// Проверка ввода для VPS и простые правила модов/плагинов (без сети).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createVps } = require('../lib/vps');
const mods = require('../lib/mods');
const { tmpDir } = require('./helpers');

function vpsIn(t) {
  // Вместо шифрования Windows — обратимая «заглушка», чтобы проверить, что пароль не лежит открытым.
  return createVps({
    dataDir: tmpDir(t),
    encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'),
    decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString(),
  });
}

test('VPS: неверные данные отклоняются', (t) => {
  const v = vpsIn(t);
  assert.throws(() => v.save({ host: 'bad host!', username: 'root', auth: 'password', secret: 'x' }), /Адрес/);
  assert.throws(() => v.save({ host: '1.2.3.4', username: 'root; rm', auth: 'password', secret: 'x' }), /пользователя/);
  assert.throws(() => v.save({ host: '1.2.3.4', port: 70000, username: 'root', auth: 'password', secret: 'x' }), /Порт/);
  assert.throws(() => v.save({ host: '1.2.3.4', username: 'root', auth: 'password' }), /пароль/);
  assert.throws(() => v.save({ host: '1.2.3.4', username: 'root', auth: 'key', keyPath: 'C:/нет/такого' }), /ключ/);
});

test('VPS: пароль хранится зашифрованным и не отдаётся в окно', (t) => {
  const dir = tmpDir(t);
  const v = createVps({ dataDir: dir, encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s) => s });
  const p = v.save({ name: 'Мой', host: 'vps.example.com', username: 'mc', auth: 'password', secret: 'секрет123' });
  const listed = v.list()[0];
  assert.equal(listed.hasSecret, true);
  assert.ok(!('secret' in listed));
  assert.ok(!fs.readFileSync(path.join(dir, 'vps.json'), 'utf8').includes('секрет123'));
  // Смена адреса сбрасывает доверие к ключу сервера.
  v.save({ id: p.id, name: 'Мой', host: 'other.example.com', username: 'mc', auth: 'password' });
  assert.equal(v.list()[0].trusted, false);
});

test('моды и плагины: что можно ставить на какой сервер', () => {
  assert.deepEqual(mods.kindsFor('vanilla'), []);
  assert.deepEqual(mods.kindsFor('paper'), ['plugin']);
  assert.deepEqual(mods.kindsFor('fabric'), ['mod']);
  assert.deepEqual(mods.kindsFor('youer'), ['mod', 'plugin']);
  assert.equal(mods.contentDir('arclight', 'plugin'), 'plugins');
  assert.equal(mods.contentDir('arclight'), 'mods');
  assert.throws(() => mods.modPath('fabric', 'C:/srv', '../evil.jar'), /Некорректное/);
});
