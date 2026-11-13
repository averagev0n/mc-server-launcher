// Датапаки, события и достижения, проверка копий, карта мира.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tar = require('tar');
const datapacks = require('../lib/datapacks');
const fun = require('../lib/fun');
const backupcheck = require('../lib/backupcheck');
const { render, packed, colorOf } = require('../lib/maprender');
const { tmpDir } = require('./helpers');

// ---- писатель NBT ----
const nm = (s) => {
  const b = Buffer.from(s);
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
};
const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};
const tag = (t, n, p) => Buffer.concat([Buffer.from([t]), nm(n), p]);
const comp = (...c) => Buffer.concat([...c, Buffer.from([0])]);
const list = (t, items) => Buffer.concat([Buffer.from([t]), i32(items.length), ...items]);
const longs = (arr) => Buffer.concat([i32(arr.length), ...arr.map((v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt.asUintN(64, v));
  return b;
})]);

test('датапаки: свои файлы, список, защита путей', (t) => {
  const d = tmpDir(t);
  const src = path.join(d, 'src');
  fs.mkdirSync(path.join(src, 'mypack'), { recursive: true });
  fs.writeFileSync(path.join(src, 'mypack', 'pack.mcmeta'), '{"pack":{"pack_format":48,"description":"x"}}');
  fs.writeFileSync(path.join(src, 'cool.zip'), 'zip');
  fs.writeFileSync(path.join(src, 'bad.txt'), 'x');
  fs.mkdirSync(path.join(src, 'notpack'));
  assert.equal(datapacks.addLocal(d, 'world', path.join(src, 'mypack')), 'mypack');
  assert.equal(datapacks.addLocal(d, 'world', path.join(src, 'cool.zip')), 'cool.zip');
  assert.throws(() => datapacks.addLocal(d, 'world', path.join(src, 'bad.txt')), /\.zip/);
  assert.throws(() => datapacks.addLocal(d, 'world', path.join(src, 'notpack')), /pack\.mcmeta/);
  assert.throws(() => datapacks.addLocal(d, 'world', path.join(src, 'cool.zip')), /уже есть/);
  assert.deepEqual(datapacks.list(d, 'world').map((x) => [x.file, x.folder]), [['cool.zip', false], ['mypack', true]]);
  assert.throws(() => datapacks.packPath(d, 'world', '../server.properties'), /Некорректное/);
  assert.throws(() => datapacks.folder(d, '..'), /Некорректное/);
  assert.ok(datapacks.packPath(d, 'world', 'cool.zip').endsWith(path.join('world', 'datapacks', 'cool.zip')));
});

test('события: команды под старые и новые версии', () => {
  assert.equal(fun.hasComponents('1.20.4'), false);
  assert.equal(fun.hasComponents('1.21.1'), true);
  assert.equal(fun.hasComponents('26.1'), true);
  assert.match(fun.firework('1.21.1', 255), /components:\{"minecraft:fireworks"/);
  assert.match(fun.firework('1.19.2', 255), /tag:\{Fireworks/);
  const peaceOld = fun.EVENTS.peace.build('1.21.1');
  assert.deepEqual([peaceOld.start, peaceOld.end, peaceOld.minutes], [['gamerule doMobSpawning false'], ['gamerule doMobSpawning true'], 60]);
  assert.deepEqual(fun.EVENTS.peace.build('1.21.11').start, ['gamerule spawn_mobs false']);
  assert.ok(fun.EVENTS.day.build('1.20.1').end.includes('gamerule doDaylightCycle true'));
  assert.deepEqual(fun.EVENTS.gift.build('1.21.1', 'Diamond').start, ['give @a diamond 1']);
  assert.throws(() => fun.EVENTS.gift.build('1.21.1', 'diamond; op me'), /латиницей/);
  assert.equal(fun.tellAll('Привет "всем"'), 'tellraw @a {"text":"Привет \\"всем\\"","color":"gold"}');
});

test('достижения: первый — только один раз, рубежи часов', (t) => {
  const d = tmpDir(t);
  const line = (who, adv) => `[20:00:00] [Server thread/INFO]: ${who} has made the advancement [${adv}]`;
  const a = fun.onLine(d, line('Steve', 'Free the End'));
  assert.equal(a.text, 'Steve первым победил Эндер-дракона на этом сервере!');
  assert.equal(fun.onLine(d, line('Alex', 'Free the End')), null, 'второй уже не первый');
  assert.equal(fun.onLine(d, line('Alex', 'Stone Age')), null, 'обычное достижение не отмечаем');
  assert.ok(fun.onLine(d, '[20:00:00] [Server thread/INFO]: Alex has completed the challenge [How Did We Get Here?]'));
  assert.deepEqual(fun.onHours(d, { Steve: 0.5 * 3600e3 }), []);
  assert.deepEqual(fun.onHours(d, { Steve: 12 * 3600e3 }).map((x) => x.text), ['Steve провёл на сервере 10 часов!']);
  assert.deepEqual(fun.onHours(d, { Steve: 13 * 3600e3 }), [], 'тот же рубеж не повторяется');
  const l = fun.list(d);
  assert.deepEqual(l.firsts.map((x) => x.name), ['Steve', 'Alex']);
  assert.deepEqual(l.hours, [{ name: 'Steve', hours: 10 }]);
});

test('проверка копии: целая и повреждённая', async (t) => {
  const d = tmpDir(t);
  fs.mkdirSync(path.join(d, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(d, 'world', 'level.dat'), zlib.gzipSync(tag(10, '', comp(tag(10, 'Data', comp(tag(8, 'LevelName', nm('Мир'))))))));
  fs.writeFileSync(path.join(d, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(9000, 1));
  fs.mkdirSync(path.join(d, 'backups'));
  const good = path.join(d, 'backups', 'good.tar.gz');
  await tar.c({ gzip: true, file: good, cwd: d, portable: true }, ['world']);
  const r = await backupcheck.verify(good);
  assert.deepEqual([r.regions, r.name], [1, 'Мир']);
  const raw = fs.readFileSync(good);
  const bad = path.join(d, 'backups', 'bad.tar.gz');
  fs.writeFileSync(bad, raw.subarray(0, Math.floor(raw.length / 2)));
  await assert.rejects(backupcheck.verify(bad));
  const noLevel = path.join(d, 'backups', 'nolevel.tar.gz');
  await tar.c({ gzip: true, file: noLevel, cwd: path.join(d, 'world'), portable: true }, ['region']);
  await assert.rejects(backupcheck.verify(noLevel), /level\.dat/);
  backupcheck.saveState(d, 'good.tar.gz', { ok: true, at: 1 });
  backupcheck.saveState(d, 'gone.tar.gz', { ok: true, at: 2 });
  assert.deepEqual(Object.keys(backupcheck.readState(d)), ['good.tar.gz'], 'записи о пропавших копиях убираются');
});

test('карта: упакованные значения и чанк 1.18+', () => {
  // 9 бит, по 7 значений на long, без переноса.
  const vals = Array.from({ length: 256 }, (_, i) => (i * 37) % 384);
  const arr = [];
  for (let li = 0; li < 37; li++) {
    let v = 0n;
    for (let k = 0; k < 7 && li * 7 + k < 256; k++) v |= BigInt(vals[li * 7 + k]) << BigInt(k * 9);
    arr.push(v);
  }
  assert.equal(packed(arr, 0, 9, false), vals[0]);
  assert.equal(packed(arr, 200, 9, false), vals[200]);
  assert.deepEqual(colorOf('minecraft:water'), [63, 118, 228]);

  // Чанк: трава на высоте 79 (секция Y=4), мир с -64.
  const h = 79 - -64 + 1;
  const hm = [];
  for (let li = 0; li < 37; li++) {
    let v = 0n;
    for (let k = 0; k < 7 && li * 7 + k < 256; k++) v |= BigInt(h) << BigInt(k * 9);
    hm.push(v);
  }
  const chunk = tag(10, '', comp(
    tag(3, 'DataVersion', i32(3953)),
    tag(8, 'Status', nm('minecraft:full')),
    tag(3, 'yPos', i32(-4)),
    tag(9, 'sections', list(10, [comp(tag(1, 'Y', Buffer.from([4])), tag(10, 'block_states', comp(tag(9, 'palette', list(10, [comp(tag(8, 'Name', nm('minecraft:grass_block')))])))))])),
    tag(10, 'Heightmaps', comp(tag(12, 'WORLD_SURFACE', longs(hm))))
  ));
  const data = zlib.deflateSync(chunk);
  const region = Buffer.alloc(8192 + Math.ceil((data.length + 5) / 4096) * 4096);
  region.writeUInt32BE((2 << 8) | 1, 0); // чанк 0 — в секторе 2
  region.writeUInt32BE(data.length + 1, 8192);
  region[8196] = 2;
  data.copy(region, 8197);
  const r = render(region, 4);
  assert.equal(r.size, 128);
  assert.deepEqual([...r.rgba.slice(0, 4)], [110, 160, 62, 255], 'трава');
  assert.equal(r.rgba[(10 * 128 + 10) * 4 + 3], 0, 'там, где чанков нет, — прозрачно');
});
