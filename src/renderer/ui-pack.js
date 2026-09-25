'use strict';
/**
 * UI pack 0.3.4 — appearance, titlebar, news, profiles polish,
 * onboarding, auth stub, widgets, sounds, performance mode.
 * Requires window.ForjaApp.
 */
(() => {
  const $ = (id) => document.getElementById(id);

  function whenReady(cb) {
    if (window.ForjaApp && window.ForjaApp.state && window.ForjaApp.state.settings) return cb(window.ForjaApp);
    const iv = setInterval(() => {
      if (window.ForjaApp && window.ForjaApp.state && window.ForjaApp.state.settings) {
        clearInterval(iv);
        cb(window.ForjaApp);
      }
    }, 40);
    setTimeout(() => clearInterval(iv), 20000);
  }

  function fmtPlaytime(sec, t) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return t('widgets.seconds', { n: s });
    if (s < 3600) return t('widgets.minutes', { n: Math.round(s / 60) });
    return t('widgets.hours', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
  }

  function headUrl(name) {
    const u = encodeURIComponent(String(name || 'Steve').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Steve');
    return `https://crafatar.com/avatars/${u}?size=64&overlay=true`;
  }

  function playBeep(kind, on) {
    if (!on) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      playBeep.ctx = playBeep.ctx || new AC();
      const ctx = playBeep.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = kind === 'ok' ? 720 : kind === 'err' ? 180 : 480;
      g.gain.value = 0.025;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
      setTimeout(() => { try { o.stop(); } catch (_) {} }, 120);
    } catch (_) { /* ignore */ }
  }

  whenReady((app) => {
    const { state, t, api, toast, toastError, selected, selectProfile, selectTab, refreshProfiles } = app;

    let enrichPlayIv = null;
    let widgetsIv = null;
    let enrichPlayFn = null;
    let updateWidgetsFn = null;
    function syncPollIntervals(perf) {
      if (enrichPlayIv) { clearInterval(enrichPlayIv); enrichPlayIv = null; }
      if (widgetsIv) { clearInterval(widgetsIv); widgetsIv = null; }
      if (!enrichPlayFn) return;
      enrichPlayIv = setInterval(enrichPlayFn, perf ? 2500 : 1000);
      if (updateWidgetsFn) widgetsIv = setInterval(updateWidgetsFn, perf ? 120000 : 45000);
      enrichPlayFn();
    }

    async function save(patch) {
      const s = await api('setSettings', patch);
      state.settings = s;
      applyAppearance(s);
      syncPollIntervals(s.performanceMode !== false);
      return s;
    }

    function applyAppearance(s) {
      if (!s) return;
      const root = document.documentElement;
      root.setAttribute('data-theme', s.theme || 'dark');
      root.style.setProperty('--ui-scale', String((Number(s.uiScale) || 100) / 100));
      document.body.style.zoom = ''; // prefer root font scaling via --ui-scale in CSS
      const perf = s.performanceMode !== false;
      root.classList.toggle('perf-mode', perf);
      document.body.classList.toggle('perf-mode', perf);
      // Perf mode forces animations off; otherwise respect glowAnimations.
      if (perf) root.classList.add('glow-anim-off');
      else root.classList.toggle('glow-anim-off', s.glowAnimations === false);

      document.querySelectorAll('#sTheme [data-theme]').forEach((b) => {
        const on = b.dataset.theme === (s.theme || 'dark');
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      });
      document.querySelectorAll('#sUiScale [data-scale]').forEach((b) => {
        const on = Number(b.dataset.scale) === Number(s.uiScale || 100);
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      });

      if ($('sHeroBackground')) $('sHeroBackground').value = s.heroBackground || '';
      if ($('sHeroBlur')) {
        $('sHeroBlur').value = String(s.heroBlur != null ? s.heroBlur : 12);
        if ($('sHeroBlurValue')) $('sHeroBlurValue').textContent = `${$('sHeroBlur').value}px`;
      }
      if ($('sHeroDim')) {
        $('sHeroDim').value = String(s.heroDim != null ? s.heroDim : 55);
        if ($('sHeroDimValue')) $('sHeroDimValue').textContent = `${$('sHeroDim').value}%`;
      }
      if ($('sUiSounds')) $('sUiSounds').checked = Boolean(s.uiSounds);
      if ($('sPerformanceMode')) $('sPerformanceMode').checked = perf;
      applyHero(s);
    }

    function applyHero(s) {
      const hero = $('hero');
      if (!hero) return;
      // Cap length so huge base64 never sits in live CSS variables.
      const raw = String((s && s.heroBackground) || '').slice(0, 2048);
      const ok = raw.startsWith('data:image/') || /^https?:\/\//i.test(raw);
      const perf = !s || s.performanceMode !== false;
      if (ok) {
        hero.classList.add('has-bg');
        hero.style.setProperty('--hero-image', `url("${raw.replace(/\\/g, '\\\\').replace(/"/g, '%22')}")`);
        const blur = perf ? 0 : (Number(s.heroBlur) || 0);
        hero.style.setProperty('--hero-blur', `${blur}px`);
        hero.style.setProperty('--hero-dim', String((Number(s.heroDim) || 0) / 100));
      } else {
        hero.classList.remove('has-bg');
        hero.style.removeProperty('--hero-image');
        hero.style.removeProperty('--hero-blur');
      }
    }

    applyAppearance(state.settings);

    // Appearance controls
    if ($('sTheme')) {
      $('sTheme').addEventListener('click', (e) => {
        const b = e.target.closest('[data-theme]');
        if (!b) return;
        save({ theme: b.dataset.theme }).then(() => playBeep('click', state.settings.uiSounds)).catch(toastError);
      });
    }
    if ($('sUiScale')) {
      $('sUiScale').addEventListener('click', (e) => {
        const b = e.target.closest('[data-scale]');
        if (!b) return;
        save({ uiScale: Number(b.dataset.scale) }).catch(toastError);
      });
    }

    let heroTimer;
    const scheduleHero = (patch) => {
      applyHero({ ...state.settings, ...patch });
      clearTimeout(heroTimer);
      heroTimer = setTimeout(() => save(patch).catch(toastError), 280);
    };
    if ($('sHeroBackground')) {
      $('sHeroBackground').addEventListener('change', () => {
        scheduleHero({ heroBackground: $('sHeroBackground').value.trim() });
      });
    }
    if ($('sHeroPick')) {
      $('sHeroPick').addEventListener('click', async () => {
        try {
          const r = await api('pickImage');
          if (!r) return;
          const dataUrl = typeof r === 'string' ? r : (r.dataUrl || '');
          if (!dataUrl) return;
          $('sHeroBackground').value = dataUrl;
          await save({ heroBackground: dataUrl });
        } catch (err) { toastError(err); }
      });
    }
    if ($('sHeroClear')) {
      $('sHeroClear').addEventListener('click', () => {
        if ($('sHeroBackground')) $('sHeroBackground').value = '';
        save({ heroBackground: '' }).catch(toastError);
      });
    }
    if ($('sHeroBlur')) {
      $('sHeroBlur').addEventListener('input', () => {
        if ($('sHeroBlurValue')) $('sHeroBlurValue').textContent = `${$('sHeroBlur').value}px`;
        scheduleHero({ heroBlur: Number($('sHeroBlur').value) });
      });
    }
    if ($('sHeroDim')) {
      $('sHeroDim').addEventListener('input', () => {
        if ($('sHeroDimValue')) $('sHeroDimValue').textContent = `${$('sHeroDim').value}%`;
        scheduleHero({ heroDim: Number($('sHeroDim').value) });
      });
    }
    if ($('sUiSounds')) {
      $('sUiSounds').addEventListener('change', () => {
        save({ uiSounds: $('sUiSounds').checked })
          .then((s) => playBeep('ok', s.uiSounds))
          .catch(toastError);
      });
    }
    if ($('sPerformanceMode')) {
      $('sPerformanceMode').addEventListener('change', () => {
        save({ performanceMode: $('sPerformanceMode').checked }).catch(toastError);
      });
    }

    // Titlebar
    api('windowPlatform').then((info) => {
      if (!info) return;
      document.body.classList.add(`platform-${info.platform}`);
    }).catch(() => {});
    if ($('winMin')) $('winMin').addEventListener('click', () => api('windowMinimize').catch(() => {}));
    if ($('winMax')) $('winMax').addEventListener('click', () => api('windowMaximize').catch(() => {}));
    if ($('winClose')) $('winClose').addEventListener('click', () => api('windowClose').catch(() => {}));
    if (window.forja && typeof window.forja.onWindowMaximized === 'function') {
      window.forja.onWindowMaximized((v) => document.body.classList.toggle('maximized', Boolean(v)));
    }

    // News
    async function loadNews(force) {
      const list = $('newsList');
      const empty = $('newsEmpty');
      if (!list) return;
      list.innerHTML = '<div class="skeleton-list"><div class="skeleton-card lg"></div><div class="skeleton-card lg"></div><div class="skeleton-card lg"></div></div>';
      if (empty) empty.classList.add('hidden');
      try {
        const res = await api('fetchNews', { force: Boolean(force) });
        const items = (res && res.items) || [];
        list.textContent = '';
        if (!items.length) {
          if (empty) empty.classList.remove('hidden');
          return;
        }
        for (const it of items) {
          const card = document.createElement('article');
          card.className = 'news-card';
          const h = document.createElement('h3');
          h.textContent = it.name || it.tag || '';
          const meta = document.createElement('div');
          meta.className = 'news-meta';
          const when = it.publishedAt ? new Date(it.publishedAt).toLocaleString(state.settings.language || 'ru') : '';
          meta.textContent = [it.tag, when, it.prerelease ? 'pre' : ''].filter(Boolean).join(' · ');
          const body = document.createElement('div');
          body.className = 'news-body';
          body.textContent = String(it.body || '').replace(/\r\n/g, '\n').slice(0, 1500) || t('news.nobody');
          const actions = document.createElement('div');
          actions.className = 'news-actions';
          if (it.url) {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'btn small';
            open.textContent = t('news.open');
            open.addEventListener('click', () => {
              try { window.open(it.url, '_blank', 'noopener'); } catch (_) {}
            });
            actions.appendChild(open);
          }
          card.append(h, meta, body, actions);
          list.appendChild(card);
        }
      } catch (err) {
        list.textContent = '';
        if (empty) empty.classList.remove('hidden');
        toastError(err);
      }
    }
    if ($('newsRefresh')) $('newsRefresh').addEventListener('click', () => loadNews(true));
    document.querySelectorAll('.tab[data-tab="news"]').forEach((b) => {
      b.addEventListener('click', () => loadNews(false));
    });

    // Player head
    function refreshHead() {
      const img = $('playerHead');
      if (!img) return;
      const name = (($('username') && $('username').value) || state.settings.username || 'Player').trim() || 'Player';
      img.classList.remove('fallback');
      img.textContent = '';
      img.alt = name;
      img.onerror = () => {
        img.onerror = null;
        img.removeAttribute('src');
        img.classList.add('fallback');
        img.textContent = name.charAt(0).toUpperCase();
      };
      img.src = headUrl(name);
    }
    refreshHead();
    if ($('username')) {
      $('username').addEventListener('change', refreshHead);
      $('username').addEventListener('blur', refreshHead);
    }

    // Auth type (Microsoft stub)
    function syncAuth() {
      const type = state.settings.authType || 'offline';
      document.querySelectorAll('#authTypeSeg [data-auth]').forEach((b) => {
        b.classList.toggle('active', b.dataset.auth === type);
      });
      if ($('msSoon')) $('msSoon').classList.toggle('hidden', type !== 'microsoft');
      if ($('authBadge')) $('authBadge').textContent = type === 'microsoft' ? t('account.microsoft') : t('account.offline');
      if ($('username')) $('username').disabled = type === 'microsoft';
    }
    syncAuth();
    if ($('authTypeSeg')) {
      $('authTypeSeg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-auth]');
        if (!b) return;
        if (b.dataset.auth === 'microsoft') {
          toast({ type: 'info', title: t('account.microsoft'), message: t('account.microsoftSoon'), timeout: 6500 });
        }
        save({ authType: b.dataset.auth }).then(syncAuth).catch(toastError);
      });
    }

    // Profile search / pin / cover / context menu
    let filter = '';
    if ($('profileSearch')) {
      $('profileSearch').addEventListener('input', () => {
        filter = $('profileSearch').value.trim().toLowerCase();
        polishProfileList();
      });
    }

    let polishingProfiles = false;
    let profileListObserver = null;

    function polishProfileList() {
      const list = $('profileList');
      if (!list || polishingProfiles) return;
      polishingProfiles = true;
      if (profileListObserver) profileListObserver.disconnect();
      try {
        const items = [...list.querySelectorAll('.profile-item')];
        for (const btn of items) {
          const p = state.profiles.find((x) => x.id === btn.dataset.id);
          if (!p) continue;
          const match = !filter
            || p.name.toLowerCase().includes(filter)
            || String(p.versionId || '').toLowerCase().includes(filter);
          if (btn.parentElement) btn.parentElement.classList.toggle('hidden', !match);

          let pin = btn.querySelector('.pi-pin');
          if (!pin) {
            pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'pi-pin';
            pin.textContent = '📌';
            pin.title = t('profiles.pin');
            pin.addEventListener('click', (e) => {
              e.stopPropagation();
              const cur = state.profiles.find((x) => x.id === btn.dataset.id);
              if (!cur) return;
              api('updateProfile', cur.id, { pinned: !cur.pinned })
                .then(() => refreshProfiles && refreshProfiles())
                .catch(toastError);
            });
            btn.appendChild(pin);
          }
          pin.classList.toggle('pinned', Boolean(p.pinned));

          if (p.coverImage) {
            let cover = btn.querySelector('.pi-cover');
            if (!cover) {
              cover = document.createElement('img');
              cover.className = 'pi-cover';
              cover.alt = '';
              const icon = btn.querySelector('.hero-icon, .profile-icon, .pi-icon');
              if (icon) icon.replaceWith(cover);
              else btn.prepend(cover);
            }
            const src = String(p.coverImage).slice(0, 2048);
            if (cover.getAttribute('src') !== src) cover.src = src;
          }
        }

        // Sort: pinned first, then lastPlayed desc
        const ranked = state.profiles.slice().sort((a, b) => {
          if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
          return (Date.parse(b.lastPlayed || 0) || 0) - (Date.parse(a.lastPlayed || 0) || 0);
        });
        for (const p of ranked) {
          const el = list.querySelector(`.profile-item[data-id="${p.id}"]`);
          if (el && el.parentElement) list.appendChild(el.parentElement);
        }

        if ($('profileEmpty')) {
          const visible = items.filter((b) => b.parentElement && !b.parentElement.classList.contains('hidden'));
          $('profileEmpty').classList.toggle('hidden', state.profiles.length === 0 ? false : visible.length > 0);
        }
        if ($('profileCount')) $('profileCount').textContent = String(state.profiles.length);
        updateWidgets();
      } finally {
        polishingProfiles = false;
        if (profileListObserver && list.isConnected) {
          profileListObserver.observe(list, { childList: true });
        }
      }
    }

    profileListObserver = new MutationObserver(() => {
      if (polishingProfiles) return;
      polishProfileList();
    });
    if ($('profileList')) profileListObserver.observe($('profileList'), { childList: true });
    polishProfileList();

    // Context menu
    const ctx = $('ctxMenu');
    let ctxId = null;
    function openCtx(x, y, id) {
      if (!ctx) return;
      ctxId = id;
      ctx.innerHTML = '';
      const entries = [
        ['play', t('play.play')],
        ['folder', t('profile.openFolder')],
        ['repair', t('profile.repair')],
        ['duplicate', t('profile.duplicate')],
        ['pin', t('profiles.pin')],
        ['cover', t('profiles.setCover')],
        ['sep'],
        ['delete', t('profile.delete'), true],
      ];
      for (const [idAct, label, danger] of entries) {
        if (idAct === 'sep') {
          const s = document.createElement('div');
          s.className = 'ctx-sep';
          ctx.appendChild(s);
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ctx-item' + (danger ? ' danger' : '');
        b.dataset.act = idAct;
        b.textContent = label;
        ctx.appendChild(b);
      }
      ctx.hidden = false;
      ctx.classList.add('open');
      const w = ctx.offsetWidth || 180;
      const h = ctx.offsetHeight || 200;
      ctx.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
      ctx.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
    }
    function closeCtx() {
      if (!ctx) return;
      ctx.hidden = true;
      ctx.classList.remove('open');
      ctxId = null;
    }
    if ($('profileList')) {
      $('profileList').addEventListener('contextmenu', (e) => {
        const b = e.target.closest('.profile-item');
        if (!b) return;
        e.preventDefault();
        openCtx(e.clientX, e.clientY, b.dataset.id);
      });
    }
    document.addEventListener('click', (e) => { if (ctx && !ctx.hidden && !e.target.closest('#ctxMenu')) closeCtx(); });
    if (ctx) {
      ctx.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-act]');
        if (!b || !ctxId) return;
        const act = b.dataset.act;
        const id = ctxId;
        closeCtx();
        const p = state.profiles.find((x) => x.id === id);
        if (!p) return;
        try {
          if (act === 'play') {
            selectProfile(id);
            if ($('playBtn')) $('playBtn').click();
          } else if (act === 'folder') await api('openProfileDir', id);
          else if (act === 'repair') await api('repair', id);
          else if (act === 'duplicate') {
            await api('duplicateProfile', id, {});
            if (refreshProfiles) await refreshProfiles();
          } else if (act === 'pin') {
            await api('updateProfile', id, { pinned: !p.pinned });
            if (refreshProfiles) await refreshProfiles();
          } else if (act === 'cover') {
            const r = await api('pickImage');
            if (!r) return;
            const dataUrl = typeof r === 'string' ? r : (r.dataUrl || '');
            if (!dataUrl) return;
            await api('updateProfile', id, { coverImage: dataUrl });
            if (refreshProfiles) await refreshProfiles();
          } else if (act === 'delete') {
            selectProfile(id);
            if ($('deleteBtn')) $('deleteBtn').click();
          }
          playBeep('ok', state.settings.uiSounds);
        } catch (err) {
          toastError(err);
          playBeep('err', state.settings.uiSounds);
        }
      });
    }

    // Rich play label
    function enrichPlay() {
      const p = selected();
      if (!p || !$('playLabel')) return;
      const g = state.games.get(p.id) || { state: 'idle' };
      if (g.state === 'preparing') {
        let pct = null;
        if (g.progress && g.progress.totalBytes) pct = Math.round(100 * g.progress.doneBytes / g.progress.totalBytes);
        else if (g.progress && g.progress.totalFiles) pct = Math.round(100 * g.progress.doneFiles / g.progress.totalFiles);
        $('playLabel').textContent = pct != null ? t('play.downloading', { pct }) : t('play.preparing');
      } else if (g.state === 'running') $('playLabel').textContent = t('play.running');
      else if (g.state === 'repairing') $('playLabel').textContent = t('play.repairing');
    }
    if ($('playBtn')) $('playBtn').addEventListener('click', () => playBeep('ok', state.settings.uiSounds));

    // Widgets
    async function updateWidgets() {
      if ($('wProfiles')) $('wProfiles').textContent = String(state.profiles.length);
      const p = selected();
      if ($('wPlaytime')) $('wPlaytime').textContent = p ? fmtPlaytime(p.playTimeSec, t) : '—';
      if ($('wStorage')) {
        try {
          const u = await api('storageUsage');
          const bytes = u && (u.totalBytes != null ? u.totalBytes : u.total);
          if (bytes != null) {
            const gb = bytes / (1024 ** 3);
            $('wStorage').textContent = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 ** 2))} MB`;
          }
        } catch (_) { /* ignore */ }
      }
    }
    updateWidgets();
    enrichPlayFn = enrichPlay;
    updateWidgetsFn = updateWidgets;
    syncPollIntervals(state.settings.performanceMode !== false);

    window.addEventListener('beforeunload', () => {
      if (enrichPlayIv) clearInterval(enrichPlayIv);
      if (widgetsIv) clearInterval(widgetsIv);
      if (profileListObserver) profileListObserver.disconnect();
    });

    // Onboarding
    let step = 1;
    function showOnboard() {
      if (!$('onboardModal') || state.settings.onboardingDone) return;
      $('onboardModal').hidden = false;
      renderOnboard();
    }
    function renderOnboard() {
      document.querySelectorAll('.onboard-step').forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.step) === step);
      });
      const pane = $('onboardPane');
      if (!pane) return;
      pane.textContent = '';
      if (step === 1) {
        const p = document.createElement('p');
        p.textContent = t('onboard.usernameHint');
        const input = document.createElement('input');
        input.className = 'input';
        input.id = 'onboardUsername';
        input.maxLength = 16;
        input.value = state.settings.username || '';
        pane.append(p, input);
      } else if (step === 2) {
        const p = document.createElement('p');
        p.textContent = t('onboard.profileHint');
        const sel = document.createElement('select');
        sel.className = 'input';
        sel.id = 'onboardProfile';
        for (const pr of state.profiles) {
          const o = document.createElement('option');
          o.value = pr.id;
          o.textContent = pr.name;
          if (pr.id === state.selectedId) o.selected = true;
          sel.appendChild(o);
        }
        const create = document.createElement('button');
        create.type = 'button';
        create.className = 'btn';
        create.style.marginTop = '8px';
        create.textContent = t('profiles.new');
        create.addEventListener('click', () => { if ($('newProfileBtn')) $('newProfileBtn').click(); });
        pane.append(p, sel, create);
      } else {
        const p = document.createElement('p');
        p.textContent = t('onboard.playHint');
        pane.append(p);
      }
      if ($('onboardNext')) $('onboardNext').textContent = step >= 3 ? t('onboard.finish') : t('onboard.next');
    }
    async function advanceOnboard() {
      if (step === 1) {
        const v = ($('onboardUsername') && $('onboardUsername').value.trim()) || '';
        if (v) {
          await save({ username: v });
          if ($('username')) $('username').value = v;
          refreshHead();
        }
        step = 2; renderOnboard(); return;
      }
      if (step === 2) {
        const id = $('onboardProfile') && $('onboardProfile').value;
        if (id) selectProfile(id);
        step = 3; renderOnboard(); return;
      }
      await save({ onboardingDone: true });
      $('onboardModal').hidden = true;
      playBeep('ok', state.settings.uiSounds);
      toast({ type: 'success', title: t('onboard.doneTitle'), message: t('onboard.doneText'), timeout: 5000 });
    }
    if ($('onboardNext')) $('onboardNext').addEventListener('click', () => advanceOnboard().catch(toastError));
    if ($('onboardSkip')) {
      $('onboardSkip').addEventListener('click', async () => {
        await save({ onboardingDone: true });
        $('onboardModal').hidden = true;
      });
    }
    setTimeout(showOnboard, 700);

    // Expose helpers for mods.js
    window.ForjaUiPack = {
      applyAppearance,
      beep: (k) => playBeep(k, state.settings.uiSounds),
      loadNews,
      favoriteMods: () => state.settings.favoriteMods || [],
      modSearchHistory: () => state.settings.modSearchHistory || [],
      async toggleFavorite(id) {
        const set = new Set(state.settings.favoriteMods || []);
        if (set.has(id)) set.delete(id); else set.add(id);
        await save({ favoriteMods: [...set] });
      },
      async pushSearchHistory(q) {
        const query = String(q || '').trim();
        if (!query) return;
        const hist = [query, ...(state.settings.modSearchHistory || []).filter((x) => x !== query)].slice(0, 20);
        await save({ modSearchHistory: hist });
      },
    };
  });
})();
