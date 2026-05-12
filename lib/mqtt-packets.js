/**
 * Raw MQTT 3.1.1 packet builders for Philips/Versuni cloud MQTT.
 * Pure utility functions, zero dependencies.
 *
 * These build binary MQTT packets directly instead of using an MQTT library,
 * because the standard mqtt.js package has keepalive issues with the Versuni
 * broker (AWS IoT custom authorizer).
 */

"use strict";

/**
 * Encode MQTT remaining length field (variable-length encoding).
 * @param {number} n - Length value to encode
 * @returns {Buffer}
 */
function encodeRemaining(n) {
  const bytes = [];
  do {
    let b = n & 0x7F;
    n = n >> 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

/**
 * Build an MQTT CONNECT packet.
 * @param {string} clientId - MQTT client ID
 * @param {number} [keepalive=30] - Keepalive interval in seconds
 * @param {string} [username] - Optional username
 * @param {string} [password] - Optional password
 * @returns {Buffer}
 */
function buildConnect(clientId, keepalive = 30, username, password) {
  const clientIdBuf = Buffer.from(clientId, "utf8");
  let connectFlags = 0x02; // Clean session

  const payloadParts = [];

  // Client ID
  const cidLen = Buffer.alloc(2);
  cidLen.writeUInt16BE(clientIdBuf.length, 0);
  payloadParts.push(cidLen, clientIdBuf);

  if (username) {
    connectFlags |= 0x80;
    const userBuf = Buffer.from(username, "utf8");
    const userLen = Buffer.alloc(2);
    userLen.writeUInt16BE(userBuf.length, 0);
    payloadParts.push(userLen, userBuf);
  }

  if (password) {
    connectFlags |= 0x40;
    const passBuf = Buffer.from(password, "utf8");
    const passLen = Buffer.alloc(2);
    passLen.writeUInt16BE(passBuf.length, 0);
    payloadParts.push(passLen, passBuf);
  }

  const varHeader = Buffer.from([
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
    0x04, // protocol level 3.1.1
    connectFlags,
    (keepalive >> 8) & 0xff,
    keepalive & 0xff,
  ]);

  const payload = Buffer.concat(payloadParts);
  const remaining = varHeader.length + payload.length;

  return Buffer.concat([
    Buffer.from([0x10]),
    encodeRemaining(remaining),
    varHeader,
    payload,
  ]);
}

/**
 * Build an MQTT SUBSCRIBE packet.
 * @param {string|string[]} topics - Topic(s) to subscribe to
 * @param {number} [packetId=1] - Packet identifier
 * @returns {Buffer}
 */
function buildSubscribe(topics, packetId = 1) {
  const topicList = Array.isArray(topics) ? topics : [topics];
  const topicParts = topicList.map((t) => {
    const buf = Buffer.from(t, "utf8");
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(buf.length, 0);
    return Buffer.concat([
      lenBuf,
      buf,
      Buffer.from([0x00]), // QoS 0
    ]);
  });
  const payload = Buffer.concat(topicParts);
  const remaining = 2 + payload.length;
  return Buffer.concat([
    Buffer.from([0x82]),
    encodeRemaining(remaining),
    Buffer.from([0x00, packetId]),
    payload,
  ]);
}

/**
 * Build an MQTT PUBLISH packet (QoS 0).
 * @param {string} topic - Topic to publish to
 * @param {string|Buffer} payload - Message payload
 * @returns {Buffer}
 */
function buildPublish(topic, payload) {
  const topicBuf = Buffer.from(topic, "utf8");
  const payloadBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload, "utf8");
  const topicLen = Buffer.alloc(2);
  topicLen.writeUInt16BE(topicBuf.length, 0);

  const remaining = 2 + topicBuf.length + payloadBuf.length;
  return Buffer.concat([
    Buffer.from([0x30]),
    encodeRemaining(remaining),
    topicLen,
    topicBuf,
    payloadBuf,
  ]);
}

/**
 * Build an MQTT PUBLISH packet with QoS 1 (requires PUBACK from broker).
 * @param {string} topic - Topic to publish to
 * @param {string|Buffer} payload - Message payload
 * @param {number} packetId - Packet identifier for QoS 1 acknowledgement
 * @returns {Buffer}
 */
function buildPublishQoS1(topic, payload, packetId) {
  const topicBuf = Buffer.from(topic, "utf8");
  const payloadBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload, "utf8");
  const topicLen = Buffer.alloc(2);
  topicLen.writeUInt16BE(topicBuf.length, 0);

  const remaining = 2 + topicBuf.length + 2 + payloadBuf.length;
  return Buffer.concat([
    Buffer.from([0x32]),
    encodeRemaining(remaining),
    topicLen,
    topicBuf,
    Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]),
    payloadBuf,
  ]);
}

/**
 * Build an MQTT PINGREQ packet.
 * @returns {Buffer}
 */
function buildPingreq() {
  return Buffer.from([0xc0, 0x00]);
}

module.exports = {
  encodeRemaining,
  buildConnect,
  buildSubscribe,
  buildPublish,
  buildPublishQoS1,
  buildPingreq,
};
