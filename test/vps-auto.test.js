// Фоновые задачи на VPS (mcl-tick), история нагрузки, файлы сервера, перенос между системами.
// Скрипты для Linux гоняем настоящим sh на Linux (в CI это Ubuntu), для Windows — PowerShell на Windows.
// Вместо Minecraft — маленький «сервер»-скрипт, сеть и Планировщик заданий не трогаем.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const auto = require('../lib/vps-auto');
const win = require('../lib/vps-windows');
const players = require('../lib/players');
const { createVps } = require('../lib/vps');
const { tmpDir } = require('./helpers');

const isLinux = process.platform === 'linux';
const isWin = process.platform === 'win32';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('настройки фоновых задач: проверка, запись и чтение', () => {
  const c = auto.validateConf({ auto: true, restart: '03:30', warn: 10, backup: '04:00', keep: 5, discord: 'https://discord.com/api/webhooks/123/abc-DEF_1', djoin: true });
  assert.equal(c.auto, true);
  assert.equal(c.dcrash, true); // по умолчанию
  const back = auto.parseConf(auto.confText(c));
  assert.deepEqual(back, c);
  assert.throws(() => auto.validateConf({ restart: '25:00' }), /ЧЧ:ММ/);
  assert.throws(() => auto.validateConf({ keep: 0 }), /от 1 до 60/);
  assert.throws(() => auto.validateConf({ warn: 31 }), /от 0 до 30/);
  assert.throws(() => auto.validateConf({ discord: 'https://evil.example/api/webhooks/1/x' }), /вебхука/);
  // Битый файл — значения по умолчанию, лишнее не проходит.
  const bad = auto.parseConf('auto=1\nrestart=99:99\nkeep=1000\ndiscord=http://x\n');
  assert.equal(bad.auto, true);
  assert.equal(bad.restart, '');
  assert.equal(bad.keep, 60);
  assert.equal(bad.discord, '');
});

test('время: перевод в UTC и обратно через полночь', () => {
  assert.equal(auto.shiftTime('05:00', -180), '02:00');
  assert.equal(auto.shiftTime('01:30', -180), '22:30');
  assert.equal(auto.shiftTime('23:45', 30), '00:15');
  assert.equal(auto.shiftTime('bad', 10), '');
});

test('скрипты фоновых задач: подставлены версия и сообщения, перевод очищен от опасных знаков', () => {
  for (const plat of ['linux', 'windows']) {
    const t = auto.tickScript(plat);
    assert.doesNotMatch(t, /__T_\w+__|__VERSION__/);
    assert.equal(auto.installedVersion(t), '1-ru');
  }
  const en = auto.tickScript('linux', (s) => (s.startsWith('Сервер «{0}» упал (код {1}) —') ? 'Server "{0}" `crashed` $(rm) {1}' : s), 'en');
  assert.equal(auto.installedVersion(en), '1-en');
  // Кавычки, ` и $ из перевода убраны — остаются только переменные самого скрипта.
  assert.ok(en.includes('dc dcrash "Server ${NM} crashed (rm) ${CODE}"'));
});

test('события и история нагрузки', () => {
  const ev = auto.parseEvents('1794948383 join srv1 Steve_1\n1794948389 crash srv1 3\nмусор\n1794948390 rm -rf /\n');
  assert.deepEqual(ev, [
    { ts: 1794948383, kind: 'join', server: 'srv1', arg: 'Steve_1' },
    { ts: 1794948389, kind: 'crash', server: 'srv1', arg: '3' },
  ]);
  // Linux: время процессора в сотых долях секунды, загрузка VPS — по разнице busy/total.
  const T0 = 1794948000;
  const lin = auto.parseHistory([`${T0} 1000 500 100 1000 4000 1000 2 2`, `${T0 + 60} 7000 600 400 1600 4000 2000 3 2`, `${T0 + 120} - - 500 1700 4000 2000 - 2`].join('\n'));
  assert.equal(lin.length, 3);
  assert.equal(lin[0].cpu, null);
  assert.equal(lin[1].cpu, 50); // 60 с процессора за 60 с на 2 ядрах
  assert.equal(lin[1].sysCpu, 50);
  assert.equal(lin[1].sysUsed, 2000 * 1024);
  assert.equal(lin[1].players, 3);
  assert.equal(lin[2].cpu, null); // сервер остановлен
  // Windows: загрузка VPS приходит готовой (-1 вместо «всего»).
  const w = auto.parseHistory(`${T0} 0 1 37 -1 4000 1000 0 4`);
  assert.equal(w[0].sysCpu, 37);
  const b = auto.bucket(lin, (T0 - 100) * 1000, (T0 + 200) * 1000, 3);
  assert.equal(b.length, 3);
  assert.equal(b[0].sysCpu, null); // пустой отрезок — разрыв
  assert.equal(b[1].players, 3);
});

test('перенос между системами: аргументы запуска читаются из mcl-start', (t) => {
  const v = createVps({ dataDir: tmpDir(t), encrypt: (s) => s, decrypt: (s) => s });
  const args = ['@user_jvm_args.txt', "@libraries/net/neoforged/neoforge/21.1.1/win_args.txt", "it's"];
  const lin = v.startScript('/home/u/java', args);
  assert.deepEqual(auto.parseStartArgs(lin, 'linux'), ['@user_jvm_args.txt', '@libraries/net/neoforged/neoforge/21.1.1/unix_args.txt', "it's"]);
  const ps = win.startScript('C:\\j\\java.exe', ['-jar', 'server.jar']);
  assert.deepEqual(auto.parseStartArgs(ps, 'windows'), ['-jar', 'server.jar']);
  assert.deepEqual(auto.argsFor(['@x/unix_args.txt'], 'windows'), ['@x/win_args.txt']);
  assert.equal(auto.parseStartArgs('что-то другое', 'linux'), null);
});

test('пути файлов сервера: без выхода из папки, служебные файлы защищены', () => {
  assert.equal(auto.safeRel(''), '');
  assert.equal(auto.safeRel('/config/a.toml/'), 'config/a.toml');
  assert.equal(auto.safeRel('config\\мод.toml'), 'config/мод.toml');
  for (const bad of ['../x', 'a/../../b', 'a//b', 'C:/x', 'a/./b', 'a\u0000b']) assert.throws(() => auto.safeRel(bad), /путь/, bad);
  assert.throws(() => auto.safeEntryName('a/b'), /Имя/);
  assert.throws(() => auto.safeEntryName('..'), /Имя/);
  assert.equal(auto.safeEntryName(' мир 2 '), 'мир 2');
  assert.ok(auto.isProtected('mcl.json') && auto.isProtected('mcl-start.sh') && auto.isProtected('mcl.conf'));
  assert.ok(!auto.isProtected('config/mcl.json'));
  assert.ok(auto.BACKUP_RE.test('srv1-20261117-204624-manual.tar.gz'));
  assert.ok(!auto.BACKUP_RE.test('../srv1-20261117-204624-manual.tar.gz'));
});

test('списки игроков: правка файла остановленного сервера', async () => {
  const wl = await players.editList([], 'whitelist', 'add', 'Steve', { onlineMode: false });
  assert.equal(wl[0].name, 'Steve');
  assert.equal(wl[0].uuid, players.offlineUuid('Steve'));
  await assert.rejects(players.editList(wl, 'whitelist', 'add', 'steve', { onlineMode: false }), /Уже есть/);
  assert.deepEqual(await players.editList(wl, 'whitelist', 'remove', 'STEVE'), []);
  const ban = await players.editList([], 'ipbans', 'add', '203.0.113.5', { reason: 'гриф' });
  assert.equal(ban[0].reason, 'гриф');
  await assert.rejects(players.editList([], 'bans', 'add', 'bad name!'), /Ник/);
});

/** SFTP «на диске»: пути относительно home, как на VPS. */
function fakeSftp(home) {
  const p = (x) => path.join(home, x);
  const attrs = (st) => ({ mode: st.mode, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
  return {
    readFile: (x, cb) => fs.readFile(p(x), cb),
    writeFile: (x, data, opts, cb) => fs.writeFile(p(x), data, typeof opts === 'function' ? opts : cb),
    readdir: (x, cb) =>
      fs.readdir(p(x), (e, names) => {
        if (e) return cb(e);
        cb(null, names.map((n) => ({ filename: n, attrs: attrs(fs.lstatSync(path.join(p(x), n))) })));
      }),
    stat: (x, cb) => fs.stat(p(x), (e, st) => cb(e, st && attrs(st))),
    lstat: (x, cb) => fs.lstat(p(x), (e, st) => cb(e, st && attrs(st))),
    unlink: (x, cb) => fs.unlink(p(x), cb),
    rmdir: (x, cb) => fs.rmdir(p(x), cb),
    mkdir: (x, cb) => fs.mkdir(p(x), cb),
    rename: (a, b, cb) => (fs.existsSync(p(b)) ? cb(new Error('exists')) : fs.rename(p(a), p(b), cb)),
    fastPut: (local, x, opts, cb) => fs.copyFile(local, p(x), typeof opts === 'function' ? opts : cb),
    fastGet: (x, local, opts, cb) => fs.copyFile(p(x), local, typeof opts === 'function' ? opts : cb),
    end() {},
  };
}

test('файлы сервера на VPS: список, правка, загрузка, защита служебных файлов', async (t) => {
  const home = tmpDir(t);
  const dir = path.join(home, 'mc-launcher', 'servers', 'srv1');
  fs.mkdirSync(path.join(dir, 'config', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcl.json'), JSON.stringify({ name: 'srv1' }));
  fs.writeFileSync(path.join(dir, 'config', 'a.toml'), 'x = 1\n');
  fs.writeFileSync(path.join(dir, 'config', 'deep', 'b.txt'), 'b');
  fs.writeFileSync(path.join(dir, 'world.bin'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(dir, 'backups', 'srv1-20261117-204624-manual.tar.gz'), 'gz');
  fs.writeFileSync(path.join(dir, 'backups', 'чужой.zip'), 'zip');
  const vps = createVps({ dataDir: home, encrypt: (s) => s, decrypt: (s) => s, openSftp: async () => fakeSftp(home) });

  const root = await vps.files('x', 'srv1', '');
  assert.equal(root.items[0].dir, true); // папки — первыми
  assert.ok(root.items.find((i) => i.name === 'mcl.json').protected);
  assert.equal((await vps.fileRead('x', 'srv1', 'config/a.toml')).text, 'x = 1\n');
  await assert.rejects(vps.fileRead('x', 'srv1', 'world.bin'), /не текстовый/);
  await vps.fileWrite('x', 'srv1', 'config/a.toml', 'x = 2\n');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'a.toml'), 'utf8'), 'x = 2\n');
  await assert.rejects(vps.fileWrite('x', 'srv1', 'mcl.json', '{}'), /ведёт сам/);
  await assert.rejects(vps.fileRemove('x', 'srv1', 'mcl.json'), /нужен лаунчеру/);
  await assert.rejects(vps.files('x', 'srv1', '../..'), /путь/);
  await assert.rejects(vps.fileRemove('x', 'srv1', ''), /Удалить сервер/);

  await vps.fileMkdir('x', 'srv1', 'config', 'новая');
  assert.ok(fs.statSync(path.join(dir, 'config', 'новая')).isDirectory());
  await vps.fileRename('x', 'srv1', 'config/a.toml', 'c.toml');
  assert.ok(fs.existsSync(path.join(dir, 'config', 'c.toml')));
  await assert.rejects(vps.fileRename('x', 'srv1', 'config/c.toml', 'b/../x'), /Имя/);

  const local = path.join(home, 'mod.jar');
  fs.writeFileSync(local, 'jar');
  await vps.fileUpload('x', 'srv1', 'config', [local]);
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'mod.jar'), 'utf8'), 'jar');
  const out = path.join(home, 'down.txt');
  await vps.fileDownload('x', 'srv1', 'config/deep/b.txt', out);
  assert.equal(fs.readFileSync(out, 'utf8'), 'b');

  // Папка удаляется со всем содержимым.
  await vps.fileRemove('x', 'srv1', 'config');
  assert.ok(!fs.existsSync(path.join(dir, 'config')));

  // Бэкапы: в списке только свои архивы.
  const list = await vps.backups('x', 'srv1');
  assert.deepEqual(list.map((b) => b.file), ['srv1-20261117-204624-manual.tar.gz']);
  assert.equal(list[0].kind, 'manual');
  await assert.rejects(vps.deleteBackup('x', 'srv1', '../mcl.json'), /Некорректный/);
  await vps.deleteBackup('x', 'srv1', list[0].file);
  assert.deepEqual(await vps.backups('x', 'srv1'), []);

  // История: нет файла — значит, фоновые задачи не включены.
  assert.equal((await vps.history('x', 'srv1')).text, null);
});

// ---- настоящие прогоны скриптов ----

const FAKE_SH = `#!/bin/sh
echo "[00:00:00] [Server thread/INFO]: Done (1.0s)!"
while IFS= read -r l; do
  case "$l" in
    stop) echo "stopping"; exit 0 ;;
    crash) echo "boom"; exit 3 ;;
    "save-all flush") echo "[00:00:01] [Server thread/INFO]: Saved the game" ;;
    "join "*) echo "[00:00:02] [Server thread/INFO]: \${l#join } joined the game" ;;
    *) echo "got:$l" ;;
  esac
done
`;

test('Linux VPS: фоновые задачи — события, бэкап, перезапуск после падения, восстановление, Discord', { skip: !isLinux, timeout: 90000 }, (t) => {
  const home = tmpDir(t);
  const B = path.join(home, 'mc-launcher');
  const D = path.join(B, 'servers', 'srv1');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(path.join(D, 'world'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(D, 'world', 'level.dat'), 'v1');
  fs.writeFileSync(path.join(D, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(D, 'mcl.json'), JSON.stringify({ name: 'srv1', ramGb: 2, port: '25565' }));
  const fake = path.join(B, 'fakejava.sh');
  fs.writeFileSync(fake, FAKE_SH, { mode: 0o755 });
  // «curl» только записывает, что ему передали, — в интернет ничего не уходит.
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${home}/curl.log"\n`, { mode: 0o755 });
  const v = createVps({ dataDir: home, encrypt: (s) => s, decrypt: (s) => s });
  fs.writeFileSync(path.join(D, 'mcl-start.sh'), v.startScript(fake, ['-jar', 'server.jar']), { mode: 0o755 });
  fs.writeFileSync(path.join(B, 'mcl-tick.sh'), auto.tickScript('linux'), { mode: 0o755 });

  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const sh = (script) => spawnSync('sh', ['-c', script], { encoding: 'utf8', env, cwd: home });
  const tick = (...a) => sh(`sh "$HOME/mc-launcher/mcl-tick.sh" ${a.join(' ')}`);
  const rd = (f) => (fs.existsSync(path.join(D, f)) ? fs.readFileSync(path.join(D, f), 'utf8') : '');
  const cmd = (x) => fs.appendFileSync(path.join(D, 'console.in'), x + '\n');
  const conf = (c) => fs.writeFileSync(path.join(D, 'mcl.conf'), auto.confText(auto.validateConf(c)));
  const alive = () => sh(`P=$(cat "${D}/mcl.pid" 2>/dev/null) && kill -0 "$P" 2>/dev/null && echo yes`).stdout.includes('yes');
  t.after(() => sh(`P=$(cat "${D}/mcl.pid" 2>/dev/null); [ -n "$P" ] && kill -KILL -- "-$P" 2>/dev/null; true`));

  // Запуск как в лаунчере.
  sh(`D="${D}"; cd "$D"; setsid nohup sh "$D/mcl-start.sh" 2 >/dev/null 2>&1 </dev/null & sleep 1.5; [ -f "$D/mcl.pid" ] && : > "$D/mcl.want"`);
  assert.ok(alive(), 'сервер запущен');
  conf({ auto: true, discord: 'https://discord.com/api/webhooks/1/abc', djoin: true, dcrash: true });

  let r = tick('tick');
  assert.equal(r.status, 0, r.stderr);
  const st = rd('mcl-stats.log').trim().split(/\s+/);
  assert.equal(st.length, 9);
  assert.ok(Number(st[2]) > 0, 'память процессов сервера');

  cmd('join Steve_1');
  sleep(2500);
  tick('tick');
  sleep(800);
  assert.match(rd('mcl-events.log'), /^\d+ join srv1 Steve_1$/m);
  const curl = fs.readFileSync(path.join(home, 'curl.log'), 'utf8');
  assert.match(curl, /Steve\\\\_1 зашёл на сервер «srv1»/);
  assert.match(curl, /"allowed_mentions":\{"parse":\[\]\}/);
  assert.match(curl, /^https:\/\/discord\.com\/api\/webhooks\/1\/abc$/m);

  // Бэкап на работающем: мир сохранён (save-all), служебные файлы и журналы не попали.
  r = tick('backup', 'srv1', 'manual');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const file = r.stdout.match(/file=(\S+)/)[1];
  assert.ok(auto.BACKUP_RE.test(file));
  const listed = sh(`tar -tzf "${D}/backups/${file}"`).stdout;
  assert.match(listed, /world\/level\.dat/);
  assert.doesNotMatch(listed, /mcl\.|console\.log|backups/);
  assert.deepEqual(rd('console.in').trim().split('\n').slice(-3), ['save-off', 'save-all flush', 'save-on']);

  // Падение: поднимается снова, событие записано.
  cmd('crash');
  sleep(2500);
  assert.ok(!alive());
  tick('tick');
  sleep(1000);
  assert.ok(alive(), 'перезапущен после падения');
  assert.match(rd('mcl-events.log'), /^\d+ crash srv1 3$/m);

  // Остановка из лаунчера (mcl.want убран) — фоновый скрипт сервер не трогает.
  sh(`rm -f "${D}/mcl.want"; echo stop >> "${D}/console.in"; sleep 2`);
  tick('tick');
  sleep(500);
  assert.ok(!alive());

  // Восстановление: мир из бэкапа, лишнее убрано, перед этим — копия текущего.
  fs.writeFileSync(path.join(D, 'world', 'level.dat'), 'v2');
  fs.writeFileSync(path.join(D, 'extra.txt'), 'x');
  r = tick('restore', 'srv1', file);
  assert.match(r.stdout, /restored/, r.stdout + r.stderr);
  assert.equal(rd('world/level.dat'), 'v1');
  assert.ok(!fs.existsSync(path.join(D, 'extra.txt')));
  assert.ok(fs.existsSync(path.join(D, 'mcl.json')));
  assert.ok(fs.readdirSync(path.join(D, 'backups')).some((f) => f.endsWith('-before-restore.tar.gz')));
  assert.match(tick('restore', 'srv1', '../x').stdout, /badname/);
  assert.match(tick('backup', '..').stdout, /badname/);
});

test('Windows VPS: фоновые задачи — события, бэкап, перезапуск после падения, восстановление', { skip: !isWin, timeout: 180000 }, (t) => {
  const home = tmpDir(t);
  const B = path.join(home, 'mc-launcher');
  const D = path.join(B, 'servers', 'srv1');
  fs.mkdirSync(path.join(D, 'world'), { recursive: true });
  fs.writeFileSync(path.join(D, 'world', 'level.dat'), 'v1');
  fs.writeFileSync(path.join(D, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(D, 'mcl.json'), JSON.stringify({ name: 'srv1', ramGb: 2, port: '25565' }));
  const fake = path.join(B, 'java.cmd');
  fs.writeFileSync(
    fake,
    '@echo off\r\necho [00:00:00] [Server thread/INFO]: Done\r\n:loop\r\nset "L="\r\nset /p L=\r\n' +
      'if "%L%"=="stop" (\r\n  echo stopping\r\n  exit /b 0\r\n)\r\n' +
      'if "%L%"=="crash" (\r\n  echo boom\r\n  exit /b 3\r\n)\r\n' +
      'if "%L%"=="save-all flush" echo [00:00:01] [Server thread/INFO]: Saved the game\r\n' +
      'if "%L:~0,5%"=="join " echo [00:00:02] [Server thread/INFO]: %L:~5% joined the game\r\n' +
      'goto loop\r\n'
  );
  fs.writeFileSync(path.join(D, 'mcl-start.ps1'), '\ufeff' + win.startScript(fake, ['-jar', 'server.jar']));
  fs.writeFileSync(path.join(B, 'mcl-tick.ps1'), '\ufeff' + auto.tickScript('windows'));
  const env = { ...process.env, USERPROFILE: home };
  const ps = (text, name) => {
    const f = path.join(home, name + '.ps1');
    fs.writeFileSync(f, '\ufeff' + text);
    return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', env });
  };
  // Рабочая папка — home: так видно, если скрипт насорит в текущей папке.
  const tick = (...a) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(B, 'mcl-tick.ps1'), ...a], { encoding: 'utf8', env, cwd: home });
  const rd = (f) => (fs.existsSync(path.join(D, f)) ? fs.readFileSync(path.join(D, f), 'utf8') : '');
  const cmd = (x) => fs.appendFileSync(path.join(D, 'console.in'), x + '\r\n');
  try {
    assert.match(ps(win.launchScript('srv1', 2), 'launch').stdout, /started/);
    assert.ok(fs.existsSync(path.join(D, 'mcl.want')), 'отметка «должен работать»');
    sleep(1500);
    let r = tick('-Mode', 'tick');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rd('mcl-stats.log').trim().split(/\s+/).length, 9);
    cmd('join Alex_2');
    sleep(2500);
    tick('-Mode', 'tick');
    assert.match(rd('mcl-events.log'), /^\d+ join srv1 Alex_2$/m);
    // «md» в PowerShell — это mkdir: функция с таким именем создавала бы папки там, где запущен скрипт.
    assert.ok(!fs.existsSync(path.join(home, 'srv1')) && !fs.existsSync(path.join(home, 'Alex_2')), 'лишние папки');

    r = tick('-Mode', 'backup', '-Name', 'srv1', '-Arg', 'manual');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const file = r.stdout.match(/file=(\S+)/)[1];
    const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
    const listed = spawnSync(tar, ['-tzf', path.join(D, 'backups', file)], { encoding: 'utf8' }).stdout;
    assert.match(listed, /world\/level\.dat/);
    assert.doesNotMatch(listed, /mcl\.|console\.log/);

    fs.writeFileSync(path.join(D, 'mcl.conf'), auto.confText(auto.validateConf({ auto: true })));
    cmd('crash');
    sleep(3000);
    tick('-Mode', 'tick');
    sleep(1500);
    assert.match(rd('mcl-events.log'), /^\d+ crash srv1 3$/m);
    assert.ok(fs.existsSync(path.join(D, 'mcl.pid')), 'перезапущен после падения');

    assert.match(ps(win.stopScript('srv1'), 'stop').stdout, /stopped/);
    tick('-Mode', 'tick');
    sleep(800);
    assert.ok(!fs.existsSync(path.join(D, 'mcl.pid')), 'после остановки из лаунчера не поднимается');

    fs.writeFileSync(path.join(D, 'world', 'level.dat'), 'v2');
    r = tick('-Mode', 'restore', '-Name', 'srv1', '-Arg', file);
    assert.match(r.stdout, /restored/, r.stdout + r.stderr);
    assert.equal(rd('world/level.dat'), 'v1');
    assert.ok(fs.existsSync(path.join(D, 'mcl.json')));
    assert.match(tick('-Mode', 'restore', '-Name', 'srv1', '-Arg', '..\\x').stdout, /badname/);
  } finally {
    ps(win.stopScript('srv1'), 'stop-final');
  }
});

test('Windows VPS: скрипты фоновых задач разбираются PowerShell', { skip: !isWin }, (t) => {
  const dir = tmpDir(t);
  const files = { tick: auto.tickScript('windows'), install: auto.windowsInstallScript() };
  for (const [name, text] of Object.entries(files)) {
    const f = path.join(dir, name + '.ps1');
    fs.writeFileSync(f, '\ufeff' + text);
    const check = `$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e) | Out-Null; if ($e) { $e | % { $_.Message }; exit 1 }`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8' });
    assert.equal(r.status, 0, name + ': ' + r.stdout + r.stderr);
  }
});

test('Linux VPS: скрипт установки cron разбирается sh', { skip: isWin }, () => {
  for (const text of [auto.linuxInstallScript(), auto.tickScript('linux')]) {
    const r = spawnSync('sh', ['-n'], { input: text, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});
