// Области мира (регионы 512×512 блоков, файлы r.X.Z.mca): что изменилось с копии и откат части мира.

const fs = require('fs');
const path = require('path');
const tar = require('tar');

const SIZE = 512;
const SUBDIRS = ['region', 'entities', 'poi'];
const MCA_RE = /^(.*?)\/?(region|entities|poi)\/r\.(-?\d+)\.(-?\d+)\.mca$/;

const regionOf = (x, z) => [Math.floor(x / SIZE), Math.floor(z / SIZE)];
const blocksOf = (rx, rz) => ({ x1: rx * SIZE, z1: rz * SIZE, x2: rx * SIZE + SIZE - 1, z2: rz * SIZE + SIZE - 1 });

/** Регионы, которые задевает квадрат с центром (x, z) и «радиусом» r блоков. */
function regionsAround(x, z, r) {
  const [x1, z1] = regionOf(x - r, z - r);
  const [x2, z2] = regionOf(x + r, z + r);
  const out = [];
  for (let rx = x1; rx <= x2; rx++) for (let rz = z1; rz <= z2; rz++) out.push([rx, rz]);
  if (out.length > 64) throw new Error('Слишком большая область — максимум около 4000 × 4000 блоков');
  return out;
}

/** Какое измерение у папки внутри мира: «world/region» → overworld, «world/DIM-1» или «world_nether/DIM-1» → nether. */
function dimOf(prefix) {
  if (/(^|\/)DIM-1$/.test(prefix)) return 'nether';
  if (/(^|\/)DIM1$/.test(prefix)) return 'end';
  return 'overworld';
}
const DIM_TITLE = { overworld: 'Обычный мир', nether: 'Нижний мир', end: 'Энд' };

/** Заголовок файла региона: какие чанки есть и когда сохранены. */
function header(buf) {
  const has = new Array(1024);
  const time = new Array(1024);
  for (let i = 0; i < 1024; i++) {
    has[i] = buf.length >= (i + 1) * 4 && buf.readUInt32BE(i * 4) !== 0;
    time[i] = buf.length >= 4096 + (i + 1) * 4 ? buf.readUInt32BE(4096 + i * 4) : 0;
  }
  return { has, time };
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(8192);
    const n = fs.readSync(fd, b, 0, 8192, 0);
    return b.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Файлы регионов текущего мира: «prefix/region/r.X.Z.mca» → полный путь. */
function currentRegions(dir, worlds) {
  const out = new Map();
  const walk = (rel, depth) => {
    let list = [];
    try {
      list = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list) {
      const p = rel + '/' + d.name;
      if (d.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (d.isFile() && MCA_RE.test(p) && /\/region\//.test(p)) out.set(p, path.join(dir, p));
    }
  };
  for (const w of worlds) walk(w, 0);
  return out;
}

/**
 * Сравнить мир с копией: [{ dim, rx, rz, changed, added, removed, ...blocks }] — сначала самые изменённые.
 * Чанк «изменён», если сервер сохранил его после копии (там строили, ломали или двигались мобы).
 */
async function compare(dir, archive, worlds) {
  const old = new Map();
  await tar.t({
    file: archive,
    onReadEntry: (entry) => {
      const p = entry.path.replace(/\\/g, '/');
      if (!MCA_RE.test(p) || !/\/region\//.test(p)) return entry.resume();
      const parts = [];
      let got = 0;
      entry.on('data', (c) => {
        if (got < 8192) {
          parts.push(c);
          got += c.length;
        }
      });
      entry.on('end', () => old.set(p, Buffer.concat(parts).subarray(0, 8192)));
    },
  });
  const now = currentRegions(dir, worlds);
  const keys = new Set([...old.keys(), ...now.keys()]);
  const out = [];
  for (const k of keys) {
    const [, prefix, , rx, rz] = MCA_RE.exec(k);
    const a = old.has(k) ? header(old.get(k)) : null;
    const b = now.has(k) ? header(readHead(now.get(k))) : null;
    let changed = 0;
    let added = 0;
    let removed = 0;
    for (let i = 0; i < 1024; i++) {
      const ah = a && a.has[i];
      const bh = b && b.has[i];
      if (bh && !ah) added++;
      else if (ah && !bh) removed++;
      else if (ah && bh && a.time[i] !== b.time[i]) changed++;
    }
    if (changed || added || removed) {
      out.push({ dim: dimOf(prefix), prefix, rx: Number(rx), rz: Number(rz), changed, added, removed, ...blocksOf(Number(rx), Number(rz)) });
    }
  }
  return out.sort((x, y) => y.changed + y.added + y.removed - (x.changed + x.added + x.removed));
}

/** Папка измерения внутри архива или на диске: world, world/DIM-1, world_nether/DIM-1… */
function prefixesFor(level, dim) {
  if (dim === 'nether') return [`${level}/DIM-1`, `${level}_nether/DIM-1`];
  if (dim === 'end') return [`${level}/DIM1`, `${level}_the_end/DIM1`];
  return [level];
}

/**
 * Вернуть выбранные регионы из копии (сервер должен быть остановлен).
 * Регион, которого в копии не было, удаляется: игра создаст его заново.
 */
async function restore(dir, archive, level, dim, list) {
  const prefixes = prefixesFor(level, dim);
  const wanted = new Set();
  for (const [rx, rz] of list) for (const pre of prefixes) for (const sub of SUBDIRS) wanted.add(`${pre}/${sub}/r.${rx}.${rz}.mca`);
  const found = new Set();
  await tar.t({
    file: archive,
    onReadEntry: (e) => {
      const p = e.path.replace(/\\/g, '/');
      if (wanted.has(p)) found.add(p);
      e.resume();
    },
  });
  // Сначала убираем текущие файлы этих регионов, потом достаём из копии те, что в ней есть.
  let removed = 0;
  for (const p of wanted) {
    const full = path.join(dir, p);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { force: true });
      if (!found.has(p)) removed++;
    }
  }
  if (found.size) {
    await tar.x({ file: archive, cwd: dir, strict: true, filter: (p) => found.has(p.replace(/\\/g, '/')) });
  }
  return { restored: [...found].filter((p) => /\/region\//.test(p)).length, removed };
}

module.exports = { SIZE, regionOf, regionsAround, blocksOf, header, compare, restore, prefixesFor, dimOf, DIM_TITLE, currentRegions };
