'use strict';
// Отчёт об ошибке: один zip с журналом, отчётами о сбоях, списком модов и сведениями о системе.
// Его можно отправить автору лаунчера или мода. Личное прячем: путь к папке пользователя,
// имя пользователя Windows, IP-адреса игроков и пароли из server.properties.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { zip } = require('./pack');

const MAX_LOG = 3 * 1024 * 1024; // от latest.log берём хвост — там и есть ошибка
const MAX_FILE = 1024 * 1024;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Убрать из текста личное. home и user — для тестов, по умолчанию берутся из системы. */
function anonymize(text, { home = os.homedir(), user = os.userInfo().username } = {}) {
  let t = String(text);
  if (home) {
    for (const h of new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])) {
      t = t.replace(new RegExp(escapeRe(h), 'gi'), '%USERPROFILE%');
    }
  }
  if (user && user.length >= 3) t = t.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(user)}(?![A-Za-z0-9_])`, 'gi'), '<user>');
  // IPv4, кроме локальных служебных: адреса игроков и внешний IP.
  t = t.replace(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g, (m, a) => {
    if (m === '0.0.0.0' || a === '127') return m;
    return 'x.x.x.x';
  });
  return t;
}

/** server.properties без паролей и секретов. */
function cleanProps(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => (/^\s*[^#=]*(password|secret|token|key)[^=]*=/i.test(l) ? l.replace(/=.*/, '=<скрыто>') : l))
    .join('\n');
}

function readTail(file, max) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return (st.size > max ? `[… начало файла пропущено, всего ${st.size} байт]\n` : '') + buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function newest(dir, re, n) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, n)
      .map((x) => x.f);
  } catch {
    return [];
  }
}

function jarList(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.jar(\.disabled)?$/i.test(f))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => `${f}  (${Math.round(fs.statSync(path.join(dir, f)).size / 1024)} КБ)`);
  } catch {
    return null;
  }
}

/**
 * Собрать отчёт. info — строки о лаунчере и сервере ({ 'Лаунчер': '1.0.10', ... }).
 * Возвращает { data: Buffer, files: [имена внутри архива] }.
 */
function build(dir, info = {}, { extra = [], ...opts } = {}) {
  const entries = [];
  const add = (name, text) => entries.push({ name, data: Buffer.from(anonymize(text, opts), 'utf8') });

  const sys = {
    Система: `${os.type()} ${os.release()} (${os.arch()})`,
    Процессор: `${(os.cpus()[0] || {}).model || '?'} × ${os.cpus().length}`,
    Память: `${Math.round(os.totalmem() / 2 ** 30)} ГБ, свободно ${Math.round(os.freemem() / 2 ** 30)} ГБ`,
    ...info,
    'Отчёт собран': new Date().toISOString(),
  };
  add('info.txt', Object.entries(sys).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n');

  const latest = path.join(dir, 'logs', 'latest.log');
  if (fs.existsSync(latest)) add('logs/latest.log', readTail(latest, MAX_LOG));
  for (const f of newest(path.join(dir, 'crash-reports'), /\.txt$/i, 3)) add(`crash-reports/${f}`, readTail(path.join(dir, 'crash-reports', f), MAX_FILE));
  for (const f of newest(dir, /^hs_err_pid\d+\.log$/i, 2)) add(f, readTail(path.join(dir, f), MAX_FILE));

  const lists = [];
  for (const sub of ['mods', 'plugins']) {
    const l = jarList(path.join(dir, sub));
    if (l) lists.push(`${sub} (${l.length}):\n${l.map((x) => '  ' + x).join('\n') || '  —'}`);
  }
  if (lists.length) add('mods.txt', lists.join('\n\n') + '\n');

  const props = path.join(dir, 'server.properties');
  if (fs.existsSync(props)) add('server.properties', cleanProps(fs.readFileSync(props, 'utf8')));
  for (const e of extra) if (e && e.text) add(e.name, e.text);

  return { data: zip(entries), files: entries.map((e) => e.name) };
}

module.exports = { build, anonymize, cleanProps };
