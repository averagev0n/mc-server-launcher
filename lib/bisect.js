'use strict';
// Поиск мода, из-за которого сервер падает при запуске: половину модов убираем,
// запускаем сервер на временном мире, смотрим, упал ли, и сужаем круг.
// Здесь — план поиска и перекладывание файлов; сами запуски делает main.js.

const fs = require('fs');
const path = require('path');
const { describeJar } = require('./modcheck');

const OFF_DIR = 'mcl-modtest-off'; // сюда на время проверки уезжают выключенные моды
const STATE_FILE = 'mcl-modtest.json'; // что вернуть, если лаунчер закрыли посреди поиска
const TEST_LEVEL = 'mcl-modtest-world'; // временный мир: настоящий мир моды без половины модов испортили бы
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'forge', 'neoforge', 'quilt_loader', 'javafml', 'lowcodefml', 'mixinextras']);

/** Все моды сервера: [{ file, name, ids, deps }]. */
function graph(modsDir) {
  let files = [];
  try {
    files = fs.readdirSync(modsDir).filter((f) => /\.jar$/i.test(f));
  } catch {
    return [];
  }
  return files.sort().map((file) => {
    let mods = [];
    try {
      mods = describeJar(path.join(modsDir, file));
    } catch {
      /* повреждённый файл — тоже подозреваемый */
    }
    const ids = new Set();
    const deps = new Set();
    for (const m of mods) {
      if (m.id) ids.add(m.id);
      for (const p of m.provides || []) ids.add(p);
      for (const d of m.deps || []) if (d && !BUILTIN.has(d)) deps.add(d);
    }
    const name = (mods[0] && mods[0].name) || file.replace(/\.jar$/i, '');
    return { file, name, ids: [...ids], deps: [...deps] };
  });
}

/** Добавить к набору файлов всё, без чего они не запустятся. */
function closure(files, mods) {
  const byId = new Map();
  for (const m of mods) for (const id of m.ids) if (!byId.has(id)) byId.set(id, m.file);
  const byFile = new Map(mods.map((m) => [m.file, m]));
  const out = new Set(files);
  const queue = [...files];
  while (queue.length) {
    const m = byFile.get(queue.pop());
    if (!m) continue;
    for (const d of m.deps) {
      const f = byId.get(d);
      if (f && !out.has(f)) {
        out.add(f);
        queue.push(f);
      }
    }
  }
  return [...out];
}

/**
 * План поиска. next() — какие моды включить в следующий запуск ({ enable } или { done });
 * report(crashed) — чем закончился запуск.
 * Сначала запуск со всеми модами: если сервер не падает, искать нечего.
 */
function createSearch(mods) {
  const all = mods.map((m) => m.file);
  let suspects = all.slice();
  let cleared = []; // моды, с которыми сервер точно запускается
  let phase = 'full';
  let half = [];
  let runs = 0;
  let result = null;
  const enableFor = (set) => closure([...cleared, ...set], mods);
  return {
    total: all.length,
    get runs() {
      return runs;
    },
    get suspects() {
      return suspects.slice();
    },
    /** Сколько запусков ещё примерно осталось. */
    left() {
      if (result) return 0;
      return Math.ceil(Math.log2(Math.max(1, suspects.length))) + (phase === 'full' ? 1 : 0);
    },
    next() {
      if (result) return { done: true, ...result };
      if (phase === 'full') return { enable: all.slice() };
      half = suspects.slice(0, Math.ceil(suspects.length / 2));
      return { enable: enableFor(half) };
    },
    report(crashed) {
      runs++;
      if (phase === 'full') {
        if (!crashed) result = { noRepro: true };
        else if (suspects.length === 1) result = { culprit: suspects[0] };
        phase = 'split';
        return;
      }
      if (crashed) suspects = half;
      else {
        cleared = [...new Set([...cleared, ...closure(half, mods)])];
        suspects = suspects.filter((f) => !half.includes(f));
      }
      if (suspects.length === 1) {
        const f = suspects[0];
        const needs = closure([f], mods).filter((x) => x !== f);
        result = { culprit: f, needs };
      } else if (!suspects.length) {
        // Поодиночке все половины запускаются — дело в сочетании модов.
        result = { combo: true };
      }
    },
  };
}

/** Разложить моды: включённые — в mods, остальные — в папку выключенных. */
function arrange(dir, enable) {
  const modsDir = path.join(dir, 'mods');
  const off = path.join(dir, OFF_DIR);
  fs.mkdirSync(off, { recursive: true });
  const want = new Set(enable);
  for (const f of fs.readdirSync(modsDir)) {
    if (/\.jar$/i.test(f) && !want.has(f)) fs.renameSync(path.join(modsDir, f), path.join(off, f));
  }
  for (const f of fs.readdirSync(off)) {
    if (want.has(f)) fs.renameSync(path.join(off, f), path.join(modsDir, f));
  }
}

/** Вернуть всё как было: моды на место, прежний мир, временный мир удалить. */
function restore(dir, writeLevel) {
  const off = path.join(dir, OFF_DIR);
  const modsDir = path.join(dir, 'mods');
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
  } catch {
    /* состояния нет — просто возвращаем моды */
  }
  if (fs.existsSync(off)) {
    for (const f of fs.readdirSync(off)) {
      const to = path.join(modsDir, f);
      if (!fs.existsSync(to)) fs.renameSync(path.join(off, f), to);
    }
    if (!fs.readdirSync(off).length) fs.rmdirSync(off);
  }
  if (state && typeof state.level === 'string' && writeLevel) writeLevel(state.level);
  for (const suffix of ['', '_nether', '_the_end']) fs.rmSync(path.join(dir, TEST_LEVEL + suffix), { recursive: true, force: true });
  fs.rmSync(path.join(dir, STATE_FILE), { force: true });
  return !!state;
}

function begin(dir, level) {
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ level, at: Date.now() }), 'utf8');
}

const pending = (dir) => fs.existsSync(path.join(dir, STATE_FILE)) || fs.existsSync(path.join(dir, OFF_DIR));

module.exports = { graph, closure, createSearch, arrange, restore, begin, pending, TEST_LEVEL, OFF_DIR, STATE_FILE };
