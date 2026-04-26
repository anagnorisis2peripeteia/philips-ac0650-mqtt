/**
 * HTTP REST API server for Philips AC0650 Air Purifier.
 *
 * Uses the native Node.js http module (no Express dependency).
 * Provides endpoints for status, power, speed, mode, and filter resets.
 *
 * @example
 *   const { PhilipsPurifier } = require('./purifier');
 *   const { HttpServer } = require('./http-server');
 *
 *   const purifier = new PhilipsPurifier();
 *   const server = new HttpServer({ purifier, port: 8080 });
 *
 *   await purifier.connect();
 *   server.start();
 *
 *   // GET  http://localhost:8080/status
 *   // POST http://localhost:8080/power  { "on": true }
 *   // POST http://localhost:8080/speed  { "speed": 5 }
 *   // POST http://localhost:8080/mode   { "mode": "auto" }
 *   // POST http://localhost:8080/reset/clean
 *   // POST http://localhost:8080/reset/hepa
 *   // GET  http://localhost:8080/health
 */

"use strict";

const http = require("http");

// ---- Helpers ----

/**
 * Read the full request body as a string.
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Send a JSON response.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 */
function jsonResponse(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

// ---- HttpServer Class ----

class HttpServer {
  /**
   * @param {object} options
   * @param {import('./purifier').PhilipsPurifier} options.purifier - Connected purifier instance
   * @param {number} [options.port=8080] - Port to listen on
   * @param {string} [options.host='0.0.0.0'] - Host to bind to
   */
  constructor(options) {
    this.purifier = options.purifier;
    this.port = options.port || 8080;
    this.host = options.host || "0.0.0.0";
    this.server = null;
    this._startTime = Date.now();
  }

  /**
   * Start the HTTP server.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res).catch((err) => {
          jsonResponse(res, 500, { error: "Internal server error", message: err.message });
        });
      });

      this.server.on("error", reject);

      this.server.listen(this.port, this.host, () => {
        this._startTime = Date.now();
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Route and handle an incoming request.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async _handleRequest(req, res) {
    const method = req.method.toUpperCase();
    const url = req.url.split("?")[0]; // Strip query string

    // Handle CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // Route requests
    if (method === "GET" && url === "/status") {
      return this._handleStatus(req, res);
    }
    if (method === "GET" && url === "/health") {
      return this._handleHealth(req, res);
    }
    if (method === "POST" && url === "/power") {
      return this._handlePower(req, res);
    }
    if (method === "POST" && url === "/speed") {
      return this._handleSpeed(req, res);
    }
    if (method === "POST" && url === "/mode") {
      return this._handleMode(req, res);
    }
    if (method === "POST" && url === "/reset/clean") {
      return this._handleResetClean(req, res);
    }
    if (method === "POST" && url === "/reset/hepa") {
      return this._handleResetHepa(req, res);
    }

    jsonResponse(res, 404, { error: "Not found" });
  }

  // ---- Route Handlers ----

  async _handleStatus(req, res) {
    const state = this.purifier.getState();
    jsonResponse(res, 200, state);
  }

  async _handleHealth(req, res) {
    const state = this.purifier.getState();
    jsonResponse(res, 200, {
      ok: true,
      connected: state.connected,
      uptime: Math.round((Date.now() - this._startTime) / 1000),
    });
  }

  async _handlePower(req, res) {
    if (!this.purifier.connected) {
      return jsonResponse(res, 503, { error: "Purifier not connected" });
    }
    const body = await this._parseBody(req, res);
    if (body === null) return;
    if (typeof body.on !== "boolean") {
      return jsonResponse(res, 400, { error: 'Missing or invalid "on" field (boolean)' });
    }
    const result = this.purifier.setPower(body.on);
    jsonResponse(res, result.success ? 200 : 500, result);
  }

  async _handleSpeed(req, res) {
    if (!this.purifier.connected) {
      return jsonResponse(res, 503, { error: "Purifier not connected" });
    }
    const body = await this._parseBody(req, res);
    if (body === null) return;
    const speed = parseInt(body.speed, 10);
    if (isNaN(speed) || speed < 1 || speed > 16) {
      return jsonResponse(res, 400, { error: '"speed" must be a number between 1 and 16' });
    }
    const result = this.purifier.setFanSpeed(speed);
    jsonResponse(res, result.success ? 200 : 500, result);
  }

  async _handleMode(req, res) {
    if (!this.purifier.connected) {
      return jsonResponse(res, 503, { error: "Purifier not connected" });
    }
    const body = await this._parseBody(req, res);
    if (body === null) return;
    const mode = (body.mode || "").toLowerCase().trim();
    if (["auto", "sleep", "turbo"].indexOf(mode) === -1) {
      return jsonResponse(res, 400, { error: '"mode" must be one of: auto, sleep, turbo' });
    }
    const result = this.purifier.setMode(mode);
    jsonResponse(res, result.success ? 200 : 500, result);
  }

  async _handleResetClean(req, res) {
    if (!this.purifier.connected) {
      return jsonResponse(res, 503, { error: "Purifier not connected" });
    }
    const result = this.purifier.resetFilterClean();
    jsonResponse(res, result.success ? 200 : 500, result);
  }

  async _handleResetHepa(req, res) {
    if (!this.purifier.connected) {
      return jsonResponse(res, 503, { error: "Purifier not connected" });
    }
    const result = this.purifier.resetFilterReplace();
    jsonResponse(res, result.success ? 200 : 500, result);
  }

  /**
   * Parse the request body as JSON.
   * Returns null and sends a 400 response if parsing fails.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @returns {Promise<object|null>}
   */
  async _parseBody(req, res) {
    try {
      const raw = await readBody(req);
      if (!raw || raw.trim() === "") {
        jsonResponse(res, 400, { error: "Empty request body" });
        return null;
      }
      return JSON.parse(raw);
    } catch (e) {
      jsonResponse(res, 400, { error: "Invalid JSON in request body" });
      return null;
    }
  }
}

module.exports = { HttpServer };
