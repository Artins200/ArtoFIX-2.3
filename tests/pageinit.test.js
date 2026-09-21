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
  audio_freq_shift: 0.0000412,
  media: {
    video: { h264: 'probably', vp9: 'probably' },
    audio: { opus: 'probably', mp3: 'probably' },
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
    WeakMap, Int32Array, Uint8ClampedArray, Promise, Math, Object, JSON, Error, String, Array,
  }));
  vm.runInContext(script, ctx, { filename: 'page-init.js' });
  return Object.assign(dom, { ctx });
}

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

// отчёт
const failed = results.filter((r) => r[0] === 'fail');
results.forEach((r) => console.log((r[0] === 'ok' ? '  ✓ ' : '  ✗ ') + r[1]));
console.log('\npageinit: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено');
process.exit(failed.length ? 1 : 0);
