'use strict';
/* Минимальная имитация окружения браузера: нужна, чтобы прогнать
   page-init скрипт антидетекта в Node и проверить, что патчи реально
   работают и не падают. Это не jsdom — только то, что патчит engine.py. */

function makeFakeDom() {
  // ── canvas 2d ──
  function makeImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  const CanvasRenderingContext2D = {
    prototype: {
      getImageData(sx, sy, sw, sh) { return makeImageData(sw, sh); },
      putImageData() {},
      createImageData(w, h) { return makeImageData(w, h); },
    },
  };
  const HTMLCanvasElement = {
    prototype: {
      width: 100, height: 100,
      getContext() { return CanvasRenderingContext2D.prototype; },
      toDataURL() { return 'data:image/png;base64,AAAA'; },
      toBlob(cb) { cb({ size: 1 }); },
    },
  };

  // ── WebGL ──
  const glCalls = [];
  const WebGLRenderingContext = {
    prototype: {
      getParameter(pname) {
        glCalls.push(pname);
        if (pname === 0x1f00) return 'WebKit';
        if (pname === 0x1f01) return 'WebKit WebGL';
        if (pname === 0x9245) return 'Intel Inc.';
        if (pname === 0x9246) return 'Intel Iris OpenGL Engine';
        if (pname === 0x0d33) return 16384;
        return null;
      },
      getSupportedExtensions() { return ['WEBGL_multi_draw']; },
    },
  };

  // ── media / audio / permissions ──
  const AnalyserNode = { prototype: { getFloatFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = -100; },
                                      getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 10; } } };
  // AudioBuffer с реальными выборками: чтобы проверить шум OfflineAudioContext
  function AudioBuffer() {
    this._channels = { 0: new Float32Array(64), 1: new Float32Array(64) };
    for (const k of [0, 1]) for (let i = 0; i < 64; i++) this._channels[k][i] = Number(k) + i * 0.001;
  }
  AudioBuffer.prototype.getChannelData = function (channel) { return this._channels[channel]; };
  AudioBuffer.prototype.copyFromChannel = function (dest, channel, start) {
    const src = this._channels[channel];
    const s = start || 0;
    for (let i = 0; i < dest.length; i++) dest[i] = src[s + i];
  };
  const HTMLMediaElement = { prototype: { canPlayType() { return ''; } } };
  const MediaSource = { isTypeSupported() { return false; } };
  const Permissions = { prototype: { query() { return Promise.resolve({ state: 'denied' }); } } };
  function PermissionStatus() {}
  const Notification = {
    permission: 'denied',
    requestPermission(cb) { if (cb) cb('denied'); return Promise.resolve('denied'); },
  };
  const NetworkInformation = function NetworkInformation() {};

  // ── "окно" ──
  const navigator = {};
  Object.setPrototypeOf(navigator, {
    webdriver: true,
    platform: 'Linux x86_64',
    languages: ['en-US'],
    language: 'en-US',
    hardwareConcurrency: 64,
    deviceMemory: 2,
    maxTouchPoints: 5,
    connection: { effectiveType: '2g', downlink: 1, rtt: 500 },
  });
  const screen = { width: 800, height: 600, availWidth: 800, availHeight: 560, colorDepth: 24, pixelDepth: 24 };

  const document = {
    $cdc_asdjflasutopfhvcZLmcfl_: {},
    cdc_adoQpoasnfa76pfcZLmcfl_Array: function () {},
    fonts: { check() { return false; } },
    hasFocus: function () { return false; },
  };

  const win = {
    navigator,
    screen,
    document,
    devicePixelRatio: 3,
    outerWidth: 800,
    outerHeight: 600,
    chrome: {},
    CanvasRenderingContext2D,
    HTMLCanvasElement,
    WebGLRenderingContext,
    WebGL2RenderingContext: { prototype: Object.create(WebGLRenderingContext.prototype) },
    AnalyserNode,
    AudioBuffer,
    HTMLMediaElement,
    MediaSource,
    Permissions,
    PermissionStatus,
    NetworkInformation,
    Notification,
    RTCPeerConnection: function RTCPeerConnection() { this.addEventListener = function () {}; },
    AudioContext: function AudioContext() {},
  };
  win.window = win;
  win.self = win;
  win.WebGL2RenderingContext.prototype.getParameter = WebGLRenderingContext.prototype.getParameter;

  return { win, navigator, screen, document, glCalls };
}

module.exports = { makeFakeDom };
