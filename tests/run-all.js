'use strict';
/* Прогон всех проверок: node tests/run-all.js */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const steps = [
  { name: 'security (валидация ввода, отпечатки)', cmd: process.execPath, args: ['tests/security.test.js'] },
  { name: 'wiring (разметка → рендерер → preload → main)', cmd: process.execPath, args: ['tests/wiring.test.js'] },
  { name: 'renderer-actions (исполнение UI-действий)', cmd: process.execPath, args: ['tests/renderer-actions.test.js'] },
  { name: 'pageinit (патчи антидетекта в браузере)', cmd: process.execPath, args: ['tests/pageinit.test.js'] },
  { name: 'main-smoke (запуск и IPC main-процесса)', cmd: process.execPath, args: ['tests/main-smoke.test.js'] },
  { name: 'engine (py: запуск браузера)', cmd: process.env.PYTHON || 'python3', args: ['tests/engine_test.py'] },
];

let failed = 0;
for (const step of steps) {
  console.log('\n── ' + step.name + ' ' + '─'.repeat(Math.max(0, 52 - step.name.length)));
  const r = spawnSync(step.cmd, step.args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log('\n' + (failed ? '✗ упало тестов: ' + failed : '✓ все проверки пройдены'));
process.exit(failed ? 1 : 0);
