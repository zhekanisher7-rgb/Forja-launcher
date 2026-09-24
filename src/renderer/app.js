'use strict';
/* global forja */
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_LOG_LINES = 5000;
  let dict = {};
  let info = null;
  let settings = null;
  let versions = [];
  let latest = null;
  let selected = null;
  let busy = false; // preparing or running
  let running = false;

  const t = (key, vars = {}) => String(dict[key] || key).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.documentElement.lang = settings.language;
    updateMemoryLabel();
    renderVersions();
    updatePlayButton();
  }

  async function loadLanguage(lang) {
    dict = await forja.getI18n(lang);
    applyI18n();
  }

  // ---------- versions ----------
  function filters() {
    return { release: $('fRelease').checked, snapshot: $('fSnapshot').checked, old: $('fOld').checked };
  }

  async function refreshVersions(force = false) {
    $('versionList').innerHTML = `<li class="empty">${escapeHtml(t('versions.loading'))}</li>`;
    const res = await forja.listVersions({ filters: filters(), force });
    versions = res.versions;
    latest = res.latest;
    $('versionsNotice').textContent = t('versions.offline');
    $('versionsNotice').classList.toggle('hidden', !res.offline);
    if (!selected || !versions.some((v) => v.id === selected)) {
      selected = settings.selectedVersion && versions.some((v) => v.id === settings.selectedVersion)
        ? settings.selectedVersion
        : (latest && versions.some((v) => v.id === latest.release) ? latest.release : (versions[0] && versions[0].id)) || null;
    }
    renderVersions();
    updatePlayButton();
  }

  function renderVersions() {
    const list = $('versionList');
    const q = $('versionSearch').value.trim().toLowerCase();
    const shown = versions.filter((v) => !q || v.id.toLowerCase().includes(q));
    list.innerHTML = '';
    if (!shown.length) {
      list.innerHTML = `<li class="empty">${escapeHtml(t('versions.empty'))}</li>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const v of shown) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.id = v.id;
      if (v.id === selected) li.classList.add('selected');
      const tags = [];
      if (latest && (v.id === latest.release || v.id === latest.snapshot)) tags.push(`<span class="tag latest">${escapeHtml(t('versions.latest'))}</span>`);
      if (v.type !== 'release') tags.push(`<span class="tag ${v.type}">${escapeHtml(t(`type.${v.type}`))}</span>`);
      if (v.installed) tags.push(`<span class="tag installed">${escapeHtml(t('versions.installed'))}</span>`);
      li.innerHTML = `<span class="vid">${escapeHtml(v.id)}</span><span class="tags">${tags.join('')}</span>`;
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  $('versionList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li || busy) return;
    selected = li.dataset.id;
    forja.setSettings({ selectedVersion: selected });
    renderVersions();
    updatePlayButton();
  });

  // ---------- play ----------
  function currentVersion() {
    return versions.find((v) => v.id === selected) || null;
  }

  function updatePlayButton() {
    const v = currentVersion();
    $('selectedVersion').textContent = v ? v.id : t('play.noVersion');
    const btn = $('playBtn');
    btn.textContent = v && !v.installed ? t('play.install') : t('play.play');
    btn.disabled = busy || !v || !validUsername();
    $('cancelBtn').classList.toggle('hidden', !(busy && !running));
    $('killBtn').classList.toggle('hidden', !running);
    if (!busy && !$('status').dataset.sticky) setStatus(t('state.idle'));
  }

  function validUsername() {
    return /^[A-Za-z0-9_]{3,16}$/.test($('username').value);
  }

  function setStatus(text, cls = '', sticky = false) {
    const s = $('status');
    s.textContent = text;
    s.className = `status ${cls}`;
    if (sticky) s.dataset.sticky = '1'; else delete s.dataset.sticky;
  }

  $('playBtn').addEventListener('click', async () => {
    const v = currentVersion();
    if (!v || busy) return;
    busy = true;
    updatePlayButton();
    showProgress(true);
    const res = await forja.launch({
      versionId: v.id,
      username: $('username').value,
      authType: $('authType').value,
      memoryMaxMb: Number($('memory').value),
    });
    if (!res.ok) {
      busy = false;
      showProgress(false);
      updatePlayButton();
    } else {
      v.installed = true;
    }
  });

  $('cancelBtn').addEventListener('click', () => forja.cancel());
  $('killBtn').addEventListener('click', () => forja.killGame());

  function showProgress(show) {
    $('progressWrap').classList.toggle('hidden', !show);
    if (show) {
      $('progressBar').style.width = '0%';
      $('progressStep').textContent = t('state.preparing');
      $('progressFiles').textContent = '';
      $('progressMb').textContent = '';
      $('progressCurrent').textContent = '';
    }
  }

  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  forja.onProgress((p) => {
    $('progressStep').textContent = t(`step.${p.step}`);
    if (p.totalFiles) $('progressFiles').textContent = t('progress.files', { done: p.doneFiles, total: p.totalFiles });
    $('progressMb').textContent = p.totalBytes ? t('progress.mb', { done: mb(p.doneBytes), total: mb(p.totalBytes) }) : '';
    const ratio = p.totalBytes ? p.doneBytes / p.totalBytes : (p.totalFiles ? p.doneFiles / p.totalFiles : 0);
    $('progressBar').style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
    $('progressCurrent').textContent = p.current || '';
  });

  forja.onState((s) => {
    switch (s.state) {
      case 'preparing':
        setStatus(t('state.preparing'));
        break;
      case 'running':
        running = true;
        showProgress(false);
        setStatus(t('state.running', { pid: s.pid }), 'ok');
        refreshInstalledFlag();
        break;
      case 'exited':
        busy = false; running = false;
        setStatus(t('state.exited', { code: s.code != null ? s.code : s.signal }), s.code === 0 ? 'ok' : '', true);
        break;
      case 'cancelled':
        busy = false; running = false;
        showProgress(false);
        setStatus(t('state.cancelled'), '', true);
        break;
      case 'error':
        busy = false; running = false;
        showProgress(false);
        setStatus(t('state.error', { error: s.error }), 'error', true);
        appendLog(`[error] ${s.error}`, 'error');
        break;
      default:
    }
    updatePlayButton();
  });

  function refreshInstalledFlag() {
    const v = currentVersion();
    if (v) v.installed = true;
    renderVersions();
  }

  // ---------- log ----------
  const logEl = $('log');
  let pending = [];
  let flushScheduled = false;
  function appendLog(line, source) {
    pending.push({ line, source });
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flushLog);
    }
  }
  function flushLog() {
    flushScheduled = false;
    const frag = document.createDocumentFragment();
    for (const { line, source } of pending) {
      const div = document.createElement('div');
      let cls = source === 'launcher' ? 'l-launcher' : source === 'stderr' ? 'l-stderr' : '';
      if (/\/(ERROR|FATAL)\]|Exception|^\[error\]/.test(line)) cls = 'l-error';
      else if (/\/WARN\]/.test(line)) cls = 'l-warn';
      if (cls) div.className = cls;
      div.textContent = line;
      frag.appendChild(div);
    }
    pending = [];
    logEl.appendChild(frag);
    while (logEl.childElementCount > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
    if ($('autoscroll').checked) logEl.scrollTop = logEl.scrollHeight;
  }
  forja.onLog(({ line, source }) => appendLog(line, source));
  $('clearLogBtn').addEventListener('click', () => { logEl.innerHTML = ''; });
  $('copyLogBtn').addEventListener('click', () => navigator.clipboard.writeText(logEl.innerText));

  // ---------- settings ----------
  function updateMemoryLabel() {
    const v = Number($('memory').value);
    $('memoryValue').textContent = v >= 1024 ? `${(v / 1024).toFixed(v % 1024 ? 2 : 0)} ГБ`.replace('ГБ', settings.language === 'en' ? 'GB' : 'ГБ') : `${v} ${settings.language === 'en' ? 'MB' : 'МБ'}`;
    if (info) $('memoryHint').textContent = t('settings.memoryHint', { total: info.totalMemoryMb });
  }

  let saveTimer;
  function saveSoon(patch) {
    Object.assign(settings, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => forja.setSettings(patch), 300);
  }

  $('memory').addEventListener('input', () => { updateMemoryLabel(); saveSoon({ memoryMaxMb: Number($('memory').value) }); });
  $('username').addEventListener('input', () => {
    const ok = validUsername();
    $('usernameError').classList.toggle('hidden', ok);
    if (ok) saveSoon({ username: $('username').value });
    updatePlayButton();
  });
  $('language').addEventListener('change', async () => {
    settings = await forja.setSettings({ language: $('language').value });
    await loadLanguage(settings.language);
  });
  for (const id of ['fRelease', 'fSnapshot', 'fOld']) {
    $(id).addEventListener('change', () => {
      forja.setSettings({ filters: filters() });
      refreshVersions();
    });
  }
  $('versionSearch').addEventListener('input', renderVersions);
  $('refreshBtn').addEventListener('click', () => refreshVersions(true));
  $('openDirBtn').addEventListener('click', () => forja.openDataDir());

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- init ----------
  (async () => {
    info = await forja.appInfo();
    settings = await forja.getSettings();
    $('brandName').textContent = info.name;
    document.title = info.name;
    const memMax = Math.max(1024, Math.floor((info.totalMemoryMb - 512) / 256) * 256);
    $('memory').max = String(Math.min(memMax, 32768));
    $('memory').value = String(settings.memoryMaxMb);
    $('username').value = settings.username;
    $('language').value = settings.language;
    $('fRelease').checked = settings.filters.release;
    $('fSnapshot').checked = settings.filters.snapshot;
    $('fOld').checked = settings.filters.old;
    await loadLanguage(settings.language);
    appendLog(`${info.name} ${info.version} — ${info.platform}/${info.arch} — ${info.dataDir}`, 'launcher');
    await refreshVersions();
  })();
})();
