/**
 * Homebridge Dynamic Platform Plugin for Philips AC0650 Air Purifier.
 *
 * Exposes the purifier as a HomeKit Air Purifier accessory with:
 * - AirPurifier service (power, speed, auto/manual mode)
 * - Two FilterMaintenance services (clean filter, HEPA filter)
 *
 * This plugin can be used as a standalone homebridge plugin (via npm link or
 * direct path) or as part of the philips-ac0650-mqtt package.
 *
 * Homebridge config.json example:
 *   {
 *     "platform": "PhilipsAC0650",
 *     "name": "Air Purifier",
 *     "configPath": "~/.philips-ac0650/config.json"
 *   }
 *
 * @param {object} api - Homebridge API object
 */

"use strict";

const { PhilipsPurifier } = require("./purifier");
const os = require("os");
const path = require("path");

const PLUGIN_NAME = "homebridge-philips-ac0650";
const PLATFORM_NAME = "PhilipsAC0650";

let Characteristic;
let Service;

// ---- Platform Plugin ----

class PhilipsAC0650Platform {
  /**
   * @param {object} log - Homebridge logger
   * @param {object} config - Platform config from config.json
   * @param {object} api - Homebridge API
   */
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    Characteristic = api.hap.Characteristic;
    Service = api.hap.Service;

    this.accessories = [];
    this.purifier = null;

    if (!config) {
      log.warn("No configuration found for PhilipsAC0650 platform.");
      return;
    }

    this.api.on("didFinishLaunching", () => {
      this.discoverDevices();
    });
  }

  /**
   * Called by Homebridge to restore cached accessories.
   * @param {object} accessory - PlatformAccessory
   */
  configureAccessory(accessory) {
    this.log.info("Restoring cached accessory: " + accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Create or restore the purifier accessory and connect to the cloud.
   */
  discoverDevices() {
    // Resolve config path (expand ~)
    let configPath = this.config.configPath;
    if (configPath) {
      configPath = configPath.replace(/^~/, os.homedir());
    } else {
      configPath = path.join(os.homedir(), ".philips-ac0650", "config.json");
    }

    this.purifier = new PhilipsPurifier({ configPath });

    this.purifier.on("error", (err) => {
      this.log.error("Purifier error: " + err.message);
    });

    const uuid = this.api.hap.uuid.generate("philips-ac0650-" + (this.config.name || "default"));
    const displayName = this.config.name || "Philips AC0650";

    // Check if accessory was already restored from cache
    let accessory = this.accessories.find((a) => a.UUID === uuid);

    if (!accessory) {
      this.log.info("Adding new accessory: " + displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // Set up the accessory handler
    new PhilipsAC0650Accessory(this, accessory, this.purifier);

    // Connect to the cloud
    this.purifier.connect().catch((err) => {
      this.log.error("Failed to connect: " + err.message);
    });
  }
}

// ---- Accessory Handler ----

class PhilipsAC0650Accessory {
  /**
   * @param {PhilipsAC0650Platform} platform
   * @param {object} accessory - PlatformAccessory
   * @param {PhilipsPurifier} purifier
   */
  constructor(platform, accessory, purifier) {
    this.platform = platform;
    this.log = platform.log;
    this.accessory = accessory;
    this.purifier = purifier;

    // Set accessory information
    const infoService =
      accessory.getService(Service.AccessoryInformation) ||
      accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, "Philips")
      .setCharacteristic(Characteristic.Model, "AC0650/20")
      .setCharacteristic(Characteristic.SerialNumber, "philips-ac0650");

    // ---- Air Purifier Service ----
    this.airPurifierService =
      accessory.getService(Service.AirPurifier) ||
      accessory.addService(Service.AirPurifier, platform.config.name || "Air Purifier");

    // Active (on/off)
    this.airPurifierService
      .getCharacteristic(Characteristic.Active)
      .onGet(() => {
        const state = this.purifier.getState();
        return state.power
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE;
      })
      .onSet((value) => {
        const on = value === Characteristic.Active.ACTIVE;
        this.purifier.setPower(on);
      });

    // Current air purifier state (idle / purifying)
    this.airPurifierService
      .getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(() => {
        const state = this.purifier.getState();
        if (!state.power) return Characteristic.CurrentAirPurifierState.INACTIVE;
        return state.fanSpeed && state.fanSpeed > 0
          ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
          : Characteristic.CurrentAirPurifierState.IDLE;
      });

    // Target air purifier state (manual / auto)
    this.airPurifierService
      .getCharacteristic(Characteristic.TargetAirPurifierState)
      .onGet(() => {
        const state = this.purifier.getState();
        return state.modeName === "auto"
          ? Characteristic.TargetAirPurifierState.AUTO
          : Characteristic.TargetAirPurifierState.MANUAL;
      })
      .onSet((value) => {
        if (value === Characteristic.TargetAirPurifierState.AUTO) {
          this.purifier.setMode("auto");
        }
        // Manual mode: keep current speed (user adjusts via RotationSpeed)
      });

    // Rotation speed (0-100%)
    this.airPurifierService
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => {
        const state = this.purifier.getState();
        if (!state.fanSpeed || state.fanSpeed < 1) return 0;
        return Math.round((Math.min(state.fanSpeed, 16) / 16) * 100);
      })
      .onSet((value) => {
        if (value <= 0) {
          this.purifier.setPower(false);
          return;
        }
        const speed = Math.max(1, Math.min(16, Math.round((value / 100) * 16)));
        this.purifier.setFanSpeed(speed);
      });

    // ---- Filter Maintenance: Clean Filter ----
    this.cleanFilterService =
      accessory.getServiceById(Service.FilterMaintenance, "clean") ||
      accessory.addService(Service.FilterMaintenance, "Clean Filter", "clean");

    this.cleanFilterService
      .getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => {
        const state = this.purifier.getState();
        return state.filterClean && state.filterClean.percent != null
          ? state.filterClean.percent
          : 100;
      });

    this.cleanFilterService
      .getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => {
        const state = this.purifier.getState();
        const pct = state.filterClean ? state.filterClean.percent : 100;
        return pct != null && pct < 10
          ? Characteristic.FilterChangeIndication.CHANGE_FILTER
          : Characteristic.FilterChangeIndication.FILTER_OK;
      });

    this.cleanFilterService
      .getCharacteristic(Characteristic.ResetFilterIndication)
      .onSet(() => {
        this.log.info("Resetting clean filter timer");
        this.purifier.resetFilterClean();
      });

    this.airPurifierService.addLinkedService(this.cleanFilterService);

    // ---- Filter Maintenance: HEPA Filter ----
    this.hepaFilterService =
      accessory.getServiceById(Service.FilterMaintenance, "hepa") ||
      accessory.addService(Service.FilterMaintenance, "HEPA Filter", "hepa");

    this.hepaFilterService
      .getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => {
        const state = this.purifier.getState();
        return state.filterReplace && state.filterReplace.percent != null
          ? state.filterReplace.percent
          : 100;
      });

    this.hepaFilterService
      .getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => {
        const state = this.purifier.getState();
        const pct = state.filterReplace ? state.filterReplace.percent : 100;
        return pct != null && pct < 10
          ? Characteristic.FilterChangeIndication.CHANGE_FILTER
          : Characteristic.FilterChangeIndication.FILTER_OK;
      });

    this.hepaFilterService
      .getCharacteristic(Characteristic.ResetFilterIndication)
      .onSet(() => {
        this.log.info("Resetting HEPA filter timer");
        this.purifier.resetFilterReplace();
      });

    this.airPurifierService.addLinkedService(this.hepaFilterService);

    // ---- State Sync ----
    this.purifier.on("state", () => {
      this._updateCharacteristics();
    });
  }

  _updateCharacteristics() {
    const state = this.purifier.getState();

    // Air Purifier
    this.airPurifierService
      .getCharacteristic(Characteristic.Active)
      .updateValue(
        state.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE
      );

    this.airPurifierService
      .getCharacteristic(Characteristic.CurrentAirPurifierState)
      .updateValue(
        !state.power
          ? Characteristic.CurrentAirPurifierState.INACTIVE
          : state.fanSpeed && state.fanSpeed > 0
            ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
            : Characteristic.CurrentAirPurifierState.IDLE
      );

    this.airPurifierService
      .getCharacteristic(Characteristic.TargetAirPurifierState)
      .updateValue(
        state.modeName === "auto"
          ? Characteristic.TargetAirPurifierState.AUTO
          : Characteristic.TargetAirPurifierState.MANUAL
      );

    if (state.fanSpeed) {
      this.airPurifierService
        .getCharacteristic(Characteristic.RotationSpeed)
        .updateValue(Math.round((Math.min(state.fanSpeed, 16) / 16) * 100));
    }

    // Clean filter
    if (state.filterClean && state.filterClean.percent != null) {
      this.cleanFilterService
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .updateValue(state.filterClean.percent);
      this.cleanFilterService
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .updateValue(
          state.filterClean.percent < 10
            ? Characteristic.FilterChangeIndication.CHANGE_FILTER
            : Characteristic.FilterChangeIndication.FILTER_OK
        );
    }

    // HEPA filter
    if (state.filterReplace && state.filterReplace.percent != null) {
      this.hepaFilterService
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .updateValue(state.filterReplace.percent);
      this.hepaFilterService
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .updateValue(
          state.filterReplace.percent < 10
            ? Characteristic.FilterChangeIndication.CHANGE_FILTER
            : Characteristic.FilterChangeIndication.FILTER_OK
        );
    }
  }
}

// ---- Plugin Registration ----

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PhilipsAC0650Platform);
};

module.exports.PhilipsAC0650Platform = PhilipsAC0650Platform;
module.exports.PhilipsAC0650Accessory = PhilipsAC0650Accessory;
