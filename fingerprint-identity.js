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

/** Локаль ↔ TZ ↔ гео: несовпадение (язык ru, зона America/New_York) — прямой флаг бота. */
const LOCALES = [
  { tz: 'Europe/Moscow',      lang: 'ru-RU', langs: ['ru-RU', 'ru', 'en-US', 'en'], geo: null },
  { tz: 'Europe/Kyiv',        lang: 'uk-UA', langs: ['uk-UA', 'uk', 'ru-RU', 'ru', 'en-US', 'en'], geo: null },
  { tz: 'Europe/Berlin',      lang: 'de-DE', langs: ['de-DE', 'de', 'en-US', 'en'], geo: null },
  { tz: 'Europe/Amsterdam',   lang: 'nl-NL', langs: ['nl-NL', 'nl', 'en-US', 'en'], geo: null },
  { tz: 'Europe/Warsaw',      lang: 'pl-PL', langs: ['pl-PL', 'pl', 'en-US', 'en'], geo: null },
  { tz: 'Europe/London',      lang: 'en-GB', langs: ['en-GB', 'en-US', 'en'], geo: null },
  { tz: 'America/New_York',   lang: 'en-US', langs: ['en-US', 'en'], geo: null },
  { tz: 'America/Chicago',    lang: 'en-US', langs: ['en-US', 'en'], geo: null },
  { tz: 'Asia/Almaty',        lang: 'ru-RU', langs: ['ru-RU', 'ru', 'kk-KZ', 'kk', 'en-US', 'en'], geo: null },
  { tz: 'Asia/Tbilisi',       lang: 'ru-RU', langs: ['ru-RU', 'ru', 'ka-GE', 'ka', 'en-US', 'en'], geo: null },
];

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
 * @param {object} opts          {browser, browserVersion, resolution, spoof, overrides}
 */
function generateIdentity(profileName, installId, opts) {
  opts = opts || {};
  const browser = opts.browser || 'chrome';
  const salt = opts.identitySalt ? '|' + String(opts.identitySalt).slice(0, 32) : '';
  const identitySeed = seedFrom('artofix|' + installId + '|' + profileName + '|' + browser + salt);
  const rng = makeRng(identitySeed);

  const gpu    = pick(rng, GPU_BANK);
  const locale = pick(rng, LOCALES);
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
    geolocation: locale.geo,

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

  identity.leak_check = validateIdentity(identity);
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
    ka: ['Asia'], de: ['Europe'], nl: ['Europe'], pl: ['Europe'],
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
  SCREENS,
  HARDWARE,
  FONTS_WIN,
  seedFrom,
  makeRng,
};
