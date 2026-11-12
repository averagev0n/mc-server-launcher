// Кто заходил на сервер: первый и последний вход, общее время в игре.
// Хранится в папке сервера, в mcl-players.json.
const fs = require('fs');
const path = require('path');

const FILE = 'mcl-players.json';
const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

function read(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
function write(dir, data) {
  try {
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify(data, null, 1), 'utf8');
  } catch {
    /* учёт времени не важнее работы сервера */
  }
}

/** Следит за входами и выходами одного запуска сервера. */
function createTracker(dir) {
  const sessions = new Map(); // ник → время входа
  return {
    join(name, now = Date.now()) {
      if (!NAME_RE.test(name) || sessions.has(name)) return;
      sessions.set(name, now);
      const data = read(dir);
      const p = data[name] || { first: now, total: 0 };
      p.last = now;
      data[name] = p;
      write(dir, data);
    },
    leave(name, now = Date.now()) {
      const start = sessions.get(name);
      if (start === undefined) return;
      sessions.delete(name);
      const data = read(dir);
      const p = data[name] || { first: start, total: 0 };
      p.total = (p.total || 0) + Math.max(0, now - start);
      p.last = now;
      data[name] = p;
      write(dir, data);
    },
    /** Сервер остановился — закрыть все незакрытые сессии. */
    closeAll(now = Date.now()) {
      for (const name of [...sessions.keys()]) this.leave(name, now);
    },
    online: () => [...sessions.keys()],
  };
}

/** Список для окна: новые сверху. */
function list(dir) {
  return Object.entries(read(dir))
    .filter(([name]) => NAME_RE.test(name))
    .map(([name, p]) => ({ name, first: p.first || null, last: p.last || null, total: p.total || 0 }))
    .sort((a, b) => (b.last || 0) - (a.last || 0));
}

module.exports = { createTracker, list, FILE };
