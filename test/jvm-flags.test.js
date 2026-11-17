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

test('checkFlags убирает флаг, которого Java не знает, и оставляет остальные', async () => {
  const known = new Set(['UseG1GC', 'MaxGCPauseMillis']);
  const calls = [];
  const fake = async (_java, args) => {
    calls.push(args);
    const bad = args.map(jvm.flagName).find((n) => n && !known.has(n));
    return bad ? { code: 1, stderr: `Unrecognized VM option '${bad}=5'\nError: Could not create the Java Virtual Machine.` } : { code: 0, stderr: '' };
  };
  const r = await jvm.checkFlags('java', ['-XX:+UseG1GC', '-XX:Bogus=5', '-XX:MaxGCPauseMillis=200', '-Dx=y'], fake);
  assert.deepEqual(r.flags, ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200', '-Dx=y']);
  assert.deepEqual(r.dropped, ['-XX:Bogus=5']);
  assert.equal(r.failed, false);
  assert.equal(calls.length, 2);
});

test('checkFlags: непонятная ошибка — без флагов; Java не ответила — флаги как есть', async () => {
  const flags = ['-XX:+UseG1GC'];
  const broken = await jvm.checkFlags('java', flags, async () => ({ code: 1, stderr: 'Error occurred during initialization of VM' }));
  assert.deepEqual(broken.flags, []);
  assert.equal(broken.failed, true);
  const silent = await jvm.checkFlags('java', flags, async () => ({ code: null, stderr: 'spawn ENOENT' }));
  assert.deepEqual(silent.flags, flags);
});

test('badOption понимает разные сообщения Java', () => {
  assert.equal(jvm.badOption("Unrecognized VM option 'G1RSetUpdatingPauseTimeTarget=5'"), 'G1RSetUpdatingPauseTimeTarget');
  assert.equal(jvm.badOption("Error: VM option 'G1NewSizePercent' is experimental and must be enabled"), 'G1NewSizePercent');
  assert.equal(jvm.badOption("Unrecognized VM option '+UseFoo'"), 'UseFoo');
  assert.equal(jvm.badOption('всё хорошо'), null);
});

test('настоящая Java: лишний флаг отбрасывается, Aikar остаются', { skip: !hasJava && 'Java не найдена' }, async () => {
  const flags = [...jvm.aikarFlags(4), '-XX:G1RSetUpdatingPauseTimeTarget=5'];
  const r = await jvm.checkFlags('java', flags);
  assert.deepEqual(r.dropped, ['-XX:G1RSetUpdatingPauseTimeTarget=5']);
  assert.deepEqual(r.flags, jvm.aikarFlags(4));
});

test('флаги Aikar: нет опечаток в известных названиях', () => {
  const flags = jvm.aikarFlags(8);
  assert.ok(flags.includes('-XX:G1RSetUpdatingPauseTimePercent=5'));
  assert.ok(!flags.some((f) => /PauseTimeTarget/.test(f)));
});
