// Карточка игрока: где он, здоровье, уровень и что в инвентаре — из playerdata/<uuid>.dat.

const fs = require('fs');
const path = require('path');
const nbt = require('./nbt');

const DIMS = { 'minecraft:overworld': 'Обычный мир', 'minecraft:the_nether': 'Нижний мир', 'minecraft:the_end': 'Энд' };
const MODES = ['Выживание', 'Творческий', 'Приключение', 'Наблюдатель'];

/** UUID по нику: из usercache.json сервера. */
function uuidFromCache(dir, name) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'usercache.json'), 'utf8'));
    const hit = list.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === name.toLowerCase());
    return hit ? hit.uuid : null;
  } catch {
    return null;
  }
}

function dimName(d) {
  if (typeof d === 'number') return ['Нижний мир', 'Обычный мир', 'Энд'][d + 1] || 'Обычный мир';
  return DIMS[d] || String(d || 'minecraft:overworld').replace(/^minecraft:/, '');
}

/** Разобрать данные игрока (объект NBT) в то, что показывает лаунчер. */
function describe(data) {
  const pos = Array.isArray(data.Pos) ? data.Pos.map((v) => Math.floor(v)) : null;
  const items = (Array.isArray(data.Inventory) ? data.Inventory : [])
    .filter((it) => it && typeof it.id === 'string')
    .map((it) => ({ slot: it.Slot ?? null, id: it.id, count: it.count ?? it.Count ?? 1 }))
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  return {
    pos,
    dimension: dimName(data.Dimension),
    health: Number.isFinite(data.Health) ? Math.round(data.Health) : null,
    food: Number.isFinite(data.foodLevel) ? data.foodLevel : null,
    level: Number.isFinite(data.XpLevel) ? data.XpLevel : null,
    mode: MODES[data.playerGameType] || null,
    items,
  };
}

/** Прочитать файл игрока; null — если сервер о нём ещё ничего не сохранил. */
function read(dir, levelName, uuid) {
  if (!/^[0-9a-f-]{32,36}$/i.test(uuid || '')) return null;
  const file = path.join(dir, levelName, 'playerdata', `${uuid}.dat`);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  return { ...describe(nbt.parse(raw)), savedAt: fs.statSync(file).mtimeMs };
}

/** «diamond_sword» → «diamond sword»; без «minecraft:». */
const itemName = (id) => String(id).replace(/^minecraft:/, '').replace(/_/g, ' ');

module.exports = { uuidFromCache, describe, read, itemName, dimName };
