// Игроки: кто онлайн (по журналу сервера), операторы, белый список, баны.
// Пока сервер работает, изменения делаются командами сервера (op, whitelist, ban…),
// когда остановлен — правкой его файлов ops.json, whitelist.json, banned-*.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { getJson } = require('./core');

const FILES = { ops: 'ops.json', whitelist: 'whitelist.json', bans: 'banned-players.json', ipbans: 'banned-ips.json' };
// Ник Java Edition; точка в начале — игроки Bedrock через Geyser/Floodgate.
const NAME_RE = /^\.?[A-Za-z0-9_]{1,16}$/;

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function readLists(dir) {
  const r = {};
  for (const [k, f] of Object.entries(FILES)) r[k] = readJson(path.join(dir, f));
  return {
    ops: r.ops.map((x) => ({ name: x.name, uuid: x.uuid, level: x.level })),
    whitelist: r.whitelist.map((x) => ({ name: x.name, uuid: x.uuid })),
    bans: r.bans.map((x) => ({ name: x.name, uuid: x.uuid, reason: x.reason, created: x.created, expires: x.expires })),
    ipbans: r.ipbans.map((x) => ({ ip: x.ip, reason: x.reason, created: x.created, expires: x.expires })),
  };
}

/** UUID игрока без лицензии (online-mode=false): так его считает сам сервер. */
function offlineUuid(name) {
  const b = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUID по нику: у лицензионных серверов — с сервера Mojang. */
async function uuidFor(name, onlineMode) {
  if (!onlineMode || name.startsWith('.')) return { uuid: offlineUuid(name), name };
  let p;
  try {
    p = await getJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  } catch (e) {
    if (/404|204/.test(e.message)) throw new Error(`Игрока «${name}» нет среди лицензионных аккаунтов. Если сервер без лицензии — снимите галочку «Только лицензионные аккаунты».`);
    throw e;
  }
  if (!p || !/^[0-9a-f]{32}$/i.test(p.id)) throw new Error(`Игрок «${name}» не найден`);
  const h = p.id.toLowerCase();
  return { uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, name: p.name || name };
}

/** Дата в формате файлов банов Minecraft: «2026-11-12 21:15:00 +0300». */
function mcDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

function validate(list, value) {
  if (!FILES[list]) throw new Error('Неизвестный список');
  if (list === 'ipbans') {
    if (!net.isIP(value)) throw new Error('IP-адрес указан неверно');
  } else if (!NAME_RE.test(value)) {
    throw new Error('Ник — до 16 символов: латиница, цифры и _');
  }
}
const cleanReason = (r) => String(r || '').replace(/[\r\n]/g, ' ').trim().slice(0, 200);

/** Команда серверу для действия над списком. */
function commandFor(list, action, value, reason) {
  validate(list, value);
  const add = action === 'add';
  const why = cleanReason(reason);
  switch (list) {
    case 'ops':
      return `${add ? 'op' : 'deop'} ${value}`;
    case 'whitelist':
      return `whitelist ${add ? 'add' : 'remove'} ${value}`;
    case 'bans':
      return add ? `ban ${value}${why ? ' ' + why : ''}` : `pardon ${value}`;
    default:
      return add ? `ban-ip ${value}${why ? ' ' + why : ''}` : `pardon-ip ${value}`;
  }
}

/** Изменить список в файлах (сервер остановлен). */
async function editOffline(dir, list, action, value, { reason, onlineMode } = {}) {
  validate(list, value);
  const file = path.join(dir, FILES[list]);
  const data = readJson(file);
  const key = list === 'ipbans' ? 'ip' : 'name';
  const same = (x) => String(x[key] || '').toLowerCase() === value.toLowerCase();
  if (action === 'remove') {
    const next = data.filter((x) => !same(x));
    if (next.length === data.length) throw new Error('Такой записи нет в списке');
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    return;
  }
  if (data.some(same)) throw new Error('Уже есть в списке');
  let entry;
  if (list === 'ipbans') {
    entry = { ip: value, created: mcDate(), source: 'Server', expires: 'forever', reason: cleanReason(reason) || 'Banned by an operator.' };
  } else {
    const who = await uuidFor(value, onlineMode);
    if (list === 'ops') entry = { uuid: who.uuid, name: who.name, level: 4, bypassesPlayerLimit: false };
    else if (list === 'whitelist') entry = { uuid: who.uuid, name: who.name };
    else entry = { uuid: who.uuid, name: who.name, created: mcDate(), source: 'Server', expires: 'forever', reason: cleanReason(reason) || 'Banned by an operator.' };
  }
  data.push(entry);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---- кто онлайн: по строкам журнала ----

const JOIN_RE = /(?:^|[\]:]\s)([.\w]{1,17}) joined the game/;
const LEAVE_RE = /(?:^|[\]:]\s)([.\w]{1,17}) left the game/;
const LIST_RE = /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/;

/** { join } | { leave } | { list: { names, max } } | null */
function parseLine(line) {
  let m = line.match(JOIN_RE);
  if (m) return { join: m[1] };
  m = line.match(LEAVE_RE);
  if (m) return { leave: m[1] };
  m = line.match(LIST_RE);
  if (m) {
    const names = m[3].split(',').map((s) => s.trim()).filter((s) => NAME_RE.test(s));
    return { list: { names, max: Number(m[2]) } };
  }
  return null;
}

module.exports = { readLists, editOffline, commandFor, parseLine, offlineUuid, NAME_RE, mcDate };
