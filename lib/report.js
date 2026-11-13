'use strict';
// Отчёт за неделю: кто и сколько играл, когда больше всего народу, сбои, размер мира.
// Сеансы игроков и падения пишутся в mcl-week.json в папке сервера (хранится 35 дней).

const fs = require('fs');
const path = require('path');
const history = require('./history');

const FILE = 'mcl-week.json';
const KEEP = 35 * 24 * 3600 * 1000;
const WEEK = 7 * 24 * 3600 * 1000;

function read(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return { sessions: Array.isArray(d.sessions) ? d.sessions : [], crashes: Array.isArray(d.crashes) ? d.crashes : [] };
  } catch {
    return { sessions: [], crashes: [] };
  }
}
function write(dir, d, now) {
  const cut = now - KEEP;
  d.sessions = d.sessions.filter((s) => s.end > cut);
  d.crashes = d.crashes.filter((t) => t > cut);
  try {
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify(d), 'utf8');
  } catch {
    /* отчёт не важнее работы сервера */
  }
}

function logSession(dir, name, start, end = Date.now()) {
  if (!(end > start)) return;
  const d = read(dir);
  d.sessions.push({ name: String(name).slice(0, 32), start, end });
  write(dir, d, end);
}
function logCrash(dir, at = Date.now()) {
  const d = read(dir);
  d.crashes.push(at);
  write(dir, d, at);
}

const hm = (ms) => {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`;
};
const size = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ` : `${Math.max(1, Math.round(b / 1024 ** 2))} МБ`);

/** Данные отчёта за 7 дней до now. */
function collect(dir, now = Date.now()) {
  const from = now - WEEK;
  const d = read(dir);
  const byName = new Map();
  for (const s of d.sessions) {
    const a = Math.max(s.start, from);
    const b = Math.min(s.end, now);
    if (b <= a) continue;
    byName.set(s.name, (byName.get(s.name) || 0) + (b - a));
  }
  const players = [...byName].map(([name, ms]) => ({ name, ms })).sort((x, y) => y.ms - x.ms);
  const points = history.read(dir).filter((p) => p.t >= from && p.t <= now);
  const sum = history.summary(points);
  return {
    players,
    totalMs: players.reduce((s, p) => s + p.ms, 0),
    uptimeH: sum.hours,
    peakHour: sum.peakHour,
    maxPlayers: sum.maxPlayers,
    worstTps: sum.worst ? sum.worst.tps : null,
    crashes: d.crashes.filter((t) => t >= from && t <= now).length,
    active: players.length > 0 || points.length > 0,
  };
}

/** Текст для Telegram. worldBytes и prevWorldBytes — размер мира сейчас и неделю назад (если известен). */
function text(title, r, worldBytes, prevWorldBytes) {
  const lines = [`📊 Неделя на сервере «${title}»`, ''];
  if (!r.active) return [...lines, 'Сервер на этой неделе не запускался.'].join('\n');
  lines.push(`Работал: ${hm(r.uptimeH * 3600000)}.`);
  if (r.players.length) {
    lines.push(`Играли ${r.players.length} — всего ${hm(r.totalMs)}:`);
    for (const p of r.players.slice(0, 10)) lines.push(`• ${p.name} — ${hm(p.ms)}`);
    if (r.players.length > 10) lines.push(`• и ещё ${r.players.length - 10}`);
  } else {
    lines.push('Никто не заходил.');
  }
  if (r.peakHour !== null) lines.push(`Больше всего народу — около ${String(r.peakHour).padStart(2, '0')}:00, максимум ${r.maxPlayers} одновременно.`);
  if (r.worstTps !== null) lines.push(`Хуже всего было с плавностью: ${String(Math.round(r.worstTps * 10) / 10).replace('.', ',')} TPS из 20.`);
  lines.push(r.crashes ? `⚠️ Сбоев: ${r.crashes}.` : 'Сбоев не было.');
  if (worldBytes) {
    const grow = prevWorldBytes && worldBytes > prevWorldBytes ? ` (+${size(worldBytes - prevWorldBytes)} за неделю)` : '';
    lines.push(`Мир занимает ${size(worldBytes)}${grow}.`);
  }
  return lines.join('\n');
}

/** Пора ли слать: понедельник после 10:00 и с прошлого отчёта прошло больше 6 дней. */
function due(last, now = new Date()) {
  if (now.getDay() !== 1 || now.getHours() < 10) return false;
  return !last || now.getTime() - last > 6 * 24 * 3600 * 1000;
}

module.exports = { FILE, logSession, logCrash, collect, text, due, read };
