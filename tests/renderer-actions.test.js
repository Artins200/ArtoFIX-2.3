'use strict';
/* Регрессия на класс багов «присваивание без var в строгом режиме».

   История: в renderHostsList() строка
       row_el = afEl('div', …)          // ← нет var
   в файле с 'use strict' бросала «ReferenceError: row_el is not defined»
   при КАЖДОМ вызове, поэтому кнопка пресета молча ничего не делала,
   а в терминал main-процесса сыпалось
       [renderer:error] [renderer:action] addPreset: row_el is not defined

   В отличие от wiring.test.js, здесь DOM-заглушка умеет возвращать элементы
   из getElementById(), поэтому renderHostsList()/addPreset() действительно
   выполняются до конца, а не выходят по «if (!el) return».

   Плюс статический сторож: в app.js не осталось присваиваний
   необъявленным идентификаторам (тот же баг в другом месте файла). */

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

// ── минимальный, но работающий DOM ─────────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = { cssText: '', setProperty() {} };
    this._text = '';
    this.className = '';
    this.listeners = {};
    this.disabled = false;
  }
  // как в настоящем DOM: запись textContent вычищает детей
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  remove() { this._removed = true; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  classList = {
    add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
  };
}

/** Загружает рендерер и отдаёт контекст + реестр элементов по id. */
function loadApp(file) {
  const byId = {};
  const get = (id) => {
    if (!(id in byId)) byId[id] = new El('div');
    return byId[id];
  };

  const listeners = {};
  const documentStub = {
    readyState: 'loading',
    body: new El('body'),
    documentElement: new El('html'),
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    getElementById: get,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(t) { return new El(t); },
    createTextNode(t) { return { text: t, nodeType: 3 }; },
    createDocumentFragment() { return new El('#fragment'); },
    fonts: { check() { return false; } },
  };

  const apiStub = {
    ready: true, platform: 'win32', version: '2.3.1',
    calls: {},                     // метод → массив аргументов (для проверки вызовов из консоли)
    _record(f, impl) {
      apiStub.calls[f] = [];
      apiStub[f] = function () {
        apiStub.calls[f].push(Array.prototype.slice.call(arguments));
        return impl.apply(null, arguments);
      };
    },
  };
  ['listProfiles', 'createProfile', 'deleteProfile', 'readProfileMeta', 'writeProfileMeta',
    'readConfig', 'writeConfig', 'readSettings', 'writeSettings', 'readBinds', 'writeBinds',
    'hostsRead', 'hostsWrite', 'hostsWriteAdmin', 'previewProfile', 'rerollProfile', 'reportError',
    'readLogs', 'clearLogs', 'closeBrowsers', 'killWinws', 'launchBrowser', 'openExternal',
    'openFolder', 'zapretService', 'zapretStart', 'zapretStop', 'zapretVersion', 'zapretCheckUpdate',
    'zapretDoUpdate', 'diagCheck', 'diagInstall', 'ublockCheck', 'ublockInstall', 'cbnPing',
    'cbnSetDns', 'cbnResetDns', 'copyLogs', 'getIconUrl', 'refreshTray', 'listCountries'].forEach((f) => {
      apiStub._record(f, () => Promise.resolve({ ok: true }));
    });
  ['onLogEntry', 'onZapretStatus', 'onZapretProgress', 'onDiagLog', 'onDiagProgress', 'onTrayAction',
    'onNavigate', 'onBootstrap', 'onSetupStep', 'onSetupLog', 'onSetupError', 'onSetupRestart',
    'onSetupDone'].forEach((f) => { apiStub[f] = () => () => {}; });

  const windowStub = {
    document: documentStub,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    navigator: { userAgent: 'test' },
    location: { href: 'file:///app/index.html' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    innerWidth: 1280, innerHeight: 720, focus() {},
  };
  Object.defineProperty(windowStub, 'api', { value: Object.freeze(apiStub), writable: false, configurable: false });
  windowStub.window = windowStub;

  const ctx = vm.createContext(Object.assign(windowStub, {
    document: documentStub, navigator: windowStub.navigator, localStorage: windowStub.localStorage,
    requestAnimationFrame: windowStub.requestAnimationFrame, getComputedStyle: windowStub.getComputedStyle,
    setTimeout, clearTimeout, setInterval, clearInterval, console, Math, JSON, Object, Array, String,
    Number, Date, Promise, Error, RegExp, isNaN, parseFloat, parseInt, encodeURIComponent,
    decodeURIComponent, Boolean,
  }));
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf-8'), ctx, { filename: file });
  return { ctx, byId, apiStub };
}

// ── 1. Сама регрессия: renderHostsList() должен отрисовать строки ──
test('renderHostsList() не бросает «row_el is not defined» и рисует строки', () => {
  const { ctx, byId } = loadApp('app.js');
  ctx.HOSTS_DOMAINS = ['example.com', 'tracker.test'];
  assert.doesNotThrow(() => ctx.renderHostsList(), 'renderHostsList упал');

  const list = byId['hosts-list'];
  assert.strictEqual(list.children.length, 2, 'ожидали 2 строки, получили ' + list.children.length);
  assert.strictEqual(byId['hosts-count'].textContent, '2', 'счётчик доменов не обновлён');
});

test('addPreset() добавляет домены пресета и перерисовывает список', () => {
  const { ctx, byId } = loadApp('app.js');
  const preset = ctx.AD_PRESETS.google_ads;
  assert.ok(Array.isArray(preset) && preset.length > 0, 'нет пресета google_ads');

  ctx.HOSTS_DOMAINS = [];
  assert.doesNotThrow(() => ctx.addPreset('google_ads'), 'addPreset упал');

  assert.strictEqual(ctx.HOSTS_DOMAINS.length, preset.length,
    'домены пресета не добавились: ' + ctx.HOSTS_DOMAINS.length + ' из ' + preset.length);
  assert.strictEqual(byId['hosts-list'].children.length, preset.length,
    'список не перерисован под все домены');
});

test('addPreset() не плодит дубликаты при повторном вызове', () => {
  const { ctx } = loadApp('app.js');
  ctx.HOSTS_DOMAINS = [];
  ctx.addPreset('yandex_ads');
  const first = ctx.HOSTS_DOMAINS.length;
  ctx.addPreset('yandex_ads');
  assert.strictEqual(ctx.HOSTS_DOMAINS.length, first, 'пресет добавил дубликаты');
});

test('removeDomain() удаляет домен и обновляет счётчик', () => {
  const { ctx, byId } = loadApp('app.js');
  ctx.HOSTS_DOMAINS = ['a.test', 'b.test', 'c.test'];
  ctx.removeDomain(1);
  assert.deepStrictEqual(ctx.HOSTS_DOMAINS, ['a.test', 'c.test']);
  assert.strictEqual(byId['hosts-list'].children.length, 2);
  assert.strictEqual(byId['hosts-count'].textContent, '2');
});

test('пустой список доменов рисует подсказку, а не падает', () => {
  const { ctx, byId } = loadApp('app.js');
  ctx.HOSTS_DOMAINS = [];
  assert.doesNotThrow(() => ctx.renderHostsList());
  assert.strictEqual(byId['hosts-list'].children.length, 1, 'нет строки-подсказки');
});

// ── 2. Статический сторож на весь класс багов ──
// Присваивание необъявленному идентификатору в 'use strict' = ReferenceError.
// Такие строки не видны при загрузке файла (ошибка всплывает только при вызове
// функции), поэтому проверяем статически.
test('в app.js нет присваиваний необъявленным идентификаторам (implicit globals)', () => {
  const src = read('app.js');
  assert.ok(/^\s*['"]use strict['"]/.test(src), 'app.js должен оставаться в строгом режиме');

  const declared = new Set();
  let m;
  const declRe = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(src))) declared.add(m[1]);
  const fnRe = /function\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g;
  while ((m = fnRe.exec(src))) {
    if (m[1]) declared.add(m[1]);
    m[2].split(',').forEach((p) => {
      const name = p.trim().split('=')[0].trim();
      if (name) declared.add(name);
    });
  }
  ['window', 'document', 'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
    'Date', 'Promise', 'Error', 'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'setTimeout',
    'clearTimeout', 'setInterval', 'clearInterval', 'undefined', 'null', 'true', 'false',
    'arguments', 'api', 'apiBridge'].forEach((g) => declared.add(g));

  const bad = [];
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) return;
    const a = /^([A-Za-z_$][\w$]*)\s*=[^=]/.exec(t);
    if (a && !declared.has(a[1])) bad.push('app.js:' + (i + 1) + '  ' + t.slice(0, 70));
  });
  assert.deepStrictEqual(bad, [], 'найдены неявные глобальные переменные:\n' + bad.join('\n'));
});

// ── 3. Диагностика должна указывать на место падения, а не на репортёр ──
// Раньше в терминал уходило «… (app.js:87)» — это строка console.error внутри
// afReportError, т.е. место бесполезное. Теперь диспетчер прикладывает кадр стека.
test('диспетчер действий прикладывает кадр стека места падения', () => {
  const src = read('app.js');
  const dispatch = /function afDispatch[\s\S]*?\n\}/.exec(src);
  assert.ok(dispatch, 'afDispatch не найден');
  assert.ok(/afErrFrame|err\.stack/.test(dispatch[0]),
    'afDispatch не передаёт стек: в логе снова будет только строка репортёра');
});

// ── 4. Консоль «Классика»: реальное исполнение команд против моста ──
// Консоль — не shell: проверяем, что команды проходят только через мост api
// и что мостовые вызовы честно формируются (правильные аргументы, валидация).
const consoleTests = [];
function ctest(name, fn) { consoleTests.push([name, fn]); }

function makeConsoleEnv() {
  const { ctx, byId, apiStub } = loadApp('app.js');
  ctx.initConsole();
  return { ctx, byId, apiStub, out: byId['console-out'], inp: byId['console-in'] };
}
function lastLines(out, n) {
  return out.children.slice(-n).map((c) => c.textContent).join('\n');
}

ctest('консоль: init + help печатает команды и не падает', async () => {
  const { ctx, out } = makeConsoleEnv();
  assert.ok(out.children.length > 0, 'нет приветствия');
  await ctx.consoleExec('help');
  const text = lastLines(out, 40);
  for (const cmd of ['profiles', 'country <профиль> <ISO|->', 'open <профиль>', 'countries', 'help']) {
    assert.ok(text.includes(cmd.split(' ')[0]), 'в help нет команды: ' + cmd);
  }
});

ctest('консоль: mkprofile/rmprofile проходят в мост с правильным именем', async () => {
  const { ctx, apiStub } = makeConsoleEnv();
  await ctx.consoleExec('mkprofile yt-test');
  assert.strictEqual(apiStub.calls.createProfile.length, 1);
  assert.strictEqual(apiStub.calls.createProfile[0][0], 'yt-test');
  await ctx.consoleExec('rmprofile yt-test');
  assert.strictEqual(apiStub.calls.deleteProfile[0][0], 'yt-test');
});

ctest('консоль: country c валидным ISO пишет meta, с мусором — отказ без записи', async () => {
  const { ctx, apiStub, out } = makeConsoleEnv();
  ctx.CONSOLE_COUNTRY_CACHE = [{ code: 'RU', name: 'Россия', flag: '', region: 'Europe', currency: 'RUB', cities: 5 }];
  await ctx.consoleExec('country prof1 RU');
  assert.strictEqual(apiStub.calls.writeProfileMeta.length, 1, 'валидная страна не записана');
  assert.strictEqual(apiStub.calls.writeProfileMeta[0][0], 'prof1');
  assert.strictEqual(apiStub.calls.writeProfileMeta[0][1].country, 'RU');

  await ctx.consoleExec('country prof1 xx');
  assert.strictEqual(apiStub.calls.writeProfileMeta.length, 1, 'мусорный код страны должен быть отклонён ДО моста');
  assert.ok(lastLines(out, 3).includes('Неизвестная страна'));

  await ctx.consoleExec('country prof1 -');
  assert.strictEqual(apiStub.calls.writeProfileMeta[1][1].country, '', 'сброс в авто не дошёл до моста');
});

ctest('консоль: open валидирует браузер и схему url', async () => {
  const { ctx, apiStub, out } = makeConsoleEnv();
  await ctx.consoleExec('open prof1 https://example.test');
  assert.strictEqual(apiStub.calls.launchBrowser.length, 1);
  assert.strictEqual(apiStub.calls.launchBrowser[0][0].url, 'https://example.test');
  assert.strictEqual(apiStub.calls.launchBrowser[0][0].browser, 'chrome');

  await ctx.consoleExec('open prof1 https://example.test iexplore');
  assert.strictEqual(apiStub.calls.launchBrowser.length, 1, 'левый браузер должен быть отклонён');
  assert.ok(lastLines(out, 2).includes('chrome|msedge|firefox|yandex'));

  await ctx.consoleExec('open prof1 file:///etc/passwd');
  assert.strictEqual(apiStub.calls.launchBrowser.length, 1, 'схема file:// должна быть отклонена');
  assert.ok(lastLines(out, 2).includes('http(s)'));
});

ctest('консоль: ping нормализует порт по умолчанию', async () => {
  const { ctx, apiStub } = makeConsoleEnv();
  await ctx.consoleExec('ping www.youtube.com');
  assert.strictEqual(apiStub.calls.cbnPing.length, 1);
  assert.strictEqual(apiStub.calls.cbnPing[0][0].host, 'www.youtube.com');
  assert.strictEqual(apiStub.calls.cbnPing[0][0].port, 443);
});

ctest('консоль: история команд запоминается и листается', async () => {
  const { ctx, inp } = makeConsoleEnv();
  inp.value = 'help'; ctx.consoleRun();
  inp.value = 'version'; ctx.consoleRun();
  // vm-контекст отдаёт чужой Array — сравниваем по содержимому, не по ссылке
  assert.strictEqual(Array.prototype.join.call(ctx.CONSOLE_HISTORY, ','), 'help,version');
  assert.strictEqual(inp.value, '', 'поле ввода не очищено после выполнения');
});

ctest('консоль: неизвестная команда не падает и подсказывает help', async () => {
  const { ctx, out } = makeConsoleEnv();
  await ctx.consoleExec('definitely-not-a-command');
  assert.ok(lastLines(out, 2).includes('Неизвестная команда'));
});

(async () => {
  for (const [name, fn] of consoleTests) {
    try { await fn(); results.push(['ok', name]); }
    catch (e) { results.push(['fail', name + ' → ' + e.message]); }
  }
  let failed = 0;
  for (const [status, name] of results) {
    if (status === 'fail') failed++;
    console.log((status === 'ok' ? '  ✓ ' : '  ✗ ') + name);
  }
  console.log('\nrenderer-actions: ' + (results.length - failed) + '/' + results.length + ' проверок пройдено');
  process.exit(failed ? 1 : 0);
})();
