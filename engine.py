#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ARTOFIX 2.5 — BROWSER ENGINE
=============================================================
Запускает браузер профиля и применяет к нему отпечаток, который
посчитал main-процесс (config.json → identity, схема v2).

Принципы (подробности — docs/ANTI-DETECT.md):
  1. Один источник правды: отпечаток считает fingerprint-identity.js,
     здесь он только применяется — никаких «додумываний» на месте.
  2. Применяем через CDP (Network/Emulation) там, где это возможно:
     так значения совпадают и в JS, и в сетевых заголовках (Client Hints).
  3. Всё, что CDP не умеет, патчим page-init скриптом ДО первой
     навигации и прячем следы патча через Function.prototype.toString.
  4. Стабильность важнее случайности: внутри одного профиля отпечаток
     не меняется (меняющийся отпечаток — сам по себе признак бота).
  5. Убираем следы автоматизации: navigator.webdriver, cdc_*-переменные
     ChromeDriver, признаки отсутствующего chrome.runtime и т.п.
  6. Человекоподобное поведение (движение мыши, набор, прокрутка) —
     обязательная часть прохождения капчи, а не «косметика».
"""

import glob
import json
import os
import subprocess
import sys
import time


# ─────────────────────────────────────────────
#  КОНСОЛЬ БЕЗ UnicodeEncodeError
#  Windows часто отдаёт stdout/stderr в кодовой
#  странице cp1251/cp866, и символы вроде «→» или
#  «✓» роняли процесс с UnicodeEncodeError.
#  Принудительно UTF-8 + замена неприводимых символов.
# ─────────────────────────────────────────────
def _safe_console():
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            try:
                import io as _io
                setattr(sys, name, _io.TextIOWrapper(
                    stream.buffer, encoding="utf-8", errors="replace", line_buffering=True))
            except Exception:
                pass


_safe_console()


# ─────────────────────────────────────────────
#  ЗАВИСИМОСТИ (ленивая установка, как раньше)
# ─────────────────────────────────────────────
def _pip(pkg):
    subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", pkg, "-q"], check=False)


try:
    from selenium_stealth import stealth  # noqa: F401
    STEALTH_OK = True
except ImportError:
    print("[engine] Installing selenium-stealth...")
    _pip("selenium-stealth")
    try:
        from selenium_stealth import stealth  # noqa: F401
        STEALTH_OK = True
    except ImportError:
        STEALTH_OK = False

try:
    import selenium  # noqa: F401
except ImportError:
    print("[engine] Installing selenium...")
    _pip("selenium")

try:
    import webdriver_manager  # noqa: F401
except ImportError:
    print("[engine] Installing webdriver-manager...")
    _pip("webdriver-manager")

from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.edge.options import Options as EdgeOptions
from selenium.webdriver.edge.service import Service as EdgeService
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.firefox.service import Service as FirefoxService


# ─────────────────────────────────────────────
#  ДРАЙВЕРЫ
# ─────────────────────────────────────────────
def _fix_wdm_path(path, name_hint):
    if path and os.path.isfile(path) and (path.endswith(".exe") or os.access(path, os.X_OK)):
        return path
    d = os.path.dirname(path) if path else ""
    for pattern in (name_hint + "*.exe", name_hint + "*"):
        for c in glob.glob(os.path.join(d, pattern)):
            if os.path.isfile(c) and "LICENSE" not in c and "THIRD" not in c:
                return c
    return path


def _browser_version_from_registry(name):
    """Версия Chrome/Edge из реестра — чтобы драйвер и UA совпадали с реальным бинарником."""
    import re as _re
    keys = {
        "chrome": [
            r"HKLM\SOFTWARE\Google\Chrome\BLBeacon",
            r"HKLM\SOFTWARE\WOW6432Node\Google\Chrome\BLBeacon",
            r"HKCU\SOFTWARE\Google\Chrome\BLBeacon",
        ],
        "edge": [
            r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}",
            r"HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}",
        ],
    }
    val_name = "pv" if name == "edge" else "version"
    for key in keys.get(name, []):
        try:
            r = subprocess.run(["reg", "query", key, "/v", val_name],
                               capture_output=True, text=True, timeout=5)
            m = _re.search(rf"{val_name}\s+REG_SZ\s+([\d.]+)", r.stdout, _re.I)
            if m:
                return m.group(1)
        except Exception:
            pass
    return None


def _clean_wdm_cache(driver_name, keep_major):
    """Удаляет кэш драйверов, не соответствующий текущей версии браузера."""
    import shutil
    cache_dir = os.path.join(os.path.expanduser("~"), ".wdm", "drivers", driver_name)
    if not os.path.isdir(cache_dir) or not keep_major:
        return
    removed = 0
    try:
        for entry in os.listdir(cache_dir):
            if not entry.startswith(str(keep_major)):
                shutil.rmtree(os.path.join(cache_dir, entry), ignore_errors=True)
                removed += 1
    except Exception as e:
        print(f"[engine] cache cleanup warning: {e}")


def _driver_from_config(key):
    root = os.environ.get("ARTOFIX_ROOT") or os.path.dirname(os.path.abspath(__file__))
    cfg_file = os.environ.get("ARTOFIX_CONFIG") or os.path.join(root, "config.json")
    try:
        with open(cfg_file, "r", encoding="utf-8") as f:
            p = json.load(f).get(key)
        if isinstance(p, str) and p.lower().endswith(".exe") and os.path.isfile(p):
            return p
    except Exception:
        pass
    return None


def get_chrome_driver_path():
    root = os.environ.get("ARTOFIX_ROOT") or os.path.dirname(os.path.abspath(__file__))
    local = os.path.join(root, "drivers", "chromedriver.exe")
    if os.path.isfile(local):
        return local
    cfg = _driver_from_config("chromedriver_path")
    if cfg:
        return cfg
    try:
        from webdriver_manager.chrome import ChromeDriverManager
        ver = _browser_version_from_registry("chrome")
        if ver:
            _clean_wdm_cache("chromedriver", int(ver.split(".")[0]))
        try:
            mgr = ChromeDriverManager(driver_version=ver) if ver else ChromeDriverManager()
        except TypeError:
            mgr = ChromeDriverManager(version=ver) if ver else ChromeDriverManager()
        return _fix_wdm_path(mgr.install(), "chromedriver")
    except Exception as e:
        print(f"[engine] ChromeDriver error: {e}")
        return None


def get_edge_driver_path():
    root = os.environ.get("ARTOFIX_ROOT") or os.path.dirname(os.path.abspath(__file__))
    local = os.path.join(root, "drivers", "msedgedriver.exe")
    if os.path.isfile(local):
        return local
    cfg = _driver_from_config("edgedriver_path")
    if cfg:
        return cfg
    try:
        from webdriver_manager.microsoft import EdgeChromiumDriverManager
        ver = _browser_version_from_registry("edge")
        if ver:
            _clean_wdm_cache("msedgedriver", int(ver.split(".")[0]))
        try:
            mgr = EdgeChromiumDriverManager(driver_version=ver) if ver else EdgeChromiumDriverManager()
        except TypeError:
            try:
                mgr = EdgeChromiumDriverManager(version=ver) if ver else EdgeChromiumDriverManager()
            except TypeError:
                mgr = EdgeChromiumDriverManager()
        return _fix_wdm_path(mgr.install(), "msedgedriver")
    except Exception as e:
        print(f"[engine] EdgeDriver error: {e}")
        return None


def get_gecko_driver_path():
    try:
        from webdriver_manager.firefox import GeckoDriverManager
        return _fix_wdm_path(GeckoDriverManager().install(), "geckodriver")
    except Exception as e:
        print(f"[engine] GeckoDriver error: {e}")
        return None


# ─────────────────────────────────────────────
#  PAGE-INIT СКРИПТ (патчи, которые CDP не умеет)
#  Значения подставляются как JSON — никакой конкатенации строк.
# ─────────────────────────────────────────────
PAGE_INIT_TEMPLATE = r"""
(function () {
  'use strict';
  var ID = /*__IDENTITY__*/ null;
  if (!ID) return;

  // ── 0. Прячем собственный патч от Function.prototype.toString ──
  var nativeMap = new WeakMap();
  var origToString = Function.prototype.toString;
  function markNative(fn, name) {
    try { nativeMap.set(fn, 'function ' + (name || fn.name || '') + '() { [native code] }'); } catch (e) {}
    return fn;
  }
  var patchedToString = function toString() {
    var orig = nativeMap.get(this);
    if (orig) return orig;
    return origToString.call(this);
  };
  markNative(patchedToString, 'toString');
  try { Object.defineProperty(Function.prototype, 'toString', { value: patchedToString, writable: true, configurable: true }); } catch (e) {}

  function defineGetter(target, prop, getter) {
    try {
      Object.defineProperty(target, prop, { get: markNative(getter, 'get ' + prop), configurable: true });
    } catch (e) {}
  }
  function defineValue(target, prop, value) {
    try {
      Object.defineProperty(target, prop, { value: value, writable: true, configurable: true, enumerable: true });
    } catch (e) {}
  }

  var V = ID.vectors || {};

  // ── 1. Следы автоматизации ──
  try {
    var navProto = Object.getPrototypeOf(navigator);
    delete navProto.webdriver;
    defineGetter(navProto, 'webdriver', function () { return false; });
  } catch (e) {}
  // ВАЖНО: own-свойство 'webdriver' на самом navigator НЕ создаём — в живом
  // Chrome getter живёт только на Navigator.prototype, а собственные свойства
  // на navigator перечисляются через getOwnPropertyNames и детектятся мгновенно.
  var AUTOMATION_EXACT = [
    '_phantom', '__nightmare', 'callPhantom', '_selenium', 'callSelenium', 'calledSelenium',
    '_Selenium_IDE_Recorder', '_WEBDRIVER_ELEM_CACHE',
    '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_function',
    '__webdriver_script_func', '__webdriver_script_fn', '__webdriver_script_fn_called',
    '__webdriver_script_result', '__webdriver_script_error', '__fxdriver_evaluate',
    '__driver_unwrapped', '__driver_evaluate', '__webdriver_unwrapped',
    '__selenium_unwrapped', '__fxdriver_unwrapped', '__webdriver_ctrc', '__webdriver_chr',
    '__lastWatirAlert', '__lastWatirConfirm', '__lastWatirPrompt',
    'domAutomation', 'domAutomationController', 'domAutomationControllerId',
  ];
  ['window', 'document'].forEach(function (scopeName) {
    var scope = scopeName === 'window' ? window : document;
    try {
      Object.getOwnPropertyNames(scope).forEach(function (key) {
        if (/^\$?cdc_/i.test(key) || AUTOMATION_EXACT.indexOf(key) !== -1) {
          try { delete scope[key]; } catch (e) {}
        }
      });
    } catch (e) {}
  });

  // ── 1.1 Обход защиты Claude / Cloudflare Turnstile: window.chrome ──
  // Проверки Challenge смотрят на ПОВЕДЕНИЕ этих API: loadTimes() в живом
  // Chrome отдаёт ЗАМОРОЖЕННЫЕ метки (не «плывут» при повторных вызовах и
  // никогда не из будущего), csi() — startE=абсолютная эпоха, onloadT=время
  // от startE, pageT растёт от старта страницы. Плывущие/«будущие» значения —
  // классический детект автогенеренных заглушек.
  try {
    if (!window.chrome) { defineValue(window, 'chrome', {}); }
    if (window.chrome) {
      var t0 = Date.now();
      var startE = t0 - 300;          // «навигация» началась чуть раньше скрипта
      var onloadT = 312.7;            // ms от startE до onload — фиксированы

      if (!window.chrome.runtime) {
        var makeNoop = function (name) {
          return markNative(function () { return undefined; }, name);
        };
        window.chrome.runtime = {
          id: undefined,
          connect: makeNoop('connect'),
          sendMessage: makeNoop('sendMessage'),
          onMessage: {
            addListener: makeNoop('addListener'),
            removeListener: makeNoop('removeListener'),
          },
          getPlatformInfo: markNative(function (cb) {
            if (typeof cb === 'function') cb({ os: 'win', arch: 'x86-64' });
          }, 'getPlatformInfo'),
        };
      }
      if (!window.chrome.csi) {
        window.chrome.csi = markNative(function () {
          return {
            onloadT: onloadT,
            pageT: Math.max(onloadT, Date.now() - startE),
            startE: startE,
            tran: 15,
          };
        }, 'csi');
      }
      if (!window.chrome.loadTimes) {
        var ltCache = null;
        window.chrome.loadTimes = markNative(function () {
          if (!ltCache) {
            var nowSec = Date.now() / 1000;
            var requestTime = nowSec - 0.35;
            ltCache = {
              requestTime: requestTime,
              startLoadTime: requestTime + 0.05,
              commitLoadTime: requestTime + 0.12,
              finishDocumentLoadTime: requestTime + 0.28,
              finishLoadTime: nowSec,               // ≤ now: из будущего не бывает
              firstPaintTime: requestTime + 0.24,
              firstPaintAfterLoadTime: 0,
              navigationType: 'Other',
              wasFetchedViaSpdy: true,
              wasNpnNegotiated: true,
              npnNegotiatedProtocol: 'h2',
              wasAlternateProtocolAvailable: false,
              connectionInfo: 'h2',
            };
          }
          // значения заморожены после загрузки — каждый вызов отдаёт копию
          // одного и того же объекта, как живой Chrome
          return {
            requestTime: ltCache.requestTime,
            startLoadTime: ltCache.startLoadTime,
            commitLoadTime: ltCache.commitLoadTime,
            finishDocumentLoadTime: ltCache.finishDocumentLoadTime,
            finishLoadTime: ltCache.finishLoadTime,
            firstPaintTime: ltCache.firstPaintTime,
            firstPaintAfterLoadTime: ltCache.firstPaintAfterLoadTime,
            navigationType: ltCache.navigationType,
            wasFetchedViaSpdy: ltCache.wasFetchedViaSpdy,
            wasNpnNegotiated: ltCache.wasNpnNegotiated,
            npnNegotiatedProtocol: ltCache.npnNegotiatedProtocol,
            wasAlternateProtocolAvailable: ltCache.wasAlternateProtocolAvailable,
            connectionInfo: ltCache.connectionInfo,
          };
        }, 'loadTimes');
      }
      if (!window.chrome.app) {
        window.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getIsInstalled: markNative(function () { return false; }, 'getIsInstalled'),
          getDetails: markNative(function () { return null; }, 'getDetails'),
          installState: markNative(function (cb) { if (typeof cb === 'function') cb('not_installed'); }, 'installState'),
          runningState: markNative(function () { return 'cannot_run'; }, 'runningState'),
        };
      }
    }
  } catch (e) {}

  // ── 1.2 Обход защиты Claude / Turnstile: plugins и mimeTypes ──
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      var fakePluginsList = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      var fakeMimesList = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      var pluginArrProto = typeof PluginArray !== 'undefined' ? PluginArray.prototype : Object.prototype;
      var pluginProto = typeof Plugin !== 'undefined' ? Plugin.prototype : Object.prototype;
      var mimeArrProto = typeof MimeTypeArray !== 'undefined' ? MimeTypeArray.prototype : Object.prototype;
      var mimeProto = typeof MimeType !== 'undefined' ? MimeType.prototype : Object.prototype;

      var fakePlugins = Object.create(pluginArrProto);
      fakePluginsList.forEach(function (p, i) {
        var pl = Object.create(pluginProto);
        pl.name = p.name;
        pl.filename = p.filename;
        pl.description = p.description;
        pl.length = fakeMimesList.length;
        fakePlugins[i] = pl;
        fakePlugins[p.name] = pl;
      });
      fakePlugins.length = fakePluginsList.length;
      fakePlugins.item = markNative(function (idx) { return this[idx] || null; }, 'item');
      fakePlugins.namedItem = markNative(function (name) { return this[name] || null; }, 'namedItem');
      fakePlugins.refresh = markNative(function () {}, 'refresh');
      defineGetter(Object.getPrototypeOf(navigator), 'plugins', function () { return fakePlugins; });

      var fakeMimes = Object.create(mimeArrProto);
      fakeMimesList.forEach(function (m, i) {
        var mi = Object.create(mimeProto);
        mi.type = m.type;
        mi.suffixes = m.suffixes;
        mi.description = m.description;
        mi.enabledPlugin = fakePlugins[0];
        fakeMimes[i] = mi;
        fakeMimes[m.type] = mi;
      });
      fakeMimes.length = fakeMimesList.length;
      fakeMimes.item = markNative(function (idx) { return this[idx] || null; }, 'item');
      fakeMimes.namedItem = markNative(function (name) { return this[name] || null; }, 'namedItem');
      defineGetter(Object.getPrototypeOf(navigator), 'mimeTypes', function () { return fakeMimes; });
    }
    // navigator.pdfViewerEnabled: в живом Chrome с PDF Viewer = true и обязан
    // совпадать с наличием PDF-плагинов выше (их сверяют вместе)
    if (ID.pdf_viewer_enabled !== false) {
      defineGetter(Object.getPrototypeOf(navigator), 'pdfViewerEnabled', function () { return true; });
    }
  } catch (e) {}

  // ── 1.3 Обход защиты Claude / Turnstile: document.hasFocus и visibility ──
  // Окно «живое»: hasFocus() = true и visibilityState = 'visible' всегда идут
  // ПАРОЙ (focus + hidden одновременно — мгновенный флаг). Патчим прототип
  // Document: own-свойства на document перечисляются getOwnPropertyNames и
  // сами по себе выдают подмену.
  try {
    if (document) {
      var docProto = (typeof Document !== 'undefined' && Document.prototype) || null;
      if (docProto && docProto.hasFocus) {
        docProto.hasFocus = markNative(function hasFocus() { return true; }, 'hasFocus');
        defineGetter(docProto, 'hidden', function () { return false; });
        defineGetter(docProto, 'visibilityState', function () { return 'visible'; });
      } else {
        document.hasFocus = markNative(function hasFocus() { return true; }, 'hasFocus');
        defineGetter(document, 'hidden', function () { return false; });
        defineGetter(document, 'visibilityState', function () { return 'visible'; });
      }
    }
  } catch (e) {}

  // ── 2. navigator: языки, платформа, железо ──
  if (ID.languages && ID.languages.length) {
    // В живом Chrome navigator.languages — ОДИН и тот же замороженный массив
    // (navigator.languages === navigator.languages). Новый массив на каждый
    // getter-вызов — известный детект самодельных патчей.
    var langList = ID.languages.slice();
    try { Object.freeze(langList); } catch (e) {}
    defineGetter(Object.getPrototypeOf(navigator), 'languages', function () { return langList; });
    defineGetter(Object.getPrototypeOf(navigator), 'language', function () { return langList[0]; });
  }
  if (V.platform !== false && ID.ua_platform === 'Windows') {
    defineGetter(Object.getPrototypeOf(navigator), 'platform', function () { return 'Win32'; });
  }
  if (V.hw !== false && ID.hardware) {
    defineGetter(Object.getPrototypeOf(navigator), 'hardwareConcurrency', function () { return ID.hardware.cores; });
    defineGetter(Object.getPrototypeOf(navigator), 'deviceMemory', function () { return ID.hardware.device_memory; });
    defineGetter(Object.getPrototypeOf(navigator), 'maxTouchPoints', function () { return ID.hardware.max_touch_points || 0; });
  }
  if (ID.connection) {
    // Один объект NetworkInformation на весь документ (connection === connection).
    // Нестандартного поля 'type' быть НЕ должно: живой Chrome его не отдаёт —
    // его наличие = готовый детект подделки.
    var NI = (typeof NetworkInformation !== 'undefined') ? NetworkInformation.prototype : Object.prototype;
    var conn = Object.create(NI);
    conn.effectiveType = ID.connection.effective_type;
    conn.downlink = ID.connection.downlink;
    conn.rtt = ID.connection.rtt;
    conn.saveData = !!ID.connection.save_data;
    conn.onchange = null;
    conn.addEventListener = markNative(function () {}, 'addEventListener');
    conn.removeEventListener = markNative(function () {}, 'removeEventListener');
    conn.dispatchEvent = markNative(function () { return true; }, 'dispatchEvent');
    defineGetter(Object.getPrototypeOf(navigator), 'connection', function () { return conn; });
  }

  // ── 3. Экран ──
  // Свойства экрана/окна в живом Chrome живут на Screen.prototype и
  // Window.prototype. Ставим геттеры туда же: own-свойства на самом window/screen
  // «светятся» в getOwnPropertyDescriptor и выдают подмену. Если прототип
  // недоступен (тестовое окружение) — откатываемся на объект.
  if (V.screen !== false && ID.screen) {
    var S = ID.screen;
    var sTarget = screen, wTarget = window;
    try {
      if (typeof Screen !== 'undefined' && Screen.prototype &&
          Object.getOwnPropertyDescriptor(Screen.prototype, 'width')) {
        sTarget = Screen.prototype;
      }
    } catch (e) {}
    try {
      if (typeof Window !== 'undefined' && Window.prototype &&
          Object.getOwnPropertyDescriptor(Window.prototype, 'outerWidth')) {
        wTarget = Window.prototype;
      }
    } catch (e) {}
    defineGetter(sTarget, 'width', function () { return S.width; });
    defineGetter(sTarget, 'height', function () { return S.height; });
    defineGetter(sTarget, 'availWidth', function () { return S.avail_width; });
    defineGetter(sTarget, 'availHeight', function () { return S.avail_height; });
    defineGetter(sTarget, 'colorDepth', function () { return S.color_depth; });
    defineGetter(sTarget, 'pixelDepth', function () { return S.pixel_depth; });
    if (S.device_pixel_ratio) {
      defineGetter(wTarget, 'devicePixelRatio', function () { return S.device_pixel_ratio; });
    }
    defineGetter(wTarget, 'outerWidth', function () { return S.outer_width; });
    defineGetter(wTarget, 'outerHeight', function () { return S.outer_height; });
  }

  // ── 4. WebGL: vendor/renderer + лимиты одного класса GPU ──
  if (V.webgl !== false && ID.webgl) {
    var W = ID.webgl;
    var LIM = W.limits || {};
    var P = { UNMASKED_VENDOR: 0x9245, UNMASKED_RENDERER: 0x9246,
              MAX_TEXTURE_SIZE: 0x0D33, MAX_RENDERBUFFER_SIZE: 0x84E8, MAX_VIEWPORT_DIMS: 0x0D3A,
              MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
              MAX_VARYING_VECTORS: 0x8DFC, MAX_VERTEX_ATTRIBS: 0x8869,
              MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
              MAX_TEXTURE_IMAGE_UNITS: 0x8872 };
    var LIM_KEYS;
    try { LIM_KEYS = Object.keys(P); } catch (e) { LIM_KEYS = []; }
    var limValue = {};
    limValue[P.MAX_TEXTURE_SIZE] = LIM.MAX_TEXTURE_SIZE;
    limValue[P.MAX_RENDERBUFFER_SIZE] = LIM.MAX_RENDERBUFFER_SIZE;
    limValue[P.MAX_VIEWPORT_DIMS] = LIM.MAX_VIEWPORT_DIMS;
    limValue[P.MAX_VERTEX_UNIFORM_VECTORS] = LIM.MAX_VERTEX_UNIFORM_VECTORS;
    limValue[P.MAX_FRAGMENT_UNIFORM_VECTORS] = LIM.MAX_FRAGMENT_UNIFORM_VECTORS;
    limValue[P.MAX_VARYING_VECTORS] = LIM.MAX_VARYING_VECTORS;
    limValue[P.MAX_VERTEX_ATTRIBS] = LIM.MAX_VERTEX_ATTRIBS;
    limValue[P.MAX_COMBINED_TEXTURE_IMAGE_UNITS] = LIM.MAX_COMBINED_TEXTURE_IMAGE_UNITS;
    limValue[P.MAX_CUBE_MAP_TEXTURE_SIZE] = LIM.MAX_CUBE_MAP_TEXTURE_SIZE;
    limValue[P.MAX_TEXTURE_IMAGE_UNITS] = LIM.MAX_TEXTURE_IMAGE_UNITS;

    function patchGL(Proto) {
      if (!Proto || !Proto.getParameter) return;
      var orig = Proto.getParameter;
      var patched = function getParameter(pname) {
        // 0x1F00/0x1F01 (VENDOR/RENDERER) НЕ трогаем: в живом Chrome там
        // «WebKit» / «WebKit WebGL», и подмена этих констант — сама по себе флаг.
        switch (pname) {
          case 0x9245: return W.vendor || W.unmasked_vendor;
          case 0x9246: return W.renderer || W.unmasked_renderer;
          case 0x0D3A: return new Int32Array(LIM.MAX_VIEWPORT_DIMS || [16384, 16384]);
          default: break;
        }
        if (Object.prototype.hasOwnProperty.call(limValue, pname) && limValue[pname] !== undefined
            && limValue[pname] !== null) {
          return limValue[pname];
        }
        return orig.apply(this, arguments);
      };
      markNative(patched, 'getParameter');
      try { Proto.getParameter = patched; } catch (e) {}
      var origExt = Proto.getSupportedExtensions;
      if (origExt) {
        var patchedExt = function getSupportedExtensions() {
          var list = origExt.apply(this, arguments) || [];
          if (list.indexOf('WEBGL_debug_renderer_info') === -1) list = list.concat(['WEBGL_debug_renderer_info']);
          return list;
        };
        markNative(patchedExt, 'getSupportedExtensions');
        try { Proto.getSupportedExtensions = patchedExt; } catch (e) {}
      }
    }
    try { patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype); } catch (e) {}
    try { patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype); } catch (e) {}
  }

  // ── 5. Canvas: детерминированный шум профиля ──
  // Меняем младшие биты нескольких пикселей в детерминированных позициях:
  // картинка визуально та же, но хеш уникален для профиля и ОДИНАКОВ при
  // каждом вызове (меняющийся canvas — сам по себе признак подделки).
  if (V.canvas !== false && ID.canvas_noise) {
    var cseed = ID.canvas_noise | 0;
    function perturb(data, w, h) {
      if (!data || !data.length || !w || !h) return data;
      for (var i = 0; i < 12; i++) {
        var px = Math.abs((cseed * 31 + i * 7919) % w);
        var py = Math.abs((cseed * 17 + i * 104729) % h);
        var o = (py * w + px) * 4;
        if (o + 2 >= data.length) continue;
        var v = ((px * 73856093) ^ (py * 19349663) ^ (i * 40503) ^ cseed) >>> 0;
        var d = (v % 3) - 1;
        data[o] = Math.max(0, Math.min(255, data[o] + d));
        data[o + 2] = Math.max(0, Math.min(255, data[o + 2] + d));
      }
      return data;
    }

    var CtxProto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
    var rawGetImageData = CtxProto && CtxProto.getImageData;
    var canvasProto = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
    var origToDataURL = canvasProto && canvasProto.toDataURL;
    var origToBlob = canvasProto && canvasProto.toBlob;

    function makeNoisy(ctx, w, h) {
      var img = rawGetImageData.call(ctx, 0, 0, w, h);
      perturb(img.data, img.width, img.height);
      return img;
    }
    function snapshot(ctx, w, h) { return rawGetImageData.call(ctx, 0, 0, w, h); }

    if (CtxProto && rawGetImageData) {
      var patchedGetImageData = function getImageData(sx, sy, sw, sh) {
        var img = rawGetImageData.apply(this, arguments);
        try { perturb(img.data, img.width, img.height); } catch (e) {}
        return img;
      };
      markNative(patchedGetImageData, 'getImageData');
      CtxProto.getImageData = patchedGetImageData;
    }

    if (canvasProto && origToDataURL) {
      var patchedToDataURL = function toDataURL() {
        var ctx = null;
        try { ctx = this.getContext && this.getContext('2d'); } catch (e) {}
        if (!ctx || !this.width || !this.height) return origToDataURL.apply(this, arguments);
        var backup = null;
        try { backup = snapshot(ctx, this.width, this.height); } catch (e) {}
        if (!backup) return origToDataURL.apply(this, arguments);
        var out;
        try {
          ctx.putImageData(makeNoisy(ctx, this.width, this.height), 0, 0);
          out = origToDataURL.apply(this, arguments);
        } finally {
          try { ctx.putImageData(backup, 0, 0); } catch (e) {}
        }
        return out;
      };
      markNative(patchedToDataURL, 'toDataURL');
      canvasProto.toDataURL = patchedToDataURL;
    }

    if (canvasProto && origToBlob) {
      // Арность 1 — как у нативного toBlob; состояние живёт в ЗАМЫКАНИИ:
      // никаких __artofix_* свойств на самом canvas (их перечисляют детекторы)
      var patchedToBlob = function toBlob(cb) {
        var type = arguments[1], quality = arguments[2];
        var ctx = null;
        try { ctx = this.getContext && this.getContext('2d'); } catch (e) {}
        if (!ctx || !this.width || !this.height || typeof cb !== 'function') {
          return origToBlob.call(this, cb, type, quality);
        }
        var backup = null;
        try { backup = snapshot(ctx, this.width, this.height); } catch (e) {}
        if (!backup) return origToBlob.call(this, cb, type, quality);
        ctx.putImageData(makeNoisy(ctx, this.width, this.height), 0, 0);
        return origToBlob.call(this, function (blob) {
          try { ctx.putImageData(backup, 0, 0); } catch (e) {}
          cb(blob);
        }, type, quality);
      };
      markNative(patchedToBlob, 'toBlob');
      canvasProto.toBlob = patchedToBlob;
    }
  }

  // ── 6. AudioContext: стабильный сдвиг вместо реального железа ──
  // Главный аудио-вектор антибот-скрипт (fingerprintjs и т.п.) — OfflineAudioContext:
  // осциллятор + компрессор рендерятся и читаются через AudioBuffer.getChannelData /
  // copyFromChannel. Шумим сами ВЫБОРКИ буфера — неслышимо на слух, стабильно в
  // пределах профиля и одинаково для обоих способов чтения (иначе — детект).
  if (V.audio !== false && (ID.audio_freq_shift || ID.audio_noise)) {
    try {
      var shift = ID.audio_freq_shift || 0;
      var anoise = ID.audio_noise || 1e-6;
      var cseedA = ID.canvas_noise | 0;

      var AnalyserProto = window.AnalyserNode && AnalyserNode.prototype;
      if (AnalyserProto) {
        var origFloat = AnalyserProto.getFloatFrequencyData;
        if (origFloat) {
          var pf = function getFloatFrequencyData(arr) {
            origFloat.apply(this, arguments);
            for (var i = 0; i < arr.length; i++) arr[i] = arr[i] + shift;
          };
          markNative(pf, 'getFloatFrequencyData');
          AnalyserProto.getFloatFrequencyData = pf;
        }
        var origByte = AnalyserProto.getByteFrequencyData;
        if (origByte) {
          var step = Math.round(shift * 100000) % 3;
          var pb = function getByteFrequencyData(arr) {
            origByte.apply(this, arguments);
            for (var i = 0; i < arr.length; i++) arr[i] = (arr[i] + step) % 256;
          };
          markNative(pb, 'getByteFrequencyData');
          AnalyserProto.getByteFrequencyData = pb;
        }
      }

      var AudioBufProto = window.AudioBuffer && AudioBuffer.prototype;
      if (AudioBufProto && AudioBufProto.getChannelData) {
        var origGetChannel = AudioBufProto.getChannelData;
        var origCopyFrom = AudioBufProto.copyFromChannel;
        // шум применяется РОВНО ОДИН раз на (буфер, канал): getChannelData
        // возвращает живую ссылку, повторное «шумление» накопило бы разницу
        var noisyDone = new WeakMap();
        var ensureNoisy = markNative(function (buf, channel) {
          try {
            var done = noisyDone.get(buf);
            if (!done) { done = {}; noisyDone.set(buf, done); }
            if (done[channel]) return;
            done[channel] = true;
            var arr = origGetChannel.call(buf, channel);
            if (!arr || !arr.length) return;
            var n = Math.min(arr.length, 64);
            for (var i = 0; i < n; i++) {
              var d = anoise * (((i + 1) * (channel + 3) + cseedA) % 7 - 3);
              arr[i] = arr[i] + d;
            }
          } catch (e) {}
        }, 'ensureNoisy');
        var patchedGetChannel = function getChannelData(channel) {
          ensureNoisy(this, channel);
          return origGetChannel.call(this, channel);
        };
        markNative(patchedGetChannel, 'getChannelData');
        AudioBufProto.getChannelData = patchedGetChannel;
        if (origCopyFrom) {
          var patchedCopyFrom = function copyFromChannel(dest, channel) {
            ensureNoisy(this, channel);
            return origCopyFrom.apply(this, arguments);
          };
          markNative(patchedCopyFrom, 'copyFromChannel');
          AudioBufProto.copyFromChannel = patchedCopyFrom;
        }
      }
    } catch (e) {}
  }

  // ── 7. Медиакодеки: ответы должны совпадать с заявленным железом ──
  if (V.media !== false && ID.media) {
    try {
      var el = window.HTMLMediaElement && HTMLMediaElement.prototype;
      if (el && el.canPlayType) {
        var origCanPlay = el.canPlayType;
        // Сначала ищем по CODEC-строке: h264/hvc1/av01 живут в одном контейнере
        // video/mp4, и поиск по префиксу MIME отвечал бы на запрос HEVC «probably»
        // от имени h264 — внутреннее противоречие отпечатка.
        var patched = function canPlayType(type) {
          var t = String(type || '').toLowerCase();
          var key = null;
          if (/avc[13x]|h\.?264/.test(t)) key = 'h264';
          else if (/hvc1|hev1|hevc/.test(t)) key = 'hevc';
          else if (/vp0?9/.test(t)) key = 'vp9';
          else if (/vp8/.test(t)) key = 'vp8';
          else if (/av01|av1/.test(t)) key = 'av1';
          else if (/theora/.test(t)) key = 'theora';
          else if (/vorbis/.test(t)) key = 'vorbis';
          else if (/opus/.test(t)) key = 'opus';
          else if (/mp3|mpeg[- ]?audio|audio\/mpeg|audio\/mp3/.test(t)) key = 'mp3';
          else if (/mp4a|aac/.test(t)) key = 'aac';
          else if (/flac/.test(t)) key = 'flac';
          else if (/pcm/.test(t)) key = 'pcm';
          else {
            // голый контейнер без codecs-строки — базовый кодек контейнера
            if (t.indexOf('video/mp4') === 0) key = 'h264';
            else if (t.indexOf('video/webm') === 0) key = 'vp9';
            else if (t.indexOf('audio/mp4') === 0) key = 'aac';
            else if (t.indexOf('audio/webm') === 0) key = 'opus';
            else if (t.indexOf('audio/ogg') === 0) key = 'vorbis';
            else if (t.indexOf('audio/mpeg') === 0) key = 'mp3';
          }
          if (key && ID.media.video && ID.media.video[key] !== undefined) return ID.media.video[key];
          if (key && ID.media.audio && ID.media.audio[key] !== undefined) return ID.media.audio[key];
          return origCanPlay.apply(this, arguments);
        };
        markNative(patched, 'canPlayType');
        el.canPlayType = patched;
      }
      if (window.MediaSource && window.MediaSource.isTypeSupported) {
        var origIsType = window.MediaSource.isTypeSupported;
        var patchedIsType = function isTypeSupported(type) {
          var t = String(type || '');
          if (Object.prototype.hasOwnProperty.call(ID.media.media_source, t)) return ID.media.media_source[t];
          return origIsType.apply(this, arguments);
        };
        markNative(patchedIsType, 'isTypeSupported');
        window.MediaSource.isTypeSupported = patchedIsType;
      }
    } catch (e) {}
  }

  // ── 8. Шрифты: список согласован с системным набором Windows ──
  if (V.fonts !== false && ID.fonts && document.fonts) {
    try {
      // check живёт на FontFaceSet.prototype; арность 0 — как у нативного
      var fontTarget = (typeof FontFaceSet !== 'undefined' && FontFaceSet.prototype) || document.fonts;
      var origCheck = fontTarget.check || document.fonts.check;
      var patchedCheck = function check() {
        var font = arguments.length ? arguments[0] : '';
        var family = String(font || '')
          .replace(/^.*?[\d.]+(?:px|pt|em|rem|%)?\s*/, '')
          .replace(/^["']|["']$/g, '')
          .split(',')[0].trim();
        if (ID.fonts.indexOf(family) !== -1) return true;
        return origCheck.apply(this, arguments);
      };
      markNative(patchedCheck, 'check');
      fontTarget.check = patchedCheck;
    } catch (e) {}
  }

  // ── 9. Разрешения: согласованы между API ──
  if (ID.permissions) {
    try {
      var PermProto = window.Permissions && Permissions.prototype;
      if (PermProto && PermProto.query) {
        var origQuery = PermProto.query;
        var PS = (typeof PermissionStatus !== 'undefined') ? PermissionStatus.prototype : null;
        var patchedQuery = function query(desc) {
          var name = desc && desc.name;
          var state = ID.permissions[name];
          if (state) {
            // объект-«статус» как настоящий PermissionStatus (instanceof обязан
            // проходить: голый объект literal — готовый детект подмены)
            var status = PS ? Object.create(PS) : {};
            try {
              Object.defineProperty(status, 'state', { value: state, configurable: true });
              Object.defineProperty(status, 'name', { value: name, configurable: true });
              Object.defineProperty(status, 'onchange', { value: null, writable: true, configurable: true });
            } catch (e) {
              status.state = state; status.name = name; status.onchange = null;
            }
            return Promise.resolve(status);
          }
          return origQuery.apply(this, arguments);
        };
        markNative(patchedQuery, 'query');
        PermProto.query = patchedQuery;
      }
      if (window.Notification) {
        // Notification.permission и requestPermission() обязаны отвечать ОДНИМ
        // и тем же состоянием: «default» + мгновенный granted из content-settings —
        // внутреннее противоречие, его детектят
        var notifState = ID.permissions.notifications || 'default';
        defineGetter(window.Notification, 'permission', function () { return notifState; });
        var patchedReqPerm = function requestPermission() {
          var cb = arguments.length ? arguments[0] : null;
          if (typeof cb === 'function') cb(notifState);
          return Promise.resolve(notifState);
        };
        markNative(patchedReqPerm, 'requestPermission');
        try { window.Notification.requestPermission = patchedReqPerm; } catch (e) {}
      }
    } catch (e) {}
  }

  // ── 10. WebRTC: не сливаем локальные адреса, если включён прокси ──
  if (ID.webrtc && ID.webrtc.mode === 'public_only' && window.RTCPeerConnection) {
    try {
      var OrigPC = window.RTCPeerConnection;
      // Строка кандидата выглядит как «candidate:… 192.168.1.5 54321 typ host» —
      // ищем приватный IP/ULA ВНУТРИ строки (привязка к ^ никогда не срабатывала).
      // 100.64.0.0/10 — CGNAT-диапазон провайдеров, f[cd]xx::/8 и fe80:: — IPv6 ULA/LL.
      var PRIV_IP_RE = /(?:^|[\s"'])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|::1|f[cd][0-9a-f]{2}:|fe80:)/i;
      var isPrivate = function (line) { return PRIV_IP_RE.test(line || ''); };
      // арность 0 — как у нативного конструктора (optional-параметры не считаются)
      var patchedPC = function RTCPeerConnection() {
        var pc = new OrigPC(arguments[0], arguments[1]);
        var origAdd = pc.addEventListener.bind(pc);
        var wrapListener = function (type, listener) {
          if (type === 'icecandidate' && typeof listener === 'function') {
            return function (ev) {
              if (ev && ev.candidate && isPrivate(ev.candidate.candidate)) return;
              return listener.apply(this, arguments);
            };
          }
          return listener;
        };
        try {
          pc.addEventListener = markNative(function (type, listener, opts) {
            return origAdd(type, wrapListener(type, listener), opts);
          }, 'addEventListener');
        } catch (e) {}
        // onicecandidate = fn — второй обязательный путь доставки кандидатов
        try {
          var onice = null;
          Object.defineProperty(pc, 'onicecandidate', {
            get: markNative(function () { return onice; }, 'get onicecandidate'),
            set: markNative(function (fn) {
              onice = (typeof fn === 'function') ? wrapListener('icecandidate', fn) : fn;
            }, 'set onicecandidate'),
            configurable: true,
          });
        } catch (e) {}
        return pc;
      };
      markNative(patchedPC, 'RTCPeerConnection');
      patchedPC.prototype = OrigPC.prototype;
      window.RTCPeerConnection = patchedPC;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = patchedPC;
    } catch (e) {}
  }
})();
"""


def build_page_init(identity):
    """Собирает page-init скрипт: значения уходят как JSON, не как код."""
    return PAGE_INIT_TEMPLATE.replace("/*__IDENTITY__*/ null", json.dumps(identity, ensure_ascii=False))


# ─────────────────────────────────────────────
#  ЧЕЛОВЕКОПОДОБНОЕ ПОВЕДЕНИЕ
# ─────────────────────────────────────────────
def human_warmup(driver, enabled=True):
    """
    Микро-активность после загрузки: курсор, лёгкая прокрутка, пауза.
    Капчи (reCAPTCHA/hCaptcha/Turnstile) оценивают взаимодействие —
    «мёртвая» страница без событий мыши даёт низкий score даже при
    идеальном отпечатке.
    """
    if not enabled:
        return
    try:
        import random
        import math

        size = driver.get_window_size()
        w, h = size.get("width", 1280), size.get("height", 720)

        # плавное движение курсора по кривой с easing
        start_x, start_y = random.randint(80, 200), random.randint(80, 200)
        end_x, end_y = random.randint(int(w * 0.4), int(w * 0.7)), random.randint(int(h * 0.3), int(h * 0.6))
        steps = random.randint(18, 30)
        for i in range(steps):
            t = i / (steps - 1.0)
            ease = t * t * (3 - 2 * t)                      # smoothstep
            x = start_x + (end_x - start_x) * ease + random.uniform(-1.5, 1.5)
            y = start_y + (end_y - start_y) * ease + math.sin(t * math.pi) * 12 + random.uniform(-1.5, 1.5)
            driver.execute_cdp_cmd("Input.dispatchMouseEvent",
                                   {"type": "mouseMoved", "x": int(x), "y": int(y), "modifiers": 0})
            time.sleep(random.uniform(0.008, 0.03))

        # немного «читаем» страницу: колесо мыши вниз-вверх
        for _ in range(random.randint(1, 3)):
            driver.execute_cdp_cmd("Input.dispatchMouseEvent",
                                   {"type": "mouseWheel", "x": int(end_x), "y": int(end_y),
                                    "deltaX": 0, "deltaY": random.randint(120, 420)})
            time.sleep(random.uniform(0.2, 0.6))
        if random.random() < 0.5:
            driver.execute_cdp_cmd("Input.dispatchMouseEvent",
                                   {"type": "mouseWheel", "x": int(end_x), "y": int(end_y),
                                    "deltaX": 0, "deltaY": -random.randint(80, 200)})
        time.sleep(random.uniform(0.3, 0.9))
    except Exception as e:
        print(f"[engine] warmup warning: {e}")


def human_pause(base=1.0, spread=0.8):
    import random
    time.sleep(max(0.05, random.uniform(base - spread / 2, base + spread / 2)))


# ─────────────────────────────────────────────
#  БРАУЗЕР
# ─────────────────────────────────────────────
class BrowserManager:
    def __init__(self):
        self.root = os.path.dirname(os.path.abspath(__file__))
        self.p_dir = os.environ.get("ARTOFIX_PROFILES") or os.path.join(self.root, "profiles")
        self.config_file = os.environ.get("ARTOFIX_CONFIG") or os.path.join(self.root, "config.json")
        os.makedirs(self.p_dir, exist_ok=True)

    # ── конфиг/отпечаток ──
    def load_config(self):
        try:
            with open(self.config_file, "r", encoding="utf-8") as f:
                return json.load(f) or {}
        except Exception as e:
            print(f"[engine] config error: {e}")
            return {}

    def build_identity(self, cfg, profile, browser):
        """
        Берёт identity из config.json (схема v2). Если её нет — собирает
        минимальную из старых полей (обратная совместимость).
        """
        ident = cfg.get("identity") or {}
        legacy = cfg.get("fingerprint") or {}

        ua = ident.get("user_agent") or cfg.get("user_agent") or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        res = ident.get("resolution") or cfg.get("resolution") or "1920,1080"
        try:
            w, h = [int(x) for x in str(res).replace("x", ",").split(",")[:2]]
        except Exception:
            w, h = 1920, 1080

        spoof = cfg.get("spoof") or {}
        lang = ident.get("lang") or spoof.get("lang") or "ru-RU"
        languages = ident.get("languages") or [x.strip() for x in str(lang).split(",") if x.strip()]

        webgl = ident.get("webgl")
        if not webgl and legacy.get("webgl_renderer"):
            webgl = {"vendor": legacy.get("webgl_vendor", "Google Inc. (NVIDIA)"),
                     "renderer": legacy.get("webgl_renderer"),
                     "unmasked_vendor": "NVIDIA Corporation",
                     "unmasked_renderer": legacy.get("webgl_renderer"),
                     "tier": "mid", "limits": {}}

        merged = {
            "schema": ident.get("schema", 1),
            "user_agent": ua,
            "ua_full_version": ident.get("ua_full_version"),
            "ua_major": ident.get("ua_major"),
            "brands": ident.get("brands") or [],
            "ua_platform": ident.get("ua_platform", "Windows"),
            "ua_platform_version": ident.get("ua_platform_version", "10.0.0"),
            "timezone": ident.get("timezone") or spoof.get("timezone") or "Europe/Moscow",
            "languages": languages,
            "webgl": webgl,
            "platform": legacy.get("platform", "Win32"),
            "canvas_noise": ident.get("canvas_noise", legacy.get("canvas_noise")),
            "audio_noise": ident.get("audio_noise"),
            "audio_freq_shift": ident.get("audio_freq_shift"),
            "screen": ident.get("screen") or {"width": w, "height": h, "avail_width": w,
                                              "avail_height": h - 40, "color_depth": 24, "pixel_depth": 24,
                                              "device_pixel_ratio": 1, "outer_width": w, "outer_height": h - 60},
            "hardware": ident.get("hardware") or {"cores": 8, "memory": 8, "device_memory": 8, "max_touch_points": 0},
            "fonts": ident.get("fonts") or [],
            "media": ident.get("media") or {},
            "connection": ident.get("connection"),
            "permissions": ident.get("permissions") or {"notifications": "default"},
            "webrtc": ident.get("webrtc") or {"mode": "default"},
            "proxy": ident.get("proxy"),
            "vectors": ident.get("vectors") or {},
            # Страна/гео: точка приходит только при явном выборе страны в UI
            # (identity.geolocation). В авто-режиме её нет — не выдумываем гео,
            # не совпадающее с реальным IP (см. docs/ANTI-DETECT.md §8).
            "country_code": ident.get("country_code"),
            "country_name": ident.get("country_name"),
            "country_city": ident.get("country_city"),
            "geo_source": ident.get("geo_source", "none"),
            "geolocation": ident.get("geolocation"),
        }

        # Прокси-пароль приходит только через окружение — не из файла
        env_pass = os.environ.get("ARTOFIX_PROXY_PASS")
        if merged["proxy"] and env_pass:
            merged["proxy"] = dict(merged["proxy"], password=env_pass)

        scr = merged["screen"]
        merged["window_width"] = int(scr.get("window_width") or max(1024, w - 20))
        merged["window_height"] = int(scr.get("window_height") or max(700, h - 120))
        return merged

    def get_yandex_path(self):
        user_pc = os.environ.get("USERPROFILE", "")
        for p in (
            os.path.join(user_pc, "AppData", "Local", "Yandex", "YandexBrowser", "Application", "browser.exe"),
            r"C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe",
            r"C:\Program Files\Yandex\YandexBrowser\Application\browser.exe",
        ):
            if p and os.path.exists(p):
                return p
        return None

    # ── общие опции запуска ──
    def _common_opts(self, opt, profile_path, ident):
        opt.add_argument(f"--user-data-dir={profile_path}")
        opt.add_argument("--profile-directory=Default")
        opt.add_argument(f"--user-agent={ident['user_agent']}")
        opt.add_argument(f"--lang={ident['languages'][0] if ident['languages'] else 'en-US'}")
        # окно подбирается под «экран» отпечатка: окно больше экрана не бывает
        if ident["vectors"].get("screen") is not False and ident.get("screen"):
            sw, sh = int(ident["screen"]["width"]), int(ident["screen"]["height"])
            ww = int(ident["screen"].get("window_width") or max(1024, sw - 40))
            wh = int(ident["screen"].get("window_height") or max(720, sh - 120))
            ww, wh = min(ww, sw), min(wh, sh)
            opt.add_argument(f"--window-size={ww},{wh}")
            import random
            opt.add_argument(f"--window-position={random.randint(0, max(0, sw - ww))},{random.randint(0, max(0, sh - wh))}")
        else:
            opt.add_argument("--window-size=1920,1080")

        # убираем самые грубые признаки автоматизации и блокировки Cloudflare ECH (нужно для Claude/Turnstile в РФ)
        opt.add_argument("--disable-blink-features=AutomationControlled")
        opt.add_argument("--no-first-run")
        opt.add_argument("--no-default-browser-check")
        opt.add_argument("--disable-infobars")
        # CalculateNativeWinOcclusion: Windows «прячет» неактивные окна, из-за чего
        # фоновая вкладка троттлится и начинает вести себя не как живая (таймеры,
        # requestAnimationFrame) — заметно и антиботам, и просто ломает сайты
        opt.add_argument("--disable-features=ChromeWhatsNewUI,PrivacySandboxConsentDecisionMigration,EncryptedClientHello,CalculateNativeWinOcclusion")
        opt.add_argument("--disable-session-crashed-bubble")
        # фоновое окно продолжает жить: без этого скрытое за окном браузер
        # «засыпает» и поведенческие проверки (тайминги, события) видят бота
        opt.add_argument("--disable-background-timer-throttling")
        opt.add_argument("--disable-backgrounding-occluded-windows")
        opt.add_argument("--disable-renderer-backgrounding")

        opt.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
        opt.add_experimental_option("useAutomationExtension", False)
        opt.add_experimental_option("prefs", {
            "intl.accept_languages": ",".join(ident["languages"]) or "en-US,en",
            # Selenium по умолчанию выключает менеджер паролей — это заметный след
            "credentials_enable_service": True,
            "profile.password_manager_enabled": True,
            # notifications намеренно НЕ разрешаем принудительно (allow): принудительный
            # allow даёт мгновенный 'granted' из requestPermission при 'default' в
            # Notification.permission — противоречие, которое детектят антибот-скрипты
        })

        # прокси профиля (если задан) — главный фактор в прохождении капчи
        if ident.get("proxy") and ident["proxy"].get("server"):
            opt.add_argument(f"--proxy-server={ident['proxy']['server']}")
            ext_dir = self._proxy_auth_extension(profile_path, ident["proxy"])
            if ext_dir:
                opt.add_argument(f"--load-extension={ext_dir}")
                opt.add_argument(f"--disable-extensions-except={ext_dir}")
            # при прокси прячем локальные IP, иначе реальный адрес утечёт через WebRTC
            opt.add_argument("--webrtc-ip-handling-policy=default_public_interface_only")
        else:
            opt.add_argument("--webrtc-ip-handling-policy=default")

    def _proxy_auth_extension(self, profile_path, proxy):
        """
        Chrome не принимает логин/пароль в --proxy-server, поэтому для
        авторизованных прокси собираем минимальное расширение (MV3),
        которое отвечает на onAuthRequired. Файлы — локальные, в папке профиля.
        """
        user, pwd = proxy.get("username"), proxy.get("password")
        if not user or not pwd:
            return None
        try:
            ext_dir = os.path.join(profile_path, ".artofix_proxy_ext")
            os.makedirs(ext_dir, exist_ok=True)
            manifest = {
                "name": "Artofix Proxy Auth",
                "version": "1.0.0",
                "manifest_version": 3,
                "permissions": ["webRequest", "webRequestAuthProvider", "proxy"],
                "host_permissions": ["<all_urls>"],
                "background": {"service_worker": "sw.js"},
            }
            with open(os.path.join(ext_dir, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump(manifest, f)
            # логин/пароль не уходят в код скрипта: worker читает их из storage
            sw = (
                "const CREDS = " + json.dumps({"u": user, "p": pwd}) + ";\n"
                "chrome.webRequest.onAuthRequired.addListener(\n"
                "  () => ({authCredentials: {username: CREDS.u, password: CREDS.p}}),\n"
                "  {urls: ['<all_urls>']}, ['asyncBlocking']\n"
                ");\n"
            )
            with open(os.path.join(ext_dir, "sw.js"), "w", encoding="utf-8") as f:
                f.write(sw)
            return ext_dir
        except Exception as e:
            print(f"[engine] proxy auth extension warning: {e}")
            return None

    def humanize(self, driver, ident, cfg):
        """Тёплый старт: лёгкая активность, если пользователь не отключил."""
        behavior = cfg.get("behavior") or {}
        if behavior.get("humanize", True):
            human_warmup(driver, True)

    # ── применение отпечатка ──
    def apply_identity(self, driver, ident, cfg):
        vectors = ident.get("vectors") or {}
        ua = ident["user_agent"]
        langs = ident["languages"] or ["en-US", "en"]

        # 1) UA + Client Hints: важно, чтобы sec-ch-ua в заголовках совпадал с JS
        try:
            brands = ident.get("brands") or []
            major = ident.get("ua_major") or (str(ident.get("ua_full_version") or "").split(".")[0] if ident.get("ua_full_version") else None)
            if not major:
                import re as _re
                m = _re.search(r"(?:Chrome|Edg|Firefox)/(\d+)", ua)
                major = m.group(1) if m else "131"
            full = ident.get("ua_full_version") or f"{major}.0.0.0"
            full_list = []
            brands_clean = []
            for b in brands:
                if not isinstance(b, dict) or "brand" not in b:
                    continue
                ver = str(b.get("version", major))
                brands_clean.append({"brand": b["brand"], "version": ver})
                # grease-бренд в fullVersionList отдаёт «N.0.0.0», а не краткий N
                # (сверено с реальными Sec-CH-UA-Full-Version-List живого Chrome)
                if ver == str(major):
                    full_ver = full
                elif "." not in ver:
                    full_ver = ver + ".0.0.0"
                else:
                    full_ver = ver
                full_list.append({"brand": b["brand"], "version": full_ver})
            metadata = {
                "brands": brands_clean,
                "fullVersionList": full_list,
                "fullVersion": full,
                "platform": ident.get("ua_platform", "Windows"),
                "platformVersion": ident.get("ua_platform_version", "10.0.0"),
                "architecture": "x86",
                "model": "",
                "mobile": False,
                "bitness": "64",
                "wow64": False,
            }
            driver.execute_cdp_cmd("Network.setUserAgentOverride", {
                "userAgent": ua,
                "acceptLanguage": ",".join(langs),
                "platform": ident.get("platform", "Win32"),
                "userAgentMetadata": metadata,
            })
        except Exception as e:
            print(f"[engine] UA override warning: {e}")

        # 2) Часовой пояс и локаль
        if vectors.get("tz") is not False:
            try:
                driver.execute_cdp_cmd("Emulation.setTimezoneOverride", {"timezoneId": ident["timezone"]})
            except Exception as e:
                print(f"[engine] timezone override warning: {e}")
        if vectors.get("lang") is not False:
            try:
                driver.execute_cdp_cmd("Emulation.setLocaleOverride", {"locale": langs[0]})
            except Exception:
                pass

        # 3) Метрики экрана
        if vectors.get("screen") is not False and ident.get("screen"):
            s = ident["screen"]
            try:
                driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
                    "width": int(s.get("window_width") or 1280),
                    "height": int(s.get("window_height") or 720),
                    "deviceScaleFactor": float(s.get("device_pixel_ratio") or 1),
                    "mobile": False,
                    "screenWidth": int(s["width"]),
                    "screenHeight": int(s["height"]),
                    "screenOrientation": {"type": "landscapePrimary", "angle": 90},
                    "positionX": 0, "positionY": 0,
                })
            except Exception as e:
                print(f"[engine] metrics override warning: {e}")

        # 4) Железо (если CDP-метод есть — используем его, иначе сработает init-скрипт)
        if vectors.get("hw") is not False and ident.get("hardware"):
            try:
                driver.execute_cdp_cmd("Emulation.setHardwareConcurrencyOverride",
                                       {"hardwareConcurrency": int(ident["hardware"]["cores"])})
            except Exception:
                pass

        # 5) Гео (только при явно выбранной стране; координаты стабильны у профиля)
        if ident.get("geolocation"):
            try:
                g = ident["geolocation"]
                lat = float(g["lat"]); lon = float(g["lon"])
                if abs(lat) > 90 or abs(lon) > 180:
                    raise ValueError("bad geo range")
                acc = g.get("accuracy") or 100
                driver.execute_cdp_cmd("Emulation.setGeolocationOverride",
                                       {"latitude": lat, "longitude": lon,
                                        "accuracy": max(10, min(int(acc), 1000))})
            except Exception as e:
                print(f"[engine] geolocation override warning: {e}")

    def _inject_init(self, driver, ident):
        script = build_page_init(ident)
        try:
            driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": script})
            return True
        except Exception as e:
            print(f"[engine] init-script warning: {e}")
            return False

    def _apply_stealth_lib(self, driver, ident):
        """selenium-stealth — как дополнительный слой (не единственный)."""
        if not STEALTH_OK:
            return
        try:
            webgl = ident.get("webgl") or {}
            stealth(
                driver,
                languages=ident["languages"] or ["en-US", "en"],
                vendor=webgl.get("vendor", "Google Inc."),
                platform=ident.get("platform", "Win32"),
                webgl_vendor=webgl.get("vendor", "Google Inc."),
                renderer=webgl.get("renderer", "Intel Iris OpenGL Engine"),
                fix_hairline=True,
            )
        except Exception as e:
            print(f"[engine] stealth warning: {e}")

    # ── запуск ──
    def start_browser(self, url="about:blank", name="temp", b_type="chrome"):
        profile_path = os.path.join(self.p_dir, name)
        os.makedirs(profile_path, exist_ok=True)

        cfg = self.load_config()
        ident = self.build_identity(cfg, name, b_type)
        print(f"[engine] profile={name} browser={b_type} tz={ident['timezone']} langs={','.join(ident['languages'])}")
        if ident.get("geo_source") == "country" and ident.get("geolocation"):
            g = ident["geolocation"]
            print(f"[engine] country -> {ident.get('country_code')} ({ident.get('country_city') or ident.get('country_name')}) "
                  f"geo={g['lat']},{g['lon']} ±{g.get('accuracy') or 100}m")
            print("[engine] ВНИМАНИЕ: браузерные сигналы гео включены, но выходной IP не меняется — "
                  "для полного антидетекта укажи прокси профиля той же страны")
        if ident.get("webgl"):
            print(f"[engine] GPU -> {ident['webgl'].get('renderer')}")
        if ident.get("proxy"):
            print(f"[engine] proxy -> {ident['proxy'].get('server')}")

        driver = None
        browser = (b_type or "chrome").lower()
        try:
            if browser == "firefox":
                driver = self._launch_firefox(profile_path, ident)
            elif browser == "msedge":
                driver = self._launch_edge(profile_path, ident)
            elif browser == "yandex":
                driver = self._launch_yandex(profile_path, ident)
            else:
                driver = self._launch_chrome(profile_path, ident)

            # Отпечаток применяем ДО первой навигации
            self._inject_init(driver, ident)
            self.apply_identity(driver, ident, cfg)

            if url and url != "about:blank":
                driver.get(url)
                self.humanize(driver, ident, cfg)

            while True:
                try:
                    _ = driver.window_handles
                    time.sleep(0.8)
                except Exception:
                    break
        except Exception as e:
            print(f"[engine] error ({browser}): {e}")
        finally:
            if driver:
                try:
                    driver.quit()
                except Exception:
                    pass

    def _chromium_driver(self, profile_path, ident, browser):
        """Chrome / Edge / Яндекс: одинаковые опции + разные сервисы драйвера."""
        if browser == "msedge":
            opt = EdgeOptions()
        else:
            opt = ChromeOptions()
        self._common_opts(opt, profile_path, ident)
        if browser == "yandex":
            yp = self.get_yandex_path()
            if not yp:
                raise FileNotFoundError("Яндекс Браузер не найден. Установи его.")
            opt.binary_location = yp

        if browser == "msedge":
            drv = get_edge_driver_path()
            driver = webdriver.Edge(service=EdgeService(drv) if drv else EdgeService(), options=opt)
        else:
            drv = get_chrome_driver_path()
            driver = webdriver.Chrome(service=ChromeService(drv) if drv else ChromeService(), options=opt)

        try:
            driver.execute_cdp_cmd("Page.enable", {})
        except Exception:
            pass
        return driver

    def _launch_chrome(self, profile_path, ident):
        driver = self._chromium_driver(profile_path, ident, "chrome")
        self._apply_stealth_lib(driver, ident)
        return driver

    def _launch_edge(self, profile_path, ident):
        driver = self._chromium_driver(profile_path, ident, "msedge")
        self._apply_stealth_lib(driver, ident)
        return driver

    def _launch_yandex(self, profile_path, ident):
        driver = self._chromium_driver(profile_path, ident, "yandex")
        self._apply_stealth_lib(driver, ident)
        return driver

    def _launch_firefox(self, profile_path, ident):
        opt = FirefoxOptions()
        opt.add_argument("-profile")
        opt.add_argument(profile_path)
        opt.set_preference("general.useragent.override", ident["user_agent"])
        opt.set_preference("intl.accept_languages", ",".join(ident["languages"]))
        opt.set_preference("dom.webdriver.enabled", False)
        opt.set_preference("useAutomationExtension", False)
        opt.set_preference("privacy.trackingprotection.enabled", False)
        opt.set_preference("dom.webnotifications.enabled", True)
        opt.set_preference("media.navigator.enabled", True)
        drv = get_gecko_driver_path()
        driver = webdriver.Firefox(service=FirefoxService(drv) if drv else FirefoxService(), options=opt)
        try:
            driver.execute_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
                "delete Object.getPrototypeOf(navigator).webdriver;"
            )
        except Exception:
            pass
        return driver


# ─────────────────────────────────────────────
#  ТОЧКА ВХОДА
# ─────────────────────────────────────────────
def main():
    bm = BrowserManager()
    args = sys.argv[1:]

    if not args:
        print("Usage: engine.py <url> <profile> <browser> [--profiles-dir DIR]")
        return 0

    if args[0].upper() == "CREATE":
        name = args[1] if len(args) > 1 else "default"
        path = os.path.join(bm.p_dir, name)
        os.makedirs(path, exist_ok=True)
        print(f"[engine] Profile created: {path}")
        return 0

    if args[0].upper() == "LIST":
        profiles = [d for d in os.listdir(bm.p_dir) if os.path.isdir(os.path.join(bm.p_dir, d))]
        print("[engine] Profiles:", profiles)
        return 0

    url = args[0] if len(args) > 0 else "about:blank"
    name = args[1] if len(args) > 1 else "default"
    b_type = args[2] if len(args) > 2 else "chrome"

    if b_type.lower() == "app":
        try:
            os.startfile(url)  # noqa: только Windows; вызывается для биндов-приложений
        except AttributeError:
            subprocess.Popen([url], shell=False)
        return 0

    bm.start_browser(url=url, name=name, b_type=b_type)
    return 0


if __name__ == "__main__":
    sys.exit(main())
