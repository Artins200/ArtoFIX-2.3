'use strict';
/* =============================================================
   ARTOFIX 2.5 — ПРЕВЬЮ-ШИМ window.api (только для браузера)
   -------------------------------------------------------------
   НЕ является частью приложения: используется preview/server.js,
   чтобы показать интерфейс Artofix в обычном браузере (без
   Electron) — проверить темы, цвета, масштаб, скругление и
   прозрачность окна. В Electron работает настоящий preload.js.

   Данные (настройки/бинды/профили) хранятся в localStorage.
   Системные действия (Zapret, hosts, DNS) имитируются тостами.
   ============================================================= */
(function () {
  var LS = 'artofix-preview:';
  function lsGet(key, fallback) {
    try { var v = localStorage.getItem(LS + key); return v === null ? fallback : JSON.parse(v); }
    catch (_) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(LS + key, JSON.stringify(val)); } catch (_) {}
  }
  function ok(extra) { return Object.assign({ ok: true }, extra || {}); }
  function no(msg) { return { ok: false, msg: msg }; }

  var subs = {};
  function emit(ch, payload) { (subs[ch] || []).forEach(function (cb) { try { cb(payload); } catch (_) {} }); }
  function subscribe(ch, cb) {
    if (typeof cb !== 'function') return function () {};
    (subs[ch] = subs[ch] || []).push(cb);
    return function () { subs[ch] = (subs[ch] || []).filter(function (x) { return x !== cb; }); };
  }

  var zapretOn = false;
  var maximized = false;
  var profiles = lsGet('profiles', { demo: { browser: 'chrome', note: 'демо-профиль', country: '' } });
  function saveProfiles() { lsSet('profiles', profiles); }

  var COUNTRIES = [
    { code: 'US', name: 'США', flag: '🇺🇸' }, { code: 'DE', name: 'Германия', flag: '🇩🇪' },
    { code: 'GB', name: 'Великобритания', flag: '🇬🇧' }, { code: 'FR', name: 'Франция', flag: '🇫🇷' },
    { code: 'NL', name: 'Нидерланды', flag: '🇳🇱' }, { code: 'PL', name: 'Польша', flag: '🇵🇱' },
    { code: 'TR', name: 'Турция', flag: '🇹🇷' }, { code: 'KZ', name: 'Казахстан', flag: '🇰🇿' },
    { code: 'JP', name: 'Япония', flag: '🇯🇵' }, { code: 'BR', name: 'Бразилия', flag: '🇧🇷' },
  ];

  function toParent(msg) { try { window.parent.postMessage(Object.assign({ src: 'artofix-preview' }, msg), '*'); } catch (_) {} }

  var api = {
    ready: true,
    platform: 'linux',
    version: '2.5.0-preview',

    // ── окно ──
    winAct: function (act) {
      if (act === 'minimize') toParent({ act: 'minimize' });
      if (act === 'hide') toParent({ act: 'hide' });
      if (act === 'maximize') api.toggleMaximize();
    },
    toggleMaximize: function () {
      maximized = !maximized;
      toParent({ act: 'maximize', on: maximized });
      emit('win-maximized', maximized);
    },
    setZoom: function (f) {
      // В браузере нет webFrame — используем CSS zoom (в Electron это
      // webFrame.setZoomFactor из preload.js).
      try { document.documentElement.style.zoom = (f === 1 ? '' : String(f)); } catch (_) {}
    },

    // ── ресурсы ──
    getIconUrl: function () { return Promise.resolve(null); },
    openFolder: function () { return Promise.resolve(no('Доступно только в Electron')); },
    openExternal: function () { return Promise.resolve(no('Доступно только в Electron')); },
    zapretService: function () { return Promise.resolve(ok()); },
    refreshTray: function () {},

    // ── процессы ──
    closeBrowsers: function () { return Promise.resolve(no('Только Windows')); },
    killWinws: function () { return Promise.resolve(no('Только Windows')); },
    launchBrowser: function (o) {
      if (o && o.browser === 'app') return Promise.resolve(ok({ preview: true }));
      return Promise.resolve(ok({ preview: true }));
    },

    // ── Zapret (имитация) ──
    zapretStart: function () {
      if (zapretOn) return Promise.resolve({ ok: false, msg: 'Уже запущен' });
      zapretOn = true;
      setTimeout(function () { emit('zapret-status', { on: true }); }, 400);
      return Promise.resolve(ok());
    },
    zapretStop: function () {
      zapretOn = false;
      emit('zapret-status', { on: false });
      return Promise.resolve(ok());
    },
    zapretVersion: function () { return Promise.resolve({ version: 'preview', path: '—' }); },
    zapretCheckUpdate: function () { return Promise.resolve(no('Только в Electron')); },
    zapretDoUpdate: function () { return Promise.resolve(no('Только в Electron')); },

    // ── профили ──
    listProfiles: function () { return Promise.resolve(Object.keys(profiles)); },
    createProfile: function (name) {
      if (!/^[a-zA-Z0-9_\-]{1,40}$/.test(name || '')) return Promise.resolve(no('Недопустимое имя'));
      if (profiles[name]) return Promise.resolve(no('Профиль уже существует'));
      profiles[name] = { browser: 'chrome', note: '', country: '' };
      saveProfiles();
      return Promise.resolve(ok());
    },
    deleteProfile: function (name) {
      delete profiles[name];
      saveProfiles();
      return Promise.resolve(ok());
    },
    readProfileMeta: function (name) { return Promise.resolve(profiles[name] || {}); },
    writeProfileMeta: function (name, data) {
      profiles[name] = Object.assign({}, profiles[name] || {}, data || {});
      saveProfiles();
      return Promise.resolve(ok());
    },

    // ── конфиг/настройки/бинды ──
    readConfig: function () { return Promise.resolve(lsGet('config', { user_agent: '', resolution: '1920,1080' })); },
    writeConfig: function (data) { lsSet('config', Object.assign(lsGet('config', {}), data || {})); return Promise.resolve(ok()); },
    readSettings: function () { return Promise.resolve(lsGet('settings', {})); },
    writeSettings: function (data) { lsSet('settings', data || {}); return Promise.resolve(ok()); },

    // ── фон-картинка ──
    // В Electron файл выбирает main-процесс (dialog + проверка сигнатуры).
    // В превью рисуем картинку прямо в canvas: этого достаточно, чтобы
    // посмотреть, как фон просвечивает сквозь меню, карточки и кнопки.
    pickBgImage: function () {
      try {
        var c = document.createElement('canvas');
        c.width = 640; c.height = 360;
        var g = c.getContext('2d');
        var grd = g.createLinearGradient(0, 0, 640, 360);
        grd.addColorStop(0, '#12203f');
        grd.addColorStop(0.45, '#2b4a8f');
        grd.addColorStop(1, '#8f3fb0');
        g.fillStyle = grd;
        g.fillRect(0, 0, 640, 360);
        g.globalAlpha = 0.5;
        for (var i = 0; i < 90; i++) {
          g.beginPath();
          g.fillStyle = 'rgba(255,255,255,' + (0.05 + Math.random() * 0.25).toFixed(2) + ')';
          g.arc(Math.random() * 640, Math.random() * 360, Math.random() * 2.6 + 0.6, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
        g.fillStyle = 'rgba(255,255,255,.78)';
        g.font = 'bold 30px Segoe UI, sans-serif';
        g.fillText('Artofix · превью фона', 28, 330);
        return Promise.resolve(ok({ dataUrl: c.toDataURL('image/png'), name: 'preview.png' }));
      } catch (e) { return Promise.resolve(no('Canvas недоступен: ' + e.message)); }
    },
    readBinds: function () { return Promise.resolve(lsGet('binds', [])); },
    writeBinds: function (data) { lsSet('binds', data || []); return Promise.resolve(ok()); },

    // ── hosts / adblock / uBlock ──
    hostsRead: function () { return Promise.resolve({ ok: false, domains: [], msg: 'Только Windows' }); },
    hostsWrite: function () { return Promise.resolve(no('Только Windows')); },
    hostsWriteAdmin: function () { return Promise.resolve(no('Только Windows')); },
    ublockCheck: function () { return Promise.resolve({ installed: false }); },
    ublockInstall: function () { return Promise.resolve(no('Только в Electron')); },

    // ── диагностика / сеть ──
    diagCheck: function () { return Promise.resolve({ status: 'ok', note: 'превью' }); },
    diagInstall: function () { return Promise.resolve(no('Только в Electron')); },
    cbnPing: function () { return Promise.resolve({ ok: false, err: 'PREVIEW' }); },
    cbnSetDns: function () { return Promise.resolve(no('Только Windows')); },
    cbnResetDns: function () { return Promise.resolve(no('Только Windows')); },
    cbnFixWarp: function () { return Promise.resolve(no('Только в Electron')); },
    cbnTestWarp: function () { return Promise.resolve({ ok: false, msg: 'превью' }); },

    // ── логи ──
    readLogs: function () { return Promise.resolve([]); },
    clearLogs: function () { return Promise.resolve(ok()); },
    copyLogs: function () { return Promise.resolve(ok()); },

    // ── отпечаток ──
    previewProfile: function () { return Promise.resolve({ identity: null, preview: true }); },
    listCountries: function () { return Promise.resolve(COUNTRIES); },
    rerollProfile: function () { return Promise.resolve(ok()); },

    reportError: function () {},

    // ── установщик (в превью не используется) ──
    skipSetup: function () {},
    setupOpenMain: function () {},
    setupConfirmInstall: function () {},

    // ── подписки ──
    onLogEntry: function (cb) { return subscribe('log-entry', cb); },
    onZapretStatus: function (cb) { return subscribe('zapret-status', cb); },
    onZapretProgress: function (cb) { return subscribe('zapret-dl-progress', cb); },
    onDiagLog: function (cb) { return subscribe('diag-log', cb); },
    onDiagProgress: function (cb) { return subscribe('diag-progress', cb); },
    onTrayAction: function (cb) { return subscribe('tray-action', cb); },
    onNavigate: function (cb) { return subscribe('navigate', cb); },
    onBootstrap: function (cb) {
      subscribe('bootstrap', cb);
      setTimeout(function () {
        emit('bootstrap', { platform: 'linux', version: '2.5.0-preview', isAdmin: true, sandbox: true, zapretRunning: false, hostsAvailable: false });
      }, 0);
      return function () {};
    },
    onSetupStep: function (cb) { return subscribe('setup-step', cb); },
    onSetupLog: function (cb) { return subscribe('setup-log', cb); },
    onSetupError: function (cb) { return subscribe('setup-error', cb); },
    onSetupRestart: function (cb) { return subscribe('setup-restart', cb); },
    onSetupDone: function (cb) { return subscribe('setup-done', cb); },
    onSetupHw: function (cb) { return subscribe('setup-hw', cb); },
    onSetupAskPerm: function (cb) { return subscribe('setup-ask-perm', cb); },
    onWinMaximized: function (cb) { return subscribe('win-maximized', cb); },
    // Cloudflare-предупреждения приходят из engine.py через main;
    // в превью подписка есть, но событий нет (движок тут не запускается).
    onCfWarning: function (cb) { return subscribe('cf-warning', cb); },
  };

  // ── демо-события из harness.html (только превью) ──
  // В Electron событие 'cf-warning' приходит из main, который разбирает
  // строки engine.py '[cf] BLOCKED …'. Здесь его можно показать кнопкой.
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.src !== 'artofix-preview-parent') return;
    if (d.act === 'cf-demo-block') {
      emit('cf-warning', { state: 'blocked', host: 'site.com', ray: '8f3c1d2e4a5b6c7d', profile: 'demo' });
    } else if (d.act === 'cf-demo-challenge') {
      emit('cf-warning', { state: 'challenge', host: 'site.com', ray: '', profile: 'demo' });
    }
  });

  window.api = Object.freeze(api);
})();
