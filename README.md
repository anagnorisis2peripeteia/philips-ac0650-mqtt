# philips-ac0650-mqtt

Control Philips AC0650 air purifiers from the command line or programmatically via the Versuni cloud MQTT API. This package reverse-engineers the same protocol used by the Philips Air+ mobile app, connecting over MQTT-over-WebSocket-over-TLS to AWS IoT with a custom authorizer.

Includes integrations for **Home Assistant** (MQTT Discovery), **Homebridge** (HomeKit), and a standalone **HTTP REST API**.

## Supported Models

- **Philips AC0650/10** (confirmed)
- Potentially other Versuni/Philips cloud-connected air purifiers that use the Air+ app

## Prerequisites

- **Node.js 18+**
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

# Home Assistant bridge (stays running)
philips-ac0650 bridge --broker mqtt://localhost:1883 --name "Air Purifier"

# HTTP API server (stays running)
philips-ac0650 serve --port 8080 --host 0.0.0.0

# Homebridge setup instructions
philips-ac0650 homebridge
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

## Home Assistant Integration

The HA bridge connects to both the Philips cloud and a local MQTT broker, publishing auto-discovery topics so the purifier appears natively in Home Assistant.

### Setup

1. Make sure you have an MQTT broker running (e.g. Mosquitto) and configured in Home Assistant.

2. Run the bridge:

```bash
philips-ac0650 bridge --broker mqtt://your-broker:1883 --name "Air Purifier"
```

3. The purifier will automatically appear in Home Assistant with:
   - **Fan entity** -- power on/off, speed percentage, preset modes (auto/sleep/turbo)
   - **Filter sensors** -- clean filter %, HEPA filter %, hours remaining for each
   - **Reset buttons** -- reset clean filter timer, reset HEPA filter timer

### MQTT Topics

| Topic | Description |
|-------|-------------|
| `homeassistant/fan/philips_ac0650_{id}/config` | Fan discovery |
| `homeassistant/sensor/philips_ac0650_{id}_filter_*/config` | Sensor discovery |
| `homeassistant/button/philips_ac0650_{id}_reset_*/config` | Button discovery |
| `philips_ac0650/state` | Current state (JSON) |
| `philips_ac0650/set` | Command topic |
| `philips_ac0650/availability` | Online/offline status |

## Homebridge Integration

The Homebridge plugin exposes the purifier as a HomeKit Air Purifier accessory.

### Setup

1. Install Homebridge if you have not already:

```bash
npm install -g homebridge
```

2. Link this plugin:

```bash
cd /path/to/philips-ac0650-mqtt
npm link
```

3. Add the platform to your Homebridge `config.json`:

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

4. Restart Homebridge.

### HomeKit Features

- **Air Purifier** -- power on/off, auto/manual mode, rotation speed (0-100%)
- **Clean Filter** -- filter life level, change indication (< 10%), reset
- **HEPA Filter** -- filter life level, change indication (< 10%), reset

## HTTP API

A lightweight REST API server using Node.js native `http` module.

### Setup

```bash
philips-ac0650 serve --port 8080 --host 0.0.0.0
```

### Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/status` | -- | Current state JSON |
| GET | `/health` | -- | `{ ok, connected, uptime }` |
| POST | `/power` | `{ "on": true\|false }` | Power on/off |
| POST | `/speed` | `{ "speed": 1-16 }` | Set fan speed |
| POST | `/mode` | `{ "mode": "auto"\|"sleep"\|"turbo" }` | Set mode |
| POST | `/reset/clean` | -- | Reset clean filter timer |
| POST | `/reset/hepa` | -- | Reset HEPA filter timer |

All responses are JSON. CORS headers are included for browser access. Returns 503 if the purifier is disconnected, 400 for bad requests.

### Example

```bash
# Get status
curl http://localhost:8080/status

# Turn on
curl -X POST -H "Content-Type: application/json" -d '{"on": true}' http://localhost:8080/power

# Set to auto mode
curl -X POST -H "Content-Type: application/json" -d '{"mode": "auto"}' http://localhost:8080/mode
```

## Docker

Run the HA bridge 24/7 with Docker Compose:

```yaml
version: '3'
services:
  philips-bridge:
    image: node:18-alpine
    volumes:
      - ./config.json:/root/.philips-ac0650/config.json
    command: npx philips-ac0650-mqtt bridge --broker mqtt://mosquitto:1883
    restart: unless-stopped
```

Place your `~/.philips-ac0650/config.json` in the same directory as the compose file, then:

```bash
docker-compose up -d
```

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

### Cloud MQTT Topics

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

### Bridge: "Failed to connect to MQTT broker"
Check that your MQTT broker is running and accessible at the specified URL. For Mosquitto: `sudo systemctl status mosquitto`.

## Credits

- [philips-airplus-homeassistant](https://github.com/ShorMeneses/philips-airplus-homeassistant) -- Home Assistant integration that documented the Versuni cloud API
- Built by reverse-engineering the Philips Air+ Android app's network traffic

## License

MIT
