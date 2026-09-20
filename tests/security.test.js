'use strict';
/* Проверки валидации ввода и генератора отпечатков.
   Запуск: node tests/security.test.js */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sec = require('../security');
const fp = require('../fingerprint-identity');

const results = [];
function test(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['fail', name + ' → ' + e.message]); }
}

// ─────────────────────────────────────────────
//  ИМЕНА ПРОФИЛЕЙ
// ─────────────────────────────────────────────
test('обычные имена профилей проходят', () => {
  ['yt', 'six seven'.replace(' ', '_'), 'acc-01', 'Profile_9'].forEach((n) => {
    assert.ok(sec.sanitizeProfileName(n), n + ' должно быть допустимо');
  });
});

test('path traversal в имени профиля отбивается', () => {
  ['../evil', '..', '.', 'a/b', 'a\\b', 'C:evil', 'a:b', 'profile.', '.hidden', 'con', 'NUL', 'a b']
    .forEach((n) => assert.strictEqual(sec.sanitizeProfileName(n), null, JSON.stringify(n) + ' должно быть отклонено'));
  // пробелы по краям просто срезаются, а не отбиваются
  assert.strictEqual(sec.sanitizeProfileName('  profile  '), 'profile');
});

test('управляющие символы и переводы строк в имени профиля отбиваются', () => {
  ['a\nb', 'a\u0000b', 'a\u001bb', 'x'.repeat(41)].forEach((n) => {
    assert.strictEqual(sec.sanitizeProfileName(n), null, JSON.stringify(n) + ' должно быть отклонено');
  });
});

test('safeJoinInside не выпускает за пределы базовой папки', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'artofix-test-'));
  assert.ok(sec.safeJoinInside(base, 'ok'));
  assert.strictEqual(sec.safeJoinInside(base, '..'), null);
  assert.strictEqual(sec.safeJoinInside(base, '..', '..', 'Windows'), null);
  assert.strictEqual(sec.safeJoinInside(base, 'sub/../../escape'), null);
  assert.ok(sec.safeJoinInside(base, 'sub', 'file.txt'));
});

// ─────────────────────────────────────────────
//  ДОМЕНЫ / IP / HOSTS
// ─────────────────────────────────────────────
test('корректные домены проходят', () => {
  ['ads.example.com', 'x.co', 'sub.domain.co.uk'].forEach((d) => {
    assert.strictEqual(sec.sanitizeDomain(d), d);
  });
});

test('инъекции в файл hosts отбиваются', () => {
  ['evil.com\n1.2.3.4 attacker', 'a.com # comment', 'a.com;rm -rf /', '$(){}', 'a_b.com',
   'a..b.com', '-a.com', 'a-.com', 'localhost', 'a'.repeat(300) + '.com', '../../etc/hosts']
    .forEach((d) => assert.strictEqual(sec.sanitizeDomain(d), null, JSON.stringify(d) + ' должно быть отклонено'));
});

test('список доменов чистится и дедуплицируется', () => {
  const r = sec.sanitizeDomainList(['ads.example.com', 'ads.example.com', 'bad domain', 'ok.example.com', 42]);
  assert.deepStrictEqual(r.domains, ['ads.example.com', 'ok.example.com']);
  assert.strictEqual(r.rejected, 2);
});

test('IPv4 строгий: инъекции отбиваются', () => {
  ['1.1.1.1', '8.8.8.8', '255.255.255.0'].forEach((ip) => assert.strictEqual(sec.sanitizeIpv4(ip), ip));
  ['1.1.1.1; whoami', '1.1.1', '1.1.1.1.1', '999.1.1.1', '01.1.1.1', '1.1.1.1\n2.2.2.2', '', 'localhost']
    .forEach((ip) => assert.strictEqual(sec.sanitizeIpv4(ip), null, JSON.stringify(ip) + ' должно быть отклонено'));
});

test('хост для TCP-проверки валидируется', () => {
  assert.strictEqual(sec.sanitizeHost('www.youtube.com'), 'www.youtube.com');
  assert.strictEqual(sec.sanitizeHost('1.1.1.1'), '1.1.1.1');
  assert.strictEqual(sec.sanitizeHost('a b'), null);
  assert.strictEqual(sec.sanitizeHost('host\nX'), null);
});

// ─────────────────────────────────────────────
//  URL
// ─────────────────────────────────────────────
test('опасные схемы URL отбиваются', () => {
  ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,<script>x</script>',
   'vbscript:msgbox', 'ms-msdt:/id', 'search-ms:query=x', '../../../etc/passwd', 'http://a b/']
    .forEach((u) => assert.strictEqual(sec.sanitizeExternalUrl(u), null, JSON.stringify(u) + ' должно быть отклонено'));
});

test('разрешённые схемы проходят', () => {
  assert.ok(sec.sanitizeExternalUrl('https://github.com/x'));
  assert.ok(sec.sanitizeExternalUrl('steam://rungameid/431960'));
  assert.ok(sec.sanitizeExternalUrl('tg://resolve?domain=test'));
  // http разрешён только для локальных адресов (свои сервисы/отладка)
  assert.ok(sec.sanitizeExternalUrl('http://localhost:8080/panel'));
  assert.ok(sec.sanitizeExternalUrl('http://192.168.1.10:3000'));
  assert.strictEqual(sec.sanitizeExternalUrl('http://example.com'), null);
});

test('URL для Selenium — только http(s) и about:blank', () => {
  assert.strictEqual(sec.sanitizeBrowseUrl('about:blank'), 'about:blank');
  assert.ok(sec.sanitizeBrowseUrl('https://youtube.com'));
  assert.strictEqual(sec.sanitizeBrowseUrl('steam://run/1'), null);
  assert.strictEqual(sec.sanitizeBrowseUrl('file:///etc/passwd'), null);
});

// ─────────────────────────────────────────────
//  СЕТЬ ОБНОВЛЕНИЙ
// ─────────────────────────────────────────────
test('белый список хостов обновления соблюдается', () => {
  assert.ok(sec.sanitizeUpdateUrl('https://api.github.com/repos/x/y/releases/latest'));
  assert.ok(sec.sanitizeUpdateUrl('https://objects.githubusercontent.com/abc'));
  assert.strictEqual(sec.sanitizeUpdateUrl('https://evil.example.com/payload.zip'), null);
  assert.strictEqual(sec.sanitizeUpdateUrl('http://api.github.com/x'), null);          // только https
  assert.strictEqual(sec.sanitizeUpdateUrl('https://api.github.com.evil.io/x'), null); // подмена поддомена
});

test('тег релиза и имена файлов санитайзятся', () => {
  assert.strictEqual(sec.sanitizeTag('v1.9.3'), 'v1.9.3');
  assert.strictEqual(sec.sanitizeTag('..\\..\\evil'), null);
  assert.strictEqual(sec.sanitizeFileName('zapret-1.0.zip'), 'zapret-1.0.zip');
  assert.strictEqual(sec.sanitizeFileName('../evil.zip'), null);
  assert.strictEqual(sec.sanitizeFileName('C:\\evil.zip'), null);
  assert.strictEqual(sec.sanitizeFileName('.hidden'), null);
});

// ─────────────────────────────────────────────
//  ОТПЕЧАТОК
// ─────────────────────────────────────────────
test('отпечаток стабилен для профиля и уникален между профилями', () => {
  const a1 = fp.generateIdentity('acc_one', 'installA', { browser: 'chrome', browserVersion: '131.0.6778.86' });
  const a2 = fp.generateIdentity('acc_one', 'installA', { browser: 'chrome', browserVersion: '131.0.6778.86' });
  const b = fp.generateIdentity('acc_two', 'installA', { browser: 'chrome', browserVersion: '131.0.6778.86' });
  assert.strictEqual(a1.canvas_noise, a2.canvas_noise);
  assert.strictEqual(a1.webgl.renderer, a2.webgl.renderer);
  assert.strictEqual(a1.timezone, a2.timezone);
  assert.notStrictEqual(a1.canvas_noise, b.canvas_noise);
  assert.notStrictEqual(a1.seed, b.seed);
});

test('разные установки дают разные отпечатки для одного имени профиля', () => {
  const a = fp.generateIdentity('acc', 'installA', { browser: 'chrome' });
  const b = fp.generateIdentity('acc', 'installB', { browser: 'chrome' });
  assert.notStrictEqual(a.seed, b.seed);
});

test('смена личности (refresh) меняет отпечаток', () => {
  const a = fp.generateIdentity('acc', 'installA', { browser: 'chrome', identitySalt: 'deadbeef' });
  const b = fp.generateIdentity('acc', 'installA', { browser: 'chrome', identitySalt: 'cafebabe' });
  assert.notStrictEqual(a.canvas_noise + a.webgl.renderer, b.canvas_noise + b.webgl.renderer);
});

test('отпечаток не содержит внутренних противоречий (leak check)', () => {
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    const id = fp.generateIdentity(name, 'installX', { browser: 'chrome', browserVersion: '132.0.6834.110' });
    assert.strictEqual(id.leak_check.ok, true, name + ': ' + JSON.stringify(id.leak_check.problems));
    assert.ok(id.vectors === undefined);                    // векторы добавляет main, не генератор
    assert.ok(!id.battery, 'battery-API в Chrome удалён — отдавать его нельзя');
    assert.strictEqual(id.webdriver, false);
  }
});

test('проверка утечек находит подделку', () => {
  const id = fp.generateIdentity('x', 'i', { browser: 'chrome' });
  id.ua_major = '999';                                       // UA ↔ UA-CH разъезжаются
  id.battery = { level: 1 };
  id.webgl.renderer = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))';
  const r = fp.validateIdentity(id);
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => /ua_major|User-Agent/.test(p)));
  assert.ok(r.problems.some((p) => /battery/.test(p)));
  assert.ok(r.problems.some((p) => /растеризатор/.test(p)));
});

test('UA строится под реальную версию браузера', () => {
  const chrome = fp.generateIdentity('c', 'i', { browser: 'chrome', browserVersion: '131.0.6778.86' });
  assert.ok(chrome.user_agent.includes('Chrome/131.0.0.0'));
  assert.strictEqual(chrome.ua_major, '131');
  const edge = fp.generateIdentity('e', 'i', { browser: 'msedge', browserVersion: '131.0.2903.86' });
  assert.ok(edge.user_agent.includes('Edg/131.0.0.0'));
  assert.ok(edge.ua_brands_edge.length > 0);
  const firefox = fp.generateIdentity('f', 'i', { browser: 'firefox', browserVersion: '134.0' });
  assert.ok(firefox.user_agent.includes('Firefox/134'));
});

test('прокси в отпечатке включает защиту от утечки WebRTC', () => {
  const id = fp.generateIdentity('p', 'i', { browser: 'chrome', proxyServer: 'socks5://127.0.0.1:1080' });
  assert.strictEqual(id.webrtc.mode, 'public_only');
  assert.ok(id.proxy && id.proxy.server === 'socks5://127.0.0.1:1080');
});

test('окно профиля не больше его экрана', () => {
  for (let i = 0; i < 20; i++) {
    const id = fp.generateIdentity('w' + i, 'i', { browser: 'chrome' });
    assert.ok(id.screen.window_width <= id.screen.width, 'окно шире экрана');
    assert.ok(id.screen.window_height <= id.screen.avail_height, 'окно выше рабочей области');
  }
});

// ─────────────────────────────────────────────
//  ПРОЧЕЕ
// ─────────────────────────────────────────────
test('JSON читается только в пределах лимита', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artofix-json-'));
  const small = path.join(dir, 'small.json');
  const big = path.join(dir, 'big.json');
  fs.writeFileSync(small, '{"a":1}');
  fs.writeFileSync(big, '{"a":"' + 'x'.repeat(5000) + '"}');
  assert.deepStrictEqual(sec.readJsonSafe(small, 1024), { a: 1 });
  assert.strictEqual(sec.readJsonSafe(big, 1024), null);
  assert.strictEqual(sec.readJsonSafe(path.join(dir, 'missing.json')), null);
});

test('выбор папки ограничен белым списком', () => {
  assert.strictEqual(sec.sanitizeWhich('profiles'), 'profiles');
  assert.strictEqual(sec.sanitizeWhich('..\\Windows'), null);
  assert.strictEqual(sec.sanitizeWhich('C:\\Windows'), null);
});

test('тип браузера ограничен белым списком', () => {
  ['chrome', 'msedge', 'firefox', 'yandex', 'app'].forEach((b) => assert.strictEqual(sec.sanitizeBrowser(b), b));
  ['iexplore', 'chrome.exe', '../../calc', '', null].forEach((b) => assert.strictEqual(sec.sanitizeBrowser(b), null));
});

const failed = results.filter((r) => r[0] === 'fail');
results.forEach((r) => console.log((r[0] === 'ok' ? '  ✓ ' : '  ✗ ') + r[1]));
console.log('\nsecurity: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено');
process.exit(failed.length ? 1 : 0);
