'use strict';
/* =============================================================
   Интеграционная проверка UI на настоящем index.html + app.js (jsdom).
   Запуск:  npm run test:ui   (нужен jsdom: npm i -D jsdom)
   Без jsdom тест молча пропускается — основные проверки живут в
   wiring/renderer-actions/main-smoke и не требуют зависимостей.

   Что здесь покрыто (регрессии 2.5.x):
     • окно: переменные скругления/прозрачности на :root;
     • темы: выбор темы + смена акцентных цветов ПОСЛЕ темы;
     • масштаб: mirrorInput → applyScale → api.setZoom (без NaN);
     • бинды: app-бинд (steam://) создаётся, рисуется и запускается;
     • авто-обход без VPN: Zapret стартует сам при запуске бинда
       и при выборе страны; бинды профиля переводятся в bypass;
     • maximize: body.is-max по событию win-maximized.
   ============================================================= */
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) {
  console.log('  ○ ui-integration пропущен: jsdom не установлен (npm i -D jsdom)');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');


let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── проба: держит ли jsdom кастомные CSS-свойства ──
const probeDom = new JSDOM('<body></body>');
probeDom.window.document.body.style.setProperty('--ac', '#ff0000');
const probeOk = probeDom.window.document.body.style.getPropertyValue('--ac') === '#ff0000';
console.log('probe custom props:', probeOk ? 'supported' : 'NOT supported');

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;

  // ── мок window.api (как preload + shim) ──
  const calls = {};
  const subs = {};
  function rec(name, impl) {
    calls[name] = [];
    return function () { calls[name].push(Array.prototype.slice.call(arguments)); return impl.apply(null, arguments); };
  }
  function sub(name) { return function (cb) { (subs[name] = subs[name] || []).push(cb); return function () {}; }; }
  const store = { settings: {}, binds: [], profiles: { demo: { browser: 'chrome', note: '', country: '' } },
    // как в живом config.json: в блоке cf есть ключи, которых нет в окне
    config: { user_agent: 'UA', resolution: '1920,1080',
      cf: { enabled: true, soft_landing: true, wait_challenge: true,
            challenge_timeout: 25, max_retries: 2, worker_patch: true, align_hardware: true } } };
  const api = {
    ready: true, platform: 'win32', version: '2.5.0',
    getIconUrl: rec('getIconUrl', () => Promise.resolve(null)),
    winAct: rec('winAct', () => {}), toggleMaximize: rec('toggleMaximize', () => {}),
    setZoom: rec('setZoom', () => {}),
    openFolder: rec('openFolder', () => Promise.resolve({ ok: true })),
    openExternal: rec('openExternal', () => Promise.resolve({ ok: true })),
    zapretService: () => Promise.resolve({ ok: true }), refreshTray: () => {},
    closeBrowsers: () => Promise.resolve({ ok: true }), killWinws: () => Promise.resolve({ ok: true }),
    launchBrowser: rec('launchBrowser', () => Promise.resolve({ ok: true })),
    zapretStart: rec('zapretStart', () => Promise.resolve({ ok: true })),
    zapretStop: rec('zapretStop', () => Promise.resolve({ ok: true })),
    zapretVersion: () => Promise.resolve({ version: 'x', path: 'y' }),
    zapretCheckUpdate: () => Promise.resolve({ ok: false, msg: 'нет' }),
    zapretDoUpdate: () => Promise.resolve({ ok: false }),
    listProfiles: rec('listProfiles', () => Promise.resolve(Object.keys(store.profiles))),
    createProfile: rec('createProfile', (n) => { store.profiles[n] = {}; return Promise.resolve({ ok: true }); }),
    deleteProfile: rec('deleteProfile', (n) => { delete store.profiles[n]; return Promise.resolve({ ok: true }); }),
    readProfileMeta: rec('readProfileMeta', (n) => Promise.resolve(store.profiles[n] || {})),
    writeProfileMeta: rec('writeProfileMeta', (n, d) => { store.profiles[n] = Object.assign({}, store.profiles[n], d); return Promise.resolve({ ok: true }); }),
    readConfig: rec('readConfig', () => Promise.resolve(store.config)),
    writeConfig: rec('writeConfig', (cfg) => { store.config = Object.assign({}, store.config, cfg); return Promise.resolve({ ok: true }); }),
    readSettings: rec('readSettings', () => Promise.resolve(store.settings)),
    writeSettings: rec('writeSettings', (s) => { store.settings = JSON.parse(JSON.stringify(s)); return Promise.resolve({ ok: true }); }),
    readBinds: rec('readBinds', () => Promise.resolve(store.binds)),
    writeBinds: rec('writeBinds', (b) => { store.binds = JSON.parse(JSON.stringify(b)); return Promise.resolve({ ok: true }); }),
    hostsRead: () => Promise.resolve({ ok: false, domains: [] }),
    hostsWrite: () => Promise.resolve({ ok: true }), hostsWriteAdmin: () => Promise.resolve({ ok: true }),
    ublockCheck: () => Promise.resolve({}), ublockInstall: () => Promise.resolve({ ok: false }),
    diagCheck: () => Promise.resolve({ status: 'ok' }), diagInstall: () => Promise.resolve({ ok: true }),
    cbnPing: () => Promise.resolve({ ok: false }), cbnSetDns: () => Promise.resolve({ ok: true }),
    cbnResetDns: () => Promise.resolve({ ok: true }), cbnFixWarp: () => Promise.resolve({ ok: true }),
    cbnTestWarp: () => Promise.resolve({ ok: false }),
    readLogs: () => Promise.resolve([]), clearLogs: () => Promise.resolve({ ok: true }), copyLogs: () => Promise.resolve({ ok: true }),
    previewProfile: () => Promise.resolve({ identity: null }),
    // фон-картинка: в Electron файл выбирает main, в тесте отдаём готовый data URL
    pickBgImage: rec('pickBgImage', () => Promise.resolve({ ok: true, dataUrl: 'data:image/png;base64,AAAB' })),
    listCountries: rec('listCountries', () => Promise.resolve([
      { code: 'US', name: 'США', flag: '🇺🇸' }, { code: 'DE', name: 'Германия', flag: '🇩🇪' },
    ])),
    rerollProfile: () => Promise.resolve({ ok: true }),
    reportError: () => {},
    onLogEntry: sub('log-entry'), onZapretStatus: sub('zapret-status'), onZapretProgress: sub('p'),
    onDiagLog: sub('d'), onDiagProgress: sub('dp'), onTrayAction: sub('tray-action'),
    onNavigate: sub('navigate'),
    onBootstrap: function (cb) { subs['bootstrap'] = subs['bootstrap'] || []; subs['bootstrap'].push(cb);
      setTimeout(() => cb({ platform: 'win32', version: '2.5.0', isAdmin: true, sandbox: true, zapretRunning: false, hostsAvailable: true }), 0);
      return () => {}; },
    onWinMaximized: sub('win-maximized'),
    onCfWarning: sub('cf-warning'),
  };
  window.api = Object.freeze(api);

  // errors → console
  window.addEventListener('error', (e) => console.log('  [window.error] ' + e.message));

  // ── запускаем app.js ──
  try { window.eval(appJs); } catch (e) { console.log('  app.js eval error: ' + e.message); failed++; }
  await sleep(120);

  const $ = (id) => document.getElementById(id);
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const inputEv = (el) => el.dispatchEvent(new window.Event('input', { bubbles: true }));
  const changeEv = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));
  const lastToast = () => { const t = $('toasts'); return t && t.lastChild ? t.lastChild.textContent : ''; };

  // ═══ 1. Окно: скругление/прозрачность по умолчанию ═══
  check('при старте применены переменные окна (--win-radius/--win-alpha на :root)',
    document.documentElement.style.getPropertyValue('--win-radius') === '20px' &&
    document.documentElement.style.getPropertyValue('--win-alpha') === '1',
    'radius=' + document.documentElement.style.getPropertyValue('--win-radius') + ' alpha=' + document.documentElement.style.getPropertyValue('--win-alpha'));

  // ═══ 2. Настройки: темы ═══
  click(document.querySelector('[data-tab="settings"]'));
  await sleep(30);
  const mintCard = $('tc-th-mint');
  check('карточка темы «Мята» есть в разметке', !!mintCard);
  click(mintCard);
  await sleep(30);
  check('тема применена классом на body', document.body.classList.contains('th-mint'));
  check('карточка темы подсвечена', mintCard.classList.contains('is-active'));
  check('color-инпуты получили акценты темы', $('color-accent').value === '#059669' && $('color-accent2').value === '#14b8a6',
    $('color-accent').value + '/' + $('color-accent2').value);

  // ═══ 3. Цвета меняются ПОСЛЕ выбора темы (главный баг) ═══
  $('color-accent').value = '#ff0000';
  inputEv($('color-accent'));
  await sleep(10);
  check('после выбора темы цвет акцента меняется (инлайн на body перебивает тему)',
    document.body.style.getPropertyValue('--ac') === '#ff0000' &&
    document.documentElement.style.getPropertyValue('--ac') === '#ff0000',
    'body:' + document.body.style.getPropertyValue('--ac'));
  click(document.querySelector('[data-af-action="saveColors"]'));
  await sleep(30);
  check('saveColors сохраняет ac/ac2', store.settings.colors && store.settings.colors.ac === '#ff0000');

  // смена темы снимает кастом и снова visibly меняет акцент
  click($('tc-th-rose'));
  await sleep(30);
  check('смена темы убирает кастомный акцент (removeProperty на body)',
    document.body.style.getPropertyValue('--ac') === '' && document.body.classList.contains('th-rose'));

  // ═══ 4. Масштаб ═══
  const scale = $('ui-scale');
  scale.value = '1.2';
  inputEv(scale);
  await sleep(20);
  check('масштаб: подпись обновлена', $('scale-display').textContent === '1.2', $('scale-display').textContent);
  check('масштаб: setZoom вызван с 1.2', calls.setZoom.length > 0 && calls.setZoom[calls.setZoom.length - 1][0] === 1.2,
    JSON.stringify(calls.setZoom.slice(-1)));
  check('масштаб: сохранён в настройках', store.settings.uiScale === '1.2', String(store.settings.uiScale));

  // ═══ 5. Ползунки окна ═══
  const rad = $('win-radius'), op = $('win-opacity');
  check('ползунки окна в разметке', !!rad && !!op);
  rad.value = '26'; inputEv(rad);
  op.value = '65'; inputEv(op);
  await sleep(30);
  check('скругление применено к :root', document.documentElement.style.getPropertyValue('--win-radius') === '26px',
    document.documentElement.style.getPropertyValue('--win-radius'));
  check('прозрачность применена к :root (0.65)', document.documentElement.style.getPropertyValue('--win-alpha') === '0.65',
    document.documentElement.style.getPropertyValue('--win-alpha'));
  check('настройки окна сохраняются', store.settings.winRadius === '26' && store.settings.winOpacity === '0.65',
    JSON.stringify({ r: store.settings.winRadius, o: store.settings.winOpacity }));

  // ═══ 6. Бинды: app-бинд steam:// ═══
  click(document.querySelector('[data-tab="binds"]'));
  await sleep(30);
  const autoBypass = $('auto-bypass');
  check('тумблер авто-обхода в разметке и включён', !!autoBypass && autoBypass.checked === true);
  $('bind-url').value = 'steam://rungameid/431960';
  $('bind-browser').value = 'app';
  $('bind-name').value = 'Steam Game';
  click(document.querySelector('[data-af-action="addBind"]'));
  await sleep(40);
  check('app-бинд добавлен и сохранён', store.binds.length === 1 && store.binds[0].browser === 'app' &&
    store.binds[0].url === 'steam://rungameid/431960', JSON.stringify(store.binds));
  const card = document.querySelector('.bind-item');
  check('бинд отрисован карточкой', !!card);
  click(card);
  await sleep(40);
  check('клик по app-бинду уходит в main с browser=app', calls.launchBrowser.length === 1 &&
    calls.launchBrowser[0][0].browser === 'app' && calls.launchBrowser[0][0].url === 'steam://rungameid/431960',
    JSON.stringify(calls.launchBrowser[0] || null));

  // ═══ 7. Авто-обход при запуске браузерного бинда ═══
  $('bind-url').value = 'https://youtube.com';
  $('bind-browser').value = 'chrome';
  $('bind-profile').value = 'demo';
  $('bind-name').value = 'YT';
  $('bind-bypass').value = '1';
  click(document.querySelector('[data-af-action="addBind"]'));
  await sleep(40);
  const ytCard = document.querySelectorAll('.bind-item')[1];
  const zBefore = calls.zapretStart.length;
  click(ytCard);
  await sleep(60);
  check('запуск бинда «с обходом» АВТОМАТИЧЕСКИ поднял Zapret', calls.zapretStart.length > zBefore,
    'zapretStart calls: ' + calls.zapretStart.length);
  check('браузерный запуск ушёл в main', calls.launchBrowser.length === 2 && calls.launchBrowser[1][0].browser === 'chrome');

  // ═══ 8. Выбор страны → авто-настройка обхода ═══
  click(document.querySelector('[data-tab="config"]'));
  await sleep(60);
  const fpProf = $('fp-profile'), fpC = $('fp-country');
  check('селекторы страны на месте', !!fpProf && !!fpC);
  if (fpProf && fpC) {
    fpProf.value = 'demo';
    // дождёмся заполнения опций стран
    await sleep(80);
    const hasUS = Array.prototype.some.call(fpC.options, (o) => o.value === 'US');
    check('список стран подтянулся из main', hasUS, 'options: ' + fpC.options.length);
    // имитируем «Zapret сейчас выключен» (до этого его поднял запуск бинда)
    (subs['zapret-status'] || []).forEach((cb) => cb({ on: false }));
    await sleep(20);
    const zBefore2 = calls.zapretStart.length;
    fpC.value = 'US';
    changeEv(fpC);
    await sleep(120);
    check('выбор страны записан в meta профиля', store.profiles.demo && store.profiles.demo.country === 'US',
      JSON.stringify(store.profiles.demo));
    check('выбор страны АВТОМАТИЧЕСКИ включил обход (zapretStart)', calls.zapretStart.length > zBefore2,
      calls.zapretStart.length + ' vs ' + zBefore2);
    await sleep(60);
    check('бинды профиля demo переведены в bypass=true', store.binds.every((b) => b.bypass === true),
      JSON.stringify(store.binds.map((b) => b.bypass)));
  }

  // ═══ 9. Maximize → body.is-max ═══
  (subs['win-maximized'] || []).forEach((cb) => cb(true));
  await sleep(10);
  check('win-maximized=true добавляет body.is-max', document.body.classList.contains('is-max'));
  (subs['win-maximized'] || []).forEach((cb) => cb(false));
  await sleep(10);
  check('win-maximized=false снимает body.is-max', !document.body.classList.contains('is-max'));

  // ═══ 10. Выключение авто-обхода ═══
  click(document.querySelector('[data-tab="binds"]'));
  await sleep(30);
  $('auto-bypass').checked = false;
  changeEv($('auto-bypass'));
  await sleep(30);
  check('авто-обход сохраняется выключенным', store.settings.autoBypass === false, String(store.settings.autoBypass));
  const zBefore3 = calls.zapretStart.length;
  const card3 = document.querySelectorAll('.bind-item')[1];
  click(card3);
  await sleep(60);
  check('с выключенным авто-обходом Zapret НЕ стартует', calls.zapretStart.length === zBefore3,
    calls.zapretStart.length + ' vs ' + zBefore3);

  // ═══ 11. Фон-картинка: меню и кнопки показывают картинку («стекло») ═══
  click(document.querySelector('[data-tab="settings"]'));
  await sleep(30);
  const bgBtn = document.querySelector('[data-af-action="pickBgImage"]');
  check('кнопка выбора картинки в «Внешнем виде»', !!bgBtn);
  click(bgBtn);
  await sleep(60);
  check('картинка применена (data URL у слоя фона)',
    ($('bg-image-layer').style.backgroundImage || '').indexOf('data:image/png;base64,AAAB') !== -1,
    $('bg-image-layer').style.backgroundImage);
  check('включён режим has-bg-image (панели и кнопки становятся полупрозрачными)',
    $('app').classList.contains('has-bg-image'));
  const surfaceA = parseFloat(document.documentElement.style.getPropertyValue('--surface-a'));
  check('плотность панелей по умолчанию ~0.74 (видно картинку, но текст читается)',
    surfaceA > 0.5 && surfaceA < 1, 'surface-a=' + surfaceA);
  const veil = parseFloat(document.documentElement.style.getPropertyValue('--img-veil'));
  check('у картинки есть лёгкое затемнение (--img-veil)', veil > 0 && veil < 1, 'veil=' + veil);
  const bgSlider = $('bg-surface');
  check('ползунок плотности панелей в разметке', !!bgSlider);
  bgSlider.value = '45';
  inputEv(bgSlider);
  await sleep(30);
  check('ползунок меняет --surface-a (0.45)', document.documentElement.style.getPropertyValue('--surface-a') === '0.45',
    document.documentElement.style.getPropertyValue('--surface-a'));
  check('плотность панелей сохраняется в настройках', store.settings.bgSurface === '45', String(store.settings.bgSurface));
  click(document.querySelector('[data-af-action="clearBgImage"]'));
  await sleep(40);
  check('«Убрать картинку» снимает has-bg-image', !$('app').classList.contains('has-bg-image'));

  // ═══ 12. Cloudflare: тумблеры сохраняются в config.json ═══
  click(document.querySelector('[data-tab="config"]'));
  await sleep(60);
  const cfEn = $('cf-enabled'), cfSl = $('cf-soft-landing'), cfWc = $('cf-wait-challenge');
  const cfWp = $('cf-worker-patch'), cfAh = $('cf-align-hardware');
  check('тумблеры Cloudflare в «Конфигурации»', !!cfEn && !!cfSl && !!cfWc);
  check('по умолчанию защита от блокировок включена', cfEn.checked === true && cfSl.checked === true && cfWc.checked === true);
  check('есть тумблеры воркеров и согласия с железом', !!cfWp && !!cfAh);
  check('воркеры и железо включены по умолчанию', cfWp.checked === true && cfAh.checked === true);
  cfEn.checked = false;
  cfWc.checked = false;
  cfWp.checked = false;
  changeEv(cfEn);
  await sleep(60);
  check('настройки Cloudflare уходят в config.json (блок cf)',
    store.config.cf && store.config.cf.enabled === false && store.config.cf.wait_challenge === false,
    JSON.stringify(store.config.cf));
  check('выключенный тумблер воркеров доехал до конфига', store.config.cf.worker_patch === false,
    JSON.stringify(store.config.cf));
  check('настройки, которых нет в окне, не стёрлись',
    store.config.cf.challenge_timeout === 25 && store.config.cf.max_retries === 2 && store.config.cf.align_hardware === true,
    JSON.stringify(store.config.cf));
  check('соседние поля конфига не потерялись', store.config.user_agent === 'UA' && store.config.resolution === '1920,1080',
    JSON.stringify(store.config));

  // ═══ 13. Превью-шим: поверхность window.api соответствует запросам app.js ═══
  // preview/api-shim.js — не часть сборки Electron, но npm run preview должен
  // работать: каждый apiBridge.<метод>, который зовёт app.js, обязан быть в шиме.
  const shimPath = path.join(ROOT, 'preview/api-shim.js');
  if (fs.existsSync(shimPath)) {
    const shimSrc = fs.readFileSync(shimPath, 'utf8');
    const shimDom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    shimDom.window.eval(shimSrc);
    const shimApi = shimDom.window.api;
    check('шим отдаёт готовый window.api', !!(shimApi && shimApi.ready === true));
    const used = new Set();
    const re = /apiBridge\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(appJs))) used.add(m[1]);
    const missing = [...used].filter((u) => typeof shimApi[u] === 'undefined');
    check('в шиме есть все методы, которые вызывает app.js', missing.length === 0, 'нет: ' + missing.join(', '));
  } else {
    check('preview/api-shim.js на месте', false, 'файл не найден');
  }

  console.log('\n' + (failed ? '✗ ПРОВАЛЕНО: ' + failed : '✓ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('verify crashed:', e); process.exit(2); });
