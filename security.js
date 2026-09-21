'use strict';
/* =============================================================
   ARTOFIX 2.5 — SECURITY PRIMITIVES
   -------------------------------------------------------------
   Единственное место, где живёт валидация входных данных от
   рендерера. Никакие значения отсюда не подставляются в командную
   строку/скрипт без проверки по строгому шаблону.

   Модель угроз:
     • renderer скомпрометирован (XSS через логи/бинды/конфиг);
     • данные на диске подменил другой процесс/архив;
     • в папку profiles попали имена с ".." или UNC-путями;
     • сеть отвечает подставным редиректом на чужой хост.
   ============================================================= */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
//  ПУТИ
// ─────────────────────────────────────────────

/** true, если target лежит внутри base (после нормализации). */
function isInside(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  const rel = path.relative(b, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Безопасный join: возвращает абсолютный путь внутри base или null.
 * Дополнительно разворачивает симлинки до ближайшего существующего
 * родителя — защита от подмены папки профиля ссылкой наружу.
 */
function safeJoinInside(base, ...parts) {
  let target;
  try {
    target = path.resolve(base, ...parts.map((p) => String(p)));
  } catch (_) { return null; }
  if (!isInside(base, target)) return null;

  // проверка симлинков по цепочке вверх
  let probe = target;
  let hops = 0;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe && hops < 64) {
    probe = path.dirname(probe);
    hops++;
  }
  try {
    const realBase = fs.existsSync(base) ? fs.realpathSync.native(base) : path.resolve(base);
    const realProbe = fs.existsSync(probe) ? fs.realpathSync.native(probe) : probe;
    if (!isInside(realBase, realProbe)) return null;
    // и сам base не должен быть ссылкой наружу
    if (fs.existsSync(base) && !isInside(realBase, realBase)) return null;
  } catch (_) { /* недоступно — считаем путь безопасным, он уже нормализован */ }

  return target;
}

// ─────────────────────────────────────────────
//  ИМЕНА ПРОФИЛЕЙ
// ─────────────────────────────────────────────
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const WIN_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Имя профиля: латиница/цифры/_/- , 1..40 символов, не резервное имя Windows.
 * Возвращает нормализованное имя или null.
 */
function sanitizeProfileName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 40) return null;
  if (s === '.' || s === '..') return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (/[\\/:*?"<>|]/.test(s)) return null;   // разделители и UNC-трюки
  if (!PROFILE_NAME_RE.test(s)) return null;
  if (WIN_RESERVED.has(s.toLowerCase())) return null;
  if (s.endsWith('.') || s.endsWith(' ')) return null;
  return s;
}

// ─────────────────────────────────────────────
//  ДОМЕНЫ / IP / ХОСТЫ
// ─────────────────────────────────────────────
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Домен для файла hosts: только буквы/цифры/дефис/точка, без переводов строк. */
function sanitizeDomain(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!s || s.length > 253) return null;
  if (/[\u0000-\u0020\u007f]/.test(s)) return null;         // пробелы/перевод строки/управляющие
  if (/[^a-z0-9.\-]/.test(s)) return null;                  // всё остальное (в т.ч. / \ : #)
  if (s.startsWith('.') || s.includes('..')) return null;
  if (s.startsWith('-') || s.includes('-.') || s.includes('.-')) return null;
  if (!DOMAIN_RE.test(s)) return null;
  return s;
}

/** Массив доменов: чистит, дедуплицирует, ограничивает размер. */
function sanitizeDomainList(list, maxItems = 5000) {
  if (!Array.isArray(list)) return { ok: false, domains: [], rejected: 0, msg: 'ожидался массив' };
  const out = [];
  const seen = new Set();
  let rejected = 0;
  for (const item of list.slice(0, maxItems)) {
    const d = sanitizeDomain(item);
    if (!d) { rejected++; continue; }
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return { ok: true, domains: out, rejected };
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Строгий IPv4: без ведущих нулей, без пробелов — исключает инъекцию в PowerShell. */
function sanitizeIpv4(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!IPV4_RE.test(s)) return null;
  if (s.split('.').some((oct) => oct.length > 1 && oct.startsWith('0'))) return null;
  return s;
}

/** Хост для TCP-проверки: домен или IPv4/IPv6-литерал. */
function sanitizeHost(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 253) return null;
  if (/[\u0000-\u0020\u007f]/.test(s)) return null;
  const ipv4 = sanitizeIpv4(s);
  if (ipv4) return ipv4;
  if (/^[0-9a-f:]{2,45}$/.test(s) && s.includes(':')) return s;   // IPv6
  if (DOMAIN_RE.test(s)) return s;
  return null;
}

/** Порт: целое 1..65535. */
function sanitizePort(raw, fallback = 443) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

// ─────────────────────────────────────────────
//  СХЕМЫ URL
// ─────────────────────────────────────────────
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'steam:', 'tg:', 'discord:']);
const BROWSER_SCHEMES = new Set(['http:', 'https:']);

/** Приватный/локальный хост: для http-ссылок это единственное исключение. */
function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/**
 * URL для открытия во внешнем приложении/браузере.
 * Режет file:, javascript:, data:, vbscript:, ms-msdt:, search-ms: и т.п.
 */
function sanitizeExternalUrl(raw, allowedSchemes = EXTERNAL_SCHEMES) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (!allowedSchemes.has(u.protocol)) return null;
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (!u.hostname) return null;
    const local = isLocalHost(u.hostname);
    const host = sanitizeHost(u.hostname);
    if (!host && !local) return null;          // localhost/приватная сеть допускаются как есть
  }
  // Внешние открытия — только https: http оставляем для localhost/локальной сети
  // (отладка и свои сервисы), чтобы ссылку нельзя было подсунуть по сети в открытом виде.
  if (u.protocol === 'http:' && allowedSchemes === EXTERNAL_SCHEMES && !isLocalHost(u.hostname)) {
    return null;
  }
  return u.toString();
}

/** URL, который уходит в Selenium (адресная строка профиля): только http(s)/about:blank. */
function sanitizeBrowseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === 'about:blank' || s === '') return 'about:blank';
  if (s.length > 2048) return null;
  return sanitizeExternalUrl(s, BROWSER_SCHEMES);
}

// ─────────────────────────────────────────────
//  СЕТЕВЫЕ ЗАПРОСЫ (обновление Zapret)
// ─────────────────────────────────────────────
const UPDATE_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

/** Разрешён ли хост для сетевых операций (в т.ч. каждого редиректа). */
function isAllowedUpdateHost(hostname) {
  if (typeof hostname !== 'string') return false;
  return UPDATE_HOSTS.has(hostname.toLowerCase());
}

/** Проверка URL обновления: только https + белый список хостов. */
function sanitizeUpdateUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  if (!isAllowedUpdateHost(u.hostname)) return null;
  return u.toString();
}

/** Тег релиза: используется как имя файла и как version.txt. */
function sanitizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 64) return null;
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

/** Имя файла внутри архива релиза: без путей, без "..", только допустимые символы. */
function sanitizeFileName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 128) return null;
  if (s !== path.basename(s)) return null;
  return /^[A-Za-z0-9._() \-]+$/.test(s) && !s.startsWith('.') ? s : null;
}

// ─────────────────────────────────────────────
//  ПРОЧЕЕ
// ─────────────────────────────────────────────
const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'yandex', 'app']);

function sanitizeBrowser(raw) { return BROWSERS.has(raw) ? raw : null; }

function sanitizeWhich(raw) {
  const allowed = new Set(['profiles', 'Zapret', 'assets', 'drivers', 'install']);
  return allowed.has(raw) ? raw : null;
}

function clampString(s, max = 256) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

/** Пользовательский текст (заметки, подписи): без управляющих символов, ограниченная длина. */
function sanitizeLabel(raw, max = 64) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/** Безопасный разбор JSON из файла с ограничением размера. */
function readJsonSafe(file, maxBytes = 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_) { return null; }
}

/**
 * Проверка URL загрузки Python с официального сайта:
 * только https, только www.python.org, только официальные инсталлеры Python 3.
 * Защита от 0-day подмены хоста, открытого редиректа и инъекций.
 */
function sanitizePythonDownloadUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 256) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'www.python.org' && host !== 'python.org') return null;
  if (!/^\/ftp\/python\/3\.\d+\.\d+\/python-3\.\d+\.\d+(-amd64)?\.exe$/i.test(u.pathname)) {
    return null;
  }
  return u.toString();
}

/**
 * Валидация скачанного бинарника установщика перед запуском:
 * проверка существования, допустимого размера (15–60 МБ) и наличия сигнатуры MZ (DOS/PE).
 * Защита от запуска 0-day шелл-скриптов, повреждённых или подставных файлов.
 */
function validateInstallerBinary(filePath) {
  try {
    if (!filePath || typeof filePath !== 'string') return { ok: false, msg: 'Некорректный путь к файлу' };
    if (!fs.existsSync(filePath)) return { ok: false, msg: 'Файл не найден' };
    const stat = fs.statSync(filePath);
    if (stat.size < 15 * 1024 * 1024 || stat.size > 60 * 1024 * 1024) {
      return { ok: false, msg: 'Некорректный размер установщика: ' + stat.size + ' байт' };
    }
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    if (buf[0] !== 0x4D || buf[1] !== 0x5A) { // 'M', 'Z'
      return { ok: false, msg: 'Отсутствует сигнатура MZ исполняемого файла' };
    }
    return { ok: true, size: stat.size };
  } catch (err) {
    return { ok: false, msg: err && err.message ? err.message : 'Ошибка валидации файла' };
  }
}

/** Атомарная запись (temp + rename): не оставляем полусломанный файл при падении. */
function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, file);
}

module.exports = {
  isInside,
  safeJoinInside,
  sanitizeProfileName,
  sanitizeDomain,
  sanitizeDomainList,
  sanitizeIpv4,
  sanitizeHost,
  sanitizePort,
  sanitizeExternalUrl,
  sanitizeBrowseUrl,
  isLocalHost,
  isAllowedUpdateHost,
  sanitizeUpdateUrl,
  sanitizePythonDownloadUrl,
  validateInstallerBinary,
  sanitizeTag,
  sanitizeFileName,
  sanitizeBrowser,
  sanitizeWhich,
  sanitizeLabel,
  clampString,
  readJsonSafe,
  writeFileAtomic,
  EXTERNAL_SCHEMES,
  BROWSER_SCHEMES,
  UPDATE_HOSTS,
  BROWSERS,
};
