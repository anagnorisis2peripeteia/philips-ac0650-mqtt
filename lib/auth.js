/**
 * OAuth token management and MQTT signature refresh for Philips/Versuni cloud.
 *
 * Handles:
 * - Loading/saving config from JSON file
 * - Refreshing OAuth access tokens via refresh_token grant
 * - Fetching MQTT WebSocket signatures from the Versuni API
 * - Checking token expiry and auto-refreshing when needed
 *
 * Uses native https module (no node-fetch dependency).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

// ---- Constants ----

const TOKEN_URL =
  "https://cdc.accounts.home.id/oidc/op/v1.0/4_JGZWlP8eQHpEqkvQElolbA/token";
const CLIENT_ID = "-XsK7O6iEkLml77yDGDUi0ku";
const API_BASE = "https://prod.eu-da.iot.versuni.com/api";
const USER_AGENT = "okhttp/4.12.0";

// ---- Helpers ----

/**
 * Make an HTTPS request. Returns { statusCode, headers, body }.
 * @param {string} url
 * @param {object} options - { method, headers, body, timeout }
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: options.timeout || 15000,
    };
    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ---- Config I/O ----

/**
 * Load config from a JSON file.
 * @param {string} configPath - Absolute path to config.json
 * @returns {object} Parsed config
 */
function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

/**
 * Save config to a JSON file (creates parent directory if needed).
 * @param {string} configPath - Absolute path to config.json
 * @param {object} config - Config object to save
 */
function saveConfig(configPath, config) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

// ---- Token Management ----

/**
 * Refresh OAuth tokens using the refresh_token grant.
 * Updates config.access_token and config.refresh_token in place.
 * @param {object} config
 * @returns {Promise<object>} Updated config
 */
async function refreshTokens(config) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refresh_token,
    client_id: CLIENT_ID,
  }).toString();

  const resp = await httpsRequest(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });

  if (resp.statusCode !== 200) {
    throw new Error(
      `Token refresh failed (HTTP ${resp.statusCode}): ${resp.body.substring(0, 200)}`
    );
  }

  const data = JSON.parse(resp.body);
  config.access_token = data.access_token;
  if (data.refresh_token) {
    config.refresh_token = data.refresh_token;
  }
  // Store expiry timestamp (1 minute buffer)
  config.token_expires_at = Date.now() + (data.expires_in - 60) * 1000;
  return config;
}

/**
 * Fetch a fresh MQTT WebSocket signature from the Versuni API.
 * Stores the signature in config.mqtt_signature.
 * @param {object} config
 * @returns {Promise<string>} The signature string
 */
async function refreshSignature(config) {
  const resp = await httpsRequest(`${API_BASE}/da/user/self/signature`, {
    headers: {
      Authorization: `Bearer ${config.access_token}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (resp.statusCode !== 200) {
    throw new Error(
      `Signature fetch failed (HTTP ${resp.statusCode}): ${resp.body.substring(0, 200)}`
    );
  }

  const data = JSON.parse(resp.body);
  config.mqtt_signature = data.signature;
  return data.signature;
}

/**
 * Ensure access token is still valid; refresh if expired.
 * @param {object} config
 * @returns {Promise<object>} Updated config (may have new tokens)
 */
async function ensureTokens(config) {
  let expiresAt = config.token_expires_at;

  // If no stored expiry, try to parse from JWT
  if (!expiresAt && config.access_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(config.access_token.split(".")[1], "base64url").toString()
      );
      expiresAt = payload.exp * 1000 - 60000;
    } catch (e) {
      // Assume expired if we cannot parse
      expiresAt = 0;
    }
  }

  if (!expiresAt || Date.now() >= expiresAt) {
    await refreshTokens(config);
  }

  return config;
}

// ---- Token Exchange (for setup) ----

/**
 * Exchange an authorization code for tokens.
 * @param {string} code - The auth code from the redirect URL
 * @returns {Promise<object>} Token response { access_token, refresh_token, id_token, expires_in }
 */
async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "com.philips.air://loginredirect",
    client_id: CLIENT_ID,
  }).toString();

  const resp = await httpsRequest(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });

  if (resp.statusCode !== 200) {
    throw new Error(
      `Code exchange failed (HTTP ${resp.statusCode}): ${resp.body.substring(0, 200)}`
    );
  }

  return JSON.parse(resp.body);
}

/**
 * List devices for the authenticated user.
 * @param {string} accessToken
 * @returns {Promise<object[]>} Array of device objects
 */
async function listDevices(accessToken) {
  const resp = await httpsRequest(`${API_BASE}/da/user/self/device`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (resp.statusCode !== 200) {
    throw new Error(
      `Device list failed (HTTP ${resp.statusCode}): ${resp.body.substring(0, 200)}`
    );
  }

  return JSON.parse(resp.body);
}

/**
 * Get user info (including user ID needed for MQTT client ID).
 * @param {string} accessToken
 * @returns {Promise<object>} User object
 */
async function getUserInfo(accessToken) {
  const resp = await httpsRequest(`${API_BASE}/da/user/self`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (resp.statusCode !== 200) {
    throw new Error(
      `User info failed (HTTP ${resp.statusCode}): ${resp.body.substring(0, 200)}`
    );
  }

  return JSON.parse(resp.body);
}

module.exports = {
  TOKEN_URL,
  CLIENT_ID,
  API_BASE,
  USER_AGENT,
  httpsRequest,
  loadConfig,
  saveConfig,
  refreshTokens,
  refreshSignature,
  ensureTokens,
  exchangeCode,
  listDevices,
  getUserInfo,
};
