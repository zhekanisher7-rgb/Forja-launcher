'use strict';
const config = require('../config');

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

async function fetchWithUA(url, opts = {}) {
  const headers = { 'User-Agent': config.userAgent, ...(opts.headers || {}) };
  return fetch(url, { ...opts, headers });
}

async function fetchJson(url, { signal, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithUA(url, { signal });
      if (!res.ok) throw new HttpError(res.status, url);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (signal && signal.aborted) throw err;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

module.exports = { fetchWithUA, fetchJson, HttpError };
