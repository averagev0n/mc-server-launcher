'use strict';
// Simple Voice Chat: голос идёт отдельно от игры, по UDP на своём порту (по умолчанию 24454).
// На этом игроки обычно и застревают: порт надо открыть на роутере или сделать для него
// отдельный UDP-туннель в playit и указать его адрес в voice_host.

const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 24454;
const JAR_RE = /voicechat/i;

function hasJar(dir, sub) {
  try {
    return fs.readdirSync(path.join(dir, sub)).some((f) => JAR_RE.test(f) && /\.jar$/i.test(f));
  } catch {
    return false;
  }
}

/** Где мод или плагин: 'mod' | 'plugin' | null. */
function installedKind(dir) {
  if (hasJar(dir, 'plugins')) return 'plugin';
  if (hasJar(dir, 'mods')) return 'mod';
  return null;
}

function configFile(dir, kind) {
  return kind === 'plugin'
    ? path.join(dir, 'plugins', 'voicechat', 'voicechat-server.properties')
    : path.join(dir, 'config', 'voicechat', 'voicechat-server.properties');
}

function parse(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\\(.)/g, '$1').trim();
  }
  return out;
}

/** Поменять значения, не трогая остальные строки и комментарии. */
function patch(text, values) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const left = { ...values };
  const res = lines.map((line) => {
    const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(left, m[1])) {
      const v = left[m[1]];
      delete left[m[1]];
      return `${m[1]}=${v}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(left)) res.push(`${k}=${v}`);
  return res.join('\n') + '\n';
}

/** Порт голосового чата: -1 в настройках значит «тот же номер, что у сервера». */
function effectivePort(cfgPort, serverPort) {
  const p = Number(cfgPort);
  if (p === -1) return Number(serverPort) || 25565;
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

/** Состояние: { kind, installed, configured, port, host }. */
function read(dir, serverPort) {
  const kind = installedKind(dir);
  const file = configFile(dir, kind || 'mod');
  let cfg = {};
  let configured = false;
  try {
    cfg = parse(fs.readFileSync(file, 'utf8'));
    configured = true;
  } catch {
    /* файла ещё нет — его создаст мод при первом запуске или лаунчер при сохранении */
  }
  return { kind, installed: !!kind, configured, port: effectivePort(cfg.port, serverPort), rawPort: cfg.port, host: cfg.voice_host || '' };
}

function checkPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Порт голосового чата — число от 1024 до 65535');
  return p;
}
function checkHost(host) {
  const h = String(host || '').trim();
  if (h && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(h)) throw new Error('Адрес для голосового чата — вида play.example.com или 147.185.221.1:12345');
  return h;
}

function write(dir, { port, host }) {
  const kind = installedKind(dir);
  if (!kind) throw new Error('Сначала установите Simple Voice Chat');
  const values = { port: checkPort(port), voice_host: checkHost(host) };
  const file = configFile(dir, kind);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, patch(text, values), 'utf8');
  return read(dir);
}

module.exports = { DEFAULT_PORT, installedKind, configFile, parse, patch, effectivePort, read, write, checkHost, checkPort };
