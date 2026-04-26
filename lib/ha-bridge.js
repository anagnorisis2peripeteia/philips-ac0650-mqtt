/**
 * Home Assistant MQTT Discovery Bridge for Philips AC0650.
 *
 * Connects to a local MQTT broker and publishes HA auto-discovery configs
 * so the purifier appears natively in Home Assistant as a fan entity with
 * sensor and button entities for filter management.
 *
 * The bridge listens for purifier 'state' events and publishes state updates
 * to the local broker. It also subscribes to HA command topics and translates
 * them into purifier control calls.
 *
 * @example
 *   const { PhilipsPurifier } = require('./purifier');
 *   const { HABridge } = require('./ha-bridge');
 *
 *   const purifier = new PhilipsPurifier();
 *   const bridge = new HABridge({
 *     purifier,
 *     brokerUrl: 'mqtt://localhost:1883',
 *     deviceName: 'Air Purifier',
 *   });
 *
 *   await purifier.connect();
 *   await bridge.start();
 */

"use strict";

const { EventEmitter } = require("events");
const mqtt = require("mqtt");

// ---- Constants ----

const HA_PREFIX = "homeassistant";
const TOPIC_PREFIX = "philips_ac0650";
const AVAILABILITY_TOPIC = TOPIC_PREFIX + "/availability";
const STATE_TOPIC = TOPIC_PREFIX + "/state";
const COMMAND_TOPIC = TOPIC_PREFIX + "/set";

const PRESET_MODES = ["auto", "sleep", "turbo"];

// Map fan speed 1-16 to percentage 0-100 and back.
// Speed 1 = ~6%, speed 16 = 100%.
function speedToPercent(speed) {
  if (speed == null || speed < 1) return 0;
  return Math.round((Math.min(speed, 16) / 16) * 100);
}

function percentToSpeed(percent) {
  if (percent <= 0) return 1;
  return Math.max(1, Math.min(16, Math.round((percent / 100) * 16)));
}

// ---- HABridge Class ----

class HABridge extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./purifier').PhilipsPurifier} options.purifier - Connected purifier instance
   * @param {string} [options.brokerUrl='mqtt://localhost:1883'] - Local MQTT broker URL
   * @param {string} [options.deviceName='Philips AC0650'] - Display name in HA
   */
  constructor(options) {
    super();
    this.purifier = options.purifier;
    this.brokerUrl = options.brokerUrl || "mqtt://localhost:1883";
    this.deviceName = options.deviceName || "Philips AC0650";
    this.client = null;
    this._stateHandler = null;
  }

  /**
   * Derive a safe device ID from the purifier's device ID or fall back to a default.
   * @returns {string}
   */
  _deviceId() {
    const raw = this.purifier.deviceId || "unknown";
    return raw.replace(/-/g, "").substring(0, 12);
  }

  /**
   * Build the HA device object used in all discovery payloads.
   * @returns {object}
   */
  _deviceInfo() {
    return {
      identifiers: ["philips_ac0650_" + this._deviceId()],
      name: this.deviceName,
      manufacturer: "Philips",
      model: "AC0650/20",
    };
  }

  /**
   * Connect to the local MQTT broker, publish discovery configs, and start
   * forwarding state between HA and the purifier.
   * @returns {Promise<void>}
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: "philips_ac0650_bridge_" + this._deviceId(),
        will: {
          topic: AVAILABILITY_TOPIC,
          payload: "offline",
          retain: true,
        },
      });

      this.client.on("connect", () => {
        this.emit("connected");
        this._publishDiscovery();
        this._publishAvailability("online");
        this._subscribeCommands();
        this._startStateSync();
        resolve();
      });

      this.client.on("error", (err) => {
        this.emit("error", err);
      });

      this.client.on("message", (topic, message) => {
        this._handleCommand(topic, message);
      });

      // Timeout if broker is unreachable
      setTimeout(() => {
        if (!this.client.connected) {
          reject(new Error("Failed to connect to MQTT broker at " + this.brokerUrl));
        }
      }, 10000);
    });
  }

  /**
   * Disconnect from the local broker and stop state forwarding.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._stateHandler) {
      this.purifier.removeListener("state", this._stateHandler);
      this._stateHandler = null;
    }
    if (this.client) {
      this._publishAvailability("offline");
      return new Promise((resolve) => {
        this.client.end(false, () => {
          this.client = null;
          resolve();
        });
      });
    }
  }

  // ---- Discovery ----

  _publishDiscovery() {
    const id = this._deviceId();
    const device = this._deviceInfo();

    // Fan entity (main control)
    this._publish(
      HA_PREFIX + "/fan/philips_ac0650_" + id + "/config",
      {
        name: this.deviceName,
        unique_id: "philips_ac0650_" + id + "_fan",
        device,
        state_topic: STATE_TOPIC,
        command_topic: COMMAND_TOPIC,
        state_value_template: "{{ value_json.state }}",
        command_template: '{ "state": "{{ value }}" }',
        percentage_state_topic: STATE_TOPIC,
        percentage_value_template: "{{ value_json.percentage }}",
        percentage_command_topic: COMMAND_TOPIC + "/percentage",
        preset_mode_state_topic: STATE_TOPIC,
        preset_mode_value_template: "{{ value_json.preset_mode }}",
        preset_mode_command_topic: COMMAND_TOPIC + "/preset_mode",
        preset_modes: PRESET_MODES,
        speed_range_min: 1,
        speed_range_max: 100,
        availability_topic: AVAILABILITY_TOPIC,
        payload_available: "online",
        payload_not_available: "offline",
      },
      true
    );

    // Sensor: clean filter life %
    this._publish(
      HA_PREFIX + "/sensor/philips_ac0650_" + id + "_filter_clean/config",
      {
        name: this.deviceName + " Clean Filter",
        unique_id: "philips_ac0650_" + id + "_filter_clean",
        device,
        state_topic: STATE_TOPIC,
        value_template: "{{ value_json.filter_clean_percent }}",
        unit_of_measurement: "%",
        icon: "mdi:air-filter",
        availability_topic: AVAILABILITY_TOPIC,
      },
      true
    );

    // Sensor: HEPA filter life %
    this._publish(
      HA_PREFIX + "/sensor/philips_ac0650_" + id + "_filter_hepa/config",
      {
        name: this.deviceName + " HEPA Filter",
        unique_id: "philips_ac0650_" + id + "_filter_hepa",
        device,
        state_topic: STATE_TOPIC,
        value_template: "{{ value_json.filter_hepa_percent }}",
        unit_of_measurement: "%",
        icon: "mdi:air-filter",
        availability_topic: AVAILABILITY_TOPIC,
      },
      true
    );

    // Sensor: clean filter hours remaining
    this._publish(
      HA_PREFIX + "/sensor/philips_ac0650_" + id + "_filter_clean_hours/config",
      {
        name: this.deviceName + " Clean Filter Hours",
        unique_id: "philips_ac0650_" + id + "_filter_clean_hours",
        device,
        state_topic: STATE_TOPIC,
        value_template: "{{ value_json.filter_clean_hours }}",
        unit_of_measurement: "h",
        icon: "mdi:timer-sand",
        availability_topic: AVAILABILITY_TOPIC,
      },
      true
    );

    // Sensor: HEPA filter hours remaining
    this._publish(
      HA_PREFIX + "/sensor/philips_ac0650_" + id + "_filter_hepa_hours/config",
      {
        name: this.deviceName + " HEPA Filter Hours",
        unique_id: "philips_ac0650_" + id + "_filter_hepa_hours",
        device,
        state_topic: STATE_TOPIC,
        value_template: "{{ value_json.filter_hepa_hours }}",
        unit_of_measurement: "h",
        icon: "mdi:timer-sand",
        availability_topic: AVAILABILITY_TOPIC,
      },
      true
    );

    // Button: reset clean filter
    this._publish(
      HA_PREFIX + "/button/philips_ac0650_" + id + "_reset_clean/config",
      {
        name: this.deviceName + " Reset Clean Filter",
        unique_id: "philips_ac0650_" + id + "_reset_clean",
        device,
        command_topic: COMMAND_TOPIC + "/reset_clean",
        icon: "mdi:refresh",
        availability_topic: AVAILABILITY_TOPIC,
      },
      true
    );

    // Button: reset HEPA filter
    this._publish(
      HA_PREFIX + "/button/philips_ac0650_" + id + "_reset_hepa/config",
      {
        name: this.deviceName + " Reset HEPA Filter",
        unique_id: "philips_ac0650_" + id + "_reset_hepa",
        device,
        command_topic: COMMAND_TOPIC + "/reset_hepa",
        icon: "mdi:refresh",
        availability_topic: AVAILABILITY_TOPIC,
      },
      true
    );
  }

  // ---- Command Handling ----

  _subscribeCommands() {
    this.client.subscribe([
      COMMAND_TOPIC,
      COMMAND_TOPIC + "/percentage",
      COMMAND_TOPIC + "/preset_mode",
      COMMAND_TOPIC + "/reset_clean",
      COMMAND_TOPIC + "/reset_hepa",
    ]);
  }

  _handleCommand(topic, message) {
    const payload = message.toString();

    if (topic === COMMAND_TOPIC) {
      try {
        const cmd = JSON.parse(payload);
        if (cmd.state === "ON") {
          this.purifier.setPower(true);
        } else if (cmd.state === "OFF") {
          this.purifier.setPower(false);
        }
      } catch (e) {
        // Plain text ON/OFF
        if (payload === "ON") this.purifier.setPower(true);
        else if (payload === "OFF") this.purifier.setPower(false);
      }
    } else if (topic === COMMAND_TOPIC + "/percentage") {
      const pct = parseInt(payload, 10);
      if (!isNaN(pct)) {
        if (pct === 0) {
          this.purifier.setPower(false);
        } else {
          const speed = percentToSpeed(pct);
          this.purifier.setFanSpeed(speed);
        }
      }
    } else if (topic === COMMAND_TOPIC + "/preset_mode") {
      const mode = payload.toLowerCase().trim();
      if (PRESET_MODES.indexOf(mode) !== -1) {
        this.purifier.setMode(mode);
      }
    } else if (topic === COMMAND_TOPIC + "/reset_clean") {
      this.purifier.resetFilterClean();
    } else if (topic === COMMAND_TOPIC + "/reset_hepa") {
      this.purifier.resetFilterReplace();
    }
  }

  // ---- State Sync ----

  _startStateSync() {
    this._stateHandler = (state) => {
      this._publishState(state);
    };
    this.purifier.on("state", this._stateHandler);

    // Publish current state immediately
    const current = this.purifier.getState();
    if (current) {
      this._publishState(current);
    }

    // Update availability based on purifier connection
    this.purifier.on("connected", () => {
      this._publishAvailability("online");
    });
    this.purifier.on("disconnected", () => {
      this._publishAvailability("offline");
    });
  }

  _publishState(state) {
    if (!this.client || !this.client.connected) return;

    const haState = {
      state: state.power ? "ON" : "OFF",
      percentage: state.fanSpeed ? speedToPercent(state.fanSpeed) : 0,
      preset_mode: (state.modeName && state.modeName !== "manual") ? state.modeName : null,
      filter_clean_percent: state.filterClean ? state.filterClean.percent : null,
      filter_hepa_percent: state.filterReplace ? state.filterReplace.percent : null,
      filter_clean_hours: state.filterClean ? state.filterClean.remaining : null,
      filter_hepa_hours: state.filterReplace ? state.filterReplace.remaining : null,
    };

    this._publish(STATE_TOPIC, haState, false);
  }

  _publishAvailability(status) {
    if (!this.client || !this.client.connected) return;
    this.client.publish(AVAILABILITY_TOPIC, status, { retain: true });
  }

  _publish(topic, payload, retain) {
    if (!this.client || !this.client.connected) return;
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.client.publish(topic, data, { retain: !!retain });
  }
}

module.exports = { HABridge, speedToPercent, percentToSpeed };
