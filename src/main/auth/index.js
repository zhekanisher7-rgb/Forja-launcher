'use strict';
/**
 * Auth provider registry. Each provider produces a session object:
 * { type, username, uuid, accessToken, userType, xuid, clientId }
 */
const offline = require('./offline');
const microsoft = require('./microsoft');

const providers = {
  offline: {
    id: 'offline',
    available: true,
    async createSession({ username }) {
      return offline.createOfflineSession(username);
    },
  },
  microsoft: {
    id: 'microsoft',
    available: microsoft.available,
    async createSession() {
      return microsoft.login();
    },
  },
};

async function createSession(type, opts) {
  const p = providers[type];
  if (!p) throw new Error(`Unknown auth provider: ${type}`);
  return p.createSession(opts || {});
}

module.exports = { providers, createSession };
