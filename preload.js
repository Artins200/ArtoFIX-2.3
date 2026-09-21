'use strict';
/* =============================================================
   ARTOFIX 2.3 — PRELOAD (единственный мост renderer ↔ main)
   -------------------------------------------------------------
   Renderer работает в песочнице: nodeIntegration = false,
   contextIsolation = true, sandbox = true. Здесь мы выдаём ему
   ТОЛЬКО фиксированный список методов с валидацией аргументов.

   Правила, которые нельзя нарушать при доработке:
     1. Никаких ipcRenderer наружу — только конкретные функции.
     2. Никаких динамических имён каналов («api:' + name»).
     3. Все аргументы проверяются на тип и длину ДО отправки.
     4. Никаких Node-модулей (fs/path/child_process) в рендерер.
   ============================================================= */

const { contextBridge, ipcRenderer } = require('electron');

// ── лимиты аргументов ──
const MAX_STR = 2048;
const MAX_LIST = 5000;
const MAX_JSON = 512 * 1024;

// ── белые списки (совпадают с main.js) ──
const BROWSERS = ['chrome', 'msedge', 'firefox', 'yandex', 'app'];
const FOLDERS = ['profiles', 'Zapret', 'assets', 'drivers', 'install'];
const DIAG_COMPONENTS = ['python', 'pip', 'selenium', 'stealth', 'wdm', 'chrome', 'chromedrv', 'edge', 'edgedrv'];
const WIN_ACTS = ['minimize', 'maximize', 'hide', 'restart'];

// ── каналы «main → renderer» (подписки) ──
const EVENTS = [
  'log-entry', 'zapret-status', 'zapret-dl-progress', 'diag-log', 'diag-progress',
  'tray-action', 'navigate', 'bootstrap', 'setup-step', 'setup-log', 'setup-error',
  'setup-restart', 'setup-done',
];

// ── гигиена аргументов ──
function str(v, max = MAX_STR) {
  if (typeof v !== 'string') return null;
  if (v.length === 0 || v.length > max) return null;
  // управляющие символы (в т.ч. \n и \0) в каналах не нужны
  return /[\u0000-\u001f\u007f]/.test(v) ? null : v;
}
function oneOf(v, list) { return list.indexOf(v) === -1 ? null : v; }
function plainObject(v, maxBytes = MAX_JSON) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let json;
  try { json = JSON.stringify(v); } catch (_) { return null; }
  if (!json || json.length > maxBytes) return null;
  if (/__proto__|constructor\s*:|prototype\s*:/.test(json)) return null;   // prototype pollution
  return JSON.parse(json);   // отвязываем от объектов страницы
}
function stringList(v, max = MAX_LIST) {
  if (!Array.isArray(v) || v.length > max) return null;
  const out = [];
  for (const item of v) {
    const s = str(item, MAX_STR);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}
function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** Один вызов main: null-аргумент означает «неверные данные» — в main не уходит. */
function call(channel) {
  const args = Array.prototype.slice.call(arguments, 1);
  return ipcRenderer.invoke(channel, ...args);
}
const BAD = { ok: false, msg: 'Некорректные данные' };
const EMPTY = { ok: false, msg: 'Некорректные данные' };

/** Подписка на событие: возвращает функцию отписки (без утечек слушателей). */
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return function () {};
  if (EVENTS.indexOf(channel) === -1) return function () {};
  const listener = (_event, payload) => {
    try { cb(payload); } catch (err) { console.error('[preload] handler error', err && err.message); }
  };
  ipcRenderer.on(channel, listener);
  return function off() { ipcRenderer.removeListener(channel, listener); };
}

const api = {
  // ── служебное ──
  ready: true,
  platform: process.platform,
  version: null,          // версию сообщает main в bootstrap-событии

  // ── окно ──
  winAct: function (act) {
    const a = oneOf(act, WIN_ACTS);
    if (!a) return;
    ipcRenderer.send('api:win-act', a);
  },
  toggleMaximize: function () { ipcRenderer.send('api:toggle-maximize'); },

  // ── ресурсы/файлы ──
  getIconUrl: function () { return call('api:get-icon-url'); },
  openFolder: function (which) {
    const w = oneOf(which, FOLDERS);
    if (!w) return Promise.resolve(EMPTY);
    return call('api:open-folder', w);
  },
  openExternal: function (url) {
    const u = str(url);
    if (!u) return Promise.resolve(EMPTY);
    return call('api:open-external', u);
  },
  zapretService: function () { return call('api:zapret-service'); },
  refreshTray: function () { ipcRenderer.send('api:refresh-tray'); },

  // ── процессы ──
  closeBrowsers: function () { return call('api:close-browsers'); },
  killWinws: function () { return call('api:kill-winws'); },
  launchBrowser: function (opts) {
    const o = plainObject(opts);
    if (!o) return Promise.resolve(EMPTY);
    if (typeof o.url !== 'string' || o.url.length > MAX_STR) return Promise.resolve(EMPTY);
    if (oneOf(o.browser, BROWSERS) === null) return Promise.resolve(EMPTY);
    if (o.profile !== undefined && o.profile !== null && str(o.profile, 64) === null) return Promise.resolve(EMPTY);
    return call('api:launch-browser', { url: o.url, profile: o.profile || 'default', browser: o.browser });
  },

  // ── Zapret ──
  zapretStart: function () { return call('api:zapret-start'); },
  zapretStop: function () { return call('api:zapret-stop'); },
  zapretVersion: function () { return call('api:zapret-version'); },
  zapretCheckUpdate: function () { return call('api:zapret-check-update'); },
  zapretDoUpdate: function (opts) {
    const o = plainObject(opts) || {};
    const tag = str(o.tag, 64);
    const name = o.assetName === undefined || o.assetName === null ? null : str(o.assetName, 128);
    if (!tag) return Promise.resolve(EMPTY);
    return call('api:zapret-do-update', { tag: tag, assetName: name });
  },

  // ── профили ──
  listProfiles: function () { return call('api:list-profiles'); },
  createProfile: function (name) {
    const n = str(name, 64);
    if (!n) return Promise.resolve(EMPTY);
    return call('api:create-profile', n);
  },
  deleteProfile: function (name) {
    const n = str(name, 64);
    if (!n) return Promise.resolve(EMPTY);
    return call('api:delete-profile', n);
  },
  readProfileMeta: function (name) {
    const n = str(name, 64);
    if (!n) return Promise.resolve({});
    return call('api:read-profile-meta', n);
  },
  writeProfileMeta: function (name, data) {
    const n = str(name, 64);
    const d = plainObject(data, 64 * 1024);
    if (!n || !d) return Promise.resolve(EMPTY);
    return call('api:write-profile-meta', n, d);
  },

  // ── конфиг/настройки/бинды ──
  readConfig: function () { return call('api:read-config'); },
  writeConfig: function (data) {
    const d = plainObject(data);
    if (!d) return Promise.resolve(EMPTY);
    return call('api:write-config', d);
  },
  readSettings: function () { return call('api:read-settings'); },
  writeSettings: function (data) {
    const d = plainObject(data);
    if (!d) return Promise.resolve(EMPTY);
    return call('api:write-settings', d);
  },
  readBinds: function () { return call('api:read-binds'); },
  writeBinds: function (data) {
    if (!Array.isArray(data) || data.length > 200) return Promise.resolve(EMPTY);
    const clean = [];
    for (const b of data) {
      const item = plainObject(b, 8 * 1024);
      if (!item) return Promise.resolve(EMPTY);
      clean.push({
        id: num(item.id, 0, Number.MAX_SAFE_INTEGER) || 0,
        label: sanitizeText(item.label, 64),
        url: sanitizeText(item.url, MAX_STR) || '',
        profile: sanitizeText(item.profile, 64) || '',
        browser: oneOf(item.browser, BROWSERS) || 'chrome',
        bypass: item.bypass === true,
      });
    }
    return call('api:write-binds', clean);
  },

  // ── hosts / adblock ──
  hostsRead: function () { return call('api:hosts-read'); },
  hostsWrite: function (domains) {
    const list = stringList(domains);
    if (!list) return Promise.resolve(EMPTY);
    return call('api:hosts-write', list);
  },
  hostsWriteAdmin: function (domains) {
    const list = stringList(domains);
    if (!list) return Promise.resolve(EMPTY);
    return call('api:hosts-write-admin', list);
  },

  // ── uBlock ──
  ublockCheck: function () { return call('api:ublock-check'); },
  ublockInstall: function (profile) {
    const p = str(profile, 64);
    if (!p) return Promise.resolve(EMPTY);
    return call('api:ublock-install', p);
  },

  // ── диагностика ──
  diagCheck: function (opts) {
    const o = plainObject(opts) || {};
    const c = oneOf(o.component, DIAG_COMPONENTS);
    if (!c) return Promise.resolve({ status: 'err', note: 'unknown component' });
    return call('api:diag-check', { component: c });
  },
  diagInstall: function (opts) {
    const o = plainObject(opts) || {};
    const list = Array.isArray(o.components) ? o.components.filter((c) => DIAG_COMPONENTS.indexOf(c) !== -1) : [];
    if (!list.length || list.length > DIAG_COMPONENTS.length) return Promise.resolve(EMPTY);
    return call('api:diag-install', { components: list });
  },

  // ── сеть / Чебурнет ──
  cbnPing: function (opts) {
    const o = plainObject(opts) || {};
    const host = str(o.host, 253);
    if (!host) return Promise.resolve({ ok: false, err: 'BAD_HOST' });
    return call('api:cbn-ping', { host: host, port: num(o.port, 1, 65535) || 443 });
  },
  cbnSetDns: function (opts) {
    const o = plainObject(opts) || {};
    const d1 = str(o.dns1, 45);
    const d2 = str(o.dns2, 45);
    if (!d1 || !d2) return Promise.resolve(EMPTY);
    return call('api:cbn-set-dns', { dns1: d1, dns2: d2 });
  },
  cbnResetDns: function () { return call('api:cbn-reset-dns'); },

  // ── логи ──
  readLogs: function () { return call('api:read-logs'); },
  clearLogs: function () { return call('api:clear-logs'); },
  copyLogs: function () { return call('api:copy-logs'); },

  // ── отпечаток ──
  previewProfile: function (profile) {
    const p = profile === null || profile === undefined ? null : str(profile, 64);
    return call('api:preview-profile', { profile: p });
  },
  listCountries: function () { return call('api:list-countries'); },
  rerollProfile: function (profile) {
    const p = str(profile, 64);
    if (!p) return Promise.resolve(EMPTY);
    return call('api:reroll-profile', { profile: p });
  },

  // ── ошибки рендерера → терминал ──
  reportError: function (payload) {
    const o = plainObject(payload, 8 * 1024) || {};
    ipcRenderer.send('api:report-error', { kind: sanitizeText(o.kind, 32), message: sanitizeText(o.message, 512) });
  },

  // ── установщик ──
  skipSetup: function () { ipcRenderer.send('api:setup-skip'); },
  setupOpenMain: function () { ipcRenderer.send('api:setup-open-main'); },

  // ── подписки (main → renderer) ──
  onLogEntry: function (cb) { return subscribe('log-entry', cb); },
  onZapretStatus: function (cb) { return subscribe('zapret-status', cb); },
  onZapretProgress: function (cb) { return subscribe('zapret-dl-progress', cb); },
  onDiagLog: function (cb) { return subscribe('diag-log', cb); },
  onDiagProgress: function (cb) { return subscribe('diag-progress', cb); },
  onTrayAction: function (cb) { return subscribe('tray-action', cb); },
  onNavigate: function (cb) { return subscribe('navigate', cb); },
  onBootstrap: function (cb) { return subscribe('bootstrap', cb); },
  onSetupStep: function (cb) { return subscribe('setup-step', cb); },
  onSetupLog: function (cb) { return subscribe('setup-log', cb); },
  onSetupError: function (cb) { return subscribe('setup-error', cb); },
  onSetupRestart: function (cb) { return subscribe('setup-restart', cb); },
  onSetupDone: function (cb) { return subscribe('setup-done', cb); },
};

/** Текст для данных: обрезаем управляющие символы и длину. */

function sanitizeText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// JSON-safe поверхность: никаких функций/прототипов наружу
contextBridge.exposeInMainWorld('api', Object.freeze(api));
