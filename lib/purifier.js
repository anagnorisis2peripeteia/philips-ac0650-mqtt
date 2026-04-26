/**
 * PhilipsPurifier — EventEmitter-based controller for Philips AC0650 air purifiers.
 *
 * Connects to the Versuni cloud via MQTT over WebSocket (AWS IoT custom authorizer).
 * Auto-refreshes OAuth tokens and MQTT signatures. Auto-reconnects with exponential backoff.
 *
 * Property mappings for AC0650/20:
 *   D0310D: power (1=on, 0=off)
 *   D0310C: fan_speed (1-18)
 *   D0520D: filter_clean_remaining (hours)
 *   D05207: filter_clean_nominal (hours, default 720)
 *   D0540E: filter_replace_remaining (hours)
 *   D05408: filter_replace_nominal (hours, default 4800)
 *
 * Mode-speed mapping: auto=1, sleep=17, turbo=18
 *
 * @example
 *   const { PhilipsPurifier } = require('philips-ac0650-mqtt');
 *   const purifier = new PhilipsPurifier();
 *   purifier.on('state', (state) => console.log(state));
 *   await purifier.connect();
 *   await purifier.setPower(true);
 */

"use strict";

const { EventEmitter } = require("events");
const WebSocket = require("ws");
const os = require("os");
const path = require("path");
const auth = require("./auth");
const {
  buildConnect,
  buildSubscribe,
  buildPublish,
  buildPublishQoS1,
  buildPingreq,
} = require("./mqtt-packets");

// ---- Constants ----

const MQTT_HOST = "ats.prod.eu-da.iot.versuni.com";
const MQTT_PORT = 443;
const MQTT_PATH = "/mqtt";
const MQTT_KEEPALIVE = 30; // seconds — 4s causes disconnect issues with AWS IoT

const MODE_SPEED = { auto: 1, sleep: 17, turbo: 18 };
const SPEED_TO_MODE = { 1: "auto", 17: "sleep", 18: "turbo" };

function speedToModeName(speed) {
  return SPEED_TO_MODE[speed] || "manual";
}

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".philips-ac0650",
  "config.json"
);

// ---- PhilipsPurifier Class ----

class PhilipsPurifier extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.configPath] - Path to config.json (default: ~/.philips-ac0650/config.json)
   */
  constructor(options = {}) {
    super();
    this.configPath = options.configPath || DEFAULT_CONFIG_PATH;

    this.ws = null;
    this.connected = false;
    this.receiveBuffer = Buffer.alloc(0);
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 5000;
    this.packetIdCounter = 1;
    this._tokenRefreshTimer = null;
    this._filterRefreshTimer = null;
    this._commandLockUntil = 0;
    this._closing = false;

    // Config (loaded from file)
    this.config = null;
    this.deviceId = null;
    this.thingName = null;
    this.topicId = null;
    this.clientId = null;
    this.statusTopic = null;
    this.controlTopic = null;

    // Cached state
    this.state = {
      power: null,
      fanSpeed: null,
      modeName: null,
      filterClean: { remaining: null, nominal: 720, percent: null },
      filterReplace: { remaining: null, nominal: 4800, percent: null },
      connected: false,
      updated: null,
    };
  }

  // ---- Config ----

  _loadConfig() {
    try {
      this.config = auth.loadConfig(this.configPath);
      this.deviceId = this.config.device_id;
      this.thingName = this.config.thing_name || "da-" + this.deviceId;
      this.topicId = "da-" + this.deviceId;
      this.clientId = this.config.user_id + "_" + this.deviceId;
      this.statusTopic = "da_ctrl/" + this.topicId + "/from_ncp";
      this.controlTopic = "da_ctrl/" + this.topicId + "/to_ncp";
      return true;
    } catch (e) {
      this.emit("error", new Error("Failed to load config: " + e.message));
      return false;
    }
  }

  _saveConfig() {
    try {
      auth.saveConfig(this.configPath, this.config);
    } catch (e) {
      this.emit("error", new Error("Failed to save config: " + e.message));
    }
  }

  // ---- Token Management ----

  async _refreshTokens() {
    try {
      await auth.refreshTokens(this.config);
      this._saveConfig();
      return true;
    } catch (e) {
      this.emit("error", new Error("Token refresh failed: " + e.message));
      return false;
    }
  }

  async _refreshSignature() {
    try {
      const sig = await auth.refreshSignature(this.config);
      this._saveConfig();
      return sig;
    } catch (e) {
      this.emit("error", new Error("Signature refresh failed: " + e.message));
      return null;
    }
  }

  async _ensureTokens() {
    try {
      await auth.ensureTokens(this.config);
      this._saveConfig();
      return true;
    } catch (e) {
      this.emit("error", new Error("Token check failed: " + e.message));
      return false;
    }
  }

  // ---- Connection ----

  /**
   * Connect to the purifier's MQTT broker.
   * Refreshes tokens and signature, then opens the WebSocket.
   * @returns {Promise<void>}
   */
  async connect() {
    this._closing = false;
    if (!this._loadConfig()) return;
    await this._ensureTokens();

    const sig = await this._refreshSignature();
    if (!sig) {
      this.emit("error", new Error("Failed to get MQTT signature"));
      return;
    }

    this._doConnect();

    // Schedule token refresh every 55 minutes
    if (!this._tokenRefreshTimer) {
      this._tokenRefreshTimer = setInterval(async () => {
        const ok = await this._refreshTokens();
        if (ok) {
          await this._refreshSignature();
          // Reconnect to apply new auth
          this._disconnect(false);
          setTimeout(() => {
            if (!this._closing) this._doConnect();
          }, 2000);
        }
      }, 55 * 60 * 1000);
    }
  }

  _doConnect() {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (e) {}
      this.ws = null;
    }
    this.connected = false;
    this.receiveBuffer = Buffer.alloc(0);

    const signature = this.config.mqtt_signature;
    const accessToken = (this.config.access_token || "").trim();

    try {
      this.ws = new WebSocket(
        "wss://" + MQTT_HOST + ":" + MQTT_PORT + MQTT_PATH,
        ["mqtt"],
        {
          headers: {
            "x-amz-customauthorizer-name": "CustomAuthorizer",
            "x-amz-customauthorizer-signature": signature,
            tenant: "da",
            "content-type": "application/json",
            "token-header": "Bearer " + accessToken,
          },
          rejectUnauthorized: false, // AWS IoT hostname mismatch
          handshakeTimeout: 15000,
        }
      );
    } catch (e) {
      this.emit("error", new Error("WebSocket creation failed: " + e.message));
      this._scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      try {
        this.ws.send(buildConnect(this.clientId, MQTT_KEEPALIVE));
      } catch (e) {
        this.emit("error", new Error("Failed to send CONNECT: " + e.message));
      }
    });

    this.ws.on("message", (data) => {
      this.receiveBuffer = Buffer.concat([
        this.receiveBuffer,
        Buffer.from(data),
      ]);
      this._processBuffer();
    });

    this.ws.on("error", (err) => {
      this.emit("error", err);
    });

    this.ws.on("close", () => {
      this._onDisconnected();
    });
  }

  // ---- MQTT Packet Processing ----

  _processBuffer() {
    while (this.receiveBuffer.length >= 2) {
      const packetType = (this.receiveBuffer[0] >> 4) & 0x0f;

      let i = 1;
      let multiplier = 1;
      let remaining = 0;
      let b;
      do {
        if (i >= this.receiveBuffer.length) return;
        b = this.receiveBuffer[i++];
        remaining += (b & 0x7f) * multiplier;
        multiplier *= 128;
      } while ((b & 0x80) !== 0);

      const totalLen = i + remaining;
      if (this.receiveBuffer.length < totalLen) return;

      const packet = this.receiveBuffer.slice(0, totalLen);
      this.receiveBuffer = this.receiveBuffer.slice(totalLen);

      this._handlePacket(packetType, packet, i);
    }
  }

  _handlePacket(packetType, packet, varHeaderStart) {
    if (packetType === 2) {
      // CONNACK
      const rc = packet[3];
      if (rc === 0) {
        this.connected = true;
        this.reconnectDelay = 5000;

        this.ws.send(
          buildSubscribe([
            this.statusTopic,
            "$aws/things/" + this.thingName + "/shadow/update/accepted",
            "$aws/things/" + this.thingName + "/shadow/get/accepted",
          ])
        );

        this._startPing();

        setTimeout(() => this._requestStatus(), 500);
        setTimeout(() => this._requestFilters(), 1000);
        setTimeout(() => this._requestFilters(), 5000);
        setTimeout(() => {
          try {
            const getTopic =
              "$aws/things/" + this.thingName + "/shadow/get";
            this.ws.send(buildPublish(getTopic, ""));
          } catch (e) {}
        }, 2000);

        if (this._filterRefreshTimer) clearInterval(this._filterRefreshTimer);
        this._filterRefreshTimer = setInterval(
          () => this._requestFilters(),
          5 * 60 * 1000
        );

        this.emit("connected");
      } else {
        this.emit(
          "error",
          new Error("MQTT CONNACK refused, return code: " + rc)
        );
        this._scheduleReconnect();
      }
    } else if (packetType === 9) {
      // SUBACK
      const rcs = Array.from(packet.slice(4));
      const allOk = rcs.every((r) => r !== 0x80);
      if (allOk) {
        this.state.connected = true;
        this._emitState();
      }
    } else if (packetType === 3) {
      // PUBLISH
      this._handlePublish(packet, varHeaderStart);
    } else if (packetType === 4) {
      // PUBACK — acknowledgement for QoS 1
      // No action needed
    } else if (packetType === 13) {
      // PINGRESP
      // Keepalive ack
    } else if (packetType === 14) {
      // DISCONNECT
      this._onDisconnected();
    }
  }

  _handlePublish(packet, varHeaderStart) {
    let pi = varHeaderStart;
    const topicLen = (packet[pi] << 8) | packet[pi + 1];
    pi += 2;
    const topic = packet.slice(pi, pi + topicLen).toString("utf8");
    pi += topicLen;

    // Check for QoS 1 (bit 1 of first byte)
    const qos = (packet[0] >> 1) & 0x03;
    if (qos === 1) {
      // Skip packet ID (2 bytes)
      pi += 2;
    }

    const payloadStr = packet.slice(pi).toString("utf8");

    let data;
    try {
      data = JSON.parse(payloadStr);
    } catch (e) {
      return;
    }

    // Handle shadow responses
    if (topic.indexOf("/shadow/") !== -1) {
      const reported = data.state
        ? data.state.reported || data.state.desired || {}
        : {};
      if (Object.keys(reported).length > 0) {
        this._updateStatus(reported);
        this._updateFilter(reported);
      }
      return;
    }

    // Handle various message types from the device
    if (data.data && data.data.properties) {
      this._updateStatus(data.data.properties);
      this._updateFilter(data.data.properties);
    }
  }

  _updateStatus(props) {
    if (this._commandLockUntil && Date.now() < this._commandLockUntil) return;
    let changed = false;

    if (props.D0310D !== undefined) {
      const on = parseInt(props.D0310D) === 1 || props.D0310D === true;
      if (this.state.power !== on) {
        this.state.power = on;
        changed = true;
      }
    }
    if (props.D0310C !== undefined) {
      const spd = parseInt(props.D0310C);
      if (this.state.fanSpeed !== spd) {
        this.state.fanSpeed = spd;
        changed = true;
      }
      const derivedMode = speedToModeName(spd);
      if (this.state.modeName !== derivedMode) {
        this.state.modeName = derivedMode;
        changed = true;
      }
    }

    // Infer power from fan speed if D0310D is not reported
    if (
      this.state.fanSpeed !== null &&
      this.state.fanSpeed > 0 &&
      !this.state.power
    ) {
      this.state.power = true;
      changed = true;
    }

    if (changed) {
      this.state.updated = Date.now();
      this._emitState();
    }
  }

  _updateFilter(props) {
    let changed = false;

    if (props.D0520D !== undefined) {
      const remaining = parseInt(props.D0520D);
      const nominal =
        props.D05207 !== undefined ? parseInt(props.D05207) : 720;
      const pct = nominal > 0 ? Math.round((remaining / nominal) * 100) : 0;
      this.state.filterClean = { remaining, nominal, percent: pct };
      changed = true;
    }

    if (props.D0540E !== undefined) {
      const remaining = parseInt(props.D0540E);
      const nominal =
        props.D05408 !== undefined ? parseInt(props.D05408) : 4800;
      const pct = nominal > 0 ? Math.round((remaining / nominal) * 100) : 0;
      this.state.filterReplace = { remaining, nominal, percent: pct };
      changed = true;
    }

    if (changed) {
      this.state.updated = Date.now();
      this._emitState();
    }
  }

  _emitState() {
    this.emit("state", this.getState());
  }

  // ---- MQTT Requests ----

  _requestStatus() {
    if (!this.connected || !this.ws) return;
    const payload = JSON.stringify({
      cid: "cli_s" + this.packetIdCounter++,
      time: new Date().toISOString().replace(/\.\d+/, ""),
      type: "command",
      cn: "getPort",
      ct: "mobile",
      data: { portName: "Status" },
    });
    try {
      this.ws.send(buildPublish(this.controlTopic, payload));
    } catch (e) {}
  }

  _requestFilters() {
    if (!this.connected || !this.ws) return;
    const payload = JSON.stringify({
      cid: "cli_f" + this.packetIdCounter++,
      time: new Date().toISOString().replace(/\.\d+/, ""),
      type: "command",
      cn: "getPort",
      ct: "mobile",
      data: { portName: "filtRd" },
    });
    try {
      this.ws.send(buildPublish(this.controlTopic, payload));
    } catch (e) {}
  }

  // ---- Keepalive ----

  _startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(buildPingreq());
      }
    }, 25000);
  }

  // ---- Reconnect ----

  _onDisconnected() {
    const wasConnected = this.connected;
    this.connected = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (wasConnected) {
      this.state.connected = false;
      this._emitState();
      this.emit("disconnected");
    }
    if (!this._closing) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this._closing) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this._closing) return;
      // Re-check tokens and signature before reconnecting
      await this._ensureTokens();
      await this._refreshSignature();
      this._doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 120000);
  }

  _disconnect(reschedule) {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (e) {}
      this.ws = null;
    }
    if (reschedule && !this._closing) this._scheduleReconnect();
  }

  /**
   * Cleanly disconnect and stop all timers.
   */
  disconnect() {
    this._closing = true;
    if (this._tokenRefreshTimer) {
      clearInterval(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }
    if (this._filterRefreshTimer) {
      clearInterval(this._filterRefreshTimer);
      this._filterRefreshTimer = null;
    }
    this._disconnect(false);
    this.state.connected = false;
    this._emitState();
    this.emit("disconnected");
  }

  // ---- Control Commands ----

  /**
   * Send a raw command to the device.
   * @param {object} properties - Property key-value pairs (e.g. { D0310D: 1 })
   * @param {string} [portName='Control'] - Port name
   * @returns {{ success: boolean, error?: string }}
   */
  sendCommand(properties, portName) {
    portName = portName || "Control";
    if (!this.connected || !this.ws) {
      return { success: false, error: "Not connected" };
    }
    const payload = JSON.stringify({
      cid: "cli_c" + this.packetIdCounter++,
      time: new Date().toISOString().replace(/\.\d+/, ""),
      type: "command",
      cn: "setPort",
      ct: "mobile",
      data: { portName, properties },
    });
    try {
      this.ws.send(buildPublish(this.controlTopic, payload));
      setTimeout(() => this._requestStatus(), 800);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Turn the purifier on or off.
   * Uses both AWS IoT shadow and da_ctrl for reliability.
   * @param {boolean} on
   * @returns {{ success: boolean, error?: string }}
   */
  setPower(on) {
    if (!this.connected || !this.ws) {
      return { success: false, error: "Not connected" };
    }

    // Shadow update for power
    const shadowPayload = JSON.stringify({
      state: { desired: { powerOn: on } },
    });
    const shadowTopic =
      "$aws/things/" + this.thingName + "/shadow/update";
    try {
      this.ws.send(buildPublish(shadowTopic, shadowPayload));
    } catch (e) {
      return { success: false, error: e.message };
    }

    // Also send via da_ctrl
    this.sendCommand({ D0310D: on ? 1 : 0 });

    this.state.power = on;
    this.state.updated = Date.now();
    this._commandLockUntil = Date.now() + 5000;
    this._emitState();
    setTimeout(() => this._requestStatus(), 5000);
    setTimeout(() => this._requestFilters(), 6000);
    return { success: true };
  }

  /**
   * Set manual fan speed (1-18).
   * @param {number} speed
   * @returns {{ success: boolean, error?: string }}
   */
  setFanSpeed(speed) {
    const s = Math.max(1, Math.min(18, parseInt(speed)));
    const result = this.sendCommand({ D0310C: s });
    if (result.success) {
      this.state.fanSpeed = s;
      this.state.modeName = speedToModeName(s);
      this.state.updated = Date.now();
      this._commandLockUntil = Date.now() + 5000;
      this._emitState();
    }
    setTimeout(() => this._requestStatus(), 5000);
    return result;
  }

  /**
   * Set a preset mode (auto, sleep, turbo).
   * Modes are implemented as specific fan speed values.
   * @param {'auto'|'sleep'|'turbo'} mode
   * @returns {{ success: boolean, error?: string }}
   */
  setMode(mode) {
    const speed = MODE_SPEED[mode.toLowerCase()];
    if (speed === undefined) {
      return {
        success: false,
        error: "Invalid mode. Use: auto, sleep, turbo",
      };
    }

    const result = this.sendCommand({ D0310C: speed });
    if (result.success) {
      this.state.fanSpeed = speed;
      this.state.modeName = mode.toLowerCase();
      this.state.updated = Date.now();
      this._commandLockUntil = Date.now() + 5000;
      this._emitState();
    }
    setTimeout(() => this._requestStatus(), 5000);
    return result;
  }

  /**
   * Reset the clean filter timer back to full (720h nominal).
   * Uses QoS 1 so the broker acknowledges receipt.
   * @returns {{ success: boolean, error?: string }}
   */
  resetFilterClean() {
    if (!this.connected || !this.ws) {
      return { success: false, error: "Not connected" };
    }
    const packetId = this.packetIdCounter++;
    const payload = JSON.stringify({
      cid: "cli_c" + packetId,
      time: new Date().toISOString().replace(/\.\d+/, ""),
      type: "command",
      cn: "setPort",
      ct: "mobile",
      data: { portName: "filtWr", properties: { D0520D: 720 } },
    });
    try {
      this.ws.send(
        buildPublishQoS1(this.controlTopic, payload, packetId)
      );
      setTimeout(() => this._requestFilters(), 2000);
      setTimeout(() => this._requestFilters(), 5000);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Reset the HEPA replace filter timer back to full (4800h nominal).
   * Uses QoS 1 so the broker acknowledges receipt.
   * @returns {{ success: boolean, error?: string }}
   */
  resetFilterReplace() {
    if (!this.connected || !this.ws) {
      return { success: false, error: "Not connected" };
    }
    const packetId = this.packetIdCounter++;
    const payload = JSON.stringify({
      cid: "cli_c" + packetId,
      time: new Date().toISOString().replace(/\.\d+/, ""),
      type: "command",
      cn: "setPort",
      ct: "mobile",
      data: { portName: "filtWr", properties: { D0540E: 4800 } },
    });
    try {
      this.ws.send(
        buildPublishQoS1(this.controlTopic, payload, packetId)
      );
      setTimeout(() => this._requestFilters(), 2000);
      setTimeout(() => this._requestFilters(), 5000);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Get the current state snapshot.
   * @returns {object}
   */
  getState() {
    return {
      power: this.state.power,
      fanSpeed: this.state.fanSpeed,
      modeName: this.state.modeName,
      filterClean: { ...this.state.filterClean },
      filterReplace: { ...this.state.filterReplace },
      connected: this.state.connected,
      updated: this.state.updated,
    };
  }
}

module.exports = { PhilipsPurifier, DEFAULT_CONFIG_PATH };
