'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const probe = require('../lib/probe');

/** Обычный запрос статуса, как его шлёт клиент Minecraft или mcsrvstat.us. */
function query(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const out = {};
    sock.on('error', reject);
    sock.on('connect', () => {
      const hs = Buffer.concat([probe.varint(767), probe.mcString('localhost'), Buffer.from([0x63, 0xdd]), probe.varint(1)]);
      sock.write(probe.packet(0, hs));
      sock.write(probe.packet(0, Buffer.alloc(0)));
    });
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const len = probe.readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        buf = buf.subarray(len.size + len.value);
        const id = probe.readVarint(body, 0);
        if (id.value === 0) {
          const sl = probe.readVarint(body, id.size);
          out.status = JSON.parse(body.subarray(id.size + sl.size, id.size + sl.size + sl.value).toString('utf8'));
          const ping = Buffer.alloc(8);
          ping.writeBigInt64BE(42n);
          sock.write(probe.packet(1, ping));
        } else if (id.value === 1) {
          out.pong = body.subarray(id.size).readBigInt64BE();
          sock.end();
          resolve(out);
        }
      }
    });
  });
}

test('probe: отвечает на запрос статуса и пинг', async () => {
  const p = await probe.start(0, '127.0.0.1');
  try {
    const r = await query(p.port);
    assert.strictEqual(r.status.description.text, probe.MOTD);
    assert.strictEqual(r.status.version.protocol, 767);
    assert.strictEqual(r.pong, 42n);
    assert.strictEqual(p.external(), false); // подключение из localhost — не из интернета
    assert.ok(p.hits().length >= 1);
  } finally {
    await p.close();
  }
});

test('probe: старый запрос 0xFE', async () => {
  const p = await probe.start(0, '127.0.0.1');
  try {
    const reply = await new Promise((resolve, reject) => {
      const sock = net.connect(p.port, '127.0.0.1', () => sock.write(Buffer.from([0xfe, 0x01])));
      const parts = [];
      sock.on('data', (c) => parts.push(c));
      sock.on('end', () => resolve(Buffer.concat(parts)));
      sock.on('error', reject);
    });
    assert.strictEqual(reply[0], 0xff);
    const text = Buffer.from(reply.subarray(3)).swap16().toString('utf16le');
    assert.ok(text.startsWith('§1\0'));
    assert.ok(text.includes(probe.MOTD));
  } finally {
    await p.close();
  }
});

test('probe: занятый порт даёт понятную ошибку', async () => {
  const p = await probe.start(0, '127.0.0.1');
  try {
    await assert.rejects(probe.start(p.port, '127.0.0.1'), /уже занят/);
  } finally {
    await p.close();
  }
});

test('probe: какие адреса считаются локальными', () => {
  for (const a of ['127.0.0.1', '::ffff:192.168.1.5', '10.0.0.2', '172.20.1.1', '100.64.0.1', '::1', 'fe80::1']) assert.ok(probe.isLocal(a), a);
  for (const a of ['8.8.8.8', '::ffff:95.31.2.4', '172.32.0.1', '2a00:1450::1']) assert.ok(!probe.isLocal(a), a);
});

test('probe: попытка войти будит сервер и получает понятное сообщение', async () => {
  let woke = 0;
  const p = await probe.start(0, '127.0.0.1', { motd: 'Сервер спит', onLogin: () => woke++, kick: 'Просыпаюсь' });
  try {
    const reply = await new Promise((resolve, reject) => {
      const sock = net.connect(p.port, '127.0.0.1', () => {
        const hs = Buffer.concat([probe.varint(767), probe.mcString('localhost'), Buffer.from([0x63, 0xdd]), probe.varint(2)]);
        sock.write(probe.packet(0, hs));
      });
      const parts = [];
      sock.on('data', (c) => parts.push(c));
      sock.on('end', () => resolve(Buffer.concat(parts)));
      sock.on('error', reject);
    });
    assert.strictEqual(woke, 1);
    assert.match(reply.toString('utf8'), /Просыпаюсь/);
    const r = await query(p.port);
    assert.strictEqual(r.status.description.text, 'Сервер спит');
  } finally {
    await p.close();
  }
});
