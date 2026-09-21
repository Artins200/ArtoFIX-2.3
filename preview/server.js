'use strict';
/* =============================================================
   Статический сервер превью интерфейса ArtoFIX 2.5.
   Запуск:  node preview/server.js  (порт: PORT или 8642)

   Отдаёт:
     /            → preview/harness.html («рабочий стол» с окном-iframe)
     /app.html    → index.html + preview/api-shim.js (мок window.api)
     /<файл>      → файлы репозитория (app.js, и т.д.)

   Нужен ТОЛЬКО для визуальной проверки в браузере; в сборке
   Electron (npm start / electron-builder) не участвует.
   ============================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8642;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveFile(res, abs) {
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return send(res, 403, 'forbidden');
  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
  });
}

function appHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const shim = '<script src="/preview/api-shim.js"></script>\n';
  if (html.includes('<script src="app.js" defer></script>')) {
    return html.replace('<script src="app.js" defer></script>', shim + '<script src="app.js" defer></script>');
  }
  return shim + html;   // запасной вариант: шим до любого скрипта страницы
}

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (_) { return send(res, 400, 'bad request'); }

  if (urlPath === '/' || urlPath === '/preview/' || urlPath === '/preview/harness.html') {
    return serveFile(res, path.join(__dirname, 'harness.html'));
  }
  if (urlPath === '/app.html') {
    try { return send(res, 200, appHtml(), MIME['.html']); }
    catch (e) { return send(res, 500, 'index.html read error'); }
  }
  const abs = path.normalize(path.join(ROOT, urlPath));
  serveFile(res, abs);
}).listen(PORT, '0.0.0.0', () => {
  console.log('[preview] ArtoFIX UI preview: http://0.0.0.0:' + PORT + '/');
});
