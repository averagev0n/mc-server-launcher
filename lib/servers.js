// Операции над серверами целиком: перенос на другую версию игры, миры из одиночной игры,
// настройки нового мира.
const fs = require('fs');
const path = require('path');
const { worldDirs } = require('./backup');

// Что переносим на новую версию, кроме мира: настройки, игроки, своё название и расписание копий.
const CARRY_FILES = [
  'server.properties',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'usercache.json',
  'mcl-settings.json',
];
const PLUGIN_TYPES = ['paper', 'arclight', 'mohist', 'youer'];
const LOCK_RE = /(^|[\\/])session\.lock$/;

const copyDir = (src, dst) =>
  fs.cpSync(src, dst, { recursive: true, errorOnExist: false, force: true, filter: (p) => !LOCK_RE.test(p) });

/** Мир или установленный сервер уже есть в папке. */
function hasServer(dir) {
  return worldDirs(dir).length > 0 || fs.existsSync(path.join(dir, 'launcher.json'));
}

/**
 * Скопировать сервер на другую версию игры: мир, настройки, списки игроков и плагины.
 * Моды не переносим — под новую версию нужны другие файлы модов.
 */
function copyForUpgrade(src, dst, type) {
  if (path.resolve(src) === path.resolve(dst)) throw new Error('Это та же версия');
  if (!worldDirs(src).length) throw new Error('У этого сервера ещё нет мира — переносить нечего');
  if (hasServer(dst)) throw new Error('Сервер этой версии уже есть. Удалите его или выберите другую версию.');
  fs.mkdirSync(dst, { recursive: true });
  const copied = [];
  for (const w of worldDirs(src)) {
    copyDir(path.join(src, w), path.join(dst, w));
    copied.push(w);
  }
  for (const f of CARRY_FILES) {
    if (!fs.existsSync(path.join(src, f))) continue;
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
    copied.push(f);
  }
  if (PLUGIN_TYPES.includes(type) && fs.existsSync(path.join(src, 'plugins'))) {
    copyDir(path.join(src, 'plugins'), path.join(dst, 'plugins'));
    copied.push('plugins');
  }
  let modsLeft = 0;
  try {
    modsLeft = fs.readdirSync(path.join(src, 'mods')).filter((f) => f.endsWith('.jar')).length;
  } catch {
    /* модов нет */
  }
  return { copied, modsLeft };
}

// ---- миры одиночной игры ----

function saveInfo(dir) {
  const level = path.join(dir, 'level.dat');
  if (!fs.existsSync(level)) return null;
  let icon = null;
  try {
    const buf = fs.readFileSync(path.join(dir, 'icon.png'));
    if (buf.length < 96 * 1024) icon = 'data:image/png;base64,' + buf.toString('base64');
  } catch {
    /* значка нет */
  }
  return { name: path.basename(dir), path: dir, mtime: fs.statSync(level).mtimeMs, icon };
}

/** Миры из папки saves (по умолчанию — официального лаунчера), новые сверху. */
function listSaves(savesDir) {
  let names = [];
  try {
    names = fs.readdirSync(savesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .map((n) => saveInfo(path.join(savesDir, n)))
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Поставить мир из одиночной игры вместо текущего. Текущий мир вызывающий код
 * перед этим сохраняет резервной копией.
 */
function importWorld(dir, src, level = 'world') {
  if (!saveInfo(src)) throw new Error('В этой папке нет мира Minecraft (не найден level.dat)');
  if (!/^[^\\/:*?"<>|]+$/.test(level) || level === '.' || level === '..') throw new Error('Некорректное имя мира');
  const target = path.join(dir, level);
  if (path.resolve(src) === path.resolve(target)) throw new Error('Это и есть мир сервера');
  fs.mkdirSync(dir, { recursive: true });
  for (const w of worldDirs(dir)) fs.rmSync(path.join(dir, w), { recursive: true, force: true });
  copyDir(src, target);
  return { name: path.basename(src) };
}

// ---- настройки нового мира ----

const LEVEL_TYPES = ['normal', 'flat', 'large_biomes', 'amplified'];
const LEGACY_LEVEL = { normal: 'default', flat: 'flat', large_biomes: 'largeBiomes', amplified: 'amplified' };

/** До 1.19 тип мира записывался старыми именами (default, largeBiomes…). */
function isModernLevelType(mc) {
  const m = String(mc).match(/^1\.(\d+)/);
  return !m || Number(m[1]) >= 19;
}

function levelTypeValue(mc, kind) {
  if (!LEVEL_TYPES.includes(kind)) throw new Error('Некорректный тип мира');
  return isModernLevelType(mc) ? `minecraft:${kind}` : LEGACY_LEVEL[kind];
}

// ---- готовый сервер из другой папки ----

const ls = (p) => {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
};
/** NeoForge 21.1.172 → Minecraft 1.21.1, 20.4.237 → 1.20.4. */
function neoToMc(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\./);
  if (!m || Number(m[1]) < 20 || Number(m[1]) > 25) return null;
  return m[2] === '0' ? `1.${m[1]}` : `1.${m[1]}.${m[2]}`;
}

/**
 * Угадать тип и версию сервера по файлам в папке. readJarVersion(jarPath) → версия или null
 * (для vanilla: читается version.json внутри server.jar — передаётся снаружи).
 */
async function detectServer(dir, readJarVersion) {
  const root = ls(dir);
  const res = { type: null, version: null, loader: null };
  const lib = (...p) => ls(path.join(dir, 'libraries', ...p));
  const neo = lib('net', 'neoforged', 'neoforge').sort().reverse()[0];
  const forge = lib('net', 'minecraftforge', 'forge').sort().reverse()[0];
  const hybrid = root.find((f) => /^(mohist|youer|arclight)\b.*\.jar$/i.test(f));
  const paper = root.find((f) => /^paper-[\d.]+-\d+\.jar$/i.test(f));
  if (hybrid) {
    res.type = hybrid.toLowerCase().match(/^(mohist|youer|arclight)/)[1];
    const m = hybrid.match(/(1\.\d+(?:\.\d+)?)/);
    res.version = m ? m[1] : null;
  } else if (paper) {
    res.type = 'paper';
    res.version = paper.match(/^paper-([\d.]+)-/i)[1];
  } else if (neo) {
    res.type = 'neoforge';
    res.loader = neo;
    res.version = neoToMc(neo);
  } else if (forge) {
    res.type = 'forge';
    const m = forge.match(/^(1\.[\d.]+)-(.+)$/);
    if (m) {
      res.version = m[1];
      res.loader = m[2];
    }
  } else if (root.includes('fabric-server-launch.jar') || root.includes('.fabric') || root.some((f) => /^fabric-server-mc\./i.test(f))) {
    res.type = 'fabric';
    const named = root.map((f) => f.match(/^fabric-server-mc\.([\d.]+)-loader\.([\d.]+)/i)).find(Boolean);
    if (named) {
      res.version = named[1];
      res.loader = named[2];
    } else {
      res.version = lib('net', 'fabricmc', 'intermediary').sort().reverse()[0] || null;
    }
  } else {
    const jar = root.find((f) => f === 'server.jar') || root.find((f) => /^minecraft_server\.[\d.]+\.jar$/.test(f));
    if (jar) {
      res.type = 'vanilla';
      const m = jar.match(/^minecraft_server\.([\d.]+)\.jar$/);
      res.version = m ? m[1] : readJarVersion ? await readJarVersion(path.join(dir, jar)) : null;
    }
  }
  const count = (sub) => ls(path.join(dir, sub)).filter((f) => f.endsWith('.jar')).length;
  return {
    ...res,
    path: dir,
    name: path.basename(dir),
    hasWorld: worldDirs(dir).length > 0,
    mods: count('mods'),
    plugins: count('plugins'),
  };
}

// Не копируем то, что лаунчер скачает сам, и мусор: ядро, библиотеки, журналы.
const SKIP_TOP = new Set([
  'libraries', 'versions', 'cache', 'logs', 'crash-reports', '.fabric', 'bundler', 'debug',
  'launcher.json', 'eula.txt', 'run.bat', 'run.sh', 'user_jvm_args.txt', 'start.bat', 'start.sh',
]);

/** Скопировать сервер из чужой папки в папку лаунчера (исходная папка не меняется). */
function importServer(src, dst) {
  if (path.resolve(src) === path.resolve(dst)) throw new Error('Этот сервер уже в лаунчере');
  if (!fs.existsSync(src)) throw new Error('Папка не найдена');
  if (hasServer(dst)) throw new Error('Сервер такого типа и версии уже есть в лаунчере. Удалите его или выберите другую версию.');
  fs.mkdirSync(dst, { recursive: true });
  const copied = [];
  for (const name of ls(src)) {
    if (SKIP_TOP.has(name.toLowerCase()) || /\.(jar|exe|bat|sh|cmd)$/i.test(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
    copied.push(name);
  }
  return { copied };
}

module.exports = {
  copyForUpgrade, listSaves, saveInfo, importWorld, levelTypeValue, LEVEL_TYPES, hasServer,
  detectServer, importServer, neoToMc,
};
