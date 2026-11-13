// Место на диске: сколько занимает сервер (мир, копии, остальное) и сколько свободно.
const fs = require('fs');
const path = require('path');
const { worldDirs } = require('./backup');

async function dirSize(p) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) {
      try {
        total += (await fs.promises.stat(full)).size;
      } catch {
        /* файл исчез */
      }
    }
  }
  return total;
}

async function freeSpace(p) {
  try {
    const s = await fs.promises.statfs(p);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return { free: null, total: null };
  }
}

/** Размеры для вкладки «Обслуживание» и сводки «Здоровье». */
async function usage(dir) {
  let world = 0;
  for (const w of worldDirs(dir)) world += await dirSize(path.join(dir, w));
  const backups = await dirSize(path.join(dir, 'backups'));
  const all = await dirSize(dir);
  const disk = await freeSpace(fs.existsSync(dir) ? dir : path.parse(dir).root);
  return { world, backups, other: Math.max(0, all - world - backups), all, ...disk };
}

/** Предупреждение о месте: 'bad' — меньше 2 ГБ или меньше трёх размеров мира, 'warn' — меньше 10 ГБ. */
function level(u) {
  if (u.free === null) return null;
  const gb = 1024 ** 3;
  if (u.free < 2 * gb || u.free < u.world * 3) return 'bad';
  if (u.free < 10 * gb) return 'warn';
  return 'ok';
}

module.exports = { usage, level, dirSize };
