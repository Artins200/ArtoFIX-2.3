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
import re
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit


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
  // navigator.platform берём из ID.platform: engine выравнивает его по РЕАЛЬНОЙ ОС
  // (в воркере живёт настоящий platform, и главный поток обязан говорить то же).
  var PLATFORM_SPOOF = ID.platform || (ID.ua_platform === 'Windows' ? 'Win32' : null);
  if (V.platform !== false && PLATFORM_SPOOF) {
    defineGetter(Object.getPrototypeOf(navigator), 'platform', function () { return PLATFORM_SPOOF; });
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


WORKER_INIT_TEMPLATE = r"""
(function () {
  'use strict';
  var ID = /*__IDENTITY__*/ null;
  if (!ID || typeof navigator === 'undefined') return;

  // ── 0. Прячем собственный патч от Function.prototype.toString (как в кадрах) ──
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
    try { Object.defineProperty(target, prop, { get: markNative(getter, 'get ' + prop), configurable: true }); } catch (e) {}
  }
  function defineValue(target, prop, value) {
    try { Object.defineProperty(target, prop, { value: value, writable: true, configurable: true, enumerable: true }); } catch (e) {}
  }

  var NAV = null;
  try { NAV = Object.getPrototypeOf(navigator); } catch (e) {}
  if (!NAV) return;
  var V = ID.vectors || {};

  // ── 1. Те же сигналы, что и в главном потоке ──
  // Воркер — не «второй браузер»: антибот-скрипты (в т.ч. проверки Cloudflare)
  // специально сверяют значения из Worker с главным потоком. Раньше здесь
  // оставались РЕАЛЬНЫЕ platform/ядра/лимиты GPU — главный детект.
  // ВАЖНО: в WorkerNavigator живут далеко не все свойства Navigator.
  // В настоящем Chrome в воркере НЕТ webdriver, maxTouchPoints и vendor —
  // создать их «для порядка» означает выдать себя: `'webdriver' in navigator`
  // внутри Worker у настоящего Chrome всегда false.
  // Поэтому подменяем только то, что там действительно есть (проверка in).
  var CAN = function (name) { try { return name in navigator; } catch (e) { return false; } };

  if (ID.languages && ID.languages.length && CAN('languages')) {
    var langList = ID.languages.slice();
    try { Object.freeze(langList); } catch (e) {}
    defineGetter(NAV, 'languages', function () { return langList; });
    if (CAN('language')) defineGetter(NAV, 'language', function () { return langList[0]; });
  }
  if (V.platform !== false && ID.platform && CAN('platform')) {
    defineGetter(NAV, 'platform', function () { return ID.platform; });
  }
  if (V.hw !== false && ID.hardware) {
    if (CAN('hardwareConcurrency') && ID.hardware.cores) {
      defineGetter(NAV, 'hardwareConcurrency', function () { return ID.hardware.cores; });
    }
    if (CAN('deviceMemory') && ID.hardware.device_memory) {
      defineGetter(NAV, 'deviceMemory', function () { return ID.hardware.device_memory; });
    }
  }

  // ── 2. WebGL в воркере (OffscreenCanvas) ──
  // Прототип WebGLRenderingContext в воркере общий с OffscreenCanvas-контекстом,
  // поэтому патч тот же, что и в главном потоке.
  if (V.webgl !== false && ID.webgl) {
    var W = ID.webgl;
    var LIM = W.limits || {};
    var limValue = {};
    limValue[0x0D33] = LIM.MAX_TEXTURE_SIZE;                 // MAX_TEXTURE_SIZE
    limValue[0x84E8] = LIM.MAX_RENDERBUFFER_SIZE;            // MAX_RENDERBUFFER_SIZE
    limValue[0x8DFB] = LIM.MAX_VERTEX_UNIFORM_VECTORS;
    limValue[0x8DFD] = LIM.MAX_FRAGMENT_UNIFORM_VECTORS;
    limValue[0x8DFC] = LIM.MAX_VARYING_VECTORS;
    limValue[0x8869] = LIM.MAX_VERTEX_ATTRIBS;
    limValue[0x8B4D] = LIM.MAX_COMBINED_TEXTURE_IMAGE_UNITS;
    limValue[0x851C] = LIM.MAX_CUBE_MAP_TEXTURE_SIZE;
    limValue[0x8872] = LIM.MAX_TEXTURE_IMAGE_UNITS;

    function patchGL(Proto) {
      if (!Proto || !Proto.getParameter) return;
      var orig = Proto.getParameter;
      var patched = function getParameter(pname) {
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
    try { patchGL(typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype); } catch (e) {}
    try { patchGL(typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype); } catch (e) {}
  }

  // ── 3. Canvas в воркере: OffscreenCanvas должен шуметь ТАК ЖЕ, как <canvas> ──
  // Если главный поток отдаёт уникальный для профиля хеш, а воркер — «чистый»,
  // скрипт сравнивает два рендера одного и того же текста и видит подмену.
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

    var OC = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : null;
    var OC2D = typeof OffscreenCanvasRenderingContext2D !== 'undefined' ? OffscreenCanvasRenderingContext2D.prototype : null;

    if (OC && OC.prototype && OC.prototype.convertToBlob) {
      var origConvert = OC.prototype.convertToBlob;
      var patchedConvert = function convertToBlob() {
        var ctx = null;
        try { ctx = this.getContext && this.getContext('2d'); } catch (e) {}
        if (!ctx || !this.width || !this.height) return origConvert.apply(this, arguments);
        var raw = ctx.getImageData.bind(ctx);
        var backup = null;
        try { backup = raw(0, 0, this.width, this.height); } catch (e) {}
        if (!backup) return origConvert.apply(this, arguments);
        var snapshot = null;
        try {
          snapshot = raw(0, 0, this.width, this.height);
          perturb(snapshot.data, snapshot.width, snapshot.height);
          ctx.putImageData(snapshot, 0, 0);
          return origConvert.apply(this, arguments);
        } finally {
          try { ctx.putImageData(backup, 0, 0); } catch (e) {}
        }
      };
      markNative(patchedConvert, 'convertToBlob');
      try { OC.prototype.convertToBlob = patchedConvert; } catch (e) {}
    }

    if (OC2D && OC2D.getImageData) {
      var origGetImageData = OC2D.getImageData;
      var patchedGetImageData = function getImageData(sx, sy, sw, sh) {
        var img = origGetImageData.apply(this, arguments);
        try { perturb(img.data, img.width, img.height); } catch (e) {}
        return img;
      };
      markNative(patchedGetImageData, 'getImageData');
      try { OC2D.getImageData = patchedGetImageData; } catch (e) {}
    }
  }
})();
"""


def build_page_init(identity):
    """Собирает page-init скрипт: значения уходят как JSON, не как код."""
    return PAGE_INIT_TEMPLATE.replace("/*__IDENTITY__*/ null", json.dumps(identity, ensure_ascii=False))

# ─────────────────────────────────────────────
#  ВОРКЕРЫ: ТОТ ЖЕ ОТПЕЧАТОК, ЧТО И В КАДРАХ
#  ---------------------------------------------------------------
#  Page.addScriptToEvaluateOnNewDocument патчит только документы. Воркеры
#  (new Worker) живут в отдельном контексте и отдают РЕАЛЬНЫЕ значения:
#  navigator.platform, hardwareConcurrency, deviceMemory, лимиты WebGL,
#  а OffscreenCanvas — вообще «чистые» пиксели без шума профиля.
#  Любой антибот-скрипт может сравнить главный поток с воркером и увидеть
#  расхождение — это и есть классический «детект подделки».
#
#  Чиним через Target-домен: авто-подключение к воркерам (только к ним —
#  фильтр, чтобы не «замораживать» iframe'ы виджетов) + Runtime.evaluate
#  из воркер-сессии. События CDP читать не нужно: targetId берём из
#  Target.getTargets, sessionId — из ответа Target.attachToTarget.
# ─────────────────────────────────────────────

WORKER_TARGET_TYPES = ("worker", "shared_worker", "service_worker")


def js_expr(script):
    """
    Selenium исполняет переданный скрипт КАК ТЕЛО ФУНКЦИИ, поэтому значение
    выражения до наружного кода не доходит: `(function(){ return {...} })();`
    возвращает None, и любая логика «прочитай состояние страницы» молча ломается.
    Оборачиваем выражение в явный `return (...)`, если его там ещё нет.
    """
    body = (script or "").strip()
    if not body:
        return body
    if body.startswith("return"):
        return body
    # перевод строки перед закрывающей скобкой: если скрипт заканчивается
    # строчным комментарием, добавленный хвост не попадёт внутрь него
    return "return (" + body.rstrip(";") + "\n);"


def build_worker_init(identity):
    """Воркер-версия page-init: собирается подстановкой JSON, как и для кадров."""
    return WORKER_INIT_TEMPLATE.replace("/*__IDENTITY__*/ null", json.dumps(identity, ensure_ascii=False))


def real_memory_gb():
    """Реальная память машины в ГБ (нужна, чтобы deviceMemory не противоречил железу)."""
    try:
        if sys.platform.startswith("win"):
            import ctypes

            class _MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            stat = _MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return int(round(stat.ullTotalPhys / (1024 ** 3)))
        else:
            pages = os.sysconf("SC_PHYS_PAGES")
            size = os.sysconf("SC_PAGE_SIZE")
            return int(round(pages * size / (1024 ** 3)))
    except Exception:
        return None


def cpu_cores():
    """Реальные ядра: os.cpu_count() в Windows-сборке Python отдаёт их корректно."""
    try:
        return int(os.cpu_count() or 0) or None
    except Exception:
        return None


def device_memory_bucket(ram_gb):
    """navigator.deviceMemory в Chrome огрублён до 0.25…8 ГБ — держим ту же шкалу."""
    if not ram_gb:
        return None
    if ram_gb <= 1:
        return 0.25
    if ram_gb <= 2:
        return 2
    if ram_gb <= 4:
        return 4
    return 8


# Проба реального железа ДО первой инъекции: текущий about:blank ещё не патчен,
# поэтому здесь видны настоящие значения (их потом нельзя будет получить).
PROBE_REAL_JS = r"""
(function () {
  try {
    var out = {
      platform: navigator.platform,
      cores: navigator.hardwareConcurrency,
      languages: navigator.languages,
      device_memory: navigator.deviceMemory,
      webgl: null
    };
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        var dbg = null;
        try { dbg = gl.getExtension('WEBGL_debug_renderer_info'); } catch (e) {}
        var limits = {};
        var names = {
          MAX_TEXTURE_SIZE: 0x0D33, MAX_RENDERBUFFER_SIZE: 0x84E8,
          MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
          MAX_VARYING_VECTORS: 0x8DFC, MAX_VERTEX_ATTRIBS: 0x8869,
          MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
          MAX_TEXTURE_IMAGE_UNITS: 0x8872
        };
        for (var k in names) {
          if (!Object.prototype.hasOwnProperty.call(names, k)) continue;
          try { limits[k] = gl.getParameter(names[k]); } catch (e) {}
        }
        var dims = null;
        try {
          var d = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
          if (d && d.length >= 2) dims = [d[0], d[1]];
        } catch (e) {}
        if (dims) limits.MAX_VIEWPORT_DIMS = dims;
        out.webgl = {
          // 0x9245/0x9246 (UNMASKED_*) — то, что отдаёт WEBGL_debug_renderer_info;
          // именно эти два значения и подменяет page-init (W.vendor / W.renderer).
          vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
          renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
          // 0x1F00/0x1F01 (VENDOR/RENDERER) — их page-init НЕ трогает
          masked_vendor: gl.getParameter(gl.VENDOR),
          masked_renderer: gl.getParameter(gl.RENDERER),
          version: gl.getParameter(gl.VERSION),
          limits: limits
        };
      }
    } catch (e) {}
    return out;
  } catch (e) { return null; }
})();
"""


# Ключи программной растеризации: заявлять «RTX 3060» на машине, где реально
# рисует SwiftShader/llvmpipe, нельзя — расхождение видно и в лимитах, и в строках.
SOFTWARE_GPU_RE = re.compile(
    r"swiftshader|llvmpipe|softpipe|software rasterizer|software renderer|"
    r"basic render|microsoft basic|mesa offscreen|virtualbox.*vboxts", re.I)


def is_software_gpu(renderer):
    return bool(renderer) and bool(SOFTWARE_GPU_RE.search(str(renderer)))


def gpu_tier_from_limits(limits):
    """Класс GPU по MAX_TEXTURE_SIZE — та же градация, что в GPU_LIMITS."""
    try:
        tex = int((limits or {}).get("MAX_TEXTURE_SIZE") or 0)
    except Exception:
        tex = 0
    if tex >= 32768:
        return "high"
    if tex >= 16384:
        return "mid"
    if tex:
        return "low"
    return None


def _os_family(platform_str):
    p = str(platform_str or "").lower()
    if p.startswith("win"):
        return "windows"
    if p.startswith("linux") or "x11" in p:
        return "linux"
    if "mac" in p:
        return "macos"
    return "unknown"


def _ua_family(user_agent):
    ua = str(user_agent or "")
    if "Windows NT" in ua:
        return "windows"
    if "Macintosh" in ua or "Mac OS X" in ua:
        return "macos"
    if "Linux" in ua or "X11" in ua:
        return "linux"
    return "unknown"


def probe_real_hardware(driver):
    """Настоящие platform/ядра/deviceMemory/лимиты WebGL (до подмены)."""
    try:
        probe = driver.execute_script(js_expr(PROBE_REAL_JS))
    except Exception as e:
        print("[engine] проба железа не удалась: " + str(e))
        return {}
    return probe if isinstance(probe, dict) else {}


def align_ua_to_os(ident, real_platform, browser="chrome"):
    """
    User-Agent профиля всегда собирается под Windows. На не-Windows машине это
    мгновенное расхождение: воркер отдаёт настоящий navigator.platform, а
    UA/Client Hints заявляют Windows. Если UA не задан пользователем вручную —
    переписываем его под реальную ОС (версии Chrome/Edge сохраняем).
    """
    fam = _os_family(real_platform)
    if fam == "unknown":
        return None
    ua = str(ident.get("user_agent") or "")
    if not ua:
        return None
    major = str(ident.get("ua_major") or "")
    if not major:
        m = re.search(r"(?:Chrome|Edg|Firefox)/(\d+)", ua)
        major = m.group(1) if m else "131"
    is_edge = "Edg/" in ua or browser == "msedge"
    is_firefox = "Firefox/" in ua or browser == "firefox"

    if fam == "windows":
        head = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        plat, plat_version = "Windows", "10.0.0"
    elif fam == "macos":
        head = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
        plat, plat_version = "macOS", "15.0.0"
    else:
        head = "Mozilla/5.0 (X11; Linux x86_64)"
        plat, plat_version = "Linux", ""

    if is_firefox:
        ident["user_agent"] = head + " Gecko/20100101 Firefox/" + major + ".0"
    elif is_edge:
        ident["user_agent"] = (head + " AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major +
                               ".0.0.0 Safari/537.36 Edg/" + major + ".0.0.0")
    else:
        ident["user_agent"] = (head + " AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major +
                               ".0.0.0 Safari/537.36")
    ident["ua_platform"] = plat
    ident["ua_platform_version"] = plat_version
    ident["platform"] = real_platform
    ident["ua_os_aligned"] = True
    return "UA переписан под реальную ОС (%s) — иначе воркер и Client Hints сразу выдают подмену" % real_platform


def align_identity_to_hardware(ident, real, cfs):
    """
    Приводит отпечаток к реальному железу там, где «отличаться» — значит
    светиться: воркеры и OffscreenCanvas физически не патчатся, а значит
    любое расхождение главного потока с настоящими значениями = детект.

    Порядок решений:
      • ядра и deviceMemory — всегда по реальной машине (воркер покажет те же числа);
      • GPU: если реальная карта настоящая — показываем ЕЁ (лимиты, строки) и
        получаем полную согласованность «renderer ↔ лимиты ↔ воркер»;
        если реально рисует SwiftShader/llvmpipe — заявлять её нельзя (это
        сам по себе флаг), поэтому оставляем GPU профиля и предупреждаем;
      • navigator.platform — из реального процесса (его всё равно видно в воркере);
      • UA — под реальную ОС, если пользователь не задал его сам.
    """
    notes = []
    if not isinstance(real, dict) or not real:
        return notes
    if cfs.get("align_hardware", True) is False:
        return notes

    hw = ident.get("hardware")
    if not isinstance(hw, dict):
        hw = {}
        ident["hardware"] = hw

    # ── ядра ──
    cores = real.get("cores")
    if not (isinstance(cores, int) and 1 <= cores <= 256):
        cores = cpu_cores()
    if cores and hw.get("cores") != cores:
        notes.append("ядра: %s → %s (реальное железо)" % (hw.get("cores"), cores))
        hw["cores"] = cores

    # ── deviceMemory: в воркере он настоящий, а Chrome огрубляет его до 0.25…8 ──
    dm = real.get("device_memory")
    if not (isinstance(dm, (int, float)) and dm > 0):
        dm = device_memory_bucket(real_memory_gb())
    if dm and hw.get("device_memory") != dm:
        notes.append("deviceMemory: %s → %s ГБ" % (hw.get("device_memory"), dm))
        hw["device_memory"] = dm

    ram = real_memory_gb()
    if ram and 1 < ram <= 256 and hw.get("memory") != ram:
        hw["memory"] = ram

    # ── GPU ──
    wgl = ident.get("webgl")
    real_wgl = real.get("webgl")
    if isinstance(real_wgl, dict) and real_wgl.get("renderer"):
        real_renderer = str(real_wgl["renderer"])
        real_limits = {k: v for k, v in (real_wgl.get("limits") or {}).items() if v is not None}
        ident["real_gpu"] = real_renderer[:160]
        if is_software_gpu(real_renderer):
            # Программный рендер: подставлять его в отпечаток нельзя — Cloudflare
            # такие значения считает признаком бота. Держим GPU профиля, но честно
            # говорим, что лимиты разойтись могут (в воркере видно настоящее железо).
            ident["software_gpu"] = True
            notes.append("реальный рендер — программный (%s): оставляем GPU профиля, "
                         "но лимиты воркера с ним не совпадут" % real_renderer[:60])
        elif isinstance(wgl, dict):
            changed = []
            for key, value in real_limits.items():
                if wgl_limits_get(wgl, key) != value:
                    changed.append(key)
            if real_wgl.get("vendor") and wgl.get("vendor") != real_wgl["vendor"]:
                changed.append("vendor")
            if wgl.get("renderer") != real_renderer:
                changed.append("renderer")
            if changed:
                wgl["renderer"] = real_renderer
                if real_wgl.get("vendor"):
                    wgl["vendor"] = real_wgl["vendor"]
                wgl["unmasked_renderer"] = real_wgl.get("unmasked_renderer") or real_renderer
                wgl["unmasked_vendor"] = real_wgl.get("unmasked_vendor") or real_wgl.get("vendor")
                if real_limits:
                    limits = dict(wgl.get("limits") or {})
                    limits.update(real_limits)
                    wgl["limits"] = limits
                tier = gpu_tier_from_limits(real_limits or (wgl.get("limits") or {}))
                if tier:
                    wgl["tier"] = tier
                notes.append("GPU профиля заменён на реальный (%s; лимиты и класс — по железу)"
                             % real_renderer[:60])

    # ── navigator.platform ──
    real_platform = real.get("platform")
    if real_platform:
        ident["platform"] = real_platform
        if _os_family(real_platform) != _ua_family(ident.get("user_agent")):
            src = str(ident.get("user_agent_source") or "")
            if src == "generated" or ident.get("ua_os_aligned"):
                note = align_ua_to_os(ident, real_platform)
                if note:
                    notes.append(note)
            else:
                ident["platform_mismatch"] = True
                notes.append("ВНИМАНИЕ: реальная ОС — %s, а UA задан вручную и заявляет другую. "
                             "Воркеры отдают настоящий navigator.platform — это видно без всяких проб."
                             % real_platform)

    # ── языки: в воркере живёт список из самого браузера (--lang), поэтому
    #    выравниваем отпечаток под него, если основной язык тот же ──
    real_langs = real.get("languages")
    langs = ident.get("languages") or []
    if isinstance(real_langs, list) and real_langs and langs:
        def primary(x):
            return str(x).split("-")[0].lower()
        if primary(real_langs[0]) == primary(langs[0]):
            if list(real_langs) != list(langs):
                notes.append("языки: %s → %s (как в самом браузере)"
                             % (",".join(langs), ",".join([str(x) for x in real_langs])))
                ident["languages"] = [str(x) for x in real_langs]
        elif primary(real_langs[0]) != primary(langs[0]):
            notes.append("ВНИМАНИЕ: браузер стартовал с языком %s, а профиль заявляет %s — "
                         "в воркере будет настоящий список (проверь --lang)" % (real_langs[0], langs[0]))
    return notes


def wgl_limits_get(wgl, key):
    try:
        return (wgl.get("limits") or {}).get(key)
    except Exception:
        return None


class WorkerPatchManager:
    """
    Патчит dedicated-воркеры тем же отпечатком, что и главный поток.

    Авто-подключение включается ФИЛЬТРОМ «только worker»: иначе Chrome
    приостанавливает и iframe'ы (в них живут виджеты капчи) — а мы обязаны
    отпускать только то, что патчим сами.
    """

    def __init__(self, driver, script, log=print, poll=0.4):
        self.driver = driver
        self.script = script
        self.log = log
        self.poll = poll
        self.enabled = False
        self.patched = 0
        self.errors = 0
        self._seen = set()          # успешно пропатченные цели
        self._attempts = {}         # попытки по цели (чтобы не штормить CDP)
        self.max_attempts = 2
        self._stop = threading.Event()
        self._thread = None

    # ── запуск/остановка ──
    def start(self):
        if not self._enable_auto_attach():
            return False
        self._thread = threading.Thread(target=self._loop, name="artofix-worker-patch", daemon=True)
        self._thread.start()
        return True

    def _enable_auto_attach(self):
        eager = {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": False,
                 "filter": [{"type": "worker", "exclude": False}, {"exclude": True}]}
        try:
            self.driver.execute_cdp_cmd("Target.setAutoAttach", eager)
            self.enabled = True
            self.log("[cf] патч воркеров включён (только Worker, iframe не трогаем)")
            return True
        except Exception as e:
            self.log("[cf] авто-подключение к воркерам не поддержано: " + str(e))
        # Откат: без фильтра подключаемся, но НЕ приостанавливаем цели
        # (иначе можно «заморозить» чужой iframe и сломать страницу).
        try:
            self.driver.execute_cdp_cmd("Target.setAutoAttach", {
                "autoAttach": True, "waitForDebuggerOnStart": False, "flatten": False})
            self.enabled = True
            self.log("[cf] патч воркеров включён в мягком режиме (без паузы целей)")
            return True
        except Exception as e:
            self.log("[cf] патч воркеров недоступен: " + str(e))
            return False

    def stop(self):
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=2.0)
        self._thread = None

    # ── рабочий цикл ──
    def _loop(self):
        while not self._stop.wait(self.poll):
            try:
                self.patch_pending()
            except Exception:
                self.errors += 1

    def patch_pending(self):
        """Одна итерация: находим новые воркеры и патчим их (по одному разу)."""
        try:
            targets = self.driver.execute_cdp_cmd("Target.getTargets", {}) or {}
        except Exception:
            self.errors += 1
            return 0
        infos = targets.get("targetInfos") or []
        done = 0
        for info in infos:
            if not isinstance(info, dict):
                continue
            if info.get("type") not in WORKER_TARGET_TYPES:
                continue
            target_id = info.get("targetId")
            if not target_id or target_id in self._seen:
                continue
            if self._attempts.get(target_id, 0) >= self.max_attempts:
                continue
            self._attempts[target_id] = self._attempts.get(target_id, 0) + 1
            if self._patch_target(target_id):
                self._seen.add(target_id)
                done += 1
        return done

    def _patch_target(self, target_id):
        session_id = None
        ok = False
        try:
            attached = self.driver.execute_cdp_cmd(
                "Target.attachToTarget", {"targetId": target_id, "flatten": False}) or {}
            session_id = attached.get("sessionId")
            if not session_id:
                return False
            self._send(session_id, "Runtime.evaluate",
                       {"expression": self.script, "returnByValue": False, "awaitPromise": False})
            ok = True
            self.patched += 1
        except Exception:
            self.errors += 1
        finally:
            if session_id:
                # Воркер ОБЯЗАН быть отпущен, даже если патч не удался:
                # приостановленный воркер = сломанный сайт.
                try:
                    self._send(session_id, "Runtime.runIfWaitingForDebugger", {})
                except Exception:
                    pass
                try:
                    self.driver.execute_cdp_cmd("Target.detachFromTarget", {"sessionId": session_id})
                except Exception:
                    pass
        return ok

    def _send(self, session_id, method, params):
        self.driver.execute_cdp_cmd("Target.sendMessageToTarget", {
            "sessionId": session_id,
            "message": json.dumps({"id": self._next_id(), "method": method, "params": params}),
        })

    _msg_seq = 0

    def _next_id(self):
        WorkerPatchManager._msg_seq += 1
        return WorkerPatchManager._msg_seq


# Синхронная самопроверка: главный поток против воркера. Антиботы сравнивают
# именно эти значения, поэтому расхождение = «подделка отпечатка».
WORKER_CHECK_JS = r"""
(function () {
  if (window.__artofixWorkerCheck) return 'pending';
  window.__artofixWorkerCheck = 'pending';
  try {
    var src = "self.onmessage = function () { try { self.postMessage({ " +
      "platform: navigator.platform, cores: navigator.hardwareConcurrency, " +
      "deviceMemory: navigator.deviceMemory, langs: navigator.languages.join(','), " +
      "ua: navigator.userAgent.slice(0, 40) }); } catch (e) { self.postMessage({ error: String(e) }); } };";
    var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    var w = new Worker(url);
    var timer = setTimeout(function () {
      try { w.terminate(); } catch (e) {}
      window.__artofixWorkerCheck = { error: 'timeout' };
    }, 4000);
    w.onmessage = function (e) {
      clearTimeout(timer);
      try { w.terminate(); } catch (e2) {}
      window.__artofixWorkerCheck = {
        platform: e.data.platform, cores: e.data.cores, deviceMemory: e.data.deviceMemory,
        langs: e.data.langs, ua: e.data.ua,
        main: { platform: navigator.platform, cores: navigator.hardwareConcurrency,
                langs: navigator.languages.join(',') }
      };
    };
    w.postMessage('check');
  } catch (e) { window.__artofixWorkerCheck = { error: String(e) }; }
  return 'pending';
})();
"""


def worker_selftest(driver, timeout=5.0):
    """
    Создаёт воркер и сравнивает его значения с главным потоком.
    Возвращает список расхождений (пусто — всё согласовано).
    """
    try:
        driver.execute_script(js_expr(WORKER_CHECK_JS))
    except Exception as e:
        return ["проверка воркера не запустилась: " + str(e)]
    deadline = time.time() + max(1.0, float(timeout))
    result = None
    while time.time() < deadline:
        try:
            result = driver.execute_script("return window.__artofixWorkerCheck || null;")
        except Exception:
            return []
        if isinstance(result, dict) and result.get("error") != "pending":
            break
        time.sleep(0.3)
    if not isinstance(result, dict) or result.get("error") == "pending":
        return ["воркер не ответил за отведённое время"]
    if result.get("error"):
        return ["воркер: " + str(result["error"])]
    diffs = []
    main = result.get("main") or {}
    if result.get("platform") != main.get("platform"):
        diffs.append("platform: главный поток %s, воркер %s" % (main.get("platform"), result.get("platform")))
    if result.get("cores") != main.get("cores"):
        diffs.append("hardwareConcurrency: главный поток %s, воркер %s" % (main.get("cores"), result.get("cores")))
    if result.get("langs") != main.get("langs"):
        diffs.append("languages: главный поток %s, воркер %s" % (main.get("langs"), result.get("langs")))
    return diffs



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
#  CLOUDFLARE: ПРОВЕРКА, ОЖИДАНИЕ, ОБХОД БЛОКИРОВКИ
#  ---------------------------------------------------------------
#  Cloudflare вместо сайта отдаёт одну из трёх страниц:
#    1) JS-проверка «Just a moment…» / «Checking your browser» — браузер
#       проходит её сам за 3–15 секунд, если ему не мешать;
#    2) страница блокировки «Sorry, you have been blocked» + Ray ID —
#       сработала WAF/Bot Management: причина почти всегда репутация IP
#       (и/или слишком «холодный» заход), а не отпечаток;
#    3) нормальная страница сайта.
#  Раньше движок после driver.get() сразу шёл «вести себя по-человечески»:
#  курсор и прокрутка уходили на страницу проверки, а пользователь оставался
#  смотреть на «Sorry, you have been blocked» на весь экран — и не понимал,
#  почему (в логе про это не было ни слова).
#  Теперь движок распознаёт состояние, спокойно ждёт проверку, а при
#  блокировке делает человеческую лестницу повторов (пауза → обновление →
#  заход через главную) и пишет причину в лог — main передаёт её в UI.
# ─────────────────────────────────────────────

CF_DEFAULTS = {
    "enabled": True,           # вся логика включена (config.json → cf.enabled)
    "soft_landing": True,      # сначала главная сайта, потом глубокая ссылка
    "wait_challenge": True,    # ждать прохождение проверки, не «читать» её
    "challenge_timeout": 25,   # секунд на одну попытку прохождения проверки
    "max_retries": 2,          # повторов после блокировки/незавершённой проверки
    "worker_patch": True,      # патчить воркеры тем же отпечатком (см. WorkerPatchManager)
    "align_hardware": True,    # приводить ядра/лимиты GPU к реальному железу
}

CF_CHALLENGE_MARKERS = (
    "just a moment",
    "checking your browser",
    "cf-chl",
    "challenge-platform",
    "__cf_chl",
    "enable javascript and cookies to continue",
    "verify you are human",
    "проверка браузера",
)

CF_BLOCK_MARKERS = (
    "you have been blocked",
    "you are unable to access",
    "why have i been blocked",
    "attention required",
    "cf-error-details",
    "error 1020",
    "error 1015",
    "blocked by cloudflare",
    "has been blocked",
)

# Мини-проба страницы: заголовок, адрес и видимый текст. DOM не трогаем,
# поэтому проба безопасна и на странице проверки.
CF_PROBE_JS = r"""
(function () {
  try {
    var body = document.body;
    var txt = body ? (body.innerText || body.textContent || '') : '';
    return {
      title: String(document.title || ''),
      url: String(location.href || ''),
      text: String(txt).slice(0, 4000)
    };
  } catch (e) { return null; }
})();
"""


def cf_settings(cfg):
    """Настройки CF-логики из config.json (блок cf) с проверкой диапазонов."""
    out = dict(CF_DEFAULTS)
    raw = (cfg or {}).get("cf")
    if not isinstance(raw, dict):
        raw = {}
    for key in ("enabled", "soft_landing", "wait_challenge", "worker_patch", "align_hardware"):
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]
    for key, lo, hi in (("challenge_timeout", 5, 90), ("max_retries", 0, 3)):
        val = raw.get(key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            out[key] = max(lo, min(hi, int(val)))
    return out


def cf_state_from_text(text):
    """'blocked' | 'challenge' | 'ok' по тексту страницы.

    Блокировку проверяем первой: на странице блокировки тоже бывает Ray ID,
    а маркеры проверки («just a moment») в неё не входят.
    """
    low = (text or "").lower()
    for mark in CF_BLOCK_MARKERS:
        if mark in low:
            return "blocked"
    for mark in CF_CHALLENGE_MARKERS:
        if mark in low:
            return "challenge"
    return "ok"


def cf_ray_id(text):
    """Ray ID из страницы блокировки — по нему поддержка сайта ищет запрос."""
    m = re.search(r"ray\s*id:?\s*([0-9a-fA-F]{8,24})", text or "", re.I)
    return m.group(1).lower() if m else None


def page_cf_state(driver):
    """(state, ray_id) текущей страницы: ok | challenge | blocked | unknown."""
    try:
        probe = driver.execute_script(js_expr(CF_PROBE_JS))
    except Exception:
        return "unknown", None
    if not isinstance(probe, dict):
        return "unknown", None
    text = str(probe.get("text") or "")
    blob = " ".join((str(probe.get("title") or ""), str(probe.get("url") or ""), text))
    return cf_state_from_text(blob), cf_ray_id(text + " " + str(probe.get("title") or ""))


def cf_wait_challenge(driver, timeout=25.0, poll=1.2):
    """Ждём, пока браузер сам пройдёт JS-проверку. Возвращает (state, ray)."""
    try:
        deadline = time.time() + max(1.0, float(timeout))
    except Exception:
        deadline = time.time() + 25.0
    state, ray = page_cf_state(driver)
    while state == "challenge" and time.time() < deadline:
        time.sleep(min(poll, max(0.2, deadline - time.time())))
        state, ray = page_cf_state(driver)
    return state, ray


def cf_settle(driver, cfs):
    """Дождаться проверки на текущей странице (если это разрешено) → (state, ray)."""
    state, ray = page_cf_state(driver)
    if state == "challenge" and cfs.get("wait_challenge", True):
        state, ray = cf_wait_challenge(driver, cfs.get("challenge_timeout", 25))
    return state, ray


def cf_origin(url):
    """«Главная страница» сайта: схема + хост + порт."""
    try:
        parts = urlsplit(url)
    except Exception:
        return None
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return parts.scheme + "://" + parts.netloc + "/"


def cf_is_deep(url):
    """Ссылка глубже главной (путь или параметры).

    «Холодный» прямой заход на глубокую ссылку чаще ловит проверку, поэтому
    с включённым soft_landing сначала открывается главная сайта.
    """
    try:
        parts = urlsplit(url)
    except Exception:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    return bool((parts.path or "/").strip("/") or parts.query)


def cf_light_read(driver):
    """Лёгкое «чтение» страницы между шагами CF-лестницы: пара оборотов колеса."""
    try:
        import random
        for _ in range(random.randint(1, 2)):
            driver.execute_cdp_cmd("Input.dispatchMouseEvent",
                                   {"type": "mouseWheel",
                                    "x": random.randint(200, 700),
                                    "y": random.randint(200, 500),
                                    "deltaX": 0,
                                    "deltaY": random.randint(140, 420)})
            time.sleep(random.uniform(0.3, 0.8))
    except Exception:
        pass


def cf_navigate(driver, url, cfg, log=print):
    """
    Заход на сайт с учётом Cloudflare.

    Возвращает итоговое состояние: 'ok' | 'challenge' | 'blocked' | 'disabled' | 'unknown'.
    Строки '[cf] BLOCKED …' / '[cf] CHALLENGE …' разбирает main-процесс и
    показывает пользователю понятное объяснение (см. main.js → maybeSendCfNotice).
    """
    cfs = cf_settings(cfg)
    if not cfs["enabled"]:
        driver.get(url)
        return "disabled"

    try:
        host = urlsplit(url).netloc or url
    except Exception:
        host = url

    if cfs["soft_landing"] and cf_is_deep(url):
        root = cf_origin(url)
        if root:
            log("[cf] мягкий вход: открываем главную " + root + " перед глубокой ссылкой")
            driver.get(root)
            state, _ray = cf_settle(driver, cfs)
            if state == "ok":
                human_pause(1.2, 0.9)     # человек сначала осматривается
                cf_light_read(driver)

    driver.get(url)
    first_state, _first_ray = cf_settle(driver, cfs)
    state, ray = first_state, _first_ray
    attempts = 0
    max_retries = int(cfs["max_retries"])
    while state in ("challenge", "blocked") and attempts < max_retries:
        attempts += 1
        human_pause(2.6, 1.6)             # человек не жмёт F5 мгновенно
        root = cf_origin(url)
        if state == "blocked" and attempts == max_retries and root and cf_is_deep(url):
            # Последняя попытка — как у человека: сначала главная (её проверка
            # короче), затем целевая ссылка уже с полученной cookie.
            log("[cf] блокировка: пробуем зайти через главную " + root)
            try:
                driver.get(root)
            except Exception as exc:
                log("[cf] переход на главную не удался: " + str(exc))
                break
            state, ray = cf_settle(driver, cfs)
            if state == "ok":
                human_pause(1.5, 1.0)
                cf_light_read(driver)
                driver.get(url)
                state, ray = cf_settle(driver, cfs)
            continue
        log("[cf] попытка " + str(attempts) + ": обновляем страницу (" + state + ")")
        try:
            driver.refresh()
        except Exception as exc:
            log("[cf] обновление не удалось: " + str(exc))
            break
        state, ray = cf_settle(driver, cfs)

    if state == "blocked":
        log("[cf] BLOCKED ray=" + (ray or "-") + " host=" + host +
            " — Cloudflare отдал страницу блокировки. Отпечаток и браузер тут не при чём: "
            "так отвечает репутация IP/подсети. Что помогает: 1) резидентский прокси профиля, "
            "2) пауза 10–30 минут, 3) повторный запуск профиля — его cookies уже сохранены.")
    elif state == "challenge":
        log("[cf] CHALLENGE host=" + host +
            " — проверка Cloudflare не завершилась за отведённое время. Окно закрывать не нужно: "
            "проверка часто досчитывается сама, либо нажми F5.")
    elif first_state != "ok":
        log("[cf] OK host=" + host + " — проверка Cloudflare пройдена, открываем страницу сайта")
    return state


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
            # 'generated' — UA собран генератором (его можно и нужно выравнивать по
            # реальной ОС); 'user' — UA задан пользователем, трогать нельзя.
            "user_agent_source": ident.get("user_agent_source"),
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
        patcher = None
        browser = (b_type or "chrome").lower()
        cfs = cf_settings(cfg)
        try:
            if browser == "firefox":
                driver = self._launch_firefox(profile_path, ident)
            elif browser == "msedge":
                driver = self._launch_edge(profile_path, ident)
            elif browser == "yandex":
                driver = self._launch_yandex(profile_path, ident)
            else:
                driver = self._launch_chrome(profile_path, ident)

            # 1) Снимаем РЕАЛЬНОЕ железо, пока документ (about:blank) ещё не пропатчен.
            #    Это последний момент, когда видно правду: ядра, deviceMemory, лимиты GPU.
            real = probe_real_hardware(driver)

            # 2) Расхождения с реальностью — единственное, что нельзя спрятать
            #    (воркеры и OffscreenCanvas патчатся не везде) — убираем их в самом
            #    отпечатке, а не косметикой поверх.
            for note in align_identity_to_hardware(ident, real, cfs):
                print("[fp] " + note)

            # 3) Отпечаток применяем ДО первой навигации
            self._inject_init(driver, ident)
            self.apply_identity(driver, ident, cfg)

            # 4) Воркеры: тот же отпечаток, что и в кадрах (иначе скрипт сравнивает
            #    главный поток с Worker и видит подмену).
            if cfs.get("worker_patch", True):
                patcher = WorkerPatchManager(driver, build_worker_init(ident))
                patcher.start()

            if url and url != "about:blank":
                # Сначала Cloudflare-логика (ожидание проверки/повтор), и только
                # потом «человеческое» поведение: прокрутка и курсор на странице
                # блокировки выглядят как бот и мешают пройти проверку.
                cf_state = cf_navigate(driver, url, cfg)
                if cf_state in ("ok", "disabled", "unknown"):
                    self.humanize(driver, ident, cfg)
                else:
                    print("[cf] разогрев поведения пропущен — страница сайта ещё не открыта")

                # 5) Самопроверка «главный поток ↔ воркер» — ровно то, чем
                #    проверяют подделку отпечатка. Пишем в лог как есть.
                if patcher is not None and patcher.enabled:
                    diffs = worker_selftest(driver)
                    if diffs:
                        print("[cf] РАСХОЖДЕНИЕ главный поток ↔ Worker: " + "; ".join(diffs) +
                              " — это видно антибот-скриптам (смени профиль/перезапусти браузер)")
                    else:
                        print("[cf] воркер-проверка: главный поток и Worker согласованы "
                              "(platform, ядра, языки)")

            while True:
                try:
                    _ = driver.window_handles
                    time.sleep(0.8)
                except Exception:
                    break
        except Exception as e:
            print(f"[engine] error ({browser}): {e}")
        finally:
            if patcher is not None:
                patcher.stop()
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
