'use strict';
// Запрос статуса сервера Minecraft — как это делает игра в списке серверов:
// сколько игроков онлайн, сколько мест, какая версия. Ничего не меняет на сервере.

const net = require('net');
const { varint, readVarint, packet, mcString } = require('./probe');

function status(host, port, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: Number(port) });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err, res) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(res);
    };
    sock.setTimeout(timeout, () => finish(new Error('Сервер не ответил')));
    sock.on('error', (e) => finish(new Error(e.code === 'ECONNREFUSED' ? 'Порт закрыт' : e.message)));
    sock.on('connect', () => {
      const port2 = Buffer.alloc(2);
      port2.writeUInt16BE(Number(port) & 0xffff);
      // Протокол -1: «просто спрашиваю статус», next state 1 — статус.
      sock.write(packet(0, Buffer.concat([varint(-1 >>> 0), mcString(String(host)), port2, varint(1)])));
      sock.write(packet(0, Buffer.alloc(0)));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024 * 1024) return finish(new Error('Слишком большой ответ'));
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        const id = readVarint(body, 0);
        if (!id || id.value !== 0) return finish(new Error('Странный ответ сервера'));
        const sl = readVarint(body, id.size);
        const json = JSON.parse(body.subarray(id.size + sl.size, id.size + sl.size + sl.value).toString('utf8'));
        const p = json.players || {};
        finish(null, {
          online: Number(p.online) || 0,
          max: Number(p.max) || 0,
          names: Array.isArray(p.sample) ? p.sample.map((x) => String(x.name || '')).filter(Boolean).slice(0, 20) : [],
          version: json.version && json.version.name ? String(json.version.name) : '',
        });
      } catch (e) {
        finish(new Error('Не удалось разобрать ответ сервера: ' + e.message));
      }
    });
  });
}

module.exports = { status };
