'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bisect = require('../lib/bisect');

const mk = (n, deps = {}) =>
  Array.from({ length: n }, (_, i) => ({ file: `m${String(i).padStart(2, '0')}.jar`, name: `M${i}`, ids: [`m${i}`], deps: deps[i] || [] }));

function run(mods, crashes) {
  const s = bisect.createSearch(mods);
  for (let i = 0; i < 50; i++) {
    const step = s.next();
    if (step.done) return { ...step, runs: s.runs };
    s.report(crashes(new Set(step.enable)));
  }
  throw new Error('не сошлось');
}

test('bisect: находит один сломанный мод из 40 за ~7 запусков', () => {
  const mods = mk(40);
  for (const bad of [0, 13, 39]) {
    const r = run(mods, (on) => on.has(mods[bad].file));
    assert.strictEqual(r.culprit, mods[bad].file);
    assert.ok(r.runs <= 8, `запусков: ${r.runs}`);
  }
});

test('bisect: сервер не падает со всеми модами — искать нечего', () => {
  const r = run(mk(10), () => false);
  assert.ok(r.noRepro);
  assert.strictEqual(r.runs, 1);
});

test('bisect: зависимости включаются вместе с модом', () => {
  // m5 требует m30; падает m5 (а не отсутствие m30).
  const mods = mk(32, { 5: ['m30'] });
  const r = run(mods, (on) => {
    if (on.has('m05.jar')) assert.ok(on.has('m30.jar'), 'm05 запущен без своей зависимости');
    return on.has('m05.jar');
  });
  assert.strictEqual(r.culprit, 'm05.jar');
  assert.deepStrictEqual(r.needs, ['m30.jar']);
});

test('bisect: падение только от сочетания двух модов', () => {
  const mods = mk(8);
  const r = run(mods, (on) => on.has('m01.jar') && on.has('m06.jar'));
  // Находит один из пары; второй останется включённым как «уже проверенный».
  assert.ok(r.culprit === 'm06.jar' || r.culprit === 'm01.jar' || r.combo);
});

test('bisect: закрытие по зависимостям через provides', () => {
  const mods = [
    { file: 'a.jar', ids: ['a'], deps: ['fabric'] },
    { file: 'api.jar', ids: ['fabric-api', 'fabric'], deps: [] },
  ];
  assert.deepStrictEqual(bisect.closure(['a.jar'], mods).sort(), ['a.jar', 'api.jar']);
});

test('bisect: раскладка модов и восстановление', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-'));
  fs.mkdirSync(path.join(dir, 'mods'));
  for (const f of ['a.jar', 'b.jar', 'c.jar']) fs.writeFileSync(path.join(dir, 'mods', f), f);
  bisect.begin(dir, 'world');
  fs.mkdirSync(path.join(dir, bisect.TEST_LEVEL));
  bisect.arrange(dir, ['b.jar']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'mods')), ['b.jar']);
  bisect.arrange(dir, ['a.jar', 'c.jar']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'mods')).sort(), ['a.jar', 'c.jar']);
  assert.ok(bisect.pending(dir));
  let level = null;
  assert.ok(bisect.restore(dir, (l) => (level = l)));
  assert.strictEqual(level, 'world');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'mods')).sort(), ['a.jar', 'b.jar', 'c.jar']);
  assert.ok(!fs.existsSync(path.join(dir, bisect.TEST_LEVEL)));
  assert.ok(!bisect.pending(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});
