'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tmpDir } = require('./helpers');
const bugreport = require('../lib/bugreport');

const anon = { home: 'C:\\Users\\Vasya', user: 'Vasya' };

/** Прочитать zip, собранный pack.zip (локальные заголовки идут подряд). */
function unzip(buf) {
  const out = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const elen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nlen).toString('utf8');
    const body = buf.slice(p + 30 + nlen + elen, p + 30 + nlen + elen + size);
    out[name] = (method === 8 ? zlib.inflateRawSync(body) : body).toString('utf8');
    p += 30 + nlen + elen + size;
  }
  return out;
}

test('anonymize прячет папку пользователя, имя и IP игроков', () => {
  const t = bugreport.anonymize(
    'Java at C:\\Users\\vasya\\.jdks\\21 and c:/Users/Vasya/x\nVasya[/93.184.216.34:51234] logged in\nlistening 0.0.0.0 / 127.0.0.1, mod VasyaCraft',
    anon
  );
  assert.ok(!/vasya[\\/]/i.test(t), t);
  assert.ok(t.includes('%USERPROFILE%\\.jdks'));
  assert.ok(t.includes('<user>[/x.x.x.x:51234]'));
  assert.ok(t.includes('0.0.0.0') && t.includes('127.0.0.1'));
  assert.ok(t.includes('VasyaCraft'), 'часть другого слова не трогаем');
});

test('cleanProps скрывает пароли', () => {
  const t = bugreport.cleanProps('rcon.password=hunter2\nmotd=Hi\nmanagement-server-secret=abc\nserver-port=25565');
  assert.ok(!t.includes('hunter2') && !t.includes('abc'));
  assert.ok(t.includes('motd=Hi') && t.includes('server-port=25565'));
});

test('build собирает журнал, сбои, моды и сведения в один zip', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.mkdirSync(path.join(dir, 'crash-reports'));
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), 'Loading C:\\Users\\Vasya\\MinecraftServers\nVasya[/10.0.0.5:1] logged in\n');
  fs.writeFileSync(path.join(dir, 'crash-reports', 'crash-2026-11-17_10.00.00-server.txt'), 'Description: Exception in server tick loop\n');
  fs.writeFileSync(path.join(dir, 'mods', 'sodium.jar'), 'x');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'rcon.password=secret1\nmotd=hello\n');
  fs.writeFileSync(path.join(dir, 'hs_err_pid42.log'), 'SIGSEGV');

  const r = bugreport.build(dir, { Лаунчер: '1.0.11' }, { ...anon, extra: [{ name: 'launcher.log', text: 'Java не знает флаги -XX:Foo' }] });
  const files = unzip(r.data);
  assert.deepEqual(Object.keys(files).sort(), ['crash-reports/crash-2026-11-17_10.00.00-server.txt', 'hs_err_pid42.log', 'info.txt', 'launcher.log', 'logs/latest.log', 'mods.txt', 'server.properties'].sort());
  assert.ok(files['logs/latest.log'].includes('%USERPROFILE%\\MinecraftServers'));
  assert.ok(files['logs/latest.log'].includes('x.x.x.x'));
  assert.ok(!files['server.properties'].includes('secret1'));
  assert.ok(files['mods.txt'].includes('sodium.jar'));
  assert.ok(files['info.txt'].includes('Лаунчер: 1.0.11'));
  assert.ok(files['launcher.log'].includes('-XX:Foo'));
});
