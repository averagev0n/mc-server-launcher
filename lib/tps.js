// Плавность сервера (TPS — тиков в секунду, норма 20). Лаунчер тихо спрашивает сервер
// раз в несколько секунд и прячет ответы из консоли.

function parseMc(mc) {
  const m = String(mc).match(/^1\.(\d+)(?:\.(\d+))?/);
  return m ? { minor: Number(m[1]), patch: Number(m[2] || 0) } : null;
}

/** Какой командой спрашивать TPS; null — у этого сервера такой команды нет. */
function queryFor(type, mc) {
  if (['paper', 'arclight', 'mohist', 'youer'].includes(type)) return 'tps';
  if (type === 'forge') return 'forge tps';
  if (type === 'neoforge') return 'neoforge tps';
  // У vanilla и Fabric — «tick query», появилась в 1.20.3.
  const v = parseMc(mc);
  if (!v || v.minor > 20 || (v.minor === 20 && v.patch >= 3)) return 'tick query';
  return null;
}

const num = (s) => Number(String(s).replace(',', '.'));

/** Разобрать строку ответа: { tps, mspt } или null. */
function parse(line) {
  const s = String(line);
  // Paper/Spigot: «TPS from last 1m, 5m, 15m: 20.0, 19.9, 20.0» (бывает «*20.0»).
  let m = s.match(/TPS from last 1m, 5m, 15m:\s*\*?([\d.]+)/i);
  if (m) return { tps: Math.min(20, num(m[1])), mspt: null };
  // Forge/NeoForge: «Overall: Mean tick time: 1.234 ms. Mean TPS: 20.000».
  m = s.match(/Overall\s*:\s*Mean tick time:\s*([\d.]+)\s*ms\.?\s*Mean TPS:\s*([\d.]+)/i);
  if (m) return { tps: Math.min(20, num(m[2])), mspt: num(m[1]) };
  // vanilla «tick query»: «Average time per tick: 3.2ms (Target: 50.0ms)».
  m = s.match(/Average time per tick:\s*([\d.]+)\s*ms\s*\(Target:\s*([\d.]+)\s*ms\)/i);
  if (m) {
    const mspt = num(m[1]);
    const target = num(m[2]) || 50;
    return { tps: Math.round(Math.min(1000 / target, 1000 / Math.max(mspt, 0.001)) * 10) / 10, mspt };
  }
  return null;
}

const NOISE = [
  /TPS from last/i,
  /Mean tick time/i,
  /Dim\s.+\(.+\)\s*:/i,
  /The game is (running normally|sprinting|frozen|stepping)/i,
  /Target tick rate/i,
  /Average time per tick/i,
  /Percentiles:/i,
  /P50:/,
  /Unknown or incomplete command|Unknown command/i,
  /<--\[HERE\]/,
];
/** Строка — ответ на тихий запрос TPS: в консоль её не показываем. */
const isTpsLine = (line) => NOISE.some((re) => re.test(String(line)));
const isUnknown = (line) => /Unknown or incomplete command|Unknown command/i.test(String(line));

module.exports = { queryFor, parse, isTpsLine, isUnknown };
