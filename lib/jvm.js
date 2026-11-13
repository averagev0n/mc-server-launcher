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
    '-XX:G1RSetUpdatingPauseTimeTarget=5',
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

module.exports = { aikarFlags, recommendRam };
