'use strict';
/* Проверяем, что вся цепочка «разметка → рендерер → preload → main»
   согласована после перехода на CSP без inline-скриптов:

     1. в HTML не осталось inline-обработчиков и inline-скриптов;
     2. каждое data-af-action существует в рендерере;
     3. каждый api.* вызов рендерера есть в preload;
     4. каждый канал preload зарегистрирован в main;
     5. рендерер не тянет Node (require/process/__dirname). */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf-8');

const results = [];
function test(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['fail', name + ' → ' + e.message]); }
}

const indexHtml = read('index.html');
const setupHtml = read('setup.html');
const appJs = read('app.js');
const setupJs = read('setup.js');
const preloadJs = read('preload.js');
const mainJs = read('main.js');

// ── 1. Разметка: никаких inline-скриптов и обработчиков ──
test('в HTML нет inline-обработчиков on*=', () => {
  for (const [name, html] of [['index.html', indexHtml], ['setup.html', setupHtml]]) {
    const found = html.match(/\son(?:click|change|input|mouseover|mouseout|keydown|keyup|submit|dblclick|focus|blur)\s*=/gi);
    assert.strictEqual(found, null, name + ': остались inline-обработчики ' + (found || []).join(', '));
  }
});

test('в HTML нет инлайновых <script> (только внешние файлы)', () => {
  for (const [name, html] of [['index.html', indexHtml], ['setup.html', setupHtml]]) {
    const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html);
    assert.strictEqual(inline, false, name + ': найден инлайновый скрипт');
  }
});

test('в HTML нет ссылок на внешние CDN (шрифты/CDN-скрипты)', () => {
  assert.strictEqual(/fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.|unpkg|jsdelivr/i.test(indexHtml + setupHtml), false,
    'внешние подключения запрещены CSP и политикой приложения');
});

// ── 2. data-af-action → AF_ACTIONS рендерера ──
// frozenApi моделирует contextBridge.exposeInMainWorld('api', …): в реальном
// Electron свойство window.api read-only и не конфигурируемое, поэтому любой
// «var api = …» в строгом режиме бросает TypeError. Раньше это роняло весь рендерер.
function loadRenderer(file, apiStub, frozenApi) {
  const listeners = {};
  const stubEl = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {},
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getContext() { return { clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, getImageData() { return { data: [] }; } }; },
    width: 0, height: 0, textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
  });
  const documentStub = {
    readyState: 'loading',
    body: stubEl(),
    documentElement: stubEl(),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return stubEl(); },
    createTextNode(t) { return { text: t }; },
    createDocumentFragment() { return stubEl(); },
    fonts: { check() { return false; } },
  };
  const windowStub = {
    document: documentStub,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    navigator: { userAgent: 'test' },
    location: { href: 'file:///app/index.html' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    innerWidth: 1280, innerHeight: 720,
    focus() {},
  };
  // Use Electron's frozen, non-writable bridge for ordinary renderer tests too.
  if (apiStub !== undefined && !frozenApi) {
    Object.defineProperty(windowStub, 'api', {
      value: Object.freeze(apiStub), writable: false, configurable: false, enumerable: true,
    });
  }
  windowStub.window = windowStub;
  const ctx = vm.createContext(Object.assign(windowStub, {
    document: documentStub, navigator: windowStub.navigator, localStorage: windowStub.localStorage,
    requestAnimationFrame: windowStub.requestAnimationFrame, getComputedStyle: windowStub.getComputedStyle,
    setTimeout, clearTimeout, setInterval, clearInterval, console, Math, JSON, Object, Array, String, Number,
    Date, Promise, Error, RegExp, isNaN, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
  }));
  if (frozenApi) {
    Object.freeze(apiStub);
    // как contextBridge.exposeInMainWorld('api', Object.freeze(…)):
    // чтение работает, а присваивание read-only свойству в строгом режиме бросает
    Object.defineProperty(ctx, 'api', {
      get() { return apiStub; },
      set() { throw new TypeError("Cannot assign to read only property 'api' of object '#<Window>'"); },
      configurable: false,
      enumerable: true,
    });
  }
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf-8'), ctx, { filename: file });
  return ctx;
}

// заглушка api со всеми методами, которые рендерер может вызвать
function apiStub() {
  const fns = ['getIconUrl', 'winAct', 'toggleMaximize', 'openFolder', 'zapretService', 'refreshTray',
    'closeBrowsers', 'killWinws', 'launchBrowser', 'openExternal', 'zapretStart', 'zapretStop',
    'zapretVersion', 'zapretCheckUpdate', 'zapretDoUpdate', 'listProfiles', 'createProfile', 'deleteProfile',
    'readProfileMeta', 'writeProfileMeta', 'readConfig', 'writeConfig', 'readSettings', 'writeSettings',
    'readBinds', 'writeBinds', 'hostsRead', 'hostsWrite', 'hostsWriteAdmin', 'ublockCheck', 'ublockInstall',
    'diagCheck', 'diagInstall', 'cbnPing', 'cbnSetDns', 'cbnResetDns', 'cbnFixWarp', 'cbnTestWarp', 'readLogs', 'clearLogs', 'copyLogs',
    'previewProfile', 'rerollProfile', 'reportError', 'skipSetup', 'setupOpenMain', 'setupConfirmInstall'];
  const subs = ['onLogEntry', 'onZapretStatus', 'onZapretProgress', 'onDiagLog', 'onDiagProgress',
    'onTrayAction', 'onNavigate', 'onBootstrap', 'onSetupStep', 'onSetupLog', 'onSetupError',
    'onSetupRestart', 'onSetupDone', 'onSetupHw', 'onSetupAskPerm'];
  const api = { ready: true, platform: 'linux', version: '2.5.0' };
  fns.forEach((f) => { api[f] = () => Promise.resolve({}); });
  subs.forEach((f) => { api[f] = () => () => {}; });
  return api;
}

let rendererCtx;
test('app.js загружается без Node и без исключений', () => {
  rendererCtx = loadRenderer('app.js', apiStub());
});

// Регрессия: contextBridge делает window.api read-only. «var api = window.api» в строгом
// режиме бросает «Cannot assign to read only property 'api'» и ронял весь рендерер.
test('рендереры не перезаписывают read-only мост window.api', () => {
  for (const f of ['app.js', 'setup.js']) {
    assert.doesNotThrow(() => loadRenderer(f, apiStub(), true),
      f + ': попытка присвоить read-only window.api (TypeError)');
  }
});

test('оба рендерера сохраняют read-only мост preload и используют отдельный alias', () => {
  for (const file of ['app.js', 'setup.js']) {
    const bridge = apiStub();
    const ctx = loadRenderer(file, bridge);
    assert.strictEqual(ctx.api, bridge, file + ': мост заменён');
    assert.strictEqual(ctx.apiBridge, bridge, file + ': alias не указывает на мост');
    const descriptor = Object.getOwnPropertyDescriptor(ctx, 'api');
    assert.strictEqual(descriptor.writable, false);
    assert.strictEqual(descriptor.configurable, false);
    assert.ok(Object.isFrozen(bridge));
    // VM globals do not always throw on writes like Chromium's Window does.
    assert.strictEqual(/^\s*(?:var|let|const)\s+api\b/m.test(read(file)), false,
      file + ': глобальное объявление конфликтует с window.api');
  }
});

test('app.js использует локальную заглушку без замены window.api', () => {
  for (const bridge of [undefined, { ready: false }]) {
    const ctx = loadRenderer('app.js', bridge);
    assert.strictEqual(ctx.API_READY, false);
    assert.strictEqual(ctx.api, bridge);
    assert.strictEqual(ctx.apiBridge.ready, false);
    assert.notStrictEqual(ctx.apiBridge, bridge);
    assert.strictEqual(typeof ctx.apiBridge.onNavigate(), 'function');
    if (bridge === undefined) assert.strictEqual(Object.hasOwn(ctx, 'api'), false);
  }
});

test('каждое data-af-action из index.html есть в AF_ACTIONS', () => {
  const actions = new Set();
  const re = /data-af-action="([A-Za-z_$][\w$]*)"/g;
  let m;
  while ((m = re.exec(indexHtml))) actions.add(m[1]);
  assert.ok(actions.size > 40, 'похоже, разметка не размечена: ' + actions.size);
  const registry = rendererCtx.AF_ACTIONS;
  assert.ok(registry && typeof registry === 'object', 'AF_ACTIONS не определён');
  const missing = [...actions].filter((a) => typeof registry[a] !== 'function');
  assert.deepStrictEqual(missing, [], 'нет обработчиков для: ' + missing.join(', '));
});

test('в строках-шаблонах рендерера нет inline-обработчиков', () => {
  const found = appJs.match(/\son(?:click|change|input|mouseover|mouseout|keydown|submit)\s*=/gi);
  assert.strictEqual(found, null, 'в app.js остались inline-обработчики: ' + (found || []).join(', '));
});

test('шаблоны модалок проходят проверку openModal и их data-af-args валидны', () => {
  let captured = null;
  rendererCtx.openModal = (html) => { captured = html; };
  rendererCtx.openCreateProfileModal();
  assert.ok(captured, 'openCreateProfileModal не собрал разметку');

  // модалка не должна быть заблокирована собственным фильтром
  assert.strictEqual(rendererCtx.MODAL_FORBIDDEN.test(captured), false,
    'шаблон модалки заблокирован MODAL_FORBIDDEN');

  const pairs = captured.match(/data-af-action="([^"]+)"(?:\s+data-af-args="([^"]*)")?/g) || [];
  assert.ok(pairs.length >= 4, 'в модалке нет data-af-атрибутов');
  pairs.forEach((p) => {
    const m = /data-af-action="([^"]+)"(?:\s+data-af-args="([^"]*)")?/.exec(p);
    const action = m[1];
    assert.ok(typeof rendererCtx.AF_ACTIONS[action] === 'function', 'нет действия ' + action);
    if (m[2]) {
      const decoded = m[2].replace(/&quot;/g, '"');
      const parsed = JSON.parse(decoded);           // упадёт, если кавычки в шаблоне поломаны
      assert.ok(Array.isArray(parsed));
    }
  });
});

test('рендерер не использует require/process/__dirname', () => {
  for (const f of ['app.js', 'setup.js']) {
    const src = read(f);
    // разрешаем упоминания в комментариях — ищем реальные вызовы
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.strictEqual(/\brequire\s*\(/.test(code), false, f + ': найден require(');
    assert.strictEqual(/\bprocess\.(env|argv|mainModule|binding)/.test(code), false, f + ': найден process.*');
    assert.strictEqual(/__dirname|__filename/.test(code), false, f + ': найден __dirname');
    assert.strictEqual(/\beval\s*\(|new Function\s*\(/.test(code), false, f + ': найден eval/Function');
  }
});

test('рендерер не вставляет данные через innerHTML', () => {
  // разрешаем только литеральные присваивания и очистку текста;
  // всё, что содержит переменные, должно идти через textContent/afEl()
  const suspects = [];
  const lines = appJs.split('\n');
  lines.forEach((line, i) => {
    if (/af-allow-innerhtml/.test(line)) return;          // осознанное исключение
    const m = /\.innerHTML\s*=\s*(.+?);\s*$/.exec(line.trim());
    if (!m) return;
    const value = m[1];
    const literal = /^(['"])(?:[^'"]*)\1$/.test(value) || value === "''" || value === '""';
    if (!literal) suspects.push('app.js:' + (i + 1) + ' ' + line.trim());
  });
  assert.deepStrictEqual(suspects, [], 'данные уходят в innerHTML:\n' + suspects.join('\n'));
});

// ── 3. preload: поверхность API ──
function loadPreload() {
  let exposed = null;
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, obj) => { exposed = { name, obj }; } },
    ipcRenderer: {
      invoke: () => Promise.resolve({}), send() {},
      on() {}, removeListener() {},
    },
  };
  const ctx = vm.createContext({
    require: (mod) => {
      assert.strictEqual(mod, 'electron', 'preload обязан требовать только electron, а не ' + mod);
      return electronStub;
    },
    console, Object, JSON, Promise, Number, Array, String, Math, RegExp, isNaN, parseFloat,
    process: { platform: 'win32' },
  });
  vm.runInContext(preloadJs, ctx, { filename: 'preload.js' });
  return exposed;
}

let bridge;
test('preload отдаёт ровно один мост window.api', () => {
  bridge = loadPreload();
  assert.ok(bridge, 'contextBridge.exposeInMainWorld не вызван');
  assert.strictEqual(bridge.name, 'api');
  assert.strictEqual(bridge.obj.ready, true);
});

test('все api.* вызовы рендерера есть в preload', () => {
  const used = new Set();
  for (const f of ['app.js', 'setup.js']) {
    // только вызовы вида apiBridge.method( / api.method( — и не внутри строк-доменов вроде 'api.amplitude.com'
    const re = /(?:^|[^'"\w.])apiBridge\.([A-Za-z_$][\w$]*)\s*\(|(?:^|[^'"\w.])api\.([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(read(f)))) used.add(m[1] || m[2]);
  }
  const missing = [...used].filter((u) => bridge.obj[u] === undefined);
  assert.deepStrictEqual(missing, [], 'preload не отдаёт: ' + missing.join(', '));
});

test('preload не отдаёт ничего лишнего (список каналов фиксирован)', () => {
  const dangerous = ['invoke', 'send', 'on', 'ipcRenderer', 'require', 'sendSync', 'postMessage'];
  dangerous.forEach((d) => assert.strictEqual(bridge.obj[d], undefined, 'наружу ушёл ' + d));
});

// ── 4. каналы preload ↔ main ──
test('каждый канал preload зарегистрирован в main', () => {
  const used = new Set();
  const re = /(?:call|subscribe)\('([a-z0-9:\-]+)'/g;
  let m;
  while ((m = re.exec(preloadJs))) used.add(m[1]);
  // api:report-error отправляется напрямую через ipcRenderer.send
  const directSend = /ipcRenderer\.send\('([^']+)'/g;
  while ((m = directSend.exec(preloadJs))) used.add(m[1]);

  const missing = [...used].filter((ch) => !mainJs.includes("'" + ch + "'"));
  assert.deepStrictEqual(missing, [], 'main не обрабатывает каналы: ' + missing.join(', '));
});

test('в main нет свободного exec и shell-строк', () => {
  const code = mainJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.strictEqual(/\bexec\s*\(/.test(code), false, 'в main остался child_process.exec');
  assert.strictEqual(/\bshell\s*:\s*true/.test(code), false, 'найден запуск с shell: true');
  assert.strictEqual(/ipcMain\.on\(\s*'cmd'/.test(code), false, 'вернулся канал cmd');
  assert.ok(/execFile/.test(code), 'нужны только execFile/spawn с argv-массивами');
});

test('main включает песочницу и отключает Node в рендерере', () => {
  assert.ok(/app\.enableSandbox\(\)/.test(mainJs), 'нет app.enableSandbox()');
  assert.ok(/nodeIntegration:\s*false/.test(mainJs));
  assert.ok(/contextIsolation:\s*true/.test(mainJs));
  assert.ok(/sandbox:\s*true/.test(mainJs));
  assert.ok(/webSecurity:\s*true/.test(mainJs));
  assert.ok(/webviewTag:\s*false/.test(mainJs));
  assert.ok(/Content-Security-Policy/.test(mainJs), 'нет CSP-заголовка');
  assert.ok(/setWindowOpenHandler/.test(mainJs), 'нет запрета новых окон');
  assert.ok(/will-navigate/.test(mainJs), 'нет запрета навигации');
});

const failed = results.filter((r) => r[0] === 'fail');
results.forEach((r) => console.log((r[0] === 'ok' ? '  ✓ ' : '  ✗ ') + r[1]));
console.log('\nwiring: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено');
process.exit(failed.length ? 1 : 0);
