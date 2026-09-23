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


@check("fullVersionList: GREASE-бренд отдаёт N.0.0.0, служебные флаги не уходят в CDP")
def _full_version_list():
    engine = load_engine()
    cfg = {"identity": {
        "schema": 2,
        "user_agent": "UA-STRING", "ua_major": "131", "ua_full_version": "131.0.6778.86",
        "brands": [
            {"brand": "Not_A Brand", "version": "24", "grease": True},
            {"brand": "Google Chrome", "version": "131"},
            {"brand": "Chromium", "version": "131"},
        ],
    }}
    ident = engine.BrowserManager().build_identity(cfg, "t", "chrome")
    captured = {}

    class CapDriver:
        def execute_cdp_cmd(self, cmd, params):
            if cmd == "Network.setUserAgentOverride":
                captured.update(params)
            return {}

    engine.BrowserManager().apply_identity(CapDriver(), ident, cfg)
    md = captured["userAgentMetadata"]
    brands = {b["brand"]: b["version"] for b in md["brands"]}
    fulls = {b["brand"]: b["version"] for b in md["fullVersionList"]}
    assert brands["Not_A Brand"] == "24", "в sec-ch-ua GREASE остаётся кратким"
    assert fulls["Not_A Brand"] == "24.0.0.0", "в fullVersionList GREASE = N.0.0.0 (как у живого Chrome)"
    assert fulls["Google Chrome"] == "131.0.6778.86"
    assert fulls["Chromium"] == "131.0.6778.86"
    assert all("grease" not in b for b in md["brands"]), "служебные флаги не уходят в CDP"



@check("Cloudflare: состояние страницы распознаётся по маркерам")
def _cf_state():
    engine = load_engine()
    blocked = ('Sorry, you have been blocked. You are unable to access site.com. '
               'Why have I been blocked? Cloudflare Ray ID: 8f3c1d2e4a5b6c7d')
    assert engine.cf_state_from_text(blocked) == "blocked"
    assert engine.cf_ray_id(blocked) == "8f3c1d2e4a5b6c7d"
    assert engine.cf_state_from_text("Just a moment... Enable JavaScript and cookies to continue") == "challenge"
    assert engine.cf_state_from_text("Checking your browser before accessing site.com") == "challenge"
    # на странице проверки тоже печатают Ray ID — это НЕ блокировка
    assert engine.cf_state_from_text("Just a moment... Ray ID: aabbccddeeff0011") == "challenge"
    assert engine.cf_state_from_text("Обычная страница сайта") == "ok"
    assert engine.cf_ray_id("никаких меток") is None


@check("Cloudflare: настройки с клампом, ссылки разбираются на главную")
def _cf_settings():
    engine = load_engine()
    assert engine.cf_settings({}) == engine.CF_DEFAULTS
    cfs = engine.cf_settings({"cf": {"enabled": False, "challenge_timeout": 999,
                                     "max_retries": -1, "soft_landing": "yes"}})
    assert cfs["enabled"] is False
    assert cfs["challenge_timeout"] == 90
    assert cfs["max_retries"] == 0
    assert cfs["soft_landing"] is True, "строка вместо bool не должна проходить валидацию"
    assert engine.cf_settings({"cf": "мусор"}) == engine.CF_DEFAULTS
    assert engine.cf_origin("https://site.com/login?x=1") == "https://site.com/"
    assert engine.cf_origin("about:blank") is None
    assert engine.cf_is_deep("https://site.com/login") is True
    assert engine.cf_is_deep("https://site.com/?a=1") is True
    assert engine.cf_is_deep("https://site.com") is False
    assert engine.cf_is_deep("about:blank") is False


class _FakeCfDriver:
    """Драйвер-стенд: отдаёт заранее заданную последовательность состояний."""

    def __init__(self, states):
        self.states = list(states)          # 'blocked' | 'challenge' | 'ok'
        self.opened = []
        self.refreshed = 0

    def get(self, url):
        self.opened.append(url)

    def refresh(self):
        self.refreshed += 1

    def _next_state(self):
        if len(self.states) > 1:
            return self.states.pop(0)
        return self.states[0] if self.states else "ok"

    def execute_script(self, _js):
        state = self._next_state()
        if state == "blocked":
            return {"title": "Attention Required! | Cloudflare", "url": "https://site.com/x",
                    "text": "Sorry, you have been blocked. Ray ID: 0123456789abcdef"}
        if state == "challenge":
            return {"title": "Just a moment...", "url": "https://site.com/x",
                    "text": "Checking your browser before accessing site.com"}
        return {"title": "Сайт", "url": "https://site.com/x", "text": "обычная страница"}


@check("Cloudflare: блокировка обходится повтором (обновлением страницы)")
def _cf_blocked_recovery():
    engine = load_engine()
    driver = _FakeCfDriver(["blocked", "ok"])
    logs = []
    state = engine.cf_navigate(driver, "https://site.com/",
                               {"cf": {"soft_landing": False, "max_retries": 1}}, log=logs.append)
    assert state == "ok", state
    assert driver.refreshed == 1, "после блокировки страница должна обновиться"
    assert any("обновляем" in line for line in logs), "в логе нет шага повтора"


@check("Cloudflare: если блокировка не снялась — причина и Ray ID в логе")
def _cf_blocked_persistent():
    engine = load_engine()
    driver = _FakeCfDriver(["blocked"])
    logs = []
    state = engine.cf_navigate(driver, "https://site.com/x", {"cf": {}}, log=logs.append)
    assert state == "blocked", state
    assert any("BLOCKED" in line for line in logs), \
        "маркер [cf] BLOCKED (его показывает main в UI) не найден"
    assert any("ray=0123456789abcdef" in line for line in logs), "Ray ID не разобран"
    assert any("host=site.com" in line for line in logs), "хост не попал в лог"


@check("Cloudflare: проверка ожидается, а не «читается» действиями бота")
def _cf_wait_challenge():
    engine = load_engine()
    driver = _FakeCfDriver(["challenge", "challenge", "ok"])
    state = engine.cf_navigate(driver, "https://site.com/",
                               {"cf": {"challenge_timeout": 6}}, log=lambda *_: None)
    assert state == "ok", state
    assert driver.refreshed == 0, "успешную проверку обновлять не нужно"


@check("Cloudflare: мягкий вход идёт через главную, затем на глубокую ссылку")
def _cf_soft_landing():
    engine = load_engine()
    driver = _FakeCfDriver(["ok"])
    state = engine.cf_navigate(driver, "https://site.com/cabinet/orders",
                               {"cf": {}}, log=lambda *_: None)
    assert state == "ok"
    assert driver.opened == ["https://site.com/", "https://site.com/cabinet/orders"], driver.opened
    # выключенный soft_landing — прямой заход, как раньше
    driver2 = _FakeCfDriver(["ok"])
    engine.cf_navigate(driver2, "https://site.com/cabinet/orders",
                       {"cf": {"soft_landing": False}}, log=lambda *_: None)
    assert driver2.opened == ["https://site.com/cabinet/orders"]


@check("Cloudflare: выключенный режим не меняет прежнее поведение")
def _cf_disabled():
    engine = load_engine()
    driver = _FakeCfDriver(["ok"])
    state = engine.cf_navigate(driver, "https://site.com/x", {"cf": {"enabled": False}},
                               log=lambda *_: None)
    assert state == "disabled"
    assert driver.opened == ["https://site.com/x"]


@check("Cloudflare: движок связан с UI (маркеры лога и пропуск разогрева)")
def _cf_wiring():
    src = ENGINE_SRC
    assert "cf_navigate(driver, url, cfg)" in src, "start_browser не зовёт CF-логику"
    assert "[cf] BLOCKED" in src and "[cf] CHALLENGE" in src, "нет машинных маркеров для main"
    assert "разогрев поведения пропущен" in src, "разогрев может уйти на страницу проверки"

# ── воркеры и coherence с реальным железом ──────────────────────────────

class _FakeWorkerDriver:
    """Драйвер с эмуляцией Target-домена: как Selenium execute_cdp_cmd."""

    def __init__(self, targets=None):
        self.calls = []
        self.scripts = []
        self.attached = 0
        self.detached = []
        self.targets = targets if targets is not None else [
            {"targetId": "W1", "type": "worker", "attached": False},
            {"targetId": "F1", "type": "iframe", "attached": False},
        ]
        self.fail_attach = False

    def execute_cdp_cmd(self, method, params):
        self.calls.append((method, params))
        if method == "Target.setAutoAttach":
            return {}
        if method == "Target.getTargets":
            return {"targetInfos": [dict(t, attached=(t["targetId"] in ("W1", "W2"))) for t in self.targets]}
        if method == "Target.attachToTarget":
            if self.fail_attach:
                raise RuntimeError("attach failed")
            self.attached += 1
            return {"sessionId": "S" + str(self.attached)}
        if method == "Target.sendMessageToTarget":
            import json as _json
            try:
                msg = _json.loads(params["message"])
            except Exception:
                msg = {}
            if msg.get("method") == "Runtime.evaluate":
                self.scripts.append(msg.get("params", {}).get("expression", ""))
            return {}
        if method == "Target.detachFromTarget":
            self.detached.append(params.get("sessionId"))
            return {}
        return {}


@check("js_expr: значение выражения доходит из Selenium (иначе CF-логика слепая)")
def _js_expr():
    engine = load_engine()
    assert engine.js_expr("(function(){return 1;})();").startswith("return (")
    assert engine.js_expr("return 1;") == "return 1;"          # уже с return — не ломаем
    # скрипт, заканчивающийся строчным комментарием, не должен «съесть» хвост
    wrapped = engine.js_expr("(function(){ return 1; })(); // хвост")
    assert wrapped.endswith("\n);") and "// хвост" in wrapped
    # и главное: проба состояния страницы обязана вернуть словарь
    class _D:
        def execute_script(self, src):
            # Selenium исполняет скрипт как ТЕЛО функции: без return значение теряется
            return {"title": "Just a moment..."} if src.strip().startswith("return") else None
    state, _ray = engine.page_cf_state(_D())
    assert state == "challenge", state
    class _D2:
        def execute_script(self, src):
            return {"platform": "Linux x86_64"} if src.strip().startswith("return") else None
    assert engine.probe_real_hardware(_D2()).get("platform") == "Linux x86_64"


@check("железо: ядра, память и языки выравниваются по реальной машине")
def _align_hw():
    engine = load_engine()
    ident = {"user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0",
             "user_agent_source": "generated", "ua_platform": "Windows", "platform": "Win32",
             "languages": ["de-DE", "de"],
             "hardware": {"cores": 8, "memory": 16, "device_memory": 8, "max_touch_points": 0}}
    real = {"platform": "Linux x86_64", "cores": 2, "languages": ["de-DE"], "device_memory": 4, "webgl": None}
    notes = engine.align_identity_to_hardware(ident, real, {})
    assert ident["hardware"]["cores"] == 2, ident["hardware"]
    assert ident["hardware"]["device_memory"] == 4, ident["hardware"]
    assert ident["languages"] == ["de-DE"], ident["languages"]
    assert ident["platform"] == "Linux x86_64"
    assert engine.device_memory_bucket(16) == 8 and engine.device_memory_bucket(2) == 2, "шкала как в Chrome"
    assert notes, "должны быть пояснения в лог"


@check("железо: реальный GPU показывается как есть, программный — нет")
def _align_gpu():
    engine = load_engine()
    base = {"user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0",
            "user_agent_source": "generated", "ua_platform": "Windows", "platform": "Win32",
            "languages": ["ru-RU"], "hardware": {"cores": 8, "device_memory": 8},
            "webgl": {"vendor": "Google Inc. (NVIDIA)", "renderer": "ANGLE (NVIDIA, RTX 3060 Direct3D11)",
                      "tier": "high", "limits": {"MAX_TEXTURE_SIZE": 32768, "MAX_VARYING_VECTORS": 32}}}
    real_hw = {"platform": "Win32", "cores": 8, "languages": ["ru-RU"], "device_memory": 8,
               "webgl": {"vendor": "Google Inc. (Intel)", "renderer": "ANGLE (Intel, Intel(R) UHD Graphics 630)",
                         "limits": {"MAX_TEXTURE_SIZE": 16384, "MAX_VARYING_VECTORS": 30}}}
    hw = json.loads(json.dumps(base))
    engine.align_identity_to_hardware(hw, real_hw, {})
    assert "Intel" in hw["webgl"]["renderer"], hw["webgl"]
    assert hw["webgl"]["limits"]["MAX_TEXTURE_SIZE"] == 16384
    assert hw["webgl"]["tier"] == "mid"

    real_sw = {"platform": "Linux x86_64", "cores": 2, "languages": ["ru-RU"], "device_memory": 4,
               "webgl": {"renderer": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))",
                         "limits": {"MAX_TEXTURE_SIZE": 8192}}}
    sw = json.loads(json.dumps(base))
    notes = engine.align_identity_to_hardware(sw, real_sw, {})
    assert sw["webgl"]["renderer"] == base["webgl"]["renderer"], "программный рендер нельзя показывать сайту"
    assert sw["webgl"]["limits"]["MAX_TEXTURE_SIZE"] == 32768, "лимиты профиля не должны стать «программными»"
    assert sw.get("software_gpu") is True and notes


@check("UA выравнивается по реальной ОС, но не трогается, если задан пользователем")
def _align_ua():
    engine = load_engine()
    def ident(src):
        return {"user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "user_agent_source": src, "ua_major": "131", "ua_platform": "Windows",
                "ua_platform_version": "10.0.0", "platform": "Win32",
                "languages": ["ru-RU"], "hardware": {"cores": 4, "device_memory": 4}}
    real = {"platform": "Linux x86_64", "cores": 4, "languages": ["ru-RU"], "device_memory": 4, "webgl": None}
    gen = ident("generated")
    engine.align_identity_to_hardware(gen, real, {})
    assert "X11; Linux x86_64" in gen["user_agent"], gen["user_agent"]
    assert "Chrome/131.0.0.0" in gen["user_agent"], "версия обязана сохраниться"
    assert gen["ua_platform"] == "Linux" and gen["platform"] == "Linux x86_64"

    usr = ident("user")
    engine.align_identity_to_hardware(usr, real, {})
    assert "Windows NT 10.0" in usr["user_agent"], "пользовательский UA трогать нельзя"
    assert usr.get("platform_mismatch") is True, "но предупредить обязаны"
    assert engine.align_ua_to_os({"user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                  "Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0", "ua_major": "131"},
                                 "MacIntel") is not None


@check("воркеры: авто-подключение только к Worker (iframe-виджеты не замораживаем)")
def _worker_autoatach():
    engine = load_engine()
    driver = _FakeWorkerDriver()
    mgr = engine.WorkerPatchManager(driver, "self.__patched = 1;", log=lambda *_: None, poll=0.05)
    assert mgr.start() is True
    method, params = driver.calls[0]
    assert method == "Target.setAutoAttach", method
    assert params.get("autoAttach") is True
    assert params.get("waitForDebuggerOnStart") is True
    filter_rule = params.get("filter") or []
    assert any(r.get("type") == "worker" and r.get("exclude") is False for r in filter_rule), filter_rule
    assert any(r.get("exclude") is True for r in filter_rule), "нужен запрет по умолчанию"
    mgr.stop()


@check("воркеры: патч применяется, воркер отпускается, повторно не патчится")
def _worker_patch():
    engine = load_engine()
    driver = _FakeWorkerDriver()
    mgr = engine.WorkerPatchManager(driver, "self.__artofix = 1;", log=lambda *_: None, poll=0.05)
    mgr.start()
    assert mgr.patch_pending() == 1, "должен пропатчить ровно воркер"
    assert mgr.patched == 1
    assert driver.scripts and "self.__artofix = 1;" in driver.scripts[0]
    methods = [c[0] for c in driver.calls]
    assert "Target.attachToTarget" in methods and "Target.detachFromTarget" in methods
    released = [json.loads(c[1]["message"])["method"] for c in driver.calls
                if c[0] == "Target.sendMessageToTarget" and "runIfWaitingForDebugger" in c[1]["message"]]
    assert released, "воркер обязан быть отпущен (Runtime.runIfWaitingForDebugger)"
    assert driver.detached, "сессию воркера нужно закрыть"
    # второй вызов не должен патчить его снова
    assert mgr.patch_pending() == 0
    mgr.stop()


@check("воркеры: при сбое патча воркер всё равно отпускается")
def _worker_patch_failure():
    engine = load_engine()
    driver = _FakeWorkerDriver()
    driver.fail_attach = True
    mgr = engine.WorkerPatchManager(driver, "self.x = 1;", log=lambda *_: None, poll=0.05)
    mgr.start()
    assert mgr.patch_pending() == 0
    assert mgr.patched == 0 and mgr.errors >= 1
    assert driver.detached == [], "сессии нет — закрывать нечего"
    mgr.stop()


@check("воркеры: самопроверка видит расхождение и молчит при согласии")
def _worker_selftest():
    engine = load_engine()

    class _D:
        def __init__(self, result):
            self.result = result
            self.calls = 0
        def execute_script(self, src):
            self.calls += 1
            return self.result

    bad = _D({"platform": "Linux x86_64", "cores": 2, "langs": "en-US",
              "main": {"platform": "Win32", "cores": 8, "langs": "ru-RU,ru"}})
    diffs = engine.worker_selftest(bad, timeout=1)
    assert len(diffs) == 3, diffs

    good = _D({"platform": "Win32", "cores": 8, "langs": "ru-RU,ru",
               "main": {"platform": "Win32", "cores": 8, "langs": "ru-RU,ru"}})
    assert engine.worker_selftest(good, timeout=1) == []

    slow = _D("pending")
    slow.result = {"error": "pending"}
    assert engine.worker_selftest(slow, timeout=1), "молчащий воркер — это подозрительно"


@check("движок применяет воркеры и железо до первой навигации")
def _start_wiring():
    src = ENGINE_SRC
    for needle in ["probe_real_hardware(driver)", "align_identity_to_hardware(ident, real, cfs)",
                   "WorkerPatchManager(driver, build_worker_init(ident))", "worker_selftest(driver)",
                   "patcher.stop()"]:
        assert needle in src, "в start_browser нет: " + needle
    assert src.index("align_identity_to_hardware(ident, real, cfs)") < src.index("cf_navigate(driver, url, cfg)"), \
        "выравнивание обязано быть до навигации"
    assert "js_expr(PROBE_REAL_JS)" in src and "js_expr(CF_PROBE_JS)" in src, "нет js_expr у проб"


@check("настройки CF знают про воркеры и железо")
def _cf_settings_keys():
    engine = load_engine()
    cfs = engine.cf_settings({})
    assert cfs["worker_patch"] is True and cfs["align_hardware"] is True, cfs
    off = engine.cf_settings({"cf": {"worker_patch": False, "align_hardware": False}})
    assert off["worker_patch"] is False and off["align_hardware"] is False
    ident = {"hardware": {"cores": 8}, "webgl": None, "languages": ["ru-RU"]}
    real = {"platform": "Win32", "cores": 2, "languages": ["ru-RU"], "webgl": None}
    engine.align_identity_to_hardware(ident, real, {"align_hardware": False})
    assert ident["hardware"]["cores"] == 8, "выключенный тумблер обязан отключать выравнивание"


def main():
    failed = [r for r in RESULTS if r[0] == "fail"]
    for status, name in RESULTS:
        print(("  ✓ " if status == "ok" else "  ✗ ") + name)
    print("\nengine: %d/%d проверок пройдено" % (len(RESULTS) - len(failed), len(RESULTS)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
