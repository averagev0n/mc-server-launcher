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

module.exports = { copyForUpgrade, listSaves, saveInfo, importWorld, levelTypeValue, LEVEL_TYPES, hasServer };
