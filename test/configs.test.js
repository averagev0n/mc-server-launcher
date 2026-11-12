const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const configs = require('../lib/configs');
const { tmpDir } = require('./helpers');

/** Сколько строк файла отличается. */
function diffLines(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  let n = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}

function roundTrip(t, name, text, key, value) {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, name), text);
  const r = configs.readConfig(d, name);
  const f = r.fields.find((x) => x.key === key);
  assert.ok(f, `поле ${key} найдено`);
  const r2 = configs.saveFields(d, name, [{ id: f.id, value }], r.version);
  assert.equal(diffLines(text, r2.text), 1, 'изменилась ровно одна строка');
  assert.ok(fs.existsSync(path.join(d, name + '.bak')), 'есть резервная копия');
  return r2;
}

test('YAML: комментарии и оформление сохраняются', (t) => {
  const text = '# заголовок\nsettings:\n  # описание\n  debug: false # хвост\n  name: "Bob"\n';
  const r = roundTrip(t, 'config.yml', text, 'debug', true);
  assert.match(r.text, /debug: true # хвост/);
  assert.match(r.text, /# описание/);
});

test('TOML: диапазоны и варианты из комментариев Forge', (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, 'a.toml'), '[general]\n\t#Range: 1 ~ 64\n\tradius = 16\n\t#Allowed Values: A, B\n\tmode = "A"\n');
  const r = configs.readConfig(d, 'a.toml');
  const radius = r.fields.find((x) => x.key === 'radius');
  const mode = r.fields.find((x) => x.key === 'mode');
  assert.equal(radius.max, 64);
  assert.equal(mode.type, 'enum');
  assert.throws(() => configs.saveFields(d, 'a.toml', [{ id: radius.id, value: 100 }], r.version), /от 1 до 64/);
  roundTrip(t, 'b.toml', '[general]\n\tenabled = true # c\n\tratio = 0.5\n', 'ratio', 0.75);
});

test('JSON с комментариями и .properties', (t) => {
  roundTrip(t, 'mod.json', '{\n  // c\n  "a": {"b": 1},\n  "s": "x"\n}\n', 'b', 5);
  roundTrip(t, 'server.properties', '#x\npvp=true\nmax-players=20\n', 'pvp', false);
});

test('битый текст не сохраняется, выход за папку запрещён', (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, 'c.yml'), 'a: 1\n');
  const r = configs.readConfig(d, 'c.yml');
  assert.throws(() => configs.saveText(d, 'c.yml', 'a: [\n', r.version), /YAML/);
  assert.throws(() => configs.readConfig(d, '../x.yml'), /Некорректный/);
});

test('файл изменился на диске — правка его не затирает', (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, 'c.yml'), 'a: 1\n');
  const r = configs.readConfig(d, 'c.yml');
  fs.writeFileSync(path.join(d, 'c.yml'), 'a: 2\n');
  assert.throws(() => configs.saveFields(d, 'c.yml', [{ id: r.fields[0].id, value: 3 }], r.version), /изменился/);
});
