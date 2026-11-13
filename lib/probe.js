'use strict';
// Пробный «сервер» для проверки порта, пока настоящий Minecraft-сервер не запущен.
// Слушает порт и отвечает на запрос статуса так же, как сервер Minecraft, — этого
// хватает сервисам вроде mcsrvstat.us, чтобы увидеть порт открытым. Мир не нужен,
// EULA не нужна: никакой код Minecraft не запускается.

const net = require('net');

const MOTD = 'Блокхост: проверка порта';

function varint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** Прочитать VarInt из buf с позиции pos. null — данных пока не хватает. */
function readVarint(buf, pos) {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    n |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value: n >>> 0, size: i + 1 };
  }
  throw new Error('bad varint');
}

function packet(id, body) {
  const data = Buffer.concat([varint(id), body]);
  return Buffer.concat([varint(data.length), data]);
}

function mcString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
}

function statusJson(protocol, motd = MOTD) {
  return JSON.stringify({
    version: { name: 'Блокхост', protocol },
    players: { max: 0, online: 0 },
    description: { text: motd },
  });
}

/** Ответ на старый запрос статуса (0xFE) — его шлют некоторые сервисы проверки. */
function legacyReply(motd = MOTD) {
  const s = ['§1', '127', 'Блокхост', motd, '0', '0'].join('\0');
  const body = Buffer.from(s, 'utf16le').swap16();
  const head = Buffer.alloc(3);
  head[0] = 0xff;
  head.writeUInt16BE(s.length, 1);
  return Buffer.concat([head, body]);
}

const PRIVATE_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd]|fe80)/i;
const isLocal = (addr) => PRIVATE_RE.test(String(addr || '').replace(/^::ffff:/, ''));

function handleSocket(sock, onHit, opts = {}) {
  let buf = Buffer.alloc(0);
  let protocol = -1;
  let stage = 'handshake';
  sock.setTimeout(10000, () => sock.destroy());
  sock.on('error', () => {});
  onHit(sock.remoteAddress);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 4096) return sock.destroy();
    if (stage === 'handshake' && buf[0] === 0xfe) {
      sock.end(legacyReply(opts.motd));
      return;
    }
    try {
      for (;;) {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        buf = buf.subarray(len.size + len.value);
        const id = readVarint(body, 0);
        if (!id) return sock.destroy();
        if (stage === 'handshake') {
          if (id.value !== 0) return sock.destroy();
          const p = readVarint(body, id.size);
          if (p) protocol = p.value | 0;
          // Дальше: адрес (строка), порт (2 байта) и что хочет клиент: 1 — статус, 2 — войти.
          let next = 1;
          if (p) {
            const al = readVarint(body, id.size + p.size);
            const at = id.size + p.size + (al ? al.size + al.value : 0) + 2;
            const n = al && readVarint(body, at);
            if (n) next = n.value;
          }
          if (next === 2) {
            // Игрок пытается войти: сообщаем, что сервер просыпается, и будим его.
            if (opts.onLogin) opts.onLogin(sock.remoteAddress);
            const text = JSON.stringify({ text: opts.kick || 'Сервер просыпается — зайдите через минуту' });
            sock.end(packet(0, mcString(text)));
            return;
          }
          stage = 'status';
        } else if (id.value === 0) {
          sock.write(packet(0, mcString(statusJson(protocol, opts.motd))));
        } else if (id.value === 1) {
          sock.end(packet(1, body.subarray(id.size)));
          return;
        } else {
          return sock.destroy();
        }
      }
    } catch {
      sock.destroy();
    }
  });
}

/**
 * Занять порт и отвечать на запросы статуса. Возвращает
 * { close(), external() } — external() говорит, было ли подключение не из локальной сети.
 * Если порт занят, промис отклоняется с понятной ошибкой.
 */
function start(port, host = '0.0.0.0', opts = {}) {
  const hits = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    handleSocket(sock, (addr) => hits.push(addr), opts);
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      reject(new Error(e.code === 'EADDRINUSE' ? `Порт ${port} уже занят другой программой — закройте её или смените порт сервера` : `Не удалось занять порт ${port}: ${e.message}`));
    });
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        external: () => hits.some((a) => !isLocal(a)),
        hits: () => hits.slice(),
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

module.exports = { start, isLocal, varint, readVarint, packet, mcString, legacyReply, MOTD };
