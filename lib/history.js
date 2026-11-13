// Нагрузка за неделю: замеры складываются в 10-минутные корзины и хранятся в mcl-history.json.

const fs = require('fs');
const path = require('path');

const FILE = 'mcl-history.json';
const BUCKET = 10 * 60 * 1000;
const KEEP_MS = 7 * 24 * 3600 * 1000;

function read(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return Array.isArray(list) ? list.filter((p) => p && Number.isFinite(p.t)) : [];
  } catch {
    return [];
  }
}

/** Учёт для одного запуска сервера. add() — на каждый замер, flush() — при остановке. */
function createHistory(dir, now = () => Date.now()) {
  let cur = null;
  const point = () => ({
    t: cur.t,
    p: cur.players,
    tps: cur.tps,
    mem: Math.round(cur.mem / cur.n),
    cpu: Math.round((cur.cpu / cur.n) * 10) / 10,
  });
  function flush() {
    if (!cur || !cur.n) return;
    const list = read(dir).filter((x) => x.t !== cur.t);
    list.push(point());
    const from = now() - KEEP_MS;
    const keep = list.filter((x) => x.t >= from).sort((a, b) => a.t - b.t);
    try {
      fs.writeFileSync(path.join(dir, FILE), JSON.stringify(keep), 'utf8');
    } catch {
      /* статистика не важнее сервера */
    }
  }
  return {
    add({ players = 0, tps = null, memMb = 0, cpu = 0 }) {
      const t = Math.floor(now() / BUCKET) * BUCKET;
      if (cur && cur.t !== t) {
        flush();
        cur = null;
      }
      if (!cur) cur = { t, n: 0, players: 0, tps: null, mem: 0, cpu: 0 };
      cur.n++;
      cur.players = Math.max(cur.players, players);
      if (Number.isFinite(tps)) cur.tps = cur.tps === null ? tps : Math.min(cur.tps, tps);
      cur.mem += memMb;
      cur.cpu += cpu;
    },
    flush,
    /** Сохранённое плюс текущая неполная корзина. */
    points() {
      const list = read(dir).filter((x) => !cur || x.t !== cur.t);
      if (cur && cur.n) list.push(point());
      return list;
    },
  };
}

/** Выводы для подсказки: часы, когда больше всего игроков, и самый тяжёлый момент. */
function summary(points) {
  const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  for (const p of points) {
    const h = new Date(p.t).getHours();
    byHour[h].sum += p.p;
    byHour[h].n++;
  }
  const avg = byHour.map((x) => (x.n ? x.sum / x.n : 0));
  let peak = null;
  avg.forEach((v, h) => {
    if (v > 0 && (peak === null || v > avg[peak])) peak = h;
  });
  let worst = null;
  for (const p of points) if (Number.isFinite(p.tps) && p.tps < 18 && (!worst || p.tps < worst.tps)) worst = p;
  const maxPlayers = points.reduce((m, p) => Math.max(m, p.p), 0);
  return { peakHour: peak, worst, maxPlayers, hours: points.length / 6 };
}

module.exports = { FILE, BUCKET, createHistory, read, summary };
