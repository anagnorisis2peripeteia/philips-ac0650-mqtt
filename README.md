# philips-ac0650-mqtt

Control Philips AC0650 air purifiers from the command line or programmatically via the Versuni cloud MQTT API. This package reverse-engineers the same protocol used by the Philips Air+ mobile app, connecting over MQTT-over-WebSocket-over-TLS to AWS IoT with a custom authorizer.

## Supported Models

- **Philips AC0650/10** (confirmed)
- Potentially other Versuni/Philips cloud-connected air purifiers that use the Air+ app

## Prerequisites

- **Node.js 18+** (16+ works but 18+ recommended for native fetch support)
- **Philips Air+ account** with your purifier already set up in the app

## Quick Start

```bash
# Install globally
npm install -g philips-ac0650-mqtt

# Or run directly with npx
npx philips-ac0650-mqtt setup
```

### First-Time Setup

Run the setup wizard to link your Philips account:

```bash
philips-ac0650 setup
```

This will:
1. Show you an OAuth login URL to open in your browser
2. Ask you to log in with your Philips Air+ credentials
3. Ask you to paste the redirect URL (the browser will show an error page -- that is expected)
4. Exchange the auth code for tokens and save your config

Your credentials are stored locally at `~/.philips-ac0650/config.json`.

## CLI Commands

```bash
# Show current status
philips-ac0650 status

# Power control
philips-ac0650 on
philips-ac0650 off

# Fan speed (1-16 for manual speeds)
philips-ac0650 speed 5

# Preset modes
philips-ac0650 auto       # Automatic (adjusts based on air quality)
philips-ac0650 sleep      # Sleep mode (quiet)
philips-ac0650 turbo      # Turbo mode (maximum speed)

# Filter maintenance
philips-ac0650 reset clean    # Reset clean filter timer (after cleaning)
philips-ac0650 reset hepa     # Reset HEPA filter timer (after replacing)

# Live monitoring (stays connected, prints state changes)
philips-ac0650 monitor

# Start HTTP REST API server (default port 8080)
philips-ac0650 serve --port 8080

# Start Home Assistant MQTT discovery bridge
philips-ac0650 ha-bridge --mqtt-host localhost --mqtt-port 1883
```

### Status Output

```
Power:  ON    Mode: auto    Speed: 1
Clean filter:  ██████░░░░  62% (446h / 720h)
HEPA filter:   █████████░  94% (4512h / 4800h)
Connected: yes
```

### Custom Config Path

```bash
philips-ac0650 status --config /path/to/config.json
```

## Integrations

### HTTP REST API

Run a local HTTP server for controlling the purifier from any language, shell script, or home automation system that supports webhooks.

```bash
philips-ac0650 serve --port 8080
```

**Endpoints:**

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/status` | — | Current state (JSON) |
| GET | `/health` | — | Health check + uptime |
| POST | `/power` | `{"on": true}` | Power on/off |
| POST | `/speed` | `{"speed": 5}` | Set fan speed (1-16) |
| POST | `/mode` | `{"mode": "auto"}` | Set mode: auto, sleep, turbo |
| POST | `/reset/clean` | — | Reset clean filter timer |
| POST | `/reset/hepa` | — | Reset HEPA filter timer |

All endpoints return JSON. CORS is enabled for browser access.

```bash
# Examples
curl http://localhost:8080/status
curl -X POST http://localhost:8080/power -d '{"on": true}'
curl -X POST http://localhost:8080/mode -d '{"mode": "sleep"}'
```

### Home Assistant (MQTT Discovery)

Bridges the purifier to Home Assistant via MQTT auto-discovery. Requires a local MQTT broker (e.g., Mosquitto) already configured in Home Assistant.

```bash
philips-ac0650 ha-bridge --mqtt-host localhost --mqtt-port 1883
```

This publishes Home Assistant discovery configs under `homeassistant/` and creates:

- **Fan entity** — power on/off, speed percentage (1-16 mapped to 0-100%), preset modes (auto/sleep/turbo)
- **Clean Filter sensor** — filter life percentage
- **HEPA Filter sensor** — filter life percentage
- **Reset Clean Filter button** — resets the clean filter timer
- **Reset HEPA Filter button** — resets the HEPA filter timer

All entities appear under a single "Philips AC0650 Air Purifier" device in Home Assistant. State updates are pushed every 30 seconds and on every purifier state change.

**Programmatic usage:**

```javascript
const { PhilipsPurifier } = require('philips-ac0650-mqtt');
const { HABridge } = require('philips-ac0650-mqtt/lib/ha-bridge');

const purifier = new PhilipsPurifier();
await purifier.connect();

const bridge = new HABridge({
  purifier,
  mqttHost: 'localhost',
  mqttPort: 1883,
});
await bridge.start();
```

### Homebridge (HomeKit)

Exposes the purifier as a HomeKit accessory via Homebridge. Install as a dynamic platform plugin.

**Install:**

```bash
# From the repo directory
cd philips-ac0650-mqtt
npm link
# Or install globally once published:
# npm install -g philips-ac0650-mqtt
```

**Homebridge config.json:**

```json
{
  "platforms": [
    {
      "platform": "PhilipsAC0650",
      "name": "Air Purifier",
      "configPath": "~/.philips-ac0650/config.json"
    }
  ]
}
```

**HomeKit services exposed:**

- **AirPurifier** — power, rotation speed (0-100%), target state (auto/manual)
- **FilterMaintenance (Clean Filter)** — life level %, change indication, reset
- **FilterMaintenance (HEPA Filter)** — life level %, change indication, reset

The plugin connects to the Versuni cloud on Homebridge startup and pushes real-time state updates to HomeKit.

## Library Usage

Use the package programmatically in your own Node.js projects:

```javascript
const { PhilipsPurifier } = require('philips-ac0650-mqtt');

const purifier = new PhilipsPurifier({
  // configPath: '/custom/path/config.json'  // optional
});

purifier.on('state', (state) => {
  console.log('State update:', state);
});

purifier.on('connected', () => {
  console.log('Connected!');
});

purifier.on('error', (err) => {
  console.error('Error:', err.message);
});

await purifier.connect();

// Control the purifier
purifier.setPower(true);
purifier.setFanSpeed(5);
purifier.setMode('auto');    // 'auto', 'sleep', 'turbo'
purifier.resetFilterClean();
purifier.resetFilterReplace();

// Get current state
const state = purifier.getState();
console.log(state);

// Disconnect when done
purifier.disconnect();
```

### State Object

```javascript
{
  power: true,              // boolean
  fanSpeed: 1,              // 1-18
  modeName: 'auto',         // 'auto', 'sleep', 'turbo', 'manual'
  filterClean: {
    remaining: 446,         // hours remaining
    nominal: 720,           // total hours when new
    percent: 62             // percentage remaining
  },
  filterReplace: {
    remaining: 4512,        // hours remaining
    nominal: 4800,          // total hours when new
    percent: 94             // percentage remaining
  },
  connected: true,          // MQTT connection state
  updated: 1714000000000    // timestamp of last update
}
```

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `state` | state object | Emitted on any state change |
| `connected` | none | MQTT connection established |
| `disconnected` | none | MQTT connection lost |
| `error` | Error | Any error (auth, network, etc.) |

## How It Works

1. **OAuth 2.0** -- Authenticates with the Philips/Versuni identity provider (Gigya/SAP CDC) using the same OIDC flow as the Air+ app
2. **Token refresh** -- Automatically refreshes the access token (1h expiry) using the long-lived refresh token
3. **MQTT signature** -- Fetches a signed credential from the Versuni API for WebSocket authentication
4. **MQTT over WSS** -- Connects to AWS IoT Core via WebSocket (port 443) with a custom authorizer
5. **Raw MQTT packets** -- Builds MQTT 3.1.1 packets directly (the standard mqtt.js library has keepalive issues with this broker)
6. **Auto-reconnect** -- Exponential backoff (5s to 2min) on connection loss
7. **Command lock** -- After sending a command, ignores status updates for 5 seconds to prevent UI bouncing

### MQTT Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `da_ctrl/da-{deviceId}/from_ncp` | Subscribe | Status updates from device |
| `da_ctrl/da-{deviceId}/to_ncp` | Publish | Commands to device |
| `$aws/things/da-{deviceId}/shadow/update` | Publish | AWS IoT shadow updates |

### Property Codes

| Code | Property | Values |
|------|----------|--------|
| D0310D | Power | 0=off, 1=on |
| D0310C | Fan speed | 1=auto, 2-16=manual, 17=sleep, 18=turbo |
| D0520D | Clean filter remaining | hours (nominal: 720) |
| D0540E | HEPA filter remaining | hours (nominal: 4800) |

## Troubleshooting

### "Failed to load config"
Run `philips-ac0650 setup` first to create your config file.

### "Token refresh failed"
Your refresh token may have expired. Run `philips-ac0650 setup` again to re-authenticate.

### "MQTT CONNACK refused"
The MQTT signature may be stale. The tool refreshes it automatically, but if it persists, try running setup again.

### Connection drops every few seconds
The keepalive is set to 30 seconds (not the 4s documented in some references). If you see frequent disconnects, check your network stability.

### "WebSocket creation failed"
Ensure you have network access to `ats.prod.eu-da.iot.versuni.com:443`. Some corporate firewalls may block this.

## Credits

- [philips-airplus-homeassistant](https://github.com/ShorMeneses/philips-airplus-homeassistant) -- Home Assistant integration that documented the Versuni cloud API
- Built by reverse-engineering the Philips Air+ Android app's network traffic

## License

MIT
