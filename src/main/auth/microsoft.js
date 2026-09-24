'use strict';
/**
 * Microsoft account authentication — PHASE 4 (not implemented yet).
 *
 * Planned flow (official): OAuth2 (device code or auth-code + PKCE) with an
 * Azure AD app registration → Xbox Live (user.auth.xboxlive.com) → XSTS →
 * Minecraft Services login_with_xbox → entitlement check → profile.
 * Requires an Azure application ID approved by Mojang for Minecraft API use.
 * The client ID must come from configuration, never hard-coded secrets.
 *
 * Must return a session of the same shape as offline.createOfflineSession:
 * { type: 'msa', username, uuid, accessToken, userType: 'msa', xuid, clientId }
 */
async function login() {
  const err = new Error('Microsoft login is not implemented yet (phase 4)');
  err.code = 'NOT_IMPLEMENTED';
  throw err;
}

async function refresh() {
  return login();
}

module.exports = { login, refresh, available: false };
