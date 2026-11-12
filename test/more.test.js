// Правила игры, TPS, учёт времени игроков, готовый сервер из папки, копии в облако.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gamerules = require('../lib/gamerules');
const tps = require('../lib/tps');
const playtime = require('../lib/playtime');
const servers = require('../lib/servers');
const backup = require('../lib/backup');
const { tmpDir } = require('./helpers');

test('правила игры: имена зависят от версии', () => {
  assert.equal(gamerules.isNewNames('1.21.10'), false);
  assert.equal(gamerules.isNewNames('1.21.11'), true);
  assert.equal(gamerules.isNewNames('26.3'), true);
  assert.deepEqual(gamerules.commandsFor('1.21.1', { keepInventory: true, doDaylightCycle: false, playersSleepingPercentage: true }), [
    'gamerule keepInventory true',
    'gamerule doDaylightCycle false',
    'gamerule playersSleepingPercentage 1',
  ]);
  assert.deepEqual(gamerules.commandsFor('26.1', { keepInventory: true, doDaylightCycle: false, doInsomnia: false }), [
    'gamerule keep_inventory true',
    'gamerule advance_time false',
    'gamerule spawn_phantoms false',
  ]);
  // Нет такого правила в старой версии — команда не отправляется; мусор отбрасывается.
  assert.deepEqual(gamerules.commandsFor('1.16.5', { playersSleepingPercentage: true, hack: true, keepInventory: 'x' }), []);
});

test('TPS: команда и разбор ответа разных серверов', () => {
  assert.equal(tps.queryFor('paper', '1.21.4'), 'tps');
  assert.equal(tps.queryFor('neoforge', '1.21.1'), 'neoforge tps');
  assert.equal(tps.queryFor('fabric', '1.20.4'), 'tick query');
  assert.equal(tps.queryFor('vanilla', '1.20.1'), null);
  assert.deepEqual(tps.parse('[12:00:00 INFO]: TPS from last 1m, 5m, 15m: *20.0, 19.98, 20.0'), { tps: 20, mspt: null });
  assert.deepEqual(tps.parse('[Server thread/INFO]: Overall: Mean tick time: 4.512 ms. Mean TPS: 19.870'), { tps: 19.87, mspt: 4.512 });
  assert.deepEqual(tps.parse('[Server thread/INFO]: Average time per tick: 80.0ms (Target: 50.0ms)'), { tps: 12.5, mspt: 80 });
  assert.deepEqual(tps.parse('Average time per tick: 2.0ms (Target: 50.0ms)'), { tps: 20, mspt: 2 });
  assert.equal(tps.parse('Steve joined the game'), null);
  assert.ok(tps.isTpsLine('Dim minecraft:overworld (minecraft:overworld): Mean tick time: 1 ms. Mean TPS: 20'));
  assert.ok(!tps.isTpsLine('<Steve> привет'));
});

test('время в игре: вход, выход, остановка сервера', (t) => {
  const d = tmpDir(t);
  const tr = playtime.createTracker(d);
  tr.join('Steve', 1000);
  tr.join('Alex', 2000);
  tr.leave('Steve', 61000);
  tr.join('Steve', 100000);
  tr.closeAll(160000);
  tr.join('../evil', 1);
  const list = playtime.list(d);
  assert.deepEqual(list.map((p) => [p.name, p.total]), [
    ['Steve', 120000],
    ['Alex', 158000],
  ]);
  assert.equal(list[0].first, 1000);
});

test('готовый сервер: тип и версия по файлам', async (t) => {
  const root = tmpDir(t);
  const mk = (name, files) => {
    const d = path.join(root, name);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), 'x');
    }
    return d;
  };
  const paper = await servers.detectServer(mk('p', ['paper-1.21.4-232.jar', 'plugins/a.jar', 'world/level.dat']));
  assert.deepEqual([paper.type, paper.version, paper.plugins, paper.hasWorld], ['paper', '1.21.4', 1, true]);
  const neo = await servers.detectServer(mk('n', ['libraries/net/neoforged/neoforge/21.1.172/x.jar', 'mods/a.jar', 'mods/b.jar']));
  assert.deepEqual([neo.type, neo.version, neo.loader, neo.mods], ['neoforge', '1.21.1', '21.1.172', 2]);
  const forge = await servers.detectServer(mk('f', ['libraries/net/minecraftforge/forge/1.20.1-47.3.0/x.jar']));
  assert.deepEqual([forge.type, forge.version, forge.loader], ['forge', '1.20.1', '47.3.0']);
  const fabric = await servers.detectServer(mk('fa', ['fabric-server-mc.1.21.1-loader.0.16.9-launcher.1.0.1.jar']));
  assert.deepEqual([fabric.type, fabric.version, fabric.loader], ['fabric', '1.21.1', '0.16.9']);
  const van = await servers.detectServer(mk('v', ['server.jar']), async () => '1.21.3');
  assert.deepEqual([van.type, van.version], ['vanilla', '1.21.3']);
  const none = await servers.detectServer(mk('x', ['readme.txt']));
  assert.equal(none.type, null);
  assert.equal(servers.neoToMc('20.4.237'), '1.20.4');
  assert.equal(servers.neoToMc('21.0.1'), '1.21');
});

test('готовый сервер копируется без ядра, журналов и eula', (t) => {
  const root = tmpDir(t);
  const src = path.join(root, 'src');
  for (const f of ['paper-1.21.4-1.jar', 'eula.txt', 'logs/latest.log', 'libraries/x.jar', 'world/level.dat', 'plugins/a.jar', 'server.properties', 'ops.json', 'start.bat']) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), 'x');
  }
  const dst = path.join(root, 'paper-1.21.4');
  const r = servers.importServer(src, dst);
  assert.deepEqual(r.copied.sort(), ['ops.json', 'plugins', 'server.properties', 'world']);
  assert.ok(fs.existsSync(path.join(dst, 'plugins', 'a.jar')));
  assert.ok(!fs.existsSync(path.join(dst, 'eula.txt')), 'лицензию принимают заново');
  assert.ok(fs.existsSync(path.join(src, 'paper-1.21.4-1.jar')), 'исходная папка не тронута');
  assert.throws(() => servers.importServer(src, dst), /уже есть/);
});

test('копии в облачную папку: копируются и чистятся', async (t) => {
  const root = tmpDir(t);
  const dir = path.join(root, 'paper-1.21.4');
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'x');
  const cloud = path.join(root, 'OneDrive');
  fs.mkdirSync(cloud);
  const b = await backup.create(dir, 'manual');
  const out = backup.mirror(dir, b.file, cloud, 2);
  assert.ok(fs.existsSync(out));
  assert.equal(path.basename(path.dirname(out)), 'paper-1.21.4');
  // Старые автокопии в облаке сверх лимита удаляются, сделанные вручную — нет.
  const target = path.dirname(out);
  for (const n of ['2020-01-01_00-00-00_auto', '2020-01-02_00-00-00_auto', '2020-01-03_00-00-00_auto']) {
    fs.writeFileSync(path.join(target, n + '.tar.gz'), 'x');
  }
  backup.mirror(dir, b.file, cloud, 2);
  const left = fs.readdirSync(target).sort();
  assert.deepEqual(left.filter((f) => f.includes('_auto')), ['2020-01-02_00-00-00_auto.tar.gz', '2020-01-03_00-00-00_auto.tar.gz']);
  assert.ok(left.includes(b.file));
  assert.throws(() => backup.mirror(dir, b.file, path.join(root, 'нет'), 2), /не найдена/);
  assert.throws(() => backup.writeSettings(dir, { backup: { mirror: 'relative/path' } }), /неверно/);
  assert.throws(() => backup.writeSettings(dir, { tunnel: { address: 'bad address!' } }), /туннеля/);
});
