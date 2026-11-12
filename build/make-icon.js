// Рисует иконку приложения (блок травы, пиксель-арт 16×16) в build/icon.png размером 512×512.
// Запуск: node build/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const GRID = 16;
const CELL = SIZE / GRID;

// Детерминированный «шум», чтобы иконка всегда получалась одинаковой.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const GREENS = [[93, 168, 66], [82, 150, 58], [106, 184, 76], [74, 138, 52]];
const DIRT = [[134, 96, 67], [121, 85, 58], [150, 108, 74], [104, 74, 50]];
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// Сколько клеток травы сверху в каждом столбце (неровный край).
const grassDepth = Array.from({ length: GRID }, () => 4 + Math.floor(rnd() * 3));

const cells = [];
for (let y = 0; y < GRID; y++) {
  for (let x = 0; x < GRID; x++) {
    cells.push(y < grassDepth[x] ? pick(GREENS) : pick(DIRT));
  }
}

// RGBA с прозрачными скруглёнными углами.
const radius = 64;
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const cx = x < radius ? radius - x : x >= SIZE - radius ? x - (SIZE - radius - 1) : 0;
    const cy = y < radius ? radius - y : y >= SIZE - radius ? y - (SIZE - radius - 1) : 0;
    const d = Math.hypot(cx, cy);
    const alpha = d <= radius - 1 ? 255 : d >= radius ? 0 : Math.round((radius - d) * 255);
    const c = cells[Math.floor(y / CELL) * GRID + Math.floor(x / CELL)];
    // Лёгкая тень по нижнему краю для объёма.
    const shade = y > SIZE * 0.75 ? 0.88 : 1;
    px[i] = Math.round(c[0] * shade);
    px[i + 1] = Math.round(c[1] * shade);
    px[i + 2] = Math.round(c[2] * shade);
    px[i + 3] = alpha;
  }
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // фильтр None
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // бит на канал
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('build/icon.png готов');
