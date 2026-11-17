// Управление сервером на VPS: настройки server.properties, замеры нагрузки, удаление, число игроков.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const m = require('../lib/vps-manage');
const { createVps } = require('../lib/vps');
const { tmpDir } = require('./helpers');

test('server.properties: разбор с комментариями и экранированием Java', () => {
  const text = '#Minecraft server properties\n#Mon Nov 17\nmotd=\\u00A7aПривет \\u041c\\u0438\\u0440\npvp=true\nlevel-name=world\nkey\\:x=a\\=b\n  spaced = 5\n\n';
  assert.deepEqual(m.parseProps(text), [
    ['motd', '§aПривет Мир'],
    ['pvp', 'true'],
    ['level-name', 'world'],
    ['key:x', 'a=b'],
    ['spaced', '5'],
  ]);
});

test('server.properties: правка не трогает остальные строки, новые ключи — в конец', () => {
  const text = '#comment\r\nmotd=old\r\npvp=true\r\nmax-players=20\r\n';
  const out = m.patchProps(text, { pvp: 'false', motd: '§aМой сервер', 'view-distance': '8' });
  assert.equal(out, '#comment\nmotd=\\u00a7a\\u041c\\u043e\\u0439 \\u0441\\u0435\\u0440\\u0432\\u0435\\u0440\npvp=false\nmax-players=20\nview-distance=8\n');
  // Туда и обратно — то же самое.
  const back = new Map(m.parseProps(out));
  assert.equal(back.get('motd'), '§aМой сервер');
  assert.equal(back.get('pvp'), 'false');
  assert.equal(m.unescapeValue(m.escapeValue('C:\\мир')), 'C:\\мир');
});

test('server.properties: проверка значений', () => {
  const cur = [['pvp', 'true'], ['view-distance', '10'], ['max-players', '20'], ['some-number', '7'], ['motd', 'x']];
  assert.deepEqual(m.validateProps(cur, { pvp: 'false', 'view-distance': ' 12 ', motd: 'a\nb' }), { pvp: 'false', 'view-distance': '12', motd: 'a b' });
  assert.throws(() => m.validateProps(cur, { 'max-players': '0' }), /Число игроков/);
  assert.throws(() => m.validateProps(cur, { 'view-distance': '64' }), /Дальность прорисовки/);
  assert.throws(() => m.validateProps(cur, { gamemode: 'god' }), /gamemode/);
  assert.throws(() => m.validateProps(cur, { pvp: 'yes' }), /true или false/);
  assert.throws(() => m.validateProps(cur, { 'some-number': 'abc' }), /целое число/);
  assert.throws(() => m.validateProps(cur, { 'server-ip': '1.2.3' }), /IP сервера/);
  assert.throws(() => m.validateProps(cur, { 'bad key': '1' }), /имя параметра/);
  assert.throws(() => m.validateProps(cur, { 'level-name': '../x' }), /Имя мира/);
  assert.deepEqual(m.validateProps(cur, { 'server-ip': '' }), { 'server-ip': '' });
});

test('имя сервера на VPS: «.» и «..» не годятся', () => {
  assert.ok(m.safeName('paper-1.21.4'));
  assert.ok(m.safeName('paper.backup-20261117-1200'));
  for (const bad of ['.', '..', '...', 'a/b', 'a b', '', 'x'.repeat(65)]) assert.ok(!m.safeName(bad), bad);
  assert.throws(() => m.linuxDeleteScript('..'), /Некорректное имя/);
  assert.throws(() => m.linuxStatsScript('a;rm'), /Некорректное имя/);
});

test('замеры Linux: проценты по разнице двух замеров', () => {
  const a = m.parseStats('up=1000.00\nclk=100\npage=4096\nncpu=4\ncpu=1000 0 500 8000 500 0 0 0 0 0\nmem=8000000\nmemfree=3000000\ndisk=20971520\nproc=4000 262144 50000\n');
  const b = m.parseStats('up=1010.00\nclk=100\npage=4096\nncpu=4\ncpu=1800 0 700 11000 500 0 0 0 0 0\nmem=8000000\nmemfree=2900000\ndisk=20971520\nsize=1048576\nproc=6000 262144 50000\n');
  assert.equal(b.running, true);
  assert.equal(b.procMem, 1024 ** 3); // 262144 страниц по 4 КБ
  assert.equal(b.age, 510); // 1010 − 50000/100
  assert.equal(b.memTotal, 8000000 * 1024);
  assert.equal(b.size, 1024 ** 3);
  const load = m.computeLoad(a, b);
  // 20 с процессорного времени за 10 с на 4 ядрах = 50 %.
  assert.equal(load.cpu, 50);
  // Система: занято 1000 из 4000 тиков = 25 %.
  assert.equal(load.sysCpu, 25);
  assert.equal(m.computeLoad(null, b).cpu, null);
  const stopped = m.parseStats('up=5\nclk=100\nncpu=2\ncpu=1 1 1 1\nmem=1\nmemfree=1\n');
  assert.equal(stopped.running, false);
  assert.throws(() => m.parseStats('nodir=1\n'), /не найден/);
});

test('замеры Windows: тики по 100 нс, загрузка системы готовая', () => {
  const a = m.parseStats('now=10000000000\nncpu=2\nsyscpu=40\nmem=4000000\nmemfree=1000000\ndisk=100\nwproc=100000000 2147483648 300\n');
  const b = m.parseStats('now=10050000000\nncpu=2\nsyscpu=41\nmem=4000000\nmemfree=1000000\ndisk=100\nwproc=150000000 2147483648 305\n');
  assert.equal(b.procMem, 2 * 1024 ** 3);
  assert.equal(b.age, 305);
  const load = m.computeLoad(a, b);
  assert.equal(load.cpu, 50); // 5 с процессора за 5 с на 2 ядрах
  assert.equal(load.sysCpu, 41);
});

test('число игроков: запрос статуса как в игре', async (t) => {
  const probe = require('../lib/probe');
  const slp = require('../lib/slp');
  const srv = await probe.start(0, '127.0.0.1', { motd: 'test' });
  t.after(() => srv.close());
  const st = await slp.status('127.0.0.1', srv.port, 3000);
  assert.equal(st.online, 0);
  assert.equal(st.max, 0);
  assert.equal(st.version, 'Блокхост');
  await srv.close();
  await assert.rejects(slp.status('127.0.0.1', srv.port, 2000), /Порт закрыт|не ответил/);
});

/** Ненастоящий SFTP: та же папка на диске, пути — от «домашней» папки, как у OpenSSH. */
function fakeSftp(home) {
  return {
    readFile: (p, cb) => fs.readFile(path.join(home, p), cb),
    writeFile: (p, data, cb) => fs.writeFile(path.join(home, p), data, cb),
    end() {},
  };
}

test('настройки сервера на VPS: чтение и сохранение через SFTP', async (t) => {
  const home = tmpDir(t);
  const dir = path.join(home, 'mc-launcher', 'servers', 'srv1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcl.json'), JSON.stringify({ name: 'srv1', ramGb: 3, port: '25565', type: 'paper' }));
  fs.writeFileSync(path.join(dir, 'server.properties'), '#Minecraft server properties\nmotd=Hello\npvp=true\nserver-port=25565\nmax-players=20\n');
  const vps = createVps({ dataDir: home, encrypt: (s) => s, decrypt: (s) => s, openSftp: async () => fakeSftp(home) });

  const s = await vps.settings('x', 'srv1');
  assert.equal(s.ramGb, 3);
  assert.equal(s.hasFile, true);
  assert.deepEqual(s.props[0], ['motd', 'Hello']);

  await vps.saveSettings('x', 'srv1', { values: { pvp: 'false', 'server-port': '25570', motd: '§cКрасный' }, ramGb: 4 });
  const text = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(text, /^#Minecraft server properties$/m);
  assert.match(text, /^pvp=false$/m);
  assert.match(text, /^server-port=25570$/m);
  assert.match(text, /^motd=\\u00a7c\\u041a/m);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'mcl.json'), 'utf8'));
  assert.equal(meta.ramGb, 4);
  assert.equal(meta.port, '25570');
  assert.equal(meta.type, 'paper');

  // Ошибка в значении — файл не меняется.
  await assert.rejects(vps.saveSettings('x', 'srv1', { values: { pvp: 'maybe' } }), /true или false/);
  assert.equal(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), text);
  await assert.rejects(vps.saveSettings('x', 'srv1', { ramGb: 0 }), /Память/);
  await assert.rejects(vps.settings('x', 'nope'), /не найден/);
  await assert.rejects(vps.settings('x', '..'), /Некорректное имя/);
});

// Скрипты для Linux проверяем настоящим sh — на Linux (в CI это Ubuntu).
const isLinux = process.platform === 'linux';
test('Linux VPS: замер нагрузки и удаление сервера', { skip: !isLinux, timeout: 30000 }, async (t) => {
  const home = tmpDir(t);
  const dir = path.join(home, 'mc-launcher', 'servers', 'srv1');
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcl.json'), '{}');
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), Buffer.alloc(10000, 1));
  const env = { ...process.env, HOME: home };
  const sh = (script) => spawnSync('sh', ['-c', script], { encoding: 'utf8', env });

  // «Сервер» — своя группа процессов, как у mcl-start.sh (setsid).
  const proc = spawn('sh', ['-c', 'sleep 60 & sleep 60 & wait'], { detached: true, stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* уже завершён */
    }
  });
  fs.writeFileSync(path.join(dir, 'mcl.pid'), String(proc.pid));
  await new Promise((r) => setTimeout(r, 300));

  const st = m.parseStats(sh(m.linuxStatsScript('srv1', true)).stdout);
  assert.equal(st.running, true);
  assert.ok(st.procMem > 0, 'память процессов сервера');
  assert.ok(st.memTotal > 0 && st.memFree > 0);
  assert.ok(st.size >= 10000, 'размер папки');
  assert.ok(st.disk > 0);

  // Запущенный не удаляется.
  const busy = sh(m.linuxDeleteScript('srv1'));
  assert.equal(busy.status, 4);
  assert.ok(fs.existsSync(dir));

  process.kill(-proc.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  const stopped = m.parseStats(sh(m.linuxStatsScript('srv1', false)).stdout);
  assert.equal(stopped.running, false);
  const del = sh(m.linuxDeleteScript('srv1'));
  assert.match(del.stdout, /deleted/);
  assert.ok(!fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(home, 'mc-launcher', 'servers')));

  // Папку без mcl.json не трогаем.
  fs.mkdirSync(path.join(home, 'mc-launcher', 'servers', 'other'));
  assert.equal(sh(m.linuxDeleteScript('other')).status, 5);
  assert.ok(fs.existsSync(path.join(home, 'mc-launcher', 'servers', 'other')));
});
