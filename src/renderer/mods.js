'use strict';
/* global ForjaApp, forja, forjaUiIcon */
/**
 * Mods tab: installed content (mods / resource packs / shader packs) and
 * Modrinth search + project page; modpacks (.mrpack) install as new profiles.
 */
(() => {
  const A = window.ForjaApp;
  const { t, api, toast, toastError, friendlyError } = A;
  const $ = (id) => document.getElementById(id);
  const PAGE = 20;
  const m = {
    type: 'mod',
    view: 'installed',
    items: [],
    updates: new Map(), // file -> update
    search: { query: '', category: '', sort: 'relevance', offset: 0, total: 0, hits: [] },
    categories: null,
    project: null,
    selectedVersion: null,
    busy: false,
    reqId: 0,
  };

  const fmtNum = (n) => {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  };

  function iconEl(url, title) {
    if (url && /^https:\/\/cdn\.modrinth\.com\//.test(url)) {
      const img = document.createElement('img');
      img.className = 'mod-icon';
      img.alt = '';
      img.loading = 'lazy';
      img.src = url;
      return img;
    }
    const d = document.createElement('div');
    d.className = 'mod-icon placeholder';
    d.textContent = (title || '?').trim().charAt(0).toUpperCase();
    return d;
  }

  /** Very small, safe Markdown → DOM (no raw HTML is ever inserted). */
  function renderMarkdown(el, md) {
    el.textContent = '';
    const text = String(md || '').replace(/<[^>]*>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[\s*\]\([^)]*\)/g, '');
    let list = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.trim() || /^\s*([-*_=|:]\s*){3,}$/.test(line)) { list = null; continue; }
      const inline = (node, s) => {
        const parts = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
        for (const part of parts) {
          if (/^\*\*[^*]+\*\*$/.test(part)) { const b = document.createElement('b'); b.textContent = part.slice(2, -2); node.appendChild(b); }
          else if (/^`[^`]+`$/.test(part)) { const c = document.createElement('code'); c.textContent = part.slice(1, -1); node.appendChild(c); }
          else node.appendChild(document.createTextNode(part.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')));
        }
      };
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const li = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (h) {
        list = null;
        const e = document.createElement('h4');
        inline(e, h[2]);
        el.appendChild(e);
      } else if (li) {
        if (!list) { list = document.createElement('ul'); el.appendChild(list); }
        const e = document.createElement('li');
        inline(e, li[1]);
        list.appendChild(e);
      } else {
        list = null;
        const e = document.createElement('p');
        inline(e, line);
        el.appendChild(e);
      }
      if (el.childNodes.length > 200) break;
    }
  }

  const profile = () => A.selected();
  const hasLoader = (p) => p && p.loader && p.loader.type !== 'vanilla';

  // ------------------------------------------------------------ header
  function renderHead() {
    const p = profile();
    document.querySelectorAll('#modsType .seg-btn').forEach((b) => {
      const on = b.dataset.type === m.type;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('active', on);
      b.tabIndex = on ? 0 : -1;
    });
    const modpack = m.type === 'modpack';
    if (modpack) m.view = 'search';
    document.querySelectorAll('#modsView .seg-btn').forEach((b) => {
      const on = b.dataset.view === m.view;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('active', on);
      b.tabIndex = on ? 0 : -1;
      b.disabled = modpack && b.dataset.view === 'installed';
    });
    $('modsInstalled').hidden = m.view !== 'installed';
    $('modsSearch').hidden = m.view !== 'search';
    $('modsProfile').textContent = p
      ? t('mods.profileInfo', { name: p.name, mc: p.versionId || '—', loader: A.loaderLabel(p.loader) })
      : '';
    const warn = $('modsWarning');
    let w = '';
    if (m.type === 'mod' && p && !hasLoader(p)) w = t('mods.noLoader');
    else if (m.type === 'shader' && p) w = t('mods.shaderNote');
    else if (modpack) w = t('mods.modpackNote');
    warn.textContent = w;
    warn.classList.toggle('hidden', !w);
    const infoFilter = p && !modpack
      ? t('mods.filterInfo', { mc: p.versionId || '—', loader: m.type === 'mod' ? A.loaderLabel({ type: p.loader.type }) : t('mods.anyLoader') })
      : t('mods.filterAll');
    $('searchFilterInfo').textContent = infoFilter;
  }

  document.querySelectorAll('#modsType .seg-btn').forEach((b) => b.addEventListener('click', () => {
    m.type = b.dataset.type;
    m.updates.clear();
    m.search.offset = 0;
    m.search.category = '';
    show();
  }));
  document.querySelectorAll('#modsView .seg-btn').forEach((b) => b.addEventListener('click', () => {
    m.view = b.dataset.view;
    show();
  }));
  // Arrow keys inside segmented controls
  ['modsType', 'modsView'].forEach((id) => $(id).addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const btns = [...$(id).querySelectorAll('.seg-btn:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    const next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    next.click();
    next.focus();
    e.preventDefault();
  }));

  // ------------------------------------------------------------ installed
  async function loadInstalled() {
    const p = profile();
    if (!p) return;
    const req = ++m.reqId;
    $('contentSummary').textContent = t('mods.loading');
    try {
      const res = await api('contentList', p.id, m.type, { identify: true });
      if (req !== m.reqId) return;
      m.items = res.items;
      if (res.offline) toast({ type: 'warn', title: t('toast.offlineTitle'), message: t('mods.identifyOffline'), timeout: 5000 });
      renderInstalled();
    } catch (err) {
      $('contentSummary').textContent = friendlyError(err).text;
    }
  }

  function renderInstalled() {
    const list = $('contentList');
    list.textContent = '';
    const q = $('installedFilter').value.trim().toLowerCase();
    const items = m.items.filter((e) => !q || (e.title || '').toLowerCase().includes(q) || e.file.toLowerCase().includes(q));
    const enabled = m.items.filter((e) => e.enabled).length;
    $('contentSummary').textContent = m.items.length ? t('mods.summary', { total: m.items.length, enabled }) : '';
    $('contentEmpty').classList.toggle('hidden', m.items.length > 0);
    $('contentEmpty').textContent = t(`mods.empty.${m.type}`);
    const p = profile();
    for (const e of items) {
      const li = document.createElement('li');
      li.className = `content-item${e.enabled ? '' : ' disabled'}`;
      li.appendChild(iconEl(e.iconUrl, e.title || e.file));
      const text = document.createElement('div');
      text.className = 'content-text';
      const title = document.createElement('div');
      title.className = 'content-title';
      title.textContent = e.title || e.file.replace(/\.disabled$/, '');
      const sub = document.createElement('div');
      sub.className = 'content-sub muted small';
      sub.textContent = [e.versionNumber, e.file, e.projectId ? null : t('mods.unknownSource')].filter(Boolean).join(' · ');
      text.append(title, sub);
      const up = m.updates.get(e.file);
      if (up) {
        const badge = document.createElement('span');
        badge.className = 'badge update';
        badge.textContent = t('mods.updateTo', { v: up.latest.version_number });
        title.appendChild(badge);
      }
      li.appendChild(text);

      if (up) {
        const ub = document.createElement('button');
        ub.className = 'btn small';
        ub.textContent = t('mods.update');
        ub.addEventListener('click', () => runUpdate([e.file]));
        li.appendChild(ub);
      }
      const sw = document.createElement('label');
      sw.className = 'switch';
      sw.title = e.enabled ? t('mods.disable') : t('mods.enable');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('role', 'switch');
      cb.checked = e.enabled;
      cb.setAttribute('aria-label', `${title.textContent}: ${t('mods.enabled')}`);
      cb.disabled = A.isBusy(p.id);
      cb.addEventListener('change', async () => {
        try {
          await api('contentToggle', p.id, m.type, e.file, cb.checked);
          await loadInstalled();
        } catch (err) { toastError(err); cb.checked = !cb.checked; }
      });
      const knob = document.createElement('span');
      knob.className = 'switch-knob';
      sw.append(cb, knob);
      li.appendChild(sw);
      const del = document.createElement('button');
      del.className = 'icon-btn danger';
      del.innerHTML = forjaUiIcon('trash');
      del.title = t('mods.remove');
      del.setAttribute('aria-label', `${t('mods.remove')}: ${title.textContent}`);
      del.addEventListener('click', async () => {
        const ok = await A.confirmDialog({ title: t('mods.removeTitle'), text: t('mods.removeText', { name: title.textContent }), ok: t('mods.remove') });
        if (!ok) return;
        try {
          await api('contentRemove', p.id, m.type, e.file);
          toast({ type: 'success', title: t('mods.removed'), message: title.textContent, timeout: 2500 });
          await loadInstalled();
        } catch (err) { toastError(err); }
      });
      li.appendChild(del);
      list.appendChild(li);
    }
    const n = m.updates.size;
    $('updateAllBtn').classList.toggle('hidden', n === 0);
    $('updateAllBtn').textContent = t('mods.updateAll', { n });
  }
  $('installedFilter').addEventListener('input', renderInstalled);

  $('checkUpdatesBtn').addEventListener('click', async () => {
    const p = profile();
    $('checkUpdatesBtn').disabled = true;
    try {
      const ups = await api('contentCheckUpdates', p.id, m.type);
      m.updates = new Map(ups.map((u) => [u.file, u]));
      toast({ type: ups.length ? 'info' : 'success', title: t('mods.updatesTitle'), message: ups.length ? t('mods.updatesFound', { n: ups.length }) : t('mods.noUpdates'), timeout: 4000 });
      renderInstalled();
    } catch (err) { toastError(err); } finally { $('checkUpdatesBtn').disabled = false; }
  });
  async function runUpdate(files) {
    const p = profile();
    $('updateAllBtn').disabled = true;
    try {
      const done = await api('contentUpdate', p.id, m.type, files);
      m.updates.clear();
      toast({ type: 'success', title: t('mods.updated'), message: done.map((d) => d.title || d.file).join(', ') || t('mods.noUpdates'), timeout: 5000 });
      await loadInstalled();
    } catch (err) { toastError(err); } finally { $('updateAllBtn').disabled = false; }
  }
  $('updateAllBtn').addEventListener('click', () => runUpdate(null));
  $('openContentFolderBtn').addEventListener('click', () => api('openProfileDir', profile().id).catch(toastError));

  // ------------------------------------------------------------ search
  async function loadCategories() {
    if (!m.categories) {
      try { m.categories = await api('modrinthCategories'); } catch { m.categories = []; }
    }
    const sel = $('searchCategory');
    const cur = m.search.category;
    sel.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = t('mods.allCategories');
    sel.appendChild(all);
    for (const c of m.categories.filter((x) => x.project_type === m.type && x.header !== 'resolutions')) {
      const o = document.createElement('option');
      o.value = c.name;
      o.textContent = c.name.replace(/-/g, ' ');
      sel.appendChild(o);
    }
    sel.value = cur;
  }

  let searchTimer = null;
  async function runSearch() {
    const p = profile();
    const req = ++m.reqId;
    const box = $('searchResults');
    box.setAttribute('aria-busy', 'true');
    try {
      const res = await api('modrinthSearch', {
        query: m.search.query, type: m.type, profileId: p ? p.id : null, category: m.search.category || null,
        index: m.search.sort, offset: m.search.offset, limit: PAGE,
      });
      if (req !== m.reqId) return;
      m.search.hits = res.hits || [];
      m.search.total = res.total_hits || 0;
      renderSearch();
    } catch (err) {
      if (req !== m.reqId) return;
      box.textContent = '';
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = friendlyError(err).text;
      box.appendChild(e);
    } finally {
      box.removeAttribute('aria-busy');
    }
  }

  function installedProjectIds() {
    return new Set(m.items.filter((e) => e.projectId).map((e) => e.projectId));
  }

  function renderSearch() {
    const box = $('searchResults');
    box.textContent = '';
    const installed = installedProjectIds();
    if (!m.search.hits.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = t('mods.noResults');
      box.appendChild(e);
    }
    for (const h of m.search.hits) {
      const card = document.createElement('article');
      card.className = 'result-card';
      card.tabIndex = 0;
      card.setAttribute('aria-label', h.title);
      card.appendChild(iconEl(h.icon_url, h.title));
      const body = document.createElement('div');
      body.className = 'result-body';
      const title = document.createElement('div');
      title.className = 'result-title';
      title.textContent = h.title;
      const by = document.createElement('span');
      by.className = 'muted small';
      by.textContent = ` ${t('mods.by', { author: h.author })}`;
      title.appendChild(by);
      const desc = document.createElement('div');
      desc.className = 'result-desc small';
      desc.textContent = h.description;
      const meta = document.createElement('div');
      meta.className = 'result-meta small muted';
      meta.textContent = `${t('mods.downloads', { n: fmtNum(h.downloads) })} · ${t('mods.follows', { n: fmtNum(h.follows) })} · ${(h.display_categories || h.categories || []).slice(0, 4).join(', ')}`;
      body.append(title, desc, meta);
      card.appendChild(body);
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      const isInstalled = installed.has(h.project_id);
      btn.textContent = m.type === 'modpack' ? t('modpack.install') : (isInstalled ? t('mods.installed') : t('mods.install'));
      btn.disabled = isInstalled && m.type !== 'modpack';
      btn.addEventListener('click', (e) => { e.stopPropagation(); quickInstall(h, btn); });
      card.appendChild(btn);
      card.addEventListener('click', () => openProject(h.project_id));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openProject(h.project_id); });
      box.appendChild(card);
    }
    const page = Math.floor(m.search.offset / PAGE) + 1;
    const pages = Math.max(1, Math.ceil(m.search.total / PAGE));
    $('pageInfo').textContent = t('mods.page', { page, pages, total: fmtNum(m.search.total) });
    $('prevPage').disabled = m.search.offset === 0;
    $('nextPage').disabled = page >= pages;
  }

  $('searchQuery').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { m.search.query = $('searchQuery').value.trim(); m.search.offset = 0; runSearch(); }, 350);
  });
  $('searchCategory').addEventListener('change', () => { m.search.category = $('searchCategory').value; m.search.offset = 0; runSearch(); });
  $('searchSort').addEventListener('change', () => { m.search.sort = $('searchSort').value; m.search.offset = 0; runSearch(); });
  $('prevPage').addEventListener('click', () => { m.search.offset = Math.max(0, m.search.offset - PAGE); runSearch(); });
  $('nextPage').addEventListener('click', () => { m.search.offset += PAGE; runSearch(); });

  // ------------------------------------------------------------ install
  async function installContent(projectId, versionId, btn) {
    const p = profile();
    if (!p) return;
    if (btn) { btn.disabled = true; btn.textContent = t('mods.installing'); }
    setProgress({ label: t('mods.installing') });
    try {
      const res = await api('contentInstall', p.id, m.type, projectId, versionId || null);
      const names = res.installed.map((i) => (i.dependency ? `${i.title} (${t('mods.dependency')})` : i.title));
      toast({ type: 'success', title: t('mods.installedTitle'), message: names.join(', '), timeout: 6000 });
      if (res.missing.length) toast({ type: 'warn', title: t('mods.missingDeps'), message: res.missing.map((d) => d.projectId || d.fileName || d.versionId).join(', '), timeout: 9000 });
      if (res.incompatible.length) toast({ type: 'warn', title: t('mods.incompatible'), message: res.incompatible.map((d) => d.projectId).join(', '), timeout: 9000 });
      await loadInstalled();
      if (m.view === 'search') renderSearch();
      return true;
    } catch (err) {
      toastError(err);
      if (btn) { btn.disabled = false; btn.textContent = t('mods.install'); }
      return false;
    } finally {
      setProgress(null);
    }
  }

  async function installModpack(projectId, versionId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = t('mods.installing'); }
    setProgress({ label: t('modpack.installing') });
    try {
      const r = await api('modpackInstallModrinth', projectId, versionId || null);
      await modpackDone(r);
      return true;
    } catch (err) {
      toastError(err);
      return false;
    } finally {
      setProgress(null);
      if (btn) { btn.disabled = false; btn.textContent = t('modpack.install'); }
    }
  }

  async function modpackDone(r) {
    if (!r) return;
    await A.refreshProfiles();
    toast({ type: 'success', title: t('modpack.done'), message: t('modpack.doneMsg', { files: r.files, overrides: r.overrides }), timeout: 7000 });
    A.selectProfile(r.profileId);
    A.selectTab('profiles');
  }

  function quickInstall(hit, btn) {
    if (m.type === 'modpack') return installModpack(hit.project_id, null, btn);
    return installContent(hit.project_id, null, btn);
  }

  $('importMrpackBtn').addEventListener('click', async () => {
    setProgress({ label: t('modpack.installing') });
    try {
      const r = await api('modpackImportFile');
      await modpackDone(r);
    } catch (err) { toastError(err); } finally { setProgress(null); }
  });

  // Progress strip shared by content installs and modpacks
  let strip = null;
  function setProgress(p) {
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'task-strip hidden';
      strip.setAttribute('role', 'status');
      strip.innerHTML = '<span class="task-label"></span><div class="progress"><div class="progress-bar"></div></div><span class="task-meta small muted"></span>';
      document.body.appendChild(strip);
    }
    if (!p) { strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    if (p.label) strip.querySelector('.task-label').textContent = p.label;
    const ratio = p.totalBytes ? p.doneBytes / p.totalBytes : (p.totalFiles ? p.doneFiles / p.totalFiles : 0);
    strip.querySelector('.progress-bar').style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;
    const bits = [];
    if (p.totalFiles) bits.push(t('progress.files', { done: p.doneFiles, total: p.totalFiles }));
    if (p.totalBytes) bits.push(t('progress.mb', { done: A.mb(p.doneBytes), total: A.mb(p.totalBytes) }));
    if (p.speedBps > 1024) bits.push(t('progress.speed', { speed: (p.speedBps / 1048576).toFixed(1) }));
    strip.querySelector('.task-meta').textContent = bits.join(' · ');
  }
  forja.onContentProgress((p) => { if (p.profileId === (profile() && profile().id)) setProgress(p); });
  forja.onModpackProgress((p) => {
    if (p.log) { A.appendLog({ profileId: 'launcher', line: p.log, source: 'launcher' }); return; }
    setProgress({ ...p, label: p.step === 'download' ? t('modpack.downloading') : t('modpack.installing') });
  });

  // ------------------------------------------------------------ project page
  async function openProject(id) {
    const p = profile();
    const modal = $('projectModal');
    $('pTitle').textContent = t('mods.loading');
    $('pMeta').textContent = '';
    $('pDesc').textContent = '';
    $('pTags').textContent = '';
    $('pBody').textContent = '';
    $('pVersions').textContent = '';
    $('pIcon').removeAttribute('src');
    $('pInstall').disabled = true;
    A.openModal(modal, $('pInstall'));
    try {
      const { project, versions, filtered } = await api('modrinthProject', { id, profileId: p ? p.id : null, type: m.type });
      m.project = project;
      m.projectVersions = versions;
      if (project.icon_url && /^https:\/\/cdn\.modrinth\.com\//.test(project.icon_url)) $('pIcon').src = project.icon_url;
      $('pTitle').textContent = project.title;
      $('pMeta').textContent = `${t('mods.downloads', { n: fmtNum(project.downloads) })} · ${t('mods.follows', { n: fmtNum(project.followers) })} · ${project.license ? project.license.id : ''}`;
      $('pDesc').textContent = project.description;
      for (const c of [...(project.categories || []), ...(project.loaders || [])].slice(0, 10)) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = c;
        $('pTags').appendChild(tag);
      }
      renderMarkdown($('pBody'), project.body);
      $('pVersionsHint').textContent = filtered && p ? t('project.filtered', { mc: p.versionId, loader: A.loaderLabel({ type: p.loader.type }) }) : '';
      const list = $('pVersions');
      m.selectedVersion = versions[0] ? versions[0].id : null;
      if (!versions.length) {
        const li = document.createElement('li');
        li.className = 'muted small';
        li.textContent = t('project.noVersions');
        list.appendChild(li);
      }
      versions.forEach((v, i) => {
        const li = document.createElement('li');
        li.className = 'version-item';
        li.tabIndex = 0;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === 0));
        const name = document.createElement('div');
        name.textContent = `${v.version_number} `;
        const type = document.createElement('span');
        type.className = `badge vt-${v.version_type}`;
        type.textContent = t(`project.vt.${v.version_type}`);
        name.appendChild(type);
        const meta = document.createElement('div');
        meta.className = 'muted small';
        meta.textContent = `${(v.game_versions || []).slice(-3).join(', ')} · ${(v.loaders || []).join(', ')} · ${new Date(v.date_published).toLocaleDateString(A.state.settings.language)}`;
        li.append(name, meta);
        const pick = () => {
          m.selectedVersion = v.id;
          list.querySelectorAll('.version-item').forEach((x) => x.setAttribute('aria-selected', String(x === li)));
          updateInstallButton();
        };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { pick(); e.preventDefault(); } });
        list.appendChild(li);
      });
      updateInstallButton();
    } catch (err) {
      $('pTitle').textContent = friendlyError(err).text;
    }
  }

  function updateInstallButton() {
    const btn = $('pInstall');
    const pt = m.project && m.project.project_type;
    const isPack = pt === 'modpack';
    const installed = !isPack && m.project && installedProjectIds().has(m.project.id);
    btn.textContent = isPack ? t('modpack.install') : (installed ? t('mods.reinstall') : t('mods.install'));
    btn.disabled = !m.selectedVersion;
    const v = (m.projectVersions || []).find((x) => x.id === m.selectedVersion);
    const f = v && ((v.files || []).find((x) => x.primary) || v.files[0]);
    $('pInstallInfo').textContent = f ? `${f.filename} · ${A.fmtBytes(f.size)}` : '';
  }

  $('pInstall').addEventListener('click', async () => {
    if (!m.project || !m.selectedVersion) return;
    const btn = $('pInstall');
    const ok = m.project.project_type === 'modpack'
      ? await installModpack(m.project.id, m.selectedVersion, btn)
      : await installContent(m.project.id, m.selectedVersion, btn);
    if (ok) A.closeModal($('projectModal'));
    else updateInstallButton();
  });
  $('pOpenWeb').addEventListener('click', () => {
    if (m.project) api('openModrinth', m.project.slug || m.project.id, m.project.project_type).catch(toastError);
  });

  // ------------------------------------------------------------ public
  async function show() {
    renderHead();
    if (!profile()) return;
    if (m.type !== 'modpack') await loadInstalled();
    else m.items = [];
    if (m.view === 'search') {
      await loadCategories();
      $('searchQuery').value = m.search.query;
      $('searchSort').value = m.search.sort;
      runSearch();
    }
  }
  function render() {
    if (A.state.tab !== 'mods') return;
    renderHead();
    if (m.view === 'installed') renderInstalled();
    else renderSearch();
  }
  window.ForjaMods = { show, render };
})();
