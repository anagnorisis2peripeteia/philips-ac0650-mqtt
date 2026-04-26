"use strict";

const { PhilipsPurifier, DEFAULT_CONFIG_PATH } = require("./purifier");
const net = require("net");

const MQTT_PORT = 1883;

class HABridge {
  constructor(options = {}) {
    this.mqttHost = options.mqttHost || "localhost";
    this.mqttPort = options.mqttPort || MQTT_PORT;
    this.haPrefix = options.haPrefix || "homeassistant";
    this.nodeId = options.nodeId || "philips_ac0650";
    this.purifier = options.purifier || null;
    this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
    this.socket = null;
    this.connected = false;
    this.packetId = 1;
    this.publishInterval = null;
  }

  async start() {
    if (!this.purifier) {
      this.purifier = new PhilipsPurifier({ configPath: this.configPath });
      await this.purifier.connect();
    }
    this._connectMqtt();
    this.purifier.on("state", () => this._publishState());
  }

  stop() {
    if (this.publishInterval) clearInterval(this.publishInterval);
    if (this.socket) this.socket.destroy();
    this.connected = false;
  }

  _connectMqtt() {
    this.socket = net.createConnection(this.mqttPort, this.mqttHost, () => {
      this._sendConnect();
    });

    this.socket.on("data", (data) => this._handleData(data));
    this.socket.on("error", (err) => {
      console.error("[HA Bridge] MQTT error:", err.message);
    });
    this.socket.on("close", () => {
      this.connected = false;
      console.log("[HA Bridge] MQTT disconnected, reconnecting in 5s...");
      setTimeout(() => this._connectMqtt(), 5000);
    });
  }

  _sendConnect() {
    const clientId = "philips_ac0650_ha_bridge";
    const buf = Buffer.alloc(256);
    let pos = 0;

    // Variable header
    const vh = Buffer.alloc(10);
    vh.writeUInt16BE(4, 0); // protocol name length
    vh.write("MQTT", 2);
    vh[6] = 4; // protocol level 3.1.1
    vh[7] = 0x02; // clean session
    vh.writeUInt16BE(60, 8); // keepalive 60s

    // Client ID
    const cidBuf = Buffer.from(clientId, "utf8");
    const cidLen = Buffer.alloc(2);
    cidLen.writeUInt16BE(cidBuf.length, 0);

    const payload = Buffer.concat([cidLen, cidBuf]);
    const remaining = vh.length + payload.length;

    // Fixed header
    buf[pos++] = 0x10; // CONNECT
    const rl = this._encodeRemainingLength(remaining);
    rl.copy(buf, pos);
    pos += rl.length;

    vh.copy(buf, pos);
    pos += vh.length;
    payload.copy(buf, pos);
    pos += payload.length;

    this.socket.write(buf.subarray(0, pos));
  }

  _handleData(data) {
    const type = (data[0] >> 4) & 0x0f;
    if (type === 2) {
      // CONNACK
      this.connected = true;
      console.log("[HA Bridge] Connected to local MQTT broker");
      this._publishDiscovery();
      this._publishState();
      this._subscribeCommands();
      this.publishInterval = setInterval(() => this._publishState(), 30000);
    } else if (type === 3) {
      // PUBLISH
      this._handlePublish(data);
    } else if (type === 9) {
      // SUBACK
    }
  }

  _publishDiscovery() {
    const deviceInfo = {
      identifiers: [this.nodeId],
      name: "Philips AC0650 Air Purifier",
      manufacturer: "Philips",
      model: "AC0650/10",
    };

    // Fan entity (main purifier control)
    const fanConfig = {
      name: "Air Purifier",
      unique_id: `${this.nodeId}_fan`,
      object_id: `${this.nodeId}_fan`,
      state_topic: `${this.nodeId}/state`,
      command_topic: `${this.nodeId}/set`,
      percentage_state_topic: `${this.nodeId}/state`,
      percentage_command_topic: `${this.nodeId}/set/speed`,
      percentage_value_template: "{{ value_json.percentage }}",
      state_value_template: "{{ value_json.state }}",
      speed_range_min: 1,
      speed_range_max: 16,
      preset_modes: ["auto", "sleep", "turbo"],
      preset_mode_state_topic: `${this.nodeId}/state`,
      preset_mode_command_topic: `${this.nodeId}/set/mode`,
      preset_mode_value_template: "{{ value_json.preset_mode }}",
      device: deviceInfo,
    };
    this._mqttPublish(
      `${this.haPrefix}/fan/${this.nodeId}/config`,
      JSON.stringify(fanConfig),
      true
    );

    // Clean filter sensor
    const cleanFilterConfig = {
      name: "Clean Filter",
      unique_id: `${this.nodeId}_filter_clean`,
      object_id: `${this.nodeId}_filter_clean`,
      state_topic: `${this.nodeId}/state`,
      value_template: "{{ value_json.filter_clean_pct }}",
      unit_of_measurement: "%",
      icon: "mdi:air-filter",
      device: deviceInfo,
    };
    this._mqttPublish(
      `${this.haPrefix}/sensor/${this.nodeId}_filter_clean/config`,
      JSON.stringify(cleanFilterConfig),
      true
    );

    // HEPA filter sensor
    const hepaFilterConfig = {
      name: "HEPA Filter",
      unique_id: `${this.nodeId}_filter_hepa`,
      object_id: `${this.nodeId}_filter_hepa`,
      state_topic: `${this.nodeId}/state`,
      value_template: "{{ value_json.filter_hepa_pct }}",
      unit_of_measurement: "%",
      icon: "mdi:air-filter",
      device: deviceInfo,
    };
    this._mqttPublish(
      `${this.haPrefix}/sensor/${this.nodeId}_filter_hepa/config`,
      JSON.stringify(hepaFilterConfig),
      true
    );

    // Reset clean filter button
    const resetCleanConfig = {
      name: "Reset Clean Filter",
      unique_id: `${this.nodeId}_reset_clean`,
      object_id: `${this.nodeId}_reset_clean`,
      command_topic: `${this.nodeId}/set/reset_clean`,
      payload_press: "PRESS",
      icon: "mdi:refresh",
      device: deviceInfo,
    };
    this._mqttPublish(
      `${this.haPrefix}/button/${this.nodeId}_reset_clean/config`,
      JSON.stringify(resetCleanConfig),
      true
    );

    // Reset HEPA filter button
    const resetHepaConfig = {
      name: "Reset HEPA Filter",
      unique_id: `${this.nodeId}_reset_hepa`,
      object_id: `${this.nodeId}_reset_hepa`,
      command_topic: `${this.nodeId}/set/reset_hepa`,
      payload_press: "PRESS",
      icon: "mdi:refresh",
      device: deviceInfo,
    };
    this._mqttPublish(
      `${this.haPrefix}/button/${this.nodeId}_reset_hepa/config`,
      JSON.stringify(resetHepaConfig),
      true
    );

    console.log("[HA Bridge] Published Home Assistant discovery configs");
  }

  _subscribeCommands() {
    const topics = [
      `${this.nodeId}/set`,
      `${this.nodeId}/set/speed`,
      `${this.nodeId}/set/mode`,
      `${this.nodeId}/set/reset_clean`,
      `${this.nodeId}/set/reset_hepa`,
    ];
    for (const topic of topics) {
      this._mqttSubscribe(topic);
    }
  }

  _handlePublish(data) {
    let pos = 1;
    const { value: remaining, bytesRead } = this._decodeRemainingLength(
      data,
      pos
    );
    pos += bytesRead;

    const topicLen = data.readUInt16BE(pos);
    pos += 2;
    const topic = data.subarray(pos, pos + topicLen).toString("utf8");
    pos += topicLen;

    const payload = data.subarray(pos, 1 + bytesRead + remaining).toString("utf8");

    if (topic === `${this.nodeId}/set`) {
      if (payload === "ON") this.purifier.setPower(true);
      else if (payload === "OFF") this.purifier.setPower(false);
    } else if (topic === `${this.nodeId}/set/speed`) {
      const speed = parseInt(payload, 10);
      if (speed >= 1 && speed <= 16) this.purifier.setFanSpeed(speed);
    } else if (topic === `${this.nodeId}/set/mode`) {
      const mode = payload.toLowerCase().trim();
      if (["auto", "sleep", "turbo"].includes(mode)) this.purifier.setMode(mode);
    } else if (topic === `${this.nodeId}/set/reset_clean`) {
      this.purifier.resetFilterClean();
    } else if (topic === `${this.nodeId}/set/reset_hepa`) {
      this.purifier.resetFilterReplace();
    }
  }

  _publishState() {
    if (!this.connected || !this.purifier) return;
    const s = this.purifier.getState();
    const statePayload = {
      state: s.power ? "ON" : "OFF",
      percentage:
        s.fanSpeed != null && s.fanSpeed >= 1
          ? Math.round((Math.min(s.fanSpeed, 16) / 16) * 100)
          : 0,
      preset_mode: s.modeName || "manual",
      filter_clean_pct:
        s.filterClean && s.filterClean.percent != null
          ? s.filterClean.percent
          : null,
      filter_hepa_pct:
        s.filterReplace && s.filterReplace.percent != null
          ? s.filterReplace.percent
          : null,
    };
    this._mqttPublish(
      `${this.nodeId}/state`,
      JSON.stringify(statePayload),
      true
    );
  }

  _mqttPublish(topic, payload, retain = false) {
    if (!this.socket || !this.connected) return;
    const topicBuf = Buffer.from(topic, "utf8");
    const payloadBuf = Buffer.from(payload, "utf8");
    const topicLenBuf = Buffer.alloc(2);
    topicLenBuf.writeUInt16BE(topicBuf.length, 0);

    const fixedByte = retain ? 0x31 : 0x30;
    const remaining = 2 + topicBuf.length + payloadBuf.length;
    const rl = this._encodeRemainingLength(remaining);

    const packet = Buffer.concat([
      Buffer.from([fixedByte]),
      rl,
      topicLenBuf,
      topicBuf,
      payloadBuf,
    ]);
    this.socket.write(packet);
  }

  _mqttSubscribe(topic) {
    if (!this.socket || !this.connected) return;
    const topicBuf = Buffer.from(topic, "utf8");
    const topicLenBuf = Buffer.alloc(2);
    topicLenBuf.writeUInt16BE(topicBuf.length, 0);

    const packetId = Buffer.alloc(2);
    packetId.writeUInt16BE(this.packetId++, 0);

    const remaining = 2 + 2 + topicBuf.length + 1; // packetId + topicLen + topic + qos
    const rl = this._encodeRemainingLength(remaining);

    const packet = Buffer.concat([
      Buffer.from([0x82]), // SUBSCRIBE
      rl,
      packetId,
      topicLenBuf,
      topicBuf,
      Buffer.from([0x00]), // QoS 0
    ]);
    this.socket.write(packet);
  }

  _encodeRemainingLength(length) {
    const bytes = [];
    do {
      let byte = length % 128;
      length = Math.floor(length / 128);
      if (length > 0) byte |= 0x80;
      bytes.push(byte);
    } while (length > 0);
    return Buffer.from(bytes);
  }

  _decodeRemainingLength(buf, startPos) {
    let multiplier = 1;
    let value = 0;
    let pos = startPos;
    let byte;
    do {
      byte = buf[pos++];
      value += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    } while (byte & 0x80);
    return { value, bytesRead: pos - startPos };
  }
}

module.exports = { HABridge };
