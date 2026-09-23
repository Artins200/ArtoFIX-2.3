'use strict';
/* =============================================================
   ARTOFIX 2.5 — RENDERER CORE
   -------------------------------------------------------------
   Среда исполнения:
     • nodeIntegration = false   → нет require(), process, Buffer
     • contextIsolation = true    → нет доступа к внутренностям preload
     • sandbox = true             → рендерер в OS-песочнице Chromium
     • webSecurity = true + CSP   → нет внешних скриптов/фреймов/connect

   Единственный канал наружу — window.api (preload, фиксированный
   список методов). Прямых IPC-каналов у рендерера больше нет.

   Эта часть загружается ПЕРВОЙ (см. index.html) и:
     1) поднимает безопасный мост window.api (или inert-заглушку);
     2) перехватывает ошибки и отправляет их в терминал main-процесса;
     3) включает делегированный диспетчер UI-действий
        (замена inline-обработчикам, которые запрещены строгим CSP).
   ============================================================= */

// ─────────────────────────────────────────────
//  1. МОСТ В MAIN-ПРОЦЕСС
// ─────────────────────────────────────────────
var API_READY = !!(window.api && window.api.ready === true);
// Use a separate name: top-level var api would overwrite the read-only preload bridge.
var apiBridge = API_READY ? window.api : null;
var CURRENT_COUNTRY_MODAL_PROFILE = null;

/**
 * Заглушка на случай, если preload не загрузился.
 * Все вызовы возвращают безопасные пустые значения — интерфейс
 * остаётся работоспособным, но ничего не выполняет.
 */
function makeNullApi() {
  var empty = function () { return Promise.resolve({ ok: false, msg: 'Мост API недоступен' }); };
  var nul = function () { return Promise.resolve([]); };
  var obj = function () { return Promise.resolve({}); };
  var nulFalse = function () { return Promise.resolve(false); };
  var off = function () { return function () {}; };
  return {
    ready: false, version: null, platform: null,
    getIconUrl: nulFalse,
    winAct: function () {}, toggleMaximize: function () {}, openFolder: function () {},
    setZoom: function () {},
    zapretService: function () {}, refreshTray: function () {}, closeBrowsers: empty,
    killWinws: empty, runSafeCommand: empty, launchBrowser: empty, openExternal: empty,
    zapretStart: empty, zapretStop: empty, zapretVersion: obj, zapretCheckUpdate: obj,
    zapretDoUpdate: empty, listProfiles: nul, createProfile: empty, deleteProfile: empty,
    readProfileMeta: obj, writeProfileMeta: empty, readConfig: obj, writeConfig: empty,
    readSettings: obj, writeSettings: empty, readBinds: nul, writeBinds: empty,
    hostsRead: function () { return Promise.resolve({ ok: false, domains: [] }); },
    hostsWrite: empty, hostsWriteAdmin: empty, ublockCheck: obj, ublockInstall: empty,
    diagCheck: obj, diagInstall: empty, cbnPing: obj, cbnSetDns: empty, cbnResetDns: empty,
    cbnFixWarp: empty, cbnTestWarp: obj,
    readLogs: nul, clearLogs: empty, copyLogs: empty,
    fingerprintRoll: obj, previewProfile: obj, previewRoll: empty, listCountries: nul,
    pickBgImage: function(){ return Promise.resolve({ ok:false, msg:'Мост недоступен'}); },
    reportError: function () {},
    onLogEntry: off, onZapretStatus: off, onZapretProgress: off, onDiagLog: off,
    onDiagProgress: off, onTrayAction: off, onNavigate: off, onBootstrap: off,
    onWinMaximized: off,
    onProfileThumb: off, platform: 'web',
  };
}

if (!API_READY) {
  apiBridge = makeNullApi();
  // Баннер показываем на DOMContentLoaded — до этого body может быть пуст
  document.addEventListener('DOMContentLoaded', function () { showApiBanner(); });
  console.warn('[renderer] window.api недоступен — интерфейс работает в режиме просмотра');
}

function showApiBanner() {
  if (document.getElementById('api-warn-banner')) return;
  var b = document.createElement('div');
  b.id = 'api-warn-banner';
  b.setAttribute('role', 'alert');
  b.textContent = '⚠ Мост API не загружен: preload не выполнился. Действия недоступны. '
                + 'Запусти приложение заново или проверь целостность файлов.';
  document.body.appendChild(b);
}

// ─────────────────────────────────────────────
//  2. ПЕРЕХВАТ ОШИБОК → терминал main-процесса
// ─────────────────────────────────────────────
var AF_ERR_COUNT = 0, AF_ERR_MAX = 20;
var TOAST_CONTAINER_ID = 'toasts';

function afReportError(kind, message, extra) {
  AF_ERR_COUNT++;
  if (AF_ERR_COUNT <= AF_ERR_MAX) {
    // уходит в main через console-message и печатается в терминале
    console.error('[renderer:' + kind + '] ' + message + (extra ? ' @ ' + extra : ''));
  }
}

/**
 * Кадр стека, где реально упал код.
 *
 * Без него в терминал main-процесса уходило «… (app.js:87)» — а 87 это строка
 * console.error внутри afReportError, то есть место репортёра, а не падения.
 * По такому логу баг не найти. Берём последний кадр с app.js: в стеке он
 * соответствует самой внутренней точке (месту throw).
 */
function afErrFrame(err) {
  if (!err || typeof err.stack !== 'string') return '';
  var frames = err.stack.split('\n')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return /app\.js:\d+/.test(s); });
  if (!frames.length) return '';
  return frames[frames.length - 1].replace(/^at\s+/, '');
}

window.addEventListener('error', function (e) {
  afReportError('error', (e && e.message) || 'unknown', (e && e.filename ? e.filename.split('/').pop() + ':' + e.lineno : ''));
  showLocalErrorToast((e && e.message) || 'Unknown error');
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e && e.reason;
  afReportError('promise', (r && r.message) || String(r), afErrFrame(r));
  showLocalErrorToast('Promise: ' + ((r && r.message) || r));
});

function showLocalErrorToast(msg) {
  try {
    var box = document.getElementById(TOAST_CONTAINER_ID) || document.body;
    var d = document.createElement('div');
    d.className = 'toast toast-err';
    d.textContent = '⚠ ' + msg;
    if (box) { box.appendChild(d); setTimeout(function () { d.remove(); }, 12000); }
  } catch (_) {}
}

// ─────────────────────────────────────────────
//  3. ДЕЛЕГИРОВАННЫЙ ДИСПЕТЧЕР UI-ДЕЙСТВИЙ
//     Заменяет inline on*="..." (их блокирует CSP).
//     Разметка: data-af-on="click" data-af-action="name"
//               data-af-args='["a",1]'  (JSON, опционально)
//               data-af-self="1"        (только если event.target === элемент)
//               data-af-style='{"opacity":"1"}' (применить стили)
// ─────────────────────────────────────────────
var AF_ACTIONS = {};

function afApplyStyle(el, json) {
  try {
    var o = JSON.parse(json);
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) el.style[k] = o[k]; }
  } catch (_) { afReportError('style', 'bad data-af-style: ' + json); }
}

function afDispatch(ev) {
  var node = ev.target;
  var el = (node && node.closest) ? node.closest('[data-af-on]') : null;
  if (!el) return;
  if (el.getAttribute('data-af-on') !== ev.type) return;
  if (el.disabled === true) return;
  if (el.getAttribute('data-af-self') === '1' && ev.target !== el) return;

  var styleJson = el.getAttribute('data-af-style');
  if (styleJson) afApplyStyle(el, styleJson);

  var name = el.getAttribute('data-af-action');
  if (!name) return;

  var fn = AF_ACTIONS[name];
  if (typeof fn !== 'function') { afReportError('ui', 'unknown action: ' + name); return; }

  var args = [];
  var raw = el.getAttribute('data-af-args');
  if (raw) {
    try { args = JSON.parse(raw); } catch (_) { args = []; }
    if (!(args instanceof Array)) args = [];
  }
  if (ev.type === 'click' && el.tagName === 'A' && !el.getAttribute('href')) ev.preventDefault();
  try {
    fn.apply(el, args.concat([ev, el]));
  } catch (err) {
    afReportError('action', name + ': ' + err.message, afErrFrame(err));
  }
}

['click', 'change', 'input', 'mouseover', 'mouseout', 'dblclick'].forEach(function (t) {
  document.addEventListener(t, afDispatch, true);
});

// ─────────────────────────────────────────────
//  4. ХЕЛПЕРЫ ДЛЯ БЕЗОПАСНОГО DOM
//     Никогда не вставляем данные в innerHTML —
//     только createElement + textContent.
// ─────────────────────────────────────────────
function afEl(tag, opts, kids) {
  var el = document.createElement(tag);
  opts = opts || {};
  if (opts.cls) el.className = opts.cls;
  if (opts.text !== undefined && opts.text !== null) el.textContent = String(opts.text);
  if (opts.style) el.style.cssText = opts.style;
  if (opts.attrs) {
    for (var k in opts.attrs) {
      if (Object.prototype.hasOwnProperty.call(opts.attrs, k) && opts.attrs[k] !== undefined && opts.attrs[k] !== null) {
        el.setAttribute(k, String(opts.attrs[k]));
      }
    }
  }
  if (opts.data) {
    for (var d in opts.data) {
      if (Object.prototype.hasOwnProperty.call(opts.data, d)) el.setAttribute('data-' + d, String(opts.data[d]));
    }
  }
  if (opts.on) {
    for (var e in opts.on) {
      if (Object.prototype.hasOwnProperty.call(opts.on, e)) el.addEventListener(e, opts.on[e]);
    }
  }
  if (kids) {
    (kids instanceof Array ? kids : [kids]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
  }
  return el;
}



// ── TOAST ──
function showToast(msg, type) {
  var container = document.getElementById('toasts');
  if (!container) return;
  var el = document.createElement('div');
  el.className = 'toast' + (type === 'err' ? ' toast-err' : type === 'ok' ? ' toast-ok' : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(function() {
    el.style.transition = '.28s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(34px)';
    setTimeout(function(){ el.remove(); }, 300);
  }, 2800);
}

// ── TABS ──
function goTab(tabName, btn) {
  var area = document.getElementById('content-area');
  var tpl  = document.getElementById('tpl-' + tabName);
  if (!tpl) {
    showToast('Шаблон не найден: tpl-' + tabName, 'err');
    return;
  }
  area.textContent = '';
  area.appendChild(tpl.content.cloneNode(true));

  // update active nav button
  var navBtns = document.querySelectorAll('.nav-btn');
  for (var i = 0; i < navBtns.length; i++) {
    navBtns[i].classList.remove('is-active');
  }
  if (btn) btn.classList.add('is-active');

  // tab-specific init
  if (tabName === 'profiles') renderProfiles();
  if (tabName === 'settings') initSettingsTab();
  if (tabName === 'config')   { loadConfig(); loadSpoofConfig(); initFpProfileSelect(); }
  if (tabName === 'binds')         initBindsTab();
  if (tabName === 'adblock')       initAdblock();
  if (tabName === 'zapret-update') initZapretUpdate();
  if (tabName === 'cheburnet')     initCheburnet();
  if (tabName === 'logs')          initLogs();
  if (tabName === 'diag')          initDiag();
  if (tabName === 'console')       initConsole();

  syncZapretUI();
}

apiBridge.onNavigate(function(tab) {
  if (typeof tab !== 'string' || !/^[a-z\-]{1,20}$/.test(tab)) return;
  var btn = document.querySelector('[data-tab="' + tab + '"]');
  goTab(tab, btn);
});

// ── КОМАНДЫ ──
// Свободного exec() в приложении больше нет: только фиксированные действия
// main-процесса (closeBrowsers / killWinws / zapret-start|stop).

// ── OPEN TG ──
function openTG() {
  apiBridge.openExternal('https://t.me/+SLxGyEiRG7sxM2Ey');
}

// ── BROWSER LAUNCH ──
// bypass=true/false — запускать ли обход (Zapret) перед открытием.
// Авто-настройка: если обход не активен, он поднимается САМ — пользователю
// не нужно вручную жать «Активировать» (см. ensureBypassAuto).
async function launchBrowser(url, profile, browser, bypass) {
  if (browser === 'app') {
    // Ярлыки и приложения (steam://, tg://, discord://, .exe/.lnk) открывает main —
    // он проверяет схему по белому списку, рендерер ничего не запускает сам.
    try {
      var appRes = await apiBridge.launchBrowser({ url: url, profile: profile, browser: 'app' });
      if (appRes && appRes.ok) showToast('▶ Приложение запущено', 'ok');
      else showToast('Не удалось открыть: ' + ((appRes && appRes.msg) || 'схема не разрешена'), 'err');
    } catch(e) { showToast('Ошибка: ' + e.message, 'err'); }
    return;
  }
  if (bypass) await ensureBypassAuto(true);
  try {
    var res = await apiBridge.launchBrowser({ url: url, profile: profile, browser: browser });
    if (res && res.ok) showToast('▶ ' + browser + ': ' + profile, 'ok');
    else showToast('Ошибка: ' + (res ? res.msg : '?'), 'err');
  } catch(e) {
    showToast('Ошибка моста API: ' + e.message, 'err');
  }
}

// ── АВТО-ОБХОД БЕЗ VPN ──
// Zapret поднимается автоматически при выборе страны и при запуске
// биндов/сайтов с меткой «С обходом». Отключается тумблером во вкладке «Бинды»
// (APP_SETTINGS.autoBypass = false).
var BYPASS_AUTOSTARTING = false;

async function ensureBypassAuto(reason) {
  if (zapretActive) return true;
  if (APP_SETTINGS.autoBypass === false) {
    if (reason) showToast('⚠ Zapret не активен — запуск без обхода', '');
    return false;
  }
  if (BYPASS_AUTOSTARTING) return false;
  BYPASS_AUTOSTARTING = true;
  try {
    if (reason) showToast('⚡ Включаю обход без VPN автоматически…', '');
    var res = await apiBridge.zapretStart();
    // «Уже запущен» — значит обход активен (например, стартовал из трея)
    if (res && (res.ok || /уже запущен/i.test(res.msg || ''))) {
      zapretActive = true;
      syncZapretUI();
      if (reason) showToast('⚡ Обход без VPN включён автоматически', 'ok');
      return true;
    }
    if (reason) showToast('Не удалось включить обход: ' + ((res && res.msg) || '?'), 'err');
  } catch (e) {
    if (reason) showToast('Ошибка авто-обхода: ' + e.message, 'err');
  } finally {
    BYPASS_AUTOSTARTING = false;
  }
  return false;
}

/** Авто-настройка биндов: все бинды профиля переводим в режим «С обходом». */
async function enableBindsBypassForProfile(prof) {
  if (!prof || !SAVED_BINDS.length) return;
  var changed = false;
  SAVED_BINDS.forEach(function (b) {
    if (b.profile === prof && b.bypass !== true) { b.bypass = true; changed = true; }
  });
  if (changed) {
    await saveBindsToFile();
    renderBinds();
  }
}

function launchFromBinds() {
  var urlEl    = document.getElementById('bind-url');
  var profEl   = document.getElementById('bind-profile');
  var broEl    = document.getElementById('bind-browser');
  var bypassEl = document.getElementById('bind-bypass');
  var url      = urlEl    ? urlEl.value.trim()    : '';
  var prof     = profEl   ? profEl.value.trim()   : '';
  var bro      = broEl    ? broEl.value            : 'chrome';
  var bypass   = bypassEl ? bypassEl.value === '1' : true;
  if (!url) { showToast('Заполни URL или путь', 'err'); return; }
  if (bro !== 'app' && !prof) { showToast('Заполни имя профиля', 'err'); return; }
  launchBrowser(url, prof || 'default', bro, bypass);
}

// ── ZAPRET ──
var zapretActive = false;

async function zapretStart() {
  try {
    var res = await apiBridge.zapretStart();
    if (res && res.ok) { zapretActive = true; syncZapretUI(); showToast('Zapret запущен!', 'ok'); }
    else showToast('Zapret: ' + (res ? res.msg : '?'), 'err');
  } catch(e) { showToast('Ошибка моста API', 'err'); }
}

async function zapretStop() {
  try {
    await apiBridge.zapretStop();
    zapretActive = false; syncZapretUI(); showToast('Zapret остановлен', 'err');
  } catch(e) {}
}

apiBridge.onZapretStatus(function(s) {
  if (!s) return;
  zapretActive = !!s.on; syncZapretUI();
  if (s.msg) showToast(s.msg, s.on ? 'ok' : 'err');
});

apiBridge.onTrayAction(function(a) {
  if (a === 'run')    zapretStart();
  if (a === 'stop')   zapretStop();
  if (a === 'config') apiBridge.openFolder('Zapret');
});

// Состояние окна (развёрнуто/обычное): в развёрнутом виде скругления и отступы
// снимаются через body.is-max (см. CSS в index.html).
if (typeof apiBridge.onWinMaximized === 'function') {
  apiBridge.onWinMaximized(function(isMax) {
    try {
      if (document.body && document.body.classList) document.body.classList.toggle('is-max', !!isMax);
    } catch (_) {}
  });
}

function syncZapretUI() {
  var dot    = document.getElementById('zapret-dot');
  var lbl    = document.getElementById('zapret-label');
  var hdot   = document.getElementById('home-zap-dot');
  var hlbl   = document.getElementById('home-zap-label');
  if (dot)  { dot.classList.toggle('is-on', zapretActive); }
  if (lbl)  { lbl.textContent = zapretActive ? 'ZAPRET ONLINE' : 'ZAPRET OFFLINE'; lbl.classList.toggle('is-on', zapretActive); }
  if (hdot) { hdot.style.background = zapretActive ? 'var(--grn)' : 'var(--red)'; }
  if (hlbl) { hlbl.textContent = zapretActive ? 'ВКЛ' : 'ВЫКЛ'; hlbl.style.color = zapretActive ? 'var(--grn)' : 'var(--red)'; }
}

// ── PROFILES ──
var BROWSER_ICONS = {
  chrome:  '<svg viewBox="0 0 32 32" width="28" height="28"><circle cx="16" cy="16" r="10" fill="#fff"/><path d="M16 6a10 10 0 0 1 8.66 5H16a5 5 0 0 0-5 5 5 5 0 0 0 .34 1.83L6.7 12.17A10 10 0 0 1 16 6z" fill="#EA4335"/><path d="M26 16a10 10 0 0 1-5 8.66l-4.33-7.5A5 5 0 0 0 21 16z" fill="#34A853"/><path d="M6 16a10 10 0 0 0 5 8.66l4.33-7.5A5 5 0 0 1 11 16z" fill="#FBBC05"/><circle cx="16" cy="16" r="5" fill="#4285F4"/></svg>',
  msedge:  '<svg viewBox="0 0 32 32" width="28" height="28"><path d="M27 18c0 5-3.8 9-9 9a9 9 0 0 1-9-9c0-3.5 2-6.5 5-8 .5 1.2.8 2.6.8 4 0 3.9 3.1 7 7 7 2.1 0 4-.9 5.2-2.4V18z" fill="#0078D7"/><path d="M27 18v.6A9 9 0 0 1 18 27c2.5-1 4.5-3.3 5.2-6.1A5 5 0 0 0 27 18z" fill="#50E6FF"/><path d="M5 22.5A13 13 0 0 0 18 29c7.2 0 13-5.8 13-13 0-1-.1-2-.4-3H18c-3.9 0-7 3.1-7 7 0 1.4.4 2.7 1.1 3.8A8 8 0 0 1 5 22.5z" fill="#1EBBEE"/><path d="M5 10A13 13 0 0 1 18 3c4.4 0 8.3 2.2 10.7 5.5A13 13 0 0 0 18 7c-4.8 0-9 2.6-11.3 6.5A9.1 9.1 0 0 0 5 10z" fill="#0078D7"/></svg>',
  firefox: '<svg viewBox="0 0 32 32" width="28" height="28"><circle cx="16" cy="16" r="13" fill="#FF9500"/><path d="M16 3C9 3 3 9 3 16s6 13 13 13 13-6 13-13S23 3 16 3zm0 2a11 11 0 0 1 9 4.7c-1.3-.5-2.8-.7-4-.5-2 .4-3.3 2-4.3 3.4-.7 1-1.4 2-2.6 2.4-.8.3-1.8.1-2.4-.5-.7-.6-.9-1.6-.6-2.5A11 11 0 0 1 16 5z" fill="#FF6611"/><path d="M25 23.3A11 11 0 0 1 8 25c1-.6 2.2-1 3.4-.8 1.8.3 3 1.8 4.1 3 .8.8 1.7 1.5 2.8 1.5 1.3 0 2.5-.9 3.2-2 .5-.8.7-1.8.5-2.7z" fill="#FF6611"/></svg>',
  yandex:  '<svg viewBox="0 0 32 32" width="28" height="28"><circle cx="16" cy="16" r="13" fill="#FC3F1D"/><text x="16" y="21" text-anchor="middle" font-family="Arial Black,sans-serif" font-weight="900" font-size="16" fill="#fff">Я</text></svg>',
  default: '🌐',
};

// Жёсткий allowlist собственных SVG-иконок: даже если в данные профиля
// попадёт мусор, в разметку уйдёт только значение из этого словаря.
var BROWSER_ICON_SAFE = {
  chrome:  BROWSER_ICONS.chrome  || '',
  msedge:  BROWSER_ICONS.msedge  || '',
  firefox: BROWSER_ICONS.firefox || '',
  yandex:  BROWSER_ICONS.yandex  || '',
};

function getBrowserIcon(browser) {
  return BROWSER_ICONS[browser] || BROWSER_ICONS.default;
}

// Читаем мета-данные профиля (браузер по умолчанию)
async function getProfileMeta(name) {
  try {
    var r = await apiBridge.readProfileMeta(name);
    return r || {};
  } catch(e) { return {}; }
}

async function renderProfiles() {
  var grid = document.getElementById('profiles-grid');
  if (!grid) return;

  var list = [];
  try { list = await apiBridge.listProfiles(); } catch(e) {}

  grid.textContent = '';

  // Кнопка создания — первой
  var addBtn = afEl('div', { cls: 'profile-add', on: { click: openCreateProfileModal } }, [
    afEl('span', { text: '＋', style: 'color:var(--ac);font-size:22px;line-height:1' }),
    afEl('span', { text: 'Создать профиль', style: 'font-size:12px;letter-spacing:.5px' }),
  ]);
  grid.appendChild(addBtn);

  for (var i = 0; i < list.length; i++) {
    (function(name) {
      // читаем мету синхронно через кеш
      var meta = PROFILE_META_CACHE[name] || {};
      var browser = meta.browser || 'chrome';
      var icon = BROWSER_ICONS[browser];
      var isEmoji = !icon || !icon.startsWith('<');

      // Имя профиля и мета — только текстовые узлы (никакого innerHTML с данными)
      var ava = afEl('div', { cls: 'profile-ava', style: 'display:flex;align-items:center;justify-content:center;font-size:' + (isEmoji ? '22px' : '0') });
      if (icon && icon.startsWith('<')) {
        // иконки браузеров — собственные литеральные SVG из BROWSER_ICONS
        ava.innerHTML = BROWSER_ICON_SAFE[browser] || '';   // af-allow-innerhtml: только литералы из allowlist
      } else {
        ava.textContent = icon || '🌐';
      }

      var countryCode = meta.country || '';
      var cObj = FP_COUNTRIES.find(function(c) { return c.code === countryCode; });
      var countryLabel = cObj ? ((cObj.flag ? cObj.flag + ' ' : '') + cObj.name) : (countryCode ? ('🌍 ' + countryCode) : '🌐 Авто (CDP)');
      var countryBadge = afEl('div', {
        cls: 'profile-country-badge',
        attrs: { title: 'Выбрать страну антидетекта (клик)' },
        text: countryLabel
      });
      countryBadge.addEventListener('click', function(e) {
        e.stopPropagation();
        openProfileCountryModal(name);
      });

      var del = afEl('div', { cls: 'profile-del', attrs: { title: 'Удалить' }, text: '🗑' });
      del.addEventListener('click', function(e) { e.stopPropagation(); deleteProfile(name); });

      var card = afEl('div', { cls: 'profile-card',
        on: { click: function() { launchBrowser('about:blank', name, browser, false); } } }, [
        ava,
        afEl('div', { style: 'flex:1;min-width:0' }, [
          afEl('div', { cls: 'profile-name', text: name }),
          afEl('div', { cls: 'profile-meta', text: browser + ' · profiles\\' + name }),
          countryBadge,
        ]),
        del,
      ]);
      grid.appendChild(card);
    })(list[i]);
  }
}

// Кеш мета данных профилей
var PROFILE_META_CACHE = {};

async function loadProfileMetas() {
  try {
    var list = await apiBridge.listProfiles();
    for (var i = 0; i < list.length; i++) {
      var r = await apiBridge.readProfileMeta(list[i]);
      if (r) PROFILE_META_CACHE[list[i]] = r;
    }
  } catch(e) {}
}

function populateCountrySelect(sel, selectedCode) {
  if (!sel) return;
  sel.textContent = '';
  sel.appendChild(afEl('option', { text: '— авто (случайная связка, без гео) —', attrs: { value: '' } }));
  FP_COUNTRIES.forEach(function (c) {
    var opt = afEl('option', {
      text: (c.flag ? c.flag + ' ' : '') + c.name + ' (' + c.code + ')',
      attrs: { value: c.code },
    });
    if (selectedCode && c.code === selectedCode) {
      opt.selected = true;
    }
    sel.appendChild(opt);
  });
  if (selectedCode) sel.value = selectedCode;
}

function openProfileCountryModal(profileName) {
  CURRENT_COUNTRY_MODAL_PROFILE = profileName;
  openModal(
    '<div class="modal-title"><span>🌍</span> Страна антидетекта <span class="modal-close" data-af-on="click" data-af-action="closeModal">✕</span></div>' +
    '<div id="pcm-profile-name" style="font-size:12.5px;font-weight:700;color:var(--ac);margin-bottom:8px"></div>' +
    '<p style="font-size:11px;color:var(--tx2);line-height:1.6;margin-bottom:12px">' +
      'Обход без VPN: браузерные сигналы (часовой пояс, язык, геопозиция города, валюта) подменяются через CDP до загрузки страницы.' +
    '</p>' +
    '<label class="field-label">Выбери страну</label>' +
    '<select class="af-input" id="pcm-country" style="margin-bottom:12px"></select>' +
    '<div id="pcm-hint" style="font-size:10px;color:var(--tx2);line-height:1.5;margin-bottom:14px"></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<button class="btn btn-primary" data-af-on="click" data-af-action="saveProfileCountryModal">✓ Применить</button>' +
      '<button class="btn btn-secondary" data-af-on="click" data-af-action="closeModal">Отмена</button>' +
    '</div>'
  );
  var pNameEl = document.getElementById('pcm-profile-name');
  if (pNameEl) pNameEl.textContent = 'Профиль: ' + profileName;

  var meta = PROFILE_META_CACHE[profileName] || {};
  initFpCountries().then(function() {
    var sel = document.getElementById('pcm-country');
    if (sel) {
      populateCountrySelect(sel, meta.country || '');
      sel.addEventListener('change', function() { updatePcmHint(sel.value); });
      updatePcmHint(meta.country || '');
    }
  }).catch(function(){});
}

function updatePcmHint(code) {
  var hint = document.getElementById('pcm-hint');
  if (!hint) return;
  if (!code) {
    hint.style.color = 'var(--tx2)';
    hint.textContent = 'Авто-режим: случайная связка зоны и языка из 40 стран, гео-точка не эмулируется.';
    return;
  }
  var c = FP_COUNTRIES.find(function(x) { return x.code === code; });
  hint.style.color = 'var(--ylw)';
  hint.textContent = '⚠ ' + (c ? c.name : code) + ': сайты увидят зону, язык и гео этой страны. ' +
    'Для полной маскировки IP свяжи профиль с резидентским прокси ' + code + '.';
}

async function saveProfileCountryModal() {
  var prof = CURRENT_COUNTRY_MODAL_PROFILE;
  if (!prof) return;
  var sel = document.getElementById('pcm-country');
  var code = sel ? sel.value : '';
  var meta = {};
  try { meta = await apiBridge.readProfileMeta(prof) || {}; } catch(e) { meta = {}; }
  try {
    var r = await apiBridge.writeProfileMeta(prof, {
      browser: meta.browser || 'chrome',
      note: meta.note || '',
      country: code
    });
    if (r && r.ok) {
      PROFILE_META_CACHE[prof] = Object.assign({}, PROFILE_META_CACHE[prof] || {}, { country: code });
      closeModal();
      showToast(code ? '🌍 ' + prof + ' → ' + code : '🌍 ' + prof + ' → авто', 'ok');
      renderProfiles();
      // Авто-настройка обхода без VPN: страна выбрана → сами включаем Zapret
      // и переводим бинды этого профиля в режим «С обходом».
      if (code) {
        await enableBindsBypassForProfile(prof);
        await ensureBypassAuto(true);
      }
    } else {
      showToast('Ошибка сохранения: ' + ((r && r.msg) || '?'), 'err');
    }
  } catch(e) {
    showToast('Ошибка: ' + e.message, 'err');
  }
}

function openCreateProfileModal() {
  openModal(
    '<div class="modal-title"><span>👤</span> Создать профиль <span class="modal-close" data-af-on="click" data-af-action="closeModal">✕</span></div>' +
    '<label class="field-label">Имя профиля <span style="color:var(--tx2);font-size:9px">(латиница, цифры, _ -)</span></label>' +
    '<input class="af-input" id="mp-name" type="text" placeholder="my_account" style="margin-bottom:12px" autofocus>' +
    '<label class="field-label">Браузер по умолчанию</label>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">' +
      '<button class="btn btn-secondary mp-bro-btn" id="mpb-chrome"  data-af-on="click" data-af-action="selectBrowser" data-af-args=\'["chrome"]\'  style="display:flex;align-items:center;gap:8px;padding:10px 12px">' + BROWSER_ICONS.chrome  + '<span>Chrome</span></button>' +
      '<button class="btn btn-secondary mp-bro-btn" id="mpb-msedge" data-af-on="click" data-af-action="selectBrowser" data-af-args=\'["msedge"]\' style="display:flex;align-items:center;gap:8px;padding:10px 12px">' + BROWSER_ICONS.msedge  + '<span>Edge</span></button>' +
      '<button class="btn btn-secondary mp-bro-btn" id="mpb-firefox" data-af-on="click" data-af-action="selectBrowser" data-af-args=\'["firefox"]\' style="display:flex;align-items:center;gap:8px;padding:10px 12px">' + BROWSER_ICONS.firefox + '<span>Firefox</span></button>' +
      '<button class="btn btn-secondary mp-bro-btn" id="mpb-yandex"  data-af-on="click" data-af-action="selectBrowser" data-af-args=\'["yandex"]\'  style="display:flex;align-items:center;gap:8px;padding:10px 12px">' + BROWSER_ICONS.yandex  + '<span>Яндекс</span></button>' +
    '</div>' +
    '<label class="field-label">🌍 Страна антидетекта (без VPN)</label>' +
    '<select class="af-input" id="mp-country" style="margin-bottom:12px"></select>' +
    '<label class="field-label">Заметка (необязательно)</label>' +
    '<input class="af-input" id="mp-note" type="text" placeholder="напр: основной акк YouTube" style="margin-bottom:12px">' +
    '<label class="field-label">Прокси профиля <span style="color:var(--tx2);font-size:9px">(необязательно — socks5://host:port)</span></label>' +
    '<input class="af-input" id="mp-proxy" type="text" placeholder="socks5://127.0.0.1:1080" style="margin-bottom:8px">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">' +
      '<input class="af-input" id="mp-proxy-user" type="text" placeholder="логин" autocomplete="off">' +
      '<input class="af-input" id="mp-proxy-pass" type="password" placeholder="пароль" autocomplete="new-password">' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<button class="btn btn-primary" data-af-on="click" data-af-action="submitCreateProfile">✓ Создать</button>' +
      '<button class="btn btn-secondary" data-af-on="click" data-af-action="closeModal">Отмена</button>' +
    '</div>'
  );
  selectBrowser('chrome');
  initFpCountries().then(function() {
    var cSel = document.getElementById('mp-country');
    if (cSel) populateCountrySelect(cSel, '');
  }).catch(function(){});
  // фокус на поле имени
  setTimeout(function(){ var el = document.getElementById('mp-name'); if(el) el.focus(); }, 80);
}

var _selectedBrowser = 'chrome';
function selectBrowser(b) {
  _selectedBrowser = b;
  var btns = document.querySelectorAll('.mp-bro-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.remove('btn-primary');
    btns[i].classList.add('btn-secondary');
    btns[i].style.border = '';
  }
  var active = document.getElementById('mpb-' + b);
  if (active) {
    active.classList.remove('btn-secondary');
    active.classList.add('btn-primary');
  }
}

async function submitCreateProfile() {
  var nameEl = document.getElementById('mp-name');
  var noteEl = document.getElementById('mp-note');
  var name   = nameEl ? nameEl.value.trim() : '';
  var note   = noteEl ? noteEl.value.trim() : '';
  if (!name) { showToast('Введи имя профиля', 'err'); if(nameEl) nameEl.focus(); return; }
  var safe = name.replace(/[^a-zA-Z0-9_\-]/g, '');
  if (!safe) { showToast('Только латиница, цифры, _ или -', 'err'); return; }

  var countryEl = document.getElementById('mp-country');
  var country = countryEl ? countryEl.value : '';

  var proxyEl = document.getElementById('mp-proxy');
  var proxyUserEl = document.getElementById('mp-proxy-user');
  var proxyPassEl = document.getElementById('mp-proxy-pass');
  var proxyServer = proxyEl ? proxyEl.value.trim() : '';
  if (proxyServer && !/^(socks5|socks4|http|https):\/\/[A-Za-z0-9._:\-]{1,120}$/.test(proxyServer)) {
    showToast('Прокси должен быть вида socks5://host:port', 'err');
    return;
  }

  try {
    var res = await apiBridge.createProfile(safe);
    if (res && res.ok) {
      var meta = { browser: _selectedBrowser, note: note, country: country, created: new Date().toISOString() };
      if (proxyServer) {
        meta.proxy = {
          server: proxyServer,
          username: proxyUserEl ? proxyUserEl.value.trim() : '',
          password: proxyPassEl ? proxyPassEl.value : '',
        };
      }
      await apiBridge.writeProfileMeta(safe, meta);
      PROFILE_META_CACHE[safe] = { browser: _selectedBrowser, note: note, country: country };
      closeModal();
      showToast('✅ Профиль "' + safe + '" создан (' + _selectedBrowser + (country ? ', ' + country : '') + ')', 'ok');
      renderProfiles();
      // Страна выбрана сразу при создании → обход без VPN включаем автоматически
      if (country) await ensureBypassAuto(true);
    } else {
      showToast('Ошибка: ' + (res ? res.msg : '?'), 'err');
    }
  } catch(e) { showToast('Ошибка моста API: ' + e.message, 'err'); }
}

async function createProfile() {
  openCreateProfileModal();
}

async function deleteProfile(name) {
  if (!confirm('Удалить профиль "' + name + '"?\nВсе данные будут стёрты.')) return;
  try {
    var res = await apiBridge.deleteProfile(name);
    if (res && res.ok) {
      delete PROFILE_META_CACHE[name];
      showToast('"' + name + '" удалён', 'err');
      renderProfiles();
    }
    else showToast('Ошибка: ' + (res ? res.msg : '?'), 'err');
  } catch(e) { showToast('Ошибка моста API', 'err'); }
}

// ── SPOOF CONFIG (обманка аккаунта) ──
function setSpoof(field, val) {
  var ids = { account_age:'spoof-age', history:'spoof-history', timezone:'spoof-tz', lang:'spoof-lang' };
  var el = document.getElementById(ids[field]);
  if (el) { el.value = val; showToast('✓ ' + val, 'ok'); }
}

async function saveSpoofConfig() {
  var age  = (document.getElementById('spoof-age')     || {}).value || '';
  var hist = (document.getElementById('spoof-history')  || {}).value || '';
  var tz   = (document.getElementById('spoof-tz')       || {}).value || '';
  var lang = (document.getElementById('spoof-lang')     || {}).value || '';
  var spoof = { account_age: age, history: hist, timezone: tz, lang: lang };
  // пишем в config.json вместе с UA/res
  try {
    var existing = await apiBridge.readConfig();
    existing.spoof = spoof;
    var r = await apiBridge.writeConfig(existing);
    if (r && r.ok) showToast('Обманка сохранена! Применится при след. запуске.', 'ok');
    else showToast('Ошибка записи', 'err');
  } catch(e) { showToast('Ошибка моста API', 'err'); }
}

async function loadSpoofConfig() {
  try {
    var data = await apiBridge.readConfig();
    var s = data.spoof || {};
    var ageEl  = document.getElementById('spoof-age');
    var histEl = document.getElementById('spoof-history');
    var tzEl   = document.getElementById('spoof-tz');
    var langEl = document.getElementById('spoof-lang');
    if (ageEl)  ageEl.value  = s.account_age || '';
    if (histEl) histEl.value = s.history      || '';
    if (tzEl)   tzEl.value   = s.timezone     || '';
    if (langEl) langEl.value = s.lang         || '';
  } catch(e) {}
}
var SAVED_BINDS = [];

async function loadBinds() {
  try {
    var r = await apiBridge.readBinds();
    if (r && Array.isArray(r)) SAVED_BINDS = r;
  } catch(e) {}
}

async function saveBindsToFile() {
  try { await apiBridge.writeBinds(SAVED_BINDS); } catch(e) {}
}

function addBind() {
  var urlEl    = document.getElementById('bind-url');
  var profEl   = document.getElementById('bind-profile');
  var broEl    = document.getElementById('bind-browser');
  var bypassEl = document.getElementById('bind-bypass');
  var nameEl   = document.getElementById('bind-name');
  var url      = urlEl    ? urlEl.value.trim()    : '';
  var prof     = profEl   ? profEl.value.trim()   : '';
  var bro      = broEl    ? broEl.value            : 'chrome';
  var bypass   = bypassEl ? bypassEl.value === '1' : true;
  var label    = nameEl   ? nameEl.value.trim()    : '';
  if (!url) { showToast('Введи URL или путь к приложению', 'err'); return; }
  if (bro !== 'app' && !prof) { showToast('Введи имя профиля для браузера', 'err'); return; }
  if (!label) label = url.replace(/https?:\/\//,'').split('/')[0] || url;
  var bind = { id: Date.now(), label: label, url: url, profile: prof, browser: bro, bypass: bypass };
  SAVED_BINDS.push(bind);
  saveBindsToFile();
  renderBinds();
  // сброс формы
  if (urlEl)    urlEl.value    = '';
  if (profEl)   profEl.value   = '';
  if (nameEl)   nameEl.value   = '';
  showToast('Бинд "' + label + '" добавлен', 'ok');
}

function deleteBind(id) {
  SAVED_BINDS = SAVED_BINDS.filter(function(b){ return b.id !== id; });
  saveBindsToFile();
  renderBinds();
  showToast('Бинд удалён', 'err');
}

/** Тумблер «Авто-обход без VPN» на вкладке биндов. */
function saveAutoBypass() {
  var el = document.getElementById('auto-bypass');
  APP_SETTINGS.autoBypass = !!(el && el.checked);
  saveSettings();
  showToast(APP_SETTINGS.autoBypass
    ? '⚡ Авто-обход включён: Zapret стартует сам при выборе страны и запуске биндов'
    : 'Авто-обход выключен — запускай Zapret вручную', APP_SETTINGS.autoBypass ? 'ok' : '');
}

/** Инициализация вкладки «Бинды»: список + состояние тумблера авто-обхода. */
function initBindsTab() {
  var el = document.getElementById('auto-bypass');
  if (el) el.checked = APP_SETTINGS.autoBypass !== false;
  renderBinds();
}

function renderBinds() {
  var grid = document.getElementById('binds-grid');
  if (!grid) return;
  grid.textContent = '';
  if (!SAVED_BINDS.length) {
    grid.appendChild(afEl('div', {
      text: 'Нет сохранённых биндов. Создай первый выше ↑',
      style: 'color:var(--tx2);font-size:11px;font-family:var(--mono);padding:14px 0' }));
    return;
  }
  SAVED_BINDS.forEach(function(b) {
    var card = document.createElement('div');
    card.className = 'bind-item';
    var icon = b.browser === 'app' ? '🖥️' : b.browser === 'msedge' ? '🌐' : b.browser === 'firefox' ? '🦊' : b.browser === 'yandex' ? '🟡' : '🔵';

    // Бейдж собирается узлами, а не строкой HTML
    var bypassBadge = afEl('span', {
      cls: 'bind-badge ' + (b.bypass ? 'bypass' : 'direct'),
      text: b.bypass ? 'BYPASS' : 'DIRECT',
    });

    var delBtn = afEl('button', {
      cls: 'bind-del',
      text: '🗑',
      attrs: { type: 'button', title: 'Удалить бинд' },
      on: { click: function(e) { e.stopPropagation(); deleteBind(b.id); } },
    });

    var meta = afEl('div', { cls: 'bind-meta' },
      [bypassBadge, document.createTextNode(b.browser !== 'app' ? b.browser + ' · ' + (b.profile || '—') : 'Приложение')]);

    card.appendChild(afEl('div', { cls: 'bind-ico', text: icon }));
    card.appendChild(afEl('div', { style: 'flex:1;min-width:0' }, [
      afEl('div', { cls: 'bind-label', text: b.label || b.url || '—' }),
      meta,
    ]));
    card.appendChild(delBtn);
    card.addEventListener('click', function() {
      launchBrowser(b.url, b.profile, b.browser, b.bypass);
    });
    grid.appendChild(card);
  });
}

// ── THEMES & COLORS ──
var APP_SETTINGS = { theme: '', colors: null, bgImage: null };

// Список тем нового дизайна (без киберпанк-набора).
// Старые значения (th-cyber, th-hacker, th-matrix и т.п.) больше не применяются.
var AF_THEMES = ['th-mint','th-sky','th-amber','th-rose','th-night'];
var AF_THEME_NAMES = {
  '': 'Классика',
  'th-mint': 'Мята',
  'th-sky': 'Небо',
  'th-amber': 'Янтарь',
  'th-rose': 'Роза',
  'th-night': 'Ночь',
};

// Акценты каждой темы — чтобы при смене темы подставлять их в color-input'ы
// и чтобы кастомные цвета можно было менять поверх любой темы.
var THEME_ACCENTS = {
  '':         ['#4f46e5', '#8b5cf6'],
  'th-mint':  ['#059669', '#14b8a6'],
  'th-sky':   ['#0284c7', '#38bdf8'],
  'th-amber': ['#d97706', '#f59e0b'],
  'th-rose':  ['#e11d48', '#f472b6'],
  'th-night': ['#8195f8', '#b39dfb'],
};

/** Пишет CSS-переменную на :root И инлайном на <body>.
    Темы объявлены как body.th-*{--ac:…} — без инлайна на body пользовательский
    цвет проигрывал теме, и после выбора темы цвета «не менялись». */
function setCssVar(name, value) {
  try {
    var de = document.documentElement;
    if (de && de.style && typeof de.style.setProperty === 'function') de.style.setProperty(name, value);
    var b = document.body;
    if (b && b.style && typeof b.style.setProperty === 'function') b.style.setProperty(name, value);
  } catch (_) {}
}

function removeCssVar(name) {
  try {
    var de = document.documentElement;
    if (de && de.style && typeof de.style.removeProperty === 'function') de.style.removeProperty(name);
    var b = document.body;
    if (b && b.style && typeof b.style.removeProperty === 'function') b.style.removeProperty(name);
  } catch (_) {}
}

function previewColors() {
  var acEl = document.getElementById('color-accent');
  var ac2El = document.getElementById('color-accent2');
  var ac  = (acEl && acEl.value)  || '#4f46e5';
  var ac2 = (ac2El && ac2El.value) || '#8b5cf6';
  applyColors(ac, ac2);
}

async function saveColors() {
  var acEl = document.getElementById('color-accent');
  var ac2El = document.getElementById('color-accent2');
  var ac  = (acEl && acEl.value)  || '#4f46e5';
  var ac2 = (ac2El && ac2El.value) || '#8b5cf6';
  applyColors(ac, ac2);
  APP_SETTINGS.colors = { ac: ac, ac2: ac2 };
  await saveSettings();
  showToast('✅ Цвета сохранены! Работают поверх любой темы.', 'ok');
}

async function resetColors() {
  ['--ac','--acr','--ac2','--ac2r'].forEach(removeCssVar);
  AF_THEMES.forEach(function(t){ document.body.classList.remove(t); });
  APP_SETTINGS.theme  = '';
  APP_SETTINGS.colors = null;
  var acc = THEME_ACCENTS[''];
  var acEl  = document.getElementById('color-accent');
  var ac2El = document.getElementById('color-accent2');
  if (acEl)  acEl.value  = acc[0];
  if (ac2El) ac2El.value = acc[1];
  await saveSettings();
  showToast('↺ Сброс выполнен');
  var btn = document.querySelector('[data-tab="settings"]');
  goTab('settings', btn);
}

function hexToRgb(hex) {
  var r = parseInt(hex.slice(1,3), 16);
  var g = parseInt(hex.slice(3,5), 16);
  var b = parseInt(hex.slice(5,7), 16);
  return r + ',' + g + ',' + b;
}

function applyColors(ac, ac2) {
  if (typeof ac !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(ac)) ac = '#4f46e5';
  if (typeof ac2 !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(ac2)) ac2 = '#8b5cf6';
  setCssVar('--ac',   ac);
  setCssVar('--acr',  hexToRgb(ac));
  setCssVar('--ac2',  ac2);
  setCssVar('--ac2r', hexToRgb(ac2));
}

// ── THEMES ──
function setTheme(cls) {
  if (cls && AF_THEMES.indexOf(cls) === -1) cls = '';   // старые темы игнорируем
  AF_THEMES.forEach(function(t){ document.body.classList.remove(t); });
  if (cls) document.body.classList.add(cls);
  APP_SETTINGS.theme = cls;
  // Смена темы убирает кастомные цвета, чтобы акценты темы было видно.
  // Сразу после этого цвета снова можно менять — инлайновые переменные
  // на <body> перебивают тему (см. setCssVar).
  ['--ac','--acr','--ac2','--ac2r'].forEach(removeCssVar);
  APP_SETTINGS.colors = null;
  var acc = THEME_ACCENTS[cls] || THEME_ACCENTS[''];
  var acEl  = document.getElementById('color-accent');
  var ac2El = document.getElementById('color-accent2');
  if (acEl)  acEl.value  = acc[0];
  if (ac2El) ac2El.value = acc[1];
  saveSettings();
  // Подсветка карточки
  document.querySelectorAll('.theme-card').forEach(function(el) {
    el.classList.remove('is-active');
    if (el.id === 'tc-' + cls) el.classList.add('is-active');
  });
  showToast('🎨 Тема: ' + (AF_THEME_NAMES[cls] || cls || 'Классика'), 'ok');
}


function applyScale(val) {
  // mirrorInput может вызвать без аргумента — берём значение из ползунка.
  var el = document.getElementById('ui-scale');
  if (val === undefined || val === null || val === '') {
    val = (el && el.value !== '' && el.value !== undefined) ? el.value : (APP_SETTINGS.uiScale || '1');
  }
  var s = parseFloat(val);
  if (!Number.isFinite(s)) s = 1;                       // раньше тут был NaN → scale(NaN)
  s = Math.min(2, Math.max(0.5, Math.round(s * 10) / 10));
  // Настоящий Chromium-zoom через preload (webFrame.setZoomFactor):
  // масштабирует весь интерфейс и не конфликтует с CSS-анимацией #app.
  if (apiBridge && typeof apiBridge.setZoom === 'function') apiBridge.setZoom(s);
  var disp = document.getElementById('scale-display');
  if (disp) disp.textContent = s.toFixed(1);
  APP_SETTINGS.uiScale = String(s);
  saveSettings();
}

// ── ОКНО: скругление + прозрачность ──
// Переменные пишем только на :root — у body.is-max своё объявление
// (--win-radius:0), которое перебивает унаследованное значение.
function applyWindowStyle() {
  var op = parseFloat(APP_SETTINGS.winOpacity);
  if (!Number.isFinite(op) || op < 0.3 || op > 1) op = 1;
  var rad = parseFloat(APP_SETTINGS.winRadius);
  if (!Number.isFinite(rad) || rad < 0 || rad > 28) rad = 20;
  try {
    var de = document.documentElement;
    if (de && de.style && typeof de.style.setProperty === 'function') {
      de.style.setProperty('--win-alpha', String(Math.round(op * 100) / 100));
      de.style.setProperty('--win-radius', Math.round(rad) + 'px');
    }
  } catch (_) {}
}

/** Ползунки «Окно»: читаем оба, применяем и сохраняем. */
function saveWindowStyle() {
  var radEl = document.getElementById('win-radius');
  var opEl  = document.getElementById('win-opacity');
  if (radEl && radEl.value !== '' && radEl.value !== undefined) {
    var r = parseFloat(radEl.value);
    if (Number.isFinite(r)) APP_SETTINGS.winRadius = String(Math.min(28, Math.max(0, Math.round(r))));
  }
  if (opEl && opEl.value !== '' && opEl.value !== undefined) {
    var o = parseFloat(opEl.value) / 100;               // ползунок в процентах
    if (Number.isFinite(o)) APP_SETTINGS.winOpacity = String(Math.min(1, Math.max(0.3, Math.round(o * 100) / 100)));
  }
  applyWindowStyle();
  saveSettings();
}

// ── ФОН-КАРТИНКА ──
// Картинка хранится как data URL в настройках (до 4 МБ). Слой #bg-image-layer
// имеет opacity: var(--win-alpha) — прозрачность продолжает работать и с картинкой.
function applyBgImage(dataUrl) {
  var layer = document.getElementById('bg-image-layer');
  var app = document.getElementById('app');
  var preview = document.getElementById('bg-preview');
  var status = document.getElementById('bg-image-status');
  if (!layer || !app) return;
  if (dataUrl && typeof dataUrl === 'string' && dataUrl.indexOf('data:image/') === 0) {
    // Безопасно: dataUrl из main-процесса, но экранируем кавычки
    var safe = dataUrl.replace(/"/g, '\\"');
    // Оверлей из --bg-rgb для читаемости текста поверх картинки
    layer.style.backgroundImage = 'linear-gradient(rgba(var(--bg-rgb,237,240,247),0.62), rgba(var(--bg-rgb,237,240,247),0.62)), url("' + safe + '")';
    app.classList.add('has-bg-image');
    if (preview) {
      preview.style.display = '';
      preview.style.backgroundImage = 'url("' + safe + '")';
    }
    if (status) { status.style.color = 'var(--grn)'; status.textContent = '✓ Картинка установлена'; }
  } else {
    layer.style.backgroundImage = '';
    app.classList.remove('has-bg-image');
    if (preview) { preview.style.display = 'none'; preview.style.backgroundImage = ''; }
    if (status) { status.style.color = 'var(--tx3)'; status.textContent = 'Фон — стандартный цвет'; }
  }
}

async function pickBgImage() {
  var status = document.getElementById('bg-image-status');
  if (status) { status.style.color = 'var(--ac)'; status.textContent = '⏳ Выбор файла...'; }
  try {
    var res = await apiBridge.pickBgImage();
    if (res && res.ok && res.dataUrl) {
      APP_SETTINGS.bgImage = res.dataUrl;
      applyBgImage(res.dataUrl);
      await saveSettings();
      showToast('🖼 Фон-картинка установлена! Прозрачность продолжает работать.', 'ok');
    } else {
      if (status) { status.style.color = res && res.msg ? 'var(--red)' : 'var(--tx3)'; status.textContent = res && res.msg ? '✗ ' + res.msg : 'Отменено'; }
      if (res && res.msg) showToast(res.msg, 'err');
    }
  } catch (e) {
    if (status) { status.style.color = 'var(--red)'; status.textContent = '✗ ' + e.message; }
    showToast('Ошибка: ' + e.message, 'err');
  }
}

async function clearBgImage() {
  APP_SETTINGS.bgImage = null;
  applyBgImage(null);
  await saveSettings();
  showToast('Фон сброшен на стандартный', '');
}

// Эффекты фона (частицы/сканлайны) из старого дизайна удалены —
// функция сохранена для совместимости с записанными настройками.
function saveFx() {
  saveSettings();
}

function initSettingsTab() {
  var s = APP_SETTINGS;
  // Активная тема
  var cur = (s.theme && AF_THEMES.indexOf(s.theme) !== -1) ? s.theme : '';
  document.querySelectorAll('.theme-card').forEach(function(el) {
    el.classList.remove('is-active');
    if (el.id === 'tc-' + cur) el.classList.add('is-active');
  });
  // Цвета: сохранённые кастомные или акценты текущей темы
  var acc = THEME_ACCENTS[cur] || THEME_ACCENTS[''];
  var acEl  = document.getElementById('color-accent');
  var ac2El = document.getElementById('color-accent2');
  if (acEl)  acEl.value  = (s.colors && s.colors.ac)  || acc[0];
  if (ac2El) ac2El.value = (s.colors && s.colors.ac2) || acc[1];
  // Масштаб интерфейса
  var scEl = document.getElementById('ui-scale');
  var scD  = document.getElementById('scale-display');
  var sc   = parseFloat(s.uiScale);
  if (!Number.isFinite(sc)) sc = 1;
  if (scEl) scEl.value = String(sc);
  if (scD)  scD.textContent = sc.toFixed(1);
  // Окно: скругление и прозрачность
  var rad = parseFloat(s.winRadius);
  if (!Number.isFinite(rad) || rad < 0 || rad > 28) rad = 20;
  var op = parseFloat(s.winOpacity);
  if (!Number.isFinite(op) || op < 0.3 || op > 1) op = 1;
  var radEl = document.getElementById('win-radius');
  var opEl  = document.getElementById('win-opacity');
  var radD  = document.getElementById('radius-display');
  var opD   = document.getElementById('opacity-display');
  if (radEl) radEl.value = String(Math.round(rad));
  if (opEl)  opEl.value  = String(Math.round(op * 100));
  if (radD)  radD.textContent = String(Math.round(rad));
  if (opD)   opD.textContent  = String(Math.round(op * 100));
  // Фон-картинка
  applyBgImage(s.bgImage || null);
}

async function saveSettings() {
  try { await apiBridge.writeSettings(APP_SETTINGS); } catch(e) {}
}

async function loadSettings() {
  try {
    var s = await apiBridge.readSettings();
    if (s && typeof s === 'object') APP_SETTINGS = s;
    // Тема: применяем только из нового набора (старые киберпанк-темы сбрасываются)
    if (APP_SETTINGS.theme) {
      AF_THEMES.forEach(function(t){ document.body.classList.remove(t); });
      if (AF_THEMES.indexOf(APP_SETTINGS.theme) !== -1) {
        document.body.classList.add(APP_SETTINGS.theme);
      }
    }
    if (APP_SETTINGS.colors) applyColors(APP_SETTINGS.colors.ac, APP_SETTINGS.colors.ac2);
    if (APP_SETTINGS.uiScale) applyScale(APP_SETTINGS.uiScale);
  } catch(e) {}
  // Скругление/прозрачность окна применяем всегда (есть настройки или дефолты)
  applyWindowStyle();
  // Фон-картинка — применяем сразу при старте, чтобы прозрачность не ломалась
  try { applyBgImage(APP_SETTINGS.bgImage || null); } catch (_) {}
}

// ── CONFIG ──
var UA_PRESETS = {
  chrome_win:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  chrome_mac:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  edge_win:      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  firefox_win:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  safari_mac:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  mobile_android:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
};

function setUA(key) {
  var el = document.getElementById('cfg-ua');
  if (el && UA_PRESETS[key]) { el.value = UA_PRESETS[key]; showToast('UA: ' + key, 'ok'); }
}
function setRes(val) {
  var el = document.getElementById('cfg-res');
  if (el) { el.value = val; showToast('Разрешение: ' + val, 'ok'); }
}

async function loadConfig() {
  try {
    var data = await apiBridge.readConfig();
    var uaEl  = document.getElementById('cfg-ua');
    var resEl = document.getElementById('cfg-res');
    if (uaEl)  uaEl.value  = data.user_agent || '';
    if (resEl) resEl.value = data.resolution || '1920,1080';
  } catch(e) {}
}

async function saveConfig() {
  var uaEl  = document.getElementById('cfg-ua');
  var resEl = document.getElementById('cfg-res');
  var ua  = uaEl  ? uaEl.value.trim()  : '';
  var res = resEl ? resEl.value.trim() : '1920,1080';
  // валидация формата разрешения
  if (res && !/^\d{3,4},\d{3,4}$/.test(res)) {
    showToast('Формат разрешения: 1920,1080', 'err'); return;
  }
  var data = {};
  if (ua)  data.user_agent = ua;
  if (res) data.resolution = res;
  try {
    var r = await apiBridge.writeConfig(data);
    if (r && r.ok) showToast('config.json сохранён! Настройки применятся при следующем запуске браузера.', 'ok');
    else showToast('Ошибка: ' + (r ? r.msg : '?'), 'err');
  } catch(e) { showToast('Ошибка моста API', 'err'); }
}

// =====================================================
//   ADBLOCK
// =====================================================
var HOSTS_DOMAINS = [];

var AD_PRESETS = {
  google_ads: [
    'pagead2.googlesyndication.com','adservice.google.com','googleadservices.com',
    'doubleclick.net','ad.doubleclick.net','stats.g.doubleclick.net',
    'googleads.g.doubleclick.net','tpc.googlesyndication.com','www.googletagservices.com',
  ],
  yandex_ads: [
    'an.yandex.ru','mc.yandex.ru','yandex-team.ru','bs.serving-sys.com',
    'awaps.yandex.ru','yabs.yandex.ru','banners.adfox.ru','ads.adfox.ru',
    'yastatic.net','static-mon.yandex.net',
  ],
  meta_ads: [
    'an.facebook.com','www.facebook.com','connect.facebook.net','graph.facebook.com',
    'staticxx.facebook.com','xx.fbcdn.net','edge-atlas.facebook.com',
    'atlas.facebook.com','advertising.facebook.com',
  ],
  trackers: [
    'google-analytics.com','www.google-analytics.com','ssl.google-analytics.com',
    'analytics.google.com','metrics.doubleclick.net','hotjar.com','static.hotjar.com',
    'script.hotjar.com','mouseflow.com','fullstory.com','mixpanel.com',
    'segment.io','cdn.segment.com','amplitude.com','api.amplitude.com',
    'mc.yandex.ru','counter.yadro.ru',
  ],
  casino: [
    '1xbet.com','betmaster.ru','pin-up.casino','mostbet.com','vulkan.com',
    'volcano.ru','olimp.bet','leon.ru','888casino.com','pokerdom.com',
    'joycasino.com','azino777.com','champion.ru','melbet.com','fonbet.ru',
  ],
  malware: [
    'malware.com','phishing-site.com','trojan-download.net','virus-alert.ru',
    'free-antivirus-download.com','update-flash-player.com','your-pc-infected.com',
    'tracking.ru','spy-track.net','adware.ru',
  ],
};

async function loadHostsDomains() {
  var statusEl = document.getElementById('hosts-status');
  if (statusEl) statusEl.textContent = 'Читаю hosts...';
  try {
    var r = await apiBridge.hostsRead();
    if (r.ok) {
      HOSTS_DOMAINS = r.domains || [];
      renderHostsList();
      if (statusEl) statusEl.textContent = '✓ Прочитано из hosts-файла';
    } else {
      if (statusEl) statusEl.style.color = 'var(--red)';
      if (statusEl) statusEl.textContent = '✗ ' + r.msg;
    }
  } catch(e) {
    if (statusEl) statusEl.textContent = 'Ошибка моста API: ' + e.message;
  }
}

function renderHostsList() {
  var el = document.getElementById('hosts-list');
  var cnt = document.getElementById('hosts-count');
  if (!el) return;
  if (cnt) cnt.textContent = HOSTS_DOMAINS.length;
  if (!HOSTS_DOMAINS.length) {
    el.textContent = '';
    el.appendChild(afEl('span', { text: 'Список пуст — добавь домены выше', style: 'color:var(--tx2)' }));
    return;
  }
  el.textContent = '';
  HOSTS_DOMAINS.forEach(function(d, i) {
    var row_el = afEl('div', { cls: 'hosts-row' }, [
      afEl('span', { style: 'color:var(--tx2)' }, [
        document.createTextNode('0.0.0.0 '),
        afEl('span', { text: d, style: 'color:var(--tx);font-weight:600' }),
      ]),
      afEl('span', {
        cls: 'hosts-del',
        text: '✕',
        on: { click: function(){ removeDomain(i); } },
      }),
    ]);
    el.appendChild(row_el);
  });
}

function removeDomain(idx) {
  HOSTS_DOMAINS.splice(idx, 1);
  renderHostsList();
}

function addHostsDomain() {
  var inp = document.getElementById('hosts-new-domain');
  if (!inp) return;
  var val = inp.value.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*/,'');
  if (!val) { showToast('Введи домен', 'err'); return; }
  if (HOSTS_DOMAINS.indexOf(val) !== -1) { showToast('Уже в списке', ''); return; }
  HOSTS_DOMAINS.push(val);
  inp.value = '';
  renderHostsList();
  showToast('+ ' + val, 'ok');
}

function addPreset(key) {
  var list = AD_PRESETS[key] || [];
  var added = 0;
  list.forEach(function(d) {
    if (HOSTS_DOMAINS.indexOf(d) === -1) { HOSTS_DOMAINS.push(d); added++; }
  });
  renderHostsList();
  showToast('Добавлено ' + added + ' доменов: ' + key, 'ok');
}

function clearAllDomains() {
  if (!confirm('Очистить весь список блокировок?')) return;
  HOSTS_DOMAINS = [];
  renderHostsList();
  showToast('Список очищен', 'err');
}

async function applyHosts() {
  var statusEl = document.getElementById('hosts-status');
  if (statusEl) { statusEl.style.color = 'var(--tx2)'; statusEl.textContent = 'Применяю...'; }
  try {
    var r = await apiBridge.hostsWrite(HOSTS_DOMAINS);
    if (r.ok) {
      if (statusEl) { statusEl.style.color = 'var(--grn)'; statusEl.textContent = '✓ Применено! ' + HOSTS_DOMAINS.length + ' доменов заблокировано.'; }
      showToast('🛡️ Hosts обновлён! ' + HOSTS_DOMAINS.length + ' доменов', 'ok');
    } else if (r.needAdmin) {
      if (statusEl) statusEl.textContent = 'Нужны права администратора — запрашиваю UAC...';
      var r2 = await apiBridge.hostsWriteAdmin(HOSTS_DOMAINS);
      if (r2.ok) {
        if (statusEl) { statusEl.style.color = 'var(--grn)'; statusEl.textContent = '✓ Применено через UAC! ' + HOSTS_DOMAINS.length + ' доменов.'; }
        showToast('🛡️ Hosts обновлён (admin)!', 'ok');
      } else {
        if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ Ошибка UAC: ' + r2.msg; }
        showToast('Ошибка: ' + r2.msg, 'err');
      }
    } else {
      if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ ' + r.msg; }
      showToast('Ошибка: ' + r.msg, 'err');
    }
  } catch(e) { showToast('Ошибка моста API', 'err'); }
}

async function initAdblock() {
  await loadHostsDomains();
  // заполняем список профилей для uBlock
  var sel = document.getElementById('ublock-profile');
  if (sel) {
    var list = [];
    try { list = await apiBridge.listProfiles(); } catch(e) {}
    sel.textContent = '';
    if (list.length) {
      list.forEach(function(pr) { sel.appendChild(afEl('option', { text: pr, attrs: { value: pr } })); });
    } else {
      sel.appendChild(afEl('option', { text: '— Нет профилей —', attrs: { value: '' } }));
    }
  }
  // проверяем наличие assets/ublock
  try {
    var chk = await apiBridge.ublockCheck();
    var statusEl = document.getElementById('ublock-status');
    if (chk.hasManifest) {
      if (statusEl) { statusEl.style.color = 'var(--grn)'; statusEl.textContent = '✓ uBlock найден в assets/ublock/ — версия ' + (chk.version || '?'); }
    } else if (chk.exists) {
      if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ Папка assets/ublock/ есть, но внутри нет manifest.json — распакуй CRX внутрь папки'; }
    } else {
      if (statusEl) { statusEl.style.color = 'var(--tx2)'; statusEl.textContent = '⚠ Папка assets/ublock/ не найдена. Создай её и распакуй туда CRX файл'; }
    }
  } catch(e) {}
}

async function installUblock() {
  var sel = document.getElementById('ublock-profile');
  var statusEl = document.getElementById('ublock-status');
  if (!sel || !sel.value) { showToast('Выбери профиль', 'err'); return; }
  // сначала проверяем папку
  try {
    var chk = await apiBridge.ublockCheck();
    if (!chk.hasManifest) {
      var msg = chk.exists
        ? 'В assets\\ublock\\ нет manifest.json — распакуй CRX внутрь папки (не в подпапку!)'
        : 'Создай папку assets\\ublock\\ рядом с программой и распакуй туда CRX';
      if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ ' + msg; }
      showToast(msg, 'err'); return;
    }
  } catch(e) {}
  if (statusEl) { statusEl.style.color = 'var(--tx2)'; statusEl.textContent = 'Устанавливаю...'; }
  try {
    var r = await apiBridge.ublockInstall(sel.value);
    if (r.ok) {
      if (statusEl) { statusEl.style.color = 'var(--grn)'; statusEl.textContent = '✓ uBlock v' + r.version + ' установлен в профиль "' + sel.value + '"\n→ ' + r.dst; }
      showToast('🧩 uBlock установлен в ' + sel.value + '!', 'ok');
    } else {
      if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '✗ ' + r.msg; }
      showToast('Ошибка: ' + r.msg, 'err');
    }
  } catch(e) { showToast('Ошибка моста API', 'err'); }
}

function openUblockLink() {
  apiBridge.openExternal('https://github.com/gorhill/uBlock/releases/latest');
}
function openUblockFolder() {
  apiBridge.openFolder('assets');
}

// =====================================================
//   ДИАГНОСТИКА КОМПОНЕНТОВ
// =====================================================
var DIAG_RUNNING = false;

var DIAG_COMPONENTS = [
  { id:'python',     icon:'🐍', name:'Python',           cmd:'diag-check-python'   },
  { id:'pip',        icon:'📦', name:'pip',               cmd:'diag-check-pip'      },
  { id:'selenium',   icon:'🤖', name:'selenium',          cmd:'diag-check-pkg',  pkg:'selenium'          },
  { id:'stealth',    icon:'👻', name:'selenium-stealth',  cmd:'diag-check-pkg',  pkg:'selenium_stealth'  },
  { id:'wdm',        icon:'🔩', name:'webdriver-manager', cmd:'diag-check-pkg',  pkg:'webdriver_manager' },
  { id:'chrome',     icon:'🌐', name:'Google Chrome',     cmd:'diag-check-chrome'   },
  { id:'chromedrv',  icon:'⚙',  name:'ChromeDriver',      cmd:'diag-check-chromedrv'},
  { id:'edge',       icon:'🌀', name:'Microsoft Edge',    cmd:'diag-check-edge'     },
  { id:'edgedrv',    icon:'⚙',  name:'EdgeDriver',        cmd:'diag-check-edgedrv'  },
];

var diagResults = {};

function diagLog(msg, cls) {
  var log = document.getElementById('diag-log');
  if (!log) return;
  if (log.querySelector('span')) log.textContent = '';
  var d = document.createElement('div');
  d.className = 'diag-log-' + (cls||'info');
  d.textContent = msg;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function diagProgress(pct, label) {
  var wrap = document.getElementById('diag-progress-wrap');
  var bar  = document.getElementById('diag-progress-bar');
  var lbl  = document.getElementById('diag-progress-label');
  var pctEl= document.getElementById('diag-progress-pct');
  if (!wrap) return;
  wrap.style.display = '';
  if (bar)  bar.style.width = pct + '%';
  if (lbl)  lbl.textContent = label || '';
  if (pctEl)pctEl.textContent = pct + '%';
}

function diagRenderList() {
  var list = document.getElementById('diag-list');
  if (!list) return;
  list.textContent = '';
  var needInstall = false;
  DIAG_COMPONENTS.forEach(function(c) {
    var r = diagResults[c.id] || { status:'unknown' };
    var row = document.createElement('div');
    row.className = 'diag-row';
    var stCls  = r.status === 'ok' ? 'ok' : r.status === 'wait' ? 'wait' : r.status === 'warn' ? 'warn' : 'err';
    var stText = r.status === 'ok' ? '✓ OK' : r.status === 'wait' ? '...' : r.status === 'warn' ? '⚠ обновить' : '✗ нет';
    if (r.status === 'err' || r.status === 'warn') needInstall = true;
    row.appendChild(afEl('div', { cls: 'diag-icon', text: c.icon }));
    row.appendChild(afEl('div', { cls: 'diag-name', text: c.name }));
    row.appendChild(afEl('div', { cls: 'diag-ver',  text: r.version || '' }));
    row.appendChild(afEl('div', { cls: 'diag-status ' + stCls, text: stText }));
    list.appendChild(row);
  });
  var installBtn = document.getElementById('diag-install-btn');
  if (installBtn) installBtn.disabled = !needInstall;
}

async function initDiag() {
  // Восстанавливаем лог из буфера если установка шла в фоне
  if (DIAG_LOG_BUFFER.length > 0) {
    var log = document.getElementById('diag-log');
    if (log) {
      log.textContent = '';
      DIAG_LOG_BUFFER.slice(-200).forEach(function(e) {
        var d = document.createElement('div');
        d.className = 'diag-log-' + (e.cls||'info');
        d.textContent = e.msg;
        log.appendChild(d);
      });
      log.scrollTop = log.scrollHeight;
    }
  }
  // Восстанавливаем состояние кнопок
  var installBtn = document.getElementById('diag-install-btn');
  var checkBtn   = document.getElementById('diag-check-btn');
  if (DIAG_RUNNING) {
    if (installBtn) { installBtn.disabled = true; installBtn.textContent = '⏳ Установка...'; }
    if (checkBtn)   checkBtn.disabled = true;
    diagLogGlobal('⏳ Установка выполняется...', 'step');
  } else {
    diagRenderList();
  }
}

async function diagCheck() {
  if (DIAG_RUNNING) return;
  DIAG_RUNNING = true;
  var checkBtn = document.getElementById('diag-check-btn');
  if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = '...'; }
  diagLog('Сканирование компонентов...', 'step');
  diagProgress(5, 'Проверка...');

  var total = DIAG_COMPONENTS.length;
  for (var i = 0; i < total; i++) {
    var c = DIAG_COMPONENTS[i];
    diagResults[c.id] = { status:'wait' };
    diagRenderList();
    diagProgress(Math.round((i/total)*80)+5, c.name + '...');
    try {
      var r = await apiBridge.diagCheck({ component: c.id, pkg: c.pkg });
      diagResults[c.id] = r;
      diagLog((r.status==='ok'?'✓':'✗') + ' ' + c.name + (r.version?' — '+r.version:'') + (r.note?' ('+r.note+')':''), r.status==='ok'?'ok':r.status==='warn'?'warn':'err');
    } catch(e) {
      diagResults[c.id] = { status:'err', note: e.message };
      diagLog('✗ ' + c.name + ': ошибка моста API', 'err');
    }
    diagRenderList();
  }

  diagProgress(100, 'Готово');
  var errors = DIAG_COMPONENTS.filter(function(c){ return diagResults[c.id] && (diagResults[c.id].status==='err'||diagResults[c.id].status==='warn'); });
  if (errors.length === 0) diagLog('Все компоненты в порядке!', 'ok');
  else diagLog('Нужно установить: ' + errors.map(function(c){return c.name;}).join(', '), 'warn');

  DIAG_RUNNING = false;
  if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = 'Проверить'; }
}

// Глобальный лог установки — не зависит от DOM вкладки
var DIAG_LOG_BUFFER = [];
var DIAG_LISTENERS_ADDED = false;

function diagLogGlobal(msg, cls) {
  DIAG_LOG_BUFFER.push({ msg, cls });
  // Пишем в DOM если вкладка открыта
  var log = document.getElementById('diag-log');
  if (log) {
    if (log.querySelector('span')) log.textContent = '';
    // Перерисовываем весь буфер
    DIAG_LOG_BUFFER.slice(-200).forEach(function(e) {
      var d = document.createElement('div');
      d.className = 'diag-log-' + (e.cls||'info');
      d.textContent = e.msg;
      log.appendChild(d);
    });
    log.scrollTop = log.scrollHeight;
  }
}

function diagProgressGlobal(pct, label) {
  // Обновляем DOM если открыт
  var wrap = document.getElementById('diag-progress-wrap');
  var bar  = document.getElementById('diag-progress-bar');
  var lbl  = document.getElementById('diag-progress-label');
  var pctEl= document.getElementById('diag-progress-pct');
  if (wrap) wrap.style.display = '';
  if (bar)  bar.style.width = pct + '%';
  if (lbl)  lbl.textContent = label || '';
  if (pctEl)pctEl.textContent = pct + '%';
  // Обновляем статус в навбаре
  var navBtn = document.querySelector('[data-tab="diag"]');
  if (navBtn && DIAG_RUNNING) {
    navBtn.querySelector('.nav-icon').textContent = pct >= 100 ? '✓' : '⏳';
  }
}

function diagLog(msg, cls) { diagLogGlobal(msg, cls); }
function diagProgress(pct, label) { diagProgressGlobal(pct, label); }

async function diagInstallAll() {
  if (DIAG_RUNNING) return;
  DIAG_RUNNING = true;
  DIAG_LOG_BUFFER = [];

  var installBtn = document.getElementById('diag-install-btn');
  var checkBtn   = document.getElementById('diag-check-btn');
  if (installBtn) { installBtn.disabled = true; installBtn.textContent = '⏳'; }
  if (checkBtn)   checkBtn.disabled = true;

  // Вешаем слушатели один раз глобально
  if (!DIAG_LISTENERS_ADDED) {
    DIAG_LISTENERS_ADDED = true;
    apiBridge.onDiagLog(function(d) { diagLogGlobal(d.msg, d.type||'info'); });
    apiBridge.onDiagProgress(function(d) { diagProgressGlobal(d.pct, d.label); });
  }

  var toInstall = DIAG_COMPONENTS.filter(function(c){
    return diagResults[c.id] && (diagResults[c.id].status==='err' || diagResults[c.id].status==='warn');
  });

  diagLogGlobal('Установка ' + toInstall.length + ' компонентов...', 'step');
  diagProgressGlobal(5, 'Запуск...');

  try {
    var res = await apiBridge.diagInstall({ components: toInstall.map(function(c){return c.id;}) });
    diagLogGlobal(res.ok ? '✓ Готово!' : '✗ ' + res.msg, res.ok ? 'ok' : 'err');
  } catch(e) {
    diagLogGlobal('✗ ' + e.message, 'err');
  }

  DIAG_RUNNING = false;
  var navBtn = document.querySelector('[data-tab="diag"]');
  if (navBtn) navBtn.querySelector('.nav-icon').textContent = '🔧';
  if (installBtn) { installBtn.textContent = 'Установить всё'; }
  if (checkBtn)   checkBtn.disabled = false;
  await diagCheck();
}

// =====================================================
//   ЛОГИ ЗАПУСКОВ
// =====================================================
var ALL_LOGS = [];

// Живые обновления — когда открыта вкладка логов
apiBridge.onLogEntry(function(entries) {
  if (!Array.isArray(entries)) return;
  entries.forEach(function(e) {
    // Не дублируем
    if (!ALL_LOGS.find(function(x){ return x.ts === e.ts && x.msg === e.msg; })) {
      ALL_LOGS.push(e);
    }
  });
  if (ALL_LOGS.length > 500) ALL_LOGS = ALL_LOGS.slice(-500);
  // Обновляем DOM если вкладка открыта
  var wrap = document.getElementById('logs-wrap');
  if (wrap) renderLogsDOM(wrap);
  // Мигаем иконкой в навбаре
  var ico = document.getElementById('logs-nav-icon');
  if (ico && document.querySelector('[data-tab="logs"]') &&
      !document.querySelector('[data-tab="logs"].is-active')) {
    ico.textContent = '🔴';
    setTimeout(function(){ ico.textContent = '📋'; }, 2000);
  }
});

async function initLogs() {
  // Загружаем все логи из main процесса
  try {
    var logs = await apiBridge.readLogs();
    if (Array.isArray(logs)) ALL_LOGS = logs;
  } catch(e) {}
  var wrap = document.getElementById('logs-wrap');
  if (wrap) renderLogsDOM(wrap);
  // Сбрасываем иконку
  var ico = document.getElementById('logs-nav-icon');
  if (ico) ico.textContent = '📋';
}

function renderLogs() {
  var wrap = document.getElementById('logs-wrap');
  if (wrap) renderLogsDOM(wrap);
}

function renderLogsDOM(wrap) {
  var filterBrowser = document.getElementById('log-filter-browser');
  var filterLevel   = document.getElementById('log-filter-level');
  var fb = filterBrowser ? filterBrowser.value : '';
  var fl = filterLevel   ? filterLevel.value   : '';

  var logs = ALL_LOGS.slice().reverse(); // новые сверху
  if (fb) logs = logs.filter(function(l){ return l.browser === fb; });
  if (fl === 'error') logs = logs.filter(function(l){ return l.msg.toLowerCase().includes('error') || l.msg.includes('[error]'); });
  if (fl === 'engine') logs = logs.filter(function(l){ return l.msg.includes('[engine]') || l.msg.includes('[start]'); });

  if (logs.length === 0) {
    wrap.textContent = '';
    wrap.appendChild(afEl('div', { text: 'Нет записей' + (fb||fl ? ' по фильтру' : '') + '.', style: 'color:var(--tx2)' }));
    return;
  }

  var BROWSER_COLORS = { chrome:'#4285F4', msedge:'#0078D7', firefox:'#FF9500', yandex:'#FC3F1D' };
  wrap.textContent = '';
  logs.forEach(function(e) {
    var msg  = String(e.msg === undefined ? '' : e.msg);
    var time = new Date(e.ts).toLocaleTimeString('ru-RU');
    var isErr  = /error/i.test(msg) || msg.indexOf('[error]') !== -1;
    var isOk   = msg.indexOf('[start]') !== -1 || msg.indexOf('OK') !== -1 || msg.indexOf('✓') !== -1;
    var color  = isErr ? 'var(--red)' : isOk ? 'var(--grn)' : 'var(--tx2)';
    var bcolor = BROWSER_COLORS[e.browser] || 'var(--ac)';
    // Все значения — текстовые узлы: логи приходят из stdout браузера/скриптов
    wrap.appendChild(afEl('div', { cls: 'log-row' }, [
      afEl('span', { cls: 'log-time', text: time }),
      afEl('span', { cls: 'log-browser', text: e.browser || '', style: 'color:' + bcolor }),
      afEl('span', { cls: 'log-profile', text: e.profile || '', attrs: { title: e.profile || '' } }),
      afEl('span', { cls: 'log-msg ' + (isErr ? 'err' : isOk ? 'ok' : ''), text: msg }),
    ]));
  });
}

async function clearLogs() {
  try { await apiBridge.clearLogs(); } catch(e) {}
  ALL_LOGS = [];
  renderLogs();
  showToast('Логи очищены');
}

// =====================================================
//   FINGERPRINT РАНДОМИЗАЦИЯ
// =====================================================

// Отпечаток целиком считает main-процесс (см. fingerprint-identity.js) —
// один источник правды для превью и для боевого запуска. Здесь только UI.

/** Селект профилей в карточке Fingerprint (для превью и смены личности). */
async function initFpProfileSelect() {
  var sel = document.getElementById('fp-profile');
  if (!sel) return;
  var list = [];
  try { list = await apiBridge.listProfiles(); } catch (e) { list = []; }
  var keep = sel.value;
  sel.textContent = '';
  if (!list.length) {
    sel.appendChild(afEl('option', { text: '— Нет профилей —', attrs: { value: '' } }));
  } else {
    list.forEach(function (pr) { sel.appendChild(afEl('option', { text: pr, attrs: { value: pr } })); });
    if (keep && list.indexOf(keep) !== -1) sel.value = keep;
  }
  loadFpCountry();   // сама внутри подтянет список стран (once)
}

var FP_COUNTRIES = [];
var FP_COUNTRIES_BUILT = false;

/** Заполняем селектор стран антидетекта (список отдаёт main-процесс). Один раз — иначе перебор опций сотрёт уже выбранное значение. */
async function initFpCountries() {
  if (!FP_COUNTRIES_BUILT || !FP_COUNTRIES.length) {
    var list = [];
    try { list = await apiBridge.listCountries() || []; } catch (e) { list = []; }
    FP_COUNTRIES = Array.isArray(list) ? list : [];
    FP_COUNTRIES_BUILT = true;
  }
  var sel = document.getElementById('fp-country');
  if (sel && (!sel.options || sel.options.length <= 1)) {
    sel.textContent = '';
    sel.appendChild(afEl('option', { text: '— авто (случайная связка, гео не эмулируется) —', attrs: { value: '' } }));
    FP_COUNTRIES.forEach(function (c) {
      sel.appendChild(afEl('option', {
        text: (c.flag ? c.flag + ' ' : '') + c.name + ' (' + c.code + ')',
        attrs: { value: c.code },
      }));
    });
  }
  return FP_COUNTRIES;
}

/** Пользователь переключил профиль — подтягиваем его страну в селектор. */
async function loadFpCountry() {
  var profSel = document.getElementById('fp-profile');
  var countrySel = document.getElementById('fp-country');
  if (!profSel || !countrySel) return;
  // сначала опции стран, иначе value=«код» не встанет на пустой селектор
  await initFpCountries();
  var meta = {};
  if (profSel.value) {
    try { meta = await apiBridge.readProfileMeta(profSel.value) || {}; } catch (e) { meta = {}; }
  }
  countrySel.value = (typeof meta.country === 'string') ? meta.country : '';
  updateFpCountryHint();
}

function updateFpCountryHint() {
  var hint = document.getElementById('fp-country-hint');
  var sel = document.getElementById('fp-country');
  if (!hint || !sel) return;
  if (!sel.value) {
    hint.style.color = 'var(--tx2)';
    hint.textContent = 'Без VPN-процесса: меняются зона, язык, валюта и координаты профиля (CDP). '
      + 'Выходной IP браузеру не поменять — при выбранной стране поставь этому профилю прокси той же страны (Аккаунты → профиль).';
    return;
  }
  var c = FP_COUNTRIES.filter(function (x) { return x.code === sel.value; })[0];
  hint.style.color = 'var(--ylw)';
  hint.textContent = '⚠ ' + (c ? c.name : sel.value) + ': сайты увидят зону, язык и геопозицию этой страны. '
    + 'IP по-прежнему реальный — свяжи профиль с прокси ' + sel.value + ', иначе GeoIP и геопозиция разойдутся.';
}

/** Сохраняем выбор страны в meta профиля (прокси НЕ трогаем — пароль хранится в meta без права чтения рендерером). */
async function saveFpCountry() {
  var profSel = document.getElementById('fp-profile');
  var countrySel = document.getElementById('fp-country');
  var prof = profSel ? profSel.value : '';
  var code = countrySel ? countrySel.value : '';
  if (!prof) {
    showToast('Сначала создай профиль (вкладка «Аккаунты»)', 'err');
    if (countrySel) countrySel.value = '';
    return;
  }
  var meta = {};
  try { meta = await apiBridge.readProfileMeta(prof) || {}; } catch (e) { meta = {}; }
  var r = await apiBridge.writeProfileMeta(prof, {
    browser: meta.browser || 'chrome',
    note: meta.note || '',
    country: code,
  });
  if (r && r.ok) {
    PROFILE_META_CACHE[prof] = Object.assign({}, PROFILE_META_CACHE[prof] || {}, { country: code });
    showToast(code ? '🌍 «' + prof + '» → страна ' + code : '🌍 «' + prof + '» → авто-страна', 'ok');
    // Авто-настройка обхода без VPN: выбрали страну → Zapret включается сам,
    // бинды профиля переводятся в режим «С обходом».
    if (code) {
      await enableBindsBypassForProfile(prof);
      await ensureBypassAuto(true);
    }
  } else {
    showToast('Не удалось сохранить страну: ' + ((r && r.msg) || '?'), 'err');
  }
  updateFpCountryHint();
}

/** Смена «личности» профиля: следующий запуск получит новый стабильный отпечаток. */
async function rerollFingerprint() {
  var sel = document.getElementById('fp-profile');
  var prof = sel ? sel.value : '';
  if (!prof) { showToast('Сначала создай профиль', 'err'); return; }
  var r = await apiBridge.rerollProfile(prof);
  if (r && r.ok) {
    showToast('🎲 Отпечаток профиля «' + prof + '» будет новым', 'ok');
    previewFingerprint();
  } else {
    showToast('Не удалось: ' + ((r && r.msg) || 'неизвестная ошибка'), 'err');
  }
}

function saveFpConfig() {
  var _f1 = document.getElementById('fp-webgl');
  var _f2 = document.getElementById('fp-platform');
  var _f3 = document.getElementById('fp-canvas');
  var _f4 = document.getElementById('fp-resolution');
  var _f5 = document.getElementById('fp-ua');
  var cfg = {
    webgl:      (_f1 && _f1.checked)      !== false,
    platform:   (_f2 && _f2.checked)   !== false,
    canvas:     (_f3 && _f3.checked)     !== false,
    resolution: (_f4 && _f4.checked) || false,
    ua:         (_f5 && _f5.checked)         || false,
  };
  // Сохраняем в APP_SETTINGS
  APP_SETTINGS.fingerprint = cfg;
  saveSettings();
  showToast('Fingerprint сохранён', 'ok');
}

function loadFpConfig() {
  var cfg = APP_SETTINGS.fingerprint || {};
  var set = function(id, val) { var el = document.getElementById(id); if (el) el.checked = val !== false; };
  set('fp-webgl',      cfg.webgl      !== false);
  set('fp-platform',   cfg.platform   !== false);
  set('fp-canvas',     cfg.canvas     !== false);
  set('fp-resolution', cfg.resolution === true);
  set('fp-ua',         cfg.ua         === true);
}

// Превью отпечатка. Все значения считает main-процесс тем же генератором,
// что применяется при реальном запуске, — превью не врёт.
async function previewFingerprint() {
  var el = document.getElementById('fp-preview');
  if (!el) return;
  el.style.display = '';
  el.textContent = '';
  el.appendChild(afEl('div', { text: '⏳ Считаем отпечаток для текущего профиля...', style: 'color:var(--tx2)' }));

  var sel  = document.getElementById('fp-profile');
  var prof = (sel && sel.value) ? sel.value : null;
  var res = {};
  try { res = await apiBridge.previewProfile(prof) || {}; } catch (e) { res = {}; }

  el.textContent = '';
  var fp = res.fingerprint || {};
  var W = { webgl: 'WebGL (GPU)', platform: 'Платформа', canvas: 'Canvas', audio: 'Audio', fonts: 'Шрифты',
            tz: 'Часовой пояс', lang: 'Языки', ua: 'User-Agent', screen: 'Экран', hw: 'Железо',
            battery: 'Батарея', media: 'Медиакодеки', rtc: 'WebRTC',
            country: 'Страна (брауз.)', geo: 'Геопозиция', currency: 'Валюта' };
  var rows = [];

  rows.push(['Профиль', res.profile ? res.profile + (res.profileExists ? '' : '  (будет создан)') : '—']);
  rows.push(['Режим', res.consistency === 'profile' ? 'стабильный отпечаток профиля' : 'новая сессия']);

  Object.keys(W).forEach(function (k) {
    var v = fp[k];
    if (v === undefined || v === null || v === false) return;
    if (typeof v === 'object') v = JSON.stringify(v);
    rows.push([W[k] + ':', String(v)]);
  });

  rows.push(['Canvas noise', fp.canvas_noise !== undefined ? fp.canvas_noise : '—']);
  rows.push(['Проверка утечек', res.leakCheck ? '✓ все векторы согласованы' : '✗ найдены противоречия']);
  if (res.countryCode && res.hasProxy === false) {
    rows.push(['⚠ IP', 'у профиля нет прокси: GeoIP провайдера покажет другую страну — поставь прокси ' + res.countryCode]);
  } else if (res.countryCode) {
    rows.push(['IP', 'прокси профиля активен — убедись, что его выходная страна ' + res.countryCode]);
  }

  rows.forEach(function (pair) {
    el.appendChild(afEl('div', {}, [
      afEl('span', { text: pair[0] + ' ', style: 'color:var(--ac)' }),
      document.createTextNode(pair[1]),
    ]));
  });

  if (res.webglRenderer) {
    el.appendChild(afEl('div', {
      text: 'GPU: ' + res.webglRenderer,
      style: 'color:var(--tx2);margin-top:6px;word-break:break-all',
    }));
  }

  // Проблемы согласованности — прямым текстом, чтобы было понятно, что чинить
  if (Array.isArray(res.leakProblems) && res.leakProblems.length) {
    el.appendChild(afEl('div', { text: 'Проблемы:', style: 'color:var(--ylw);margin-top:8px' }));
    res.leakProblems.forEach(function(pb) {
      el.appendChild(afEl('div', { text: '• ' + pb, style: 'color:var(--ylw);word-break:break-word' }));
    });
  }
}

// =====================================================
//   КЛАССИКА — командная консоль интерфейса
//   Это НЕ системный shell: свободное выполнение команд ОС запрещено
//   моделью безопасности (docs/SECURITY.md §2.4). Консоль — текстовый
//   режим управления теми же проверенными действиями моста API.
// =====================================================
var CONSOLE_HISTORY = [];
var CONSOLE_HIST_POS = -1;
var CONSOLE_COUNTRY_CACHE = null;

function cprint(text, style) {
  var out = document.getElementById('console-out');
  if (!out) return;
  String(text).split('\n').forEach(function (line) {
    out.appendChild(afEl('div', {
      text: line === '' ? ' ' : line,
      style: 'white-space:pre-wrap;word-break:break-word' + (style ? ';' + style : ''),
    }));
  });
  out.scrollTop = out.scrollHeight;
}

function cmdSplit(line) {
  var out = [], m, re = /"([^"]*)"|(\S+)/g;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function consoleCountries() {
  if (CONSOLE_COUNTRY_CACHE) return Promise.resolve(CONSOLE_COUNTRY_CACHE);
  return apiBridge.listCountries().then(function (list) {
    CONSOLE_COUNTRY_CACHE = Array.isArray(list) ? list : [];
    return CONSOLE_COUNTRY_CACHE;
  }).catch(function () { CONSOLE_COUNTRY_CACHE = []; return CONSOLE_COUNTRY_CACHE; });
}

function consoleUsage() {
  cprint('Команды (регистр не важен, аргументы с пробелами — в "кавычках"):', 'color:var(--tx2)');
  [
    ['help',                           'эта справка'],
    ['clear',                          'очистить консоль'],
    ['profiles',                       'список профилей'],
    ['mkprofile <имя>',                'создать профиль'],
    ['rmprofile <имя>',                'удалить профиль'],
    ['meta <профиль>',                 'показать meta: браузер, страна, прокси'],
    ['preview [профиль]',              'предпросмотр отпечатка (как кнопка в «Конфигурация»)'],
    ['reroll <профиль>',               'новый отпечаток (смена личности)'],
    ['countries [фильтр]',             'страны антидетекта (ISO-коды)'],
    ['country <профиль> <ISO|->',      'страна антидетекта; «-» или Auto = авто'],
    ['open <профиль> [url] [браузер]', 'запустить браузер профиля'],
    ['close-all',                      'закрыть все браузеры профилей'],
    ['killwinws',                      'остановить winws.exe (Zapret-движок)'],
    ['zapret <start|stop|version>',    'управление Zapret'],
    ['warp <fix|test>',                'починить/проверить WARP в Чебурнете'],
    ['ping <host> [порт]',             'TCP-проверка хоста (как в «Чебурнет»)'],
    ['logs',                           'последние логи запусков'],
    ['version',                        'версия оболочки'],
  ].forEach(function (c) {
    cprint('  ' + c[0], 'color:var(--ac)');
    cprint('      ' + c[1], 'color:var(--tx2)');
  });
}

async function consoleExec(raw) {
  var line = String(raw || '').trim();
  var args = cmdSplit(line);
  var cmd = (args.shift() || '').toLowerCase();
  if (!cmd) return;
  cprint('› ' + line, 'color:var(--ac);font-weight:700;margin-top:6px');

  try {
    if (cmd === 'help') { consoleUsage(); }

    else if (cmd === 'clear') { consoleClear(); }

    else if (cmd === 'version') {
      cprint('Artofix ' + (apiBridge.version || '2.5.x') + ' · платформа ' + (apiBridge.platform || '?'), 'color:var(--tx2)');
    }

    else if (cmd === 'profiles') {
      var list = await apiBridge.listProfiles();
      if (!list || !list.length) cprint('(профилей нет — создай: mkprofile yt)', 'color:var(--tx2)');
      else list.forEach(function (p) { cprint('  👤 ' + p); });
    }

    else if (cmd === 'mkprofile') {
      if (!args[0]) return cprint('Нужно имя: mkprofile yt', 'color:var(--red)');
      var r1 = await apiBridge.createProfile(args[0]);
      cprint(r1 && r1.ok ? '✓ профиль «' + args[0] + '» создан' : '✗ ' + ((r1 && r1.msg) || 'ошибка'),
             'color:' + (r1 && r1.ok ? 'var(--grn)' : 'var(--red)'));
    }

    else if (cmd === 'rmprofile') {
      if (!args[0]) return cprint('Нужно имя: rmprofile yt', 'color:var(--red)');
      var r2 = await apiBridge.deleteProfile(args[0]);
      cprint(r2 && r2.ok ? '✓ профиль «' + args[0] + '» удалён' : '✗ ' + ((r2 && r2.msg) || 'ошибка'),
             'color:' + (r2 && r2.ok ? 'var(--grn)' : 'var(--red)'));
    }

    else if (cmd === 'meta') {
      if (!args[0]) return cprint('Нужен профиль: meta yt', 'color:var(--red)');
      var mt = await apiBridge.readProfileMeta(args[0]) || {};
      cprint('  браузер : ' + (mt.browser || 'chrome'));
      cprint('  страна  : ' + (mt.country || 'авто (без эмуляции гео)'));
      cprint('  прокси  : ' + (mt.proxy && mt.proxy.server ? mt.proxy.server : 'нет'));
      cprint('  заметка : ' + (mt.note || '—'));
    }

    else if (cmd === 'preview') {
      var prof = args[0] || null;
      var pv = await apiBridge.previewProfile(prof) || {};
      var f = pv.fingerprint || {};
      cprint('  профиль : ' + (pv.profile || 'preview') + (pv.profileExists ? '' : ' (будет создан)'));
      cprint('  страна  : ' + (f.country || 'авто — без эмуляции гео'));
      if (f.geo) cprint('  гео     : ' + f.geo);
      if (f.currency) cprint('  валюта  : ' + f.currency);
      cprint('  зона    : ' + (f.tz || '—'));
      cprint('  языки   : ' + (f.lang || '—'));
      cprint('  GPU     : ' + (f.webgl || '—'));
      cprint('  экран   : ' + (f.screen || '—'));
      cprint('  железо  : ' + (f.hw || '—'));
      if (pv.countryCode && pv.hasProxy === false) {
        cprint('  ⚠ у профиля нет прокси: GeoIP провайдера покажет другую страну', 'color:var(--ylw)');
      }
      cprint(pv.leakCheck ? '✓ утечек нет — все векторы согласованы'
                          : '✗ противоречия:\n  - ' + (pv.leakProblems || []).join('\n  - '),
             'color:' + (pv.leakCheck ? 'var(--grn)' : 'var(--ylw)'));
    }

    else if (cmd === 'countries') {
      var flt = (args[0] || '').toLowerCase();
      var clist = await consoleCountries();
      var shown = clist.filter(function (c) {
        return !flt || c.code.toLowerCase().indexOf(flt) !== -1 || c.name.toLowerCase().indexOf(flt) !== -1;
      });
      if (!shown.length) cprint('Ничего не найдено по «' + flt + '»', 'color:var(--tx2)');
      shown.forEach(function (c) {
        cprint('  ' + c.code + '  ' + (c.flag || '') + ' ' + c.name + ' — ' + c.currency + ', городов: ' + c.cities);
      });
      cprint('Применение: country <профиль> <ISO>', 'color:var(--tx3)');
    }

    else if (cmd === 'country') {
      var cprof = args[0];
      var code = (args[1] || '').toUpperCase();
      if (!cprof || !code) return cprint('Формат: country <профиль> <ISO|->  (например: country yt DE)', 'color:var(--red)');
      if (code === '-' || code === 'AUTO' || code === '—') code = '';
      if (code) {
        var known = await consoleCountries();
        var hit = known.filter(function (c) { return c.code === code; })[0];
        if (!hit) return cprint('✗ Неизвестная страна «' + code + '» — смотри: countries', 'color:var(--red)');
      }
      if (code) {
        var cmeta = await apiBridge.readProfileMeta(cprof) || {};
        var rc = await apiBridge.writeProfileMeta(cprof, {
          browser: cmeta.browser || 'chrome', note: cmeta.note || '', country: code,
        });
        cprint(rc && rc.ok ? '✓ «' + cprof + '» → страна ' + code + ' (гео/зона/язык — при следующем запуске)'
                           : '✗ ' + ((rc && rc.msg) || 'ошибка'),
               'color:' + (rc && rc.ok ? 'var(--grn)' : 'var(--red)'));
        if (rc && rc.ok) {
          // Авто-настройка: страна выбрана → обход без VPN включается сам,
          // бинды профиля переводятся в режим «С обходом».
          PROFILE_META_CACHE[cprof] = Object.assign({}, PROFILE_META_CACHE[cprof] || {}, { country: code });
          await enableBindsBypassForProfile(cprof);
          var cBypass = await ensureBypassAuto(false);
          cprint(cBypass ? '  ⚡ Обход без VPN (Zapret) включён автоматически'
                         : '  напоминание: IP меняется только прокси профиля той же страны', 'color:var(--ylw)');
        }
      } else {
        var cmeta2 = await apiBridge.readProfileMeta(cprof) || {};
        var rc2 = await apiBridge.writeProfileMeta(cprof, {
          browser: cmeta2.browser || 'chrome', note: cmeta2.note || '', country: '',
        });
        cprint(rc2 && rc2.ok ? '✓ «' + cprof + '» → авто-страна' : '✗ ' + ((rc2 && rc2.msg) || 'ошибка'),
               'color:' + (rc2 && rc2.ok ? 'var(--grn)' : 'var(--red)'));
      }
    }

    else if (cmd === 'reroll') {
      if (!args[0]) return cprint('Нужен профиль: reroll yt', 'color:var(--red)');
      var rr = await apiBridge.rerollProfile(args[0]);
      cprint(rr && rr.ok ? '🎲 Отпечаток «' + args[0] + '» будет новым при следующем запуске'
                         : '✗ ' + ((rr && rr.msg) || 'ошибка'),
             'color:' + (rr && rr.ok ? 'var(--grn)' : 'var(--red)'));
    }

    else if (cmd === 'open') {
      var oprof = args[0];
      var ourl = args[1] || 'about:blank';
      var obro = args[2] || 'chrome';
      if (!oprof) return cprint('Формат: open <профиль> [url] [браузер]', 'color:var(--red)');
      if (['chrome', 'msedge', 'firefox', 'yandex'].indexOf(obro) === -1) {
        return cprint('✗ браузер: chrome|msedge|firefox|yandex', 'color:var(--red)');
      }
      if (!/^(https?:\/\/|about:blank$)/i.test(ourl)) {
        return cprint('✗ url: только http(s):// или about:blank', 'color:var(--red)');
      }
      cprint('Запускаю ' + obro + ' «' + oprof + '» → ' + ourl + ' ...', 'color:var(--tx2)');
      var ro = await apiBridge.launchBrowser({ url: ourl, profile: oprof, browser: obro });
      cprint(ro && ro.ok ? '▶ Запущен' : '✗ ' + ((ro && ro.msg) || 'ошибка запуска'),
             'color:' + (ro && ro.ok ? 'var(--grn)' : 'var(--red)'));
    }

    else if (cmd === 'close-all') {
      var rc3 = await apiBridge.closeBrowsers();
      cprint(rc3 && rc3.ok ? '✓ браузеры закрыты' : '✗ ' + ((rc3 && rc3.msg) || 'ошибка'),
             'color:' + (rc3 && rc3.ok ? 'var(--grn)' : 'var(--red)'));
    }

    else if (cmd === 'killwinws') {
      var rk = await apiBridge.killWinws();
      cprint(rk && rk.ok ? '✓ winws остановлен' : '✗ ' + ((rk && rk.msg) || 'ошибка'),
             'color:' + (rk && rk.ok ? 'var(--grn)' : 'var(--red)'));
    }

    else if (cmd === 'zapret') {
      var sub = (args[0] || '').toLowerCase();
      if (sub === 'start') {
        var rs = await apiBridge.zapretStart();
        cprint(rs && rs.ok ? '✓ Zapret запущен' : '✗ ' + ((rs && rs.msg) || 'ошибка'),
               'color:' + (rs && rs.ok ? 'var(--grn)' : 'var(--red)'));
      } else if (sub === 'stop') {
        var rt = await apiBridge.zapretStop();
        cprint(rt && rt.ok ? '✓ Zapret остановлен' : '✗ ' + ((rt && rt.msg) || 'ошибка'),
               'color:' + (rt && rt.ok ? 'var(--grn)' : 'var(--red)'));
      } else if (sub === 'version') {
        var rv = await apiBridge.zapretVersion();
        cprint('Zapret: ' + ((rv && rv.version) || (rv && rv.msg) || 'нет данных'), 'color:var(--tx2)');
      } else {
        cprint('Формат: zapret start | stop | version', 'color:var(--red)');
      }
    }

    else if (cmd === 'ping') {
      if (!args[0]) return cprint('Формат: ping <host> [порт]', 'color:var(--red)');
      var port = args[1] ? parseInt(args[1], 10) : 443;
      if (!(port >= 1 && port <= 65535)) return cprint('✗ порт 1–65535', 'color:var(--red)');
      var rp = await apiBridge.cbnPing({ host: args[0], port: port });
      if (rp && rp.ok) cprint('✓ ' + args[0] + ':' + port + ' — ' + rp.ping + ' мс', 'color:var(--grn)');
      else cprint('✗ ' + args[0] + ':' + port + ' недоступен' + (rp && rp.err ? ' (' + rp.err + ')' : ''), 'color:var(--red)');
    }

    else if (cmd === 'warp') {
      var wSub = (args[0] || 'fix').toLowerCase();
      if (wSub === 'fix') {
        cprint('Чиним Cloudflare WARP в Чебурнете...', 'color:var(--ac)');
        var rw = await apiBridge.cbnFixWarp();
        cprint(rw && rw.ok ? (rw.msg || '✓ WARP починен') : '✗ ' + ((rw && rw.msg) || 'ошибка'),
               'color:' + (rw && rw.ok ? 'var(--grn)' : 'var(--red)'));
      } else if (wSub === 'test') {
        cprint('Проверяем эндпоинты Cloudflare WARP...', 'color:var(--ac)');
        var rwt = await apiBridge.cbnTestWarp();
        if (rwt && rwt.ok && Array.isArray(rwt.tests)) {
          rwt.tests.forEach(function (t) {
            cprint('  ' + (t.ok ? '✓ ' : '✗ ') + t.name + ' (' + t.ip + ') — ' + (t.ok ? (t.ping + 'мс') : (t.err || 'блок')),
                   'color:' + (t.ok ? 'var(--grn)' : 'var(--red)'));
          });
        }
      } else {
        cprint('Формат: warp fix | warp test', 'color:var(--red)');
      }
    }

    else if (cmd === 'logs') {
      var lg = await apiBridge.readLogs();
      if (!lg || !lg.length) return cprint('(логов нет)', 'color:var(--tx2)');
      lg.slice(-12).forEach(function (l) {
        cprint('  [' + (l.browser || '?') + '/' + (l.profile || '?') + '] ' + l.msg,
               /err|error|✗/i.test(l.msg) ? 'color:var(--red)' : 'color:var(--tx2)');
      });
      cprint('(показаны последние ' + Math.min(lg.length, 12) + ' — полный вид во вкладке «Логи»)', 'color:var(--tx3)');
    }

    else {
      cprint('Неизвестная команда «' + cmd + '». Смотри: help', 'color:var(--red)');
    }
  } catch (e) {
    cprint('✗ ' + (e && e.message ? e.message : e), 'color:var(--red)');
  }
}

function consoleRun() {
  var inp = document.getElementById('console-in');
  if (!inp) return;
  var line = inp.value.trim();
  if (!line) return;
  CONSOLE_HISTORY.push(line);
  if (CONSOLE_HISTORY.length > 50) CONSOLE_HISTORY.shift();
  CONSOLE_HIST_POS = -1;
  inp.value = '';
  consoleExec(line);
}

function consoleClear() {
  var out = document.getElementById('console-out');
  if (out) out.textContent = '';
}

function initConsole() {
  var out = document.getElementById('console-out');
  var inp = document.getElementById('console-in');
  if (!out || !inp) return;
  cprint('Artofix «Классика» v' + (apiBridge.version || '2.5') + ' — командный режим интерфейса.', 'color:var(--tx2)');
  cprint('help — список команд. Все действия проходят проверку моста безопасности (shell нарочно недоступен).', 'color:var(--tx3)');
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { consoleRun(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!CONSOLE_HISTORY.length) return;
      if (CONSOLE_HIST_POS === -1) CONSOLE_HIST_POS = CONSOLE_HISTORY.length - 1;
      else if (CONSOLE_HIST_POS > 0) CONSOLE_HIST_POS--;
      inp.value = CONSOLE_HISTORY[CONSOLE_HIST_POS] || '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (CONSOLE_HIST_POS === -1) return;
      if (CONSOLE_HIST_POS < CONSOLE_HISTORY.length - 1) {
        CONSOLE_HIST_POS++;
        inp.value = CONSOLE_HISTORY[CONSOLE_HIST_POS] || '';
      } else { CONSOLE_HIST_POS = -1; inp.value = ''; }
    }
  });
  try { inp.focus(); } catch (_) {}
}

// =====================================================
//   ЗАПУСК БРАУЗЕРА (fingerprint применяет main-процесс атомарно)
//   Рендерер больше не пишет config.json — только просит запуск.
// =====================================================

// =====================================================
//   ЧЕБУРНЕТ — ЗАЩИТА
// =====================================================
var CBN_SETTINGS = {};
var CBN_MONITOR_TIMER = null;

// Цели для проверки — только те что реально блокируются в РФ.
// Проверяем TCP connect на порт 443, а не HTTP — надёжно и без ложных срабатываний.
// host — реальный хост, port — порт (443 по умолч.), retries — сколько раз пробуем
var CBN_TARGETS = [
  { name: 'YouTube',         host: 'www.youtube.com',    port: 443, icon: '▶' },
  { name: 'Discord',         host: 'discord.com',         port: 443, icon: '💬' },
  { name: 'Claude AI',       host: 'claude.ai',           port: 443, icon: '🧠' },
  { name: 'Cloudflare WARP', host: '1.1.1.1',             port: 443, icon: '🛡️' },
  { name: 'Instagram',       host: 'www.instagram.com',   port: 443, icon: '📷' },
  { name: 'X (Twitter)',     host: 'x.com',               port: 443, icon: '✖' },
  { name: 'Spotify',         host: 'open.spotify.com',    port: 443, icon: '🎵' },
  { name: 'Telegram',        host: 'web.telegram.org',    port: 443, icon: '✈️' },
  { name: 'Twitch',          host: 'www.twitch.tv',       port: 443, icon: '🟣' },
  { name: 'Google',          host: 'www.google.com',      port: 443, icon: '🔍' },
  { name: 'GitHub',          host: 'github.com',          port: 443, icon: '💻' },
];

async function initCheburnet() {
  // Загружаем настройки
  try {
    var s = await apiBridge.readSettings();
    if (s && s.cheburnet) CBN_SETTINGS = s.cheburnet;
  } catch(e) {}
  // Восстанавливаем UI
  if (CBN_SETTINGS.autostart)   { var el=document.getElementById('cbn-autostart');   if(el) el.checked = CBN_SETTINGS.autostart; }
  if (CBN_SETTINGS.autorestart) { var el=document.getElementById('cbn-autorestart'); if(el) el.checked = CBN_SETTINGS.autorestart; }
  if (CBN_SETTINGS.interval)    { var el=document.getElementById('cbn-interval');    if(el) { el.value=CBN_SETTINGS.interval; document.getElementById('cbn-interval-v').textContent=CBN_SETTINGS.interval; } }
  if (CBN_SETTINGS.dns1)        { var el=document.getElementById('cbn-dns1');        if(el) el.value=CBN_SETTINGS.dns1; }
  if (CBN_SETTINGS.dns2)        { var el=document.getElementById('cbn-dns2');        if(el) el.value=CBN_SETTINGS.dns2; }
  if (CBN_SETTINGS.dnsMode)     { var el=document.getElementById('cbn-dns-mode');    if(el) el.value=CBN_SETTINGS.dnsMode; }
  // Рендерим список тестов
  renderCbnTests([]);
  // Если автостарт — запускаем мониторинг
  if (CBN_SETTINGS.autostart) startCbnMonitor();
}

function saveCbn() {
  var _c1 = document.getElementById('cbn-autostart');
  var _c2 = document.getElementById('cbn-autorestart');
  var _c3 = document.getElementById('cbn-interval');
  var _c4 = document.getElementById('cbn-dns1');
  var _c5 = document.getElementById('cbn-dns2');
  var _c6 = document.getElementById('cbn-dns-mode');
  CBN_SETTINGS.autostart   = (_c1 && _c1.checked) || false;
  CBN_SETTINGS.autorestart = (_c2 && _c2.checked) || true;
  CBN_SETTINGS.interval    = parseInt((_c3 && _c3.value) || '30');
  CBN_SETTINGS.dns1        = _c4 && _c4.value;
  CBN_SETTINGS.dns2        = _c5 && _c5.value;
  CBN_SETTINGS.dnsMode     = _c6 && _c6.value;
  APP_SETTINGS.cheburnet = CBN_SETTINGS;
  saveSettings();
  if (CBN_SETTINGS.autostart) startCbnMonitor();
  else stopCbnMonitor();
}

function renderCbnTests(results) {
  var list = document.getElementById('cbn-tests-list');
  if (!list) return;
  list.textContent = '';
  CBN_TARGETS.forEach(function(t, i) {
    var r = results[i] || {};
    var row = document.createElement('div');
    row.className = 'cbn-test-row';
    var dotCls = r.status === 'ok' ? 'ok' : r.status === 'err' ? 'err' : r.status === 'wait' ? 'wait' : '';
    var ping = r.ping ? (' ' + r.ping + 'мс') : '';
    row.appendChild(afEl('div', { cls: 'cbn-dot ' + dotCls, attrs: { id: 'cbn-dot-' + i } }));
    row.appendChild(afEl('span', { text: t.icon, style: 'color:var(--ac)' }));
    row.appendChild(afEl('span', { text: t.name, style: 'flex:1;color:var(--tx)' }));
    row.appendChild(afEl('span', { text: (r.msg || '—') + ping, attrs: { id: 'cbn-res-' + i }, style: 'color:var(--tx2);font-size:9px' }));
    list.appendChild(row);
  });
}

async function cheburnetCheck() {
  cheburnetRunTests();
}

async function cheburnetRunTests() {
  var results = CBN_TARGETS.map(function() { return { status:'wait', msg:'проверка...' }; });
  renderCbnTests(results);

  // TCP ping с повторной попыткой при неудаче — убирает ложные срабатывания
  async function tcpCheck(target) {
    var r1 = await apiBridge.cbnPing({ host: target.host, port: target.port || 443 }).catch(function(){ return { ok: false }; });
    if (r1.ok) return r1;
    // Первый раз не прошёл — ждём 800мс и пробуем ещё раз
    await new Promise(function(r){ setTimeout(r, 800); });
    var r2 = await apiBridge.cbnPing({ host: target.host, port: target.port || 443 }).catch(function(){ return { ok: false }; });
    return r2;
  }

  var blocked = 0;
  for (var i = 0; i < CBN_TARGETS.length; i++) {
    var t = CBN_TARGETS[i];
    try {
      var r = await tcpCheck(t);
      results[i] = r.ok
        ? { status: 'ok',  msg: 'доступен', ping: r.ping }
        : { status: 'err', msg: r.err === 'TIMEOUT' ? 'таймаут' : 'заблокирован' };
      if (!r.ok) blocked++;
    } catch(e) {
      results[i] = { status:'err', msg:'ошибка' };
      blocked++;
    }
    var dot = document.getElementById('cbn-dot-' + i);
    var res = document.getElementById('cbn-res-' + i);
    if (dot) dot.className = 'cbn-dot ' + results[i].status;
    if (res) res.textContent = results[i].msg + (results[i].ping ? ' ' + results[i].ping + 'мс' : '');
  }

  var pct   = Math.round(blocked / CBN_TARGETS.length * 100);
  var icon  = document.getElementById('cbn-threat-icon');
  var label = document.getElementById('cbn-threat-label');
  var sub   = document.getElementById('cbn-threat-sub');
  var bar   = document.getElementById('cbn-threat-bar');

  if (bar) {
    bar.style.width = pct + '%';
    bar.style.background = pct === 0
      ? 'linear-gradient(90deg,var(--grn),#00cc88)'
      : pct < 50
      ? 'linear-gradient(90deg,var(--ylw),#ff8800)'
      : 'linear-gradient(90deg,var(--red),#ff6600)';
  }
  if (pct === 0) {
    if (icon)  icon.textContent  = '✅';
    if (label) { label.textContent = 'Всё доступно'; label.style.color = 'var(--grn)'; }
    if (sub)   sub.textContent   = 'Блокировок не обнаружено.';
  } else if (pct < 50) {
    if (icon)  icon.textContent  = '⚠️';
    if (label) { label.textContent = 'Частичная блокировка ' + blocked + '/' + CBN_TARGETS.length; label.style.color = 'var(--ylw)'; }
    if (sub)   sub.textContent   = 'Некоторые сервисы недоступны. Запусти Zapret.';
    if (CBN_SETTINGS.autorestart) { zapretStart(); showToast('Zapret запущен автоматически', 'ok'); }
  } else {
    if (icon)  icon.textContent  = '🚨';
    if (label) { label.textContent = 'ЧЕБУРНЕТ ' + blocked + '/' + CBN_TARGETS.length; label.style.color = 'var(--red)'; }
    if (sub)   sub.textContent   = 'Массовые блокировки. Аварийный режим...';
    if (CBN_SETTINGS.autorestart) cheburnetEmergency();
  }
}

function startCbnMonitor() {
  if (CBN_MONITOR_TIMER) clearInterval(CBN_MONITOR_TIMER);
  var interval = (CBN_SETTINGS.interval || 30) * 1000;
  CBN_MONITOR_TIMER = setInterval(function() {
    // Проверяем YouTube по TCP — надёжный индикатор
    apiBridge.cbnPing({ host: 'www.youtube.com', port: 443 }).then(function(r) {
      if (!r.ok && CBN_SETTINGS.autorestart) {
        zapretStart();
        showToast('Чебурнет — Zapret запущен', 'ok');
      }
    }).catch(function(){});
  }, interval);
}

function stopCbnMonitor() {
  if (CBN_MONITOR_TIMER) { clearInterval(CBN_MONITOR_TIMER); CBN_MONITOR_TIMER = null; }
}

async function cheburnetApplyDns() {
  var _d1 = document.getElementById('cbn-dns1');
  var _d2 = document.getElementById('cbn-dns2');
  var dns1 = _d1 && _d1.value;
  var dns2 = _d2 && _d2.value;
  var st = document.getElementById('cbn-dns-status');
  if (st) { st.textContent = '⏳ Применяем DNS...'; st.style.color = 'var(--ac)'; }
  try {
    var r = await apiBridge.cbnSetDns({ dns1: dns1, dns2: dns2 });
    if (st) { st.textContent = r.ok ? '✓ DNS успешно изменён на ' + dns1 + ' / ' + dns2 : '✗ Ошибка: ' + r.msg; st.style.color = r.ok ? 'var(--grn)' : 'var(--red)'; }
    if (r.ok) showToast('🔒 DNS изменён: ' + dns1, 'ok');
  } catch(e) { if(st) { st.textContent = '✗ ' + e.message; st.style.color='var(--red)'; } }
}

async function cheburnetResetDns() {
  var st = document.getElementById('cbn-dns-status');
  if (st) { st.textContent = '⏳ Сбрасываем DNS...'; st.style.color='var(--ac)'; }
  try {
    var r = await apiBridge.cbnResetDns();
    if (st) { st.textContent = r.ok ? '✓ DNS сброшен (автоматический от провайдера)' : '✗ ' + r.msg; st.style.color = r.ok ? 'var(--grn)' : 'var(--red)'; }
  } catch(e) { if(st) { st.textContent='✗ '+e.message; st.style.color='var(--red)'; } }
}

async function cheburnetEmergency() {
  var logEl = document.getElementById('cbn-emergency-log');
  if (logEl) { logEl.style.display = ''; logEl.textContent = ''; }
  function eLog(msg, color) {
    if (!logEl) return;
    var line = document.createElement('div');
    line.style.color = color || 'var(--tx2)';
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
  eLog('🆘 Аварийный режим активирован...', 'var(--red)');
  eLog('■ Останавливаем текущий Zapret...', 'var(--tx2)');
  await apiBridge.zapretStop().catch(()=>{});
  await new Promise(r => setTimeout(r, 500));
  eLog('▶ Перезапускаем Zapret...', 'var(--ac)');
  await apiBridge.zapretStart().catch(()=>{});
  eLog('🛡️ Настраиваем чистый Cloudflare WARP / DoH в обход Чебурнета...', 'var(--ac)');
  var warpR = await apiBridge.cbnFixWarp().catch(()=>({ok:false}));
  if (warpR && warpR.ok) {
    eLog(warpR.msg || '✓ WARP / DoH активирован', 'var(--grn)');
  } else {
    eLog('⚠ Пробуем резервный чистый DNS (162.159.192.1 / 162.159.193.1)...', 'var(--ylw)');
    var dnsR = await apiBridge.cbnSetDns({ dns1:'162.159.192.1', dns2:'162.159.193.1' }).catch(()=>({ok:false}));
    eLog(dnsR.ok ? '✓ Резервный DNS применён' : '⚠ DNS не удалось изменить (нужны права администратора)', dnsR.ok ? 'var(--grn)' : 'var(--ylw)');
  }
  await new Promise(r => setTimeout(r, 1000));
  eLog('🌐 Проверяем доступность...', 'var(--tx2)');
  var ping = await apiBridge.cbnPing({ host:'www.google.com', port:443 }).catch(()=>({ok:false}));
  eLog(ping.ok ? '✅ Соединение восстановлено!' : '⚠ Соединение всё ещё ограничено. Попробуй альтернативный режим Zapret.', ping.ok ? 'var(--grn)' : 'var(--ylw)');
  showToast(ping.ok ? '✅ Аварийный режим — OK' : '⚠ Частичное восстановление', ping.ok ? 'ok' : '');
}

async function cbnFixWarp() {
  var st = document.getElementById('cbn-warp-status');
  if (st) { st.textContent = '⏳ Тестируем чистые эндпоинты Cloudflare и настраиваем WARP / DoH...'; st.style.color = 'var(--ac)'; }
  try {
    var r = await apiBridge.cbnFixWarp();
    if (st) {
      st.textContent = r && r.ok ? r.msg : '✗ Ошибка: ' + ((r && r.msg) || 'не удалось настроить');
      st.style.color = r && r.ok ? 'var(--grn)' : 'var(--red)';
    }
    showToast(r && r.ok ? '🛡️ WARP починен в Чебурнете!' : '✗ Ошибка настройки WARP', r && r.ok ? 'ok' : 'err');
  } catch (e) {
    if (st) { st.textContent = '✗ ' + e.message; st.style.color = 'var(--red)'; }
    showToast('Ошибка: ' + e.message, 'err');
  }
}

async function cbnTestWarp() {
  var st = document.getElementById('cbn-warp-status');
  if (st) { st.textContent = '⏳ Проверяем эндпоинты Cloudflare WARP...'; st.style.color = 'var(--ac)'; }
  try {
    var r = await apiBridge.cbnTestWarp();
    if (r && r.ok && Array.isArray(r.tests)) {
      var okCount = r.tests.filter(function (t) { return t.ok; }).length;
      var msg = 'Доступно: ' + okCount + '/' + r.tests.length + ' эндпоинтов. ';
      var details = r.tests.map(function (t) {
        return (t.ok ? '✓ ' : '✗ ') + t.name + ' (' + (t.ok ? (t.ping + 'мс') : (t.err || 'блок')) + ')';
      }).join(' · ');
      if (st) {
        st.textContent = msg + details;
        st.style.color = okCount > 0 ? 'var(--grn)' : 'var(--red)';
      }
      showToast(msg, okCount > 0 ? 'ok' : 'err');
    } else {
      if (st) { st.textContent = '✗ ' + ((r && r.msg) || 'ошибка проверки'); st.style.color = 'var(--red)'; }
    }
  } catch (e) {
    if (st) { st.textContent = '✗ ' + e.message; st.style.color = 'var(--red)'; }
  }
}

async function cheburnetFullCheck() {
  showToast('🔬 Полная диагностика запущена...', 'ok');
  await cheburnetRunTests();
}

// =====================================================
//   ZAPRET AUTO-UPDATE
// =====================================================
var ZU_STATE = { checking: false, updating: false, latestTag: null, assetName: null };
var ZU_PROGRESS_OFF = null;   // отписка от прогресса скачивания (прелоад-подписка)

function zuLog(msg, type) {
  var box = document.getElementById('zu-log');
  if (!box) return;
  var span = document.createElement('div');
  span.style.color = type === 'ok' ? 'var(--grn)' : type === 'err' ? 'var(--red)' : type === 'warn' ? 'var(--ylw)' : 'var(--tx2)';
  span.textContent = msg;
  box.appendChild(span);
  box.scrollTop = box.scrollHeight;
}

function zuProgress(pct, label) {
  var bar = document.getElementById('zu-bar');
  var pctEl = document.getElementById('zu-pct');
  var lbl = document.getElementById('zu-status-label');
  if (bar)   bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
  if (lbl)   lbl.textContent = label || '';
}

function zuShow(cardId) {
  ['zu-status-card','zu-update-card','zu-ok-card','zu-changelog-card'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = id === cardId ? '' : 'none';
  });
}

async function initZapretUpdate() {
  // Читаем текущую версию из version.txt внутри папки Zapret
  try {
    var r = await apiBridge.zapretVersion();
    var el = document.getElementById('zu-current');
    var pe = document.getElementById('zu-path');
    if (el) el.textContent = r.version || 'Не определена';
    if (pe) pe.textContent = r.path || '—';
  } catch(e) {}
  zuShow(null);
}

async function zapretCheckUpdate() {
  if (ZU_STATE.checking || ZU_STATE.updating) return;
  ZU_STATE.checking = true;
  var btn = document.getElementById('zu-btn-check');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Проверяем...'; }

  // показываем прогресс-карту
  zuShow('zu-status-card');
  var logBox = document.getElementById('zu-log');
  if (logBox) logBox.textContent = '';
  zuProgress(10, 'Подключаемся к GitHub...');
  zuLog('🔍 Запрос к GitHub API...', 'info');

  try {
    var res = await apiBridge.zapretCheckUpdate();
    if (!res.ok) {
      zuLog('✗ Ошибка: ' + res.msg, 'err');
      zuProgress(0, 'Ошибка');
      ZU_STATE.checking = false;
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Проверить снова'; }
      return;
    }

    zuProgress(60, 'Получен ответ...');
    zuLog('✓ Последняя версия: ' + res.latestTag, 'ok');
    zuLog('  Дата выхода: ' + res.publishedAt, 'info');
    zuLog('  Файл: ' + res.assetName, 'info');

    // Обновляем карточку "последняя версия"
    var latEl  = document.getElementById('zu-latest');
    var datEl  = document.getElementById('zu-date');
    var sizEl  = document.getElementById('zu-size');
    if (latEl) latEl.textContent = res.latestTag;
    if (datEl) datEl.textContent = res.publishedAt;
    if (sizEl) sizEl.textContent = res.assetSizeMb ? res.assetSizeMb + ' МБ' : '—';

    ZU_STATE.latestTag  = res.latestTag;
    ZU_STATE.assetName  = res.assetName;

    zuProgress(100, 'Готово');

    if (res.needsUpdate) {
      zuLog('🆕 Доступно обновление! ' + res.currentVersion + ' → ' + res.latestTag, 'warn');
      zuShow('zu-update-card');
      var desc = document.getElementById('zu-update-desc');
      var clog = document.getElementById('zu-changelog');
      if (desc) desc.textContent = 'Текущая версия: ' + (res.currentVersion || '?') + '  →  Новая: ' + res.latestTag;
      if (clog && res.body) {
        // changelog — берём первые 20 строк
        clog.textContent = res.body.split('\n').slice(0, 20).join('\n');
        document.getElementById('zu-changelog-card').style.display = '';
      }
    } else {
      zuLog('✓ Zapret актуален', 'ok');
      zuShow('zu-ok-card');
    }
  } catch(e) {
    zuLog('✗ Ошибка: ' + e.message, 'err');
  }

  ZU_STATE.checking = false;
  if (btn) { btn.disabled = false; btn.textContent = '🔍 Проверить снова'; }
}

async function zapretDoUpdate() {
  if (ZU_STATE.updating) return;
  if (!ZU_STATE.latestTag) { showToast('Сначала проверь обновление', 'err'); return; }
  if (!confirm('Обновить Zapret до ' + ZU_STATE.latestTag + '?\n\nZapret будет остановлен на время обновления.')) return;

  ZU_STATE.updating = true;
  var btn = document.getElementById('zu-btn-update');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Обновляем...'; }

  // Останавливаем Zapret
  try { await apiBridge.zapretStop(); } catch(e) {}

  zuShow('zu-status-card');
  var logBox = document.getElementById('zu-log');
  if (logBox) logBox.textContent = '';
  zuProgress(5, 'Начинаем обновление...');
  zuLog('■ Zapret остановлен', 'info');

  // Слушаем прогресс скачивания
  if (ZU_PROGRESS_OFF) { ZU_PROGRESS_OFF(); ZU_PROGRESS_OFF = null; }
  ZU_PROGRESS_OFF = apiBridge.onZapretProgress(function(d) {
    zuProgress(5 + Math.round(d.pct * 0.7), 'Скачиваем... ' + d.downloaded + ' / ' + d.total);
    zuLog('↓ ' + d.downloaded + ' МБ / ' + d.total + ' МБ (' + Math.round(d.pct) + '%)', 'info');
  });

  try {
    var res = await apiBridge.zapretDoUpdate({ tag: ZU_STATE.latestTag, assetName: ZU_STATE.assetName });
    if (ZU_PROGRESS_OFF) { ZU_PROGRESS_OFF(); ZU_PROGRESS_OFF = null; }

    if (!res.ok) {
      zuLog('✗ Ошибка: ' + res.msg, 'err');
      zuProgress(0, 'Ошибка');
      ZU_STATE.updating = false;
      if (btn) { btn.disabled = false; btn.textContent = '⬇ Попробовать снова'; }
      return;
    }

    zuProgress(100, 'Готово!');
    zuLog('✓ Zapret ' + ZU_STATE.latestTag + ' установлен!', 'ok');
    zuLog('  Файлы обновлены в папке Zapret\\', 'info');
    showToast('✅ Zapret обновлён до ' + ZU_STATE.latestTag + '!', 'ok');

    // Обновляем текущую версию
    var el = document.getElementById('zu-current');
    if (el) el.textContent = ZU_STATE.latestTag;

    document.getElementById('zu-update-card').style.display = 'none';
    document.getElementById('zu-ok-card').style.display = '';
  } catch(e) {
    zuLog('✗ Ошибка моста: ' + e.message, 'err');
    if (ZU_PROGRESS_OFF) { ZU_PROGRESS_OFF(); ZU_PROGRESS_OFF = null; }
  }

  ZU_STATE.updating = false;
  if (btn) { btn.disabled = false; btn.textContent = '⬇ Скачать и установить'; }
}

// =====================================================
//   MODAL SYSTEM
// =====================================================
// openModal принимает ТОЛЬКО статические шаблоны, собранные в этом файле.
// Данные пользователя/системы сюда передавать нельзя — для них afEl()/textContent.
var MODAL_FORBIDDEN = /<script|<iframe|<object|<embed|\son[a-z]+\s*=/i;

function openModal(html) {
  if (typeof html !== 'string' || MODAL_FORBIDDEN.test(html)) {
    afReportError('modal', 'заблокирован небезопасный шаблон модального окна');
    return;
  }
  document.getElementById('modal-box').innerHTML = html;   // af-allow-innerhtml: только статические шаблоны
  document.getElementById('modal-overlay').classList.add('is-open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('is-open');
  document.getElementById('modal-box').innerHTML = '';
}
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});

// ── INIT ──
async function initialLoad() {
  // Иконка приходит из main как data:URL — никаких file:// в рендерере
  try {
    var iconUrl = await apiBridge.getIconUrl();
    var img = document.getElementById('logo-img');
    if (img && iconUrl && /^data:image\//.test(iconUrl)) img.src = iconUrl;
  } catch(e) { afReportError('icon', e.message); }

  // Статус приложения из main (админ-права, живой Zapret, режим sandbox)
  apiBridge.onBootstrap(function(info) {
    if (!info) return;
    document.documentElement.setAttribute('data-platform', info.platform || 'unknown');
    if (info.zapretRunning) { zapretActive = true; syncZapretUI(); }
    if (!info.isAdmin) showAdminHint(info.platform);
  });

  await loadSettings();
  await loadBinds();
  await loadProfileMetas();
  goTab('home', document.querySelector('[data-tab="home"]'));
}

function showAdminHint(platform) {
  var el = document.getElementById('admin-hint');
  if (!el) return;
  el.style.display = '';
  el.textContent = platform === 'win32'
    ? '⚠ Приложение запущено без прав администратора: блокировка рекламы через hosts и правка DNS недоступны.'
    : '⚠ Правка системного hosts и DNS доступна только в сборке для Windows.';
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initialLoad();
} else {
  window.addEventListener('DOMContentLoaded', initialLoad);
}

// =====================================================
//   UI-ДЕЙСТВИЯ (замена inline on*="..." — их блокирует CSP)
//   Каждое действие — чистая функция без eval/строк.
// =====================================================

function winMin()    { apiBridge.winAct('minimize'); }
function winHide()   { apiBridge.winAct('hide'); }
function winMax()    { apiBridge.toggleMaximize(); }
function openFolder(which) { apiBridge.openFolder(which); }
function zapretService()   { apiBridge.zapretService(); }
function clearDiagLog()    { var l = document.getElementById('diag-log'); if (l) l.textContent = ''; }

async function closeBrowsers() {
  var r = await apiBridge.closeBrowsers();
  showToast(r && r.ok ? 'Браузеры закрыты' : 'Не удалось закрыть браузеры', r && r.ok ? 'ok' : 'err');
}

async function killWinws() {
  var r = await apiBridge.killWinws();
  showToast(r && r.ok ? 'winws.exe остановлен' : 'winws.exe не найден', r && r.ok ? 'err' : '');
}

/** Зеркалит значение input в подпись и вызывает указанный saver. */
function mirrorInput(labelId, saverName, asFloat) {
  var label = document.getElementById(labelId);
  var val = this.value;
  if (label) label.textContent = asFloat ? parseFloat(val).toFixed(1) : val;
  // saver получает значение: раньше вызов был без аргумента, и applyScale
  // строил scale(NaN) — масштабирование «не работало».
  var savers = { saveFx: saveFx, saveCbn: saveCbn, saveScale: applyScale, saveWin: saveWindowStyle };
  if (typeof savers[saverName] === 'function') savers[saverName](val);
}

function goTabAction(name) {
  // `this` — кнопка, на которую нажали (передаёт диспетчер)
  goTab(name, this);
}

AF_ACTIONS = {
  // окно
  winMin: winMin,
  winHide: winHide,
  winMax: winMax,
  closeModal: closeModal,

  // навигация / папки
  goTab: goTabAction,
  openFolder: openFolder,
  openTG: openTG,
  openUblockLink: openUblockLink,
  openUblockFolder: openUblockFolder,
  zapretService: zapretService,

  // процессы
  closeBrowsers: closeBrowsers,
  killWinws: killWinws,

  // zapret
  zapretStart: zapretStart,
  zapretStop: zapretStop,
  zapretCheckUpdate: zapretCheckUpdate,
  zapretDoUpdate: zapretDoUpdate,

  // браузеры / профили
  launchBrowser: launchBrowser,
  selectBrowser: selectBrowser,
  submitCreateProfile: submitCreateProfile,
  openProfileCountryModal: openProfileCountryModal,
  saveProfileCountryModal: saveProfileCountryModal,
  addBind: addBind,
  renderBinds: renderBinds,
  saveAutoBypass: saveAutoBypass,

  // конфигурация
  setUA: setUA,
  setRes: setRes,
  setSpoof: setSpoof,
  saveSpoofConfig: saveSpoofConfig,
  loadSpoofConfig: loadSpoofConfig,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  saveFpConfig: saveFpConfig,
  previewFingerprint: previewFingerprint,
  rerollFingerprint: rerollFingerprint,
  loadFpCountry: loadFpCountry,
  saveFpCountry: saveFpCountry,
  consoleRun: consoleRun,
  consoleClear: consoleClear,
  previewColors: previewColors,

  // внешний вид
  setTheme: setTheme,
  saveColors: saveColors,
  resetColors: resetColors,
  saveFx: saveFx,
  saveWindowStyle: saveWindowStyle,
  pickBgImage: pickBgImage,
  clearBgImage: clearBgImage,

  // adblock
  addPreset: addPreset,
  addHostsDomain: addHostsDomain,
  clearAllDomains: clearAllDomains,
  applyHosts: applyHosts,
  loadHostsDomains: loadHostsDomains,
  installUblock: installUblock,

  // чебурнет
  cheburnetCheck: cheburnetCheck,
  cheburnetRunTests: cheburnetRunTests,
  cheburnetFullCheck: cheburnetFullCheck,
  cheburnetEmergency: cheburnetEmergency,
  cheburnetApplyDns: cheburnetApplyDns,
  cheburnetResetDns: cheburnetResetDns,
  cbnFixWarp: cbnFixWarp,
  cbnTestWarp: cbnTestWarp,
  saveCbn: saveCbn,

  // логи / диагностика
  renderLogs: renderLogs,
  clearLogs: clearLogs,
  diagCheck: diagCheck,
  diagInstallAll: diagInstallAll,
  clearDiagLog: clearDiagLog,

  // прочее
  mirrorInput: mirrorInput,
};
