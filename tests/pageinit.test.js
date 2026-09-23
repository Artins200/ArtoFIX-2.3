'use strict';
/* Проверяем, что page-init скрипт антидетекта из engine.py:
     • синтаксически валиден и не падает на живом окружении;
     • реально скрывает navigator.webdriver и переменные ChromeDriver;
     • подменяет только UNMASKED_* у WebGL, оставляя WebKit/WebKit WebGL;
     • даёт детерминированный canvas-шум (одинаковый при повторе);
     • врёт про Function.prototype.toString для своих патчей. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { makeFakeDom } = require('./fake-dom');

const ROOT = path.join(__dirname, '..');

function extractTemplate() {
  const src = fs.readFileSync(path.join(ROOT, 'engine.py'), 'utf-8');
  const marker = 'PAGE_INIT_TEMPLATE = r"""';
  const start = src.indexOf(marker) + marker.length;
  const end = src.indexOf('"""', start);
  return src.slice(start, end);
}

const IDENTITY = {
  vectors: { webgl: true, platform: true, canvas: true, audio: true, screen: true, hw: true, media: true, fonts: true },
  languages: ['ru-RU', 'ru', 'en-US', 'en'],
  ua_platform: 'Windows',
  platform: 'Win32',
  hardware: { cores: 8, memory: 16, device_memory: 8, max_touch_points: 0 },
  connection: { effective_type: '4g', downlink: 10, rtt: 50, save_data: false },
  screen: {
    width: 1920, height: 1080, avail_width: 1920, avail_height: 1040,
    color_depth: 24, pixel_depth: 24, device_pixel_ratio: 1,
    outer_width: 1880, outer_height: 1000,
  },
  webgl: {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    tier: 'high',
    limits: {
      MAX_TEXTURE_SIZE: 32768, MAX_VIEWPORT_DIMS: [32768, 32768], MAX_RENDERBUFFER_SIZE: 32768,
      MAX_VERTEX_UNIFORM_VECTORS: 4096, MAX_FRAGMENT_UNIFORM_VECTORS: 4096, MAX_VARYING_VECTORS: 32,
      MAX_VERTEX_ATTRIBS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32, MAX_CUBE_MAP_TEXTURE_SIZE: 32768,
      MAX_TEXTURE_IMAGE_UNITS: 32,
    },
  },
  canvas_noise: 37,
  audio_noise: 2e-5,
  audio_freq_shift: 0.0000412,
  media: {
    video: { h264: 'probably', vp9: 'probably', hevc: '', av1: 'probably' },
    audio: { opus: 'probably', mp3: 'probably', aac: 'probably' },
    media_source: { 'video/mp4; codecs="avc1.42E01E"': true, 'audio/mpeg': true },
  },
  fonts: ['Arial', 'Segoe UI'],
  permissions: { notifications: 'default', geolocation: 'prompt' },
  webrtc: { mode: 'public_only' },
};

function runInit(identity) {
  const dom = makeFakeDom();
  const script = extractTemplate().replace('/*__IDENTITY__*/ null', JSON.stringify(identity || IDENTITY));
  const ctx = vm.createContext(Object.assign(dom.win, {
    WeakMap, Int32Array, Uint8ClampedArray, Promise: SyncPromise, Math, Object, JSON, Error, String, Array,
  }));
  vm.runInContext(script, ctx, { filename: 'page-init.js' });
  return Object.assign(dom, { ctx });
}

/* Мини-Promise с синхронным then: промис-значения (permissions, Notification)
   проверяются в синхронных тестах без вылета за их рамки. */
function SyncPromise(executor) {
  const self = this;
  this._state = 'pending';
  this._value = undefined;
  this._cbs = [];
  const resolve = (v) => {
    if (self._state !== 'pending') return;
    self._state = 'fulfilled';
    self._value = v;
    self._cbs.splice(0).forEach((f) => f(v));
  };
  try { executor(resolve, () => {}); } catch (e) { /* как Promise: ошибки гасим */ }
}
SyncPromise.prototype.then = function (onFulfilled) {
  if (typeof onFulfilled === 'function') {
    if (this._state === 'fulfilled') onFulfilled(this._value);
    else this._cbs.push(onFulfilled);
  }
  return this;
};
SyncPromise.resolve = function (v) { return new SyncPromise((res) => res(v)); };

const results = [];
function test(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['fail', name + ' → ' + e.message]); }
}

let dom;
test('скрипт выполняется без исключений', () => { dom = runInit(); });

test('navigator.webdriver скрыт', () => {
  assert.strictEqual(dom.win.navigator.webdriver, false);
});

test('переменные ChromeDriver (cdc_*) удалены из document', () => {
  const keys = Object.keys(dom.win.document).filter((k) => /^\$?cdc_/i.test(k));
  assert.deepStrictEqual(keys, []);
});

test('navigator.platform = Win32', () => {
  assert.strictEqual(dom.win.navigator.platform, 'Win32');
});

test('железо подменено на согласованное', () => {
  assert.strictEqual(dom.win.navigator.hardwareConcurrency, 8);
  assert.strictEqual(dom.win.navigator.deviceMemory, 8);
  assert.strictEqual(dom.win.navigator.maxTouchPoints, 0);
});

test('языки совпадают с отпечатком', () => {
  // Array.from: значения приходят из другого vm-контекста
  assert.deepStrictEqual(Array.from(dom.win.navigator.languages), ['ru-RU', 'ru', 'en-US', 'en']);
  assert.strictEqual(dom.win.navigator.language, 'ru-RU');
});

test('WebGL: UNMASKED_* подменены, VENDOR/RENDERER остались WebKit', () => {
  const gl = dom.win.WebGLRenderingContext.prototype;
  assert.strictEqual(gl.getParameter(0x9245), 'Google Inc. (NVIDIA)');
  assert.strictEqual(gl.getParameter(0x9246), IDENTITY.webgl.renderer);
  assert.strictEqual(gl.getParameter(0x1f00), 'WebKit');
  assert.strictEqual(gl.getParameter(0x1f01), 'WebKit WebGL');
  assert.strictEqual(gl.getParameter(0x0d33), 32768);
  assert.ok(gl.getSupportedExtensions().includes('WEBGL_debug_renderer_info'));
});

test('Canvas: шум детерминирован и одинаков при повторных вызовах', () => {
  const proto = dom.win.CanvasRenderingContext2D.prototype;
  const a = proto.getImageData(0, 0, 40, 40).data;
  const b = proto.getImageData(0, 0, 40, 40).data;
  assert.deepStrictEqual(Array.from(a), Array.from(b), 'шум должен быть стабильным');
  assert.ok(Array.from(a).some((v) => v !== 0), 'шум должен менять пиксели');
  // у другого профиля (другой noise) результат отличается
  const dom2 = runInit(Object.assign({}, IDENTITY, { canvas_noise: 11 }));
  const c = dom2.win.CanvasRenderingContext2D.prototype.getImageData(0, 0, 40, 40).data;
  assert.notDeepStrictEqual(Array.from(a), Array.from(c), 'разные профили → разный canvas');
});

test('Audio: сдвиг применён и стабилен', () => {
  const proto = dom.win.AnalyserNode.prototype;
  const arr = new Float32Array(128);
  proto.getFloatFrequencyData(arr);
  // точность float32 — сравниваем с допуском
  assert.ok(Math.abs(arr[0] - (-100 + IDENTITY.audio_freq_shift)) < 1e-4,
    'ожидали сдвиг, получили ' + arr[0]);
  const byteArr = new Uint8Array(128);
  proto.getByteFrequencyData(byteArr);
  assert.strictEqual(byteArr[0], (10 + (Math.round(IDENTITY.audio_freq_shift * 100000) % 3)) % 256);
});

test('медиакодеки отвечают как заявлено', () => {
  assert.strictEqual(dom.win.HTMLMediaElement.prototype.canPlayType('video/mp4; codecs="avc1.42E01E"'), 'probably');
  assert.strictEqual(dom.win.MediaSource.isTypeSupported('audio/mpeg'), true);
});

test('шрифты: allowlist профиля', () => {
  assert.strictEqual(dom.win.document.fonts.check('16px "Segoe UI"'), true);
  assert.strictEqual(dom.win.document.fonts.check('16px "Comic Sans MS"'), false);
});

test('permissions подменены согласованно', async () => {
  const p = dom.win.Permissions.prototype.query({ name: 'notifications' });
  assert.ok(p && typeof p.then === 'function');
});

test('Function.prototype.toString скрывает патчи ([native code])', () => {
  const str = dom.win.WebGLRenderingContext.prototype.getParameter.toString();
  assert.ok(/\[native code\]/.test(str), 'патч должен выглядеть нативно, а получили: ' + str);
  // обычные функции по-прежнему отдают свой код
  function userFn() { return 1; }
  assert.ok(/userFn/.test(userFn.toString()));
});

test('chrome.runtime добавлен (в автоматизированном Chrome его нет)', () => {
  assert.ok(dom.win.chrome.runtime && typeof dom.win.chrome.runtime.connect === 'function');
});

test('chrome.csi и chrome.loadTimes присутствуют (детект Cloudflare/Turnstile/Claude)', () => {
  assert.strictEqual(typeof dom.win.chrome.csi, 'function');
  assert.strictEqual(typeof dom.win.chrome.loadTimes, 'function');
  const lt = dom.win.chrome.loadTimes();
  assert.ok(lt && lt.startLoadTime > 0);
  assert.strictEqual(typeof dom.win.chrome.app, 'object');
});

test('navigator.plugins и mimeTypes эмулируют плагины Chrome PDF', () => {
  assert.ok(dom.win.navigator.plugins.length >= 2);
  assert.strictEqual(dom.win.navigator.plugins[0].name, 'PDF Viewer');
  assert.ok(dom.win.navigator.mimeTypes.length >= 2);
});

test('document.hasFocus возвращает true для прохождения проверок активности', () => {
  assert.strictEqual(dom.win.document.hasFocus(), true);
});

// ── Согласованность против детекторов Cloudflare / «мёртвых» заглушек ──

test('navigator.webdriver живёт ТОЛЬКО на прототипе (без own-свойства)', () => {
  assert.strictEqual(Object.getOwnPropertyDescriptor(dom.win.navigator, 'webdriver'), undefined);
  assert.strictEqual(dom.win.navigator.webdriver, false);
});

test('navigator.languages — один и тот же замороженный массив (languages === languages)', () => {
  const a = dom.win.navigator.languages;
  const b = dom.win.navigator.languages;
  assert.strictEqual(a, b, 'новый массив на каждый вызов — признак патча');
  assert.strictEqual(dom.win.navigator.language, 'ru-RU');
});

test('navigator.connection — один объект без нестандартного поля type', () => {
  const c1 = dom.win.navigator.connection;
  const c2 = dom.win.navigator.connection;
  assert.strictEqual(c1, c2, 'connection должен быть одним объектом');
  assert.strictEqual(c1.effectiveType, '4g');
  assert.strictEqual(c1.type, undefined, "Chrome не отдаёт connection.type — его наличие = детект");
});

test('chrome.csi: правдоподобные метки (onloadT относительный, pageT растёт, всё стабильно)', () => {
  const a = dom.win.chrome.csi();
  const b = dom.win.chrome.csi();
  assert.strictEqual(a.startE, b.startE, 'startE не должен меняться между вызовами');
  assert.strictEqual(a.onloadT, b.onloadT, 'onloadT заморожен после onload');
  assert.ok(a.onloadT < 10000, 'onloadT — время ОТ startE, а не абсолютная эпоха: ' + a.onloadT);
  assert.ok(a.startE > 1e12, 'startE — абсолютная эпоха в ms');
  assert.ok(a.pageT >= a.onloadT, 'pageT не может быть меньше onloadT');
  assert.strictEqual(a.tran, 15);
});

test('chrome.loadTimes: метки заморожены, монотонны и не «из будущего»', () => {
  const a = dom.win.chrome.loadTimes();
  const b = dom.win.chrome.loadTimes();
  const nowSec = Date.now() / 1000;
  assert.ok(a.requestTime < a.startLoadTime, 'requestTime < startLoadTime');
  assert.ok(a.startLoadTime < a.commitLoadTime, 'startLoadTime < commitLoadTime');
  assert.ok(a.commitLoadTime <= a.finishDocumentLoadTime, 'commitLoadTime <= finishDocumentLoadTime');
  assert.ok(a.finishDocumentLoadTime <= a.finishLoadTime, 'finishDocumentLoadTime <= finishLoadTime');
  assert.ok(a.finishLoadTime <= nowSec, 'finishLoadTime из будущего — готовый детект заглушки: ' + a.finishLoadTime);
  assert.strictEqual(a.finishLoadTime, b.finishLoadTime, 'значения loadTimes() должны быть заморожены');
  assert.strictEqual(a.requestTime, b.requestTime);
  assert.strictEqual(a.firstPaintAfterLoadTime, 0);
  assert.strictEqual(a.connectionInfo, 'h2');
});

test('Canvas.toBlob не оставляет следов (__artofix_*) на самом canvas', () => {
  const c = Object.create(dom.win.HTMLCanvasElement.prototype);
  c.width = 10; c.height = 10;
  c.toBlob(function () {});
  const leaks = Object.getOwnPropertyNames(c).filter((k) => /artofix/i.test(k));
  assert.deepStrictEqual(leaks, [], 'свойства на canvas перечисляются детекторами: ' + leaks.join(','));
});

test('арности патчей совпадают с нативными (toBlob=1, RTCPeerConnection=0, check=0)', () => {
  assert.strictEqual(dom.win.HTMLCanvasElement.prototype.toBlob.length, 1);
  assert.strictEqual(dom.win.RTCPeerConnection.length, 0);
  assert.strictEqual(dom.win.document.fonts.check.length, 0);
  assert.strictEqual(dom.win.HTMLMediaElement.prototype.canPlayType.length, 1);
});

test('кодеки: HEVC в video/mp4 не отвечает «probably» от имени h264', () => {
  assert.strictEqual(dom.win.HTMLMediaElement.prototype.canPlayType('video/mp4; codecs="avc1.42E01E"'), 'probably');
  assert.strictEqual(dom.win.HTMLMediaElement.prototype.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'), '');
  assert.strictEqual(dom.win.HTMLMediaElement.prototype.canPlayType('video/mp4'), 'probably');
  assert.strictEqual(dom.win.HTMLMediaElement.prototype.canPlayType('video/webm; codecs="vp9"'), 'probably');
});

test('AudioBuffer: шум стабилен, одинаков для getChannelData и copyFromChannel', () => {
  const buf = new dom.win.AudioBuffer();
  const first = Float32Array.from(buf.getChannelData(0));
  const second = Float32Array.from(buf.getChannelData(0));
  assert.deepStrictEqual(Array.from(first), Array.from(second), 'повторное чтение не должно накапливать шум');
  assert.strictEqual(buf.getChannelData(0), buf.getChannelData(0), 'нативный getChannelData возвращает ту же ссылку');
  const dest = new Float32Array(64);
  buf.copyFromChannel(dest, 1);
  assert.deepStrictEqual(Array.from(dest), Array.from(buf.getChannelData(1)), 'два пути чтения обязаны совпадать');
  // шум должен отличаться у другого профиля
  const dom2 = runInit(Object.assign({}, IDENTITY, { canvas_noise: 55, audio_noise: 2e-6 }));
  const buf2 = new dom2.win.AudioBuffer();
  assert.notDeepStrictEqual(Array.from(buf2.getChannelData(0)), Array.from(new dom.win.AudioBuffer().getChannelData(0)),
    'разные профили → разный аудио-отпечаток');
  // исходная выборка реально изменена (шум применился)
  assert.notDeepStrictEqual(Array.from(first), Array.from(new dom.win.AudioBuffer()._channels[0]),
    'шум должен менять выборки');
});

test('navigator.pdfViewerEnabled согласован с PDF-плагинами', () => {
  assert.strictEqual(dom.win.navigator.pdfViewerEnabled, true);
});

test('Notification.requestPermission отдаёт то же состояние, что Notification.permission', () => {
  assert.strictEqual(dom.win.Notification.permission, 'default');
  let got = null;
  dom.win.Notification.requestPermission(function (s) { got = s; });
  assert.strictEqual(got, dom.win.Notification.permission, 'permission и requestPermission обязаны совпадать');
});

test('permissions.query отдаёт объект-PermissionStatus (instanceof), а не голый литерал', () => {
  let status = null;
  const p = dom.win.Permissions.prototype.query({ name: 'notifications' });
  assert.ok(p && typeof p.then === 'function', 'query должен возвращать Promise');
  p.then((s) => { status = s; });
  assert.ok(status, 'статус должен прийти');
  assert.strictEqual(status.state, 'default');
  assert.ok(status instanceof dom.win.PermissionStatus, 'instanceof PermissionStatus обязан проходить — голый литерал детектят');
  assert.strictEqual(status.onchange, null);
});

test('WebRTC: приватные ICE-кандидаты фильтруются и через onicecandidate', () => {
  const pc = new dom.win.RTCPeerConnection();
  const got = [];
  pc.onicecandidate = function (ev) { got.push(ev); };
  const wrapped = pc.onicecandidate;
  assert.strictEqual(typeof wrapped, 'function');
  wrapped({ candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host' } });
  wrapped({ candidate: { candidate: 'candidate:2 1 udp 2122260223 10.0.0.7 54321 typ host' } });
  wrapped({ candidate: { candidate: 'candidate:3 1 udp 2122260223 fd31:ab1:2::5 54321 typ host' } });
  assert.strictEqual(got.length, 0, 'приватные/ULA кандидаты должны отсекаться');
  wrapped({ candidate: { candidate: 'candidate:4 1 udp 2122260223 203.0.113.7 54321 typ srflx' } });
  assert.strictEqual(got.length, 1, 'публичный кандидат должен проходить');
});

/* ── Раздел: воркеры и platform ─────────────────────────────────────────
   Скрипт в воркере отдельный (WorkerGlobalScope), и именно там остаются
   настоящие значения — поэтому у него свой шаблон + проверки ниже. */

test('navigator.platform берётся из identity.platform, а не только «Win32»', () => {
  const mac = Object.assign({}, IDENTITY, { platform: 'MacIntel', ua_platform: 'macOS' });
  const dom2 = runInit(mac);
  assert.strictEqual(dom2.win.navigator.platform, 'MacIntel');
  const linux = Object.assign({}, IDENTITY, { platform: 'Linux x86_64', ua_platform: 'Linux' });
  assert.strictEqual(runInit(linux).win.navigator.platform, 'Linux x86_64');
});

test('без identity.platform остаётся Windows-вариант (обратная совместимость)', () => {
  const old = Object.assign({}, IDENTITY, { platform: undefined });
  assert.strictEqual(runInit(old).win.navigator.platform, 'Win32');
});

function extractWorkerTemplate() {
  const src = fs.readFileSync(path.join(ROOT, 'engine.py'), 'utf-8');
  const marker = 'WORKER_INIT_TEMPLATE = r"""';
  const start = src.indexOf(marker) + marker.length;
  const end = src.indexOf('"""', start);
  return src.slice(start, end);
}

test('воркер-шаблон собирается подстановкой JSON и остаётся валидным JS', () => {
  const rendered = extractWorkerTemplate().replace('/*__IDENTITY__*/ null', JSON.stringify(IDENTITY));
  assert.ok(!rendered.includes('/*__IDENTITY__*/'), 'плейсхолдер не подставлен');
  new vm.Script(rendered, { filename: 'worker-init.js' });   // бросит при синтаксисе
  const engine = fs.readFileSync(path.join(ROOT, 'engine.py'), 'utf-8');
  assert.ok(engine.includes('build_worker_init'), 'нет сборщика воркер-скрипта');
});

test('воркер-шаблон закрывает те же векторы, что и кадры', () => {
  const tpl = extractWorkerTemplate();
  for (const needle of ['languages', 'platform', 'hardwareConcurrency', 'deviceMemory',
                        'MAX_TEXTURE_SIZE', 'WEBGL_debug_renderer_info',
                        'OffscreenCanvas', 'getImageData', 'toString']) {
    assert.ok(tpl.includes(needle), 'в воркер-шаблоне нет ' + needle);
  }
});

test('воркер-шаблон не создаёт свойств, которых в WorkerNavigator не бывает', () => {
  const tpl = extractWorkerTemplate();
  // В настоящем Chrome внутри воркера нет navigator.webdriver и maxTouchPoints:
  // их появление — мгновенный признак подделки, поэтому только «in navigator».
  assert.ok(!/defineGetter\(NAV, 'webdriver'/.test(tpl), 'в воркере не должно быть webdriver');
  assert.ok(!/defineGetter\(NAV, 'maxTouchPoints'/.test(tpl), 'в воркере не должно быть maxTouchPoints');
  assert.ok(tpl.includes("var CAN = function (name)"), 'нет проверки наличия свойства');
});

test('воркер-скрипт несёт шум canvas профиля (как <canvas> в кадрах)', () => {
  const tpl = extractWorkerTemplate();
  assert.ok(tpl.includes('ID.canvas_noise'), 'шум не берётся из отпечатка');
  assert.ok(tpl.includes('cseed'), 'нет детерминированного зерна профиля');
});

// отчёт
const failed = results.filter((r) => r[0] === 'fail');
results.forEach((r) => console.log((r[0] === 'ok' ? '  ✓ ' : '  ✗ ') + r[1]));
console.log('\npageinit: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено');
process.exit(failed.length ? 1 : 0);
