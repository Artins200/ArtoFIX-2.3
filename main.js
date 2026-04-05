const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── Корневая папка программы ──
// В dev: папка проекта (__dirname)
// В .exe: папка рядом с .exe файлом (не внутри asar!)
function getAppRoot() {
    if (app.isPackaged) {
        // process.execPath = путь к Artofix.exe
        // нам нужна папка где лежит exe
        return path.dirname(process.execPath);
    }
    return __dirname;
}

// Путь к файлу данных (profiles, binds, config и т.д.)
function dataPath(...parts) {
    return path.join(getAppRoot(), ...parts);
}

// Путь к ресурсам (engine.py, Zapret, assets) — в .exe они в extraResources
function resPath(...parts) {
    if (app.isPackaged) {
        // electron-builder кладёт extraResources в папку рядом с exe в resources/
        return path.join(path.dirname(process.execPath), 'resources', ...parts);
    }
    return path.join(__dirname, ...parts);
}

// ── Поиск Python ──
function findPython() {
    // 1. python рядом с программой (portable)
    const local = dataPath('python', 'python.exe');
    if (fs.existsSync(local)) return local;
    // 2. python.exe в папке resources (extraResources)
    const res = resPath('python', 'python.exe');
    if (fs.existsSync(res)) return res;
    // 3. python в PATH системы
    return 'python';
}

// ── Проверка прав администратора при старте ──
function isAdmin() {
    try {
        // Пробуем прочитать hosts — если ОК, значит есть доступ
        fs.accessSync('C:\\Windows\\System32\\drivers\\etc\\hosts', fs.constants.W_OK);
        return true;
    } catch(_) { return false; }
}

function relaunchAsAdmin() {
    const exe  = process.execPath;
    const args = process.argv.slice(1).map(a => `"${a}"`).join(' ');
    const cwd  = app.isPackaged ? path.dirname(process.execPath) : __dirname;
    spawn('powershell', [
        '-Command',
        `Start-Process "${exe}" -ArgumentList '${args}' -Verb RunAs -WorkingDirectory "${cwd}"`
    ], { detached: true, windowsHide: true });
    app.exit(0);
}

let win, tray, zapretProcess, isQuiting = false;

function createWindow() {
    win = new BrowserWindow({
        width: 1100, height: 680,
        minWidth: 900, minHeight: 580,
        frame: false, transparent: false,
        backgroundColor: '#04050f',
        show: false,           // не показываем до готовности
        resizable: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    win.once('ready-to-show', () => { win.show(); });
    if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
    win.on('close', e => { if (!isQuiting) { e.preventDefault(); win.hide(); } });
}

// ── ТРЕЙ ──
function buildTrayMenu() {
    // Читаем бинды для подменю
    let bindsItems = [];
    try {
        const p = dataPath('artofix_binds.json');
        if (fs.existsSync(p)) {
            const binds = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (Array.isArray(binds) && binds.length > 0) {
                bindsItems = binds.slice(0, 12).map(b => ({
                    label: (b.label || b.url || '?').substring(0, 40),
                    click: () => {
                        // Запускаем бинд напрямую без открытия окна
                        launchBindFromTray(b);
                    }
                }));
            }
        }
    } catch(_) {}

    const template = [
        { label: 'ARTOFIX 2.3', enabled: false },
        { type: 'separator' },
        { label: '▶ Запустить Zapret',  click: () => { send('tray-act','run'); } },
        { label: '■ Остановить Zapret', click: () => { send('tray-act','stop'); } },
        { type: 'separator' },
    ];

    if (bindsItems.length > 0) {
        template.push({ label: '🔗 Бинды', submenu: bindsItems });
        template.push({ type: 'separator' });
    }

    template.push(
        { label: '🪟 Показать окно', click: () => win.show() },
        { label: '📋 Логи',          click: () => { win.show(); send('go-to','logs'); } },
        { label: '⚙️ Настройки',     click: () => { win.show(); send('go-to','settings'); } },
        { type: 'separator' },
        { label: '❌ Выход',          click: () => { isQuiting = true; app.quit(); } }
    );

    return Menu.buildFromTemplate(template);
}

function createTray() {
    const iconPath = resPath('icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip('Artofix 2.3');
    tray.on('double-click', () => win.show());
}

// Пересобираем меню трея когда бинды обновились
ipcMain.on('tray-rebuild', () => {
    if (tray) tray.setContextMenu(buildTrayMenu());
});

function launchBindFromTray(bind) {
    const python   = findPython();
    const enginePy = resPath('engine.py');
    const profile  = bind.profile || 'default';
    const browser  = bind.browser || 'chrome';
    const url      = bind.url || 'about:blank';

    if (browser === 'app') {
        shell.openPath(url);
        return;
    }

    try { fs.mkdirSync(dataPath('profiles', profile), { recursive: true }); } catch(_) {}

    const py = spawn(python, [enginePy, url, profile, browser, '--profiles-dir', dataPath('profiles')], {
        cwd: resPath(),
        windowsHide: true,
        env: {
            ...process.env,
            ARTOFIX_PROFILES: dataPath('profiles'),
            ARTOFIX_CONFIG:   dataPath('config.json'),
            ARTOFIX_ROOT:     getAppRoot(),
        }
    });
    py.stdout.on('data', d => appendLog(profile, browser, d.toString()));
    py.stderr.on('data', d => appendLog(profile, browser, d.toString()));
    py.on('error', e => appendLog(profile, browser, '[error] ' + e.message));
}

function send(ch, d) { if (win && !win.isDestroyed()) win.webContents.send(ch, d); }

// ── ZAPRET ──
function openZapretCfg() {
    // У Flowseal нет config.bat — открываем папку Zapret в проводнике
    // чтобы пользователь сам выбрал нужный .bat
    shell.openPath(resPath('Zapret'));
}

function openZapretService() {
    const zapDir = resPath('Zapret');
    const p = path.join(zapDir, 'service.bat');
    if (fs.existsSync(p)) {
        // Запускаем с явным cd в папку Zapret — иначе bat ищет файлы от рабочего стола
        spawn('cmd.exe', ['/c', `cd /d "${zapDir}" && "${p}"`], {
            cwd: zapDir,
            windowsHide: false,
            shell: true,
            detached: true,
        });
    } else {
        dialog.showMessageBox(win, { type: 'warning', message: 'service.bat не найден в папке Zapret:\n' + zapDir });
    }
}

ipcMain.handle('get-icon-path', () => {
    const p = resPath('icon.png');
    if (fs.existsSync(p)) return p;
    // dev fallback
    const dev = path.join(__dirname, 'icon.png');
    if (fs.existsSync(dev)) return dev;
    return null;
});

ipcMain.on('win-act', (_, a) => {
    if (a === 'close') { isQuiting = true; app.quit(); }
    if (a === 'hide')  win.hide();
    if (a === 'min')   win.minimize();
    if (a === 'max')   win.isMaximized() ? win.unmaximize() : win.maximize();
});

ipcMain.on('cmd', (_, command) => {
    exec(command, { cwd: resPath('Zapret'), windowsHide: true }, (err) => {
        if (err) console.error('[cmd]', err.message);
    });
});

ipcMain.on('zapret-config',   () => openZapretCfg());
ipcMain.on('zapret-service',  () => openZapretService());
ipcMain.on('open-folder', (_, rel) => {
    // profiles и data папки — рядом с exe
    // Zapret и assets — в resources
    const dataDirs = ['profiles', 'artofix_binds.json'];
    const isData = dataDirs.some(d => rel.startsWith(d));
    shell.openPath(isData ? dataPath(rel) : resPath(rel));
});

ipcMain.handle('zapret-start', () => {
    if (zapretProcess) return { ok: false, msg: 'Уже запущен' };
    const zapDir = resPath('Zapret');

    // Flowseal: ищем стратегию запуска по приоритету
    const candidates = [
        'general.bat',          // основная стратегия Flowseal
        'general(ALT1).bat',
        'general(ALT2).bat',
        'discord.bat',
        'run_zapret.bat',       // fallback для других форков
    ];

    let bat = null;
    for (const name of candidates) {
        const p = path.join(zapDir, name);
        if (fs.existsSync(p)) { bat = p; break; }
    }

    if (!bat) return { ok: false, msg: 'Не найден general.bat в папке Zapret.\nПроверь что Zapret установлен.' };

    zapretProcess = spawn('cmd.exe', ['/c', bat], {
        cwd: zapDir,
        windowsHide: true,
        // detached чтобы winws.exe продолжал работать независимо
        detached: false,
    });
    zapretProcess.on('error', e => {
        zapretProcess = null;
        send('zapret-status', { on: false, msg: 'Ошибка: ' + e.message });
    });
    zapretProcess.on('exit', () => {
        // general.bat завершается быстро — winws.exe остаётся висеть отдельно
        // Не ставим zapretActive=false при выходе bat-файла
        zapretProcess = null;
    });
    return { ok: true };
});

ipcMain.handle('zapret-stop', () => {
    // Убиваем winws.exe (сам процесс обхода) и cmd если висит
    exec('taskkill /f /im winws.exe /t', () => {});
    exec('taskkill /f /im winws64.exe /t', () => {});
    if (zapretProcess) {
        try { process.kill(zapretProcess.pid, 'SIGTERM'); } catch(_) {}
        zapretProcess = null;
    }
    return { ok: true };
});

// ── ЛОГИ ЗАПУСКОВ ──
const LOG_MAX = 300; // максимум строк в памяти
let launchLogs = [];

function appendLog(profile, browser, text) {
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
        launchLogs.push({
            ts: Date.now(),
            profile, browser,
            msg: line.trim()
        });
    }
    if (launchLogs.length > LOG_MAX) launchLogs = launchLogs.slice(-LOG_MAX);
    // Шлём в renderer если окно открыто
    send('log-entry', launchLogs.slice(-5));
}

ipcMain.handle('read-logs',  () => launchLogs);
ipcMain.handle('clear-logs', () => { launchLogs = []; return { ok: true }; });

ipcMain.handle('launch-browser', (_, { url, profile, browser }) => {
    return new Promise(resolve => {
        const python   = findPython();
        const enginePy = resPath('engine.py');
        const profDir  = dataPath('profiles', profile);
        try { fs.mkdirSync(profDir, { recursive: true }); } catch(_) {}

        appendLog(profile, browser, `[start] ${browser} → ${url}`);

        const py = spawn(python, [enginePy, url, profile, browser, '--profiles-dir', dataPath('profiles')], {
            cwd: resPath(),
            windowsHide: true,
            env: {
                ...process.env,
                ARTOFIX_PROFILES: dataPath('profiles'),
                ARTOFIX_CONFIG:   dataPath('config.json'),
                ARTOFIX_ROOT:     getAppRoot(),
            }
        });
        py.stdout.on('data', d => appendLog(profile, browser, d.toString()));
        py.stderr.on('data', d => appendLog(profile, browser, d.toString()));
        py.on('error', e => {
            appendLog(profile, browser, '[error] ' + e.message);
            resolve({ ok: false, msg: 'Python не найден: ' + e.message });
        });
        setTimeout(() => resolve({ ok: true }), 800);
    });
});

ipcMain.handle('create-profile', (_, name) => {
    try {
        const safe = name.replace(/[^a-zA-Z0-9_\-]/g, '');
        if (!safe) return { ok: false, msg: 'Недопустимое имя' };
        const dir = dataPath('profiles', safe);
        fs.mkdirSync(dir, { recursive: true });
        const meta = path.join(dir, '_artofix_meta.json');
        if (!fs.existsSync(meta)) {
            fs.writeFileSync(meta, JSON.stringify({ name: safe, created: new Date().toISOString() }), 'utf-8');
        }
        return { ok: true, name: safe };
    } catch (e) { return { ok: false, msg: e.message }; }
});

ipcMain.handle('list-profiles', () => {
    const dir = dataPath('profiles');
    try {
        fs.mkdirSync(dir, { recursive: true }); // создаём если нет
        return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    } catch (_) { return []; }
});

ipcMain.handle('delete-profile', (_, name) => {
    const dir = dataPath('profiles', name);
    try { fs.rmSync(dir, { recursive: true, force: true }); return { ok: true }; }
    catch (e) { return { ok: false, msg: e.message }; }
});

ipcMain.handle('read-config', () => {
    const p = dataPath('config.json');
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) {}
    return {};
});
ipcMain.handle('write-config', (_, data) => {
    try { fs.writeFileSync(dataPath('config.json'), JSON.stringify(data, null, 2), 'utf-8'); return { ok: true }; }
    catch (e) { return { ok: false, msg: e.message }; }
});

ipcMain.handle('read-settings', () => {
    const p = dataPath('artofix_settings.json');
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) {}
    return {};
});
ipcMain.handle('write-settings', (_, data) => {
    try { fs.writeFileSync(dataPath('artofix_settings.json'), JSON.stringify(data, null, 2), 'utf-8'); return { ok: true }; }
    catch (e) { return { ok: false, msg: e.message }; }
});

ipcMain.handle('read-binds', () => {
    const p = dataPath('artofix_binds.json');
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) {}
    return [];
});
ipcMain.handle('write-binds', (_, data) => {
    try {
        fs.writeFileSync(dataPath('artofix_binds.json'), JSON.stringify(data, null, 2), 'utf-8');
        // Пересобираем меню трея с новыми биндами
        if (tray) tray.setContextMenu(buildTrayMenu());
        return { ok: true };
    }
    catch (e) { return { ok: false, msg: e.message }; }
});

ipcMain.handle('read-profile-meta', (_, name) => {
    const p = dataPath('profiles', name, '_artofix_meta.json');
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) {}
    return {};
});
ipcMain.handle('write-profile-meta', (_, name, data) => {
    try {
        const dir = dataPath('profiles', name);
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, '_artofix_meta.json');
        const existing = (() => { try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p,'utf-8')); } catch(_){} return {}; })();
        fs.writeFileSync(p, JSON.stringify({ ...existing, ...data }, null, 2), 'utf-8');
        return { ok: true };
    } catch(e) { return { ok: false, msg: e.message }; }
});

// ── ADBLOCK: hosts-файл ──
const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const ARTOFIX_MARKER_START = '# === ARTOFIX ADBLOCK START ===';
const ARTOFIX_MARKER_END   = '# === ARTOFIX ADBLOCK END ===';

ipcMain.handle('hosts-read', () => {
    try {
        const raw = fs.readFileSync(HOSTS_PATH, 'utf-8');
        const m = raw.match(/# === ARTOFIX ADBLOCK START ===([\s\S]*?)# === ARTOFIX ADBLOCK END ===/);
        if (!m) return { ok: true, domains: [] };
        const domains = m[1].split('\n')
            .map(l => l.trim())
            .filter(l => l.startsWith('0.0.0.0 '))
            .map(l => l.replace('0.0.0.0 ', '').trim());
        return { ok: true, domains };
    } catch(e) { return { ok: false, msg: e.message }; }
});

ipcMain.handle('hosts-write', (_, domains) => {
    try {
        let raw = fs.readFileSync(HOSTS_PATH, 'utf-8');
        // убираем старый блок если есть
        raw = raw.replace(/\n?# === ARTOFIX ADBLOCK START ===([\s\S]*?)# === ARTOFIX ADBLOCK END ===\n?/g, '');
        raw = raw.trimEnd();
        if (domains && domains.length > 0) {
            const block = '\n' + ARTOFIX_MARKER_START + '\n' +
                domains.map(d => '0.0.0.0 ' + d.trim()).join('\n') +
                '\n' + ARTOFIX_MARKER_END + '\n';
            raw += block;
        }
        fs.writeFileSync(HOSTS_PATH, raw, 'utf-8');
        return { ok: true };
    } catch(e) {
        // нет прав — пробуем через PowerShell с UAC
        if (e.code === 'EACCES' || e.message.includes('permission') || e.message.includes('EPERM')) {
            return { ok: false, needAdmin: true, msg: 'Нужны права администратора' };
        }
        return { ok: false, msg: e.message };
    }
});

ipcMain.handle('hosts-write-admin', (_, domains) => {
    return new Promise(resolve => {
        let raw = '';
        try { raw = fs.readFileSync(HOSTS_PATH, 'utf-8'); } catch(_) {}
        raw = raw.replace(/\n?# === ARTOFIX ADBLOCK START ===([\s\S]*?)# === ARTOFIX ADBLOCK END ===\n?/g, '').trimEnd();
        if (domains && domains.length > 0) {
            raw += '\n' + ARTOFIX_MARKER_START + '\n' +
                domains.map(d => '0.0.0.0 ' + d.trim()).join('\n') +
                '\n' + ARTOFIX_MARKER_END + '\n';
        }
        // пишем через temp файл + PowerShell с elevation
        const tmp = path.join(app.getPath('temp'), 'artofix_hosts_patch.txt');
        try { fs.writeFileSync(tmp, raw, 'utf-8'); } catch(e) { return resolve({ ok: false, msg: e.message }); }
        const ps = `Copy-Item -Path '${tmp}' -Destination '${HOSTS_PATH}' -Force`;
        const cmd = spawn('powershell', ['-Command', `Start-Process powershell -Verb RunAs -Wait -ArgumentList "-Command &{${ps}}"`],
            { windowsHide: true });
        cmd.on('error', e => resolve({ ok: false, msg: e.message }));
        cmd.on('exit', code => {
            try { fs.unlinkSync(tmp); } catch(_) {}
            resolve({ ok: code === 0 });
        });
    });
});

ipcMain.handle('ublock-install', (_, profileName) => {
    const src      = resPath('assets', 'ublock');
    const manifest = path.join(src, 'manifest.json');
    if (!fs.existsSync(src))      return { ok: false, msg: 'Папка assets\\ublock\\ не найдена' };
    if (!fs.existsSync(manifest)) return { ok: false, msg: 'В assets\\ublock\\ нет manifest.json' };
    let version = '1.0.0';
    try { const m = JSON.parse(fs.readFileSync(manifest,'utf-8')); if (m.version) version = m.version; } catch(_) {}
    const EXT_ID     = 'cjpalhdlnbpafiamejdnhcphjbkeiagm';
    const profileBase = dataPath('profiles', profileName);
    const dst         = path.join(profileBase, 'Default', 'Extensions', EXT_ID, version + '_0');
    try {
        function copyDir(from, to) {
            fs.mkdirSync(to, { recursive: true });
            for (const e of fs.readdirSync(from, { withFileTypes: true })) {
                const s = path.join(from, e.name), d = path.join(to, e.name);
                if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
            }
        }
        copyDir(src, dst);
        const prefsPath = path.join(profileBase, 'Default', 'Preferences');
        if (!fs.existsSync(prefsPath)) {
            fs.mkdirSync(path.join(profileBase, 'Default'), { recursive: true });
            fs.writeFileSync(prefsPath, JSON.stringify({ extensions: { settings: { [EXT_ID]: { location: 4, path: dst, state: 1 } } } }, null, 2), 'utf-8');
        }
        return { ok: true, version, dst };
    } catch(e) { return { ok: false, msg: e.message }; }
});

ipcMain.handle('ublock-check', () => {
    const src      = resPath('assets', 'ublock');
    const manifest = path.join(src, 'manifest.json');
    const exists   = fs.existsSync(src);
    const hasManifest = fs.existsSync(manifest);
    let version = null;
    if (hasManifest) { try { version = JSON.parse(fs.readFileSync(manifest,'utf-8')).version; } catch(_) {} }
    return { exists, hasManifest, version };
});

// =====================================================
//   ZAPRET AUTO-UPDATE
// =====================================================
const https  = require('https');
const os     = require('os');
const zlib   = require('zlib');

// Читаем версию из Zapret/version.txt или из имени папки
function getZapretVersion() {
    const vFile = resPath('Zapret', 'version.txt');
    if (fs.existsSync(vFile)) {
        try { return fs.readFileSync(vFile, 'utf-8').trim(); } catch(_) {}
    }
    // Fallback — ищем в самом zip или просто возвращаем "Неизвестно"
    return 'Неизвестно';
}

ipcMain.handle('zapret-version', () => {
    return {
        version: getZapretVersion(),
        path:    resPath('Zapret'),
    };
});

// Запрос к GitHub API с https (без axios/fetch — только встроенный Node.js)
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const opts = new URL(url);
        const req  = https.get({
            hostname: opts.hostname,
            path:     opts.pathname + opts.search,
            headers:  {
                'User-Agent':  'Artofix/2.3',
                'Accept':      'application/vnd.github+json',
            },
        }, (res) => {
            // follow redirects
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                return httpsGet(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
        });
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('Таймаут соединения с GitHub')); });
    });
}

ipcMain.handle('zapret-check-update', async () => {
    try {
        const resp = await httpsGet('https://api.github.com/repos/Flowseal/zapret-discord-youtube/releases/latest');
        if (resp.statusCode !== 200) return { ok: false, msg: 'GitHub ответил: ' + resp.statusCode };

        const rel = JSON.parse(resp.body);
        const tag = rel.tag_name; // напр. "1.9.7b"

        // Имя файла у Flowseal: zapret-discord-youtube-{tag}.zip
        const expectedName = `zapret-discord-youtube-${tag}.zip`;
        let asset = (rel.assets || []).find(a => a.name === expectedName);

        // Fallback — любой .zip среди ассетов
        if (!asset) asset = (rel.assets || []).find(a => a.name && a.name.endsWith('.zip'));

        // Последний fallback — zipball (исходники)
        if (!asset) {
            asset = {
                name: expectedName,
                browser_download_url: rel.zipball_url,
                size: 0,
            };
        }

        const currentVersion = getZapretVersion();
        const needsUpdate    = currentVersion !== tag;

        return {
            ok:             true,
            latestTag:      tag,
            assetUrl:       asset.browser_download_url,
            assetName:      asset.name,
            assetSizeMb:    asset.size ? (asset.size / 1024 / 1024).toFixed(1) : null,
            publishedAt:    rel.published_at ? rel.published_at.slice(0, 10) : '—',
            body:           rel.body || '',
            currentVersion,
            needsUpdate,
        };
    } catch(e) {
        return { ok: false, msg: e.message };
    }
});

// Скачиваем файл с прогрессом
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        function doGet(u) {
            https.get(u, {
                headers: { 'User-Agent': 'Artofix/2.3' }
            }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                    return doGet(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    file.close();
                    return reject(new Error('HTTP ' + res.statusCode));
                }

                const total   = parseInt(res.headers['content-length'] || '0', 10);
                let received  = 0;
                let lastSent  = 0;

                res.on('data', (chunk) => {
                    received += chunk.length;
                    file.write(chunk);
                    if (total > 0 && (received - lastSent) > 200_000) { // каждые ~200кб
                        lastSent = received;
                        const pct  = (received / total * 100);
                        const dlMb = (received / 1024 / 1024).toFixed(1);
                        const totMb = (total   / 1024 / 1024).toFixed(1);
                        if (win && !win.isDestroyed()) win.webContents.send('zapret-dl-progress', { pct, downloaded: dlMb, total: totMb });
                    }
                });
                res.on('end', () => { file.close(); resolve(destPath); });
                res.on('error', (e) => { file.close(); reject(e); });
            }).on('error', (e) => { file.close(); reject(e); });
        }
        doGet(url);
        file.on('error', reject);
    });
}

// Распаковка ZIP (встроенный Node.js через zlib/unzip — нет JSZip)
// Используем PowerShell Expand-Archive — надёжнее всего на Windows
function unzipWithPowerShell(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        // Expand-Archive распаковывает в папку, создаёт подпапку с именем zip
        const ps = `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`;
        const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error('PowerShell exit code: ' + code));
        });
    });
}

ipcMain.handle('zapret-do-update', async (_, { url, name, tag }) => {
    const stamp  = Date.now();
    const tmpZip = path.join(os.tmpdir(), `zapret_update_${stamp}.zip`);
    const tmpDir = path.join(os.tmpdir(), `zapret_update_${stamp}`);
    const zapDir = resPath('Zapret');

    try {
        // ── 1. Скачиваем ZIP ──
        if (win) win.webContents.send('zapret-dl-progress', { pct: 0, downloaded: '0', total: '?' });
        await downloadFile(url, tmpZip);

        // ── 2. Распаковываем во временную папку ──
        fs.mkdirSync(tmpDir, { recursive: true });
        await unzipWithPowerShell(tmpZip, tmpDir);

        // ── 3. Находим корень внутри zip (обычно zapret-vXX/ или просто файлы) ──
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        let srcDir = tmpDir;
        if (entries.length === 1 && entries[0].isDirectory()) {
            srcDir = path.join(tmpDir, entries[0].name);
        }

        // ── 4. Сохраняем пользовательские файлы Flowseal ──
        // Корневые bat-конфиги
        const SAVE_ROOT  = ['config.bat', 'run_zapret.bat', 'blockcheck.bat'];
        // Пользовательские списки Flowseal (создаются самим zapret при первом запуске)
        const SAVE_LISTS = ['ipset-exclude-user.txt', 'list-general-user.txt', 'list-exclude-user.txt'];

        const savedRoot  = {};
        const savedLists = {};
        for (const f of SAVE_ROOT)  { const p = path.join(zapDir, f);          if (fs.existsSync(p)) savedRoot[f]  = fs.readFileSync(p); }
        for (const f of SAVE_LISTS) { const p = path.join(zapDir, 'lists', f); if (fs.existsSync(p)) savedLists[f] = fs.readFileSync(p); }

        // ── 5. Полностью сносим старую папку Zapret ──
        if (fs.existsSync(zapDir)) fs.rmSync(zapDir, { recursive: true, force: true });

        // ── 6. Копируем новую версию целиком ──
        copyDirRecursive(srcDir, zapDir);

        // ── 7. Восстанавливаем пользовательские файлы ──
        for (const [f, buf] of Object.entries(savedRoot))  fs.writeFileSync(path.join(zapDir, f), buf);
        fs.mkdirSync(path.join(zapDir, 'lists'), { recursive: true });
        for (const [f, buf] of Object.entries(savedLists)) fs.writeFileSync(path.join(zapDir, 'lists', f), buf);

        // ── 8. Пишем version.txt ──
        fs.writeFileSync(path.join(zapDir, 'version.txt'), tag, 'utf-8');

        // ── 9. Чистим tmp ──
        try { fs.unlinkSync(tmpZip); } catch(_) {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}

        return { ok: true };
    } catch(e) {
        try { fs.unlinkSync(tmpZip); } catch(_) {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
        return { ok: false, msg: e.message };
    }
});

function copyDirRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) copyDirRecursive(s, d);
        else fs.copyFileSync(s, d);
    }
}

// =====================================================
//   ДИАГНОСТИКА КОМПОНЕНТОВ — IPC
// =====================================================

// Найти версию Chrome из реестра
function getChromeVersion() {
    return new Promise(resolve => {
        const keys = [
            'HKLM\\SOFTWARE\\Google\\Chrome\\BLBeacon',
            'HKLM\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\BLBeacon',
            'HKCU\\SOFTWARE\\Google\\Chrome\\BLBeacon',
        ];
        let idx = 0;
        const tryNext = () => {
            if (idx >= keys.length) return resolve(null);
            exec(`reg query "${keys[idx]}" /v version`, { windowsHide:true }, (err, out) => {
                idx++;
                if (!err && out) {
                    const m = out.match(/version\s+REG_SZ\s+([\d.]+)/i);
                    if (m) return resolve(m[1]);
                }
                tryNext();
            });
        };
        tryNext();
    });
}

// Найти версию Edge из реестра
function getEdgeVersion() {
    return new Promise(resolve => {
        const keys = [
            'HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}',
            'HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}',
        ];
        let idx = 0;
        const tryNext = () => {
            if (idx >= keys.length) return resolve(null);
            exec(`reg query "${keys[idx]}" /v pv`, { windowsHide:true }, (err, out) => {
                idx++;
                if (!err && out) {
                    const m = out.match(/pv\s+REG_SZ\s+([\d.]+)/i);
                    if (m) return resolve(m[1]);
                }
                tryNext();
            });
        };
        tryNext();
    });
}

// Получить мажорную версию из строки "120.0.6099.129" → 120
function majorVer(v) { return v ? parseInt(v.split('.')[0]) : 0; }

ipcMain.handle('diag-check', async (_, { component, pkg }) => {
    const python = findPython();
    const run = (cmd) => new Promise(r => exec(cmd, { windowsHide:true }, (e,o,s) => r({ ok:!e, out:(o||'').trim(), err:(s||'').trim() })));

    switch (component) {
        case 'python': {
            const r = await run(`${python} --version`);
            const ver = (r.out || r.err).match(/Python ([\d.]+)/i);
            if (ver) return { status:'ok', version: ver[1] };
            return { status:'err', note:'не найден' };
        }
        case 'pip': {
            const r = await run(`${python} -m pip --version`);
            const ver = r.out.match(/pip ([\d.]+)/i);
            if (ver) return { status:'ok', version: ver[1] };
            return { status:'err' };
        }
        case 'selenium':
        case 'stealth':
        case 'wdm': {
            const modName = { selenium:'selenium', stealth:'selenium_stealth', wdm:'webdriver_manager' }[component] || pkg;
            const r = await run(`${python} -c "import importlib.metadata; print(importlib.metadata.version('${modName.replace(/_/g,'-')}'))"`);
            if (r.ok && r.out) return { status:'ok', version: r.out };
            // Fallback для старого pip
            const r2 = await run(`${python} -c "import ${modName}; print(getattr(${modName},'__version__','?'))"`);
            if (r2.ok) return { status:'ok', version: r2.out };
            return { status:'err', note:'не установлен' };
        }
        case 'chrome': {
            const ver = await getChromeVersion();
            if (ver) return { status:'ok', version: ver };
            // Проверяем через путь
            const paths = [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            ];
            for (const p of paths) { if (fs.existsSync(p)) return { status:'ok', version:'установлен', note: p }; }
            return { status:'err', note:'не найден' };
        }
        case 'chromedrv': {
            const chromeVer = await getChromeVersion();
            const chromeMajor = majorVer(chromeVer);
            // Проверяем через wdm — не PATH, а кэш драйверов
            const r = await run(`${python} -c "from webdriver_manager.chrome import ChromeDriverManager; p=ChromeDriverManager().install(); print(p)"`);
            if (r.ok && r.out && !r.out.includes('Error') && !r.out.includes('Traceback')) {
                const vm = r.out.match(/[\\/]([\d.]+)[\\/]/);
                const drvVer = vm ? vm[1] : 'ok';
                const drvMajor = majorVer(drvVer);
                if (chromeMajor && drvMajor && Math.abs(chromeMajor - drvMajor) > 3) {
                    return { status:'warn', version: drvVer, note: `Chrome ${chromeMajor} vs драйвер ${drvMajor}` };
                }
                return { status:'ok', version: drvVer };
            }
            return { status:'err', note:'не скачан — нажми Установить' };
        }
        case 'edge': {
            const ver = await getEdgeVersion();
            if (ver) return { status:'ok', version: ver };
            const p = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
            if (fs.existsSync(p)) return { status:'ok', version:'установлен' };
            return { status:'err', note:'не найден' };
        }
        case 'edgedrv': {
            const edgeVer = await getEdgeVersion();
            const edgeMajor = majorVer(edgeVer);
            const r = await run(`${python} -c "from webdriver_manager.microsoft import EdgeChromiumDriverManager; p=EdgeChromiumDriverManager().install(); print(p)"`);
            if (r.ok && r.out && !r.out.includes('Error') && !r.out.includes('Traceback')) {
                const vm = r.out.match(/[\\/]([\d.]+)[\\/]/);
                const drvVer = vm ? vm[1] : 'ok';
                const drvMajor = majorVer(drvVer);
                if (edgeMajor && drvMajor && Math.abs(edgeMajor - drvMajor) > 3) {
                    return { status:'warn', version: drvVer, note: `Edge ${edgeMajor} vs драйвер ${drvMajor}` };
                }
                return { status:'ok', version: drvVer };
            }
            return { status:'err', note:'не скачан — нажми Установить' };
        }
        default:
            return { status:'err', note:'unknown component' };
    }
});

ipcMain.handle('diag-install', async (event, { components }) => {
    const python = findPython();
    const log  = (msg, type) => { try { event.sender.send('diag-log', { msg, type }); } catch(_){} };
    const prog = (pct, label) => { try { event.sender.send('diag-progress', { pct, label }); } catch(_){} };

    const runCmd = (cmd, opts) => new Promise(resolve => {
        const proc = exec(cmd, { windowsHide:true, ...(opts||{}) }, (e,o,s) => resolve({ ok:!e, out:(o||'').trim(), err:(s||'').trim() }));
        proc.stdout && proc.stdout.on('data', d => log(d.toString().trim(), 'info'));
        proc.stderr && proc.stderr.on('data', d => {
            const s = d.toString().trim();
            if (s && !s.startsWith('WARNING')) log(s, 'warn');
        });
    });

    const total = components.length;
    let done = 0;

    for (const cid of components) {
        done++;
        const pct = Math.round((done / (total+1)) * 90);

        switch (cid) {
            case 'pip': {
                prog(pct, 'Обновление pip...');
                log('► Обновление pip...', 'step');
                await runCmd(`${python} -m pip install --upgrade pip`, { timeout:60000 });
                log('✓ pip обновлён', 'ok');
                break;
            }
            case 'selenium': {
                prog(pct, 'selenium...');
                log('► pip install selenium', 'step');
                const r = await runCmd(`${python} -m pip install --upgrade selenium`, { timeout:120000 });
                log(r.ok ? '✓ selenium установлен' : '✗ selenium: ' + r.err, r.ok ? 'ok' : 'err');
                break;
            }
            case 'stealth': {
                prog(pct, 'selenium-stealth...');
                log('► pip install selenium-stealth', 'step');
                const r = await runCmd(`${python} -m pip install --upgrade selenium-stealth`, { timeout:120000 });
                log(r.ok ? '✓ selenium-stealth установлен' : '✗ selenium-stealth: ' + r.err, r.ok ? 'ok' : 'err');
                break;
            }
            case 'wdm': {
                prog(pct, 'webdriver-manager...');
                log('► pip install webdriver-manager', 'step');
                const r = await runCmd(`${python} -m pip install --upgrade webdriver-manager`, { timeout:120000 });
                log(r.ok ? '✓ webdriver-manager установлен' : '✗ webdriver-manager: ' + r.err, r.ok ? 'ok' : 'err');
                break;
            }
            case 'chromedrv': {
                prog(pct, 'ChromeDriver...');
                log('► Определяю версию Chrome из реестра...', 'step');
                const chromeVer = await getChromeVersion();
                const cMajor    = majorVer(chromeVer);
                log(chromeVer ? `✓ Chrome ${chromeVer} (мажор: ${cMajor})` : '⚠ Версия Chrome не найдена', chromeVer ? 'ok' : 'warn');

                log('► Очищаю старые кэши ChromeDriver...', 'step');
                const wdmChrome = path.join(
                    process.env.USERPROFILE || process.env.HOME || '',
                    '.wdm', 'drivers', 'chromedriver'
                );
                if (fs.existsSync(wdmChrome)) {
                    try {
                        let removed = 0;
                        for (const entry of fs.readdirSync(wdmChrome)) {
                            if (cMajor && !entry.startsWith(String(cMajor))) {
                                fs.rmSync(path.join(wdmChrome, entry), { recursive: true, force: true });
                                removed++;
                            }
                        }
                        if (removed > 0) log(`✓ Удалено старых кэшей: ${removed}`, 'ok');
                        else log('✓ Старых кэшей нет', 'ok');
                    } catch(e) { log('⚠ ' + e.message, 'warn'); }
                }

                log(`► Скачиваю ChromeDriver ${chromeVer || '(последний)'}...`, 'step');
                const tmpChrome = path.join(require('os').tmpdir(), 'artofix_chromedrv.py');
                fs.writeFileSync(tmpChrome, [
                    'import sys, os',
                    'os.environ["WDM_LOG"] = "0"',
                    'from webdriver_manager.chrome import ChromeDriverManager',
                    chromeVer
                        ? `driver_version = "${chromeVer}"`
                        : 'driver_version = None',
                    'try:',
                    '    mgr = ChromeDriverManager(version=driver_version) if driver_version else ChromeDriverManager()',
                    '    p = mgr.install()',
                    '    print("OK:", p)',
                    'except Exception as e:',
                    '    try:',
                    '        p = ChromeDriverManager().install()',
                    '        print("OK:", p)',
                    '    except Exception as e2:',
                    '        print("ERR:", e2)',
                    '        sys.exit(1)',
                ].join('\n'));
                const rc = await runCmd(`${python} "${tmpChrome}"`, { timeout: 180000 });
                try { fs.unlinkSync(tmpChrome); } catch(_) {}
                if (rc.ok && rc.out.includes('OK')) {
                    log('✓ ChromeDriver установлен: ' + rc.out.replace('OK: ', ''), 'ok');
                } else {
                    log('✗ ChromeDriver: ' + (rc.err || rc.out || 'неизвестная ошибка'), 'err');
                }
                break;
            }
            case 'edgedrv': {
                prog(pct, 'EdgeDriver...');

                // 1. Читаем точную версию Edge из реестра
                log('► Читаю версию Edge из реестра...', 'step');
                const edgeVer = await getEdgeVersion();
                if (!edgeVer) {
                    log('✗ Microsoft Edge не найден на компьютере', 'err');
                    break;
                }
                const eMajor = majorVer(edgeVer);
                log(`✓ Edge ${edgeVer} (мажор: ${eMajor})`, 'ok');

                // 2. Зачищаем ВСЕ старые драйверы из кэша wdm
                log('► Очищаю кэш старых EdgeDriver...', 'step');
                const wdmEdgeDir = path.join(
                    process.env.USERPROFILE || process.env.HOME || '',
                    '.wdm', 'drivers', 'msedgedriver'
                );
                if (fs.existsSync(wdmEdgeDir)) {
                    try {
                        fs.rmSync(wdmEdgeDir, { recursive: true, force: true });
                        log('✓ Старый кэш удалён', 'ok');
                    } catch(e) { log('⚠ Кэш не удалось удалить: ' + e.message, 'warn'); }
                } else {
                    log('✓ Кэш пуст', 'ok');
                }

                // 3. Скачиваем точную версию драйвера напрямую от Microsoft
                // URL: https://msedgedriver.azureedge.net/{version}/edgedriver_win64.zip
                log(`► Скачиваю msedgedriver ${edgeVer} от Microsoft...`, 'step');
                const drvUrl = `https://msedgedriver.azureedge.net/${edgeVer}/edgedriver_win64.zip`;
                const tmpZip = path.join(require('os').tmpdir(), `edgedriver_${edgeVer}.zip`);
                const tmpDir = path.join(require('os').tmpdir(), `edgedriver_${edgeVer}`);
                // Целевая папка — рядом с программой (dataPath)
                const drvDestDir = dataPath('drivers');
                const drvDestExe = path.join(drvDestDir, 'msedgedriver.exe');

                try { fs.mkdirSync(drvDestDir, { recursive: true }); } catch(_) {}

                // Скачиваем через PowerShell (встроен везде)
                const dlScript = `
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri '${drvUrl}' -OutFile '${tmpZip.replace(/\\/g,'\\\\')}' -UseBasicParsing
    Write-Output 'DOWNLOADED'
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
                `.trim();
                const dlRes = await runCmd(`powershell -NoProfile -NonInteractive -Command "${dlScript.replace(/\n/g,' ')}"`, { timeout: 120000 });
                if (!dlRes.ok || !dlRes.out.includes('DOWNLOADED')) {
                    log('✗ Не удалось скачать: ' + (dlRes.err || dlRes.out), 'err');
                    log('  Попробуй вручную: ' + drvUrl, 'warn');
                    break;
                }
                log('✓ Архив скачан', 'ok');

                // Распаковываем
                log('► Распаковываю архив...', 'step');
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
                const unzipRes = await runCmd(
                    `powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${tmpZip.replace(/\\/g,'\\\\')}' -DestinationPath '${tmpDir.replace(/\\/g,'\\\\')}' -Force"`,
                    { timeout: 30000 }
                );
                // Ищем msedgedriver.exe в распакованном (может быть в подпапке)
                let foundExe = null;
                const findExe = (dir) => {
                    try {
                        for (const f of fs.readdirSync(dir)) {
                            const fp = path.join(dir, f);
                            if (f.toLowerCase() === 'msedgedriver.exe') { foundExe = fp; return; }
                            if (fs.statSync(fp).isDirectory()) findExe(fp);
                        }
                    } catch(_) {}
                };
                findExe(tmpDir);

                if (!foundExe) {
                    log('✗ msedgedriver.exe не найден в архиве', 'err');
                    break;
                }

                // Копируем в папку drivers/ рядом с программой
                try { fs.copyFileSync(foundExe, drvDestExe); } catch(e) {
                    log('✗ Не удалось скопировать: ' + e.message, 'err');
                    break;
                }

                // Чистим временные файлы
                try { fs.unlinkSync(tmpZip); } catch(_) {}
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}

                log(`✓ msedgedriver ${edgeVer} установлен → ${drvDestExe}`, 'ok');

                // 4. Записываем путь к драйверу в конфиг чтобы engine.py знал где он
                try {
                    const cfgPath = dataPath('config.json');
                    let cfg = {};
                    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch(_) {}
                    cfg.edgedriver_path = drvDestExe;
                    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
                    log('✓ Путь к драйверу сохранён в config.json', 'ok');
                } catch(e) { log('⚠ Не удалось записать config: ' + e.message, 'warn'); }

                break;
            }
            default:
                log('⚠ Пропускаем ' + cid + ' (ручная установка)', 'warn');
        }
    }

    prog(100, 'Готово!');
    return { ok: true };
});

// =====================================================
//   ЧЕБУРНЕТ — IPC
// =====================================================

// TCP connect — самый надёжный способ проверить доступность.
// Не зависит от HTTP статусов, редиректов, HEAD-блокировок.
// Если сайт заблокирован — TCP SYN либо дропается (таймаут) либо RST (ошибка).
ipcMain.handle('cbn-ping', async (_, { host, port }) => {
    return new Promise((resolve) => {
        const net = require('net');
        const t0  = Date.now();
        port = port || 443;

        let settled = false;
        const done = (ok, err) => {
            if (settled) return;
            settled = true;
            resolve({ ok, ping: Date.now() - t0, err: err || null });
        };

        const sock = new net.Socket();
        sock.setTimeout(5000);

        sock.connect(port, host, () => {
            sock.destroy();
            done(true);
        });
        sock.on('error',   (e) => done(false, e.code || e.message));
        sock.on('timeout', ()  => { sock.destroy(); done(false, 'TIMEOUT'); });
    });
});

ipcMain.handle('cbn-set-dns', (_, { dns1, dns2 }) => {
    return new Promise((resolve) => {
        // Получаем список сетевых интерфейсов и меняем DNS через netsh
        const script = `
$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceAlias
foreach ($a in $adapters) {
    try {
        Set-DnsClientServerAddress -InterfaceAlias $a -ServerAddresses ('${dns1}','${dns2}') -ErrorAction SilentlyContinue
    } catch {}
}
Write-Output 'done'
        `.trim();
        const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        let out = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.on('exit', code => resolve({ ok: code === 0, msg: out.trim() }));
        proc.on('error', e => resolve({ ok: false, msg: e.message }));
    });
});

ipcMain.handle('cbn-reset-dns', () => {
    return new Promise((resolve) => {
        const script = `
$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceAlias
foreach ($a in $adapters) {
    try {
        Set-DnsClientServerAddress -InterfaceAlias $a -ResetServerAddresses -ErrorAction SilentlyContinue
    } catch {}
}
Write-Output 'done'
        `.trim();
        const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        let out = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.on('exit', code => resolve({ ok: code === 0, msg: out.trim() }));
        proc.on('error', e => resolve({ ok: false, msg: e.message }));
    });
});

// =====================================================
//   SETUP / УСТАНОВЩИК
// =====================================================

let setupWin = null;

// Проверяем нужен ли setup (флаг-файл рядом с exe)
function needsSetup() {
    const flag = dataPath('.artofix_setup_done');
    return !fs.existsSync(flag);
}
function markSetupDone() {
    fs.writeFileSync(dataPath('.artofix_setup_done'), new Date().toISOString(), 'utf-8');
}

function sendSetup(event, data) {
    if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send(event, data);
}

function createSetupWindow() {
    setupWin = new BrowserWindow({
        width: 560, height: 540,
        resizable: false, frame: false,
        transparent: false, backgroundColor: '#04050f',
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        center: true,
    });
    setupWin.loadFile(path.join(__dirname, 'setup.html'));
}

// Запуск команды с логом в setup окно
function runSetupCmd(cmd, opts) {
    return new Promise((resolve) => {
        const proc = exec(cmd, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, code: err ? err.code : 0, stdout, stderr });
        });
        proc.stdout && proc.stdout.on('data', d => sendSetup('setup-log', d.toString()));
        proc.stderr && proc.stderr.on('data', d => sendSetup('setup-log', d.toString()));
    });
}

// Главная логика установки
async function runSetup() {
    const log  = (msg, type) => sendSetup('setup-log', { msg, type: type || 'info' });
    const step = (text, pct) => sendSetup('setup-step', { text, pct });

    // ── Шаг 1: Проверка Python ──
    step('Проверка Python...', 5);
    await new Promise(r => setTimeout(r, 300));

    let pythonCmd = null;
    for (const cmd of ['python', 'python3', 'py']) {
        const r = await runSetupCmd(`${cmd} --version`);
        const out = (r.stdout || r.stderr || '').trim();
        if (out.includes('Python 3')) {
            pythonCmd = cmd;
            log(`✓ Python найден (${cmd}): ${out}`, 'ok');
            break;
        }
    }

    if (!pythonCmd) {
        const installer = resPath('install', 'python-3.13.1-amd64.exe');
        if (!fs.existsSync(installer)) {
            sendSetup('setup-error', 'Python не найден. Положи python-3.13.1-amd64.exe в папку install/');
            return;
        }
        step('Установка Python 3.13...', 15);
        log('Устанавливаю Python...', 'info');
        const r = await runSetupCmd(`"${installer}" /quiet InstallAllUsers=1 PrependPath=1 Include_test=0`, { timeout: 180000 });
        if (!r.ok) { sendSetup('setup-error', 'Не удалось установить Python'); return; }
        log('✓ Python установлен — нужен перезапуск', 'ok');
        sendSetup('setup-need-restart', 'Python установлен. Перезапусти Artofix.');
        return;
    }

    // ── Шаг 2: pip ──
    step('Обновление pip...', 20);
    await runSetupCmd(`${pythonCmd} -m pip install --upgrade pip -q`, { timeout: 60000 });
    log('✓ pip обновлён', 'ok');

    // ── Шаг 3: selenium ──
    step('Установка selenium...', 35);
    log('pip install selenium...', 'info');
    const r3 = await runSetupCmd(`${pythonCmd} -m pip install --upgrade selenium -q`, { timeout: 120000 });
    log(r3.ok ? '✓ selenium установлен' : '✗ selenium: ' + r3.stderr, r3.ok ? 'ok' : 'err');

    // ── Шаг 4: selenium-stealth ──
    step('Установка selenium-stealth...', 50);
    log('pip install selenium-stealth...', 'info');
    const r4 = await runSetupCmd(`${pythonCmd} -m pip install --upgrade selenium-stealth -q`, { timeout: 120000 });
    log(r4.ok ? '✓ selenium-stealth установлен' : '✗ selenium-stealth: ' + r4.stderr, r4.ok ? 'ok' : 'err');

    // ── Шаг 5: webdriver-manager ──
    step('Установка webdriver-manager...', 65);
    log('pip install webdriver-manager...', 'info');
    const r5 = await runSetupCmd(`${pythonCmd} -m pip install --upgrade webdriver-manager -q`, { timeout: 120000 });
    log(r5.ok ? '✓ webdriver-manager установлен' : '✗ webdriver-manager: ' + r5.stderr, r5.ok ? 'ok' : 'err');

    // ── Шаг 6: ChromeDriver ──
    step('Загрузка ChromeDriver...', 78);
    log('Определяю версию Chrome...', 'info');
    const chromeVerSetup = await getChromeVersion();
    const cMajorSetup    = majorVer(chromeVerSetup);
    log(chromeVerSetup ? `Chrome ${chromeVerSetup}` : 'Версия Chrome не найдена — скачаю последний', chromeVerSetup ? 'ok' : 'info');
    const tmpC = path.join(require('os').tmpdir(), 'artofix_setup_chrome.py');
    fs.writeFileSync(tmpC, [
        'import sys, os',
        'os.environ["WDM_LOG"] = "0"',
        'from webdriver_manager.chrome import ChromeDriverManager',
        chromeVerSetup ? `v = "${chromeVerSetup}"` : 'v = None',
        'try:',
        '    p = (ChromeDriverManager(version=v) if v else ChromeDriverManager()).install()',
        '    print("OK", p)',
        'except Exception as e:',
        '    try: p = ChromeDriverManager().install(); print("OK", p)',
        '    except Exception as e2: print("ERR", e2); sys.exit(1)',
    ].join('\n'));
    const r6 = await runSetupCmd(`${pythonCmd} "${tmpC}"`, { timeout: 120000 });
    try { fs.unlinkSync(tmpC); } catch(_) {}
    log(r6.ok && r6.stdout.includes('OK') ? '✓ ChromeDriver готов' : '⚠ ChromeDriver: ' + (r6.stderr||r6.stdout||'').trim().slice(0,100), r6.ok ? 'ok' : 'warn');

    // ── Шаг 7: EdgeDriver ──
    step('Загрузка EdgeDriver...', 90);
    log('Определяю версию Edge...', 'info');
    const edgeVerSetup = await getEdgeVersion();
    const eMajorSetup  = majorVer(edgeVerSetup);
    log(edgeVerSetup ? `Edge ${edgeVerSetup}` : 'Edge не найден — скачаю последний', edgeVerSetup ? 'ok' : 'info');
    // Чистим старый кэш
    const wdmEdgeDir = path.join(process.env.USERPROFILE || '', '.wdm', 'drivers', 'msedgedriver');
    if (fs.existsSync(wdmEdgeDir)) {
        try {
            let removed = 0;
            for (const e of fs.readdirSync(wdmEdgeDir)) {
                if (eMajorSetup && !e.startsWith(String(eMajorSetup))) {
                    fs.rmSync(path.join(wdmEdgeDir, e), { recursive: true, force: true });
                    removed++;
                }
            }
            if (removed) log(`Очищено старых кэшей Edge: ${removed}`, 'info');
        } catch(_) {}
    }
    const tmpE = path.join(require('os').tmpdir(), 'artofix_setup_edge.py');
    fs.writeFileSync(tmpE, [
        'import sys, os',
        'os.environ["WDM_LOG"] = "0"',
        'from webdriver_manager.microsoft import EdgeChromiumDriverManager',
        edgeVerSetup ? `v = "${edgeVerSetup}"` : 'v = None',
        'try:',
        '    p = (EdgeChromiumDriverManager(version=v) if v else EdgeChromiumDriverManager()).install()',
        '    print("OK", p)',
        'except Exception as e:',
        '    try: p = EdgeChromiumDriverManager().install(); print("OK", p)',
        '    except Exception as e2: print("ERR", e2); sys.exit(1)',
    ].join('\n'));
    const r7 = await runSetupCmd(`${pythonCmd} "${tmpE}"`, { timeout: 120000 });
    try { fs.unlinkSync(tmpE); } catch(_) {}
    log(r7.ok && r7.stdout.includes('OK') ? '✓ EdgeDriver готов' : '⚠ EdgeDriver: ' + (r7.stderr||r7.stdout||'').trim().slice(0,100), r7.ok ? 'ok' : 'warn');

    // ── Готово ──
    step('Установка завершена!', 100);
    log('✅ Все компоненты установлены!', 'ok');
    markSetupDone();
    await new Promise(r => setTimeout(r, 1200));
    sendSetup('setup-done', true);
}

ipcMain.on('setup-start', () => runSetup());
ipcMain.on('setup-skip',  () => { markSetupDone(); sendSetup('setup-done', true); });

app.whenReady().then(() => {
    if (needsSetup()) {
        createSetupWindow();
        setupWin.once('ready-to-show', () => {
            setupWin.show();
            // Авто-старт через секунду
            setTimeout(() => runSetup(), 1000);
        });
        // Когда setup завершён — открываем главное окно
        ipcMain.once('open-main', () => {
            if (setupWin && !setupWin.isDestroyed()) setupWin.close();
            createWindow();
            createTray();
            checkAdmin();
        });
    } else {
        createWindow();
        createTray();
        checkAdmin();
    }
});

function checkAdmin() {
    if (!isAdmin()) {
        const choice = dialog.showMessageBoxSync({
            type: 'question',
            title: 'Artofix — Права администратора',
            message: 'Для работы блокировки рекламы (hosts-файл) нужны права администратора.',
            detail: 'Перезапустить с правами администратора?\n\nЕсли откажешься — всё работает, но hosts-блокировка будет недоступна.',
            buttons: ['Перезапустить как администратор', 'Продолжить без прав'],
            defaultId: 0, cancelId: 1,
        });
        if (choice === 0) relaunchAsAdmin();
    }
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { isQuiting = true; if (zapretProcess) { try { process.kill(-zapretProcess.pid); } catch(_){} } });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
