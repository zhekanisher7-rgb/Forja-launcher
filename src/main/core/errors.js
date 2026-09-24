'use strict';
/**
 * Map low-level errors to stable codes the UI translates into friendly
 * messages (i18n keys "error.<code>").
 */
function classifyError(err) {
  if (!err) return { code: 'unknown', message: '' };
  const msg = String(err.message || err);
  const code = err.code || (err.cause && err.cause.code) || '';
  const out = (c, params = {}) => ({ code: c, message: msg, params });

  if (err.cancelled || err.name === 'CancelledError') return out('cancelled');
  if (code === 'ENOSPC' || /ENOSPC|no space left/i.test(msg)) {
    return out('disk', { needMb: err.neededBytes ? Math.ceil(err.neededBytes / 1048576) : '', freeMb: err.freeBytes != null ? Math.floor(err.freeBytes / 1048576) : '' });
  }
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)) return out('permission', { path: err.path || '' });
  if (code === 'INVALID_USERNAME') return out('username');
  if (code === 'JAVA_NOT_FOUND') return out('javaNotFound', { path: err.path || '' });
  if (code === 'NOT_IMPLEMENTED') return out('notImplemented');
  if (code === 'PROFILE_NAME_REQUIRED') return out('profileName');
  if (code === 'PROFILE_VERSION_REQUIRED') return out('profileVersion');
  if (code === 'PROFILE_LAST') return out('profileLast');
  if (code === 'ALREADY_RUNNING') return out('alreadyRunning');
  if (code === 'LOADER_UNAVAILABLE') return out('loaderUnavailable');
  if (code === 'LOADER_PROCESSOR_FAILED') return out('loaderProcessor');
  if (code === 'NO_COMPATIBLE_VERSION') return out('noCompatibleVersion');
  if (code === 'MRPACK_INVALID') return out('mrpackInvalid');
  if (code === 'UNSAFE_PATH') return out('unsafePath');
  if (code === 'CLEANUP_BUSY') return out('cleanupBusy');
  if (code === 'UPDATE_NOT_READY') return out('updateNotReady');
  if (code === 'UPDATE_GAME_RUNNING') return out('updateGameRunning');
  if (code === 'CLEANUP_STALE') return out('cleanupStale');
  if (code === 'CHECKSUM') return out('checksum');
  if (code === 'VERSION_NOT_FOUND' || /not found locally and not present in manifest/.test(msg)) return out('versionNotFound');
  if (/SHA1 mismatch|Size mismatch|checksum/i.test(msg)) return out('checksum');
  if (err.status === 404 || /HTTP 404/.test(msg)) return out('notFound');
  if (err.status >= 500 || /HTTP 5\d\d/.test(msg)) return out('server');
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
    || /fetch failed|network|stalled|getaddrinfo/i.test(msg)) {
    return out('network');
  }
  if (code === 'ENOENT' && /java/i.test(msg)) return out('javaNotFound', { path: err.path || '' });
  return out('unknown');
}

module.exports = { classifyError };
