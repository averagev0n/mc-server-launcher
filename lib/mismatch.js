'use strict';
// Разбор ошибки, с которой друга не пускает на модовый сервер: «моды не совпадают»,
// «missing mods», «registry entries are missing». Сопоставляем то, что упомянуто в тексте,
// с модами сервера: чего у друга не хватает и что у него лишнее.

const IGNORE = new Set(['minecraft', 'forge', 'neoforge', 'fml', 'fabric', 'c', 'java', 'brigadier', 'http', 'https', 'net', 'com', 'org', 'io', 'www']);

// Где в тексте говорится, что не хватает у клиента, а где — у сервера.
const CLIENT_MISSING = /(you are missing|missing on (the )?client|client is missing|not present on (the |your )?client|missing (the following )?mods|mod rejections|registry entries are missing|missing registry|missing required|requires|нет на клиенте|у вас нет|отсутству)/i;
const SERVER_MISSING = /(missing on (the )?server|server is missing|not present on (the )?server|not installed on (the )?server|нет на сервере)/i;
const VERSION_WORDS = /(version|версия|mismatch|не совпада)/i;

/** Идентификаторы модов, упомянутые в строке. */
function idsIn(line) {
  const out = new Set();
  // modid:что-то — каналы и записи реестров
  for (const m of line.matchAll(/\b([a-z][a-z0-9_.-]{1,63}):[a-z0-9_/.-]+/g)) out.add(m[1]);
  // Списки в скобках: [modid, other_mod] или «Mod X (modid)»
  for (const m of line.matchAll(/[[(]([a-z0-9_.,\s-]{2,400})[\])]/g)) {
    for (const part of m[1].split(/[,\s]+/)) if (/^[a-z][a-z0-9_-]{1,63}$/.test(part)) out.add(part);
  }
  // «modid@1.2.3» и «modid 1.2.3» после «missing:»
  for (const m of line.matchAll(/\b([a-z][a-z0-9_-]{1,63})@[\w.+-]+/g)) out.add(m[1]);
  return [...out].filter((x) => !IGNORE.has(x));
}

/**
 * text — что прислал друг; mods — моды сервера [{ file, name, ids }].
 * Возвращает { missing: [мод сервера], extra: [id], mismatch: [мод сервера], found }.
 */
function analyze(text, mods) {
  const byId = new Map();
  for (const m of mods) for (const id of m.ids || []) byId.set(id.toLowerCase(), m);
  const missing = new Map();
  const extra = new Set();
  const mismatch = new Map();
  let context = 'unknown';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.toLowerCase();
    if (SERVER_MISSING.test(line)) context = 'server';
    else if (CLIENT_MISSING.test(line)) context = 'client';
    const versionLine = VERSION_WORDS.test(line);
    for (const id of idsIn(line)) {
      const m = byId.get(id);
      if (!m) {
        // Мода нет на сервере: если он упомянут, значит, лишний у друга.
        if (context !== 'client' || /\b(server|сервер)/.test(line)) extra.add(id);
        continue;
      }
      if (context === 'server') continue; // мод есть на сервере, а текст про сервер — шум
      if (versionLine && context !== 'client') mismatch.set(m.file, m);
      else missing.set(m.file, m);
    }
  }
  for (const f of mismatch.keys()) missing.delete(f);
  const found = missing.size + extra.size + mismatch.size > 0;
  return { missing: [...missing.values()], extra: [...extra].sort(), mismatch: [...mismatch.values()], found };
}

module.exports = { analyze, idsIn };
