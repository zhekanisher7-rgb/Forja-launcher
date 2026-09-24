'use strict';
/**
 * Offline DEV/TEST session ("Офлайн (тест)").
 * Generates the same offline UUID the vanilla server uses for offline
 * players: UUID v3 (MD5) of "OfflinePlayer:<name>".
 * This does NOT authenticate against anything and cannot join
 * online-mode servers. Real accounts: Microsoft auth module (phase 4).
 */
const crypto = require('node:crypto');

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function isValidUsername(name) {
  return USERNAME_RE.test(String(name || ''));
}

/** Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name) */
function offlineUuid(name) {
  const b = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30; // version 3
  b[8] = (b[8] & 0x3f) | 0x80; // IETF variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function createOfflineSession(username) {
  if (!isValidUsername(username)) {
    const err = new Error('Invalid username (3-16 chars: A-Z, a-z, 0-9, _)');
    err.code = 'INVALID_USERNAME';
    throw err;
  }
  return {
    type: 'offline',
    username,
    uuid: offlineUuid(username).replace(/-/g, ''),
    accessToken: '0', // no token in offline test mode
    userType: 'legacy',
    xuid: '0',
    clientId: '0',
  };
}

module.exports = { offlineUuid, isValidUsername, createOfflineSession };
