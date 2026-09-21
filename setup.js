'use strict';
/* Установщик работает в тех же условиях, что и основной рендерер:
   sandbox + contextIsolation, никаких require() — только window.api. */

// Use a separate name: top-level var api would overwrite the read-only preload bridge.
var apiBridge = window.api || null;
if (!apiBridge || apiBridge.ready !== true) {
  document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById('error-msg');
    if (el) { el.textContent = '✗ Мост API не загружен — перезапусти установщик'; el.classList.add('show'); }
  });
}

function launchApp() { if (apiBridge) apiBridge.setupOpenMain(); }
function skipSetup() { if (apiBridge) { apiBridge.skipSetup(); apiBridge.setupOpenMain(); } }
function confirmInstall() {
  var permCard = document.getElementById('perm-card');
  if (permCard) permCard.style.display = 'none';
  var sl = document.getElementById('step-label');
  if (sl) sl.textContent = '⏳ Запуск установки...';
  if (apiBridge && typeof apiBridge.setupConfirmInstall === 'function') {
    apiBridge.setupConfirmInstall();
  }
}

// Делегированный диспетчер (inline-обработчики запрещены CSP)
var SETUP_ACTIONS = {
  skip: skipSetup,             // крестик в титлбаре
  skipSetup: skipSetup,        // кнопка «Пропустить»
  launchApp: launchApp,        // «Запустить Artofix»
  confirmInstall: confirmInstall, // Разрешение на установку компонентов
  restartApp: function () { if (apiBridge) apiBridge.winAct('restart'); },
};

document.addEventListener('click', function (ev) {
  var el = ev.target && ev.target.closest ? ev.target.closest('[data-af-on]') : null;
  if (!el || el.getAttribute('data-af-on') !== 'click') return;
  var fn = SETUP_ACTIONS[el.getAttribute('data-af-action')];
  if (typeof fn === 'function') fn();
}, true);

// ── Шаги по проценту ──
const STEP_MAP = [
  { pct:  5, id:'sd-python'   },
  { pct: 35, id:'sd-pip'      },
  { pct: 55, id:'sd-selenium' },
  { pct: 85, id:'sd-chrome'   },
  { pct: 95, id:'sd-edge'     },
  { pct:100, id:'sd-done'     },
];

function updateSteps(pct) {
  STEP_MAP.forEach(function(s, i) {
    var el = document.getElementById(s.id);
    if (!el) return;
    el.classList.remove('active','done');
    if (pct > s.pct) el.classList.add('done');
    else if (pct >= (STEP_MAP[i-1] ? STEP_MAP[i-1].pct : 0)) el.classList.add('active');
  });
}

// ── Аппаратный чекер (ОЗУ и ядра) ──
if (apiBridge && typeof apiBridge.onSetupHw === 'function') {
  apiBridge.onSetupHw(function (hw) {
    if (!hw) return;
    var coresEl = document.getElementById('hw-cores');
    if (coresEl) coresEl.textContent = hw.cores + ' ядер (' + (hw.cpuModel || 'CPU') + ')';
    var ramEl = document.getElementById('hw-ram');
    if (ramEl) ramEl.textContent = hw.totalRamGb + ' ГБ (свободно: ' + hw.freeRamGb + ' ГБ)';
    var badge = document.getElementById('hw-badge');
    if (badge) {
      badge.textContent = hw.meetsReqs ? '✓ Соответствует' : '⚠ Минимум';
      badge.className = 'hw-badge ' + (hw.meetsReqs ? 'ok' : 'warn');
    }
    var noteEl = document.getElementById('hw-note');
    if (noteEl) noteEl.textContent = hw.note || '';
  });
}

// ── Запрос разрешения на установку компонентов ──
if (apiBridge && typeof apiBridge.onSetupAskPerm === 'function') {
  apiBridge.onSetupAskPerm(function (info) {
    if (!info) return;
    var permCard = document.getElementById('perm-card');
    if (!permCard) return;

    if (info.needsInstallation) {
      permCard.style.display = 'flex';
      var listEl = document.getElementById('perm-list');
      if (listEl) {
        listEl.textContent = ''; // безопасно очищаем без innerHTML

        // Пункт Python
        var pyItem = document.createElement('div');
        pyItem.className = 'perm-item';
        var pyDot = document.createElement('span');
        pyDot.className = 'perm-item-dot ' + (info.hasPython ? 'ok' : 'needed');
        var pyText = document.createElement('span');
        pyText.textContent = info.hasPython
          ? '✓ Python 3: установлен (' + (info.pythonVersion || 'OK') + ')'
          : '⚡ Python 3.13: авто-скачивание с официального сайта python.org';
        pyItem.appendChild(pyDot);
        pyItem.appendChild(pyText);
        listEl.appendChild(pyItem);

        // Пункт библиотек
        var libItem = document.createElement('div');
        libItem.className = 'perm-item';
        var libDot = document.createElement('span');
        var hasMissing = Array.isArray(info.missingLibs) && info.missingLibs.length > 0;
        libDot.className = 'perm-item-dot ' + (hasMissing ? 'needed' : 'ok');
        var libText = document.createElement('span');
        libText.textContent = hasMissing
          ? '⚡ Библиотеки антидетекта: ' + info.missingLibs.join(', ') + ' (тихая установка pip)'
          : '✓ Библиотеки антидетекта: все установлены';
        libItem.appendChild(libDot);
        libItem.appendChild(libText);
        listEl.appendChild(libItem);
      }
      var sl = document.getElementById('step-label');
      if (sl) sl.textContent = '⏳ Требуется подтверждение установки';
    } else {
      permCard.style.display = 'none';
    }
  });
}

if (apiBridge && typeof apiBridge.onSetupStep === 'function') {
  apiBridge.onSetupStep(function (d) {
    var sl = document.getElementById('step-label');
    if (sl) sl.textContent = '⏳ ' + d.text;
    var pb = document.getElementById('progress-bar');
    if (pb) pb.style.width = d.pct + '%';
    updateSteps(d.pct);
  });
}

if (apiBridge && typeof apiBridge.onSetupLog === 'function') {
  apiBridge.onSetupLog(function (d) {
    var box = document.getElementById('log-box');
    if (!box) return;
    if (typeof d === 'string') {
      d.split('\n').forEach(function (line) {
        if (!line.trim()) return;
        var span = document.createElement('div');
        span.className = 'log-info';
        span.textContent = line;
        box.appendChild(span);
      });
    } else if (d && d.msg) {
      var span = document.createElement('div');
      span.className = 'log-' + (d.type || 'info');
      span.textContent = d.msg;
      box.appendChild(span);
    }
    box.scrollTop = box.scrollHeight;
  });
}

if (apiBridge && typeof apiBridge.onSetupError === 'function') {
  apiBridge.onSetupError(function (msg) {
    var el = document.getElementById('error-msg');
    if (el) {
      el.textContent = '✗ ' + msg;
      el.classList.add('show');
    }
    var sl = document.getElementById('step-label');
    if (sl) sl.textContent = '✗ Ошибка установки';
    var skipBtn = document.getElementById('btn-skip');
    if (skipBtn) skipBtn.textContent = 'Пропустить';
  });
}

if (apiBridge && typeof apiBridge.onSetupRestart === 'function') {
  apiBridge.onSetupRestart(function (msg) {
    var el = document.getElementById('restart-msg');
    if (el) {
      el.textContent = '↺ ' + msg;
      el.classList.add('show');
    }
    var sl = document.getElementById('step-label');
    if (sl) sl.textContent = '↺ Требуется перезапуск';
    var rBtn = document.getElementById('btn-restart');
    if (rBtn) rBtn.style.display = '';
    var sBtn = document.getElementById('btn-skip');
    if (sBtn) sBtn.style.display = 'none';
  });
}

if (apiBridge && typeof apiBridge.onSetupDone === 'function') {
  apiBridge.onSetupDone(function () {
    var pb = document.getElementById('progress-bar');
    if (pb) pb.style.width = '100%';
    var sl = document.getElementById('step-label');
    if (sl) sl.textContent = '✓ Готово!';
    var dm = document.getElementById('done-msg');
    if (dm) dm.classList.add('show');
    var lb = document.getElementById('btn-launch');
    if (lb) lb.style.display = '';
    var sb = document.getElementById('btn-skip');
    if (sb) sb.style.display = 'none';
    updateSteps(100);
    if (apiBridge) apiBridge.setupOpenMain();
  });
}
