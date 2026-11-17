// Параметры Java для сервера: флаги Aikar и подбор памяти.

/** Флаги сборщика мусора G1 от Aikar — меньше подвисаний; для 12 ГБ и больше — свои значения. */
function aikarFlags(ramGb) {
  const big = ramGb >= 12;
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${big ? 16 : 8}M`,
    `-XX:G1ReservePercent=${big ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
  ];
}

/**
 * Сколько памяти дать серверу: { min, rec } в ГБ.
 * Ориентиры: обычный сервер — 2 ГБ, плюс по чуть-чуть на игроков; моды — от 4 до 10 ГБ по их числу.
 */
function recommendRam({ modded, mods = 0, plugins = 0, players = 10 }) {
  let rec;
  if (modded) rec = mods >= 250 ? 10 : mods >= 150 ? 8 : mods >= 80 ? 6 : mods >= 20 ? 5 : 4;
  else rec = 2 + (plugins >= 30 ? 1 : 0);
  rec += players > 20 ? 2 : players > 10 ? 1 : 0;
  const min = modded ? Math.max(3, rec - 2) : 2;
  return { min, rec };
}

// ---- проверка флагов на выбранной Java ----
// Неизвестный флаг не даёт Java даже запуститься, а набор флагов у разных сборок и версий Java разный.
// Перед запуском пробуем `java <флаги> -version` и убираем то, на что Java ругается.

const { execFile } = require('child_process');

/** Имя флага -XX без знака и значения: '-XX:+UseG1GC' → 'UseG1GC'. */
function flagName(flag) {
  const m = /^-XX:[+-]?([A-Za-z0-9_]+)/.exec(flag);
  return m ? m[1] : null;
}

/** Какой флаг не понравился Java (по тексту ошибки) — или null. */
function badOption(text) {
  const m = /VM option '[+-]?([A-Za-z0-9_]+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

function runJava(javaPath, args) {
  return new Promise((resolve) => {
    execFile(javaPath, args, { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return resolve({ code: null, stderr: String(stderr || err.message) });
      resolve({ code: err ? err.code : 0, stderr: String(stderr || '') });
    });
  });
}

const checked = new Map();

/**
 * Оставить только флаги, которые принимает эта Java.
 * Возвращает { flags, dropped, failed }: failed — Java не запустилась даже без «плохих» флагов, тогда flags пустой.
 * Если саму проверку провести не удалось (Java не ответила) — флаги возвращаются как есть.
 */
async function checkFlags(javaPath, flags, run = runJava) {
  const key = `${javaPath}\n${flags.join(' ')}`;
  if (run === runJava && checked.has(key)) return checked.get(key);
  let cur = [...flags];
  const dropped = [];
  let res = null;
  for (let i = 0; i <= flags.length; i++) {
    // Память небольшая, без AlwaysPreTouch — проверка должна быть быстрой.
    const r = await run(javaPath, ['-Xms1g', '-Xmx1g', ...cur.filter((f) => f !== '-XX:+AlwaysPreTouch'), '-version']);
    if (r.code === null) {
      res = { flags: [...flags], dropped: [], failed: false, unchecked: true };
      break;
    }
    if (r.code === 0) {
      res = { flags: cur, dropped, failed: false };
      break;
    }
    const name = badOption(r.stderr);
    const idx = name ? cur.findIndex((f) => flagName(f) === name) : -1;
    if (idx < 0) {
      res = { flags: [], dropped: [...flags], failed: true };
      break;
    }
    dropped.push(cur[idx]);
    cur.splice(idx, 1);
  }
  if (!res) res = { flags: [], dropped: [...flags], failed: true };
  if (run === runJava && !res.unchecked) checked.set(key, res);
  return res;
}

module.exports = { aikarFlags, recommendRam, checkFlags, badOption, flagName };
