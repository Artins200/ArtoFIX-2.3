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
  const HTMLMediaElement = { prototype: { canPlayType() { return ''; } } };
  const Permissions = { prototype: { query() { return Promise.resolve({ state: 'denied' }); } } };
  const Notification = { permission: 'denied' };

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
    HTMLMediaElement,
    MediaSource: { isTypeSupported() { return false; } },
    Permissions,
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
