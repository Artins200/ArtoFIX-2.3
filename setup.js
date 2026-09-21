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

// Делегированный диспетчер (inline-обработчики запрещены CSP)
var SETUP_ACTIONS = {
  skipSetup: skipSetup,        // кнопка «Пропустить» и крестик в титлбаре
  launchApp: launchApp,        // «Запустить Artofix»
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
  { pct: 25, id:'sd-pip'      },
  { pct: 35, id:'sd-selenium' },
  { pct: 65, id:'sd-chrome'   },
  { pct: 78, id:'sd-edge'     },
  { pct:100, id:'sd-done'     },
];
let lastPct = 0;

function updateSteps(pct) {
  STEP_MAP.forEach(function(s, i) {
    var el = document.getElementById(s.id);
    if (!el) return;
    el.classList.remove('active','done');
    if (pct > s.pct) el.classList.add('done');
    else if (pct >= (STEP_MAP[i-1] ? STEP_MAP[i-1].pct : 0)) el.classList.add('active');
  });
}

apiBridge.onSetupStep(function(d) {
  document.getElementById('step-label').textContent = '⏳ ' + d.text;
  document.getElementById('progress-bar').style.width = d.pct + '%';
  updateSteps(d.pct);
});

apiBridge.onSetupLog(function(d) {
  var box = document.getElementById('log-box');
  if (typeof d === 'string') {
    // raw stdout
    d.split('\n').forEach(function(line) {
      if (!line.trim()) return;
      var span = document.createElement('div');
      span.className = 'log-info';
      span.textContent = line;
      box.appendChild(span);
    });
  } else {
    var span = document.createElement('div');
    span.className = 'log-' + (d.type || 'info');
    span.textContent = d.msg;
    box.appendChild(span);
  }
  box.scrollTop = box.scrollHeight;
});

apiBridge.onSetupError(function(msg) {
  var el = document.getElementById('error-msg');
  el.textContent = '✗ ' + msg;
  el.classList.add('show');
  document.getElementById('step-label').textContent = '✗ Ошибка установки';
  document.getElementById('btn-skip').textContent = 'Пропустить';
});

apiBridge.onSetupRestart(function(msg) {
  var el = document.getElementById('restart-msg');
  el.textContent = '↺ ' + msg;
  el.classList.add('show');
  document.getElementById('step-label').textContent = '↺ Требуется перезапуск';
  document.getElementById('btn-restart').style.display = '';
  document.getElementById('btn-skip').style.display = 'none';
});

apiBridge.onSetupDone(function() {
  document.getElementById('progress-bar').style.width = '100%';
  document.getElementById('step-label').textContent = '✓ Готово!';
  document.getElementById('done-msg').classList.add('show');
  document.getElementById('btn-launch').style.display = '';
  document.getElementById('btn-skip').style.display = 'none';
  updateSteps(100);
  if (apiBridge) apiBridge.setupOpenMain();
});

function launchApp() { if (apiBridge) apiBridge.setupOpenMain(); }
function skipSetup() { if (apiBridge) { apiBridge.skipSetup(); apiBridge.setupOpenMain(); } }
