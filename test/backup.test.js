const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const backup = require('../lib/backup');
const { tmpDir } = require('./helpers');

// Имя копии — с точностью до секунды, поэтому между копиями ждём.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function world(d) {
  fs.writeFileSync(path.join(d, 'server.properties'), 'level-name=w\n');
  for (const n of ['w', 'w_nether']) {
    fs.mkdirSync(path.join(d, n, 'region'), { recursive: true });
    fs.writeFileSync(path.join(d, n, 'level.dat'), 'data-' + n);
    fs.writeFileSync(path.join(d, n, 'session.lock'), 'lock');
  }
}

test('копия и восстановление мира, текущий мир сохраняется перед восстановлением', async (t) => {
  const d = tmpDir(t);
  world(d);
  assert.deepEqual(backup.worldDirs(d), ['w', 'w_nether']);
  const b = await backup.create(d, 'manual');
  fs.writeFileSync(path.join(d, 'w', 'level.dat'), 'CHANGED');
  fs.mkdirSync(path.join(d, 'w', 'new'));
  await sleep(1100);
  const r = await backup.restore(d, b.file);
  assert.equal(fs.readFileSync(path.join(d, 'w', 'level.dat'), 'utf8'), 'data-w');
  assert.ok(!fs.existsSync(path.join(d, 'w', 'new')));
  assert.ok(r.safety && r.safety.endsWith('_before-restore.tar.gz'));
});

test('лишние автокопии удаляются, ручные — нет', async (t) => {
  const d = tmpDir(t);
  world(d);
  backup.writeSettings(d, { backup: { keep: 2 } });
  await backup.create(d, 'manual');
  for (let i = 0; i < 3; i++) {
    await sleep(1100);
    await backup.create(d, 'auto');
  }
  const reasons = backup.list(d).map((b) => b.reason);
  assert.equal(reasons.filter((r) => r === 'auto').length, 2);
  assert.equal(reasons.filter((r) => r === 'manual').length, 1);
});

test('настройки обслуживания проверяются', (t) => {
  const d = tmpDir(t);
  assert.throws(() => backup.writeSettings(d, { restart: { time: '25:00' } }), /ЧЧ:ММ/);
  assert.throws(() => backup.writeSettings(d, { backup: { everyHours: 5 } }), /интервал/);
  assert.throws(() => backup.backupPath(d, '../evil.tar.gz'), /Некорректное/);
  const s = backup.writeSettings(d, { restart: { enabled: true, time: '04:30' } });
  assert.deepEqual(s.restart, { enabled: true, time: '04:30' });
});
