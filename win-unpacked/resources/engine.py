import os
import json
import time
import sys
import subprocess
import glob

# ── Авто-установка зависимостей ──────────────────────────────
def _pip(pkg):
    subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", pkg, "-q"], check=False)

try:
    from selenium_stealth import stealth
    STEALTH_OK = True
except ImportError:
    print("[engine] Installing selenium-stealth...")
    _pip("selenium-stealth")
    try:
        from selenium_stealth import stealth
        STEALTH_OK = True
    except ImportError:
        STEALTH_OK = False

try:
    import selenium
except ImportError:
    print("[engine] Installing selenium...")
    _pip("selenium")

try:
    import webdriver_manager
except ImportError:
    print("[engine] Installing webdriver-manager...")
    _pip("webdriver-manager")

from selenium import webdriver
from selenium.webdriver.chrome.service   import Service as ChromeService
from selenium.webdriver.edge.service     import Service as EdgeService
from selenium.webdriver.firefox.service  import Service as FirefoxService
from selenium.webdriver.chrome.options   import Options as ChromeOptions
from selenium.webdriver.edge.options     import Options as EdgeOptions
from selenium.webdriver.firefox.options  import Options as FirefoxOptions


def _fix_wdm_path(path, name_hint):
    """wdm иногда возвращает путь к LICENSE файлу — ищем реальный exe рядом."""
    if path and os.path.isfile(path) and (path.endswith(".exe") or os.access(path, os.X_OK)):
        return path
    d = os.path.dirname(path) if path else ""
    for pattern in [name_hint + "*.exe", name_hint + "*"]:
        for c in glob.glob(os.path.join(d, pattern)):
            if os.path.isfile(c) and "LICENSE" not in c and "THIRD" not in c:
                return c
    return path


def _get_browser_version_from_registry(name):
    """Читает версию Chrome/Edge из реестра Windows."""
    import subprocess, re as _re
    keys = {
        'chrome': [
            r'HKLM\SOFTWARE\Google\Chrome\BLBeacon',
            r'HKLM\SOFTWARE\WOW6432Node\Google\Chrome\BLBeacon',
            r'HKCU\SOFTWARE\Google\Chrome\BLBeacon',
        ],
        'edge': [
            r'HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}',
            r'HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}',
        ],
    }
    val_name = 'pv' if name == 'edge' else 'version'
    for key in keys.get(name, []):
        try:
            r = subprocess.run(
                ['reg', 'query', key, '/v', val_name],
                capture_output=True, text=True, timeout=5
            )
            m = _re.search(rf'{val_name}\s+REG_SZ\s+([\d.]+)', r.stdout, _re.I)
            if m:
                return m.group(1)
        except Exception:
            pass
    return None


def _clean_wdm_cache(driver_name, keep_major):
    """Удаляет старые кэши драйвера из ~/.wdm/drivers/<driver_name>."""
    import shutil
    home = os.path.expanduser('~')
    cache_dir = os.path.join(home, '.wdm', 'drivers', driver_name)
    if not os.path.isdir(cache_dir) or not keep_major:
        return
    removed = 0
    try:
        for entry in os.listdir(cache_dir):
            if not entry.startswith(str(keep_major)):
                try:
                    shutil.rmtree(os.path.join(cache_dir, entry), ignore_errors=True)
                    removed += 1
                except Exception:
                    pass
        if removed:
            print(f"[engine] Removed {removed} old {driver_name} cache(s)")
    except Exception as e:
        print(f"[engine] Cache cleanup warning: {e}")


def get_chrome_driver_path():
    # ARTOFIX_ROOT — папка рядом с exe (или папка проекта в dev)
    # drivers/ создаётся туда при установке через вкладку Компоненты
    root = os.environ.get('ARTOFIX_ROOT') or os.path.dirname(os.path.abspath(__file__))
    local = os.path.join(root, "drivers", "chromedriver.exe")
    if os.path.isfile(local):
        print(f"[engine] ChromeDriver (local): {local}")
        return local

    # Через config.json
    cfg_file = os.environ.get('ARTOFIX_CONFIG') or os.path.join(root, "config.json")
    try:
        with open(cfg_file, "r") as f:
            cfg_path = json.load(f).get("chromedriver_path")
            if cfg_path and os.path.isfile(cfg_path):
                print(f"[engine] ChromeDriver (config): {cfg_path}")
                return cfg_path
    except Exception:
        pass

    # Через webdriver-manager (авто)
    try:
        from webdriver_manager.chrome import ChromeDriverManager
        ver = _get_browser_version_from_registry('chrome')
        if ver:
            _clean_wdm_cache('chromedriver', int(ver.split('.')[0]))
        try:
            mgr = ChromeDriverManager(driver_version=ver) if ver else ChromeDriverManager()
        except TypeError:
            mgr = ChromeDriverManager(version=ver) if ver else ChromeDriverManager()
        drv_path = _fix_wdm_path(mgr.install(), "chromedriver")
        print(f"[engine] ChromeDriver (wdm): {drv_path}")
        return drv_path
    except Exception as e:
        print(f"[engine] ChromeDriver error: {e}")
        return None


def get_edge_driver_path():
    root = os.environ.get('ARTOFIX_ROOT') or os.path.dirname(os.path.abspath(__file__))
    local = os.path.join(root, "drivers", "msedgedriver.exe")
    if os.path.isfile(local):
        print(f"[engine] EdgeDriver (local): {local}")
        return local

    # Через config.json
    cfg_file = os.environ.get('ARTOFIX_CONFIG') or os.path.join(root, "config.json")
    try:
        with open(cfg_file, "r") as f:
            cfg_path = json.load(f).get("edgedriver_path")
            if cfg_path and os.path.isfile(cfg_path):
                print(f"[engine] EdgeDriver (config): {cfg_path}")
                return cfg_path
    except Exception:
        pass

    # Через webdriver-manager (авто)
    try:
        from webdriver_manager.microsoft import EdgeChromiumDriverManager
        ver = _get_browser_version_from_registry('edge')
        if ver:
            _clean_wdm_cache('msedgedriver', int(ver.split('.')[0]))
        try:
            mgr = EdgeChromiumDriverManager(driver_version=ver) if ver else EdgeChromiumDriverManager()
        except TypeError:
            try:
                mgr = EdgeChromiumDriverManager(version=ver) if ver else EdgeChromiumDriverManager()
            except TypeError:
                mgr = EdgeChromiumDriverManager()
        drv_path = _fix_wdm_path(mgr.install(), "msedgedriver")
        print(f"[engine] EdgeDriver (wdm): {drv_path}")
        return drv_path
    except Exception as e:
        print(f"[engine] EdgeDriver error: {e}")
        return None


def get_gecko_driver_path():
    try:
        from webdriver_manager.firefox import GeckoDriverManager
        path = GeckoDriverManager().install()
        path = _fix_wdm_path(path, "geckodriver")
        print(f"[engine] GeckoDriver: {path}")
        return path
    except Exception as e:
        print(f"[engine] GeckoDriver error: {e}")
        return None


class BrowserManager:
    def __init__(self):
        self.root        = os.path.dirname(os.path.abspath(__file__))
        self.p_dir       = os.environ.get('ARTOFIX_PROFILES') or os.path.join(self.root, "profiles")
        self.config_file = os.environ.get('ARTOFIX_CONFIG')   or os.path.join(self.root, "config.json")
        os.makedirs(self.p_dir, exist_ok=True)

    def load_config(self):
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print(f"[engine] config error: {e}")
        return {}

    def get_yandex_path(self):
        user_pc = os.environ.get("USERPROFILE", "")
        paths = [
            os.path.join(user_pc, "AppData", "Local", "Yandex", "YandexBrowser", "Application", "browser.exe"),
            r"C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe",
            r"C:\Program Files\Yandex\YandexBrowser\Application\browser.exe",
        ]
        for p in paths:
            if os.path.exists(p):
                return p
        return None

    def start_browser(self, url="about:blank", name="temp", b_type="chrome"):
        profile_path = os.path.join(self.p_dir, name)
        os.makedirs(profile_path, exist_ok=True)

        cfg   = self.load_config()
        ua    = cfg.get("user_agent") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        res   = cfg.get("resolution") or "1920,1080"
        w, h  = (res.replace(",", "x").split("x") + ["1080"])[:2]
        spoof = cfg.get("spoof") or {}
        tz    = spoof.get("timezone") or "Europe/Moscow"
        lang  = spoof.get("lang") or "ru-RU,ru"
        langs = [l.strip() for l in lang.split(",")]
        fp    = cfg.get("fingerprint") or {}

        print(f"[engine] fingerprint: webgl={fp.get('webgl_vendor','default')} platform={fp.get('platform','default')}")

        b_type = b_type.lower()
        driver = None
        try:
            if b_type == "firefox":
                driver = self._launch_firefox(profile_path, ua, langs)
            elif b_type == "msedge":
                driver = self._launch_edge(profile_path, ua, w, h, tz, langs, fp)
            elif b_type == "yandex":
                driver = self._launch_yandex(profile_path, ua, w, h, tz, langs, fp)
            else:
                driver = self._launch_chrome(profile_path, ua, w, h, tz, langs, fp)

            if url and url != "about:blank":
                driver.get(url)

            while True:
                try:
                    _ = driver.window_handles
                    time.sleep(0.8)
                except Exception:
                    break
        except Exception as e:
            print(f"[engine] error ({b_type}): {e}")
        finally:
            if driver:
                try: driver.quit()
                except Exception: pass

    def _apply_stealth(self, driver, fp=None):
        fp = fp or {}
        if STEALTH_OK:
            stealth(driver,
                languages=["ru-RU", "ru", "en-US", "en"],
                vendor=fp.get('webgl_vendor',    'Google Inc.'),
                platform=fp.get('platform',      'Win32'),
                webgl_vendor=fp.get('webgl_vendor', 'Google Inc.'),
                renderer=fp.get('webgl_renderer', 'Intel Iris OpenGL Engine'),
                fix_hairline=True,
            )
        # Canvas noise
        noise = fp.get('canvas_noise')
        if noise is not None:
            try:
                driver.execute_script(f"""
(function(){{
  const orig = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(t) {{
    const ctx = this.getContext && this.getContext('2d');
    if (ctx) {{ const d = ctx.getImageData(0,0,1,1); d.data[0]=(d.data[0]+{noise})%256; ctx.putImageData(d,0,0); }}
    return orig.apply(this, arguments);
  }};
  const orig2 = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function(x,y,w,h) {{
    const d = orig2.apply(this,[x,y,w,h]);
    d.data[0] = (d.data[0] + {noise % 3}) % 256;
    return d;
  }};
}})();
""")
            except Exception:
                pass

    def _common_opts(self, opt, profile_path, ua, w, h, langs):
        opt.add_argument(f"--user-data-dir={profile_path}")
        opt.add_argument(f"--user-agent={ua}")
        opt.add_argument(f"--window-size={w},{h}")
        opt.add_argument(f"--lang={langs[0] if langs else 'ru-RU'}")
        opt.add_argument("--disable-blink-features=AutomationControlled")
        opt.add_argument("--no-first-run")
        opt.add_argument("--no-default-browser-check")
        opt.add_argument("--disable-infobars")
        opt.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
        opt.add_experimental_option("useAutomationExtension", False)
        opt.add_experimental_option("prefs", {"intl.accept_languages": ",".join(langs)})

    def _launch_chrome(self, profile_path, ua, w, h, tz, langs, fp=None):
        opt = ChromeOptions()
        self._common_opts(opt, profile_path, ua, w, h, langs)
        drv = get_chrome_driver_path()
        driver = webdriver.Chrome(service=ChromeService(drv) if drv else ChromeService(), options=opt)
        self._apply_stealth(driver, fp)
        try: driver.execute_cdp_cmd("Emulation.setTimezoneOverride", {"timezoneId": tz})
        except Exception: pass
        return driver

    def _launch_edge(self, profile_path, ua, w, h, tz, langs, fp=None):
        opt = EdgeOptions()
        self._common_opts(opt, profile_path, ua, w, h, langs)
        drv = get_edge_driver_path()
        driver = webdriver.Edge(service=EdgeService(drv) if drv else EdgeService(), options=opt)
        self._apply_stealth(driver, fp)
        try: driver.execute_cdp_cmd("Emulation.setTimezoneOverride", {"timezoneId": tz})
        except Exception: pass
        return driver

    def _launch_yandex(self, profile_path, ua, w, h, tz, langs, fp=None):
        opt = ChromeOptions()
        self._common_opts(opt, profile_path, ua, w, h, langs)
        yp = self.get_yandex_path()
        if not yp:
            raise FileNotFoundError("Яндекс Браузер не найден. Установи его.")
        opt.binary_location = yp
        drv = get_chrome_driver_path()
        driver = webdriver.Chrome(service=ChromeService(drv) if drv else ChromeService(), options=opt)
        self._apply_stealth(driver, fp)
        try: driver.execute_cdp_cmd("Emulation.setTimezoneOverride", {"timezoneId": tz})
        except Exception: pass
        return driver

    def _launch_firefox(self, profile_path, ua, langs=None):
        if langs is None: langs = ["ru-RU", "ru"]
        opt = FirefoxOptions()
        opt.add_argument("-profile"); opt.add_argument(profile_path)
        opt.set_preference("general.useragent.override", ua)
        opt.set_preference("dom.webdriver.enabled", False)
        opt.set_preference("useAutomationExtension", False)
        opt.set_preference("intl.accept_languages", ",".join(langs))
        drv = get_gecko_driver_path()
        return webdriver.Firefox(service=FirefoxService(drv) if drv else FirefoxService(), options=opt)


if __name__ == "__main__":
    bm   = BrowserManager()
    args = sys.argv[1:]

    if not args:
        print("Usage: engine.py <url> <profile> <browser>")
        sys.exit(0)

    if args[0].upper() == "CREATE":
        path = os.path.join(bm.p_dir, args[1] if len(args) > 1 else "default")
        os.makedirs(path, exist_ok=True)
        print(f"[engine] Profile created: {path}")

    elif args[0].upper() == "LIST":
        profiles = [d for d in os.listdir(bm.p_dir) if os.path.isdir(os.path.join(bm.p_dir, d))]
        print("[engine] Profiles:", profiles)

    else:
        url    = args[0] if len(args) > 0 else "about:blank"
        name   = args[1] if len(args) > 1 else "default"
        b_type = args[2] if len(args) > 2 else "chrome"

        if b_type.lower() == "app":
            try: os.startfile(url)
            except AttributeError: subprocess.Popen([url], shell=True)
            sys.exit(0)

        bm.start_browser(url=url, name=name, b_type=b_type)
