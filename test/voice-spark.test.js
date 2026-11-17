'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const vc = require('../lib/voicechat');
const lag = require('../lib/lag');

test('голосовой чат: без мода — не установлен, порт по умолчанию', (t) => {
  const dir = tmpDir(t);
  const r = vc.read(dir, 25565);
  assert.equal(r.installed, false);
  assert.equal(r.port, 24454);
  assert.throws(() => vc.write(dir, { port: 24454, host: '' }), /установите/);
});

test('голосовой чат: мод — config/voicechat, плагин — plugins/voicechat', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'mods', 'voicechat-fabric-1.21.1-2.5.26.jar'), 'x');
  vc.write(dir, { port: 24500, host: 'castle.ply.gg:12345' });
  const file = path.join(dir, 'config', 'voicechat', 'voicechat-server.properties');
  assert.ok(fs.existsSync(file));
  const r = vc.read(dir, 25565);
  assert.deepEqual([r.kind, r.port, r.host, r.configured], ['mod', 24500, 'castle.ply.gg:12345', true]);

  const dir2 = tmpDir(t);
  fs.mkdirSync(path.join(dir2, 'plugins'));
  fs.writeFileSync(path.join(dir2, 'plugins', 'voicechat-bukkit-2.5.26.jar'), 'x');
  assert.equal(vc.installedKind(dir2), 'plugin');
  assert.ok(vc.configFile(dir2, 'plugin').includes(path.join('plugins', 'voicechat')));
});

test('голосовой чат: правка сохраняет остальные настройки и комментарии', () => {
  const src = '# Simple Voice Chat server config\nport=24454\nbind_address=\nmax_voice_distance=48.0\nvoice_host=\n';
  const out = vc.patch(src, { port: 25000, voice_host: 'a.b:1' });
  assert.equal(out, '# Simple Voice Chat server config\nport=25000\nbind_address=\nmax_voice_distance=48.0\nvoice_host=a.b:1\n');
  assert.equal(vc.parse('voice_host=host\\:123').voice_host, 'host:123');
  assert.equal(vc.effectivePort('-1', '25570'), 25570);
  assert.equal(vc.effectivePort('abc', 25565), 24454);
});

test('голосовой чат: проверка ввода', () => {
  assert.throws(() => vc.checkPort(80), /1024/);
  assert.throws(() => vc.checkPort('x'), /1024/);
  assert.throws(() => vc.checkHost('bad host;rm'), /адрес/i);
  assert.equal(vc.checkHost(' 147.185.221.1:12345 '), '147.185.221.1:12345');
  assert.equal(vc.checkHost(''), '');
});

test('spark: встроен в Paper с 1.21, ссылки и ошибки из консоли', () => {
  assert.equal(lag.sparkBuiltin('paper', '1.21.1'), true);
  assert.equal(lag.sparkBuiltin('paper', '1.20.6'), false);
  assert.equal(lag.sparkBuiltin('fabric', '1.21.1'), false);
  assert.equal(lag.sparkBuiltin('paper', '26.1'), true);
  assert.equal(lag.sparkUrl('[12:00:01] [Server thread/INFO]: [⚡] https://spark.lucko.me/AbC123xyz'), 'https://spark.lucko.me/AbC123xyz');
  assert.equal(lag.sparkUrl('[⚡] Profiler is now running!'), null);
  assert.match(lag.sparkError('Unknown or incomplete command, see below for error', 500), /установите spark/);
  assert.equal(lag.sparkError('Unknown or incomplete command', 60000), null, 'чужая ошибка позже — не наша');
  assert.match(lag.sparkError('[12:00] [INFO]: [⚡] An error occurred whilst uploading the data.', 40000), /^spark: An error occurred/);
  assert.equal(lag.sparkError('[⚡] Profiler is now running!', 100), null);
});
