// Рисует иконку приложения «Блокхост» (пиксель-арт 16×16) в build/icon.png размером 512×512.
// Запуск: node build/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const GRID = 16;
const CELL = SIZE / GRID;

// Серверная стойка из блоков: трава сверху, три сервера с огоньками.
const MAP = [
  '................',
  '..gggggggggggg..',
  '..gGgggGggGggg..',
  '..kkkkkkkkkkkk..',
  '..kLLkkkkkhhhk..',
  '..kkkkkkkkkkkk..',
  '..mmmmmmmmmmmm..',
  '..kkkkkkkkkkkk..',
  '..kLLkkkkkhhhk..',
  '..kkkkkkkkkkkk..',
  '..mmmmmmmmmmmm..',
  '..kkkkkkkkkkkk..',
  '..kOLkkkkkhhhk..',
  '..kkkkkkkkkkkk..',
  '..mmmmmmmmmmmm..',
  '................',
];
const PAL = {
  '.': [59, 75, 94], g: [95, 174, 68], G: [74, 145, 53], k: [43, 48, 56], L: [109, 255, 138],
  O: [255, 176, 46], h: [74, 82, 96], m: [23, 26, 31],
};
const cells = MAP.flatMap((row) => [...row].map((ch) => PAL[ch]));

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
    const shade = 1;
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
