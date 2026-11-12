// Перенос на другую версию, миры одиночной игры, UPnP, Discord, настройки сервера.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const servers = require('../lib/servers');
const upnp = require('../lib/upnp');
const backup = require('../lib/backup');
const core = require('../lib/core');
const { createDiscord, escapeMd } = require('../lib/discord');
const { tmpDir } = require('./helpers');

function makeWorld(dir, name = 'world') {
  fs.mkdirSync(path.join(dir, name, 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'level.dat'), 'lvl');
  fs.writeFileSync(path.join(dir, name, 'region', 'r.0.0.mca'), 'chunk');
  fs.writeFileSync(path.join(dir, name, 'session.lock'), 'lock');
}

test('перенос на новую версию копирует мир, настройки и плагины, но не моды', (t) => {
  const root = tmpDir(t);
  const src = path.join(root, 'paper-1.20.4');
  const dst = path.join(root, 'paper-1.21.4');
  makeWorld(src);
  makeWorld(src, 'world_nether');
  fs.writeFileSync(path.join(src, 'server.properties'), 'motd=Привет\n');
  fs.writeFileSync(path.join(src, 'ops.json'), '[]');
  fs.writeFileSync(path.join(src, 'mcl-settings.json'), '{"name":"Мой"}');
  fs.mkdirSync(path.join(src, 'plugins', 'LuckPerms'), { recursive: true });
  fs.writeFileSync(path.join(src, 'plugins', 'lp.jar'), 'jar');
  fs.mkdirSync(path.join(src, 'mods'));
  fs.writeFileSync(path.join(src, 'mods', 'a.jar'), 'jar');

  const r = servers.copyForUpgrade(src, dst, 'paper');
  assert.ok(fs.existsSync(path.join(dst, 'world', 'region', 'r.0.0.mca')));
  assert.ok(fs.existsSync(path.join(dst, 'world_nether', 'level.dat')));
  assert.ok(!fs.existsSync(path.join(dst, 'world', 'session.lock')), 'session.lock не копируется');
  assert.ok(fs.existsSync(path.join(dst, 'plugins', 'lp.jar')));
  assert.ok(!fs.existsSync(path.join(dst, 'mods')));
  assert.equal(r.modsLeft, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dst, 'mcl-settings.json'), 'utf8')).name, 'Мой');
  // Старый сервер не тронут, повторно на занятую версию — нельзя.
  assert.ok(fs.existsSync(path.join(src, 'world', 'level.dat')));
  assert.throws(() => servers.copyForUpgrade(src, dst, 'paper'), /уже есть/);
});

test('у Fabric плагины не переносятся, без мира перенос запрещён', (t) => {
  const root = tmpDir(t);
  const src = path.join(root, 'fabric-1.20.1');
  fs.mkdirSync(src);
  assert.throws(() => servers.copyForUpgrade(src, path.join(root, 'fabric-1.21.1'), 'fabric'), /нет мира/);
  makeWorld(src);
  fs.mkdirSync(path.join(src, 'plugins'));
  servers.copyForUpgrade(src, path.join(root, 'fabric-1.21.1'), 'fabric');
  assert.ok(!fs.existsSync(path.join(root, 'fabric-1.21.1', 'plugins')));
});

test('мир из одиночной игры: список и замена мира сервера', (t) => {
  const root = tmpDir(t);
  const savesDir = path.join(root, 'saves');
  makeWorld(savesDir, 'Остров');
  fs.mkdirSync(path.join(savesDir, 'не мир'), { recursive: true });
  const list = servers.listSaves(savesDir);
  assert.deepEqual(list.map((s) => s.name), ['Остров']);
  assert.deepEqual(servers.listSaves(path.join(root, 'нет')), []);

  const dir = path.join(root, 'server');
  makeWorld(dir, 'world');
  makeWorld(dir, 'world_the_end');
  fs.writeFileSync(path.join(dir, 'world', 'old.txt'), 'старый');
  servers.importWorld(dir, list[0].path, 'world');
  assert.ok(fs.existsSync(path.join(dir, 'world', 'region', 'r.0.0.mca')));
  assert.ok(!fs.existsSync(path.join(dir, 'world', 'old.txt')), 'старый мир заменён');
  assert.ok(!fs.existsSync(path.join(dir, 'world_the_end')), 'старый Край убран');
  assert.throws(() => servers.importWorld(dir, path.join(savesDir, 'не мир'), 'world'), /level\.dat/);
  assert.throws(() => servers.importWorld(dir, list[0].path, '../x'), /имя мира/);
});

test('тип мира пишется в формате нужной версии', () => {
  assert.equal(servers.levelTypeValue('1.21.4', 'flat'), 'minecraft:flat');
  assert.equal(servers.levelTypeValue('26.3', 'amplified'), 'minecraft:amplified');
  assert.equal(servers.levelTypeValue('1.12.2', 'large_biomes'), 'largeBiomes');
  assert.equal(servers.levelTypeValue('1.16.5', 'normal'), 'default');
  assert.throws(() => servers.levelTypeValue('1.21', 'nether'), /тип мира/);
});

test('сид и тип мира проверяются при записи server.properties', (t) => {
  const d = tmpDir(t);
  core.writeProps(d, { 'level-seed': '12345', 'level-type': 'minecraft:flat' });
  const text = fs.readFileSync(path.join(d, 'server.properties'), 'utf8');
  assert.match(text, /level-seed=12345/);
  assert.match(text, /level-type=minecraft:flat/);
  assert.throws(() => core.writeProps(d, { 'level-type': 'x;rm' }), /тип мира/);
  assert.throws(() => core.writeProps(d, { 'level-seed': 'a'.repeat(65) }), /64/);
});

test('настройки сервера: вебхук Discord и UPnP', (t) => {
  const d = tmpDir(t);
  const url = 'https://discord.com/api/webhooks/1234567890/abc_DEF-ghi';
  let s = backup.writeSettings(d, { discord: { url, players: false }, net: { upnp: true } });
  assert.equal(s.discord.url, url);
  assert.equal(s.discord.players, false);
  assert.equal(s.discord.start, true);
  assert.equal(s.net.upnp, true);
  // Другие настройки не сбрасывают уже сохранённые.
  s = backup.writeSettings(d, { backup: { keep: 3 } });
  assert.equal(s.discord.url, url);
  assert.equal(s.net.upnp, true);
  assert.throws(() => backup.writeSettings(d, { discord: { url: 'https://example.com/api/webhooks/1/x' } }), /вебхука/);
  assert.equal(backup.writeSettings(d, { discord: { url: '' } }).discord.url, '');
});

test('UPnP: разбор ответов роутера', () => {
  assert.equal(upnp.parseSsdp('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:5000/rootDesc.xml\r\n\r\n'), 'http://192.168.1.1:5000/rootDesc.xml');
  assert.equal(upnp.parseSsdp('HTTP/1.1 200 OK\r\n\r\n'), null);
  const xml = `<root><device><serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
  </serviceList></device></root>`;
  assert.deepEqual(upnp.findService(xml, 'http://192.168.1.1:5000/rootDesc.xml'), {
    type: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    control: 'http://192.168.1.1:5000/ctl/IPConn',
  });
  assert.equal(upnp.findService('<root></root>', 'http://x/'), null);
  const env = upnp.envelope('urn:x', 'AddPortMapping', { NewPortMappingDescription: 'a<b' });
  assert.match(env, /<u:AddPortMapping xmlns:u="urn:x"><NewPortMappingDescription>a&lt;b<\/NewPortMappingDescription>/);
  assert.equal(upnp.xmlValue('<s:Body><NewExternalIPAddress>93.1.2.3</NewExternalIPAddress></s:Body>', 'NewExternalIPAddress'), '93.1.2.3');
  for (const ip of ['10.0.0.1', '172.20.1.1', '192.168.0.5', '100.72.3.4']) assert.ok(upnp.isPrivateIp(ip), ip);
  for (const ip of ['93.184.216.34', '172.32.0.1', '100.128.0.1', 'abc']) assert.ok(!upnp.isPrivateIp(ip), ip);
});

test('Discord: сообщение без упоминаний, ошибки вебхука понятны', async () => {
  const calls = [];
  const d = createDiscord(async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 204 };
  }, 'ua');
  await d.test('https://discord.com/api/webhooks/1/x', 'привет @everyone');
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(calls[0].body.content, 'привет @everyone');
  const bad = createDiscord(async () => ({ ok: false, status: 404 }), 'ua');
  await assert.rejects(bad.test('https://discord.com/api/webhooks/1/x', 'x'), /удалили/);
  assert.equal(escapeMd('_Steve_*'), '\\_Steve\\_\\*');
});
