'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { zip } = require('../lib/pack');
const zipread = require('../lib/zipread');

test('extractAll распаковывает zip и пропускает опасные пути', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'a.zip');
  fs.writeFileSync(
    file,
    zip([
      { name: 'overrides/config/a.toml', data: Buffer.from('x = 1') },
      { name: 'modrinth.index.json', data: Buffer.from('{"files":[]}'.repeat(50)) },
      { name: '../evil.txt', data: Buffer.from('no') },
      { name: '/abs.txt', data: Buffer.from('no') },
      { name: 'C:/win.txt', data: Buffer.from('no') },
    ])
  );
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  assert.equal(zipread.extractAll(file, out), 2);
  assert.equal(fs.readFileSync(path.join(out, 'overrides', 'config', 'a.toml'), 'utf8'), 'x = 1');
  assert.equal(fs.readFileSync(path.join(out, 'modrinth.index.json'), 'utf8').length, 12 * 50);
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
  assert.throws(() => zipread.extractAll(file, out, 10), /слишком большой/);
});

test('archive.zipFolder и unzip туда и обратно', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src', 'Мой мир');
  fs.mkdirSync(path.join(src, 'region'), { recursive: true });
  fs.writeFileSync(path.join(src, 'level.dat'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(src, 'region', 'r.0.0.mca'), Buffer.alloc(5000, 7));
  const archive = require('../lib/archive');
  const out = path.join(dir, 'world.zip');
  await archive.zipFolder(path.join(dir, 'src'), 'Мой мир', out);
  const back = path.join(dir, 'back');
  fs.mkdirSync(back);
  await archive.unzip(out, back);
  assert.deepEqual([...fs.readFileSync(path.join(back, 'Мой мир', 'level.dat'))], [1, 2, 3]);
  assert.equal(fs.readFileSync(path.join(back, 'Мой мир', 'region', 'r.0.0.mca')).length, 5000);
});
