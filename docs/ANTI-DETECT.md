# Artofix 2.3.1 — система антидетекта и работа с капчей

Коротко: раньше отпечаток **генерировался случайно при каждом запуске** и часть
векторов (Client Hints, железо, медиакодеки, шрифты, разрешения, следы ChromeDriver)
не закрывалась вовсе. Теперь отпечаток **детерминированно привязан к профилю**,
согласован между всеми API и применяется до первой навигации.

---

## 1. Как это работает

```
UI (app.js)                main (main.js)                     browser (engine.py)
───────────                ──────────────                     ───────────────────
выбор профиля  ──────►  rollIdentity(profile, browser)
                        ├─ seed = installId + profile + salt
                        ├─ версия браузера из реестра
                        ├─ GPU / TZ / экран / железо / шрифты
                        ├─ validateIdentity() → leak-check
                        └─ config.json.identity (схема v2)
                                     │
                                     ├─ CDP: UA + Client Hints, TZ, локаль,
                                     │        метрики экрана, ядра CPU, гео
                                     └─ page-init (до навигации):
                                              WebGL, canvas, audio, кодеки,
                                              шрифты, разрешения, WebRTC,
                                              следы автоматизации
                                     │
                        human_warmup(): движение мыши, прокрутка, паузы
```

Один источник правды — `fingerprint-identity.js`. `engine.py` значения только
применяет, поэтому предпросмотр в UI («👁 Предпросмотр отпечатка») показывает
ровно то, что увидит сайт.

## 2. Ключевые принципы

**Стабильность, а не случайность.** `seed = sha256(installId | profile | browser | salt)`.
Профиль «yt» на этом ПК всегда получает одну и ту же RTX 3060, тот же canvas-шум и ту же
зону — как реальный компьютер. Меняющийся между запусками отпечаток сам по себе
является сильным признаком автоматизации (и его ловят почти все антибот-системы).

**Согласованность.** Все поля выводятся из одного «железа»:
* класс GPU ↔ лимиты WebGL (`MAX_TEXTURE_SIZE`, `MAX_VERTEX_UNIFORM_VECTORS`, …),
* версия установленного Chrome ↔ `User-Agent` ↔ `navigator.userAgentData.brands` ↔ `sec-ch-ua`,
* часовой пояс ↔ `navigator.language(s)` ↔ `Accept-Language` (с учётом диаспор: `ru-RU` + `Asia/Tbilisi` — валидно),
* экран ↔ размер окна ↔ `devicePixelRatio` ↔ `screen.availHeight` (окно не больше экрана),
* `hardwareConcurrency` ↔ объём памяти.

**Никаких невозможных значений.** Например, `navigator.getBattery()` в Chrome не
существует с версии 103 — его подделка мгновенно выдаёт бота, поэтому батарея не
эмулируется вовсе. `gl.getParameter(gl.VENDOR)` в живом Chrome равно `"WebKit"`,
`RENDERER` — `"WebKit WebGL"`; подменяются только `UNMASKED_*` (как это делают
Multilogin/GoLogin и как их читают антибот-скрипты).

## 3. Векторы и способы подмены

| Вектор | Как применяется |
|--------|-----------------|
| User-Agent + Client Hints | CDP `Network.setUserAgentOverride` c `userAgentMetadata` (brands, fullVersionList, platform, bitness) — совпадает и в JS, и в заголовках |
| Платформа | `navigator.platform = "Win32"`, `userAgentData.platform = "Windows"` |
| Часовой пояс | CDP `Emulation.setTimezoneOverride` |
| Языки/локаль | CDP `Emulation.setLocaleOverride` + `--lang` + `intl.accept_languages` |
| Экран/окно | CDP `Emulation.setDeviceMetricsOverride` (screenWidth/Height, devicePixelRatio) + патчи `screen.*`, `outerWidth/Height` |
| Железо | CDP `Emulation.setHardwareConcurrencyOverride` + патчи `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints` |
| WebGL | патч `getParameter` для `0x9245/0x9246` + лимиты по классу GPU; списки расширений дополняются `WEBGL_debug_renderer_info` |
| Canvas | детерминированный шум младших битов в 12 точках для `getImageData`/`toDataURL`/`toBlob`; canvas восстанавливается после чтения |
| Audio | стабильный сдвиг `AnalyserNode.getFloatFrequencyData`/`getByteFrequencyData` |
| Медиакодеки | согласованные ответы `canPlayType` и `MediaSource.isTypeSupported` |
| Шрифты | `document.fonts.check` согласован с системным набором Windows |
| Разрешения | `Permissions.query` и `Notification.permission` не противоречат друг другу |
| WebRTC | `--webrtc-ip-handling-policy=default_public_interface_only` (при прокси) + фильтрация приватных ICE-кандидатов |
| Прокси профиля | `--proxy-server` + генерируемое MV3-расширение для логина/пароля (пароль приходит только через переменную окружения) |

## 4. Скрытие автоматизации

* `--disable-blink-features=AutomationControlled`, `excludeSwitches: ['enable-automation','enable-logging']`, `useAutomationExtension: false`.
* `navigator.webdriver` → `false` (свойство удаляется из прототипа и переопределяется геттером).
* Переменные ChromeDriver (`cdc_…`, `$cdc_…`) вычищаются из `window` и `document` — классическая проверка `Detected_by_chromedriver`.
* Добавляется правдоподобный `chrome.runtime` (в автоматизированном Chrome его нет, в обычном — есть).
* `credentials_enable_service`/`profile.password_manager_enabled` включаются обратно (Selenium выключает их по умолчанию — это заметный след).
* **Маскировка патчей**: все подменённые функции регистрируются в `WeakMap`, `Function.prototype.toString` возвращает для них `function getParameter() { [native code] }` — детекторы вида «функция переопределена» не срабатывают (проверено тестом `tests/pageinit.test.js`).

## 5. Человекоподобное поведение

Капчи (reCAPTCHA v3, hCaptcha, Turnstile) оценивают не только отпечаток, но и
взаимодействие. После навигации выполняется `human_warmup()`:
* курсор движется по кривой с easing (smoothstep), десятками мелких шагов через CDP `Input.dispatchMouseEvent`;
* лёгкая прокрутка колесом вниз/вверх с рандомными паузами;
* паузы рандомизированы (`human_pause`).

Отключается флагом `"behavior": { "humanize": false }` в `config.json`.

## 6. Что реально влияет на прохождение капчи (по важности)

1. **IP-репутация и прокси** — главный фактор. Датацентр-IP сдаёт капчу
   «запрос подтверждения» независимо от идеального отпечатка. Ставьте резидентский
   прокси в мета профиля (`proxy.server`, `proxy.username`, `proxy.password`).
2. **Один профиль = один аккаунт = один IP.** Не смешивайте.
3. **Согласованность отпечатка** (см. §2) — вторая по важности.
4. **Следы автоматизации** (§4) — быстрый способ провалить проверку.
5. **Поведение** (§5) — без событий мыши score у v3 падает заметно.

## 7. Приватность

`canvas_noise` одинаков внутри профиля (иначе — признак подделки), но уникален
для каждого профиля: два профиля одного ПК не «склеиваются» в одну личность.
Между разными установками Artofix отпечатки тоже не совпадают (разный `installId`,
файл `.artofix_install_id` рядом с программой).

Смена личности профиля: кнопка «🎲 Новый отпечаток» в карточке Fingerprint →
в `_artofix_meta.json` пишется `fingerprint_refresh`, и seed меняется. Полезно
после смены прокси или при подозрении на «залипание» идентификатора.

## 8. Что не входит в систему и почему

* **Отпечатки TLS/JA3/JA4** — задаются сетевой библиотекой браузера, а не JS.
  Artofix использует настоящий Chrome/Edge/Яндекс.Браузер (не headless, не
  пересобранный Chromium), поэтому JA3 совпадает с обычным пользователем.
  Если бы мы патчили бинарник, пришлось бы подделывать и это.
* **Подмена `Geolocation`** — включается только если у профиля заданы координаты
  (`geolocation: {lat, lon}`); иначе лучше не выдумывать гео, не совпадающее с IP.
* **Headless-режим** — намеренно не используется: он даёт десятки дополнительных
  признаков (media-кодеки, шрифты, GPU), которые невозможно закрыть полностью.
