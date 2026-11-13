// Расписание работы, нагрузка за неделю, чат, Telegram, мир для одиночной игры.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const power = require('../lib/power');
const history = require('../lib/history');
const chat = require('../lib/chat');
const { parseCommand, createTelegram } = require('../lib/telegram');
const singleplayer = require('../lib/singleplayer');
const backup = require('../lib/backup');
const { tmpDir } = require('./helpers');

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);

test('расписание: обычное окно, через полночь, дни недели', () => {
  const weekdays = power.clean({ enabled: true, from: '18:00', to: '23:00', days: [1, 1, 1, 1, 1, 0, 0] });
  // 2026-11-16 — понедельник, 2026-11-21 — суббота.
  assert.equal(power.inWindow(weekdays, at(2026, 11, 16, 18, 0)), true);
  assert.equal(power.inWindow(weekdays, at(2026, 11, 16, 23, 0)), false);
  assert.equal(power.inWindow(weekdays, at(2026, 11, 16, 17, 59)), false);
  assert.equal(power.inWindow(weekdays, at(2026, 11, 21, 19, 0)), false);
  const night = power.clean({ enabled: true, from: '20:00', to: '02:00', days: [0, 0, 0, 0, 1, 0, 0] }); // только пятница
  assert.equal(power.inWindow(night, at(2026, 11, 20, 21, 0)), true); // пятница вечер
  assert.equal(power.inWindow(night, at(2026, 11, 21, 1, 30)), true); // ночь на субботу
  assert.equal(power.inWindow(night, at(2026, 11, 21, 2, 0)), false);
  assert.equal(power.inWindow(night, at(2026, 11, 20, 1, 0)), false); // ночь на пятницу — четверг не отмечен
  assert.equal(power.inWindow({ ...weekdays, enabled: false }, at(2026, 11, 16, 19, 0)), false);
  assert.equal(power.describe(weekdays), 'Пн–Пт, 18:00–23:00');
  assert.throws(() => power.clean({ from: '25:00' }), /ЧЧ:ММ/);
  assert.throws(() => power.clean({ enabled: true, days: [0, 0, 0, 0, 0, 0, 0] }), /день/);
});

test('расписание сохраняется в настройках сервера', (t) => {
  const d = tmpDir(t);
  assert.equal(backup.readSettings(d).power.enabled, false);
  backup.writeSettings(d, { power: { enabled: true, from: '10:00', to: '12:00' } });
  const p = backup.readSettings(d).power;
  assert.deepEqual([p.enabled, p.from, p.to, p.days.length], [true, '10:00', '12:00', 7]);
  backup.writeSettings(d, { discord: { url: '' } });
  assert.equal(backup.readSettings(d).power.enabled, true, 'другие настройки не сбрасывают расписание');
});

test('копии мира в одну секунду не затирают друг друга', async (t) => {
  const d = tmpDir(t);
  fs.mkdirSync(path.join(d, 'world'));
  fs.writeFileSync(path.join(d, 'world', 'level.dat'), 'x');
  const names = [];
  for (let i = 0; i < 3; i++) names.push((await backup.create(d, i === 1 ? 'before-restore' : 'manual')).file);
  assert.equal(new Set(names).size, 3, names.join(' '));
  assert.equal(backup.list(d).length, 3);
});

test('нагрузка за неделю: 10-минутные корзины, старое удаляется, выводы', (t) => {
  const d = tmpDir(t);
  let now = at(2026, 11, 16, 20, 1).getTime();
  const h = history.createHistory(d, () => now);
  h.add({ players: 2, tps: 20, memMb: 1000, cpu: 10 });
  h.add({ players: 5, tps: 12.5, memMb: 3000, cpu: 30 });
  now += 10 * 60 * 1000;
  h.add({ players: 1, tps: 19.9, memMb: 2000, cpu: 5 }); // новая корзина — прошлая записана
  let saved = history.read(d);
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].p, saved[0].tps, saved[0].mem, saved[0].cpu], [5, 12.5, 2000, 20]);
  assert.equal(h.points().length, 2, 'вместе с текущей корзиной');
  h.flush();
  const s = history.summary(history.read(d));
  assert.equal(s.maxPlayers, 5);
  assert.equal(s.peakHour, 20);
  assert.equal(s.worst.tps, 12.5);
  // Через 8 дней старое уходит.
  now += 8 * 24 * 3600 * 1000;
  h.add({ players: 0, tps: 20, memMb: 500, cpu: 1 });
  h.flush();
  saved = history.read(d);
  assert.equal(saved.length, 1);
});

test('чат: строки игроков и ответ от имени сервера', () => {
  assert.deepEqual(chat.parseChat('[20:01:02] [Server thread/INFO]: <Steve> привет всем'), { name: 'Steve', text: 'привет всем' });
  assert.deepEqual(chat.parseChat('[20:01:02] [Async Chat Thread - #0/INFO]: [Not Secure] <.Bedrock_1> hi'), { name: '.Bedrock_1', text: 'hi' });
  assert.equal(chat.parseChat('[20:01:02] [Server thread/INFO]: Steve joined the game'), null);
  assert.equal(chat.parseChat('[20:01:02] [Server thread/INFO]: [Server] hello'), null);
  const cmd = chat.tellraw('@a', 'Привет "всем"\nstop');
  assert.ok(cmd.startsWith('tellraw @a ['));
  assert.ok(!cmd.includes('\n'));
  assert.deepEqual(JSON.parse(cmd.slice('tellraw @a '.length))[2], { text: 'Привет "всем" stop' });
  assert.ok(chat.tellraw('Steve', 'hi').startsWith('tellraw Steve '));
  assert.throws(() => chat.tellraw('@e[type=creeper]', 'x'), /ник/);
  assert.throws(() => chat.tellraw('@a', '   '), /Пустое/);
});

test('Telegram: разбор команд и привязка только по коду', async () => {
  assert.deepEqual(parseCommand('/say@MyBot Всем привет'), { cmd: 'say', arg: 'Всем привет' });
  assert.deepEqual(parseCommand('/status'), { cmd: 'status', arg: '' });
  assert.equal(parseCommand('просто текст'), null);
  const tg = createTelegram({ fetchFn: async () => ({ status: 200, json: async () => ({ ok: true, result: {} }) }), onMessage() {}, onFatal() {} });
  await assert.rejects(tg.me('не токен'), /токен/);
  // Ответ Telegram 401 — понятная ошибка.
  const bad = createTelegram({ fetchFn: async () => ({ status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) }), onMessage() {}, onFatal() {} });
  await assert.rejects(bad.me('123456789:' + 'A'.repeat(35)), /не принял токен/);
});

test('мир для одиночной игры: измерения Paper собираются в одну папку, название меняется', (t) => {
  const d = tmpDir(t);
  const nbt = (name) => {
    const s = Buffer.from(name, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(s.length);
    // корневой compound «» → compound Data → string LevelName → int → конец, конец
    return zlib.gzipSync(Buffer.concat([
      Buffer.from([0x0a, 0, 0, 0x0a, 0, 4]), Buffer.from('Data'),
      Buffer.from([0x08, 0, 9]), Buffer.from('LevelName'), len, s,
      Buffer.from([0x03, 0, 1]), Buffer.from('x'), Buffer.from([0, 0, 0, 7]),
      Buffer.from([0, 0]),
    ]));
  };
  fs.mkdirSync(path.join(d, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(d, 'world', 'level.dat'), nbt('world'));
  fs.writeFileSync(path.join(d, 'world', 'session.lock'), 'lock');
  fs.writeFileSync(path.join(d, 'world', 'region', 'r.0.0.mca'), 'overworld');
  fs.mkdirSync(path.join(d, 'world_nether', 'DIM-1', 'region'), { recursive: true });
  fs.writeFileSync(path.join(d, 'world_nether', 'DIM-1', 'region', 'r.0.0.mca'), 'nether');
  fs.mkdirSync(path.join(d, 'world_the_end', 'DIM1', 'region'), { recursive: true });
  fs.writeFileSync(path.join(d, 'world_the_end', 'DIM1', 'region', 'r.0.0.mca'), 'end');
  const saves = path.join(d, 'saves');
  fs.mkdirSync(saves);
  const name = singleplayer.uniqueName(saves, singleplayer.safeName('Мир: друзья?'));
  assert.equal(name, 'Мир друзья');
  const dest = path.join(saves, name);
  const r = singleplayer.exportWorld(d, 'world', dest);
  assert.deepEqual(r.dims, ['nether', 'end']);
  assert.equal(fs.readFileSync(path.join(dest, 'DIM-1', 'region', 'r.0.0.mca'), 'utf8'), 'nether');
  assert.equal(fs.readFileSync(path.join(dest, 'DIM1', 'region', 'r.0.0.mca'), 'utf8'), 'end');
  assert.equal(fs.existsSync(path.join(dest, 'session.lock')), false);
  assert.equal(singleplayer.uniqueName(saves, name), 'Мир друзья (2)');
  assert.equal(singleplayer.renameLevel(path.join(dest, 'level.dat'), 'Мир друзья'), true);
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(dest, 'level.dat')));
  assert.ok(raw.includes(Buffer.from('Мир друзья', 'utf8')));
  assert.equal(raw.readInt32BE(raw.length - 6), 7, 'остальные данные не сдвинулись и не испортились');
  assert.throws(() => singleplayer.exportWorld(d, 'world', dest), /уже существует/);
  assert.throws(() => singleplayer.exportWorld(d, 'nope', path.join(saves, 'x')), /Мира ещё нет/);
});
