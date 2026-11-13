// Проверка модов, журналы, диск, параметры Java, сеть Velocity, фоновые серверы, управление с телефона.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const modcheck = require('../lib/modcheck');
const logs = require('../lib/logs');
const disk = require('../lib/disk');
const jvm = require('../lib/jvm');
const velocity = require('../lib/velocity');
const { freePort } = require('../lib/runner');
const { createRemote } = require('../lib/remote');
const { tmpDir } = require('./helpers');

const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

/** Собрать .jar (zip) из файлов встроенным в Windows tar. */
function makeJar(dir, name, files) {
  const src = fs.mkdtempSync(path.join(dir, 'src-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), text);
  }
  const out = path.join(dir, 'mods', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(TAR, ['-a', '-cf', out + '.zip', '-C', src, ...Object.keys(files).map((f) => f.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)]);
  fs.renameSync(out + '.zip', out);
  fs.rmSync(src, { recursive: true, force: true });
}

test('проверка модов: клиентские, дубли, не тот загрузчик, повреждённые', { skip: !fs.existsSync(TAR) }, (t) => {
  const d = tmpDir(t);
  const fabric = (id, extra = {}) => ({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, name: id, version: '1.0', ...extra }) });
  makeJar(d, 'lithium.jar', fabric('lithium'));
  makeJar(d, 'lithium-old.jar', fabric('lithium'));
  makeJar(d, 'sodium.jar', fabric('sodium'));
  makeJar(d, 'hud.jar', fabric('hudmod', { environment: 'client' }));
  makeJar(d, 'forgemod.jar', { 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="create"\ndisplayName="Create"\n' });
  makeJar(d, 'lib.jar', { 'a.txt': 'library without metadata' });
  fs.writeFileSync(path.join(d, 'mods', 'broken.jar'), 'not a zip');
  const issues = modcheck.checkMods('fabric', d);
  const by = Object.fromEntries(issues.map((i) => [i.file, i.kind]));
  assert.equal(by['sodium.jar'], 'client');
  assert.equal(by['hud.jar'], 'client');
  assert.equal(by['forgemod.jar'], 'loader');
  assert.equal(by['broken.jar'], 'broken');
  assert.ok(by['lithium.jar'] === 'duplicate' || by['lithium-old.jar'] === 'duplicate');
  assert.equal(by['lib.jar'], undefined, 'библиотеки без описания не трогаем');
  assert.deepEqual(modcheck.checkMods('paper', d), [], 'для Paper моды не проверяются');
  // Тот же Forge-мод на Forge-сервере — без замечаний.
  assert.equal(modcheck.checkMods('forge', d).find((i) => i.file === 'forgemod.jar'), undefined);
});

test('журналы: список, чтение .gz, автоочистка не трогает latest.log', (t) => {
  const d = tmpDir(t);
  fs.mkdirSync(path.join(d, 'logs'));
  fs.mkdirSync(path.join(d, 'crash-reports'));
  fs.writeFileSync(path.join(d, 'logs', 'latest.log'), 'свежий');
  fs.writeFileSync(path.join(d, 'logs', '2020-01-01-1.log.gz'), zlib.gzipSync('старый журнал'));
  fs.writeFileSync(path.join(d, 'crash-reports', 'crash-2020-01-01_00.00.00-server.txt'), 'Description: Exception');
  const old = new Date('2020-01-02');
  fs.utimesSync(path.join(d, 'logs', '2020-01-01-1.log.gz'), old, old);
  fs.utimesSync(path.join(d, 'crash-reports', 'crash-2020-01-01_00.00.00-server.txt'), old, old);
  fs.utimesSync(path.join(d, 'logs', 'latest.log'), old, old);
  assert.equal(logs.list(d).length, 3);
  assert.equal(logs.read(d, 'log', '2020-01-01-1.log.gz'), 'старый журнал');
  assert.throws(() => logs.read(d, 'log', '../secret.log'), /Некорректное/);
  const r = logs.clean(d, 14);
  assert.equal(r.files, 2);
  assert.deepEqual(logs.list(d).map((x) => x.name), ['latest.log']);
});

test('место на диске: размеры и уровень предупреждения', async (t) => {
  const d = tmpDir(t);
  fs.mkdirSync(path.join(d, 'world'));
  fs.writeFileSync(path.join(d, 'world', 'level.dat'), Buffer.alloc(1000));
  fs.mkdirSync(path.join(d, 'backups'));
  fs.writeFileSync(path.join(d, 'backups', 'a.tar.gz'), Buffer.alloc(500));
  const u = await disk.usage(d);
  assert.equal(u.world, 1000);
  assert.equal(u.backups, 500);
  assert.ok(u.free > 0);
  const GB = 1024 ** 3;
  assert.equal(disk.level({ free: GB, world: 0 }), 'bad');
  assert.equal(disk.level({ free: 5 * GB, world: 0 }), 'warn');
  assert.equal(disk.level({ free: 50 * GB, world: 20 * GB }), 'bad');
  assert.equal(disk.level({ free: 50 * GB, world: GB }), 'ok');
});

test('параметры Java: флаги Aikar и подбор памяти', () => {
  assert.ok(jvm.aikarFlags(4).includes('-XX:+UseG1GC'));
  assert.ok(jvm.aikarFlags(4).includes('-XX:G1NewSizePercent=30'));
  assert.ok(jvm.aikarFlags(16).includes('-XX:G1NewSizePercent=40'));
  assert.deepEqual(jvm.recommendRam({ modded: false, players: 5 }), { min: 2, rec: 2 });
  assert.equal(jvm.recommendRam({ modded: true, mods: 200, players: 5 }).rec, 8);
  assert.equal(jvm.recommendRam({ modded: true, mods: 10, players: 30 }).rec, 6);
});

test('сеть Velocity: конфиг прокси и настройки Paper', (t) => {
  const used = new Set();
  assert.equal(velocity.slugName('Выживание с друзьями', used), 'server');
  assert.equal(velocity.slugName('Lobby 1', used), 'lobby-1');
  assert.equal(velocity.slugName('Lobby 1', used), 'lobby-1-2');
  const toml = velocity.velocityToml({ port: 25565, onlineMode: true, servers: [{ name: 'lobby', port: 25566 }, { name: 'survival', port: 25567 }] });
  assert.match(toml, /bind = "0\.0\.0\.0:25565"/);
  assert.match(toml, /lobby = "127\.0\.0\.1:25566"/);
  assert.match(toml, /try = \["lobby"\]/);
  assert.match(toml, /player-info-forwarding-mode = "modern"/);
  require('smol-toml').parse(toml); // конфиг — корректный TOML
  const d = tmpDir(t);
  assert.throws(() => velocity.enablePaperForwarding(d, 'x'), /paper-global/);
  fs.mkdirSync(path.join(d, 'config'));
  fs.writeFileSync(path.join(d, 'config', 'paper-global.yml'), '# комментарий\nproxies:\n  velocity:\n    enabled: false\n    online-mode: true\n    secret: \'\'\nmisc:\n  foo: 1\n');
  velocity.enablePaperForwarding(d, 'SECRET');
  const y = require('yaml').parse(fs.readFileSync(path.join(d, 'config', 'paper-global.yml'), 'utf8'));
  assert.deepEqual(y.proxies.velocity, { enabled: true, 'online-mode': true, secret: 'SECRET' });
  assert.equal(y.misc.foo, 1);
  assert.match(fs.readFileSync(path.join(d, 'config', 'paper-global.yml'), 'utf8'), /# комментарий/);
  assert.equal(freePort([25565, 25566, 25567], 25566), 25568);
});

test('управление с телефона: вход по коду, защита от подбора и чужих страниц', async () => {
  const calls = [];
  const r = createRemote({
    status: () => ({ state: 'stopped', name: 'Тест', players: [], tps: null, log: [], canStart: true }),
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    command: (t) => calls.push('cmd:' + t),
  });
  const port = 18765 + Math.floor(Math.random() * 1000);
  const info = await r.enable(port);
  try {
    const base = `http://127.0.0.1:${port}`;
    const H = { 'Content-Type': 'application/json', 'X-Mcl': '1' };
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/api/status', { headers: H })).status, 401);
    assert.equal((await fetch(base + '/api/status')).status, 403, 'без заголовка — отказ');
    const bad = await fetch(base + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ code: '000000' === info.code ? '111111' : '000000' }) });
    assert.equal(bad.status, 401);
    const ok = await fetch(base + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ code: info.code }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const st = await (await fetch(base + '/api/status', { headers: { ...H, Cookie: cookie } })).json();
    assert.equal(st.name, 'Тест');
    await fetch(base + '/api/command', { method: 'POST', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ text: 'say hi\nstop' }) });
    assert.deepEqual(calls, ['cmd:say hi stop']);
    r.newCode();
    assert.equal((await fetch(base + '/api/status', { headers: { ...H, Cookie: cookie } })).status, 401, 'новый код — старые входы недействительны');
  } finally {
    r.disable();
  }
});
