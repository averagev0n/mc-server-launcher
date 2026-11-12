const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose, unknownCrash } = require('../lib/diagnose');

const ids = (lines, ctx = {}) => [...new Set(diagnose(lines, 0, ctx).map((x) => x.id))];

test('частые ошибки распознаются', () => {
  assert.deepEqual(ids(['**** FAILED TO BIND TO PORT!']), ['port']);
  assert.deepEqual(ids(['java.net.BindException: Cannot assign requested address: bind']), ['bad-ip']);
  assert.deepEqual(ids(['java.lang.OutOfMemoryError: Java heap space']), ['oom']);
  assert.deepEqual(ids(['Unknown/missing dependency plugins: [Vault]']), ['plugin-dep']);
  assert.deepEqual(ids(["Can't keep up! Is the server overloaded? Running 5032ms or 100 ticks behind"]), ['lag']);
  assert.deepEqual(ids(['обычная строка без ошибок']), []);
});

test('Java 21 вместо 17: правильные номера версий', () => {
  const [x] = diagnose(
    ['class file version 65.0, this version of the Java Runtime only recognizes class file versions up to 61.0'],
    0,
    {}
  );
  assert.equal(x.title, 'Нужна Java 21, а запущена Java 17');
});

test('части Fabric API склеиваются в одну карточку', () => {
  const lines = [
    " - Mod 'LuckPerms' (luckperms) 5.5.85 requires any version of fabric-api-base, which is missing!",
    " - Mod 'LuckPerms' (luckperms) 5.5.85 requires any version of fabric-command-api-v2, which is missing!",
  ];
  const found = diagnose(lines, 0, {});
  assert.deepEqual([...new Set(found.map((x) => x.key))], ['fabric-dep:fabric-api']);
  assert.match(found[0].title, /Fabric API/);
});

test('Forge: мод для другой версии игры и понятный диапазон', () => {
  const [x] = diagnose(
    ["\tMod ID: 'minecraft', Requested by: 'create', Expected range: '[1.20.1,1.20.2)', Actual version: '1.21.1'"],
    0,
    {}
  );
  assert.match(x.title, /другой версии игры/);
  assert.match(x.text, /от 1\.20\.1 до 1\.20\.2/);
});

test('незнакомая ошибка — общая карточка с копированием журнала', () => {
  const x = unknownCrash(1, {});
  assert.equal(x.id, 'unknown-crash');
  assert.ok(x.actions.some((a) => a.type === 'copy'));
});
