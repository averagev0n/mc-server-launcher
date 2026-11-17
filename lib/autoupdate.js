'use strict';
// Автообновление модов и плагинов по ночам: что пора делать и как откатить, если сервер после обновления не поднялся.
// Само обновление, копия мира и пробный запуск — в main.js; здесь то, что можно проверить без сервера.

const fs = require('fs');
const path = require('path');

const STATE_FILE = 'mcl-autoupd.json';
const INDEX_FILE = 'modrinth.json';
const TEST_LEVEL = 'mcl-update-test';
const WINDOW_MIN = 180; // если лаунчер включили позже назначенного времени — ещё 3 часа можно наверстать

function readState(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
function writeState(dir, st) {
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(st, null, 2), 'utf8');
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Пора ли обновлять: включено, сегодня ещё не обновляли и сейчас в окне [время; время + 3 ч). */
function due(cfg, now, state) {
  if (!cfg || !cfg.enabled) return false;
  if (state && state.lastRun === dayKey(now)) return false;
  const [h, m] = String(cfg.time).split(':').map(Number);
  const at = h * 60 + m;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= at && cur < at + WINDOW_MIN;
}

function readIndexText(dir) {
  try {
    return fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Вернуть всё как было. updates — [{ folder: 'mods'|'plugins', oldFile, newFile, backup }],
 * где backup — папка (относительно dir), куда updateFile отложил старый файл.
 */
function rollback(dir, updates, indexText) {
  const problems = [];
  for (const u of updates) {
    const folder = path.join(dir, u.folder);
    const saved = path.join(dir, u.backup, u.oldFile);
    try {
      if (!fs.existsSync(saved)) throw new Error('старый файл не найден');
      if (u.newFile !== u.oldFile) fs.rmSync(path.join(folder, u.newFile), { force: true });
      fs.renameSync(saved, path.join(folder, u.oldFile));
    } catch (e) {
      problems.push(`${u.oldFile}: ${e.message}`);
    }
  }
  if (indexText !== null && indexText !== undefined) fs.writeFileSync(path.join(dir, INDEX_FILE), indexText, 'utf8');
  return problems;
}

/** Временный мир для пробного запуска: подменить level-name и потом вернуть. */
function testWorldDirs(dir) {
  return ['', '_nether', '_the_end'].map((s) => path.join(dir, TEST_LEVEL + s));
}
function clearTestWorld(dir) {
  for (const d of testWorldDirs(dir)) fs.rmSync(d, { recursive: true, force: true });
}

/** Строки из журнала, по которым видно, почему не запустилось. */
function failLines(tail) {
  const pick = (tail || []).filter((l) => /error|exception|caused by|crash|incompatible|requires|missing/i.test(l));
  return (pick.length ? pick : tail || []).slice(-4);
}

module.exports = { STATE_FILE, TEST_LEVEL, readState, writeState, dayKey, due, readIndexText, rollback, clearTestWorld, failLines };
