// VPS с Windows: тексты скриптов PowerShell. На Windows их ещё и разбирает настоящий PowerShell,
// а запуск, команду и остановку проверяем на этом же компьютере с фальшивой Java (батник).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const win = require('../lib/vps-windows');
const { tmpDir } = require('./helpers');

const isWin = process.platform === 'win32';
const scripts = () => ({
  info: win.infoScript(),
  java: win.javaInstallScript(21, 'x64'),
  extract: win.extractScript('my-srv', '20261116-1200'),
  start: win.startScript('C:\\Users\\u\\mc-launcher\\java\\21\\bin\\java.exe', ['-jar', 'server.jar']),
  launch: win.launchScript('my-srv', 4),
  command: win.commandScript('my-srv', Buffer.from('say hi\n').toString('base64')),
  stop: win.stopScript('my-srv'),
});

test('Windows VPS: кавычки в PowerShell экранируются', () => {
  assert.equal(win.psq("a'b"), "'a''b'");
  // Кавычки в аргументах Java не попадают в строку запуска.
  const s = win.startScript('C:\\j\\java.exe', ['-jar', "se'rv\"er.jar"]);
  assert.ok(s.includes('"-jar" "server.jar"'));
});

test('Windows VPS: скрипты разбираются PowerShell без ошибок', { skip: !isWin }, (t) => {
  const dir = tmpDir(t);
  for (const [name, text] of Object.entries(scripts())) fs.writeFileSync(path.join(dir, name + '.ps1'), '\ufeff' + text);
  const check =
    `$bad = @(); Get-ChildItem '${dir}\\*.ps1' | ForEach-Object { $e = $null; $t = $null; ` +
    `[void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e); ` +
    `if ($e.Count) { $bad += "$($_.Name): $($e[0].Message)" } }; $bad -join "; "`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '', r.stdout + r.stderr);
});

test('Windows VPS: запуск в фоне, команда серверу, остановка (с фальшивой Java)', { skip: !isWin, timeout: 90000 }, (t) => {
  const home = tmpDir(t);
  const srv = path.join(home, 'mc-launcher', 'servers', 't1');
  const jdir = path.join(home, 'mc-launcher', 'java', '21', 'bin');
  fs.mkdirSync(srv, { recursive: true });
  fs.mkdirSync(jdir, { recursive: true });
  const fake = path.join(jdir, 'java.cmd');
  // «Сервер»: печатает всё, что получил на вход, и выходит по команде stop.
  fs.writeFileSync(fake, '@echo off\r\necho fake server starting\r\n:loop\r\nset "L="\r\nset /p L=\r\nif "%L%"=="stop" (\r\n  echo stopping\r\n  exit /b 0\r\n)\r\nif not "%L%"=="" echo got:%L%\r\ngoto loop\r\n');
  fs.writeFileSync(path.join(srv, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(srv, 'mcl.json'), JSON.stringify({ name: 't1', ramGb: 2 }));
  fs.writeFileSync(path.join(srv, 'mcl-start.ps1'), '\ufeff' + win.startScript(fake, ['-jar', 'server.jar']));

  const env = { ...process.env, USERPROFILE: home };
  const ps = (text, name) => {
    const f = path.join(home, name + '.ps1');
    fs.writeFileSync(f, '\ufeff' + text);
    return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', env });
  };
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const log = () => (fs.existsSync(path.join(srv, 'console.log')) ? fs.readFileSync(path.join(srv, 'console.log'), 'utf8') : '');
  try {
    // Без принятого EULA сервер не запускается.
    fs.writeFileSync(path.join(srv, 'eula.txt'), 'eula=false\n');
    const no = ps(win.launchScript('t1', 3), 'launch-no');
    assert.match(no.stdout, /noeula/);
    fs.writeFileSync(path.join(srv, 'eula.txt'), 'eula=true\n');

    const up = ps(win.launchScript('t1', 3), 'launch');
    assert.match(up.stdout, /started/, up.stdout + up.stderr);
    assert.match(fs.readFileSync(path.join(srv, 'mcl.json'), 'utf8'), /"ramGb":3/);
    sleep(2000);
    const info = ps(win.infoScript(), 'info').stdout;
    assert.match(info, /^platform=windows/m);
    assert.match(info, /server=t1\|running\|/);

    assert.equal(ps(win.commandScript('t1', Buffer.from('say hello\n').toString('base64')), 'cmd').status, 0);
    sleep(2500);
    assert.match(log(), /got:say hello/);

    assert.match(ps(win.stopScript('t1'), 'stop').stdout, /stopped/);
    sleep(1000);
    assert.match(log(), /Сервер остановлен \(код 0\)/);
    assert.ok(!fs.existsSync(path.join(srv, 'mcl.pid')));
    // Остановленному серверу команды не передаются.
    assert.equal(ps(win.commandScript('t1', Buffer.from('say late\n').toString('base64')), 'cmd2').status, 4);
  } finally {
    ps(win.stopScript('t1'), 'stop-final');
  }
});
