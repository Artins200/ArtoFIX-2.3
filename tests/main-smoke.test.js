'use strict';
/* Загружаем main.js в изолированном контексте с заглушками Electron и
   проверяем, что он не падает при инициализации, регистрирует все каналы
   preload и не тянет ничего лишнего. Ловит опечатки и «мёртвые» ссылки. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf-8');

const results = [];
function test(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['fail', name + ' → ' + e.message]); }
}

// ── заглушки Electron ──
const handled = new Map();
const sendHandled = new Map();
const logs = [];

function makeElectronStub() {
  const app = {
    isPackaged: false,
    enableSandbox() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on() {}, once() {}, quit() {}, exit() {}, relaunch() {},
    getPath: () => require('os').tmpdir(),
    setPath() {},
    getVersion: () => '2.5.0',
  };
  const webContentsStub = () => ({ on() {}, send() {}, setWindowOpenHandler() {}, closeDevTools() {} });
  class BrowserWindow {
    constructor() { this.webContents = webContentsStub(); }
    loadFile() { return Promise.resolve(); }
    once() {} on() {} show() {} hide() {} focus() {} isDestroyed() { return false; }
    isMaximized() { return false; } maximize() {} unmaximize() {} minimize() {}
    static getAllWindows() { return []; }
  }
  const ipcMain = {
    handle(channel, fn) { handled.set(channel, fn); },
    on(channel, fn) { sendHandled.set(channel, fn); },
  };
  return {
    app,
    BrowserWindow,
    ipcMain,
    Tray: class { setContextMenu() {} setToolTip() {} on() {} },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    shell: { openPath: () => Promise.resolve(''), openExternal: () => Promise.resolve() },
    dialog: { showMessageBoxSync: () => 1, showMessageBox: () => Promise.resolve({ response: 1 }) },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onHeadersReceived() {}, onBeforeRequest() {} } } },
    clipboard: { writeText() {} },
  };
}

let ctx;
test('main.js выполняется без ошибок и регистрирует IPC', () => {
  const electron = makeElectronStub();
  const childProcess = {
    execFile: (_f, _a, _o, cb) => { if (typeof cb === 'function') cb(null, '', ''); return { stdout: { on() {} }, stderr: { on() {} } }; },
    spawn: () => ({ on() {}, stdout: { on() {} }, stderr: { on() {} }, unref() {}, pid: 1 }),
  };
  ctx = vm.createContext({
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    require: (mod) => {
      if (mod === 'electron') return electron;
      if (mod === 'child_process') return childProcess;
      if (mod === 'https') return require('https');
      if (mod === 'net') return require('net');
      if (mod === './security') return require(path.join(ROOT, 'security.js'));
      if (mod === './fingerprint-identity') return require(path.join(ROOT, 'fingerprint-identity.js'));
      if (mod === './package.json') return require(path.join(ROOT, 'package.json'));
      return require(mod);
    },
    process: { platform: 'win32', argv: ['electron', '.'], execPath: 'C:\\app\\artofix.exe', env: {}, pid: 1, on() {}, getuid: () => 0 },
    module: { exports: {} },
    __dirname: ROOT,
    __filename: path.join(ROOT, 'main.js'),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer, URL, JSON, Object, Array, String, Number, Math, Date, Promise, Error, RegExp,
    isNaN, parseFloat, parseInt, Uint8Array,
  });
  vm.runInContext(mainSrc, ctx, { filename: 'main.js' });
  assert.ok(handled.size > 20, 'ожидали много зарегистрированных каналов, получили ' + handled.size);
});

test('все каналы preload обрабатываются в main', () => {
  // события main→renderer идут через webContents.send, их тут не проверяем
  const events = new Set();
  const evSrc = /const EVENTS = \[([\s\S]*?)\];/.exec(preloadSrc)[1];
  evSrc.split(',').forEach((e) => {
    const v = e.trim().replace(/['"]/g, '');
    if (v) events.add(v);
  });

  const used = new Set();
  let m;
  const re = /(?:call|subscribe)\('([a-z0-9:\-]+)'/g;
  while ((m = re.exec(preloadSrc))) used.add(m[1]);
  const direct = /ipcRenderer\.send\('([^']+)'/g;
  while ((m = direct.exec(preloadSrc))) used.add(m[1]);

  const missing = [...used].filter((ch) => !events.has(ch) && !handled.has(ch) && !sendHandled.has(ch));
  assert.deepStrictEqual(missing, [], 'не обрабатываются: ' + missing.join(', '));
});

test('все события preload шлются из main', () => {
  const events = [];
  let m;
  const re = /const EVENTS = \[([\s\S]*?)\];/.exec(preloadSrc);
  assert.ok(re, 'не нашли список EVENTS в preload');
  re[1].split(',').forEach((e) => {
    const v = e.trim().replace(/['"]/g, '');
    if (v) events.push(v);
  });
  assert.ok(events.length >= 10);
  const missing = events.filter((e) => !mainSrc.includes("'" + e + "'"));
  assert.deepStrictEqual(missing, [], 'main не отправляет события: ' + missing.join(', '));
});

test('main не отправляет события без подписчиков в preload', () => {
  const sent = new Set();
  let m;
  const re = /send(?:ToSetup)?\('([a-z0-9:\-]+)'/g;
  while ((m = re.exec(mainSrc))) sent.add(m[1]);
  const preloadEvents = new Set();
  const re2 = /const EVENTS = \[([\s\S]*?)\];/.exec(preloadSrc)[1];
  re2.split(',').forEach((e) => {
    const v = e.trim().replace(/['"]/g, '');
    if (v) preloadEvents.add(v);
  });
  const unknown = [...sent].filter((s) => !preloadEvents.has(s));
  assert.deepStrictEqual(unknown, [], 'события не подписаны в preload: ' + unknown.join(', '));
});

test('main не падает при вызове обработчиков с мусорными аргументами', async () => {
  // базовые каналы должны возвращать ошибку, а не бросать исключение
  const checks = [
    ['api:open-folder', ['..\\Windows']],
    ['api:open-external', ['javascript:alert(1)']],
    ['api:launch-browser', [{ url: 'file:///etc/passwd', profile: '../x', browser: 'chrome' }]],
    ['api:create-profile', ['../../evil']],
    ['api:delete-profile', ['..']],
    ['api:write-binds', [[{ label: 'x', url: 'javascript:alert(1)', browser: 'chrome' }]]],
    ['api:hosts-write', [['evil.com\n1.2.3.4 x']]],
    ['api:cbn-ping', [{ host: 'a b', port: 99999 }]],
    ['api:cbn-set-dns', [{ dns1: '1.1.1.1; whoami', dns2: 'x' }]],
    ['api:zapret-do-update', [{ tag: '..\\evil', assetName: '../x' }]],
    ['api:preview-profile', [{ profile: '../evil' }]],
  ];
  const event = { senderFrame: { url: 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html' } };
  for (const [channel, args] of checks) {
    const fn = handled.get(channel);
    assert.ok(fn, 'нет обработчика ' + channel);
    const res = await fn(event, ...args);
    assert.ok(res && typeof res === 'object', channel + ' должен вернуть объект');
    if (res.ok === true) throw new Error(channel + ' не должен принимать мусор: ' + JSON.stringify(args));
  }
});

test('обработчики отклоняют вызов из недоверенного источника', async () => {
  const fn = handled.get('api:hosts-write-admin');
  const res = await fn({ senderFrame: { url: 'https://evil.example.com/index.html' } }, ['ads.example.com']);
  assert.strictEqual(res.ok, false);
  assert.ok(/не разрешён/i.test(res.msg || ''));
});

// ── регрессии 2.5.x: app-бинды, окно, настройки ──
test('app-бинды валидируются ДО браузерной проверки URL (регрессия steam://)', () => {
  const fn = /async function launchBrowser\([\s\S]*?\n\}/.exec(mainSrc);
  assert.ok(fn, 'launchBrowser не найден');
  const appIdx = fn[0].indexOf("safeBrowser === 'app'");
  // ищем реальный вызов, а не упоминание в комментарии
  const browseIdx = fn[0].indexOf('sec.sanitizeBrowseUrl');
  assert.ok(appIdx !== -1, 'ветка browser=app исчезла');
  assert.ok(browseIdx !== -1, 'ветка браузерного URL исчезла');
  assert.ok(appIdx < browseIdx,
    'sec.sanitizeBrowseUrl(http/https) выполняется раньше app-ветки — steam://-бинды снова отобьются');
  const tray = /function launchBindFromTray\([\s\S]*?\n\}/.exec(mainSrc);
  assert.ok(tray, 'launchBindFromTray не найден');
  assert.ok(tray[0].indexOf("browser === 'app'") < tray[0].indexOf('sec.sanitizeBrowseUrl'),
    'в tray-запуске биндов app-ветка снова после браузерной проверки');
});

test('sanitizeBinds сохраняет steam:// и пути .exe/.lnk, отбивает javascript:', () => {
  const out = ctx.sanitizeBinds([
    { id: 1, label: 'Steam', url: 'steam://rungameid/431960', browser: 'app', bypass: true },
    { id: 2, label: 'Game', url: 'C:\\Games\\game.exe', browser: 'app' },
    { id: 3, label: 'bad', url: 'javascript:alert(1)', browser: 'chrome' },
    { id: 4, label: 'bad2', url: 'C:\\Windows\\evil.bat', browser: 'app' },
  ]);
  assert.strictEqual(out.length, 2, 'ожидали 2 валидных бинда, получили ' + out.length);
  assert.strictEqual(out[0].url, 'steam://rungameid/431960');
  assert.strictEqual(out[0].bypass, true);
  assert.strictEqual(out[1].url, 'C:\\Games\\game.exe');
});

test('sanitizeSettings хранит скругление/прозрачность окна и авто-обход', () => {
  const s = ctx.sanitizeSettings({
    theme: 'th-mint', uiScale: '1.2', winOpacity: '0.75', winRadius: '14', autoBypass: false,
  });
  assert.strictEqual(s.winOpacity, '0.75');
  assert.strictEqual(s.winRadius, '14');
  assert.strictEqual(s.autoBypass, false);
  const junk = ctx.sanitizeSettings({ winOpacity: '5', winRadius: '999', autoBypass: 'yes' });
  assert.strictEqual(junk.winOpacity, undefined);
  assert.strictEqual(junk.winRadius, undefined);
  assert.strictEqual(junk.autoBypass, undefined);
});

test('главное окно прозрачное, а состояние maximize уходит в рендерер', () => {
  assert.ok(/transparent:\s*true/.test(mainSrc), 'окно не прозрачное — скругления CSS не будут видны');
  assert.ok(/hasShadow:\s*false/.test(mainSrc), 'у прозрачного окна должна быть отключена системная тень');
  assert.ok(mainSrc.includes("'win-maximized'"), 'main не сообщает рендереру о maximize/unmaximize');
});

test('в main нет ссылок на удалённые функции (свободный exec)', () => {
  const code = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.strictEqual(/\bexec\b\s*\(/.test(code), false);
  assert.ok(!/ipcRenderer/.test(code), 'main не должен трогать ipcRenderer');
});

const failed = results.filter((r) => r[0] === 'fail');
results.forEach((r) => console.log((r[0] === 'ok' ? '  ✓ ' : '  ✗ ') + r[1]));
console.log('\nmain-smoke: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено');
process.exit(failed.length ? 1 : 0);
