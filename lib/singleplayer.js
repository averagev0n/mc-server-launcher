// Мир сервера → мир для одиночной игры.
// У Paper и Spigot Нижний мир и Энд лежат в отдельных папках (world_nether/DIM-1, world_the_end/DIM1),
// а в одиночной игре — внутри папки мира. Здесь они собираются обратно в одну папку.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SKIP = new Set(['session.lock']);

/** Имя папки, допустимое в Windows. */
function safeName(s) {
  const n = String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60);
  return n || 'Мир с сервера';
}

/** Свободное имя в папке: «Мир», «Мир (2)», … */
function uniqueName(parent, base) {
  let name = base;
  for (let i = 2; fs.existsSync(path.join(parent, name)); i++) name = `${base} (${i})`;
  return name;
}

/** Скопировать мир сервера в dest. Возвращает { dims: ['nether', 'end'] } — какие измерения добавлены отдельно. */
function exportWorld(serverDir, levelName, dest) {
  const src = path.join(serverDir, levelName);
  if (!fs.existsSync(path.join(src, 'level.dat'))) throw new Error('Мира ещё нет — запустите сервер хотя бы раз');
  if (fs.existsSync(dest)) throw new Error('Папка назначения уже существует');
  const filter = (p) => !SKIP.has(path.basename(p));
  fs.cpSync(src, dest, { recursive: true, filter });
  const dims = [];
  for (const [suffix, dim, label] of [['_nether', 'DIM-1', 'nether'], ['_the_end', 'DIM1', 'end']]) {
    const extra = path.join(serverDir, levelName + suffix, dim);
    if (fs.existsSync(extra) && !fs.existsSync(path.join(dest, dim))) {
      fs.cpSync(extra, path.join(dest, dim), { recursive: true, filter });
      dims.push(label);
    }
  }
  return { dims };
}

/**
 * Название мира в списке одиночной игры берётся из level.dat (строка LevelName), а не из имени папки.
 * NBT без длин у составных тегов, поэтому строку можно просто заменить. Не вышло — оставляем как было.
 */
function renameLevel(file, name) {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    const key = Buffer.from([0x08, 0x00, 0x09, ...Buffer.from('LevelName', 'ascii')]);
    const at = raw.indexOf(key);
    if (at < 0) return false;
    const lenAt = at + key.length;
    const old = raw.readUInt16BE(lenAt);
    const value = Buffer.from(String(name).replace(/\u0000/g, ''), 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(value.length);
    const out = Buffer.concat([raw.subarray(0, lenAt), len, value, raw.subarray(lenAt + 2 + old)]);
    fs.writeFileSync(file, zlib.gzipSync(out));
    return true;
  } catch {
    return false;
  }
}

module.exports = { exportWorld, safeName, uniqueName, renameLevel };
