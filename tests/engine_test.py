#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Проверки engine.py без реального запуска браузера.

Запуск:  python3 tests/engine_test.py

Что проверяем:
  • engine.py не использует shell=True / os.system / eval;
  • все внешние команды вызываются списком аргументов;
  • разбор identity из config.json (схема v2) и обратная совместимость (v1);
  • page-init скрипт собирается подстановкой JSON и остаётся валидным JS.
"""

import ast
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "engine.py")

RESULTS = []


def check(name):
    def deco(fn):
        try:
            fn()
            RESULTS.append(("ok", name))
        except Exception as e:
            RESULTS.append(("fail", name + " → " + repr(e)))
        return fn
    return deco


# ── стенды для selenium, чтобы импорт engine.py не тянул зависимости ──
def _stub_modules():
    def mod(name, **attrs):
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m
        return m

    class _Opts:
        def add_argument(self, *a, **k): pass
        def add_experimental_option(self, *a, **k): pass
        def set_preference(self, *a, **k): pass
        binary_location = None

    class _Svc:
        def __init__(self, *a, **k): pass

    class _Driver:
        def __init__(self, *a, **k): pass
        def execute_cdp_cmd(self, *a, **k): return {}
        def execute_script(self, *a, **k): pass
        def get(self, *a, **k): pass
        def quit(self): pass
        window_handles = []

    mod("selenium", webdriver=None)
    mod("selenium.webdriver", webdriver=None)
    mod("selenium.webdriver.chrome", options=None, service=None)
    mod("selenium.webdriver.chrome.options", Options=_Opts)
    mod("selenium.webdriver.chrome.service", Service=_Svc)
    mod("selenium.webdriver.edge.options", Options=_Opts)
    mod("selenium.webdriver.edge.service", Service=_Svc)
    mod("selenium.webdriver.firefox.options", Options=_Opts)
    mod("selenium.webdriver.firefox.service", Service=_Svc)
    webdriver = mod("selenium.webdriver", webdriver=None)
    webdriver.Chrome = _Driver
    webdriver.Edge = _Driver
    webdriver.Firefox = _Driver
    mod("selenium_stealth", stealth=lambda *a, **k: None)
    mod("webdriver_manager")


def load_engine():
    _stub_modules()
    import importlib.util
    spec = importlib.util.spec_from_file_location("artofix_engine", ENGINE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ENGINE_SRC = open(ENGINE, encoding="utf-8").read()
ENGINE_AST = ast.parse(ENGINE_SRC)


@check("engine.py: нет shell=True, os.system и eval")
def _no_shell():
    assert "shell=True" not in ENGINE_SRC
    assert "os.system(" not in ENGINE_SRC
    assert "eval(" not in ENGINE_SRC
    assert "exec(" not in ENGINE_SRC.replace("sys.executable", "")


@check("engine.py: subprocess вызывается списком аргументов")
def _list_args():
    for node in ast.walk(ENGINE_AST):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in ("run", "Popen") and node.args:
                first = node.args[0]
                assert isinstance(first, (ast.List, ast.Name, ast.Attribute, ast.Call)), (
                    "команда должна быть списком, а не строкой: " + ast.dump(first)[:80])


@check("identity v2 разбирается полностью")
def _identity_v2():
    engine = load_engine()
    cfg = {
        "identity": {
            "schema": 2,
            "user_agent": "UA-STRING",
            "ua_major": "131",
            "ua_full_version": "131.0.6778.86",
            "brands": [{"brand": "Chromium", "version": "131"}],
            "languages": ["ru-RU", "ru"],
            "timezone": "Europe/Moscow",
            "webgl": {"vendor": "Google Inc. (NVIDIA)", "renderer": "ANGLE (...)", "tier": "high",
                      "limits": {"MAX_TEXTURE_SIZE": 32768}},
            "canvas_noise": 37,
            "audio_freq_shift": 0.00004,
            "hardware": {"cores": 8, "memory": 16, "device_memory": 8, "max_touch_points": 0},
            "screen": {"width": 1920, "height": 1080, "window_width": 1880, "window_height": 980,
                       "device_pixel_ratio": 1},
            "vectors": {"webgl": True, "canvas": True},
            "webrtc": {"mode": "public_only"},
            "country_code": "DE", "country_name": "Германия", "country_city": "Берлин",
            "geo_source": "country",
            "geolocation": {"lat": 52.52, "lon": 13.405, "accuracy": 64},
        }
    }
    bm = engine.BrowserManager()
    ident = bm.build_identity(cfg, "yt", "chrome")
    assert ident["user_agent"] == "UA-STRING"
    assert ident["timezone"] == "Europe/Moscow"
    assert ident["languages"] == ["ru-RU", "ru"]
    assert ident["canvas_noise"] == 37
    assert ident["webgl"]["vendor"] == "Google Inc. (NVIDIA)"
    assert ident["hardware"]["cores"] == 8
    assert ident["window_width"] == 1880
    assert ident["webrtc"]["mode"] == "public_only"
    assert ident["vectors"]["webgl"] is True
    # страна антидетекта: гео-точка доходит до браузера именно так, без обрезаний
    assert ident["geo_source"] == "country"
    assert ident["country_code"] == "DE"
    assert ident["geolocation"] == {"lat": 52.52, "lon": 13.405, "accuracy": 64}


@check("identity без выбора страны живёт без эмуляции гео")
def _identity_v2_no_country():
    engine = load_engine()
    cfg = {"identity": {"schema": 2, "languages": ["ru-RU"], "timezone": "Europe/Moscow"}}
    ident = engine.BrowserManager().build_identity(cfg, "alt", "chrome")
    assert ident["geolocation"] is None
    assert ident["geo_source"] == "none"


@check("identity v1 (старый config.json) поддерживается")
def _identity_v1():
    engine = load_engine()
    cfg = {
        "user_agent": "OLD-UA",
        "resolution": "1280,720",
        "spoof": {"timezone": "Europe/Berlin", "lang": "de-DE,de"},
        "fingerprint": {"webgl_vendor": "Google Inc. (Intel)", "webgl_renderer": "ANGLE (Intel ...)",
                        "platform": "Win32", "canvas_noise": 12},
    }
    bm = engine.BrowserManager()
    ident = bm.build_identity(cfg, "alt", "chrome")
    assert ident["user_agent"] == "OLD-UA"
    assert ident["timezone"] == "Europe/Berlin"
    assert ident["languages"] == ["de-DE", "de"]
    assert ident["webgl"]["renderer"] == "ANGLE (Intel ...)"
    assert ident["canvas_noise"] == 12
    assert ident["platform"] == "Win32"


@check("пароль прокси берётся только из окружения")
def _proxy_password_env():
    engine = load_engine()
    cfg = {"identity": {"proxy": {"server": "socks5://1.2.3.4:1080", "username": "u"}}}
    old = os.environ.get("ARTOFIX_PROXY_PASS")
    try:
        os.environ.pop("ARTOFIX_PROXY_PASS", None)
        ident = engine.BrowserManager().build_identity(cfg, "p", "chrome")
        assert "password" not in (ident.get("proxy") or {})
        os.environ["ARTOFIX_PROXY_PASS"] = "s3cret"
        ident = engine.BrowserManager().build_identity(cfg, "p", "chrome")
        assert ident["proxy"]["password"] == "s3cret"
        # и пароль не попадает в json, который уходит в файл
        assert "s3cret" not in json.dumps(cfg)
    finally:
        if old is None:
            os.environ.pop("ARTOFIX_PROXY_PASS", None)
        else:
            os.environ["ARTOFIX_PROXY_PASS"] = old


@check("page-init собирается подстановкой JSON (без конкатенации)")
def _page_init_build():
    engine = load_engine()
    identity = {"user_agent": "UA\" }; alert(1); //", "canvas_noise": 5}
    script = engine.build_page_init(identity)
    marker = "var ID = "
    line = next(l for l in script.split("\n") if l.strip().startswith(marker))
    payload = line.strip()[len(marker):].strip().rstrip(";").strip()
    parsed = json.loads(payload)
    assert parsed["user_agent"] == identity["user_agent"], "значения должны уходить как JSON"
    assert "alert(1)" in json.dumps(parsed)


@check("page-init: подмена UNMASKED_* и защита от cdc_*")
def _page_init_content():
    engine = load_engine()
    script = engine.build_page_init({"canvas_noise": 1})
    assert "0x9245" in script and "0x9246" in script, "нет подмены UNMASKED_VENDOR/RENDERER"
    assert "cdc_" in script, "нет очистки переменных ChromeDriver"
    assert "nativeMap" in script, "нет маскировки патчей в Function.prototype.toString"
    assert "webdriver" in script


@check("движение мыши и прокрутка включены в человеческое поведение")
def _humanization():
    engine = load_engine()
    src = ENGINE_SRC
    assert "Input.dispatchMouseEvent" in src
    assert "mouseWheel" in src
    assert callable(engine.human_warmup)
    assert callable(engine.human_pause)


def main():
    failed = [r for r in RESULTS if r[0] == "fail"]
    for status, name in RESULTS:
        print(("  ✓ " if status == "ok" else "  ✗ ") + name)
    print("\nengine: %d/%d проверок пройдено" % (len(RESULTS) - len(failed), len(RESULTS)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
