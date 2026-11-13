// Карточка игрока (NBT), области мира (сравнение и откат), поиск причин лагов.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tar = require('tar');
const nbt = require('../lib/nbt');
const playercard = require('../lib/playercard');
const regions = require('../lib/regions');
const lag = require('../lib/lag');
const { tmpDir } = require('./helpers');

// ---- маленький писатель NBT для тестов ----
const W = {
  name: (s) => {
    const b = Buffer.from(s, 'utf8');
    const l = Buffer.alloc(2);
    l.writeUInt16BE(b.length);
    return Buffer.concat([l, b]);
  },
  tag: (t, name, payload) => Buffer.concat([Buffer.from([t]), W.name(name), payload]),
  int: (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    return b;
  },
  float: (v) => {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v);
    return b;
  },
  double: (v) => {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    return b;
  },
  compound: (...children) => Buffer.concat([...children, Buffer.from([0])]),
  list: (type, items) => Buffer.concat([Buffer.from([type]), W.int(items.length), ...items]),
};

function playerDat() {
  const item = (slot, id, count) => W.compound(W.tag(1, 'Slot', Buffer.from([slot])), W.tag(8, 'id', W.name(id)), W.tag(3, 'count', W.int(count)));
  const root = W.tag(10, '', W.compound(
    W.tag(9, 'Pos', W.list(6, [W.double(10.7), W.double(64), W.double(-3.2)])),
    W.tag(8, 'Dimension', W.name('minecraft:the_nether')),
    W.tag(5, 'Health', W.float(17.5)),
    W.tag(3, 'foodLevel', W.int(20)),
    W.tag(3, 'XpLevel', W.int(30)),
    W.tag(3, 'playerGameType', W.int(0)),
    W.tag(4, 'Seed', Buffer.from([0, 0, 0, 0, 0, 0, 1, 0])),
    W.tag(11, 'UUID', Buffer.concat([W.int(4), W.int(1), W.int(2), W.int(3), W.int(4)])),
    W.tag(9, 'Inventory', W.list(10, [item(1, 'minecraft:torch', 32), item(0, 'minecraft:diamond_sword', 1)]))
  ));
  return zlib.gzipSync(root);
}

test('NBT: данные игрока — координаты, измерение, инвентарь', (t) => {
  const d = tmpDir(t);
  const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
  fs.mkdirSync(path.join(d, 'world', 'playerdata'), { recursive: true });
  fs.writeFileSync(path.join(d, 'world', 'playerdata', uuid + '.dat'), playerDat());
  fs.writeFileSync(path.join(d, 'usercache.json'), JSON.stringify([{ name: 'Notch', uuid, expiresOn: '' }]));
  assert.equal(playercard.uuidFromCache(d, 'notch'), uuid);
  const p = playercard.read(d, 'world', uuid);
  assert.deepEqual(p.pos, [10, 64, -4]);
  assert.equal(p.dimension, 'Нижний мир');
  assert.equal(p.health, 18);
  assert.equal(p.level, 30);
  assert.equal(p.mode, 'Выживание');
  assert.deepEqual(p.items.map((i) => [i.id, i.count]), [['minecraft:diamond_sword', 1], ['minecraft:torch', 32]]);
  assert.equal(playercard.read(d, 'world', '../../etc'), null);
  assert.equal(playercard.read(d, 'world', '00000000-0000-0000-0000-000000000000'), null);
  assert.throws(() => nbt.parse(zlib.gzipSync(Buffer.from([10, 0, 0, 3, 0]))), /обрезан/);
});

// Файл региона: заголовок 8 КБ (есть ли чанк + время сохранения) и немного данных.
function mca(chunks) {
  const b = Buffer.alloc(8192 + 16);
  for (const [i, time] of Object.entries(chunks)) {
    b.writeUInt32BE((2 << 8) | 1, Number(i) * 4);
    b.writeUInt32BE(time, 4096 + Number(i) * 4);
  }
  return b;
}

test('области: сравнение с копией и откат выбранных', async (t) => {
  const d = tmpDir(t);
  const put = (rel, buf) => {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), buf);
  };
  put('world/region/r.0.0.mca', mca({ 0: 100, 1: 100 }));
  put('world/region/r.-1.0.mca', mca({ 5: 100 }));
  put('world_nether/DIM-1/region/r.0.0.mca', mca({ 7: 100 }));
  put('world/level.dat', Buffer.from('x'));
  fs.mkdirSync(path.join(d, 'backups'));
  const archive = path.join(d, 'backups', 'b.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: d, portable: true }, ['world', 'world_nether']);
  // После копии: в r.0.0 перезаписан один чанк и добавлен новый, появился новый регион, Нижний мир не менялся.
  put('world/region/r.0.0.mca', mca({ 0: 200, 1: 100, 2: 200 }));
  put('world/region/r.3.3.mca', mca({ 0: 300 }));
  const res = await regions.compare(d, archive, ['world', 'world_nether']);
  const by = Object.fromEntries(res.map((x) => [`${x.dim}:${x.rx},${x.rz}`, x]));
  assert.deepEqual([by['overworld:0,0'].changed, by['overworld:0,0'].added], [1, 1]);
  assert.equal(by['overworld:3,3'].added, 1);
  assert.equal(by['overworld:-1,0'], undefined);
  assert.equal(by['nether:0,0'], undefined);
  assert.equal(by['overworld:3,3'].x1, 1536);

  assert.deepEqual(regions.regionsAround(10, 10, 50), [[-1, -1], [-1, 0], [0, -1], [0, 0]]);
  assert.deepEqual(regions.regionsAround(100, 100, 50), [[0, 0]]);
  assert.throws(() => regions.regionsAround(0, 0, 10000), /Слишком большая/);

  const r = await regions.restore(d, archive, 'world', 'overworld', [[0, 0], [3, 3]]);
  assert.deepEqual(r, { restored: 1, removed: 1 });
  assert.deepEqual(fs.readFileSync(path.join(d, 'world/region/r.0.0.mca')), mca({ 0: 100, 1: 100 }));
  assert.equal(fs.existsSync(path.join(d, 'world/region/r.3.3.mca')), false, 'области не было в копии — удалена');
  assert.ok(fs.existsSync(path.join(d, 'world/region/r.-1.0.mca')), 'остальной мир не тронут');
  assert.deepEqual(regions.prefixesFor('world', 'nether'), ['world/DIM-1', 'world_nether/DIM-1']);
});

test('лаги: запросы, разбор ответов и выводы', () => {
  assert.equal(lag.supported('1.12.2'), false);
  assert.equal(lag.supported('1.21.1'), true);
  assert.equal(lag.supported('26.1'), true);
  const q = lag.queries(['Steve', 'bad name;']);
  assert.ok(q.some((x) => x.cmd === 'execute at Steve if entity @e[distance=..48]'));
  assert.ok(!q.some((x) => x.cmd.includes('bad')));
  assert.equal(lag.parseReply('count', '[Server thread/INFO]: Test passed, count: 1234'), 1234);
  assert.equal(lag.parseReply('count', '[Server thread/INFO]: Test failed'), 0);
  assert.deepEqual(lag.parseReply('pos', '[Server thread/INFO]: Steve has the following entity data: [-12.5d, 70.0d, 300.9d]'), [-13, 70, 300]);
  assert.ok(lag.REPLY_RE.test('Test passed, count: 3'));
  const hints = lag.analyze({ total: 3000, items: 2000, xp: 10, 'near:Steve': 900, 'items:Steve': 100, 'vill:Steve': 2, 'pos:Steve': [1, 64, 2] }, ['Steve']);
  assert.equal(hints[0].fix, 'items');
  assert.equal(hints[0].level, 'bad');
  assert.match(hints[1].text, /Около Steve \(1 64 2\) 800 существ/);
  const calm = lag.analyze({ total: 100, items: 3, xp: 0 }, []);
  assert.equal(calm.length, 1);
  assert.match(calm[0].text, /spark/);
  assert.equal(lag.FIXES.items, 'kill @e[type=item]');
});
