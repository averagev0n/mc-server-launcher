'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const au = require('../lib/autoupdate');
const backup = require('../lib/backup');

const at = (h, m, day = 17) => new Date(2026, 10, day, h, m);

test('due: только в окне после назначенного времени и раз в день', () => {
  const cfg = { enabled: true, time: '04:30' };
  assert.equal(au.due(cfg, at(4, 29), {}), false);
  assert.equal(au.due(cfg, at(4, 30), {}), true);
  assert.equal(au.due(cfg, at(7, 29), {}), true, 'лаунчер включили позже — можно наверстать');
  assert.equal(au.due(cfg, at(7, 30), {}), false, 'окно 3 часа');
  assert.equal(au.due(cfg, at(5, 0), { lastRun: '2026-11-17' }), false, 'сегодня уже обновляли');
  assert.equal(au.due(cfg, at(5, 0, 18), { lastRun: '2026-11-17' }), true);
  assert.equal(au.due({ enabled: false, time: '04:30' }, at(5, 0), {}), false);
});

test('rollback возвращает старые файлы и список модов', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.mkdirSync(path.join(dir, 'backups', 'mods-2026-11-17'), { recursive: true });
  // Так выглядит папка после updateFile: новый файл в mods, старый — в backups.
  fs.writeFileSync(path.join(dir, 'mods', 'sodium-0.7.jar'), 'new');
  fs.writeFileSync(path.join(dir, 'backups', 'mods-2026-11-17', 'sodium-0.6.jar'), 'old');
  fs.writeFileSync(path.join(dir, 'modrinth.json'), '{"x":"new"}');
  const problems = au.rollback(dir, [{ folder: 'mods', oldFile: 'sodium-0.6.jar', newFile: 'sodium-0.7.jar', backup: path.join('backups', 'mods-2026-11-17') }], '{"x":"old"}');
  assert.deepEqual(problems, []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mods')), ['sodium-0.6.jar']);
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'sodium-0.6.jar'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(dir, 'modrinth.json'), 'utf8'), '{"x":"old"}');
  // Если старого файла нет — об этом сказано, остальное не ломается.
  const p2 = au.rollback(dir, [{ folder: 'mods', oldFile: 'gone.jar', newFile: 'gone2.jar', backup: 'backups/x' }], null);
  assert.equal(p2.length, 1);
});

test('состояние и временный мир', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(au.readState(dir), {});
  au.writeState(dir, { lastRun: '2026-11-17', last: { ok: true } });
  assert.equal(au.readState(dir).lastRun, '2026-11-17');
  fs.mkdirSync(path.join(dir, au.TEST_LEVEL));
  fs.mkdirSync(path.join(dir, au.TEST_LEVEL + '_nether'));
  au.clearTestWorld(dir);
  assert.ok(!fs.existsSync(path.join(dir, au.TEST_LEVEL)) && !fs.existsSync(path.join(dir, au.TEST_LEVEL + '_nether')));
  assert.deepEqual(au.failLines(['ok', 'java.lang.RuntimeException: boom', 'Caused by: x']), ['java.lang.RuntimeException: boom', 'Caused by: x']);
});

test('настройки автообновления', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(backup.readSettings(dir).autoupd, { enabled: false, time: '04:30' });
  assert.deepEqual(backup.writeSettings(dir, { autoupd: { enabled: true, time: '03:15' } }).autoupd, { enabled: true, time: '03:15' });
  assert.throws(() => backup.writeSettings(dir, { autoupd: { time: '25:00' } }), /ЧЧ:ММ/);
});
