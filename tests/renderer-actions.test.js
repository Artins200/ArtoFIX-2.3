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
  // classList ведёт себя как настоящий: классы реально добавляются/снимаются.
  // Нужно для проверок вида app.classList.contains('has-bg-image') —
  // именно этот класс включает «стекло» панелей поверх фон-картинки.
  classList = (() => {
    const set = new Set();
    const sync = () => { this.className = Array.from(set).join(' '); };
    return {
      add: (...c) => { c.forEach((x) => set.add(x)); sync(); },
      remove: (...c) => { c.forEach((x) => set.delete(x)); sync(); },
      toggle: (c) => { if (set.has(c)) set.delete(c); else set.add(c); sync(); },
      contains: (c) => set.has(c),
    };
  })();
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
    ready: true, platform: 'win32', version: '2.5.0',
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
    'cbnSetDns', 'cbnResetDns', 'cbnFixWarp', 'cbnTestWarp', 'copyLogs', 'getIconUrl', 'refreshTray', 'listCountries',
    'setupConfirmInstall', 'skipSetup', 'setupOpenMain'].forEach((f) => {
      apiStub._record(f, () => Promise.resolve({ ok: true }));
    });
  ['onLogEntry', 'onZapretStatus', 'onZapretProgress', 'onDiagLog', 'onDiagProgress', 'onTrayAction',
    'onNavigate', 'onBootstrap', 'onSetupStep', 'onSetupLog', 'onSetupError', 'onSetupRestart',
    'onSetupDone', 'onSetupHw', 'onSetupAskPerm', 'onCfWarning'].forEach((f) => { apiStub[f] = () => () => {}; });

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

ctest('консоль: warp fix и warp test дергают cbnFixWarp / cbnTestWarp', async () => {
  const { ctx, apiStub } = makeConsoleEnv();
  await ctx.consoleExec('warp fix');
  assert.strictEqual(apiStub.calls.cbnFixWarp.length, 1);
  await ctx.consoleExec('warp test');
  assert.strictEqual(apiStub.calls.cbnTestWarp.length, 1);
});

ctest('AF_ACTIONS содержит новые действия cbnFixWarp, cbnTestWarp, open/saveProfileCountryModal', () => {
  const { ctx } = loadApp('app.js');
  assert.strictEqual(typeof ctx.AF_ACTIONS.cbnFixWarp, 'function');
  assert.strictEqual(typeof ctx.AF_ACTIONS.cbnTestWarp, 'function');
  assert.strictEqual(typeof ctx.AF_ACTIONS.openProfileCountryModal, 'function');
  assert.strictEqual(typeof ctx.AF_ACTIONS.saveProfileCountryModal, 'function');
});

// ── 5. Внешний вид: цвета поверх темы, масштаб, скругление/прозрачность окна ──
// Регрессия «выбрал тему — цвета не меняются»: темы объявлены как body.th-*{--ac:…},
// поэтому кастомный акцент обязан писаться ИНЛАЙНОМ на <body>, иначе проигрывает теме.
test('applyColors пишет акценты инлайном на body — перебивает переменные темы', () => {
  const { ctx } = loadApp('app.js');
  const bodyVars = {}, rootVars = {};
  ctx.document.body.style.setProperty = (k, v) => { bodyVars[k] = v; };
  ctx.document.documentElement.style.setProperty = (k, v) => { rootVars[k] = v; };
  ctx.applyColors('#ff0000', '#00ff00');
  assert.strictEqual(bodyVars['--ac'], '#ff0000', 'акцент не записан на body — тема его перебьёт');
  assert.strictEqual(bodyVars['--acr'], '255,0,0');
  assert.strictEqual(bodyVars['--ac2'], '#00ff00');
  assert.strictEqual(bodyVars['--ac2r'], '0,255,0');
  assert.strictEqual(rootVars['--ac'], '#ff0000');
});

test('applyColors отбивает мусор вместо битого CSS', () => {
  const { ctx } = loadApp('app.js');
  const bodyVars = {};
  ctx.document.body.style.setProperty = (k, v) => { bodyVars[k] = v; };
  ctx.applyColors('javascript:alert(1)', null);
  assert.strictEqual(bodyVars['--ac'], '#4f46e5');
  assert.strictEqual(bodyVars['--ac2'], '#8b5cf6');
});

test('setTheme снимает кастомные цвета и подставляет акценты темы в инпуты', () => {
  const { ctx, byId } = loadApp('app.js');
  ctx.document.getElementById('color-accent');
  ctx.document.getElementById('color-accent2');
  const removed = [];
  ctx.document.body.style.removeProperty = (k) => removed.push(k);
  ctx.document.documentElement.style.removeProperty = (k) => removed.push('root:' + k);
  ctx.APP_SETTINGS = { colors: { ac: '#ff0000', ac2: '#00ff00' } };
  ctx.setTheme('th-mint');
  assert.ok(removed.includes('--ac') && removed.includes('--acr'),
    'инлайновые акценты не сняты — тему не будет видно');
  assert.strictEqual(ctx.APP_SETTINGS.theme, 'th-mint');
  assert.strictEqual(ctx.APP_SETTINGS.colors, null);
  assert.strictEqual(byId['color-accent'].value, '#059669');
  assert.strictEqual(byId['color-accent2'].value, '#14b8a6');
});

test('setTheme игнорирует старые/мусорные темы', () => {
  const { ctx } = loadApp('app.js');
  ctx.APP_SETTINGS = {};
  ctx.setTheme('th-cyber');                       // старая тема из прошлых версий
  assert.strictEqual(ctx.APP_SETTINGS.theme, '');
  ctx.setTheme('"><script>');
  assert.strictEqual(ctx.APP_SETTINGS.theme, '');
});

// Регрессия «масштабирование не работает»: mirrorInput вызывал saver БЕЗ значения,
// applyScale(undefined) строил scale(NaN), а animation-fill у #app добивал transform.
test('applyScale без аргумента берёт значение ползунка и не даёт NaN', () => {
  const { ctx, byId } = loadApp('app.js');
  const zooms = [];
  ctx.apiBridge = Object.assign({}, ctx.apiBridge, { setZoom: (v) => zooms.push(v) });
  ctx.document.getElementById('ui-scale').value = '1.2';
  ctx.applyScale();                                // ровно так его зовёт mirrorInput
  assert.deepStrictEqual(zooms, [1.2], 'Chromium-zoom не вызван со значением ползунка');
  assert.strictEqual(ctx.APP_SETTINGS.uiScale, '1.2');
  assert.strictEqual(byId['scale-display'].textContent, '1.2');
  ctx.applyScale('abc');                           // мусор → кламп в 1, не NaN
  assert.strictEqual(zooms[zooms.length - 1], 1);
  assert.strictEqual(ctx.APP_SETTINGS.uiScale, '1');
  ctx.applyScale('99');                            // выход за диапазон → кламп
  assert.strictEqual(zooms[zooms.length - 1], 2);
});

test('mirrorInput передаёт значение в saver (saveScale/saveWin)', () => {
  const { ctx, byId } = loadApp('app.js');
  const el = ctx.document.getElementById('ui-scale');
  el.value = '1.1';
  ctx.mirrorInput.call(el, 'scale-display', 'saveScale', true);
  assert.strictEqual(byId['scale-display'].textContent, '1.1');
  assert.strictEqual(ctx.APP_SETTINGS.uiScale, '1.1', 'saver вызван без значения');
});

test('applyWindowStyle: дефолты, корректные значения и кламп мусора', () => {
  const { ctx } = loadApp('app.js');
  const rootVars = {};
  ctx.document.documentElement.style.setProperty = (k, v) => { rootVars[k] = v; };
  ctx.APP_SETTINGS = {};
  ctx.applyWindowStyle();
  assert.strictEqual(rootVars['--win-alpha'], '1');
  assert.strictEqual(rootVars['--win-radius'], '20px');
  ctx.APP_SETTINGS = { winOpacity: '0.55', winRadius: '12' };
  ctx.applyWindowStyle();
  assert.strictEqual(rootVars['--win-alpha'], '0.55');
  assert.strictEqual(rootVars['--win-radius'], '12px');
  ctx.APP_SETTINGS = { winOpacity: '99', winRadius: '-5' };
  ctx.applyWindowStyle();
  assert.strictEqual(rootVars['--win-alpha'], '1');
  assert.strictEqual(rootVars['--win-radius'], '20px');
});

test('saveWindowStyle читает ползунки (проценты → доля) и сохраняет настройки', () => {
  const { ctx, byId } = loadApp('app.js');
  ctx.document.getElementById('win-radius').value = '14';
  ctx.document.getElementById('win-opacity').value = '80';
  ctx.APP_SETTINGS = {};
  ctx.saveWindowStyle();
  assert.strictEqual(ctx.APP_SETTINGS.winRadius, '14');
  assert.strictEqual(ctx.APP_SETTINGS.winOpacity, '0.8');
});

test('applyBgSurface: плотность панелей поверх картинки клампится и уходит в CSS', () => {
  const { ctx, byId } = loadApp('app.js');
  const vars = {};
  ctx.document.documentElement.style.setProperty = (k, v) => { vars[k] = v; };
  ctx.APP_SETTINGS = {};
  ctx.applyBgSurface();                       // без значения — дефолт 74 %
  assert.strictEqual(ctx.APP_SETTINGS.bgSurface, '74');
  assert.strictEqual(vars['--surface-a'], '0.74');
  assert.ok(parseFloat(vars['--img-veil']) > 0, 'картинка должна получать лёгкое затемнение');
  assert.strictEqual(byId['surface-display'].textContent, '74');
  ctx.applyBgSurface(95);
  assert.strictEqual(vars['--surface-a'], '0.95');
  ctx.applyBgSurface(10);                     // ниже минимума → кламп в 35 (не «в ноль»)
  assert.strictEqual(vars['--surface-a'], '0.35');
  ctx.applyBgSurface(100);                    // 100 % — панели плотные, затемнение минимально
  assert.strictEqual(vars['--surface-a'], '1');
  assert.strictEqual(vars['--img-veil'], '0.22');
});

test('applyBgImage вешает has-bg-image и включает «стекло» панелей', () => {
  const { ctx } = loadApp('app.js');
  const app = ctx.document.getElementById('app');
  const vars = {};
  ctx.document.documentElement.style.setProperty = (k, v) => { vars[k] = v; };
  ctx.APP_SETTINGS = { bgSurface: '62' };
  ctx.applyBgImage('data:image/png;base64,AAAA');
  assert.ok(app.classList.contains('has-bg-image'), 'нет класса has-bg-image — меню останется непрозрачным');
  assert.strictEqual(vars['--surface-a'], '0.62', 'плотность панелей не применилась');
  assert.ok(ctx.document.getElementById('bg-image-layer').style.backgroundImage.indexOf('data:image/png;base64,AAAA') !== -1);
  ctx.applyBgImage(null);
  assert.strictEqual(app.classList.contains('has-bg-image'), false);
});

test('CLOUDFLARE: cf_navigate-настройки сохраняются в config.json', async () => {
  const { ctx, byId } = loadApp('app.js');
  const written = [];
  ctx.apiBridge.readConfig = () => Promise.resolve({ user_agent: 'UA', resolution: '1920,1080' });
  ctx.apiBridge.writeConfig = (cfg) => { written.push(cfg); return Promise.resolve({ ok: true }); };
  ctx.document.getElementById('cf-enabled').checked = false;
  ctx.document.getElementById('cf-soft-landing').checked = true;
  ctx.document.getElementById('cf-wait-challenge').checked = false;
  await ctx.saveCfConfig();
  assert.strictEqual(written.length, 1, 'config.json не записан');
  assert.strictEqual(written[0].cf.enabled, false);
  assert.strictEqual(written[0].cf.wait_challenge, false);
  assert.strictEqual(written[0].user_agent, 'UA', 'чужие поля конфига потерялись');
  assert.strictEqual(ctx.AF_ACTIONS.saveCfConfig, ctx.saveCfConfig);
});

test('CLOUDFLARE: loadCfConfig заполняет тумблеры из config.json', async () => {
  const { ctx } = loadApp('app.js');
  ctx.apiBridge.readConfig = () => Promise.resolve({ cf: { enabled: false, soft_landing: false } });
  await ctx.loadCfConfig();
  assert.strictEqual(ctx.document.getElementById('cf-enabled').checked, false);
  assert.strictEqual(ctx.document.getElementById('cf-soft-landing').checked, false);
  assert.strictEqual(ctx.document.getElementById('cf-wait-challenge').checked, true, 'по умолчанию ожидание включено');
});

test('Сохранить всё в UA-форме не стирает остальные блоки config.json', async () => {
  const { ctx } = loadApp('app.js');
  const written = [];
  ctx.apiBridge.writeConfig = (cfg) => { written.push(cfg); return Promise.resolve({ ok: true }); };
  ctx.document.getElementById('cfg-ua').value = 'Mozilla/5.0 Test';
  ctx.document.getElementById('cfg-res').value = '1920,1080';
  await ctx.saveConfig();
  // рендерер отправляет только свои поля, остальное main мержит с файлом
  assert.deepStrictEqual(Object.keys(written[0]).sort(), ['resolution', 'user_agent']);
});

test('AF_ACTIONS содержит действия окна/авто-обхода из разметки', () => {
  const { ctx } = loadApp('app.js');
  ['saveAutoBypass', 'saveWindowStyle', 'winMax', 'setTheme', 'previewColors', 'saveColors', 'resetColors',
    'saveBgSurface', 'saveCfConfig', 'loadCfConfig', 'pickBgImage', 'clearBgImage']
    .forEach((a) => assert.strictEqual(typeof ctx.AF_ACTIONS[a], 'function', a + ' отсутствует'));
});

test('saveAutoBypass переключает настройку по чекбоксу', () => {
  const { ctx, byId } = loadApp('app.js');
  ctx.APP_SETTINGS = {};
  const cb = ctx.document.getElementById('auto-bypass');
  cb.checked = false;
  ctx.saveAutoBypass();
  assert.strictEqual(ctx.APP_SETTINGS.autoBypass, false);
  cb.checked = true;
  ctx.saveAutoBypass();
  assert.strictEqual(ctx.APP_SETTINGS.autoBypass, true);
});

// ── 6. Авто-обход без VPN: страна выбрана → Zapret стартует сам ──
ctest('авто-обход: Zapret поднимается сам и переводит бинды профиля в bypass', async () => {
  const { ctx, apiStub } = loadApp('app.js');
  ctx.APP_SETTINGS = {};                           // autoBypass по умолчанию включён
  ctx.zapretActive = false;
  ctx.SAVED_BINDS = [{ id: 1, label: 'yt', url: 'https://youtube.com', profile: 'yt', browser: 'chrome', bypass: false }];
  const ok = await ctx.ensureBypassAuto(false);
  assert.strictEqual(ok, true, 'обход не включился автоматически');
  assert.strictEqual(ctx.zapretActive, true);
  assert.ok(apiStub.calls.zapretStart.length >= 1, 'zapretStart не вызван');
  await ctx.enableBindsBypassForProfile('yt');
  assert.strictEqual(ctx.SAVED_BINDS[0].bypass, true, 'бинд профиля не переведён в «С обходом»');
  assert.ok(apiStub.calls.writeBinds.length >= 1, 'бинды не сохранены');
});

ctest('авто-обход: «Уже запущен» из main считается успехом', async () => {
  const { ctx } = loadApp('app.js');
  ctx.APP_SETTINGS = {};
  ctx.zapretActive = false;
  ctx.apiBridge = Object.assign({}, ctx.apiBridge, {
    zapretStart: () => Promise.resolve({ ok: false, msg: 'Уже запущен' }),
  });
  const ok = await ctx.ensureBypassAuto(false);
  assert.strictEqual(ok, true);
  assert.strictEqual(ctx.zapretActive, true);
});

ctest('авто-обход: выключен тумблером → Zapret не стартует', async () => {
  const { ctx, apiStub } = loadApp('app.js');
  ctx.APP_SETTINGS = { autoBypass: false };
  ctx.zapretActive = false;
  const ok = await ctx.ensureBypassAuto(false);
  assert.strictEqual(ok, false);
  assert.strictEqual((apiStub.calls.zapretStart || []).length, 0);
});

ctest('запуск браузера с bypass сам включает обход до старта', async () => {
  const { ctx, apiStub } = loadApp('app.js');
  ctx.APP_SETTINGS = {};
  ctx.zapretActive = false;
  await ctx.launchBrowser('https://youtube.com', 'yt', 'chrome', true);
  assert.ok(apiStub.calls.zapretStart.length >= 1, 'обход не стартовал перед запуском');
  assert.strictEqual(apiStub.calls.launchBrowser.length, 1);
  assert.strictEqual(apiStub.calls.launchBrowser[0][0].browser, 'chrome');
});

ctest('app-бинд уходит в main с browser=app (steam://, ярлыки)', async () => {
  const { ctx, apiStub } = loadApp('app.js');
  await ctx.launchBrowser('steam://rungameid/431960', '', 'app', true);
  assert.strictEqual(apiStub.calls.launchBrowser.length, 1);
  assert.strictEqual(apiStub.calls.launchBrowser[0][0].browser, 'app');
  assert.strictEqual(apiStub.calls.launchBrowser[0][0].url, 'steam://rungameid/431960');
  assert.strictEqual((apiStub.calls.zapretStart || []).length, 0, 'для app-биндов Zapret не нужен');
});

test('setup.js: SETUP_ACTIONS содержит confirmInstall, skip, skipSetup, launchApp', () => {
  const { ctx } = loadApp('setup.js');
  assert.strictEqual(typeof ctx.SETUP_ACTIONS.confirmInstall, 'function');
  assert.strictEqual(typeof ctx.SETUP_ACTIONS.skip, 'function');
  assert.strictEqual(typeof ctx.SETUP_ACTIONS.skipSetup, 'function');
  assert.strictEqual(typeof ctx.SETUP_ACTIONS.launchApp, 'function');
});

test('setup.js: confirmInstall вызывает apiBridge.setupConfirmInstall', () => {
  const { ctx, apiStub } = loadApp('setup.js');
  ctx.SETUP_ACTIONS.confirmInstall();
  assert.strictEqual(apiStub.calls.setupConfirmInstall.length, 1);
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
