// Почему тормозит сервер: подсчёт существ командами /execute и понятные выводы.

/** Нужна команда execute нового вида — она есть с 1.13. */
function supported(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  const major = Number(m[1]);
  return major > 1 || Number(m[2]) >= 13;
}

const NAME_RE = /^\.?[A-Za-z0-9_]{1,16}$/;

/** Список запросов: [{ key, cmd, kind: 'count' | 'pos' }]. */
function queries(players) {
  const q = [
    { key: 'total', cmd: 'execute if entity @e', kind: 'count' },
    { key: 'items', cmd: 'execute if entity @e[type=item]', kind: 'count' },
    { key: 'xp', cmd: 'execute if entity @e[type=experience_orb]', kind: 'count' },
  ];
  for (const p of players.filter((n) => NAME_RE.test(n)).slice(0, 20)) {
    q.push({ key: `near:${p}`, cmd: `execute at ${p} if entity @e[distance=..48]`, kind: 'count' });
    q.push({ key: `items:${p}`, cmd: `execute at ${p} if entity @e[type=item,distance=..48]`, kind: 'count' });
    q.push({ key: `vill:${p}`, cmd: `execute at ${p} if entity @e[type=villager,distance=..48]`, kind: 'count' });
    q.push({ key: `pos:${p}`, cmd: `data get entity ${p} Pos`, kind: 'pos' });
  }
  return q;
}

/** Строки-ответы, которые прячем из консоли. */
const REPLY_RE = /(Test passed, count: \d+|Test failed|has the following entity data: \[|No entity was found|Found no elements matching)/;

function parseReply(kind, line) {
  if (kind === 'count') {
    const m = /Test passed, count: (\d+)/.exec(line);
    return m ? Number(m[1]) : 0;
  }
  const m = /has the following entity data: \[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(line);
  return m ? [m[1], m[2], m[3]].map((v) => Math.floor(Number(v))) : null;
}

/** Выводы: [{ level: 'bad' | 'warn' | 'info', text, fix? }] — fix: 'items' | 'xp'. */
function analyze(r, players) {
  const out = [];
  if (r.items >= 400) {
    out.push({ level: r.items >= 1500 ? 'bad' : 'warn', text: `На земле лежит ${r.items} предметов — сервер следит за каждым. Обычно это сломанная ферма или мусор после взрыва.`, fix: 'items' });
  }
  if (r.xp >= 300) out.push({ level: 'warn', text: `${r.xp} сфер опыта на земле.`, fix: 'xp' });
  for (const p of players) {
    const near = r[`near:${p}`] || 0;
    const items = r[`items:${p}`] || 0;
    const vill = r[`vill:${p}`] || 0;
    const pos = r[`pos:${p}`];
    const where = pos ? ` (${pos.join(' ')})` : '';
    if (vill >= 40) out.push({ level: 'warn', text: `Около ${p}${where} ${vill} жителей — большие торговые залы сильно нагружают сервер.` });
    else if (near - items >= 250) out.push({ level: near >= 600 ? 'bad' : 'warn', text: `Около ${p}${where} ${near - items} существ — похоже на ферму мобов или загон. Стоит уменьшить число животных.` });
    if (items >= 300) out.push({ level: 'warn', text: `Около ${p}${where} ${items} предметов на земле.`, fix: 'items' });
  }
  if (!out.length) {
    out.push({
      level: 'info',
      text:
        r.total >= 2500
          ? `В мире ${r.total} существ — многовато, но скопления не нашлось. Помогут меньшая дальность прорисовки и прогрузка мира заранее.`
          : `Существ немного (${r.total}). Причина, скорее всего, в механизмах из редстоуна, модах или прогрузке новых мест. Подробно разберёт мод/плагин spark.`,
    });
  }
  // Повторяющиеся подсказки про предметы — одна кнопка на всех.
  let fixShown = false;
  for (const x of out) {
    if (x.fix === 'items') {
      if (fixShown) delete x.fix;
      fixShown = true;
    }
  }
  return out;
}

const FIXES = { items: 'kill @e[type=item]', xp: 'kill @e[type=experience_orb]' };

module.exports = { supported, queries, REPLY_RE, parseReply, analyze, FIXES };
