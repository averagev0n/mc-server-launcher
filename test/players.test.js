const test = require('node:test');
const assert = require('node:assert/strict');
const players = require('../lib/players');
const { tmpDir } = require('./helpers');

test('UUID для серверов без лицензии совпадает с тем, что считает Minecraft', () => {
  assert.equal(players.offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});

test('кто зашёл и вышел — по журналу; сообщения чата не путаются со входом', () => {
  assert.deepEqual(players.parseLine('[12:00:01] [Server thread/INFO]: Steve joined the game'), { join: 'Steve' });
  assert.deepEqual(players.parseLine('[Server thread/INFO]: .Bedrock left the game'), { leave: '.Bedrock' });
  assert.deepEqual(players.parseLine('There are 2 of a max of 20 players online: Steve, Alex'), {
    list: { names: ['Steve', 'Alex'], max: 20 },
  });
  assert.equal(players.parseLine('[INFO]: <Steve> I joined the game lol'), null);
});

test('команды серверу: опасные ники и адреса отклоняются', () => {
  assert.equal(players.commandFor('bans', 'add', 'Griefer', 'спам\nи гриф'), 'ban Griefer спам и гриф');
  assert.equal(players.commandFor('ipbans', 'remove', '10.0.0.5'), 'pardon-ip 10.0.0.5');
  assert.throws(() => players.commandFor('ops', 'add', 'bad name;stop'), /Ник/);
  assert.throws(() => players.commandFor('ipbans', 'add', 'not-ip'), /IP/);
});

test('списки правятся в файлах, когда сервер остановлен', async (t) => {
  const d = tmpDir(t);
  await players.editOffline(d, 'whitelist', 'add', 'Steve', { onlineMode: false });
  await assert.rejects(players.editOffline(d, 'whitelist', 'add', 'steve', { onlineMode: false }), /Уже есть/);
  await players.editOffline(d, 'bans', 'add', 'Bob', { reason: 'гриф', onlineMode: false });
  const l = players.readLists(d);
  assert.equal(l.whitelist[0].uuid, players.offlineUuid('Steve'));
  assert.equal(l.bans[0].reason, 'гриф');
  await players.editOffline(d, 'bans', 'remove', 'bob');
  assert.equal(players.readLists(d).bans.length, 0);
});
