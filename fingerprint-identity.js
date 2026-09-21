'use strict';
/* =============================================================
   ARTOFIX 2.3 — FINGERPRINT IDENTITY
   -------------------------------------------------------------
   Генерация «личности» браузера. Один источник правды:
     • main-процесс (этот модуль) считает отпечаток и кладёт его
       в config.json;
     • engine.py (Python) читает config.json и применяет значения
       к реальному браузеру через CDP + page-init скрипт.

   Ключевые принципы (важно для антидетекта):
     1. СТАБИЛЬНОСТЬ на профиль. seed детерминирован от имени
        профиля + ID установки, поэтому при каждом запуске профиль
        получает тот же отпечаток (как реальный ПК пользователя).
        Рандомизация на каждом старте — сама по себе признак бота.
     2. СОГЛАСОВАННОСТЬ. Все поля выводятся из одного «железа»:
        GPU ↔ WebGL limits, версия Chrome ↔ UA ↔ UA-CH brands,
        TZ ↔ язык ↔ гео, экран ↔ окно ↔ devicePixelRatio.
     3. ОТСУТСТВИЕ НЕВОЗМОЖНЫХ ЗНАЧЕНИЙ. Не выдаём то, чего нет
        в живом Chrome (battery-API после 103, WebRTC-локальные IP
        при прокси и т.п.).

   Все банки значений — реальные связки, снятые с живых машин:
   смена vendor без renderer и без лимитов GPU палится на первом
   же запросе WEBGL_debug_renderer_info.
   ============================================================= */

const crypto = require('crypto');

// ─────────────────────────────────────────────
//  БАНКИ ДАННЫХ
// ─────────────────────────────────────────────

/** tier нужен, чтобы лимиты GPU (MAX_TEXTURE_SIZE и т.п.) совпадали с классом карты. */
const GPU_BANK = [
  { vendor: 'Google Inc. (NVIDIA)', unmasked: 'NVIDIA Corporation', tier: 'high',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', unmasked: 'NVIDIA Corporation', tier: 'high',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', unmasked: 'NVIDIA Corporation', tier: 'mid',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', unmasked: 'ATI Technologies Inc.', tier: 'high',
    renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', unmasked: 'ATI Technologies Inc.', tier: 'mid',
    renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', unmasked: 'Intel Inc.', tier: 'low',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', unmasked: 'Intel Inc.', tier: 'low',
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', unmasked: 'Intel Inc.', tier: 'low',
    renderer: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

/** Лимиты WebGL по классу GPU — их сверяют антибот-скрипты. */
const GPU_LIMITS = {
  high: {
    MAX_TEXTURE_SIZE: 32768, MAX_RENDERBUFFER_SIZE: 32768, MAX_VIEWPORT_DIMS: [32768, 32768],
    MAX_VERTEX_UNIFORM_VECTORS: 4096, MAX_FRAGMENT_UNIFORM_VECTORS: 4096,
    MAX_VARYING_VECTORS: 32, MAX_VERTEX_ATTRIBS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
    MAX_CUBE_MAP_TEXTURE_SIZE: 32768, MAX_TEXTURE_IMAGE_UNITS: 32,
  },
  mid: {
    MAX_TEXTURE_SIZE: 16384, MAX_RENDERBUFFER_SIZE: 16384, MAX_VIEWPORT_DIMS: [16384, 16384],
    MAX_VERTEX_UNIFORM_VECTORS: 4096, MAX_FRAGMENT_UNIFORM_VECTORS: 4096,
    MAX_VARYING_VECTORS: 32, MAX_VERTEX_ATTRIBS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
    MAX_CUBE_MAP_TEXTURE_SIZE: 16384, MAX_TEXTURE_IMAGE_UNITS: 16,
  },
  low: {
    MAX_TEXTURE_SIZE: 16384, MAX_RENDERBUFFER_SIZE: 16384, MAX_VIEWPORT_DIMS: [16384, 16384],
    MAX_VERTEX_UNIFORM_VECTORS: 1024, MAX_FRAGMENT_UNIFORM_VECTORS: 1024,
    MAX_VARYING_VECTORS: 30, MAX_VERTEX_ATTRIBS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
    MAX_CUBE_MAP_TEXTURE_SIZE: 16384, MAX_TEXTURE_IMAGE_UNITS: 16,
  },
};

/* ─────────────────────────────────────────────
   СТРАНЫ: единая связка «страна → локаль → зона → город → координаты».

   Антидетект по стране НЕ требует VPN-слоя процесса: сайты судят о стране
   пользователя по браузерным сигналам — IANA-зоне, Accept-Language/ua-full
   локали, а если сайту дали доступ к геопозиции — по координатам. Всё это
   применяется через CDP (а не системный VPN): Emulation.setTimezoneOverride,
   setLocaleOverride, setGeolocationOverride + --lang и intl.accept_languages.
   Единственное, что браузерными средствами не поменять, — выходной IP:
   поэтому IP-совпадение остаётся на прокси профиля (см. UI-подсказку).

   Каждая зона: { tz, city, lat, lon, r } — город-«якорь» и радиус (в градусах),
   внутри которого профиль получает СТАБИЛЬНУЮ случайную точку: два профиля
   одной страны живут в разных местах (не «склеиваются»), а один профиль не
   «прыгает» по городу между запусками.
   ───────────────────────────────────────────── */
const COUNTRIES = [
  { code: 'RU', name: 'Россия',        flag: '🇷🇺', region: 'Europe',  currency: 'RUB', weekStart: 1,
    langs: ['ru-RU', 'ru', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Moscow',        city: 'Москва',        lat: 55.7558, lon: 37.6173,  r: 0.28 },
      { tz: 'Europe/Moscow',        city: 'Санкт-Петербург', lat: 59.9343, lon: 30.3351, r: 0.20 },
      { tz: 'Europe/Samara',        city: 'Самара',        lat: 53.1959, lon: 50.1002,  r: 0.18 },
      { tz: 'Asia/Yekaterinburg',   city: 'Екатеринбург',  lat: 56.8389, lon: 60.6057,  r: 0.20 },
      { tz: 'Asia/Novosibirsk',     city: 'Новосибирск',   lat: 55.0084, lon: 82.9357,  r: 0.18 },
    ] },
  { code: 'UA', name: 'Украина',       flag: '🇺🇦', region: 'Europe',  currency: 'UAH', weekStart: 1,
    langs: ['uk-UA', 'uk', 'ru-RU', 'ru', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Kyiv',          city: 'Киев',          lat: 50.4501, lon: 30.5234,  r: 0.18 },
      { tz: 'Europe/Kyiv',          city: 'Харьков',       lat: 49.9935, lon: 36.2304,  r: 0.14 },
    ] },
  { code: 'BY', name: 'Беларусь',      flag: '🇧🇾', region: 'Europe',  currency: 'BYN', weekStart: 1,
    langs: ['be-BY', 'be', 'ru-RU', 'ru', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Minsk',   city: 'Минск',         lat: 53.9045, lon: 27.5615,  r: 0.16 }] },
  { code: 'KZ', name: 'Казахстан',     flag: '🇰🇿', region: 'Asia',    currency: 'KZT', weekStart: 1,
    langs: ['ru-RU', 'ru', 'kk-KZ', 'kk', 'en-US', 'en'],
    zones: [
      { tz: 'Asia/Almaty',          city: 'Алматы',        lat: 43.2380, lon: 76.9450,  r: 0.16 },
      { tz: 'Asia/Almaty',          city: 'Астана',        lat: 51.1694, lon: 71.4491,  r: 0.16 },
    ] },
  { code: 'GE', name: 'Грузия',        flag: '🇬🇪', region: 'Asia',    currency: 'GEL', weekStart: 1,
    langs: ['ru-RU', 'ru', 'ka-GE', 'ka', 'en-US', 'en'],
    zones: [{ tz: 'Asia/Tbilisi',   city: 'Тбилиси',       lat: 41.7151, lon: 44.8271,  r: 0.12 }] },
  { code: 'AM', name: 'Армения',       flag: '🇦🇲', region: 'Asia',    currency: 'AMD', weekStart: 1,
    langs: ['ru-RU', 'ru', 'hy-AM', 'hy', 'en-US', 'en'],
    zones: [{ tz: 'Asia/Yerevan',   city: 'Ереван',        lat: 40.1872, lon: 44.5152,  r: 0.10 }] },
  { code: 'AZ', name: 'Азербайджан',   flag: '🇦🇿', region: 'Asia',    currency: 'AZN', weekStart: 1,
    langs: ['ru-RU', 'ru', 'az-AZ', 'az', 'en-US', 'en'],
    zones: [{ tz: 'Asia/Baku',      city: 'Баку',          lat: 40.4093, lon: 49.8671,  r: 0.12 }] },
  { code: 'KG', name: 'Киргизия',      flag: '🇰🇬', region: 'Asia',    currency: 'KGS', weekStart: 1,
    langs: ['ru-RU', 'ru', 'ky-KG', 'ky', 'en-US', 'en'],
    zones: [{ tz: 'Asia/Bishkek',   city: 'Бишкек',        lat: 42.8746, lon: 74.5698,  r: 0.12 }] },
  { code: 'UZ', name: 'Узбекистан',    flag: '🇺🇿', region: 'Asia',    currency: 'UZS', weekStart: 1,
    langs: ['ru-RU', 'ru', 'uz-UZ', 'uz', 'en-US', 'en'],
    zones: [{ tz: 'Asia/Tashkent',  city: 'Ташкент',       lat: 41.2995, lon: 69.2401,  r: 0.16 }] },
  { code: 'TR', name: 'Турция',        flag: '🇹🇷', region: 'Asia',    currency: 'TRY', weekStart: 1,
    langs: ['tr-TR', 'tr', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Istanbul',      city: 'Стамбул',       lat: 41.0082, lon: 28.9784,  r: 0.20 },
      { tz: 'Europe/Istanbul',      city: 'Анкара',        lat: 39.9334, lon: 32.8597,  r: 0.16 },
    ] },
  { code: 'DE', name: 'Германия',      flag: '🇩🇪', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['de-DE', 'de', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Berlin',        city: 'Берлин',        lat: 52.5200, lon: 13.4050,  r: 0.16 },
      { tz: 'Europe/Berlin',        city: 'Гамбург',       lat: 53.5511, lon: 9.9937,   r: 0.12 },
      { tz: 'Europe/Berlin',        city: 'Мюнхен',        lat: 48.1351, lon: 11.5820,  r: 0.12 },
      { tz: 'Europe/Berlin',        city: 'Кёльн',         lat: 50.9375, lon: 6.9603,   r: 0.10 },
    ] },
  { code: 'NL', name: 'Нидерланды',    flag: '🇳🇱', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['nl-NL', 'nl', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Amsterdam',     city: 'Амстердам',     lat: 52.3676, lon: 4.9041,   r: 0.10 },
      { tz: 'Europe/Amsterdam',     city: 'Роттердам',     lat: 51.9225, lon: 4.4792,   r: 0.08 },
    ] },
  { code: 'PL', name: 'Польша',        flag: '🇵🇱', region: 'Europe',  currency: 'PLN', weekStart: 1,
    langs: ['pl-PL', 'pl', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Warsaw',        city: 'Варшава',       lat: 52.2297, lon: 21.0122,  r: 0.14 },
      { tz: 'Europe/Warsaw',        city: 'Краков',        lat: 50.0647, lon: 19.9450,  r: 0.10 },
    ] },
  { code: 'CZ', name: 'Чехия',         flag: '🇨🇿', region: 'Europe',  currency: 'CZK', weekStart: 1,
    langs: ['cs-CZ', 'cs', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Prague',  city: 'Прага',         lat: 50.0755, lon: 14.4378,  r: 0.10 }] },
  { code: 'AT', name: 'Австрия',       flag: '🇦🇹', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['de-AT', 'de-DE', 'de', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Vienna',  city: 'Вена',          lat: 48.2082, lon: 16.3738,  r: 0.12 }] },
  { code: 'CH', name: 'Швейцария',     flag: '🇨🇭', region: 'Europe',  currency: 'CHF', weekStart: 1,
    langs: ['de-CH', 'de', 'fr-CH', 'fr', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Zurich',  city: 'Цюрих',         lat: 47.3769, lon: 8.5417,   r: 0.08 }] },
  { code: 'FR', name: 'Франция',       flag: '🇫🇷', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['fr-FR', 'fr', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Paris',         city: 'Париж',         lat: 48.8566, lon: 2.3522,   r: 0.14 },
      { tz: 'Europe/Paris',         city: 'Лион',          lat: 45.7640, lon: 4.8357,   r: 0.10 },
    ] },
  { code: 'IT', name: 'Италия',        flag: '🇮🇹', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['it-IT', 'it', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Rome',          city: 'Рим',           lat: 41.9028, lon: 12.4964,  r: 0.12 },
      { tz: 'Europe/Rome',          city: 'Милан',         lat: 45.4642, lon: 9.1900,   r: 0.10 },
    ] },
  { code: 'ES', name: 'Испания',       flag: '🇪🇸', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['es-ES', 'es', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/Madrid',        city: 'Мадрид',        lat: 40.4168, lon: -3.7038,  r: 0.14 },
      { tz: 'Europe/Madrid',        city: 'Барселона',     lat: 41.3874, lon: 2.1686,   r: 0.10 },
    ] },
  { code: 'PT', name: 'Португалия',    flag: '🇵🇹', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['pt-PT', 'pt', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Lisbon',  city: 'Лиссабон',      lat: 38.7223, lon: -9.1393,  r: 0.10 }] },
  { code: 'SE', name: 'Швеция',        flag: '🇸🇪', region: 'Europe',  currency: 'SEK', weekStart: 1,
    langs: ['sv-SE', 'sv', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Stockholm', city: 'Стокгольм',   lat: 59.3293, lon: 18.0686,  r: 0.12 }] },
  { code: 'FI', name: 'Финляндия',     flag: '🇫🇮', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['fi-FI', 'fi', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Helsinki', city: 'Хельсинки',    lat: 60.1699, lon: 24.9384,  r: 0.10 }] },
  { code: 'NO', name: 'Норвегия',      flag: '🇳🇴', region: 'Europe',  currency: 'NOK', weekStart: 1,
    langs: ['nb-NO', 'nb', 'no', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Oslo',    city: 'Осло',          lat: 59.9139, lon: 10.7522,  r: 0.10 }] },
  { code: 'DK', name: 'Дания',          flag: '🇩🇰', region: 'Europe',  currency: 'DKK', weekStart: 1,
    langs: ['da-DK', 'da', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Copenhagen', city: 'Копенгаген', lat: 55.6761, lon: 12.5683,  r: 0.10 }] },
  { code: 'LV', name: 'Латвия',         flag: '🇱🇻', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['lv-LV', 'lv', 'ru-RU', 'ru', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Riga',    city: 'Рига',          lat: 56.9496, lon: 24.1052,  r: 0.08 }] },
  { code: 'LT', name: 'Литва',          flag: '🇱🇹', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['lt-LT', 'lt', 'ru-RU', 'ru', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Vilnius', city: 'Вильнюс',       lat: 54.6872, lon: 25.2797,  r: 0.08 }] },
  { code: 'EE', name: 'Эстония',        flag: '🇪🇪', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['et-EE', 'et', 'ru-RU', 'ru', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Tallinn', city: 'Таллинн',       lat: 59.4370, lon: 24.7536,  r: 0.07 }] },
  { code: 'GB', name: 'Великобритания', flag: '🇬🇧', region: 'Europe',  currency: 'GBP', weekStart: 1,
    langs: ['en-GB', 'en-US', 'en'],
    zones: [
      { tz: 'Europe/London',        city: 'Лондон',        lat: 51.5074, lon: -0.1278,  r: 0.16 },
      { tz: 'Europe/London',        city: 'Манчестер',     lat: 53.4808, lon: -2.2426,  r: 0.10 },
    ] },
  { code: 'IE', name: 'Ирландия',       flag: '🇮🇪', region: 'Europe',  currency: 'EUR', weekStart: 1,
    langs: ['en-IE', 'en-US', 'en'],
    zones: [{ tz: 'Europe/Dublin',  city: 'Дублин',        lat: 53.3498, lon: -6.2603,  r: 0.08 }] },
  { code: 'US', name: 'США',            flag: '🇺🇸', region: 'America', currency: 'USD', weekStart: 0,
    langs: ['en-US', 'en'],
    zones: [
      { tz: 'America/New_York',     city: 'Нью-Йорк',      lat: 40.7128, lon: -74.0060, r: 0.16 },
      { tz: 'America/Chicago',      city: 'Чикаго',        lat: 41.8781, lon: -87.6298, r: 0.14 },
      { tz: 'America/Denver',       city: 'Денвер',        lat: 39.7392, lon: -104.9903, r: 0.12 },
      { tz: 'America/Los_Angeles',  city: 'Лос-Анджелес',  lat: 34.0522, lon: -118.2437, r: 0.14 },
      { tz: 'America/Los_Angeles',  city: 'Сан-Франциско', lat: 37.7749, lon: -122.4194, r: 0.10 },
    ] },
  { code: 'CA', name: 'Канада',         flag: '🇨🇦', region: 'America', currency: 'CAD', weekStart: 0,
    langs: ['en-CA', 'en-US', 'en'],
    zones: [
      { tz: 'America/Toronto',      city: 'Торонто',       lat: 43.6532, lon: -79.3832, r: 0.12 },
      { tz: 'America/Vancouver',    city: 'Ванкувер',      lat: 49.2827, lon: -123.1207, r: 0.10 },
    ] },
  { code: 'BR', name: 'Бразилия',       flag: '🇧🇷', region: 'America', currency: 'BRL', weekStart: 0,
    langs: ['pt-BR', 'pt', 'en-US', 'en'],
    zones: [{ tz: 'America/Sao_Paulo', city: 'Сан-Паулу',  lat: -23.5505, lon: -46.6333, r: 0.18 }] },
  { code: 'AR', name: 'Аргентина',      flag: '🇦🇷', region: 'America', currency: 'ARS', weekStart: 0,
    langs: ['es-AR', 'es', 'en-US', 'en'],
    zones: [{ tz: 'America/Argentina/Buenos_Aires', city: 'Буэнос-Айрес', lat: -34.6037, lon: -58.3816, r: 0.14 }] },
  { code: 'MX', name: 'Мексика',        flag: '🇲🇽', region: 'America', currency: 'MXN', weekStart: 0,
    langs: ['es-MX', 'es', 'en-US', 'en'],
    zones: [{ tz: 'America/Mexico_City', city: 'Мехико',   lat: 19.4326, lon: -99.1332, r: 0.14 }] },
  { code: 'IN', name: 'Индия',          flag: '🇮🇳', region: 'Asia',    currency: 'INR', weekStart: 0,
    langs: ['en-IN', 'en', 'hi-IN', 'hi', 'en-US'],
    zones: [
      { tz: 'Asia/Kolkata',         city: 'Мумбаи',        lat: 19.0760, lon: 72.8777,  r: 0.14 },
      { tz: 'Asia/Kolkata',         city: 'Дели',          lat: 28.7041, lon: 77.1025,  r: 0.12 },
    ] },
  { code: 'JP', name: 'Япония',         flag: '🇯🇵', region: 'Asia',    currency: 'JPY', weekStart: 0,
    langs: ['ja-JP', 'ja', 'en-US', 'en'],
    zones: [
      { tz: 'Asia/Tokyo',           city: 'Токио',         lat: 35.6762, lon: 139.6503, r: 0.14 },
      { tz: 'Asia/Tokyo',           city: 'Осака',         lat: 34.6937, lon: 135.5023, r: 0.10 },
    ] },
  { code: 'KR', name: 'Южная Корея',    flag: '🇰🇷', region: 'Asia',    currency: 'KRW', weekStart: 0,
    langs: ['ko-KR', 'ko', 'en-US', 'en'],
    zones: [{ tz: 'Asia/Seoul',     city: 'Сеул',          lat: 37.5665, lon: 126.9780, r: 0.10 }] },
  { code: 'SG', name: 'Сингапур',       flag: '🇸🇬', region: 'Asia',    currency: 'SGD', weekStart: 0,
    langs: ['en-SG', 'en-US', 'en', 'zh-SG', 'zh'],
    zones: [{ tz: 'Asia/Singapore', city: 'Сингапур',      lat: 1.3521,  lon: 103.8198, r: 0.05 }] },
  { code: 'AE', name: 'ОАЭ',            flag: '🇦🇪', region: 'Asia',    currency: 'AED', weekStart: 0,
    langs: ['ar-AE', 'ar', 'en-US', 'en'],
    zones: [{ tz: 'Asia/Dubai',     city: 'Дубай',         lat: 25.2048, lon: 55.2708,  r: 0.08 }] },
  { code: 'AU', name: 'Австралия',      flag: '🇦🇺', region: 'Australia', currency: 'AUD', weekStart: 0,
    langs: ['en-AU', 'en-US', 'en'],
    zones: [
      { tz: 'Australia/Sydney',     city: 'Сидней',        lat: -33.8688, lon: 151.2093, r: 0.14 },
      { tz: 'Australia/Melbourne',  city: 'Мельбурн',      lat: -37.8136, lon: 144.9631, r: 0.12 },
    ] },
];

const COUNTRY_BY_CODE = {};
const CURRENCY_BY_CC = {};
COUNTRIES.forEach((c) => { COUNTRY_BY_CODE[c.code] = c; CURRENCY_BY_CC[c.code] = c.currency; });

function getCountry(code) { return COUNTRY_BY_CODE[String(code || '').trim().toUpperCase()] || null; }

/** Список для UI-селектора: только то, что нужно отрисовать (без координат). */
function listCountries() {
  return COUNTRIES.map((c) => ({
    code: c.code, name: c.name, flag: c.flag, region: c.region,
    currency: c.currency, cities: c.zones.length,
  }));
}

/**
 * Локаль ↔ TZ ↔ гео: несовпадение (язык ru, зона America/New_York) — прямой
 * флаг бота. Таблица выводится из COUNTRIES, поэтому любая случайная связка
 * согласована по построению. geo здесь всегда null — координаты выдаются
 * только при ЯВНОМ выборе страны (docs/ANTI-DETECT.md §8: не выдумывать гео,
 * не совпадающее с выходным IP).
 */
const LOCALES = [];
COUNTRIES.forEach((country) => {
  country.zones.forEach((z) => {
    LOCALES.push({
      tz: z.tz,
      lang: country.langs[0],
      langs: country.langs.slice(),
      geo: null,
      country: country.code,
      anchor: { lat: z.lat, lon: z.lon, r: z.r },
    });
  });
});

/** Популярные разрешения с частотой, как в реальной статистике. */
const SCREENS = [
  { w: 1920, h: 1080, weight: 6 }, { w: 2560, h: 1440, weight: 2 },
  { w: 1536, h: 864,  weight: 3 }, { w: 1440, h: 900,  weight: 2 },
  { w: 1366, h: 768,  weight: 3 }, { w: 1600, h: 900,  weight: 1 },
  { w: 1280, h: 800,  weight: 1 }, { w: 3840, h: 2160, weight: 1 },
];

/** Парк «железа»: ядра/память реально встречающимися парами. */
const HARDWARE = [
  { cores: 4,  memory: 8,  deviceMemory: 8 },
  { cores: 8,  memory: 8,  deviceMemory: 8 },
  { cores: 8,  memory: 16, deviceMemory: 8 },
  { cores: 12, memory: 16, deviceMemory: 8 },
  { cores: 16, memory: 32, deviceMemory: 8 },
  { cores: 6,  memory: 16, deviceMemory: 8 },
  { cores: 2,  memory: 4,  deviceMemory: 4 },
];

/** Шрифты Windows 10/11 (Chromium их видит побайтово одинаково на всех таких ПК). */
const FONTS_WIN = [
  'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola',
  'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console',
  'Lucida Sans Unicode', 'Malgun Gothic', 'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei',
  'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le',
  'Microsoft YaHei', 'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MV Boli', 'Myanmar Text',
  'Nirmala UI', 'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script',
  'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol', 'SimSun', 'Sitka',
  'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings',
  'Wingdings', 'Yu Gothic',
];

// ─────────────────────────────────────────────
//  ДЕТЕРМИНИРОВАННЫЙ ГПСЧ
// ─────────────────────────────────────────────
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function seedFrom(str) { return parseInt(sha256(str).slice(0, 12), 16) >>> 0; }

/** mulberry32 — детерминированный, быстрый, без внешних зависимостей. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function pickWeighted(rng, arr, weightKey) {
  const total = arr.reduce((s, x) => s + (x[weightKey] || 1), 0);
  let r = rng() * total;
  for (const item of arr) { r -= (item[weightKey] || 1); if (r <= 0) return item; }
  return arr[arr.length - 1];
}
function intBetween(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }

// ─────────────────────────────────────────────
//  UA / UA-CH
// ─────────────────────────────────────────────
/** Порядок brands в UA-CH у Chrome фиксирован и менялся по версиям. */
function buildBrands(chromeMajor) {
  const v = String(chromeMajor);
  // «Not)A;Brand» появился с Chrome 113 и ступенчато меняет разделитель.
  const grease = 'Not)A;Brand';
  const order = chromeMajor >= 120
    ? [[grease, '99'], ['Chromium', v], ['Google Chrome', v]]
    : [[grease, '99'], ['Chromium', v], ['Google Chrome', v]];
  return order.map(([brand, version]) => ({ brand, version }));
}

function isEdgeUA(browser) { return browser === 'msedge'; }

function buildUserAgent(browser, version, platformString) {
  const major = String(version).split('.')[0];
  if (browser === 'msedge') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
         + 'Chrome/' + major + '.0.0.0 Safari/537.36 Edg/' + major + '.0.0.0';
  }
  if (browser === 'firefox') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:' + major + '.0) Gecko/20100101 Firefox/' + major + '.0';
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
       + 'Chrome/' + major + '.0.0.0 Safari/537.36';
}

/**
 * @param {string} profileName   имя профиля (стабильность отпечатка)
 * @param {string} installId     ID установки (чтобы профили разных ПК не совпадали)
 * @param {object} opts          {browser, browserVersion, resolution, spoof, overrides, country}
 *   opts.country — ISO-код страны ('DE', 'US', …): локаль, зона и гео-точка
 *   берутся только из этой страны и координаты эмулируются (CDP). Без кода —
 *   случайная согласованная связка, гео не трогаем (см. COUNTRIES выше).
 */
function generateIdentity(profileName, installId, opts) {
  opts = opts || {};
  const browser = opts.browser || 'chrome';
  const salt = opts.identitySalt ? '|' + String(opts.identitySalt).slice(0, 32) : '';
  const identitySeed = seedFrom('artofix|' + installId + '|' + profileName + '|' + browser + salt);
  const rng = makeRng(identitySeed);

  const country = opts.country ? getCountry(opts.country) : null;

  const gpu    = pick(rng, GPU_BANK);
  const locale = country
    ? pick(rng, LOCALES.filter((l) => l.country === country.code))
    : pick(rng, LOCALES);
  const screen = pickWeighted(rng, SCREENS, 'weight');
  const hw     = pick(rng, HARDWARE);

  // Версия браузера — только реально установленная (иначе UA разойдётся
  // с тем, что отдаёт настоящий бинарник в Client Hints).
  const realVersion = opts.browserVersion || null;
  const chromeMajor = realVersion ? parseInt(String(realVersion).split('.')[0], 10) : 131;
  const fullVersion = realVersion || (chromeMajor + '.0.6778.86');

  const win = { w: screen.w, h: screen.h };
  // Окно всегда меньше экрана на панели задач/хром — иначе «экранов» не бывает.
  const winW = win.w - intBetween(rng, 0, 60);
  const winH = win.h - intBetween(rng, 80, 160);
  const scale = screen.w >= 2560 ? pick(rng, [1, 1.25, 1.5]) : 1;

  const ua = buildUserAgent(browser, fullVersion, 'Windows NT 10.0; Win64; x64');

  /* Гео-точка профиля. Ток rng берётся из ОТДЕЛЬНОГО потока (не из общего rng),
     чтобы включение/выключение выбора страны не сдвигало остальные векторы
     (canvas-шум, экран, железо) — иначе у того же профиля «уедет» всё железо.
     Джиттер в радиусе города: профиль стабильно живёт в одной точке, но два
     профиля одной страны не сидят в одинаковых координатах (анти-«склейка»). */
  let geoLocation = null;
  let geoCity = null;
  if (country) {
    const geoRng = makeRng((identitySeed ^ 0x9e3779b9) >>> 0);
    const zone = country.zones.filter((z) => z.tz === locale.tz)[0] || country.zones[0];
    const jitterDeg = () => (geoRng() - 0.5) * 2 * zone.r;
    geoLocation = {
      lat: +(zone.lat + jitterDeg()).toFixed(6),
      lon: +(zone.lon + jitterDeg()).toFixed(6),
      accuracy: intBetween(geoRng, 32, 120),
    };
    geoCity = zone.city;
  }

  const identity = {
    schema: 2,
    profile: profileName,
    browser,
    seed: identitySeed.toString(16),
    seed_source: opts.identitySalt ? 'profile+install+rotated' : 'profile+install',

    // ── UA / UA-CH ──
    user_agent: ua,
    ua_full_version: fullVersion,
    ua_major: String(chromeMajor),
    ua_platform: browser === 'firefox' ? 'Windows' : 'Windows',
    ua_platform_version: '10.0.0',
    ua_architecture: 'x86',
    ua_bitness: '64',
    ua_model: '',
    ua_mobile: false,
    brands: browser === 'firefox' ? [] : buildBrands(chromeMajor),
    ua_brands_edge: isEdgeUA(browser)
      ? [{ brand: 'Microsoft Edge', version: String(chromeMajor) }, { brand: 'Chromium', version: String(chromeMajor) }]
      : null,

    // ── гео/локаль ──
    timezone: locale.tz,
    timezone_offset_known: true,
    lang: locale.lang,
    languages: locale.langs.slice(),
    accept_language: locale.langs.join(','),
    geolocation: geoLocation,
    geo_source: country ? 'country' : 'none',
    country_code: locale.country || null,
    country_name: country ? country.name : null,
    country_flag: country ? country.flag : null,
    country_city: country ? geoCity : null,
    region: String(locale.tz).split('/')[0],
    currency: country ? country.currency : CURRENCY_BY_CC[locale.country] || null,
    week_start: country ? country.weekStart : (COUNTRY_BY_CODE[locale.country] || {}).weekStart || 1,

    // ── GPU ──
    webgl: {
      vendor: gpu.vendor,
      renderer: gpu.renderer,
      // в живом Chrome UNMASKED_VENDOR_WEBGL = «Google Inc. (NVIDIA)»,
      // а UNMASKED_RENDERER_WEBGL = строка ANGLE(...) целиком
      unmasked_vendor: gpu.vendor,
      unmasked_renderer: gpu.renderer,
      tier: gpu.tier,
      limits: GPU_LIMITS[gpu.tier],
    },

    // ── экран ──
    screen: {
      width: screen.w, height: screen.h,
      avail_width: screen.w, avail_height: screen.h - intBetween(rng, 30, 48),
      color_depth: 24, pixel_depth: 24, device_pixel_ratio: scale,
      window_width: winW, window_height: winH,
      outer_width: winW, outer_height: winH + intBetween(rng, 70, 95),
    },
    resolution: screen.w + ',' + screen.h,

    // ── железо ──
    hardware: { cores: hw.cores, memory: hw.memory, device_memory: hw.deviceMemory, max_touch_points: 0 },

    // ── медиа/шрифты ──
    fonts: FONTS_WIN.slice(),
    media: {
      video: { h264: 'probably', vp8: 'probably', vp9: 'probably', av1: 'probably', hevc: '', theora: '' },
      audio: { aac: 'probably', mp3: 'probably', opus: 'probably', vorbis: 'probably', flac: 'probably', pcm: 'probably' },
      media_source: { 'video/mp4; codecs="avc1.42E01E"': true, 'video/webm; codecs="vp9"': true, 'audio/mpeg': true, 'audio/ogg; codecs="opus"': true },
    },

    // ── прочее, что светится в отпечатке ──
    connection: { effective_type: pick(rng, ['4g', '4g', '4g', '3g']), downlink: 10, rtt: 50, save_data: false },
    permissions: { notifications: 'default', geolocation: opts.geoGranted ? 'granted' : 'prompt', camera: 'prompt', microphone: 'prompt' },
    do_not_track: null,
    pdf_viewer_enabled: true,
    webdriver: false,
    user_agent_data_platform: 'Windows',

    // ── приватность/сеть ──
    webrtc: { mode: opts.proxyServer ? 'public_only' : 'default' },
    proxy: opts.proxyServer ? { server: opts.proxyServer, username: opts.proxyUsername || null } : null,

    // шум для константных векторов (canvas/audio) — стабилен внутри профиля
    canvas_noise: intBetween(rng, 1, 60),
    audio_noise: Number((rng() * 4e-6).toFixed(12)),
    audio_freq_shift: Number((rng() * 8e-5).toFixed(12)),

    generated_at: new Date().toISOString(),
  };

  // прикладные переопределения из настроек UI
  const ov = opts.overrides || {};
  if (ov.user_agent) identity.user_agent = ov.user_agent;
  if (ov.resolution && /^\d{2,5},\d{2,5}$/.test(ov.resolution)) {
    const [w, h] = ov.resolution.split(',').map(Number);
    identity.resolution = ov.resolution;
    identity.screen.width = w; identity.screen.height = h; identity.screen.avail_width = w;
  }
  if (ov.timezone) identity.timezone = ov.timezone;
  if (ov.lang) { identity.lang = ov.lang; identity.languages = ov.lang.split(',').slice(0, 3); }
  if (ov.proxy_server) { identity.proxy = { server: ov.proxy_server, username: ov.proxy_username || null }; identity.webrtc.mode = 'public_only'; }

  reconcileCountry(identity);
  identity.leak_check = validateIdentity(identity);
  return identity;
}

/**
 * После ручных override зоны/языка подчистим ИНФОРМАЦИОННЫЕ поля страны,
 * но только в авто-режиме: если зона больше не принадлежит случайно выбранной
 * связке, не показываем устаревшие код/валюту (иначе превью врёт).
 * При явном выборе страны (geo_source === 'country') конфликт зоны и страны
 * НЕ заметаем под ковёр — пусть leak_check покажет его пользователю.
 */
function reconcileCountry(identity) {
  if (identity.geo_source !== 'country') {
    const cc = identity.country_code && COUNTRY_BY_CODE[identity.country_code];
    if (cc && identity.timezone && !cc.zones.some((z) => z.tz === identity.timezone)) {
      identity.country_code = null;
      identity.country_name = null;
      identity.country_flag = null;
      identity.country_city = null;
      identity.currency = null;
    }
  }
  identity.region = String(identity.timezone || '').split('/')[0] || identity.region;
  return identity;
}

/**
 * Проверка «утечек»: ищем внутренние противоречия отпечатка.
 * Используется и в превью UI, и в тестах.
 */
function validateIdentity(id) {
  const problems = [];
  if (!id || typeof id !== 'object') return { ok: false, problems: ['пустой отпечаток'] };

  // 1. UA ↔ UA-CH
  const uaVersion = (id.user_agent || '').match(/(?:Chrome|Edg|Firefox)\/(\d+)/);
  if (uaVersion && id.ua_major && uaVersion[1] !== String(id.ua_major)) {
    problems.push('версия в User-Agent не совпадает с ua_major');
  }
  if ((id.user_agent || '').includes('Edg/') && !id.ua_brands_edge && id.browser !== 'firefox') {
    problems.push('в UA есть Edg/, но Edge-бренды UA-CH не выставлены');
  }
  if ((id.user_agent || '').includes('Windows') !== (id.ua_platform === 'Windows') && id.browser !== 'firefox') {
    problems.push('платформа в User-Agent расходится с ua_platform');
  }

  // 2. локаль ↔ зона
  // Учитываем диаспоры: ru-RU в Asia/Tbilisi или Asia/Almaty — норма,
  // а вот de-DE с America/New_York — почти наверняка подделка.
  const LANG_CONTINENTS = {
    ru: ['Europe', 'Asia'], uk: ['Europe'], be: ['Europe'], kk: ['Asia'],
    ka: ['Asia'], hy: ['Asia'], az: ['Asia'], ky: ['Asia'], uz: ['Asia'],
    tr: ['Europe', 'Asia'], de: ['Europe'], nl: ['Europe'], pl: ['Europe'],
    cs: ['Europe'], sv: ['Europe'], fi: ['Europe'], nb: ['Europe'],
    da: ['Europe'], lv: ['Europe'], lt: ['Europe'], et: ['Europe'],
    it: ['Europe'], fr: ['Europe'], es: ['Europe', 'America'],
    pt: ['Europe', 'America'], hi: ['Asia'], ja: ['Asia'], ko: ['Asia'],
    zh: ['Asia'], ar: ['Asia'],
    en: null,   // английский глобальный: зона может быть любой
  };
  if (id.timezone && id.lang) {
    const langBase = String(id.lang).split('-')[0];
    const tzRegion = String(id.timezone).split('/')[0];
    const allowed = LANG_CONTINENTS[langBase];
    if (allowed && tzRegion !== 'UTC' && allowed.indexOf(tzRegion) === -1) {
      problems.push('язык (' + id.lang + ') не типичен для зоны ' + id.timezone);
    }
    if (String(id.lang).includes('-') && id.timezone === 'UTC') {
      problems.push('зона UTC при региональной локали');
    }
  }

  // 3. GPU ↔ лимиты
  if (id.webgl && id.webgl.limits) {
    const t = id.webgl.tier;
    if (t !== 'high' && id.webgl.limits.MAX_TEXTURE_SIZE > 16384) {
      problems.push('лимиты GPU не соответствуют классу карты');
    }
    if (/(SwiftShader|llvmpipe|Software)/i.test(id.webgl.renderer || '')) {
      problems.push('в renderer светится программный растеризатор');
    }
    if (!/^(Google|Apple|Intel|ATI|Mozilla|Microsoft)\b/.test(id.webgl.vendor || '')) {
      problems.push('vendor WebGL не в формате реального Chrome');
    }
  }

  // 4. экран ↔ окно
  const s = id.screen || {};
  if (s.width && s.window_width && s.window_width > s.width) problems.push('окно шире экрана');
  if (s.avail_height && s.window_height && s.window_height > s.avail_height + 80) {
    problems.push('высота окна не влезает в рабочую область экрана');
  }
  if (s.device_pixel_ratio && ![1, 1.25, 1.5, 1.75, 2].includes(s.device_pixel_ratio)) {
    problems.push('нестандартный devicePixelRatio');
  }

  // 5. железо
  const hwCores = id.hardware && id.hardware.cores;
  const mem = id.hardware && id.hardware.memory;
  if (hwCores && ![2, 4, 6, 8, 12, 16, 20, 24, 32].includes(hwCores)) problems.push('подозрительное число ядер');
  if (hwCores >= 16 && mem && mem <= 4) problems.push('много ядер при 4 ГБ памяти — нетипично');

  // 6. невозможные API
  if (id.battery) problems.push('battery-API отдаётся, хотя Chrome её удалил — это флаг бота');
  if (id.webdriver === true) problems.push('navigator.webdriver = true');

  // 7. страна: гео ↔ зона ↔ локаль ↔ валюта
  // Проверяется только когда страна выбрана ЯВНО (geo_source === 'country'):
  // в авто-режиме поле country_code информационное, а ручные override зоны/языка
  // из конфига — осознанное действие пользователя, не противоречие системы.
  const cc = id.country_code && COUNTRY_BY_CODE[id.country_code];
  if (cc && id.geo_source === 'country') {
    // зона должна принадлежать этой стране
    if (id.timezone) {
      const zone = cc.zones.filter((z) => z.tz === id.timezone)[0];
      if (!zone) problems.push('зона ' + id.timezone + ' не принадлежит стране ' + id.country_code);
      if (zone && id.geolocation) {
        // точка должна лежать у города-якоря этой страны (с запасом на джиттер)
        const tol = Math.max(zone.r * 2.2, 1.2);
        const dLat = Math.abs(id.geolocation.lat - zone.lat);
        const dLon = Math.abs(id.geolocation.lon - zone.lon);
        if (dLat > tol || dLon > tol) {
          problems.push('гео-' + id.country_code + ' стоит в ' + id.geolocation.lat.toFixed(2)
                        + ',' + id.geolocation.lon.toFixed(2) + ', а не у ' + zone.city);
        }
      }
    }
    // язык должен быть из набора страны (пустой массив = язык не заявлен страной)
    if (id.lang && cc.langs.indexOf(id.lang) === -1 && id.geo_source === 'country') {
      problems.push('язык (' + id.lang + ') не характерен для страны ' + id.country_code);
    }
    if (id.currency && cc.currency !== id.currency) {
      problems.push('валюта ' + id.currency + ' не совпадает со страной ' + id.country_code);
    }
  }
  if (id.geolocation) {
    const g = id.geolocation;
    if (typeof g.lat !== 'number' || Math.abs(g.lat) > 90 || typeof g.lon !== 'number' || Math.abs(g.lon) > 180) {
      problems.push('невозможные координаты геопозиции');
    }
    if (!id.timezone) problems.push('есть геопозиция, но нет зоны — сайт сверит их и спалит несовпадение');
  }
  if (id.country_code && !cc) problems.push('неизвестный код страны: ' + id.country_code);

  return { ok: problems.length === 0, problems };
}

module.exports = {
  generateIdentity,
  validateIdentity,
  buildUserAgent,
  buildBrands,
  GPU_BANK,
  GPU_LIMITS,
  LOCALES,
  COUNTRIES,
  COUNTRY_BY_CODE,
  getCountry,
  listCountries,
  SCREENS,
  HARDWARE,
  FONTS_WIN,
  seedFrom,
  makeRng,
};
