#!/usr/bin/env node

/**
 * CLI for controlling Philips AC0650 air purifiers via cloud MQTT.
 *
 * Usage:
 *   philips-ac0650 setup              # interactive onboarding
 *   philips-ac0650 status             # show current state
 *   philips-ac0650 on                 # power on
 *   philips-ac0650 off                # power off
 *   philips-ac0650 speed <1-16>       # manual fan speed
 *   philips-ac0650 auto               # auto mode
 *   philips-ac0650 sleep              # sleep mode
 *   philips-ac0650 turbo              # turbo mode
 *   philips-ac0650 reset clean        # reset clean filter timer
 *   philips-ac0650 reset hepa         # reset HEPA filter timer
 *   philips-ac0650 monitor            # live status stream
 *   philips-ac0650 serve [--port N]   # HTTP REST API server
 *   philips-ac0650 ha-bridge [opts]   # Home Assistant MQTT discovery bridge
 */

"use strict";

const { PhilipsPurifier } = require("../lib/purifier");
const { runSetup } = require("../lib/setup");

const args = process.argv.slice(2);
const command = (args[0] || "").toLowerCase();

// ---- Helpers ----

function printUsage() {
  console.log("philips-ac0650 — Control Philips AC0650 air purifiers");
  console.log();
  console.log("Commands:");
  console.log("  setup              Run interactive onboarding wizard");
  console.log("  status             Show current device state");
  console.log("  on                 Power on");
  console.log("  off                Power off");
  console.log("  speed <1-16>       Set manual fan speed");
  console.log("  auto               Auto mode");
  console.log("  sleep              Sleep mode");
  console.log("  turbo              Turbo mode");
  console.log("  reset clean        Reset clean filter timer");
  console.log("  reset hepa         Reset HEPA filter timer");
  console.log("  monitor            Live status stream");
  console.log("  serve              Start HTTP REST API server");
  console.log("  ha-bridge          Start Home Assistant MQTT discovery bridge");
  console.log();
  console.log("Options:");
  console.log(
    "  --config <path>    Config file (default: ~/.philips-ac0650/config.json)"
  );
  console.log("  --port <N>         HTTP server port (default: 8080)");
  console.log("  --mqtt-host <host> MQTT broker host for HA bridge (default: localhost)");
  console.log("  --mqtt-port <N>    MQTT broker port for HA bridge (default: 1883)");
  console.log("  --help, -h         Show this help");
  console.log();
  console.log("First-time setup:");
  console.log("  philips-ac0650 setup");
}

function progressBar(percent, width) {
  width = width || 10;
  if (percent == null) return "?" .repeat(width);
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function formatState(state) {
  const power = state.power === true ? "ON" : state.power === false ? "OFF" : "?";
  const mode = state.modeName || "?";
  const speed = state.fanSpeed != null ? String(state.fanSpeed) : "?";

  const cleanPct = state.filterClean.percent;
  const cleanRem = state.filterClean.remaining;
  const cleanNom = state.filterClean.nominal;
  const cleanBar = progressBar(cleanPct);
  const cleanText =
    cleanPct != null
      ? cleanPct + "% (" + cleanRem + "h / " + cleanNom + "h)"
      : "unknown";

  const hepaPct = state.filterReplace.percent;
  const hepaRem = state.filterReplace.remaining;
  const hepaNom = state.filterReplace.nominal;
  const hepaBar = progressBar(hepaPct);
  const hepaText =
    hepaPct != null
      ? hepaPct + "% (" + hepaRem + "h / " + hepaNom + "h)"
      : "unknown";

  const conn = state.connected ? "yes" : "no";

  const lines = [
    "Power:  " + power + "    Mode: " + mode + "    Speed: " + speed,
    "Clean filter:  " + cleanBar + "  " + cleanText,
    "HEPA filter:   " + hepaBar + "  " + hepaText,
    "Connected: " + conn,
  ];
  return lines.join("\n");
}

function getConfigPath() {
  const idx = args.indexOf("--config");
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return defaultValue;
}

// ---- One-shot command runner ----

async function runOneShot(action, options) {
  options = options || {};
  const waitMs = options.waitMs != null ? options.waitMs : 6000;
  const configPath = getConfigPath();
  const purifier = new PhilipsPurifier({ configPath });

  let stateReceived = false;

  purifier.on("error", (err) => {
    console.error("Error: " + err.message);
  });

  purifier.on("state", () => {
    stateReceived = true;
  });

  await purifier.connect();

  await new Promise((resolve) => {
    if (purifier.connected) return resolve();
    const check = setInterval(() => {
      if (purifier.connected) {
        clearInterval(check);
        resolve();
      }
    }, 200);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 15000);
  });

  if (!purifier.connected) {
    console.error("Failed to connect to purifier.");
    process.exit(1);
  }

  const result = await action(purifier);
  if (result && !result.success) {
    console.error("Command failed: " + (result.error || "unknown error"));
    purifier.disconnect();
    process.exit(1);
  }

  await new Promise((resolve) => setTimeout(resolve, waitMs));

  console.log(formatState(purifier.getState()));

  purifier.disconnect();
  setTimeout(() => process.exit(0), 500);
}

// ---- Main ----

async function main() {
  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return;
  }

  if (command === "setup") {
    await runSetup(getConfigPath());
    return;
  }

  if (!command) {
    printUsage();
    return;
  }

  if (command === "status") {
    await runOneShot(
      function () {
        return { success: true };
      },
      { waitMs: 4000 }
    );
    return;
  }

  if (command === "on") {
    await runOneShot(function (p) {
      return p.setPower(true);
    });
    return;
  }

  if (command === "off") {
    await runOneShot(function (p) {
      return p.setPower(false);
    });
    return;
  }

  if (command === "speed") {
    const speed = parseInt(args[1], 10);
    if (isNaN(speed) || speed < 1 || speed > 16) {
      console.error("Speed must be a number between 1 and 16.");
      process.exit(1);
    }
    await runOneShot(function (p) {
      return p.setFanSpeed(speed);
    });
    return;
  }

  if (command === "auto") {
    await runOneShot(function (p) {
      return p.setMode("auto");
    });
    return;
  }

  if (command === "sleep") {
    await runOneShot(function (p) {
      return p.setMode("sleep");
    });
    return;
  }

  if (command === "turbo") {
    await runOneShot(function (p) {
      return p.setMode("turbo");
    });
    return;
  }

  if (command === "reset") {
    const sub = (args[1] || "").toLowerCase();
    if (sub === "clean") {
      await runOneShot(function (p) {
        console.log("Resetting clean filter timer...");
        return p.resetFilterClean();
      });
    } else if (sub === "hepa") {
      await runOneShot(function (p) {
        console.log("Resetting HEPA filter timer...");
        return p.resetFilterReplace();
      });
    } else {
      console.error('Usage: philips-ac0650 reset <clean|hepa>');
      process.exit(1);
    }
    return;
  }

  if (command === "monitor") {
    const configPath = getConfigPath();
    const purifier = new PhilipsPurifier({ configPath });

    purifier.on("error", (err) => {
      console.error("[" + new Date().toLocaleTimeString() + "] Error: " + err.message);
    });

    purifier.on("connected", () => {
      console.log(
        "[" + new Date().toLocaleTimeString() + "] Connected to purifier"
      );
    });

    purifier.on("disconnected", () => {
      console.log(
        "[" + new Date().toLocaleTimeString() + "] Disconnected"
      );
    });

    purifier.on("state", (state) => {
      console.log();
      console.log("[" + new Date().toLocaleTimeString() + "] State update:");
      console.log(formatState(state));
    });

    console.log("Connecting to purifier... (Ctrl+C to stop)");
    await purifier.connect();

    process.on("SIGINT", () => {
      console.log("\nDisconnecting...");
      purifier.disconnect();
      setTimeout(() => process.exit(0), 500);
    });
    process.on("SIGTERM", () => {
      purifier.disconnect();
      setTimeout(() => process.exit(0), 500);
    });
    return;
  }

  if (command === "serve") {
    const { HttpServer } = require("../lib/http-server");
    const configPath = getConfigPath();
    const port = parseInt(getArg("--port", "8080"), 10);
    const purifier = new PhilipsPurifier({ configPath });

    purifier.on("error", (err) => {
      console.error("Purifier error: " + err.message);
    });

    console.log("Connecting to purifier...");
    await purifier.connect();

    await new Promise((resolve) => {
      if (purifier.connected) return resolve();
      const check = setInterval(() => {
        if (purifier.connected) {
          clearInterval(check);
          resolve();
        }
      }, 200);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 15000);
    });

    const server = new HttpServer({ purifier, port });
    await server.start();
    console.log("HTTP API server running on http://0.0.0.0:" + port);
    console.log();
    console.log("Endpoints:");
    console.log("  GET  /status       Current state");
    console.log("  GET  /health       Health check");
    console.log('  POST /power        {"on": true|false}');
    console.log('  POST /speed        {"speed": 1-16}');
    console.log('  POST /mode         {"mode": "auto"|"sleep"|"turbo"}');
    console.log("  POST /reset/clean  Reset clean filter timer");
    console.log("  POST /reset/hepa   Reset HEPA filter timer");

    process.on("SIGINT", async () => {
      console.log("\nShutting down...");
      await server.stop();
      purifier.disconnect();
      setTimeout(() => process.exit(0), 500);
    });
    return;
  }

  if (command === "ha-bridge") {
    const { HABridge } = require("../lib/ha-bridge");
    const configPath = getConfigPath();
    const mqttHost = getArg("--mqtt-host", "localhost");
    const mqttPort = parseInt(getArg("--mqtt-port", "1883"), 10);
    const purifier = new PhilipsPurifier({ configPath });

    purifier.on("error", (err) => {
      console.error("Purifier error: " + err.message);
    });

    console.log("Connecting to purifier...");
    await purifier.connect();

    await new Promise((resolve) => {
      if (purifier.connected) return resolve();
      const check = setInterval(() => {
        if (purifier.connected) {
          clearInterval(check);
          resolve();
        }
      }, 200);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 15000);
    });

    const bridge = new HABridge({ purifier, mqttHost, mqttPort });
    await bridge.start();
    console.log("Home Assistant MQTT bridge running");
    console.log("MQTT broker: " + mqttHost + ":" + mqttPort);
    console.log("Discovery prefix: homeassistant");

    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      bridge.stop();
      purifier.disconnect();
      setTimeout(() => process.exit(0), 500);
    });
    return;
  }

  console.error("Unknown command: " + command);
  console.error('Run "philips-ac0650 --help" for usage.');
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal: " + err.message);
  process.exit(1);
});
