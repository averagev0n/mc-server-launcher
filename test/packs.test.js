// Сборки модов: экспорт для игроков (.mrpack/.zip) и сервер из чужой сборки.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pack = require('../lib/pack');
const mrpack = require('../lib/mrpack');
const { tmpDir } = require('./helpers');

const isWin = process.platform === 'win32';

test('servers.dat — правильная структура NBT', () => {
  const b = pack.serversDat('Мой', '1.2.3.4');
  assert.equal(b[0], 10); // корневой compound
  assert.equal(b[3], 9); // list «servers»
  assert.ok(b.includes(Buffer.from('1.2.3.4')));
  assert.ok(b.includes(Buffer.from('Мой', 'utf8')));
  assert.deepEqual([...b.subarray(-2)], [0, 0]);
});

test('zip: правильные сигнатуры и число файлов', () => {
  const z = pack.zip([
    { name: 'a.txt', data: Buffer.from('hello'.repeat(100)) },
    { name: 'папка/б.txt', data: Buffer.from('x') },
  ]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  const end = z.length - 22;
  assert.equal(z.readUInt32LE(end), 0x06054b50);
  assert.equal(z.readUInt16LE(end + 10), 2);
});

test('экспорт .mrpack: моды с Modrinth — ссылкой, свои — внутрь, сервер в списке', (t) => {
  const d = tmpDir(t);
  const mods = path.join(d, 'mods');
  fs.mkdirSync(mods);
  fs.writeFileSync(path.join(mods, 'a.jar'), 'A');
  fs.writeFileSync(path.join(mods, 'own.jar'), 'OWN');
  const items = [
    { file: 'a.jar', size: 1, sha1: 'a'.repeat(40), sha512: 'b'.repeat(128), download: 'https://cdn.modrinth.com/a.jar', clientSide: 'required' },
    { file: 'own.jar', size: 3, sha1: 'c'.repeat(40), sha512: 'd'.repeat(128) },
  ];
  const out = path.join(d, 'p.mrpack');
  const r = pack.build({
    format: 'mrpack', items, modsDir: mods, name: 'Тест', mc: '1.21.1',
    loader: { flavor: 'fabric', version: '0.16.5' }, server: { name: 'S', address: '1.2.3.4' }, outFile: out,
  });
  assert.equal(r.bundled, 1);
  const raw = fs.readFileSync(out);
  // modrinth.index.json хранится первым — достаём и разбираем его.
  const nameLen = raw.readUInt16LE(26);
  const size = raw.readUInt32LE(18);
  const method = raw.readUInt16LE(8);
  const body = raw.subarray(30 + nameLen, 30 + nameLen + size);
  const json = JSON.parse((method === 8 ? require('zlib').inflateRawSync(body) : body).toString('utf8'));
  assert.deepEqual(json.dependencies, { minecraft: '1.21.1', 'fabric-loader': '0.16.5' });
  assert.equal(json.files.length, 1);
  assert.equal(json.files[0].env.client, 'required');
});

test('безопасные пути в чужой сборке', () => {
  assert.equal(mrpack.safeRel('mods/a.jar'), 'mods/a.jar');
  assert.equal(mrpack.safeRel('config/x/y.toml'), 'config/x/y.toml');
  for (const bad of ['../evil.jar', 'C:/x.jar', '/etc/x', 'config/../../x', 'run.bat', 'launcher.json', 'eula.txt', 'scripts/x.bat', 'a/evil.exe']) {
    assert.equal(mrpack.safeRel(bad), null, bad);
  }
});

test('сервер из .mrpack: только серверные файлы, overrides, защита путей', { skip: !isWin && 'нужен tar.exe из Windows' }, async (t) => {
  const d = tmpDir(t);
  const sha512 = (s) => crypto.createHash('sha512').update(s).digest('hex');
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '2.0',
    name: 'Тестовая сборка',
    dependencies: { minecraft: '1.21.1', neoforge: '21.1.77' },
    files: [
      { path: 'mods/server.jar', hashes: { sha512: sha512('s') }, downloads: ['https://cdn.modrinth.com/s.jar'], env: { client: 'required', server: 'required' } },
      { path: 'mods/client.jar', hashes: { sha512: sha512('c') }, downloads: ['https://cdn.modrinth.com/c.jar'], env: { client: 'required', server: 'unsupported' } },
      { path: 'resourcepacks/rp.zip', hashes: { sha512: sha512('r') }, downloads: ['https://cdn.modrinth.com/r.zip'] },
      { path: 'mods/evil.jar', hashes: { sha512: sha512('e') }, downloads: ['https://evil.example.com/e.jar'] },
      { path: '../escape.jar', hashes: { sha512: sha512('x') }, downloads: ['https://cdn.modrinth.com/x.jar'] },
    ],
  };
  const file = path.join(d, 'p.mrpack');
  fs.writeFileSync(file, pack.zip([
    { name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index)) },
    { name: 'overrides/config/a.toml', data: Buffer.from('a = 1') },
    { name: 'overrides/run.bat', data: Buffer.from('echo evil') },
    { name: 'server-overrides/config/a.toml', data: Buffer.from('a = 2') },
  ]));
  const plan = await mrpack.read(file);
  assert.equal(plan.type, 'neoforge');
  assert.equal(plan.loader, '21.1.77');
  assert.deepEqual(plan.files.map((f) => f.path), ['mods/server.jar']);
  assert.equal(plan.skipped.length, 2); // клиентский мод и ресурспак
  assert.equal(plan.bad.length, 2); // чужой сайт и выход из папки

  // Скачивание не проверяем (нужен интернет) — ставим сборку без файлов, только overrides.
  plan.files = [];
  const srv = path.join(d, 'srv');
  const r = await mrpack.apply(plan, srv);
  assert.equal(fs.readFileSync(path.join(srv, 'config', 'a.toml'), 'utf8'), 'a = 2', 'серверные overrides важнее');
  assert.ok(!fs.existsSync(path.join(srv, 'run.bat')), 'файл запуска из сборки не записан');
  assert.equal(r.rejected, 1);
  assert.equal(mrpack.packLoader(srv), '21.1.77');
  assert.ok(!fs.existsSync(plan.tmpDir), 'временная папка удалена');
});
