const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const { tmpDir } = require('./helpers');

test('сравнение версий по числам', () => {
  assert.ok(core.cmpVer('1.20.10', '1.20.9') > 0);
  assert.ok(core.cmpVer('1.21', '1.21.1') < 0);
  assert.equal(core.cmpVer('26.3', '26.3.0'), 0);
});

test('версия NeoForge → версия Minecraft', () => {
  assert.equal(core.neoMc('21.1.77'), '1.21.1');
  assert.equal(core.neoMc('21.0.167'), '1.21');
  assert.equal(core.neoMc('26.1.2.126'), '26.1.2');
  assert.equal(core.neoMc('26.3.0.75-beta'), '26.3');
  assert.equal(core.neoMc('0.25w14craftmine.5-beta'), null);
});

test('аргументы запуска из run.bat Forge', (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(
    path.join(d, 'run.bat'),
    [
      '@echo off',
      'REM comment',
      'java @user_jvm_args.txt -jar forge-1.21-shim.jar --onlyCheckJava || exit /b',
      'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.21-51/win_args.txt %*',
      'pause',
    ].join('\r\n')
  );
  assert.deepEqual(core.argsFromRunBat(d), ['@libraries/net/minecraftforge/forge/1.21-51/win_args.txt']);
});

test('server.properties: меняется только нужное, значения проверяются', (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, 'server.properties'), '#comment\nserver-port=25565\nlevel-seed=abc\n');
  core.writeProps(d, { 'server-port': '25570', motd: 'Привет', 'server-ip': '192.168.0.5' });
  const text = fs.readFileSync(path.join(d, 'server.properties'), 'utf8');
  assert.match(text, /^#comment$/m);
  assert.match(text, /^level-seed=abc$/m);
  assert.equal(core.readProps(d)['server-port'], '25570');
  assert.equal(core.readProps(d)['server-ip'], '192.168.0.5');
  assert.throws(() => core.writeProps(d, { 'server-port': '70000' }), /Порт/);
  assert.throws(() => core.writeProps(d, { 'server-ip': '999.1.1.1' }), /IP/);
  assert.throws(() => core.writeProps(d, { 'level-name': '../evil' }), /мира/);
});

test('гибриды: загрузчик модов по сборке', () => {
  assert.equal(core.hybridFlavor('arclight', 'arclight-neoforge-1.21.1-1.0.1-8ec9529'), 'neoforge');
  assert.equal(core.hybridFlavor('mohist', '995'), 'forge');
  assert.equal(core.hybridFlavor('youer', '1'), 'neoforge');
  assert.equal(core.hybridFlavor('paper', 'x'), null);
});

test('выбор Java: для модов — самая старая подходящая, 64 бита важнее', () => {
  const javas = [
    { path: 'a', major: 25, bits: 64 },
    { path: 'b', major: 17, bits: 64 },
    { path: 'c', major: 8, bits: 64 },
    { path: 'd', major: 8, bits: 32 },
  ];
  assert.equal(core.pickJava(javas, 17, true).path, 'b');
  assert.equal(core.pickJava(javas, 17, false).path, 'a');
  assert.equal(core.pickJava(javas, 8, true).path, 'c');
  assert.equal(core.pickJava(javas, 30, true), null);
  assert.equal(core.javaToInstall(16), 17);
  assert.equal(core.javaToInstall(null), 21);
});

test('проверка имён версий и загрузчиков', () => {
  assert.throws(() => core.checkArgs('vanilla', '../x'), /версия/);
  assert.throws(() => core.checkArgs('nope', '1.0'), /тип/);
  assert.doesNotThrow(() => core.checkArgs('fabric', '1.21.1', '0.16.5'));
});
