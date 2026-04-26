/**
 * Interactive onboarding wizard for Philips AC0650 cloud control.
 *
 * Walks the user through:
 * 1. Opening the OAuth authorize URL in their browser
 * 2. Logging in with their Philips Air+ account
 * 3. Pasting the redirect URL (com.philips.air:// — the browser will error)
 * 4. Exchanging the auth code for tokens (using PKCE)
 * 5. Listing devices and selecting one
 * 6. Saving config to ~/.philips-ac0650/config.json
 *
 * Uses only Node.js stdlib (readline, crypto). No external dependencies.
 */

"use strict";

const readline = require("readline");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const auth = require("./auth");

const ISSUER_BASE =
  "https://cdc.accounts.home.id/oidc/op/v1.0/4_JGZWlP8eQHpEqkvQElolbA";
const REDIRECT_URI = "com.philips.air://loginredirect";

/**
 * Prompt the user for a line of input.
 * @param {readline.Interface} rl
 * @param {string} question
 * @returns {Promise<string>}
 */
function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Run the interactive setup wizard.
 * @param {string} [configPath] - Override config file location
 * @returns {Promise<void>}
 */
async function runSetup(configPath) {
  const configDir = configPath
    ? path.dirname(configPath)
    : path.join(os.homedir(), ".philips-ac0650");
  const configFile = configPath || path.join(configDir, "config.json");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const state = crypto.randomBytes(16).toString("hex");

    // PKCE — required by Philips since mid-2025
    const codeVerifier = crypto.randomBytes(48).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const authorizeUrl =
      ISSUER_BASE +
      "/authorize?" +
      new URLSearchParams({
        client_id: auth.CLIENT_ID,
        response_type: "code",
        scope: "openid email profile",
        redirect_uri: REDIRECT_URI,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();

    console.log();
    console.log("Philips AC0650 Cloud Setup");
    console.log("─".repeat(40));
    console.log();
    console.log("1. Open this URL in your browser:");
    console.log();
    console.log("   " + authorizeUrl);
    console.log();
    console.log("2. Before opening the URL, set up Chrome/Edge to capture the redirect:");
    console.log();
    console.log("   a) Press F12 to open DevTools");
    console.log("   b) Click the Network tab");
    console.log("   c) Tick the 'Preserve log' checkbox (keeps requests after the error page loads)");
    console.log();
    console.log("3. Paste the URL above into the address bar and press Enter");
    console.log("4. Log in with your Philips Air+ account credentials");
    console.log("5. After the 'site can't be reached' error appears:");
    console.log();
    console.log("   a) In the Network tab, type 'loginredirect' in the filter box");
    console.log("   b) Click the matching request (it will have a 302 status)");
    console.log("   c) Click the 'Headers' tab in the right panel");
    console.log("   d) Under 'Response Headers', find the 'location' entry");
    console.log("   e) Copy the full value — it starts with com.philips.air://loginredirect?code=...");
    console.log();

    const redirectUrl = await ask(rl, "Paste the com.philips.air:// redirect URL: ");
    console.log();

    // Extract authorization code from the pasted URL
    let code;
    try {
      // Replace custom scheme so URL() can parse it
      const parseable = redirectUrl.replace(
        /^com\.philips\.air:\/\//,
        "http://placeholder/"
      );
      const parsed = new URL(parseable);
      code = parsed.searchParams.get("code");
    } catch (e) {
      // Fallback: regex extraction
      const match = redirectUrl.match(/[?&]code=([^&]+)/);
      if (match) code = match[1];
    }

    if (!code) {
      console.error("Could not find authorization code in the URL.");
      console.error("Make sure you copied the full URL starting with com.philips.air://");
      process.exit(1);
    }

    console.log("Authorization code found. Exchanging for tokens...");

    // Exchange code for tokens — must include the PKCE verifier
    const tokenData = await auth.exchangeCode(code, codeVerifier);
    console.log("Tokens received.");

    // Get user info
    console.log("Fetching user info...");
    const userInfo = await auth.getUserInfo(tokenData.access_token);
    const userId = userInfo.id || userInfo.userId || userInfo.sub;
    if (!userId) {
      console.error("Could not determine user ID from API response.");
      console.error("Response keys: " + Object.keys(userInfo).join(", "));
      process.exit(1);
    }
    console.log("User ID: " + userId);

    // List devices
    console.log("Fetching devices...");
    const devices = await auth.listDevices(tokenData.access_token);

    if (!devices || devices.length === 0) {
      console.error("No devices found on your account.");
      console.error(
        "Make sure you have set up your purifier in the Air+ app first."
      );
      process.exit(1);
    }

    let device;
    if (devices.length === 1) {
      device = devices[0];
      console.log(
        "Found 1 device: " +
          (device.friendlyName || device.ctn) +
          " (" +
          device.ctn +
          ")"
      );
    } else {
      console.log();
      console.log("Found " + devices.length + " devices:");
      devices.forEach(function (d, i) {
        console.log(
          "  " +
            (i + 1) +
            ". " +
            (d.friendlyName || "Unnamed") +
            " (" +
            d.ctn +
            ") - " +
            d.id.substring(0, 8) +
            "..."
        );
      });
      console.log();
      const choice = await ask(rl, "Select device (1-" + devices.length + "): ");
      const idx = parseInt(choice, 10) - 1;
      if (idx < 0 || idx >= devices.length) {
        console.error("Invalid selection.");
        process.exit(1);
      }
      device = devices[idx];
    }

    // Build config
    const config = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expires_at: Date.now() + (tokenData.expires_in - 60) * 1000,
      user_id: userId,
      device_id: device.id,
      thing_name: device.thingName || "da-" + device.id,
      device_model: device.ctn,
      device_name: device.friendlyName || device.ctn,
    };

    // Save config
    auth.saveConfig(configFile, config);

    console.log();
    console.log("Setup complete!");
    console.log("Config saved to: " + configFile);
    console.log();
    console.log("You can now use:");
    console.log("  philips-ac0650 status   # view current state");
    console.log("  philips-ac0650 on       # power on");
    console.log("  philips-ac0650 off      # power off");
    console.log("  philips-ac0650 monitor  # live status stream");
    console.log();
  } finally {
    rl.close();
  }
}

module.exports = { runSetup };
