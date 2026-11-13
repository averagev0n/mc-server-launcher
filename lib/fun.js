// Игровые события по кнопке и достижения сервера.

const fs = require('fs');
const path = require('path');
const gamerules = require('./gamerules');

// ---- события ----

/** С 1.20.5 у предметов «компоненты» вместо NBT-тегов. */
function hasComponents(mc) {
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(String(mc));
  if (!m) return true;
  const minor = Number(m[1]);
  const patch = Number(m[2] || 0);
  return minor > 20 || (minor === 20 && patch >= 5);
}

const COLORS = [16711680, 16766720, 65280, 3381759, 16711935, 16777215];

function firework(mc, color) {
  const fw = hasComponents(mc)
    ? `{id:"firework_rocket",count:1,components:{"minecraft:fireworks":{flight_duration:1,explosions:[{shape:"large_ball",colors:[I;${color}],has_twinkle:true}]}}}`
    : `{id:"firework_rocket",Count:1,tag:{Fireworks:{Flight:1,Explosions:[{Type:1,Colors:[I;${color}],Flicker:1}]}}}`;
  return `execute at @a run summon firework_rocket ~ ~2 ~ {LifeTime:20,FireworksItem:${fw}}`;
}

function rule(mc, oldName, newName, value) {
  return `gamerule ${gamerules.isNewNames(mc) ? newName : oldName} ${value}`;
}

/**
 * Событие → { start: [команды], end: [команды] | null, minutes, say }.
 * Конец события — обратные команды через minutes минут.
 */
const EVENTS = {
  fireworks: {
    title: 'Праздничный салют',
    build: (mc) => ({ start: [0, 1, 2].map((i) => firework(mc, COLORS[(Date.now() / 1000 + i) % COLORS.length | 0])), end: null, minutes: 0, say: 'Праздничный салют!' }),
  },
  xp: {
    title: 'Подарок опыта',
    build: () => ({ start: ['execute at @a run summon experience_orb ~ ~1 ~ {Value:100}', 'execute at @a run summon experience_orb ~1 ~1 ~ {Value:100}', 'execute at @a run summon experience_orb ~ ~1 ~1 {Value:100}'], end: null, minutes: 0, say: 'Подарок от сервера: опыт всем!' }),
  },
  peace: {
    title: 'Мирный час',
    build: (mc) => ({
      start: [rule(mc, 'doMobSpawning', 'spawn_mobs', 'false')],
      end: [rule(mc, 'doMobSpawning', 'spawn_mobs', 'true')],
      minutes: 60,
      say: 'Мирный час: целый час новые монстры не появляются.',
      endSay: 'Мирный час закончился — будьте осторожны.',
    }),
  },
  day: {
    title: 'Вечный день',
    build: (mc) => ({
      start: ['time set day', 'weather clear', rule(mc, 'doDaylightCycle', 'advance_time', 'false'), rule(mc, 'doWeatherCycle', 'advance_weather', 'false')],
      end: [rule(mc, 'doDaylightCycle', 'advance_time', 'true'), rule(mc, 'doWeatherCycle', 'advance_weather', 'true')],
      minutes: 60,
      say: 'Целый час — солнечный день без дождя.',
      endSay: 'Время снова идёт как обычно.',
    }),
  },
  gift: {
    title: 'Подарок всем',
    build: (mc, arg) => {
      const id = String(arg || 'cake').toLowerCase().trim();
      if (!/^([a-z0-9_.-]+:)?[a-z0-9_./-]{1,64}$/.test(id)) throw new Error('Название предмета — латиницей, например cake или diamond');
      return { start: [`give @a ${id} 1`], end: null, minutes: 0, say: `Подарок от сервера: ${id.replace(/^minecraft:/, '').replace(/_/g, ' ')}!` };
    },
  },
};

const tellAll = (text, color = 'gold') => `tellraw @a {"text":${JSON.stringify(String(text))},"color":"${color}"}`;

// ---- достижения ----

const FILE = 'mcl-achievements.json';
// Достижения игры, за которые сервер отмечает того, кто получил их первым.
const FIRSTS = {
  'Free the End': 'первым победил Эндер-дракона',
  'We Need to Go Deeper': 'первым попал в Нижний мир',
  'The End?': 'первым попал в Энд',
  'Diamonds!': 'первым нашёл алмазы',
  'Monster Hunter': 'первым убил монстра',
  'Return to Sender': 'первым отбил огненный шар гаста',
  'The Next Generation': 'первым забрал яйцо дракона',
  'Hero of the Village': 'первым защитил деревню от рейда',
  'Cover Me in Debris': 'первым собрал полную незеритовую броню',
  'A Furious Cocktail': 'первым собрал все эффекты зелий',
  'How Did We Get Here?': 'первым собрал все эффекты в игре',
};
const HOURS = [1, 10, 50, 100, 250, 500];
const ADV_RE = /\]:\s(?:\[Not Secure\]\s)?([.\w]{1,17}) has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]\s*$/;

function read(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return { firsts: j.firsts || {}, hours: j.hours || {} };
  } catch {
    return { firsts: {}, hours: {} };
  }
}
const write = (dir, data) => fs.writeFileSync(path.join(dir, FILE), JSON.stringify(data, null, 2), 'utf8');

/** Строка журнала → новое достижение сервера или null. */
function onLine(dir, line, now = Date.now()) {
  const m = ADV_RE.exec(line);
  if (!m || !FIRSTS[m[2]]) return null;
  const data = read(dir);
  if (data.firsts[m[2]]) return null;
  data.firsts[m[2]] = { name: m[1], at: now };
  write(dir, data);
  return { name: m[1], text: `${m[1]} ${FIRSTS[m[2]]} на этом сервере!` };
}

/** Часы в игре: totals — { ник: мс }. Возвращает новые рубежи. */
function onHours(dir, totals) {
  const data = read(dir);
  const out = [];
  for (const [name, ms] of Object.entries(totals)) {
    const h = ms / 3600000;
    const got = data.hours[name] || 0;
    const next = HOURS.filter((x) => x > got && x <= h).pop();
    if (next) {
      data.hours[name] = next;
      out.push({ name, text: `${name} провёл на сервере ${next} ${next === 1 ? 'час' : next < 5 ? 'часа' : 'часов'}!` });
    }
  }
  if (out.length) write(dir, data);
  return out;
}

function list(dir) {
  const d = read(dir);
  return {
    firsts: Object.entries(d.firsts).map(([adv, v]) => ({ adv, text: FIRSTS[adv] || adv, name: v.name, at: v.at })).sort((a, b) => a.at - b.at),
    hours: Object.entries(d.hours).map(([name, h]) => ({ name, hours: h })).sort((a, b) => b.hours - a.hours),
  };
}

module.exports = { EVENTS, tellAll, hasComponents, firework, onLine, onHours, list, FIRSTS, HOURS, FILE };
