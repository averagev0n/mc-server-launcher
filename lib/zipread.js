// Чтение отдельных файлов из zip/jar без распаковки целиком (центральный каталог + inflate).
const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRY = 4 * 1024 * 1024; // описания модов маленькие; большие файлы не читаем

/** Список записей: { name, method, csize, size, offset }. */
function entries(fd, fileSize) {
  const tail = Math.min(fileSize, 65557);
  const buf = Buffer.alloc(tail);
  fs.readSync(fd, buf, 0, tail, fileSize - tail);
  let eocd = -1;
  for (let i = tail - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Это не zip-архив');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > fileSize) throw new Error('Повреждённый архив');
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const offset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, csize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Прочитать файлы по именам: { имя: Buffer } (отсутствующие пропускаются). */
function readFiles(file, names) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const want = new Set(names);
    const result = {};
    for (const e of entries(fd, size)) {
      if (!want.has(e.name) || e.size > MAX_ENTRY || e.csize > MAX_ENTRY) continue;
      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, e.offset);
      if (head.readUInt32LE(0) !== 0x04034b50) continue;
      const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const data = Buffer.alloc(e.csize);
      fs.readSync(fd, data, 0, e.csize, start);
      if (e.method === 0) result[e.name] = data;
      else if (e.method === 8) result[e.name] = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readFiles };
