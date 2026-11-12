// Правила игры (gamerule) без команд. С Minecraft 1.21.11 правила переименованы
// в snake_case, некоторые — по-новому (doDaylightCycle → advance_time), поэтому имя зависит от версии.

const RULES = {
  keepInventory: { next: 'keep_inventory', def: false },
  mobGriefing: { next: 'mob_griefing', def: true },
  doInsomnia: { next: 'spawn_phantoms', def: true },
  playersSleepingPercentage: { next: 'players_sleeping_percentage', def: false, number: true, since: 17 },
  doDaylightCycle: { next: 'advance_time', def: true },
  doWeatherCycle: { next: 'advance_weather', def: true },
  doImmediateRespawn: { next: 'immediate_respawn', def: false, since: 15 },
  announceAdvancements: { next: 'show_advancement_messages', def: true },
};

/** Вторая часть версии 1.X.Y; у новых версий без «1.» (26.1 и т. п.) — null. */
function parseMc(mc) {
  const m = String(mc).match(/^1\.(\d+)(?:\.(\d+))?/);
  return m ? { minor: Number(m[1]), patch: Number(m[2] || 0) } : null;
}

function isNewNames(mc) {
  const v = parseMc(mc);
  return !v || v.minor > 21 || (v.minor === 21 && v.patch >= 11);
}

function supported(mc, id) {
  const r = RULES[id];
  const v = parseMc(mc);
  return !!r && (!r.since || !v || v.minor >= r.since);
}

/** Проверить и очистить сохранённые значения: только известные правила и только да/нет. */
function clean(values) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (RULES[k] && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Команды для сервера. playersSleepingPercentage: true — «хватит одного спящего» (1 %), false — все (100 %). */
function commandsFor(mc, values) {
  const neu = isNewNames(mc);
  const cmds = [];
  for (const [id, v] of Object.entries(clean(values))) {
    if (!supported(mc, id)) continue;
    const r = RULES[id];
    const name = neu ? r.next : id;
    const value = r.number ? (v ? 1 : 100) : v;
    cmds.push(`gamerule ${name} ${value}`);
  }
  return cmds;
}

module.exports = { RULES, isNewNames, supported, clean, commandsFor };
