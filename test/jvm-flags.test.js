// Флаги Aikar должны принимать настоящая Java: неизвестный флаг не даёт серверу даже стартовать.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const jvm = require('../lib/jvm');

const probe = spawnSync('java', ['-version'], { encoding: 'utf8' });
const hasJava = !probe.error && probe.status === 0;

for (const ram of [4, 16]) {
  test(`флаги Aikar для ${ram} ГБ принимает установленная Java`, { skip: !hasJava && 'Java не найдена' }, () => {
    const r = spawnSync('java', ['-Xms1g', '-Xmx1g', ...jvm.aikarFlags(ram).filter((f) => f !== '-XX:+AlwaysPreTouch'), '-version'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/Unrecognized VM option|Could not create the Java Virtual Machine/.test(r.stderr), r.stderr);
  });
}

test('флаги Aikar: нет опечаток в известных названиях', () => {
  const flags = jvm.aikarFlags(8);
  assert.ok(flags.includes('-XX:G1RSetUpdatingPauseTimePercent=5'));
  assert.ok(!flags.some((f) => /PauseTimeTarget/.test(f)));
});
