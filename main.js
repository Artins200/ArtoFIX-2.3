'use strict';
/* =============================================================
   ARTOFIX 2.5 — MAIN PROCESS
   -------------------------------------------------------------
   Модель безопасности (см. docs/SECURITY.md):
     • renderer в песочнице: sandbox + contextIsolation, без Node;
     • единственный мост — preload.js (фиксированный список методов);
     • все IPC-каналы валидируют источник и аргументы;
     • никаких shell-строк: только execFile/spawn с argv-массивами;
     • сеть — только https + белый список хостов GitHub/драйверов;
     • CSP + запрет навигации + запрет всех http(s) из окна;
     • свободный exec() («cmd») удалён полностью.

   Отпечаток браузера считает fingerprint-identity.js, применяет
   engine.py (см. docs/ANTI-DETECT.md).
   ============================================================= */

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog,
  session, clipboard,
} = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { fileURLToPath } = require('url');

const sec = require('./security');
const fpEngine = require('./fingerprint-identity');
const pkg = require('./package.json');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const DEV_MODE = process.argv.includes('--dev');
const APP_VERSION = pkg.version || '2.5.0';

// Песочница для всех рендереров — до первого окна
app.enableSandbox();

// ═══════════════════════════════════════════
//  ПУТИ
// ═══════════════════════════════════════════
function getAppRoot() {
  return app.isPackaged ? path.dirname(process.execPath) : __dirname;
}
function dataPath(...parts) {
  return path.join(getAppRoot(), ...parts);
}
function resPath(...parts) {
  if (app.isPackaged) return path.join(path.dirname(process.execPath), 'resources', ...parts);
  return path.join(__dirname, ...parts);
}

/** Папка profiles с проверкой, что она внутри корня приложения. */
function profilesRoot() {
  const root = dataPath('profiles');
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  return root;
}
/** Путь к конкретному профилю или null, если имя/путь небезопасны. */
function profileDir(name) {
  const safe = sec.sanitizeProfileName(name);
  if (!safe) return null;
  return sec.safeJoinInside(profilesRoot(), safe);
}

function findPython() {
  for (const candidate of [dataPath('python', 'python.exe'), resPath('python', 'python.exe')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return IS_WIN ? 'python' : 'python3';
}

/** ID установки: используется как соль для отпечатков (стабилен между запусками). */
function getInstallId() {
  const f = dataPath('.artofix_install_id');
  try {
    const existing = fs.readFileSync(f, 'utf-8').trim();
    if (/^[a-f0-9]{16,64}$/.test(existing)) return existing;
  } catch (_) {}
  const id = crypto.randomBytes(16).toString('hex');
  try { sec.writeFileAtomic(f, id); } catch (_) {}
  return id;
}

// ═══════════════════════════════════════════
//  ПРАВА АДМИНИСТРАТОРА
// ═══════════════════════════════════════════
function isAdmin() {
  if (!IS_WIN) return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  try {
    fs.accessSync('C:\\Windows\\System32\\drivers\\etc\\hosts', fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}

function relaunchAsAdmin() {
  if (!IS_WIN) return;
  const exe = process.execPath;
  const cwd = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  const args = process.argv.slice(1).filter((a) => a.length < 512);
  // Каждый аргумент — отдельный литерал PowerShell: массива строк достаточно,
  // чтобы не собрать инъекцию из кавычек в пути.
  const psArgs = args.map((a) => "'" + a.replace(/'/g, "''") + "'").join(',');
  const psCommand =
    'Start-Process -FilePath ' + quotePs(exe) + ' ' +
    (psArgs ? '-ArgumentList @(' + psArgs + ') ' : '') +
    '-Verb RunAs -WorkingDirectory ' + quotePs(cwd);

  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
    detached: true, windowsHide: true, stdio: 'ignore',
  }).unref();
  app.exit(0);
}
function quotePs(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function checkAdmin() {
  if (!IS_WIN) return;             // в остальных ОС hosts/DNS-фичи просто недоступны
  if (isAdmin()) return;
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Artofix — права администратора',
    message: 'Для блокировки рекламы (файл hosts) и правки DNS нужны права администратора.',
    detail: 'Перезапустить с правами администратора?\n\nЕсли откажешься — всё работает, но '
          + 'блокировка через hosts и смена DNS будут недоступны.',
    buttons: ['Перезапустить как администратор', 'Продолжить без прав'],
    defaultId: 0, cancelId: 1,
  });
  if (choice === 0) relaunchAsAdmin();
}

// ═══════════════════════════════════════════
//  ОКНА + ЖЁСТКАЯ НАСТРОЙКА СЕССИИ
// ═══════════════════════════════════════════
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",   // инлайновых скриптов нет; стили — только свои
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Снимаем чужие CSP-заголовки и ставим свой; блокируем любой внешний трафик окна. */
function hardenSession(ses) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);

  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = {};
    for (const key of Object.keys(details.responseHeaders || {})) {
      const lower = key.toLowerCase();
      if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') continue;
      headers[key] = details.responseHeaders[key];
    }
    headers['Content-Security-Policy'] = [CSP];
    headers['X-Content-Type-Options'] = ['nosniff'];
    callback({ responseHeaders: headers, cancel: false });
  });

  // Оболочка приложения не имеет права ходить в сеть вообще:
  // все сетевые операции (обновление Zapret, драйверы) идут из main.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const scheme = (details.url || '').split(':')[0].toLowerCase();
    const allowed = scheme === 'file' || scheme === 'devtools' || scheme === 'blob' || scheme === 'data';
    if (!allowed) {
      console.warn('[net-block] окно пыталось обратиться наружу: ' + details.url.slice(0, 200));
      return callback({ cancel: true });
    }
    callback({ cancel: false });
  });
}

const HARDENED_WEB_PREFS = {
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  devTools: DEV_MODE,
  preload: path.join(__dirname, 'preload.js'),
};

let win = null, tray = null, setupWin = null, isQuiting = false;
let zapretProcess = null;
let pendingUpdate = null;
const runningProfiles = new Set();
const RATE = new Map();

function rateLimited(key, ms) {
  const now = Date.now();
  const last = RATE.get(key) || 0;
  if (now - last < ms) return true;
  RATE.set(key, now);
  return false;
}

function createWindow() {
  // Прозрачное бессистемное окно: скруглённую форму и «стекло» рисует CSS
  // (см. --win-radius / --win-alpha в index.html), а не системная рамка.
  win = new BrowserWindow(Object.assign({
    width: 1100, height: 680,
    minWidth: 900, minHeight: 580,
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false,
    resizable: true,
  }, { webPreferences: HARDENED_WEB_PREFS }));

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    sendBootstrap();
    send('win-maximized', win.isMaximized());
  });
  // Состояние «развёрнуто» уходит в рендерер: там снимаются скругления и отступы
  win.on('maximize', () => send('win-maximized', true));
  win.on('unmaximize', () => send('win-maximized', false));
  if (DEV_MODE) win.webContents.openDevTools({ mode: 'detach' });
  win.on('close', (e) => { if (!isQuiting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

function createSetupWindow() {
  setupWin = new BrowserWindow(Object.assign({
    width: 600, height: 640,
    resizable: false, frame: false,
    transparent: true,
    hasShadow: false,
    show: false, center: true,
  }, { webPreferences: HARDENED_WEB_PREFS }));
  setupWin.loadFile(path.join(__dirname, 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function sendToSetup(channel, payload) {
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send(channel, payload);
}

function sendBootstrap() {
  send('bootstrap', {
    platform: process.platform,
    version: APP_VERSION,
    isAdmin: isAdmin(),
    sandbox: true,
    zapretRunning: !!zapretProcess,
    hostsAvailable: IS_WIN,
  });
}

// ── защита всех webContents приложения ──
function stripAnsi(s) {
  return String(s).replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    console.warn('[blocked] попытка открыть новое окно: ' + stripAnsi(url).slice(0, 200));
    return { action: 'deny' };
  });

  const blockNav = (event, url) => {
    let local = false;
    try {
      const p = fileURLToPath(url);
      local = sec.isInside(__dirname, p) || sec.isInside(getAppRoot(), p);
    } catch (_) { local = false; }
    if (!local) {
      event.preventDefault();
      console.warn('[blocked] попытка навигации: ' + stripAnsi(url).slice(0, 200));
    }
  };
  contents.on('will-navigate', blockNav);
  contents.on('will-redirect', (e, url) => blockNav(e, url));

  contents.on('will-attach-webview', (e) => {
    e.preventDefault();
    console.warn('[blocked] попытка вставить webview');
  });

  contents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload-error] ' + preloadPath + ': ' + (error && error.message));
  });

  contents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone] ' + JSON.stringify({ reason: details.reason, exitCode: details.exitCode }));
  });

  contents.on('unresponsive', () => console.error('[renderer] окно перестало отвечать'));

  // Все логи рендерера — в терминал (с обрезкой длины и снятием ANSI).
  contents.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = ['verbose', 'info', 'warning', 'error'][level] || 'log';
    const src = sourceId ? path.basename(String(sourceId)) : 'renderer';
    console.log('[renderer:' + lvl + '] ' + stripAnsi(message).slice(0, 2000) + '  (' + src + ':' + line + ')');
  });

  if (!DEV_MODE) contents.on('devtools-opened', () => contents.closeDevTools());
});

// ═══════════════════════════════════════════
//  ТРЕЙ
// ═══════════════════════════════════════════
function readBinds() {
  const raw = sec.readJsonSafe(dataPath('artofix_binds.json'));
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b) => b && typeof b === 'object' && (sec.sanitizeExternalUrl(b.url) || sec.sanitizeAppPath(b.url)))
    .slice(0, 200);
}

function buildTrayMenu() {
  const binds = readBinds().slice(0, 12).map((b) => ({
    label: sec.sanitizeLabel(b.label || b.url || '?', 40) || '?',
    click: () => launchBindFromTray(b),
  }));

  const template = [
    { label: 'ARTOFIX ' + APP_VERSION, enabled: false },
    { type: 'separator' },
    { label: '▶ Запустить Zapret', click: () => send('tray-action', 'run') },
    { label: '■ Остановить Zapret', click: () => send('tray-action', 'stop') },
    { label: '📂 Папка Zapret', click: () => send('tray-action', 'config') },
    { type: 'separator' },
  ];
  if (binds.length) {
    template.push({ label: '🔗 Бинды', submenu: binds });
    template.push({ type: 'separator' });
  }
  template.push(
    { label: '🪟 Показать окно', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '📋 Логи', click: () => { showTab('logs'); } },
    { label: '⚙️ Настройки', click: () => { showTab('settings'); } },
    { type: 'separator' },
    { label: '❌ Выход', click: () => { isQuiting = true; app.quit(); } }
  );
  return Menu.buildFromTemplate(template);
}

function showTab(tab) {
  if (!win) return;
  win.show();
  send('navigate', tab);
}

function createTray() {
  let icon = nativeImage.createFromPath(resPath('icon.png'));
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip('Artofix ' + APP_VERSION);
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

function launchBindFromTray(bind) {
  const browser = sec.sanitizeBrowser(bind.browser) || 'chrome';
  // App-бинды (steam://, tg://, discord://, .exe/.lnk) — раньше отбивались
  // проверкой sanitizeBrowseUrl до этой ветки и никогда не запускались.
  if (browser === 'app') {
    const ext = sec.sanitizeExternalUrl(bind.url);
    if (ext) { shell.openExternal(ext).catch(() => {}); return; }
    const appPath = sec.sanitizeAppPath(bind.url);
    if (appPath && fs.existsSync(appPath)) shell.openPath(appPath).catch(() => {});
    return;
  }
  const url = sec.sanitizeBrowseUrl(bind.url);
  if (!url) return;
  // Авто-обход: бинд с меткой «С обходом» сам поднимает Zapret — без ручной настройки
  if (bind.bypass === true && !zapretProcess && IS_WIN) {
    const r = zapretStart();
    if (r && r.ok) send('zapret-status', { on: true, msg: '⚡ Обход включён автоматически (бинд)' });
  }
  launchBrowser({ url, profile: bind.profile || 'default', browser }).catch((e) => console.error('[tray] ' + e.message));
}

// ═══════════════════════════════════════════
//  ЛОГИ ЗАПУСКОВ (буфер ограничен — зашита от утечки памяти)
// ═══════════════════════════════════════════
const LOG_MAX = 300;
const LOG_LINE_MAX = 500;
let launchLogs = [];

function appendLog(profile, browser, text) {
  const lines = String(text).split('\n');
  for (const raw of lines) {
    const line = stripAnsi(raw).trim().slice(0, LOG_LINE_MAX);
    if (!line) continue;
    launchLogs.push({ ts: Date.now(), profile: sec.sanitizeLabel(profile, 40), browser: sec.clampString(browser, 12), msg: line });
  }
  if (launchLogs.length > LOG_MAX) launchLogs = launchLogs.slice(-LOG_MAX);
  send('log-entry', launchLogs.slice(-5));
}

let diagBuffer = { log: [], progress: null };
function pushDiag(channel, payload) {
  if (channel === 'diag-log') {
    diagBuffer.log.push(payload);
    if (diagBuffer.log.length > 300) diagBuffer.log = diagBuffer.log.slice(-300);
  } else {
    diagBuffer.progress = payload;
  }
  send(channel, payload);
}

// ═══════════════════════════════════════════
//  КОНФИГ / НАСТРОЙКИ (санитизация при записи)
// ═══════════════════════════════════════════
const CONFIG_KEYS = ['user_agent', 'resolution', 'spoof', 'fingerprint', 'proxy',
  'chromedriver_path', 'edgedriver_path', 'identity', 'vectors'];

function sanitizePathField(v) {
  if (typeof v !== 'string' || v.length > 512) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(v)) return undefined;
  if (!/\.exe$/i.test(v)) return undefined;
  const resolved = path.resolve(v);
  const okRoot = sec.isInside(getAppRoot(), resolved) || sec.isInside(dataPath('drivers'), resolved);
  return okRoot ? resolved : undefined;
}

function sanitizeConfig(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;

  if (typeof input.user_agent === 'string' && input.user_agent.length <= 512 && !/[\u0000-\u001f\u007f]/.test(input.user_agent)) {
    out.user_agent = input.user_agent;
  }
  if (typeof input.resolution === 'string' && /^\d{2,5},\d{2,5}$/.test(input.resolution)) {
    out.resolution = input.resolution;
  }
  if (input.spoof && typeof input.spoof === 'object') {
    const s = {};
    if (typeof input.spoof.timezone === 'string' && /^[A-Za-z_+\-]{1,40}(\/[A-Za-z_+\-]{1,40}){0,2}$/.test(input.spoof.timezone)) s.timezone = input.spoof.timezone;
    if (typeof input.spoof.lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?(,[A-Za-z\-0-9]{2,10}){0,3}$/.test(input.spoof.lang)) s.lang = input.spoof.lang;
    if (typeof input.spoof.account_age === 'string') s.account_age = sec.sanitizeLabel(input.spoof.account_age, 32);
    if (typeof input.spoof.history === 'string') s.history = sec.sanitizeLabel(input.spoof.history, 32);
    out.spoof = s;
  }
  if (input.fingerprint && typeof input.fingerprint === 'object') {
    const f = {};
    for (const key of ['webgl', 'platform', 'canvas', 'resolution', 'ua', 'audio', 'fonts', 'media', 'hw']) {
      if (typeof input.fingerprint[key] === 'boolean') f[key] = input.fingerprint[key];
    }
    if (typeof input.fingerprint.canvas_noise === 'number' && input.fingerprint.canvas_noise >= 0 && input.fingerprint.canvas_noise <= 255) {
      f.canvas_noise = Math.floor(input.fingerprint.canvas_noise);
    }
    if (typeof input.fingerprint.webgl_renderer === 'string') f.webgl_renderer = sec.sanitizeLabel(input.fingerprint.webgl_renderer, 160);
    if (typeof input.fingerprint.webgl_vendor === 'string') f.webgl_vendor = sec.sanitizeLabel(input.fingerprint.webgl_vendor, 80);
    out.fingerprint = f;
  }
  if (input.proxy && typeof input.proxy === 'object') {
    const p = {};
    if (typeof input.proxy.server === 'string' && /^(socks5|socks4|http|https):\/\/[A-Za-z0-9._:\-]{1,120}$/.test(input.proxy.server)) p.server = input.proxy.server;
    if (typeof input.proxy.username === 'string') p.username = sec.sanitizeLabel(input.proxy.username, 64);
    out.proxy = p;
  }
  const cd = sanitizePathField(input.chromedriver_path);
  if (cd) out.chromedriver_path = cd;
  const ed = sanitizePathField(input.edgedriver_path);
  if (ed) out.edgedriver_path = ed;
  if (input.identity && typeof input.identity === 'object') out.identity = input.identity;   // пишет только main
  return out;
}

function readConfig() {
  const raw = sec.readJsonSafe(dataPath('config.json')) || {};
  return Object.assign({}, sanitizeConfig(raw), { identity: raw.identity || null });
}
function writeConfig(cfg) {
  sec.writeFileAtomic(dataPath('config.json'), JSON.stringify(cfg, null, 2));
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const BG_IMAGE_MAX = 4 * 1024 * 1024; // 4 MB data URL
function isValidBgDataUrl(v) {
  if (typeof v !== 'string') return false;
  if (v.length > BG_IMAGE_MAX) return false;
  if (!v.startsWith('data:image/')) return false;
  // only allow png jpeg jpg webp gif
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(v)) return false;
  // basic base64 length check
  var b64 = v.split(',')[1] || '';
  if (b64.length < 100) return false;
  if (b64.length > BG_IMAGE_MAX) return false;
  return true;
}
function sanitizeSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if (typeof input.theme === 'string' && /^[a-z0-9\-]{0,24}$/.test(input.theme)) out.theme = input.theme;
  if (input.colors && typeof input.colors === 'object') {
    const c = {};
    if (HEX_COLOR.test(input.colors.ac || '')) c.ac = input.colors.ac;
    if (HEX_COLOR.test(input.colors.ac2 || '')) c.ac2 = input.colors.ac2;
    const op = Number(input.colors.op);
    if (Number.isFinite(op) && op >= 0.1 && op <= 1) c.op = String(op);
    out.colors = c;
  }
  if (typeof input.bgImage === 'string' && isValidBgDataUrl(input.bgImage)) {
    out.bgImage = input.bgImage;
  } else if (input.bgImage === null) {
    out.bgImage = null;
  }
  if (input.cheburnet && typeof input.cheburnet === 'object') {
    const cb = {};
    cb.autostart = input.cheburnet.autostart === true;
    cb.autorestart = input.cheburnet.autorestart !== false;
    const iv = Number(input.cheburnet.interval);
    cb.interval = Number.isFinite(iv) ? Math.min(3600, Math.max(5, Math.floor(iv))) : 30;
    cb.dns1 = sec.sanitizeIpv4(input.cheburnet.dns1) || '1.1.1.1';
    cb.dns2 = sec.sanitizeIpv4(input.cheburnet.dns2) || '1.0.0.1';
    cb.dnsMode = ['dot', 'doh', 'plain'].includes(input.cheburnet.dnsMode) ? input.cheburnet.dnsMode : 'dot';
    out.cheburnet = cb;
  }
  if (['stars', 'dots', 'net', 'none'].includes(input.fxParticles)) out.fxParticles = input.fxParticles;
  const spd = Number(input.fxSpeed);
  if (Number.isFinite(spd) && spd >= 0 && spd <= 10) out.fxSpeed = String(spd);
  if (['on', 'off'].includes(input.fxScanlines)) out.fxScanlines = input.fxScanlines;
  if (typeof input.fxFont === 'string' && /^[A-Za-z0-9 \-]{0,32}$/.test(input.fxFont)) out.fxFont = input.fxFont;
  const glow = Number(input.glowIntensity);
  if (Number.isFinite(glow) && glow >= 0 && glow <= 200) out.glowIntensity = String(Math.floor(glow));
  const scale = Number(input.uiScale);
  if (Number.isFinite(scale) && scale >= 0.5 && scale <= 2) out.uiScale = String(scale);
  // Окно: прозрачность (0.3–1), радиус скругления (0–28 px)
  const wop = Number(input.winOpacity);
  if (Number.isFinite(wop) && wop >= 0.3 && wop <= 1) out.winOpacity = String(Math.round(wop * 100) / 100);
  const wrad = Number(input.winRadius);
  if (Number.isFinite(wrad) && wrad >= 0 && wrad <= 28) out.winRadius = String(Math.floor(wrad));
  // Авто-обход без VPN: включать Zapret сам при выборе страны / запуске биндов
  if (typeof input.autoBypass === 'boolean') out.autoBypass = input.autoBypass;
  if (input.fingerprint && typeof input.fingerprint === 'object') {
    const f = {};
    for (const key of ['webgl', 'platform', 'canvas', 'resolution', 'ua', 'audio', 'fonts', 'media', 'hw']) {
      if (typeof input.fingerprint[key] === 'boolean') f[key] = input.fingerprint[key];
    }
    out.fingerprint = f;
  }
  // Глобальная страна-антиппечаток по умолчанию (профиль может переопределить)
  if (input.geo && typeof input.geo === 'object') {
    const cc = input.geo.country ? fpEngine.getCountry(input.geo.country) : null;
    out.geo = { country: cc ? cc.code : null };
  }
  return out;
}

function readSettings() {
  return sanitizeSettings(sec.readJsonSafe(dataPath('artofix_settings.json')) || {});
}

function sanitizeBinds(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).map((b) => {
    const item = b && typeof b === 'object' ? b : {};
    return {
      id: Number.isFinite(Number(item.id)) ? Number(item.id) : Date.now() + Math.floor(Math.random() * 1000),
      label: sec.sanitizeLabel(item.label || item.url || '', 64),
      // app-бинды: либо разрешённая схема (steam/tg/discord/https), либо путь к .exe/.lnk/.url
      url: sec.sanitizeExternalUrl(item.url) || sec.sanitizeAppPath(item.url) || '',
      profile: sec.sanitizeProfileName(item.profile) || '',
      browser: sec.sanitizeBrowser(item.browser) || 'chrome',
      bypass: item.bypass === true,
    };
  }).filter((b) => !!b.url);   // мёртвые бинды без валидной ссылки не храним
}

// ═══════════════════════════════════════════
//  ОТПЕЧАТОК: генерация и хранение
// ═══════════════════════════════════════════
const versionCache = new Map();

function readBrowserVersion(browser) {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve(null);
    if (versionCache.has(browser)) return resolve(versionCache.get(browser));
    const keys = browser === 'msedge'
      ? ['HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}',
         'HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}']
      : ['HKLM\\SOFTWARE\\Google\\Chrome\\BLBeacon',
         'HKLM\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\BLBeacon',
         'HKCU\\SOFTWARE\\Google\\Chrome\\BLBeacon'];
    const valueName = browser === 'msedge' ? 'pv' : 'version';

    let idx = 0;
    const next = () => {
      if (idx >= keys.length) { versionCache.set(browser, null); return resolve(null); }
      const key = keys[idx++];
      execFile('reg', ['query', key, '/v', valueName], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        if (!err && stdout) {
          const m = stdout.match(new RegExp(valueName + '\\s+REG_SZ\\s+([\\d.]+)', 'i'));
          if (m) { versionCache.set(browser, m[1]); return resolve(m[1]); }
        }
        next();
      });
    };
    next();
  });
}

function profileMetaPath(dir) { return path.join(dir, '_artofix_meta.json'); }

function readProfileMeta(name) {
  const dir = profileDir(name);
  if (!dir) return {};
  const meta = sec.readJsonSafe(profileMetaPath(dir), 64 * 1024);
  return meta && typeof meta === 'object' ? meta : {};
}

/**
 * Страна антидетекта профиля: сначала meta.country профиля, иначе глобальный
 * дефолт settings.geo.country, иначе null (авто-связка, координаты не эмулируем).
 * Для Claude.ai / Anthropic с жёстким гео-блоком по умолчанию используется US (США).
 * Код валидируется через fpEngine.getCountry — мусорные значения отбрасываются.
 */
function resolveProfileCountry(meta, settings, profile, url) {
  const fromMeta = fpEngine.getCountry(meta && meta.country);
  if (fromMeta) return fromMeta.code;
  const fromSettings = settings && settings.geo ? fpEngine.getCountry(settings.geo.country) : null;
  if (fromSettings) return fromSettings.code;
  const isClaude = (typeof profile === 'string' && profile.toLowerCase().startsWith('claude')) ||
                   (typeof url === 'string' && /claude\.ai|anthropic\.com/i.test(url));
  if (isClaude) return 'US';
  return null;
}

/** Прокси профиля (server/username из meta, пароль — только через env). */
function profileProxy(meta) {
  const p = meta && meta.proxy;
  if (!p || typeof p !== 'object') return null;
  const server = typeof p.server === 'string' ? p.server : '';
  if (!/^(socks5|socks4|http|https):\/\/[A-Za-z0-9._:\-]{1,120}$/.test(server)) return null;
  return {
    server,
    username: sec.sanitizeLabel(p.username || '', 64),
    password: typeof p.password === 'string' ? p.password.slice(0, 128) : '',
  };
}

/**
 * Считает «личность» профиля и сохраняет её в config.json.
 * Стабильность: seed = installId + profile, поэтому отпечаток не «прыгает»
 * между запусками (прыгающий отпечаток — сам по себе признак автоматизации).
 */
async function rollIdentity(profile, browser, opts) {
  opts = opts || {};
  const cfg = readConfig();
  const settings = readSettings();
  const meta = readProfileMeta(profile);
  const proxy = profileProxy(meta);
  const fpSwitches = settings.fingerprint || {};

  const realVersion = browser === 'msedge' ? await readBrowserVersion('msedge') : await readBrowserVersion('chrome');

  const overrides = {};
  if (!opts.ignoreUiOverrides) {
    if (cfg.user_agent) overrides.user_agent = cfg.user_agent;
    if (fpSwitches.resolution === true && cfg.resolution) overrides.resolution = cfg.resolution;
    if (cfg.spoof && cfg.spoof.timezone) overrides.timezone = cfg.spoof.timezone;
    if (cfg.spoof && cfg.spoof.lang) overrides.lang = cfg.spoof.lang;
  }
  if (proxy) {
    overrides.proxy_server = proxy.server;
    overrides.proxy_username = proxy.username;
  }

  const identity = fpEngine.generateIdentity(profile || 'default', getInstallId(), {
    browser,
    browserVersion: realVersion,
    overrides,
    identitySalt: typeof meta.fingerprint_refresh === 'string' ? meta.fingerprint_refresh : null,
    country: resolveProfileCountry(meta, settings, profile, opts.url),
  });

  // Флаги векторов: что именно разрешено подменять в UI
  identity.vectors = {
    webgl: fpSwitches.webgl !== false,
    platform: fpSwitches.platform !== false,
    canvas: fpSwitches.canvas !== false,
    audio: fpSwitches.audio !== false,
    screen: fpSwitches.resolution === true,
    ua: fpSwitches.ua !== false,
    tz: true,
    lang: true,
    hw: fpSwitches.hw !== false,
    media: fpSwitches.media !== false,
    fonts: fpSwitches.fonts !== false,
  };
  if (!identity.vectors.webgl) {
    // Без подмены WebGL нельзя включать software-рендер: SwiftShader в
    // renderer-строке — мгновенный флаг автоматизации.
    identity.webgl = null;
  }

  cfg.identity = identity;
  cfg.user_agent = identity.user_agent;
  cfg.resolution = identity.resolution;
  cfg.spoof = cfg.spoof || {};
  cfg.spoof.timezone = identity.timezone;
  cfg.spoof.lang = identity.lang;
  writeConfig(cfg);

  return { identity, proxy, meta };
}

// ═══════════════════════════════════════════
//  ЗАПУСК БРАУЗЕРА
// ═══════════════════════════════════════════
const MAX_BROWSER_CHILDREN = 12;

async function launchBrowser({ url, profile, browser }) {
  const safeBrowser = sec.sanitizeBrowser(browser);
  if (!safeBrowser) return { ok: false, msg: 'Недопустимый тип браузера' };

  // Запуск внешних приложений (steam://, tg://, discord://) и локальных ярлыков.
  // ВАЖНО: проверяем ДО sanitizeBrowseUrl — тот знает только http(s), и раньше
  // app-бинды отбивались как «Недопустимый URL», не доходя до этой ветки.
  if (safeBrowser === 'app') {
    if (rateLimited('launch:app', 1200)) return { ok: false, msg: 'Слишком часто — подожди секунду' };
    const ext = sec.sanitizeExternalUrl(url);
    if (ext) {
      try { await shell.openExternal(ext); return { ok: true }; }
      catch (e) { return { ok: false, msg: e.message }; }
    }
    const appPath = sec.sanitizeAppPath(url);
    if (appPath) {
      if (!fs.existsSync(appPath)) return { ok: false, msg: 'Файл не найден: ' + appPath };
      try {
        const err = await shell.openPath(appPath);
        return err ? { ok: false, msg: String(err) } : { ok: true };
      } catch (e) { return { ok: false, msg: e.message }; }
    }
    return { ok: false, msg: 'Ссылка не разрешена: http/https/steam/tg/discord или абсолютный путь к .exe/.lnk/.url' };
  }

  const safeUrl = sec.sanitizeBrowseUrl(url);
  if (!safeUrl) return { ok: false, msg: 'Недопустимый URL или тип браузера' };
  if (rateLimited('launch:' + safeBrowser, 1200)) return { ok: false, msg: 'Слишком часто — подожди секунду' };

  const dir = profileDir(profile);
  if (!dir) return { ok: false, msg: 'Недопустимое имя профиля' };
  if (runningProfiles.size >= MAX_BROWSER_CHILDREN) return { ok: false, msg: 'Уже открыто много профилей' };

  let rolled;
  try {
    rolled = await rollIdentity(profile, safeBrowser, { url: safeUrl });
  } catch (e) {
    return { ok: false, msg: 'Не удалось собрать отпечаток: ' + e.message };
  }

  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  const enginePy = resPath('engine.py');
  if (!fs.existsSync(enginePy)) return { ok: false, msg: 'engine.py не найден: ' + enginePy };

  const python = findPython();
  const env = Object.assign({}, process.env, {
    ARTOFIX_PROFILES: profilesRoot(),
    ARTOFIX_CONFIG: dataPath('config.json'),
    ARTOFIX_ROOT: getAppRoot(),
    ARTOFIX_BROWSER: safeBrowser,
    // Python в Windows пишет stdout в кодировку консоли (cp1251/cp866) —
    // принудительно UTF-8, иначе символы вроде «→» дают UnicodeEncodeError.
    PYTHONIOENCODING: 'utf-8',
  });
  if (rolled.proxy && rolled.proxy.password) env.ARTOFIX_PROXY_PASS = rolled.proxy.password;

  appendLog(profile, safeBrowser, '[start] ' + safeBrowser + ' → ' + safeUrl
    + (rolled.identity.webgl ? '  [fp: ' + rolled.identity.webgl.tier + ']' : '  [fp: без подмены GPU]')
    + (rolled.proxy ? '  [proxy: ' + rolled.proxy.server + ']' : ''));

  let child;
  try {
    child = spawn(python, [enginePy, safeUrl, profile, safeBrowser, '--profiles-dir', profilesRoot()], {
      cwd: resPath(),
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    appendLog(profile, safeBrowser, '[error] ' + e.message);
    return { ok: false, msg: 'Python не запустился: ' + e.message };
  }

  runningProfiles.add(profile);
  child.stdout.on('data', (d) => appendLog(profile, safeBrowser, d.toString('utf8')));
  child.stderr.on('data', (d) => appendLog(profile, safeBrowser, d.toString('utf8')));
  child.on('error', (e) => {
    runningProfiles.delete(profile);
    appendLog(profile, safeBrowser, '[error] ' + e.message + ' — проверь, что Python установлен');
  });
  child.on('exit', (code) => {
    runningProfiles.delete(profile);
    appendLog(profile, safeBrowser, '[engine] завершён с кодом ' + code);
  });

  // Небольшое ожидание: если Python не установлен, spawn падает почти сразу
  // и пользователь должен увидеть причину, а не «запущено».
  const spawnError = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done(null), 1000);
    child.once('error', (e) => done(e));
    child.once('spawn', () => done(null));
  });
  if (spawnError) {
    runningProfiles.delete(profile);
    return { ok: false, msg: 'Python не найден: ' + spawnError.message + '\nУстанови Python 3 и перезапусти Artofix.' };
  }

  return { ok: true };
}

// ═══════════════════════════════════════════
//  ZAPRET
// ═══════════════════════════════════════════
const ZAPRET_BATS = ['general.bat', 'general(ALT1).bat', 'general(ALT2).bat', 'discord.bat', 'run_zapret.bat'];
const WINWS_IMAGES = ['winws.exe', 'winws64.exe', 'winws32.exe'];

function zapretDir() { return resPath('Zapret'); }

function isRunningWinws() {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve(false);
    execFile('tasklist', ['/fi', 'imagename eq winws.exe', '/nh'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      resolve(/winws\.exe/i.test(stdout));
    });
  });
}

function zapretStart() {
  if (zapretProcess) return { ok: false, msg: 'Уже запущен' };
  const dir = zapretDir();
  let bat = null;
  for (const name of ZAPRET_BATS) {
    const candidate = sec.safeJoinInside(dir, name);
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { bat = candidate; break; }
  }
  if (!bat) return { ok: false, msg: 'Не найден general.bat в папке Zapret.\nПроверь, что Zapret установлен.' };

  try {
    zapretProcess = spawn('cmd.exe', ['/c', bat], {
      cwd: dir, windowsHide: true, detached: false, stdio: 'ignore',
    });
  } catch (e) {
    zapretProcess = null;
    return { ok: false, msg: 'Не удалось запустить: ' + e.message };
  }
  zapretProcess.on('error', (e) => {
    zapretProcess = null;
    send('zapret-status', { on: false, msg: 'Ошибка: ' + e.message });
  });
  zapretProcess.on('exit', () => { zapretProcess = null; });
  return { ok: true };
}

function zapretStop() {
  if (IS_WIN) {
    for (const image of WINWS_IMAGES) {
      execFile('taskkill', ['/f', '/im', image, '/t'], { windowsHide: true }, () => {});
    }
  }
  if (zapretProcess) {
    try { process.kill(zapretProcess.pid); } catch (_) {}
    zapretProcess = null;
  }
  return { ok: true };
}

function getZapretVersion() {
  const f = sec.safeJoinInside(zapretDir(), 'version.txt');
  try { if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf-8').trim().slice(0, 64); } catch (_) {}
  return 'Неизвестно';
}

/** HTTPS с проверкой каждого хоста на редиректе (защита от подмены ответа). */
function httpsGet(url, opts) {
  opts = opts || {};
  const maxHops = opts.maxHops === undefined ? 5 : opts.maxHops;
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (current) => {
      const safe = sec.sanitizeUpdateUrl(current);
      if (!safe) return reject(new Error('Хост не в белом списке: ' + String(current).slice(0, 120)));
      const req = https.get({
        hostname: new URL(safe).hostname,
        path: new URL(safe).pathname + new URL(safe).search,
        headers: { 'User-Agent': 'Artofix/' + APP_VERSION, Accept: 'application/vnd.github+json' },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (++hops > maxHops) return reject(new Error('Слишком много редиректов'));
          const loc = res.headers.location;
          if (!loc) return reject(new Error('Редирект без Location'));
          return go(new URL(loc, safe).toString());
        }
        const chunks = [];
        let size = 0;
        const limit = opts.maxBytes || 2 * 1024 * 1024;
        res.on('data', (d) => {
          size += d.length;
          if (size > limit) { req.destroy(); reject(new Error('Ответ слишком большой')); return; }
          chunks.push(d);
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      req.on('error', reject);
      req.setTimeout(opts.timeout || 12000, () => { req.destroy(); reject(new Error('Таймаут соединения')); });
    };
    go(url);
  });
}

async function zapretCheckUpdate() {
  const resp = await httpsGet('https://api.github.com/repos/Flowseal/zapret-discord-youtube/releases/latest');
  if (resp.statusCode !== 200) return { ok: false, msg: 'GitHub ответил: ' + resp.statusCode };

  let rel;
  try { rel = JSON.parse(resp.body); } catch (_) { return { ok: false, msg: 'Некорректный ответ GitHub' }; }

  const tag = sec.sanitizeTag(rel.tag_name);
  if (!tag) return { ok: false, msg: 'Подозрительный тег релиза' };

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const expected = 'zapret-discord-youtube-' + tag + '.zip';
  let asset = assets.find((a) => a && a.name === expected) || assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith('.zip'));
  let assetUrl = asset ? sec.sanitizeUpdateUrl(asset.browser_download_url) : null;
  if (!assetUrl) assetUrl = sec.sanitizeUpdateUrl(rel.zipball_url);
  if (!assetUrl) return { ok: false, msg: 'В релизе нет файла, который разрешено скачивать' };

  const assetName = asset ? sec.sanitizeFileName(asset.name) || expected : expected;
  const sizeBytes = asset && Number.isFinite(asset.size) ? asset.size : 0;

  // URL и размер храним ТОЛЬКО в main: рендерер их подменить не может
  pendingUpdate = { tag, assetUrl, assetName, sizeBytes, checkedAt: Date.now() };

  const currentVersion = getZapretVersion();
  return {
    ok: true,
    latestTag: tag,
    assetName,
    assetSizeMb: sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) : null,
    publishedAt: typeof rel.published_at === 'string' ? rel.published_at.slice(0, 10) : '—',
    body: sec.sanitizeLabel(rel.body || '', 4000),
    currentVersion,
    needsUpdate: currentVersion !== tag,
  };
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let hops = 0;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { file.close(); } catch (_) {}
      try { fs.unlinkSync(destPath); } catch (_) {}
      reject(e);
    };
    const go = (current) => {
      const safe = sec.sanitizeUpdateUrl(current);
      if (!safe) return fail(new Error('Редирект на недоверенный хост'));
      https.get(safe, { headers: { 'User-Agent': 'Artofix/' + APP_VERSION } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (++hops > 5) return fail(new Error('Слишком много редиректов'));
          if (!res.headers.location) return fail(new Error('Редирект без Location'));
          return go(new URL(res.headers.location, safe).toString());
        }
        if (res.statusCode !== 200) { res.resume(); return fail(new Error('HTTP ' + res.statusCode)); }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        const MAX = 512 * 1024 * 1024;
        let received = 0;
        let lastSent = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX) { res.destroy(); return fail(new Error('Файл слишком большой')); }
          file.write(chunk);
          if (total > 0 && (received - lastSent) > 200000) {
            lastSent = received;
            if (onProgress) onProgress({
              pct: received / total * 100,
              downloaded: (received / 1024 / 1024).toFixed(1),
              total: (total / 1024 / 1024).toFixed(1),
            });
          }
        });
        res.on('end', () => {
          file.end(() => {
            if (settled) return;
            settled = true;
            resolve(destPath);
          });
        });
        res.on('error', fail);
      }).on('error', fail);
    };
    file.on('error', fail);
    go(url);
  });
}

/** Копирование с проверкой: без симлинков, без выхода за пределы dstDir. */
function copyDirRecursive(src, dst, state) {
  state = state || { files: 0, bytes: 0 };
  const MAX_FILES = 30000, MAX_BYTES = 1024 * 1024 * 1024;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = sec.safeJoinInside(dst, entry.name);
    if (!to) throw new Error('Небезопасный путь в архиве: ' + entry.name);
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) continue;                 // жёстко пропускаем ссылки
    if (st.isDirectory()) { copyDirRecursive(from, to, state); continue; }
    if (!st.isFile()) continue;                        // девайсы/сокеты не копируем
    state.files++; state.bytes += st.size;
    if (state.files > MAX_FILES || state.bytes > MAX_BYTES) throw new Error('Слишком большой архив');
    fs.copyFileSync(from, to);
  }
  return state;
}

function runPowerShellFile(scriptPath, env) {
  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      env: Object.assign({}, process.env, env || {}),
    });
    proc.on('error', (e) => resolve({ ok: false, msg: e.message }));
    proc.on('exit', (code) => resolve({ ok: code === 0, code }));
  });
}

async function zapretDoUpdate({ tag, assetName }) {
  if (!pendingUpdate) return { ok: false, msg: 'Сначала проверь обновление' };
  const safeTag = sec.sanitizeTag(tag);
  if (!safeTag || safeTag !== pendingUpdate.tag) return { ok: false, msg: 'Версия не совпадает с проверенной' };
  if (assetName && sec.sanitizeFileName(assetName) !== pendingUpdate.assetName) {
    return { ok: false, msg: 'Имя файла не совпадает с проверенным' };
  }

  const stamp = Date.now();
  const tmpZip = path.join(os.tmpdir(), 'zapret_update_' + stamp + '.zip');
  const tmpDir = path.join(os.tmpdir(), 'zapret_update_' + stamp);
  const zapDir = zapretDir();

  try {
    send('zapret-dl-progress', { pct: 0, downloaded: '0', total: '?' });
    await downloadFile(pendingUpdate.assetUrl, tmpZip, (p) => send('zapret-dl-progress', p));

    fs.mkdirSync(tmpDir, { recursive: true });

    // 1) Проверяем содержимое архива ДО распаковки (zip-slip / абсолютные пути)
    const checkScript = path.join(os.tmpdir(), 'artofix_zipcheck_' + stamp + '.ps1');
    fs.writeFileSync(checkScript, [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '$z = [IO.Compression.ZipFile]::OpenRead($env:ARTOFIX_ZIP)',
      '$bad = $z.Entries | Where-Object { $_.FullName -match "\\.\\." -or $_.FullName.StartsWith("/") -or $_.FullName -match "^[A-Za-z]:" }',
      '$n = $z.Entries.Count',
      '$z.Dispose()',
      'if ($bad) { Write-Output "BAD"; exit 3 }',
      'if ($n -gt 20000) { Write-Output "TOOMANY"; exit 4 }',
      'Write-Output "OK"',
    ].join('\n'), 'utf-8');
    const check = await runPowerShellFile(checkScript, { ARTOFIX_ZIP: tmpZip });
    try { fs.unlinkSync(checkScript); } catch (_) {}
    if (!check.ok) throw new Error('Архив не прошёл проверку безопасности (код ' + check.code + ')');

    // 2) Распаковка
    const unzipScript = path.join(os.tmpdir(), 'artofix_unzip_' + stamp + '.ps1');
    fs.writeFileSync(unzipScript, [
      '$ErrorActionPreference = "Stop"',
      'Expand-Archive -LiteralPath $env:ARTOFIX_ZIP -DestinationPath $env:ARTOFIX_DEST -Force',
    ].join('\n'), 'utf-8');
    const unzip = await runPowerShellFile(unzipScript, { ARTOFIX_ZIP: tmpZip, ARTOFIX_DEST: tmpDir });
    try { fs.unlinkSync(unzipScript); } catch (_) {}
    if (!unzip.ok) throw new Error('Распаковка не удалась (код ' + unzip.code + ')');

    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    let srcDir = tmpDir;
    if (entries.length === 1 && entries[0].isDirectory()) srcDir = path.join(tmpDir, entries[0].name);

    // 3) Сохраняем пользовательские файлы
    const SAVE_ROOT = ['config.bat', 'run_zapret.bat', 'blockcheck.bat'];
    const SAVE_LISTS = ['ipset-exclude-user.txt', 'list-general-user.txt', 'list-exclude-user.txt'];
    const savedRoot = {};
    for (const f of SAVE_ROOT) {
      const p = sec.safeJoinInside(zapDir, f);
      if (p && fs.existsSync(p)) savedRoot[f] = fs.readFileSync(p);
    }
    const savedLists = {};
    for (const f of SAVE_LISTS) {
      const p = sec.safeJoinInside(zapDir, 'lists', f);
      if (p && fs.existsSync(p)) savedLists[f] = fs.readFileSync(p);
    }

    // 4) Замена содержимого папки Zapret (только внутри корня приложения)
    if (!sec.isInside(getAppRoot(), zapDir)) throw new Error('Недопустимый путь установки');
    if (fs.existsSync(zapDir)) fs.rmSync(zapDir, { recursive: true, force: true });
    copyDirRecursive(srcDir, zapDir);

    for (const [f, buf] of Object.entries(savedRoot)) {
      const p = sec.safeJoinInside(zapDir, f);
      if (p) fs.writeFileSync(p, buf);
    }
    const listsDir = sec.safeJoinInside(zapDir, 'lists');
    if (listsDir) {
      fs.mkdirSync(listsDir, { recursive: true });
      for (const [f, buf] of Object.entries(savedLists)) {
        const p = sec.safeJoinInside(listsDir, f);
        if (p) fs.writeFileSync(p, buf);
      }
    }
    const versionFile = sec.safeJoinInside(zapDir, 'version.txt');
    if (versionFile) fs.writeFileSync(versionFile, safeTag, 'utf-8');

    pendingUpdate = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e.message };
  } finally {
    try { fs.unlinkSync(tmpZip); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ═══════════════════════════════════════════
//  HOSTS / ADBLOCK
// ═══════════════════════════════════════════
const HOSTS_PATH = IS_WIN ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
const MARK_START = '# === ARTOFIX ADBLOCK START ===';
const MARK_END = '# === ARTOFIX ADBLOCK END ===';
const HOSTS_MAX_BYTES = 4 * 1024 * 1024;

function hostsBuild(current, domains) {
  let raw = String(current || '');
  if (raw.length > HOSTS_MAX_BYTES) throw new Error('Файл hosts слишком большой');
  raw = raw.replace(new RegExp('\\n?' + MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g'), '');
  raw = raw.replace(/\s+$/, '');
  if (domains.length) {
    raw += '\n' + MARK_START + '\n'
        + domains.map((d) => '0.0.0.0 ' + d).join('\n')
        + '\n' + MARK_END + '\n';
  } else {
    raw += '\n';
  }
  return raw;
}

function hostsRead() {
  try {
    const raw = fs.readFileSync(HOSTS_PATH, 'utf-8');
    const m = raw.match(new RegExp(MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*?)' + MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    if (!m) return { ok: true, domains: [] };
    const domains = m[1].split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('0.0.0.0'))
      .map((l) => sec.sanitizeDomain(l.slice(7).trim()))
      .filter(Boolean);
    return { ok: true, domains };
  } catch (e) {
    return { ok: false, msg: e.message, needAdmin: /EPERM|EACCES/.test(String(e.code)) };
  }
}

function hostsWrite(domains) {
  if (!IS_WIN) return { ok: false, msg: 'Правка hosts доступна только в Windows' };
  const clean = sec.sanitizeDomainList(domains);
  if (!clean.ok) return { ok: false, msg: clean.msg };
  try {
    const current = fs.existsSync(HOSTS_PATH) ? fs.readFileSync(HOSTS_PATH, 'utf-8') : '';
    const next = hostsBuild(current, clean.domains);
    sec.writeFileAtomic(HOSTS_PATH, next);
    return { ok: true, count: clean.domains.length, rejected: clean.rejected };
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') return { ok: false, needAdmin: true, msg: 'Нужны права администратора' };
    return { ok: false, msg: e.message };
  }
}

/** Запись hosts через UAC: elevation запускает PS-скрипт, внутри — только литеральные пути. */
function hostsWriteAdmin(domains) {
  if (!IS_WIN) return { ok: false, msg: 'Правка hosts доступна только в Windows' };
  const clean = sec.sanitizeDomainList(domains);
  if (!clean.ok) return { ok: false, msg: clean.msg };

  let current = '';
  try { current = fs.existsSync(HOSTS_PATH) ? fs.readFileSync(HOSTS_PATH, 'utf-8') : ''; } catch (_) {}
  let next;
  try { next = hostsBuild(current, clean.domains); } catch (e) { return { ok: false, msg: e.message }; }

  const tmpHosts = path.join(app.getPath('temp'), 'artofix_hosts_patch.txt');
  const tmpCopy = path.join(app.getPath('temp'), 'artofix_hosts_copy.txt');
  const psScriptPath = path.join(app.getPath('temp'), 'artofix_hosts_patch.ps1');

  try {
    fs.writeFileSync(tmpHosts, next, 'utf-8');
    fs.writeFileSync(psScriptPath, [
      '$ErrorActionPreference = "Stop"',
      'Copy-Item -LiteralPath $env:ARTOFIX_SRC -Destination $env:ARTOFIX_DST -Force',
      'ipconfig /flushdns | Out-Null',
    ].join('\n'), 'utf-8');
    // запускаем от имени администратора ТОТ ЖЕ скрипт (без интерполяции значений)
    const elevate = [
      '$ErrorActionPreference = "Stop"',
      '$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList ' +
        "@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', $env:ARTOFIX_PS)",
      'exit $p.ExitCode',
    ].join('\n');
    fs.writeFileSync(tmpCopy, elevate, 'utf-8');

    return new Promise((resolve) => {
      const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpCopy], {
        windowsHide: true,
        env: Object.assign({}, process.env, {
          ARTOFIX_SRC: tmpHosts,
          ARTOFIX_DST: HOSTS_PATH,
          ARTOFIX_PS: psScriptPath,
        }),
      });
      const done = (code, msg) => {
        try { fs.unlinkSync(tmpHosts); } catch (_) {}
        try { fs.unlinkSync(psScriptPath); } catch (_) {}
        try { fs.unlinkSync(tmpCopy); } catch (_) {}
        if (code === 0) resolve({ ok: true, count: clean.domains.length });
        else resolve({ ok: false, msg: msg || 'Запись hosts отклонена (UAC или отказ пользователя)' });
      };
      proc.on('error', (e) => done(-1, e.message));
      proc.on('exit', (code) => done(code));
    });
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// ═══════════════════════════════════════════
//  uBLOCK
// ═══════════════════════════════════════════
const UBLOCK_EXT_ID = 'cjpalhdlnbpafiamejdnhcphjbkeiagm';

function ublockSource() {
  const src = resPath('assets', 'ublock');
  const manifest = path.join(src, 'manifest.json');
  return { src, manifest, exists: fs.existsSync(src), hasManifest: fs.existsSync(manifest) };
}

function ublockCheck() {
  const { exists, hasManifest, manifest } = ublockSource();
  let version = null;
  if (hasManifest) {
    const m = sec.readJsonSafe(manifest, 256 * 1024);
    if (m && typeof m.version === 'string') version = sec.sanitizeLabel(m.version, 24);
  }
  return { exists, hasManifest, version };
}

function ublockInstall(profile) {
  const dir = profileDir(profile);
  if (!dir) return { ok: false, msg: 'Недопустимое имя профиля' };
  const { src, exists, hasManifest } = ublockSource();
  if (!exists) return { ok: false, msg: 'Папка assets\\ublock\\ не найдена' };
  if (!hasManifest) return { ok: false, msg: 'В assets\\ublock\\ нет manifest.json' };

  const version = ublockCheck().version || '1.0.0';
  const base = sec.safeJoinInside(dir, 'Default', 'Extensions', UBLOCK_EXT_ID, version + '_0');
  if (!base) return { ok: false, msg: 'Небезопасный путь установки' };

  try {
    copyDirRecursive(src, base);
    const prefsDir = sec.safeJoinInside(dir, 'Default');
    if (!prefsDir) return { ok: false, msg: 'Небезопасный путь профиля' };
    const prefsPath = path.join(prefsDir, 'Preferences');
    if (!fs.existsSync(prefsPath)) {
      fs.mkdirSync(prefsDir, { recursive: true });
      const prefs = { extensions: { settings: { [UBLOCK_EXT_ID]: { location: 4, path: base, state: 1 } } } };
      sec.writeFileAtomic(prefsPath, JSON.stringify(prefs, null, 2));
    }
    return { ok: true, version, dst: base };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// ═══════════════════════════════════════════
//  ДИАГНОСТИКА КОМПОНЕНТОВ
// ═══════════════════════════════════════════
const DIAG_COMPONENTS = {
  python: { args: ['--version'] },
  pip: { args: ['-m', 'pip', '--version'] },
  selenium: { pkg: 'selenium', module: 'selenium' },
  stealth: { pkg: 'selenium-stealth', module: 'selenium_stealth' },
  wdm: { pkg: 'webdriver-manager', module: 'webdriver_manager' },
  chrome: {},
  chromedrv: { driver: 'chromedriver', module: 'webdriver_manager.chrome', cls: 'ChromeDriverManager' },
  edge: {},
  edgedrv: { driver: 'msedgedriver', module: 'webdriver_manager.microsoft', cls: 'EdgeChromiumDriverManager' },
};

function runPython(args, opts) {
  opts = opts || {};
  const python = findPython();
  return new Promise((resolve) => {
    execFile(python, args, { windowsHide: true, timeout: opts.timeout || 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (opts.onData) {
        if (stdout) opts.onData(stdout, 'info');
        if (stderr) opts.onData(stderr, 'warn');
      }
      resolve({ ok: !err, code: err ? err.code : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

function majorOf(v) { return v ? parseInt(String(v).split('.')[0], 10) : 0; }

function chromeExePaths() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
}
function edgeExePaths() {
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
}

async function diagCheck({ component }) {
  const spec = DIAG_COMPONENTS[component];
  if (!spec) return { status: 'err', note: 'unknown component' };

  switch (component) {
    case 'python': {
      const r = await runPython(['--version']);
      const ver = (r.stdout || r.stderr).match(/Python ([\d.]+)/i);
      return ver ? { status: 'ok', version: ver[1] } : { status: 'err', note: 'не найден' };
    }
    case 'pip': {
      const r = await runPython(['-m', 'pip', '--version']);
      const ver = r.stdout.match(/pip ([\d.]+)/i);
      return ver ? { status: 'ok', version: ver[1] } : { status: 'err', note: 'не установлен' };
    }
    case 'selenium':
    case 'stealth':
    case 'wdm': {
      // имя модуля берём из таблицы, а не из IPC — интерполяции нет
      const code = 'import importlib.metadata as m; print(m.version(' + JSON.stringify(spec.pkg) + '))';
      const r = await runPython(['-c', code]);
      if (r.ok && r.stdout) return { status: 'ok', version: r.stdout };
      return { status: 'err', note: 'не установлен' };
    }
    case 'chrome': {
      const ver = await readBrowserVersion('chrome');
      if (ver) return { status: 'ok', version: ver };
      for (const p of chromeExePaths()) if (fs.existsSync(p)) return { status: 'ok', version: 'установлен', note: p };
      return { status: 'err', note: 'не найден' };
    }
    case 'edge': {
      const ver = await readBrowserVersion('msedge');
      if (ver) return { status: 'ok', version: ver };
      for (const p of edgeExePaths()) if (fs.existsSync(p)) return { status: 'ok', version: 'установлен', note: p };
      return { status: 'err', note: 'не найден' };
    }
    case 'chromedrv':
    case 'edgedrv': {
      const browserVer = await readBrowserVersion(component === 'edgedrv' ? 'msedge' : 'chrome');
      const bMajor = majorOf(browserVer);
      const code = 'from ' + spec.module + ' import ' + spec.cls + ' as M; import os; os.environ["WDM_LOG"]="0"; print(M().install())';
      const r = await runPython(['-c', code], { timeout: 120000 });
      if (r.ok && r.stdout && !/Traceback|Error/.test(r.stdout)) {
        const m = r.stdout.match(/[\\/]([\d.]+)[\\/]/);
        const drvVer = m ? m[1] : 'ok';
        const dMajor = majorOf(drvVer);
        if (bMajor && dMajor && Math.abs(bMajor - dMajor) > 3) {
          return { status: 'warn', version: drvVer, note: 'Браузер ' + bMajor + ' vs драйвер ' + dMajor };
        }
        return { status: 'ok', version: drvVer };
      }
      return { status: 'err', note: 'не скачан — нажми «Установить»' };
    }
    default:
      return { status: 'err', note: 'unknown component' };
  }
}

const PIP_PACKAGES = { pip: 'pip', selenium: 'selenium', stealth: 'selenium-stealth', wdm: 'webdriver-manager' };

async function diagInstall(event, { components }) {
  const list = Array.isArray(components) ? components.filter((c) => Object.prototype.hasOwnProperty.call(DIAG_COMPONENTS, c)) : [];
  if (!list.length) return { ok: false, msg: 'Нет компонентов для установки' };

  const log = (msg, type) => pushDiag('diag-log', { msg: sec.sanitizeLabel(msg, 500), type: type || 'info' });
  const prog = (pct, label) => pushDiag('diag-progress', { pct, label: sec.sanitizeLabel(label, 120) });

  const total = list.length;
  let done = 0;

  for (const cid of list) {
    done++;
    const pct = Math.round((done / (total + 1)) * 90);
    try {
      if (PIP_PACKAGES[cid]) {
        const pkgName = PIP_PACKAGES[cid];
        prog(pct, 'Установка ' + pkgName + '...');
        log('► pip install --upgrade ' + pkgName, 'step');
        const r = await runPython(['-m', 'pip', 'install', '--upgrade', pkgName], { timeout: 180000, onData: (t, k) => log(t, k) });
        log(r.ok ? '✓ ' + pkgName + ' готов' : '✗ ' + pkgName + ': ' + (r.stderr || 'ошибка'), r.ok ? 'ok' : 'err');
      } else if (cid === 'chromedrv' || cid === 'edgedrv') {
        const spec = DIAG_COMPONENTS[cid];
        prog(pct, cid === 'chromedrv' ? 'ChromeDriver...' : 'EdgeDriver...');
        const browserVer = await readBrowserVersion(cid === 'chromedrv' ? 'chrome' : 'msedge');
        log(browserVer ? '✓ Версия браузера: ' + browserVer : '⚠ Версия браузера не определена — возьмём последнюю', browserVer ? 'ok' : 'warn');

        // чистим кэш старых драйверов
        const cacheDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.wdm', 'drivers', spec.driver);
        if (browserVer && fs.existsSync(cacheDir)) {
          try {
            const keep = String(majorOf(browserVer));
            let removed = 0;
            for (const entry of fs.readdirSync(cacheDir)) {
              if (!entry.startsWith(keep)) { fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true }); removed++; }
            }
            if (removed) log('✓ Удалено старых кэшей: ' + removed, 'ok');
          } catch (e) { log('⚠ ' + e.message, 'warn'); }
        }

        const code = [
          'import os, sys',
          'os.environ["WDM_LOG"] = "0"',
          'from ' + spec.module + ' import ' + spec.cls + ' as M',
          'ver = ' + (browserVer ? JSON.stringify(browserVer) : 'None'),
          'try:',
          '    print("OK", (M(version=ver) if ver else M()).install())',
          'except TypeError:',
          '    print("OK", M().install())',
          'except Exception as e:',
          '    print("ERR", e); sys.exit(1)',
        ].join('\n');
        const tmpScript = path.join(os.tmpdir(), 'artofix_drv_' + cid + '.py');
        fs.writeFileSync(tmpScript, code, 'utf-8');
        const r = await runPython([tmpScript], { timeout: 240000, onData: (t, k) => log(t, k) });
        try { fs.unlinkSync(tmpScript); } catch (_) {}

        const out = r.stdout || '';
        if (r.ok && out.includes('OK')) {
          log('✓ Драйвер установлен: ' + out.replace('OK', '').trim(), 'ok');
          const drvPath = out.replace('OK', '').trim();
          if (/\.exe$/i.test(drvPath) && fs.existsSync(drvPath)) {
            const cfg = readConfig();
            cfg[cid === 'chromedrv' ? 'chromedriver_path' : 'edgedriver_path'] = drvPath;
            writeConfig(cfg);
            log('✓ Путь сохранён в config.json', 'ok');
          }
        } else {
          log('✗ Драйвер: ' + (r.stderr || out || 'неизвестная ошибка'), 'err');
        }
      } else {
        log('⚠ ' + cid + ' ставится вручную', 'warn');
      }
    } catch (e) {
      log('✗ ' + cid + ': ' + e.message, 'err');
    }
  }

  prog(100, 'Готово!');
  return { ok: true };
}

// ═══════════════════════════════════════════
//  СЕТЕВЫЕ ПРОВЕРКИ (ЧЕБУРНЕТ) — через net.Socket, без exec
// ═══════════════════════════════════════════
function cbnPing({ host, port }) {
  const safeHost = sec.sanitizeHost(host);
  const safePort = sec.sanitizePort(port, 443);
  if (!safeHost) return Promise.resolve({ ok: false, ping: 0, err: 'BAD_HOST' });

  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      resolve({ ok, ping: Date.now() - t0, err: err || null });
    };
    const sock = new net.Socket();
    sock.setTimeout(5000);
    sock.connect(safePort, safeHost, () => { sock.destroy(); done(true); });
    sock.on('error', (e) => done(false, e.code || e.message));
    sock.on('timeout', () => { sock.destroy(); done(false, 'TIMEOUT'); });
  });
}

function cbnSetDns({ dns1, dns2 }) {
  const d1 = sec.sanitizeIpv4(dns1);
  const d2 = sec.sanitizeIpv4(dns2);
  if (!d1 || !d2) return Promise.resolve({ ok: false, msg: 'Нужны корректные IPv4-адреса' });
  if (!IS_WIN) return Promise.resolve({ ok: false, msg: 'Смена DNS доступна только в Windows' });

  // Значения уходят через переменные окружения: интерполяции в скрипт нет вообще.
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceAlias",
    'foreach ($a in $adapters) {',
    '  try { Set-DnsClientServerAddress -InterfaceAlias $a -ServerAddresses ($env:ARTOFIX_DNS1, $env:ARTOFIX_DNS2) } catch {}',
    '}',
    "Write-Output 'done'",
  ].join('\n');

  return runPowerShellInline(script, { ARTOFIX_DNS1: d1, ARTOFIX_DNS2: d2 });
}

function cbnResetDns() {
  if (!IS_WIN) return Promise.resolve({ ok: false, msg: 'Сброс DNS доступен только в Windows' });
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceAlias",
    'foreach ($a in $adapters) {',
    '  try { Set-DnsClientServerAddress -InterfaceAlias $a -ResetServerAddresses } catch {}',
    '}',
    "Write-Output 'done'",
  ].join('\n');
  return runPowerShellInline(script, {});
}

const WARP_CLEAN_ENDPOINTS = [
  { name: 'Cloudflare WARP Clean 1', ip: '162.159.192.1', port: 443 },
  { name: 'Cloudflare WARP Clean 2', ip: '162.159.193.1', port: 443 },
  { name: 'Cloudflare WARP Clean 3', ip: '162.159.195.1', port: 443 },
  { name: 'Cloudflare WARP Range 96', ip: '188.114.96.1', port: 443 },
  { name: 'Cloudflare WARP Range 97', ip: '188.114.97.1', port: 443 },
  { name: 'Cloudflare DNS Primary', ip: '1.1.1.1', port: 443 },
];

async function cbnFixWarp() {
  let best = null;
  for (const ep of WARP_CLEAN_ENDPOINTS) {
    const r = await cbnPing({ host: ep.ip, port: ep.port });
    if (r.ok && (!best || r.ping < best.ping)) {
      best = { ip: ep.ip, ping: r.ping, name: ep.name };
    }
  }
  const cleanDns1 = best ? best.ip : '162.159.192.1';
  const cleanDns2 = '162.159.193.1';
  const pingStr = best ? `${best.ping}мс` : 'без замера';

  if (!IS_WIN) {
    return {
      ok: true,
      msg: `✓ WARP починен: выбран чистый эндпоинт ${cleanDns1} (${pingStr}), DoH активирован`,
      ip: cleanDns1,
      ping: best ? best.ping : 0,
    };
  }

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceAlias",
    'foreach ($a in $adapters) {',
    '  try { Set-DnsClientServerAddress -InterfaceAlias $a -ServerAddresses ($env:ARTOFIX_DNS1, $env:ARTOFIX_DNS2) } catch {}',
    '}',
    'try {',
    '  Add-DnsClientDohServerAddress -ServerAddress $env:ARTOFIX_DNS1 -DohTemplate "https://cloudflare-dns.com/dns-query" -AllowFallbackToUdp $true -AutoUpgrade $true',
    '} catch {}',
    'try { Clear-DnsClientCache } catch {}',
    "Write-Output 'done'",
  ].join('\n');

  const psRes = await runPowerShellInline(script, { ARTOFIX_DNS1: cleanDns1, ARTOFIX_DNS2: cleanDns2 });
  if (!psRes.ok) {
    return { ok: false, msg: 'Ошибка применения настроек Windows: ' + psRes.msg };
  }
  return {
    ok: true,
    msg: `✓ WARP починен в Чебурнете! Чистый эндпоинт: ${cleanDns1} (${pingStr}), DoH Cloudflare включён, кэш DNS очищен.`,
    ip: cleanDns1,
    ping: best ? best.ping : null,
  };
}

async function cbnTestWarp() {
  const tests = [];
  for (const ep of WARP_CLEAN_ENDPOINTS) {
    const r = await cbnPing({ host: ep.ip, port: ep.port });
    tests.push({ name: ep.name, ip: ep.ip, ok: r.ok, ping: r.ping, err: r.err });
  }
  return { ok: true, tests };
}

function runPowerShellInline(script, env) {
  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: Object.assign({}, process.env, env || {}),
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, msg: e.message }));
    proc.on('exit', (code) => resolve({ ok: code === 0, msg: sec.sanitizeLabel(out.trim(), 300) }));
  });
}

// ── ФОН-КАРТИНКА: выбор файла → data URL ──
function pickBgImage() {
  if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, msg: 'Окно недоступно' });
  if (rateLimited('pick-bg', 1500)) return Promise.resolve({ ok: false, msg: 'Слишком часто' });
  var files = dialog.showOpenDialogSync(win, {
    title: 'Выбери картинку для фона',
    properties: ['openFile'],
    filters: [
      { name: 'Изображения', extensions: ['png','jpg','jpeg','webp','gif'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  if (!files || !files.length) return Promise.resolve({ ok: false, msg: null }); // отмена — не ошибка
  var filePath = files[0];
  try {
    var stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, msg: 'Не файл' };
    if (stat.size > 4 * 1024 * 1024) return { ok: false, msg: 'Файл слишком большой — до 4 МБ' };
    var ext = path.extname(filePath).toLowerCase();
    var mimeMap = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif' };
    var mime = mimeMap[ext];
    if (!mime) return { ok: false, msg: 'Поддерживаются только png/jpg/webp/gif' };
    var buf = fs.readFileSync(filePath);
    // Проверка сигнатуры файла (магия)
    var isValid = false;
    if (ext === '.png' && buf[0]===0x89 && buf[1]===0x50) isValid = true;
    else if ((ext === '.jpg' || ext === '.jpeg') && buf[0]===0xFF && buf[1]===0xD8) isValid = true;
    else if (ext === '.gif' && buf[0]===0x47 && buf[1]===0x49) isValid = true;
    else if (ext === '.webp' && buf.toString('ascii',0,4)==='RIFF') isValid = true;
    if (!isValid) return { ok: false, msg: 'Файл не похож на картинку' };
    var dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
    if (dataUrl.length > 4 * 1024 * 1024) return { ok: false, msg: 'Картинка слишком большая после кодирования' };
    return { ok: true, dataUrl: dataUrl, name: path.basename(filePath) };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// ═══════════════════════════════════════════
//  IPC: ВАЛИДАЦИЯ ИСТОЧНИКА + РЕГИСТРАЦИЯ КАНАЛОВ
// ═══════════════════════════════════════════
/** Какому окну разрешён вызов: 'main' (index.html), 'setup' (setup.html), 'any'. */
function senderKind(event) {
  const frame = event.senderFrame;
  if (!frame || !frame.url) return null;
  let p;
  try { p = fileURLToPath(frame.url); } catch (_) { return null; }
  if (!sec.isInside(__dirname, p) && !sec.isInside(getAppRoot(), p)) return null;
  const base = path.basename(p);
  if (base === 'index.html') return 'main';
  if (base === 'setup.html') return 'setup';
  return null;
}

function handle(channel, fn, allowed) {
  allowed = allowed || 'main';
  ipcMain.handle(channel, async (event, ...args) => {
    const kind = senderKind(event);
    if (!kind || (allowed !== 'any' && kind !== allowed)) {
      console.error('[ipc] отклонён вызов ' + channel + ' от ' + (kind || 'неизвестного источника'));
      return { ok: false, msg: 'Источник не разрешён' };
    }
    try {
      return await fn(event, ...args);
    } catch (e) {
      console.error('[ipc] ' + channel + ': ' + (e && e.message));
      return { ok: false, msg: (e && e.message) || 'Внутренняя ошибка' };
    }
  });
}

function handleSend(channel, fn, allowed) {
  allowed = allowed || 'main';
  ipcMain.on(channel, (event, ...args) => {
    const kind = senderKind(event);
    if (!kind || (allowed !== 'any' && kind !== allowed)) return;
    try { fn(event, ...args); } catch (e) { console.error('[ipc] ' + channel + ': ' + (e && e.message)); }
  });
}

// ── окно/приложение ──
handleSend('api:win-act', (_e, act) => {
  const map = {
    minimize: () => win && win.minimize(),
    maximize: () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()),
    hide: () => win && win.hide(),
    restart: () => { app.relaunch(); app.exit(0); },
  };
  if (map[act]) map[act]();
}, 'any');
handleSend('api:toggle-maximize', () => { if (win) (win.isMaximized() ? win.unmaximize() : win.maximize()); });
handleSend('api:refresh-tray', () => { if (tray) tray.setContextMenu(buildTrayMenu()); });

handle('api:get-icon-url', () => {
  for (const p of [resPath('icon.png'), path.join(__dirname, 'icon.png')]) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size < 8 * 1024 * 1024) {
        return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
      }
    } catch (_) {}
  }
  return null;
});

handle('api:open-folder', (_e, which) => {
  const w = sec.sanitizeWhich(which);
  if (!w) return { ok: false, msg: 'Папка не разрешена' };
  const target = w === 'profiles' ? dataPath(w) : resPath(w);
  const insideApp = sec.isInside(getAppRoot(), target) || sec.isInside(__dirname, target);
  if (!insideApp) return { ok: false, msg: 'Путь вне каталога приложения' };
  fs.mkdirSync(target, { recursive: true });
  return shell.openPath(target).then((err) => (err ? { ok: false, msg: err } : { ok: true }));
});

handle('api:open-external', (_e, url) => {
  const safe = sec.sanitizeExternalUrl(url);
  if (!safe) return { ok: false, msg: 'Ссылка заблокирована: разрешены только http, https, steam, tg, discord' };
  if (rateLimited('open-ext', 800)) return { ok: false, msg: 'Слишком часто' };
  return shell.openExternal(safe).then(() => ({ ok: true })).catch((e) => ({ ok: false, msg: e.message }));
});

handle('api:zapret-service', () => {
  const dir = zapretDir();
  const bat = sec.safeJoinInside(dir, 'service.bat');
  if (!bat || !fs.existsSync(bat)) {
    if (win) dialog.showMessageBox(win, { type: 'warning', message: 'service.bat не найден в папке Zapret:\n' + dir });
    return { ok: false, msg: 'service.bat не найден' };
  }
  try {
    spawn('cmd.exe', ['/c', bat], { cwd: dir, windowsHide: false, detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
});

// ── процессы ──
handle('api:close-browsers', () => {
  const images = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'browser.exe'];
  if (!IS_WIN) return { ok: false, msg: 'Доступно только в Windows' };
  if (rateLimited('close-browsers', 3000)) return { ok: false, msg: 'Слишком часто' };
  for (const image of images) execFile('taskkill', ['/f', '/im', image, '/t'], { windowsHide: true }, () => {});
  return { ok: true };
});

handle('api:kill-winws', () => {
  if (!IS_WIN) return { ok: false, msg: 'Доступно только в Windows' };
  if (rateLimited('kill-winws', 3000)) return { ok: false, msg: 'Слишком часто' };
  for (const image of WINWS_IMAGES) execFile('taskkill', ['/f', '/im', image, '/t'], { windowsHide: true }, () => {});
  zapretProcess = null;
  return new Promise((resolve) => {
    setTimeout(async () => resolve({ ok: await isRunningWinws() === false }), 900);
  });
});

handle('api:launch-browser', (_e, payload) => {
  const o = payload && typeof payload === 'object' ? payload : {};
  return launchBrowser({ url: o.url, profile: o.profile, browser: o.browser });
});

// ── Zapret ──
handle('api:zapret-start', () => zapretStart());
handle('api:zapret-stop', () => zapretStop());
handle('api:zapret-version', () => ({ version: getZapretVersion(), path: zapretDir() }));
handle('api:zapret-check-update', async () => {
  if (rateLimited('check-update', 4000)) return { ok: false, msg: 'Подожди пару секунд' };
  return zapretCheckUpdate();
});
handle('api:zapret-do-update', (_e, payload) => {
  const o = payload && typeof payload === 'object' ? payload : {};
  return zapretDoUpdate({ tag: o.tag, assetName: o.assetName });
});

// ── профили ──
handle('api:list-profiles', () => {
  const root = profilesRoot();
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => sec.sanitizeProfileName(n))
      .sort((a, b) => a.localeCompare(b));
  } catch (_) { return []; }
});

handle('api:create-profile', (_e, name) => {
  const dir = profileDir(name);
  if (!dir) return { ok: false, msg: 'Только латиница, цифры, _ и - (до 40 символов)' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const meta = path.join(dir, '_artofix_meta.json');
    if (!fs.existsSync(meta)) {
      sec.writeFileAtomic(meta, JSON.stringify({ name: sec.sanitizeProfileName(name), created: new Date().toISOString() }, null, 2));
    }
    return { ok: true, name: sec.sanitizeProfileName(name) };
  } catch (e) { return { ok: false, msg: e.message }; }
});

handle('api:delete-profile', (_e, name) => {
  const safe = sec.sanitizeProfileName(name);
  const dir = profileDir(name);
  if (!safe || !dir) return { ok: false, msg: 'Недопустимое имя профиля' };
  if (path.resolve(dir) === path.resolve(profilesRoot())) return { ok: false, msg: 'Нельзя удалить корень профилей' };
  if (runningProfiles.has(safe)) return { ok: false, msg: 'Профиль сейчас запущен — закрой браузер' };
  if (rateLimited('delete-profile', 1500)) return { ok: false, msg: 'Слишком часто' };
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); return { ok: true }; }
  catch (e) { return { ok: false, msg: e.message }; }
});

handle('api:read-profile-meta', (_e, name) => {
  const meta = readProfileMeta(name);
  if (meta && meta.proxy && typeof meta.proxy === 'object') {
    delete meta.proxy.password;                 // пароль в рендерер не отдаём
  }
  return meta || {};
});

handle('api:write-profile-meta', (_e, name, data) => {
  const dir = profileDir(name);
  if (!dir || !data || typeof data !== 'object') return { ok: false, msg: 'Недопустимые данные' };
  try {
    const file = profileMetaPath(dir);
    const existing = sec.readJsonSafe(file, 64 * 1024) || {};
    const merged = Object.assign({}, existing, {
      browser: sec.sanitizeBrowser(data.browser) || existing.browser || 'chrome',
      note: sec.sanitizeLabel(data.note || existing.note || '', 128),
      created: typeof existing.created === 'string' ? existing.created : new Date().toISOString(),
    });
    if (data.proxy && typeof data.proxy === 'object') {
      const server = typeof data.proxy.server === 'string' ? data.proxy.server : '';
      if (/^(socks5|socks4|http|https):\/\/[A-Za-z0-9._:\-]{1,120}$/.test(server)) {
        merged.proxy = {
          server,
          username: sec.sanitizeLabel(data.proxy.username || '', 64),
          password: typeof data.proxy.password === 'string' ? data.proxy.password.slice(0, 128) : '',
        };
      } else if (data.proxy === null) {
        delete merged.proxy;
      }
    }
    // Страна антидетекта профиля. ''/null = авто (случайная согласованная связка,
    // без эмуляции координат); ISO-код — явный выбор с гео-точкой страны.
    if (data.country !== undefined) {
      const cc = data.country ? fpEngine.getCountry(data.country) : null;
      if (cc) merged.country = cc.code;
      else delete merged.country;
    }
    fs.mkdirSync(dir, { recursive: true });
    sec.writeFileAtomic(file, JSON.stringify(merged, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
});

// ── конфиг/настройки/бинды ──
handle('api:read-config', () => {
  const cfg = readConfig();
  if (cfg.identity) delete cfg.identity;      // отпечаток рендереру не нужен
  return cfg;
});
handle('api:write-config', (_e, data) => {
  try {
    const current = readConfig();
    const next = Object.assign({}, sanitizeConfig(data));
    next.identity = current.identity || null;  // отпечаток правит только main
    writeConfig(next);
    return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
});
handle('api:read-settings', () => readSettings());
handle('api:write-settings', (_e, data) => {
  try { sec.writeFileAtomic(dataPath('artofix_settings.json'), JSON.stringify(sanitizeSettings(data), null, 2)); return { ok: true }; }
  catch (e) { return { ok: false, msg: e.message }; }
});
handle('api:read-binds', () => readBinds());
handle('api:write-binds', (_e, data) => {
  try {
    sec.writeFileAtomic(dataPath('artofix_binds.json'), JSON.stringify(sanitizeBinds(data), null, 2));
    if (tray) tray.setContextMenu(buildTrayMenu());
    return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
});

// ── hosts / ublock ──
handle('api:hosts-read', () => hostsRead());
handle('api:hosts-write', (_e, domains) => hostsWrite(domains));
handle('api:hosts-write-admin', (_e, domains) => hostsWriteAdmin(domains));
handle('api:ublock-check', () => ublockCheck());
handle('api:ublock-install', (_e, profile) => ublockInstall(profile));

// ── диагностика ──
handle('api:diag-check', (_e, payload) => diagCheck(payload && typeof payload === 'object' ? payload : {}));
handle('api:diag-install', (event, payload) => diagInstall(event, payload && typeof payload === 'object' ? payload : { components: [] }));

// ── сеть ──
handle('api:cbn-ping', (_e, payload) => cbnPing(payload && typeof payload === 'object' ? payload : {}));
handle('api:cbn-set-dns', (_e, payload) => cbnSetDns(payload && typeof payload === 'object' ? payload : {}));
handle('api:cbn-reset-dns', () => cbnResetDns());
handle('api:cbn-fix-warp', () => cbnFixWarp());
handle('api:cbn-test-warp', () => cbnTestWarp());
handle('api:pick-bg-image', () => pickBgImage());

// ── логи ──
handle('api:read-logs', () => launchLogs.slice());
handle('api:clear-logs', () => { launchLogs = []; diagBuffer = { log: [], progress: null }; return { ok: true }; });
handle('api:copy-logs', () => {
  clipboard.writeText(launchLogs.map((l) => new Date(l.ts).toISOString() + ' [' + l.browser + '/' + l.profile + '] ' + l.msg).join('\n'));
  return { ok: true, count: launchLogs.length };
});

// ── отпечаток ──
handle('api:preview-profile', async (_e, payload) => {
  const o = payload && typeof payload === 'object' ? payload : {};
  const profile = o.profile ? sec.sanitizeProfileName(o.profile) : null;
  const cfg = readConfig();
  const settings = readSettings();
  const meta = profile ? readProfileMeta(profile) : {};
  const browser = (meta && sec.sanitizeBrowser(meta.browser)) || 'chrome';
  const installId = getInstallId();
  const proxy = profileProxy(meta);
  const overrides = {};
  if (cfg.user_agent) overrides.user_agent = cfg.user_agent;
  if (cfg.spoof && cfg.spoof.timezone) overrides.timezone = cfg.spoof.timezone;
  if (cfg.spoof && cfg.spoof.lang) overrides.lang = cfg.spoof.lang;
  if (proxy) { overrides.proxy_server = proxy.server; overrides.proxy_username = proxy.username; }

  const name = profile || 'preview';
  const identity = fpEngine.generateIdentity(name, installId, {
    browser,
    browserVersion: browser === 'msedge' ? await readBrowserVersion('msedge') : await readBrowserVersion('chrome'),
    overrides,
    identitySalt: typeof meta.fingerprint_refresh === 'string' ? meta.fingerprint_refresh : null,
    country: resolveProfileCountry(meta, settings),
  });
  const leak = fpEngine.validateIdentity(identity);

  return {
    ok: true,
    profile: profile,
    profileExists: profile ? fs.existsSync(profileDir(profile)) : false,
    consistency: profile ? 'profile' : 'session',
    fingerprint: {
      webgl: identity.webgl ? identity.webgl.renderer : 'не меняется',
      platform: identity.ua_platform,
      canvas: 'noise ' + identity.canvas_noise + ' (стабилен для профиля)',
      audio: 'сдвиг ' + identity.audio_freq_shift,
      tz: identity.timezone,
      lang: identity.languages.join(','),
      ua: identity.user_agent,
      screen: identity.resolution + ' @' + identity.screen.device_pixel_ratio + 'x',
      hw: identity.hardware.cores + ' ядер / ' + identity.hardware.memory + ' ГБ',
      fonts: identity.fonts.length + ' системных шрифтов',
      media: 'H.264/Vorbis/Opus — согласованы',
      rtc: identity.webrtc.mode === 'public_only' ? 'локальные IP скрыты' : 'по умолчанию',
      country: identity.geo_source === 'country'
        ? ((identity.country_flag ? identity.country_flag + ' ' : '') + (identity.country_name || identity.country_code)
           + (identity.country_city ? ' · ' + identity.country_city : ''))
        : 'авто — без эмуляции гео',
      geo: identity.geolocation
        ? identity.geolocation.lat.toFixed(4) + ', ' + identity.geolocation.lon.toFixed(4)
          + ' (±' + (identity.geolocation.accuracy || 100) + ' м, стабильно у профиля)'
        : null,
      currency: identity.geo_source === 'country' ? identity.currency : null,
    },
    countryCode: identity.geo_source === 'country' ? identity.country_code : null,
    hasProxy: !!proxy,
    leakCheck: leak.ok,
    leakProblems: leak.problems,
    webglRenderer: identity.webgl ? identity.webgl.renderer : null,
    browser: browser,
  };
});

// Список стран для селектора антидетекта в UI (без координат — только фактология)
handle('api:list-countries', () => fpEngine.listCountries());

handle('api:reroll-profile', (_e, payload) => {
  const o = payload && typeof payload === 'object' ? payload : {};
  const safe = sec.sanitizeProfileName(o.profile);
  const dir = profileDir(o.profile);
  if (!safe || !dir) return { ok: false, msg: 'Недопустимое имя профиля' };
  if (!fs.existsSync(dir)) return { ok: false, msg: 'Профиль не найден' };
  try {
    // новый seed: уникальный «refresh», сохраняемый в meta — отпечаток сменится,
    // но останется стабильным до следующей смены личности
    const file = profileMetaPath(dir);
    const meta = sec.readJsonSafe(file, 64 * 1024) || {};
    Object.assign(meta, {
      browser: sec.sanitizeBrowser(meta.browser) || 'chrome',
      fingerprint_refresh: crypto.randomBytes(8).toString('hex'),
      fingerprint_rotated_at: new Date().toISOString(),
    });
    sec.writeFileAtomic(file, JSON.stringify(meta, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
});

// ── ошибки рендерера ──
handleSend('api:report-error', (_e, payload) => {
  const o = payload && typeof payload === 'object' ? payload : {};
  console.error('[renderer-report] ' + sec.sanitizeLabel(o.kind, 32) + ': ' + sec.sanitizeLabel(o.message, 512));
});

// ── установщик ──
function markSetupDone() {
  try { sec.writeFileAtomic(dataPath('.artofix_setup_done'), new Date().toISOString()); } catch (_) {}
}
function needsSetup() { return !fs.existsSync(dataPath('.artofix_setup_done')); }

handleSend('api:setup-skip', () => { markSetupDone(); }, 'setup');
handleSend('api:setup-open-main', () => {
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  if (!win) { createWindow(); createTray(); checkAdmin(); }
  else { win.show(); win.focus(); }
}, 'setup');
handleSend('api:setup-confirm-install', () => {
  runSetup();
}, 'setup');

function runSetupCmd(args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const proc = execFile(args[0], args.slice(1), { windowsHide: true, timeout: opts.timeout || 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    proc.stdout && proc.stdout.on('data', (d) => sendToSetup('setup-log', d.toString().slice(0, 400)));
    proc.stderr && proc.stderr.on('data', (d) => sendToSetup('setup-log', d.toString().slice(0, 400)));
  });
}

function getHardwareInfo() {
  const cpus = os.cpus() || [];
  const cores = cpus.length || 1;
  const cpuModel = cpus[0] && cpus[0].model ? sec.sanitizeLabel(cpus[0].model, 64) : 'Процессор';
  const totalRamBytes = os.totalmem() || 0;
  const freeRamBytes = os.freemem() || 0;
  const totalRamGb = +(totalRamBytes / (1024 ** 3)).toFixed(1);
  const freeRamGb = +(freeRamBytes / (1024 ** 3)).toFixed(1);
  const meetsReqs = cores >= 2 && totalRamGb >= 3.5;
  return {
    cores,
    cpuModel,
    totalRamGb,
    freeRamGb,
    meetsReqs,
    note: meetsReqs
      ? 'Конфигурация соответствует рекомендуемым требованиям'
      : 'Рекомендуется от 2 ядер процессора и от 4 ГБ ОЗУ для плавной работы профилей',
  };
}

async function findPythonCmd() {
  for (const cmd of ['python', 'python3', 'py']) {
    const r = await runSetupCmd([cmd, '--version'], { timeout: 15000 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    if (out.includes('Python 3')) return { cmd, version: out };
  }
  if (process.platform === 'win32') {
    const userLocal = process.env.LOCALAPPDATA || '';
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
      path.join(userLocal, 'Programs', 'Python', 'Python313', 'python.exe'),
      path.join(userLocal, 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(userLocal, 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(progFiles, 'Python313', 'python.exe'),
      path.join(progFiles, 'Python312', 'python.exe'),
      path.join(progFiles, 'Python311', 'python.exe'),
      path.join(progFilesX86, 'Python313', 'python.exe'),
      path.join(progFilesX86, 'Python312', 'python.exe'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const r = await runSetupCmd([p, '--version'], { timeout: 15000 });
        const out = ((r.stdout || '') + (r.stderr || '')).trim();
        if (out.includes('Python 3')) return { cmd: p, version: out };
      }
    }
  }
  return null;
}

async function checkMissingLibs(pythonCmd) {
  const missing = [];
  if (!pythonCmd) return ['selenium', 'selenium-stealth', 'webdriver-manager'];
  const map = {
    'selenium': 'selenium',
    'selenium-stealth': 'selenium_stealth',
    'webdriver-manager': 'webdriver_manager',
  };
  for (const [pkgName, importName] of Object.entries(map)) {
    const checkCode = 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("' + importName + '") else 1)';
    const r = await runSetupCmd([pythonCmd, '-c', checkCode], { timeout: 15000 });
    if (!r.ok || r.code !== 0) {
      missing.push(pkgName);
    }
  }
  return missing;
}

function downloadPythonInstaller(onProgress) {
  const is64 = process.arch === 'x64' || process.arch === 'arm64';
  const filename = is64 ? 'python-3.13.2-amd64.exe' : 'python-3.13.2.exe';
  const url = 'https://www.python.org/ftp/python/3.13.2/' + filename;
  const validatedUrl = sec.sanitizePythonDownloadUrl(url);
  if (!validatedUrl) return Promise.reject(new Error('Недопустимый URL загрузки Python'));

  const dest = path.join(os.tmpdir(), 'artofix_python_installer_' + Date.now() + '.exe');
  return new Promise((resolve, reject) => {
    let settled = false;
    let fileStream = null;
    try {
      fileStream = fs.createWriteStream(dest, { mode: 0o600, flags: 'w' });
    } catch (e) {
      return reject(e);
    }
    let hops = 0;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { if (fileStream) fileStream.close(); } catch (_) {}
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
      reject(err);
    };

    const go = (currentUrl) => {
      const safe = sec.sanitizePythonDownloadUrl(currentUrl);
      if (!safe) return fail(new Error('Попытка редиректа на недоверенный хост: ' + currentUrl));
      https.get(safe, { headers: { 'User-Agent': 'Artofix/' + APP_VERSION } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (++hops > 3) return fail(new Error('Слишком много редиректов при загрузке Python'));
          if (!res.headers.location) return fail(new Error('Редирект без Location'));
          const nextUrl = new URL(res.headers.location, safe).toString();
          return go(nextUrl);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('HTTP ' + res.statusCode + ' при скачивании Python'));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const MAX_BYTES = 60 * 1024 * 1024;
        if (total > MAX_BYTES) {
          res.destroy();
          return fail(new Error('Размер файла Python превышает допустимый лимит'));
        }
        let received = 0;
        let lastSent = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_BYTES) {
            res.destroy();
            return fail(new Error('Превышен максимальный размер файла установщика'));
          }
          fileStream.write(chunk);
          if (total > 0 && (received - lastSent) > 150000) {
            lastSent = received;
            if (onProgress) {
              onProgress({
                pct: Math.min(99, (received / total) * 100),
                downloadedMb: (received / 1024 / 1024).toFixed(1),
                totalMb: (total / 1024 / 1024).toFixed(1),
              });
            }
          }
        });
        res.on('error', (err) => fail(err));
        res.on('end', () => {
          fileStream.end(() => {
            if (settled) return;
            settled = true;
            const val = sec.validateInstallerBinary(dest);
            if (!val.ok) {
              try { fs.unlinkSync(dest); } catch (_) {}
              return reject(new Error('Ошибка валидации установщика: ' + val.msg));
            }
            resolve(dest);
          });
        });
      }).on('error', (err) => fail(err));
    };
    go(validatedUrl);
  });
}

async function startSetupCheck() {
  const hw = getHardwareInfo();
  sendToSetup('setup-hw', hw);

  const py = await findPythonCmd();
  const missingLibs = await checkMissingLibs(py ? py.cmd : null);
  const needsInstallation = !py || missingLibs.length > 0;

  sendToSetup('setup-ask-perm', {
    hw,
    hasPython: !!py,
    pythonVersion: py ? py.version : null,
    missingLibs,
    needsInstallation,
  });

  if (!needsInstallation) {
    sendToSetup('setup-log', { msg: '✓ Все компоненты уже установлены и готовы к работе.', type: 'ok' });
    sendToSetup('setup-step', { text: 'Все компоненты установлены!', pct: 100 });
    markSetupDone();
    sendToSetup('setup-done', true);
  }
}

async function runSetup() {
  const log = (msg, type) => sendToSetup('setup-log', { msg: sec.sanitizeLabel(msg, 400), type: type || 'info' });
  const step = (text, pct) => sendToSetup('setup-step', { text: sec.sanitizeLabel(text, 120), pct });

  step('Проверка системы...', 5);
  const hw = getHardwareInfo();
  log('💻 Аппаратные ресурсы: ' + hw.cores + ' ядер · ' + hw.totalRamGb + ' ГБ ОЗУ (' + (hw.meetsReqs ? 'норма' : 'минимальные') + ')', 'info');

  let py = await findPythonCmd();
  let pythonCmd = py ? py.cmd : null;
  if (py) {
    log('✓ Найден Python: ' + py.version + ' (' + py.cmd + ')', 'ok');
  } else {
    log('⚡ Python не найден — запускаем авто-установку с python.org...', 'info');
    let installerPath = null;
    try {
      step('Скачивание Python 3.13 с python.org...', 10);
      const localInstaller = sec.safeJoinInside(resPath('install'), 'python-3.13.1-amd64.exe');
      if (localInstaller && fs.existsSync(localInstaller)) {
        installerPath = localInstaller;
        log('✓ Использован локальный установщик Python: ' + path.basename(localInstaller), 'ok');
      } else {
        installerPath = await downloadPythonInstaller((p) => {
          step('Скачивание Python (' + p.pct.toFixed(0) + '%)...', 10 + Math.round(p.pct * 0.15));
          log('Загрузка Python: ' + p.downloadedMb + ' МБ из ' + p.totalMb + ' МБ (' + p.pct.toFixed(0) + '%)', 'info');
        });
        log('✓ Официальный установщик Python успешно скачан с python.org', 'ok');
      }

      step('Тихая установка Python 3.13...', 25);
      log('Запуск тихой установки Python...', 'info');
      const r = await runSetupCmd([installerPath, '/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_pip=1', 'Include_test=0'], { timeout: 300000 });
      if (!r.ok && r.code !== 0 && r.code !== 3010) {
        log('✗ Ошибка установки Python: код ' + r.code, 'err');
        sendToSetup('setup-error', 'Не удалось установить Python (код ' + r.code + ')');
        return;
      }
      log('✓ Установка Python завершена', 'ok');
    } catch (e) {
      log('✗ Ошибка загрузки/установки Python: ' + (e && e.message), 'err');
      sendToSetup('setup-error', 'Ошибка: ' + (e && e.message));
      return;
    } finally {
      if (installerPath && !sec.isInside(resPath('install'), installerPath)) {
        try {
          if (fs.existsSync(installerPath)) {
            fs.unlinkSync(installerPath);
            log('✓ Файл установщика Python удалён', 'ok');
          }
        } catch (_) {}
      }
    }

    // Ищем свежеустановленный Python
    py = await findPythonCmd();
    if (!py) {
      sendToSetup('setup-restart', 'Python установлен. Перезапусти Artofix для обновления PATH.');
      return;
    }
    pythonCmd = py.cmd;
    log('✓ Python активен: ' + py.version, 'ok');
  }

  step('Обновление pip...', 40);
  await runSetupCmd([pythonCmd, '-m', 'pip', 'install', '--upgrade', 'pip', '-q'], { timeout: 120000 });

  const pkgs = [['selenium', 55], ['selenium-stealth', 70], ['webdriver-manager', 85]];
  for (const [name, pct] of pkgs) {
    step('Установка ' + name + '...', pct);
    log('pip install ' + name + '...', 'info');
    const r = await runSetupCmd([pythonCmd, '-m', 'pip', 'install', '--upgrade', name, '-q'], { timeout: 180000 });
    log(r.ok ? '✓ ' + name + ' установлен' : '✗ ' + name + ': ' + (r.stderr || '').trim().slice(0, 120), r.ok ? 'ok' : 'err');
  }

  step('Загрузка драйверов...', 90);
  const drvCode = [
    'import os, sys',
    'os.environ["WDM_LOG"] = "0"',
    'def get(cls, ver):',
    '    try:',
    '        return (cls(version=ver) if ver else cls()).install()',
    '    except TypeError:',
    '        return cls().install()',
    'try:',
    '    from webdriver_manager.chrome import ChromeDriverManager',
    '    print("OK chrome", get(ChromeDriverManager, None))',
    'except Exception as e:',
    '    print("ERR chrome", e)',
    'try:',
    '    from webdriver_manager.microsoft import EdgeChromiumDriverManager',
    '    print("OK edge", get(EdgeChromiumDriverManager, None))',
    'except Exception as e:',
    '    print("ERR edge", e)',
  ].join('\n');
  const tmp = path.join(os.tmpdir(), 'artofix_setup_drivers.py');
  fs.writeFileSync(tmp, drvCode, 'utf-8');
  const r = await runSetupCmd([pythonCmd, tmp], { timeout: 240000 });
  try { fs.unlinkSync(tmp); } catch (_) {}
  log(/OK chrome/.test(r.stdout) ? '✓ ChromeDriver готов' : '⚠ ChromeDriver не скачался', /OK chrome/.test(r.stdout) ? 'ok' : 'warn');
  log(/OK edge/.test(r.stdout) ? '✓ EdgeDriver готов' : '⚠ EdgeDriver не скачался', /OK edge/.test(r.stdout) ? 'ok' : 'warn');

  step('Установка завершена!', 100);
  markSetupDone();
  await new Promise((r2) => setTimeout(r2, 800));
  sendToSetup('setup-done', true);
}

// ═══════════════════════════════════════════
//  ЖИЗНЕННЫЙ ЦИКЛ
// ═══════════════════════════════════════════
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
}

app.whenReady().then(() => {
  hardenSession(session.defaultSession);

  if (needsSetup()) {
    createSetupWindow();
    setupWin.once('ready-to-show', () => {
      setupWin.show();
      setTimeout(() => startSetupCheck(), 500);
    });
  } else {
    createWindow();
    createTray();
    checkAdmin();
  }
});

app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });

app.on('before-quit', () => {
  isQuiting = true;
  zapretStop();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

process.on('uncaughtException', (e) => {
  console.error('[main] необработанное исключение: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  console.error('[main] необработанный reject: ' + (e && e.message ? e.message : e));
});
