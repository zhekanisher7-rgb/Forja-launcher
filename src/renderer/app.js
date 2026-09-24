'use strict';
/* global forja, renderProfileIcon, FORJA_ICONS */
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_LOG = 8000;

  const state = {
    info: null,
    settings: null,
    dict: {},
    profiles: [],
    selectedId: null,
    games: new Map(), // profileId -> { state, pid, progress }
    installed: new Set(),
    latest: null,
    logs: [], // { profileId, line, source }
    logFilter: 'all',
    tab: 'profiles',
  };

  // ------------------------------------------------------------ helpers
  const t = (key, vars = {}) => String(state.dict[key] != null ? state.dict[key] : key)
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));

  async function api(fn, ...args) {
    const res = await forja[fn](...args);
    if (!res || !res.ok) {
      const err = new Error((res && res.error && res.error.message) || 'error');
      err.info = (res && res.error) || { code: 'unknown' };
      throw err;
    }
    return res.data;
  }

  function friendlyError(errInfo) {
    const info = errInfo && errInfo.info ? errInfo.info : errInfo || { code: 'unknown' };
    const key = `error.${info.code}`;
    const text = state.dict[key] ? t(key, info.params || {}) : t('error.unknown');
    return { text, detail: info.code === 'unknown' ? info.message : '' };
  }

  function toastError(err, title) {
    const f = friendlyError(err);
    if ((err && err.info ? err.info.code : err && err.code) === 'cancelled') return;
    toast({ type: 'error', title: title || t('toast.errorTitle'), message: f.detail ? `${f.text} (${f.detail})` : f.text, timeout: 9000 });
  }

  const mb = (b) => (b / 1048576).toFixed(b >= 1048576 * 100 ? 0 : 1);
  function formatMem(v) {
    const unitG = state.settings.language === 'en' ? 'GB' : 'ГБ';
    const unitM = state.settings.language === 'en' ? 'MB' : 'МБ';
    return v >= 1024 ? `${(v / 1024).toFixed(v % 1024 ? 2 : 0).replace(/\.?0+$/, '')} ${unitG}` : `${v} ${unitM}`;
  }
  function formatEta(sec) {
    if (sec == null) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function relTime(iso) {
    if (!iso) return t('profile.neverPlayed');
    const diff = (new Date(iso).getTime() - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(state.settings.language, { numeric: 'auto' });
    const abs = Math.abs(diff);
    let text;
    if (abs < 60) text = rtf.format(Math.round(diff), 'second');
    else if (abs < 3600) text = rtf.format(Math.round(diff / 60), 'minute');
    else if (abs < 86400) text = rtf.format(Math.round(diff / 3600), 'hour');
    else if (abs < 86400 * 30) text = rtf.format(Math.round(diff / 86400), 'day');
    else text = new Date(iso).toLocaleDateString(state.settings.language);
    return t('profile.lastPlayed', { when: text });
  }
  const selected = () => state.profiles.find((p) => p.id === state.selectedId) || null;
  const gameOf = (id) => state.games.get(id) || { state: 'idle' };
  const isBusy = (id) => ['preparing', 'running', 'repairing'].includes(gameOf(id).state);

  // ------------------------------------------------------------ toasts
  function toast({ type = 'info', title = '', message = '', timeout = 5000 }) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const body = document.createElement('div');
    body.className = 't-body';
    const tt = document.createElement('div');
    tt.className = 't-title';
    tt.textContent = title;
    const tm = document.createElement('div');
    tm.className = 't-msg';
    tm.textContent = message;
    body.append(tt, tm);
    const close = document.createElement('button');
    close.className = 'icon-btn';
    close.setAttribute('aria-label', t('common.close'));
    close.textContent = '✕';
    el.append(body, close);
    const remove = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    close.addEventListener('click', remove);
    $('toasts').appendChild(el);
    while ($('toasts').childElementCount > 4) $('toasts').firstElementChild.remove();
    if (timeout) setTimeout(remove, timeout);
  }

  // ------------------------------------------------------------ modals
  let modalStack = [];
  function openModal(el, focusEl) {
    modalStack.push({ el, restore: document.activeElement });
    el.hidden = false;
    setTimeout(() => (focusEl || el.querySelector('input, select, textarea, button'))?.focus(), 30);
  }
  function closeModal(el) {
    const idx = modalStack.findIndex((m) => m.el === el);
    if (idx === -1) return;
    const [m] = modalStack.splice(idx, 1);
    el.hidden = true;
    if (m.restore && m.restore.focus) m.restore.focus();
    if (el._onClose) { const f = el._onClose; el._onClose = null; f(); }
  }
  document.querySelectorAll('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('mousedown', (e) => { if (e.target === bd) closeModal(bd); });
    bd.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); closeModal(bd); }));
  });
  document.addEventListener('keydown', (e) => {
    const top = modalStack[modalStack.length - 1];
    if (!top) {
      // global shortcuts: Ctrl+1/2/3 switch tabs, Ctrl+N new profile
      if (e.ctrlKey && ['1', '2', '3'].includes(e.key)) { selectTab(['profiles', 'settings', 'log'][Number(e.key) - 1], true); e.preventDefault(); }
      if (e.ctrlKey && e.key.toLowerCase() === 'n') { openEditor(null); e.preventDefault(); }
      return;
    }
    if (e.key === 'Escape') { closeModal(top.el); e.preventDefault(); }
    if (e.key === 'Tab') { // focus trap
      const f = [...top.el.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    }
  });

  function confirmDialog({ title, text, ok, checkLabel = null }) {
    return new Promise((resolve) => {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmOk').textContent = ok;
      $('confirmCheckWrap').classList.toggle('hidden', !checkLabel);
      $('confirmCheck').checked = false;
      $('confirmCheckLabel').textContent = checkLabel || '';
      let result = null;
      $('confirmOk').onclick = () => { result = { checked: $('confirmCheck').checked }; closeModal($('confirmModal')); };
      $('confirmModal')._onClose = () => resolve(result);
      openModal($('confirmModal'), $('confirmOk'));
    });
  }

  // ------------------------------------------------------------ i18n
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.documentElement.lang = state.settings.language;
    renderAll();
  }
  async function loadLanguage(lang) {
    state.dict = await api('getI18n', lang);
    applyI18n();
  }

  // ------------------------------------------------------------ tabs
  function selectTab(name, focus = false) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      const on = p.id === `tab-${name}`;
      p.hidden = !on;
      p.classList.toggle('active', on);
    });
    if (name === 'log') { $('logDot').classList.add('hidden'); renderLog(); }
    if (name === 'settings') renderSettings();
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const tabs = ['profiles', 'settings', 'log'];
    const i = tabs.indexOf(state.tab);
    if (e.key === 'ArrowRight') { selectTab(tabs[(i + 1) % 3], true); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { selectTab(tabs[(i + 2) % 3], true); e.preventDefault(); }
  });

  // ------------------------------------------------------------ sidebar
  function renderProfileList() {
    const list = $('profileList');
    list.textContent = '';
    $('profileCount').textContent = String(state.profiles.length);
    for (const p of state.profiles) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'profile-item';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(p.id === state.selectedId));
      btn.tabIndex = p.id === state.selectedId ? 0 : -1;
      btn.dataset.id = p.id;
      const icon = document.createElement('div');
      icon.className = 'hero-icon';
      renderProfileIcon(icon, p.icon);
      const text = document.createElement('div');
      text.className = 'pi-text';
      const name = document.createElement('div');
      name.className = 'pi-name';
      name.textContent = p.name;
      const ver = document.createElement('div');
      ver.className = 'pi-ver';
      ver.textContent = p.versionId || t('profile.noVersion');
      text.append(name, ver);
      const g = gameOf(p.id);
      if (g.state === 'preparing' || g.state === 'repairing') {
        const bar = document.createElement('div');
        bar.className = 'pi-progress';
        const fill = document.createElement('div');
        fill.style.width = `${progressRatio(g.progress) * 100}%`;
        bar.appendChild(fill);
        text.appendChild(bar);
      }
      btn.append(icon, text);
      if (g.state === 'running') {
        const b = document.createElement('span');
        b.className = 'pi-badge';
        b.textContent = t('badge.running');
        btn.appendChild(b);
      } else if (g.state === 'preparing' || g.state === 'repairing') {
        const b = document.createElement('span');
        b.className = 'pi-badge busy';
        b.textContent = t(g.state === 'repairing' ? 'badge.repairing' : 'badge.installing');
        btn.appendChild(b);
      }
      li.appendChild(btn);
      list.appendChild(li);
    }
    const running = [...state.games.values()].filter((g) => g.state === 'running').length;
    $('runningSummary').classList.toggle('hidden', running === 0);
    $('runningSummary').textContent = t('badge.runningCount', { n: running });
  }
  $('profileList').addEventListener('click', (e) => {
    const b = e.target.closest('.profile-item');
    if (b) selectProfile(b.dataset.id);
  });
  $('profileList').addEventListener('dblclick', (e) => {
    const b = e.target.closest('.profile-item');
    if (b && !isBusy(b.dataset.id)) play();
  });
  $('profileList').addEventListener('keydown', (e) => {
    const idx = state.profiles.findIndex((p) => p.id === state.selectedId);
    let next = null;
    if (e.key === 'ArrowDown') next = Math.min(state.profiles.length - 1, idx + 1);
    if (e.key === 'ArrowUp') next = Math.max(0, idx - 1);
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = state.profiles.length - 1;
    if (next != null) {
      e.preventDefault();
      selectProfile(state.profiles[next].id);
      $('profileList').querySelector(`[data-id="${state.profiles[next].id}"]`)?.focus();
    }
    if (e.key === 'Enter' && e.ctrlKey) play();
  });

  function selectProfile(id) {
    state.selectedId = id;
    api('setSettings', { selectedProfileId: id }).then((s) => { state.settings = s; }).catch(() => {});
    renderProfileList();
    renderHero();
    if (state.tab !== 'profiles') selectTab('profiles');
  }

  // ------------------------------------------------------------ hero
  function progressRatio(p) {
    if (!p) return 0;
    if (p.totalBytes) return Math.min(1, p.doneBytes / p.totalBytes);
    if (p.totalFiles) return Math.min(1, p.doneFiles / p.totalFiles);
    return 0;
  }

  function renderHero() {
    const p = selected();
    const has = Boolean(p);
    ['editBtn', 'duplicateBtn', 'openFolderBtn', 'repairBtn', 'deleteBtn', 'playBtn'].forEach((id) => { $(id).disabled = !has; });
    if (!p) return;
    const g = gameOf(p.id);
    renderProfileIcon($('heroIcon'), p.icon);
    $('hero').style.setProperty('--hero-color', p.icon.color);
    $('heroName').textContent = p.name;
    $('heroVersion').textContent = p.versionId ? `Minecraft ${p.versionId}` : t('profile.noVersion');
    $('heroLastPlayed').textContent = relTime(p.lastPlayed);
    $('heroRunning').classList.toggle('hidden', g.state !== 'running');
    $('heroRunning').textContent = g.pid ? t('badge.runningPid', { pid: g.pid }) : t('badge.running');

    const preparing = g.state === 'preparing' || g.state === 'repairing';
    $('playBtn').disabled = !p.versionId || isBusy(p.id) || !validUsername();
    $('playLabel').textContent = p.versionId && !state.installed.has(p.versionId) ? t('play.install') : t('play.play');
    $('cancelBtn').classList.toggle('hidden', !preparing);
    $('killBtn').classList.toggle('hidden', g.state !== 'running');
    $('repairBtn').disabled = !p.versionId || isBusy(p.id);
    $('deleteBtn').disabled = isBusy(p.id) || state.profiles.length < 2;

    const st = $('heroStatus');
    st.className = 'hero-status';
    if (g.state === 'running') { st.textContent = t('state.running', { pid: g.pid }); st.classList.add('ok'); }
    else if (g.state === 'preparing') st.textContent = t('state.preparing');
    else if (g.state === 'repairing') st.textContent = t('state.repairing');
    else if (g.lastStatus) { st.textContent = g.lastStatus.text; if (g.lastStatus.cls) st.classList.add(g.lastStatus.cls); }
    else if (!validUsername()) { st.textContent = t('account.usernameInvalid'); st.classList.add('error'); }
    else if (p.versionId && !state.installed.has(p.versionId)) st.textContent = t('state.notInstalled');
    else st.textContent = t('state.idle');

    $('progressWrap').classList.toggle('visible', preparing);
    $('progressWrap').setAttribute('aria-hidden', String(!preparing));
    if (preparing) renderProgress(g.progress);

    const s = state.settings;
    $('dMemory').textContent = p.memoryMaxMb ? formatMem(p.memoryMaxMb) : `${formatMem(s.defaultMemoryMb)} (${t('profile.default')})`;
    $('dJava').textContent = p.java.mode === 'custom' ? p.java.path : (s.defaultJavaPath ? `${t('java.global')}: ${s.defaultJavaPath}` : t('java.auto'));
    const r = p.resolution;
    $('dResolution').textContent = r.fullscreen ? t('profile.fullscreen') : (r.width && r.height ? `${r.width} × ${r.height}` : t('profile.default'));
    $('dJvm').textContent = p.jvmArgs || '—';
    $('dGameDir').textContent = p.gameDir;
    $('dGameDir').title = p.gameDir;
  }

  function renderProgress(p) {
    if (!p) {
      $('progressStep').textContent = t('state.preparing');
      ['progressFiles', 'progressMb', 'progressSpeed', 'progressEta', 'progressCurrent'].forEach((id) => { $(id).textContent = ''; });
      $('progressBar').style.width = '0%';
      return;
    }
    $('progressStep').textContent = t(`step.${p.step}`);
    $('progressFiles').textContent = p.totalFiles ? t('progress.files', { done: p.doneFiles, total: p.totalFiles }) : '';
    $('progressMb').textContent = p.totalBytes ? t('progress.mb', { done: mb(p.doneBytes), total: mb(p.totalBytes) }) : '';
    $('progressSpeed').textContent = p.speedBps > 1024 ? t('progress.speed', { speed: (p.speedBps / 1048576).toFixed(1) }) : '';
    $('progressEta').textContent = p.etaSec != null ? t('progress.eta', { eta: formatEta(p.etaSec) }) : '';
    const pct = progressRatio(p) * 100;
    $('progressBar').style.width = `${pct.toFixed(1)}%`;
    $('progressBarOuter').setAttribute('aria-valuenow', pct.toFixed(0));
    $('progressCurrent').textContent = p.current || '';
  }

  // ------------------------------------------------------------ actions
  async function play() {
    const p = selected();
    if (!p || isBusy(p.id)) return;
    if (!validUsername()) { $('username').focus(); return; }
    state.games.set(p.id, { state: 'preparing', progress: null });
    renderProfileList();
    renderHero();
    try {
      await api('launch', p.id);
    } catch (err) {
      // state event already reported (or error before start)
      if (gameOf(p.id).state === 'preparing') state.games.set(p.id, { state: 'idle' });
      const code = err.info && err.info.code;
      if (code !== 'cancelled') {
        const f = friendlyError(err);
        state.games.set(p.id, { state: 'idle', lastStatus: { text: f.text, cls: 'error' } });
        toastError(err, t('toast.launchFailed', { name: p.name }));
      }
      renderProfileList();
      renderHero();
    }
  }
  $('playBtn').addEventListener('click', play);
  $('cancelBtn').addEventListener('click', () => { const p = selected(); if (p) api('cancel', p.id).catch(toastError); });
  $('killBtn').addEventListener('click', () => { const p = selected(); if (p) api('kill', p.id).catch(toastError); });
  $('openFolderBtn').addEventListener('click', () => { const p = selected(); if (p) api('openProfileDir', p.id).catch(toastError); });
  $('editBtn').addEventListener('click', () => { const p = selected(); if (p) openEditor(p); });
  $('newProfileBtn').addEventListener('click', () => openEditor(null));
  $('duplicateBtn').addEventListener('click', async () => {
    const p = selected();
    if (!p) return;
    try {
      const copy = await api('duplicateProfile', p.id, { name: t('profile.copyName', { name: p.name }).slice(0, 40) });
      await refreshProfiles();
      selectProfile(copy.id);
      toast({ type: 'success', title: t('toast.duplicated'), message: copy.name });
    } catch (err) { toastError(err); }
  });
  $('deleteBtn').addEventListener('click', async () => {
    const p = selected();
    if (!p) return;
    const r = await confirmDialog({
      title: t('confirm.deleteTitle'),
      text: t('confirm.deleteText', { name: p.name }),
      ok: t('profile.delete'),
      checkLabel: t('confirm.deleteFiles'),
    });
    if (!r) return;
    try {
      await api('deleteProfile', p.id, { deleteFiles: r.checked });
      await refreshProfiles();
      selectProfile(state.profiles[0].id);
      toast({ type: 'success', title: t('toast.deleted'), message: p.name });
    } catch (err) { toastError(err); }
  });
  async function repair(profileId) {
    const p = state.profiles.find((x) => x.id === profileId);
    if (!p || isBusy(p.id)) return;
    state.games.set(p.id, { state: 'repairing', progress: null });
    renderProfileList();
    renderHero();
    try {
      await api('repair', p.id);
    } catch (err) {
      state.games.set(p.id, { state: 'idle' });
      toastError(err, t('toast.repairFailed', { name: p.name }));
      renderProfileList();
      renderHero();
    }
  }
  $('repairBtn').addEventListener('click', () => { const p = selected(); if (p) repair(p.id); });

  // ------------------------------------------------------------ username (global account)
  function validUsername() {
    return /^[A-Za-z0-9_]{3,16}$/.test($('username').value);
  }
  let userTimer;
  $('username').addEventListener('input', () => {
    const ok = validUsername();
    $('usernameError').classList.toggle('hidden', ok);
    $('username').setAttribute('aria-invalid', String(!ok));
    clearTimeout(userTimer);
    if (ok) userTimer = setTimeout(() => api('setSettings', { username: $('username').value }).then((s) => { state.settings = s; }), 300);
    renderHero();
  });

  // ------------------------------------------------------------ profile editor
  const editor = { mode: 'create', id: null, icon: null, versions: [] };

  async function openEditor(profile) {
    editor.mode = profile ? 'edit' : 'create';
    editor.id = profile ? profile.id : null;
    const s = state.settings;
    const base = profile || {
      name: '',
      icon: { type: 'preset', preset: state.info.iconPresets[Math.floor(Math.random() * state.info.iconPresets.length)], color: state.info.colors[Math.floor(Math.random() * state.info.colors.length)] },
      versionId: state.latest ? state.latest.release : null,
      memoryMaxMb: null,
      jvmArgs: '',
      resolution: { width: null, height: null, fullscreen: false },
      java: { mode: 'auto', path: null },
    };
    $('editTitle').textContent = profile ? t('editor.editTitle', { name: profile.name }) : t('editor.newTitle');
    $('eName').value = base.name;
    editor.letterTouched = Boolean(profile && base.icon.type === 'letter');
    editor.icon = { ...base.icon, letter: base.icon.letter || (base.name || '').charAt(0).toUpperCase() };
    $('eLetter').value = editor.icon.letter || '';
    $('eMemDefault').checked = base.memoryMaxMb == null;
    $('eMemory').value = String(base.memoryMaxMb || s.defaultMemoryMb);
    $('eWidth').value = base.resolution.width || '';
    $('eHeight').value = base.resolution.height || '';
    $('eFullscreen').checked = base.resolution.fullscreen;
    document.querySelector(`input[name="eJavaMode"][value="${base.java.mode}"]`).checked = true;
    $('eJavaPath').value = base.java.path || '';
    $('eJvmArgs').value = base.jvmArgs || '';
    $('eError').classList.add('hidden');
    $('eVersionSearch').value = '';
    const sel = base.versionId || '';
    const selType = sel && !/^\d+\.\d+(\.\d+)?$/.test(sel) && !/^\d{2}\.\d/.test(sel);
    $('eRelease').checked = true;
    $('eSnapshot').checked = s.showSnapshots || Boolean(selType && /w|pre|rc|snapshot/.test(sel));
    $('eOld').checked = s.showOld || /^[ab]\d/.test(sel);
    editor.selectedVersion = sel;
    updateEditorMem();
    updateEditorJava();
    renderIconPicker();
    $('editForm').scrollTop = 0;
    openModal($('editModal'), $('eName'));
    await loadEditorVersions();
  }

  function renderIconPicker() {
    renderProfileIcon($('eIconPreview'), editor.icon);
    document.querySelector(`input[name="eIconType"][value="${editor.icon.type}"]`).checked = true;
    $('eLetter').disabled = editor.icon.type !== 'letter';
    const grid = $('eIconGrid');
    grid.textContent = '';
    for (const key of state.info.iconPresets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-choice';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', t(`icon.${key}`));
      b.title = t(`icon.${key}`);
      b.setAttribute('aria-checked', String(editor.icon.type === 'preset' && editor.icon.preset === key));
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${FORJA_ICONS[key]}"/></svg>`;
      b.addEventListener('click', () => { editor.icon = { ...editor.icon, type: 'preset', preset: key }; renderIconPicker(); });
      grid.appendChild(b);
    }
    const row = $('eColorRow');
    row.textContent = '';
    for (const c of state.info.colors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'color-choice';
      b.style.background = c;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', c);
      b.setAttribute('aria-checked', String(editor.icon.color === c));
      b.addEventListener('click', () => { editor.icon = { ...editor.icon, color: c }; renderIconPicker(); });
      row.appendChild(b);
    }
  }
  document.querySelectorAll('input[name="eIconType"]').forEach((r) => r.addEventListener('change', () => {
    editor.icon = { ...editor.icon, type: r.value, preset: editor.icon.preset || 'anvil', letter: editor.icon.letter || $('eName').value.trim().charAt(0).toUpperCase() };
    $('eLetter').value = editor.icon.letter;
    renderIconPicker();
  }));
  $('eLetter').addEventListener('input', () => {
    editor.letterTouched = Boolean($('eLetter').value);
    editor.icon = { ...editor.icon, letter: $('eLetter').value.toUpperCase() || $('eName').value.trim().charAt(0).toUpperCase() };
    renderIconPicker();
  });
  $('eName').addEventListener('input', () => {
    if (!editor.letterTouched) {
      editor.icon.letter = $('eName').value.trim().charAt(0).toUpperCase();
      $('eLetter').value = editor.icon.letter;
      if (editor.icon.type === 'letter') renderIconPicker();
    }
  });

  async function loadEditorVersions() {
    $('eVersion').textContent = '';
    $('eVersionHint').textContent = t('versions.loading');
    try {
      const res = await api('listVersions', { filters: { release: $('eRelease').checked, snapshot: $('eSnapshot').checked, old: $('eOld').checked } });
      editor.versions = res.versions;
      if (res.latest) state.latest = res.latest;
      $('eVersionHint').textContent = res.offline ? t('versions.offline') : '';
      if (res.error) toastError({ info: res.error });
      renderEditorVersions();
    } catch (err) {
      $('eVersionHint').textContent = friendlyError(err).text;
    }
  }
  function renderEditorVersions() {
    const q = $('eVersionSearch').value.trim().toLowerCase();
    const sel = $('eVersion');
    // Selecting an <option> scrolls ancestors into view; keep the form where the user left it.
    const form = $('editForm');
    const keepScroll = form.scrollTop;
    sel.textContent = '';
    let list = editor.versions.filter((v) => !q || v.id.toLowerCase().includes(q));
    if (editor.selectedVersion && !list.some((v) => v.id === editor.selectedVersion) && !q) {
      list = [{ id: editor.selectedVersion, type: 'custom' }, ...list];
    }
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      const tags = [];
      if (state.latest && v.id === state.latest.release) tags.push(t('versions.latest'));
      if (v.type && v.type !== 'release' && v.type !== 'custom') tags.push(t(`type.${v.type}`));
      if (state.installed.has(v.id) || v.installed) tags.push(t('versions.installed'));
      o.textContent = tags.length ? `${v.id}   · ${tags.join(' · ')}` : v.id;
      if (v.id === editor.selectedVersion) o.selected = true;
      sel.appendChild(o);
    }
    if (!list.length) $('eVersionHint').textContent = t('versions.empty');
    form.scrollTop = keepScroll;
    requestAnimationFrame(() => { form.scrollTop = keepScroll; });
  }
  $('eVersion').addEventListener('change', () => { editor.selectedVersion = $('eVersion').value; });
  $('eVersionSearch').addEventListener('input', renderEditorVersions);
  ['eRelease', 'eSnapshot', 'eOld'].forEach((id) => $(id).addEventListener('change', loadEditorVersions));

  function updateEditorMem() {
    $('eMemory').max = $('sMemory').max;
    $('eMemory').disabled = $('eMemDefault').checked;
    $('eMemoryValue').textContent = $('eMemDefault').checked ? formatMem(state.settings.defaultMemoryMb) : formatMem(Number($('eMemory').value));
  }
  $('eMemDefault').addEventListener('change', updateEditorMem);
  $('eMemory').addEventListener('input', updateEditorMem);
  function updateEditorJava() {
    const custom = document.querySelector('input[name="eJavaMode"]:checked').value === 'custom';
    $('eJavaPath').disabled = !custom;
    $('eJavaBrowse').disabled = !custom;
  }
  document.querySelectorAll('input[name="eJavaMode"]').forEach((r) => r.addEventListener('change', updateEditorJava));
  $('eJavaBrowse').addEventListener('click', async () => {
    const pth = await api('pickJava').catch(() => null);
    if (pth) $('eJavaPath').value = pth;
  });
  $('eFullscreen').addEventListener('change', () => {
    $('eWidth').disabled = $('eFullscreen').checked;
    $('eHeight').disabled = $('eFullscreen').checked;
  });

  async function saveEditor() {
    const showErr = (msg, focus) => { $('eError').textContent = msg; $('eError').classList.remove('hidden'); $('eError').scrollIntoView({ block: 'nearest' }); if (focus) focus.focus(); };
    const name = $('eName').value.trim();
    if (!name) return showErr(t('error.profileName'), $('eName'));
    if (!editor.selectedVersion) return showErr(t('error.profileVersion'), $('eVersion'));
    const javaMode = document.querySelector('input[name="eJavaMode"]:checked').value;
    if (javaMode === 'custom' && !$('eJavaPath').value.trim()) return showErr(t('error.javaPathRequired'), $('eJavaPath'));
    const w = $('eWidth').value ? Number($('eWidth').value) : null;
    const h = $('eHeight').value ? Number($('eHeight').value) : null;
    if ((w && !h) || (!w && h)) return showErr(t('error.resolution'), w ? $('eHeight') : $('eWidth'));
    const data = {
      name,
      icon: editor.icon,
      versionId: editor.selectedVersion,
      memoryMaxMb: $('eMemDefault').checked ? null : Number($('eMemory').value),
      jvmArgs: $('eJvmArgs').value.trim(),
      resolution: { width: w, height: h, fullscreen: $('eFullscreen').checked },
      java: { mode: javaMode, path: javaMode === 'custom' ? $('eJavaPath').value.trim() : null },
    };
    try {
      const saved = editor.mode === 'edit' ? await api('updateProfile', editor.id, data) : await api('createProfile', data);
      closeModal($('editModal'));
      await refreshProfiles();
      selectProfile(saved.id);
      toast({ type: 'success', title: editor.mode === 'edit' ? t('toast.saved') : t('toast.created'), message: saved.name, timeout: 3000 });
    } catch (err) {
      showErr(friendlyError(err).text);
    }
  }
  $('eSave').addEventListener('click', saveEditor);
  $('editForm').addEventListener('submit', (e) => { e.preventDefault(); saveEditor(); });

  // ------------------------------------------------------------ settings tab
  function renderSettings() {
    const s = state.settings;
    $('sLanguage').value = s.language;
    document.querySelectorAll('input[name="onGameStart"]').forEach((r) => { r.checked = r.value === s.onGameStart; });
    $('sShowSnapshots').checked = s.showSnapshots;
    $('sShowOld').checked = s.showOld;
    $('sMemory').value = String(s.defaultMemoryMb);
    $('sMemoryValue').textContent = formatMem(s.defaultMemoryMb);
    $('sMemoryHint').textContent = t('settings.memoryHint', { total: state.info.totalMemoryMb });
    document.querySelectorAll('input[name="sJavaMode"]').forEach((r) => { r.checked = r.value === (s.defaultJavaPath ? 'custom' : 'auto'); });
    $('sJavaPath').value = s.defaultJavaPath || '';
    $('sJavaPath').disabled = !s.defaultJavaPath && document.querySelector('input[name="sJavaMode"]:checked').value === 'auto';
    $('sJavaBrowse').disabled = $('sJavaPath').disabled;
    $('sConcurrency').value = String(s.concurrency);
    $('sConcurrencyValue').textContent = String(s.concurrency);
    $('sDataDir').value = state.info.dataDir;
    const rs = $('sRepairProfile');
    const cur = rs.value;
    rs.textContent = '';
    for (const p of state.profiles) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.name} — ${p.versionId || t('profile.noVersion')}`;
      rs.appendChild(o);
    }
    rs.value = cur && state.profiles.some((p) => p.id === cur) ? cur : state.selectedId;
  }

  let savedTimer;
  async function saveSetting(patch) {
    try {
      state.settings = await api('setSettings', patch);
      $('savedHint').classList.add('show');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => $('savedHint').classList.remove('show'), 1200);
      renderHero();
    } catch (err) { toastError(err); }
  }
  $('sLanguage').addEventListener('change', async () => {
    await saveSetting({ language: $('sLanguage').value });
    await loadLanguage(state.settings.language);
  });
  document.querySelectorAll('input[name="onGameStart"]').forEach((r) => r.addEventListener('change', () => saveSetting({ onGameStart: r.value })));
  $('sShowSnapshots').addEventListener('change', () => saveSetting({ showSnapshots: $('sShowSnapshots').checked }));
  $('sShowOld').addEventListener('change', () => saveSetting({ showOld: $('sShowOld').checked }));
  let memTimer;
  $('sMemory').addEventListener('input', () => {
    $('sMemoryValue').textContent = formatMem(Number($('sMemory').value));
    clearTimeout(memTimer);
    memTimer = setTimeout(() => saveSetting({ defaultMemoryMb: Number($('sMemory').value) }), 300);
  });
  let concTimer;
  $('sConcurrency').addEventListener('input', () => {
    $('sConcurrencyValue').textContent = $('sConcurrency').value;
    clearTimeout(concTimer);
    concTimer = setTimeout(() => saveSetting({ concurrency: Number($('sConcurrency').value) }), 300);
  });
  document.querySelectorAll('input[name="sJavaMode"]').forEach((r) => r.addEventListener('change', () => {
    const custom = r.value === 'custom' && r.checked;
    $('sJavaPath').disabled = !custom;
    $('sJavaBrowse').disabled = !custom;
    if (!custom) saveSetting({ defaultJavaPath: null });
    else $('sJavaPath').focus();
  }));
  $('sJavaPath').addEventListener('change', () => saveSetting({ defaultJavaPath: $('sJavaPath').value.trim() || null }));
  $('sJavaBrowse').addEventListener('click', async () => {
    const pth = await api('pickJava').catch(() => null);
    if (pth) { $('sJavaPath').value = pth; saveSetting({ defaultJavaPath: pth }); }
  });
  $('sOpenDataDir').addEventListener('click', () => api('openDataDir').catch(toastError));
  $('sRepairBtn').addEventListener('click', () => { const id = $('sRepairProfile').value; if (id) { selectProfile(id); repair(id); } });

  // ------------------------------------------------------------ log
  const logEl = $('log');
  let pendingLog = [];
  let logScheduled = false;
  function profileName(id) {
    const p = state.profiles.find((x) => x.id === id);
    return p ? p.name : id;
  }
  function logLineEl(entry, withTag) {
    const div = document.createElement('div');
    const { line, source } = entry;
    let cls = source === 'launcher' ? 'l-launcher' : source === 'stderr' ? 'l-stderr' : '';
    if (/\/(ERROR|FATAL)\]|Exception|^\[error\]|^Error:/.test(line)) cls = 'l-error';
    else if (/\/WARN\]/.test(line)) cls = 'l-warn';
    if (cls) div.className = cls;
    if (withTag) {
      const tag = document.createElement('span');
      tag.className = 'l-tag';
      tag.textContent = `[${profileName(entry.profileId)}] `;
      div.appendChild(tag);
    }
    div.appendChild(document.createTextNode(line));
    return div;
  }
  function appendLog(entry) {
    state.logs.push(entry);
    if (state.logs.length > MAX_LOG) state.logs.splice(0, state.logs.length - MAX_LOG);
    if (state.tab !== 'log') return;
    if (state.logFilter !== 'all' && state.logFilter !== entry.profileId) return;
    pendingLog.push(entry);
    if (!logScheduled) { logScheduled = true; requestAnimationFrame(flushLog); }
  }
  function flushLog() {
    logScheduled = false;
    const frag = document.createDocumentFragment();
    for (const e of pendingLog) frag.appendChild(logLineEl(e, state.logFilter === 'all'));
    pendingLog = [];
    logEl.appendChild(frag);
    while (logEl.childElementCount > 3000) logEl.removeChild(logEl.firstChild);
    if ($('autoscroll').checked) logEl.scrollTop = logEl.scrollHeight;
  }
  function renderLog() {
    const f = $('logFilter');
    const cur = state.logFilter;
    f.textContent = '';
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = t('log.all');
    f.appendChild(all);
    for (const p of state.profiles) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      f.appendChild(o);
    }
    f.value = [...f.options].some((o) => o.value === cur) ? cur : 'all';
    state.logFilter = f.value;
    logEl.textContent = '';
    const frag = document.createDocumentFragment();
    const entries = state.logs.filter((e) => state.logFilter === 'all' || e.profileId === state.logFilter).slice(-3000);
    for (const e of entries) frag.appendChild(logLineEl(e, state.logFilter === 'all'));
    logEl.appendChild(frag);
    if ($('autoscroll').checked) logEl.scrollTop = logEl.scrollHeight;
  }
  $('logFilter').addEventListener('change', () => { state.logFilter = $('logFilter').value; renderLog(); });
  $('clearLogBtn').addEventListener('click', () => {
    state.logs = state.logFilter === 'all' ? [] : state.logs.filter((e) => e.profileId !== state.logFilter);
    renderLog();
  });
  $('copyLogBtn').addEventListener('click', () => navigator.clipboard.writeText(logEl.innerText).then(() => toast({ type: 'success', title: t('toast.copied'), timeout: 1500 })));

  // ------------------------------------------------------------ crash dialog
  let crashProfile = null;
  function showCrash(c) {
    crashProfile = c.profileId;
    const code = c.code != null ? c.code : c.signal;
    $('crashSummary').textContent = t('crash.summary', { name: profileName(c.profileId), version: c.versionId || '', code });
    $('crashReport').classList.toggle('hidden', !c.crashReport);
    $('crashReport').textContent = c.crashReport ? t('crash.reportFile', { path: c.crashReport }) : '';
    const log = $('crashLog');
    log.textContent = '';
    for (const line of c.lines || []) log.appendChild(logLineEl({ line, source: 'stdout' }, false));
    if (!c.lines || !c.lines.length) log.textContent = t('crash.noLog');
    openModal($('crashModal'), $('crashOpen'));
    setTimeout(() => { log.scrollTop = log.scrollHeight; }, 50);
  }
  $('crashOpen').addEventListener('click', () => { if (crashProfile) api('openCrashReports', crashProfile).catch(toastError); });
  $('crashCopy').addEventListener('click', () => navigator.clipboard.writeText($('crashLog').innerText).then(() => toast({ type: 'success', title: t('toast.copied'), timeout: 1500 })));

  // ------------------------------------------------------------ events from main
  forja.onProgress((p) => {
    const g = state.games.get(p.profileId) || { state: 'preparing' };
    g.progress = p;
    state.games.set(p.profileId, g);
    if (p.profileId === state.selectedId) renderProgress(p);
    const item = $('profileList').querySelector(`[data-id="${p.profileId}"] .pi-progress > div`);
    if (item) item.style.width = `${progressRatio(p) * 100}%`;
  });
  forja.onLog((l) => {
    appendLog(l);
    if (state.tab !== 'log' && /\/(ERROR|FATAL)\]/.test(l.line)) $('logDot').classList.remove('hidden');
  });
  forja.onState((s) => {
    const prev = state.games.get(s.profileId) || {};
    const name = profileName(s.profileId);
    switch (s.state) {
      case 'preparing':
      case 'repairing':
        state.games.set(s.profileId, { state: s.state, progress: prev.progress || null });
        break;
      case 'running': {
        state.games.set(s.profileId, { state: 'running', pid: s.pid });
        const p = state.profiles.find((x) => x.id === s.profileId);
        if (p) state.installed.add(p.versionId);
        toast({ type: 'success', title: t('toast.started', { name }), message: t('state.running', { pid: s.pid }), timeout: 3500 });
        break;
      }
      case 'exited': {
        const ok = s.code === 0 || s.killedByUser;
        state.games.set(s.profileId, { state: 'idle', lastStatus: { text: s.killedByUser ? t('state.killed') : t('state.exited', { code: s.code != null ? s.code : s.signal }), cls: ok ? '' : 'error' } });
        break;
      }
      case 'cancelled':
        state.games.set(s.profileId, { state: 'idle', lastStatus: { text: t('state.cancelled') } });
        toast({ type: 'warn', title: t('state.cancelled'), message: name, timeout: 2500 });
        break;
      case 'repaired':
        state.games.set(s.profileId, { state: 'idle', lastStatus: { text: t('state.repaired', { repaired: s.result.repaired }), cls: 'ok' } });
        toast({
          type: 'success',
          title: t('toast.repaired', { name }),
          message: t('toast.repairedMsg', { checked: s.result.checked, repaired: s.result.repaired, mb: mb(s.result.repairedBytes) }),
          timeout: 7000,
        });
        break;
      case 'error': {
        const f = friendlyError({ info: s.error });
        state.games.set(s.profileId, { state: 'idle', lastStatus: { text: f.text, cls: 'error' } });
        break;
      }
      default:
    }
    renderProfileList();
    if (s.profileId === state.selectedId) renderHero();
  });
  forja.onCrash((c) => showCrash(c));
  forja.onProfilesChanged((list) => {
    state.profiles = list;
    renderProfileList();
    renderHero();
  });

  // ------------------------------------------------------------ data
  async function refreshProfiles() {
    state.profiles = await api('listProfiles');
    if (!state.profiles.some((p) => p.id === state.selectedId)) state.selectedId = state.profiles[0] ? state.profiles[0].id : null;
    renderProfileList();
    renderHero();
  }
  async function refreshInstalled() {
    try {
      const res = await api('listVersions', { filters: { release: true, snapshot: true, old: true } });
      state.installed = new Set(res.versions.filter((v) => v.installed).map((v) => v.id));
      state.latest = res.latest;
      if (res.offline) toast({ type: 'warn', title: t('toast.offlineTitle'), message: res.error ? friendlyError({ info: res.error }).text : t('versions.offline'), timeout: 8000 });
    } catch (err) { toastError(err); }
    renderHero();
  }

  function renderAll() {
    renderProfileList();
    renderHero();
    if (state.tab === 'settings') renderSettings();
    if (state.tab === 'log') renderLog();
  }

  // ------------------------------------------------------------ init
  (async () => {
    try {
      state.info = await api('appInfo');
      state.settings = await api('getSettings');
      $('brandName').textContent = state.info.name;
      document.title = state.info.name;
      const memMax = Math.max(1024, Math.floor((state.info.totalMemoryMb - 512) / 256) * 256);
      $('sMemory').max = String(Math.min(memMax, 32768));
      $('username').value = state.settings.username;
      state.profiles = await api('listProfiles');
      state.selectedId = state.profiles.some((p) => p.id === state.settings.selectedProfileId) ? state.settings.selectedProfileId : (state.profiles[0] && state.profiles[0].id);
      for (const g of await api('gamesStatus')) state.games.set(g.profileId, { state: g.state, pid: g.pid });
      await loadLanguage(state.settings.language);
      appendLog({ profileId: 'launcher', line: `${state.info.name} ${state.info.version} — ${state.info.platform}/${state.info.arch} — ${state.info.dataDir}`, source: 'launcher' });
      await refreshInstalled();
      const p = selected();
      if (p && !p.versionId) {
        toast({ type: 'info', title: t('toast.pickVersionTitle'), message: t('toast.pickVersion'), timeout: 8000 });
      }
    } catch (err) {
      toastError(err);
    }
  })();
})();
