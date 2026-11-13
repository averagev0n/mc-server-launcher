// Вид сверху: файл региона r.X.Z.mca → картинка RGBA (по одному пикселю на scale блоков).
// Поддерживаются миры 1.13+ (палитры блоков). Цвет — по верхнему блоку, с тенью от рельефа.

const zlib = require('zlib');
const nbt = require('./nbt');

const COLORS = [
  [/water|seagrass|kelp|bubble_column/, [63, 118, 228]],
  [/lava/, [217, 106, 26]],
  [/^grass_block$|moss_block|moss_carpet/, [110, 160, 62]],
  [/short_grass|tall_grass|^grass$|fern|vine|lily_pad|sugar_cane|bush/, [96, 150, 56]],
  [/birch_leaves/, [128, 167, 85]],
  [/spruce_leaves/, [61, 100, 61]],
  [/cherry_leaves/, [232, 170, 200]],
  [/leaves/, [72, 128, 44]],
  [/red_sand/, [190, 102, 33]],
  [/sandstone|^sand$|suspicious_sand/, [219, 211, 160]],
  [/gravel/, [131, 127, 126]],
  [/snow|powder_snow/, [242, 246, 248]],
  [/ice/, [158, 195, 255]],
  [/deepslate|tuff|basalt|blackstone/, [80, 80, 86]],
  [/stone|andesite|diorite|granite|calcite|ore/, [125, 125, 125]],
  [/podzol|rooted_dirt|coarse_dirt/, [110, 80, 50]],
  [/mycelium/, [111, 98, 101]],
  [/dirt|farmland|dirt_path|grass_path/, [139, 107, 71]],
  [/mud/, [60, 56, 55]],
  [/clay/, [160, 166, 180]],
  [/terracotta/, [160, 96, 62]],
  [/log|wood|stem|hyphae/, [107, 80, 52]],
  [/planks|slab|stairs|fence|door|trapdoor|bookshelf|crafting_table|chest|barrel/, [165, 132, 79]],
  [/cobble|bricks|wall/, [122, 122, 122]],
  [/end_stone|purpur/, [219, 222, 158]],
  [/obsidian/, [21, 16, 30]],
  [/netherrack|nether_wart|crimson/, [122, 42, 40]],
  [/warped/, [43, 104, 99]],
  [/soul_sand|soul_soil/, [80, 62, 50]],
  [/glass/, [192, 216, 224]],
  [/wool|carpet|concrete/, [200, 200, 200]],
  [/pumpkin|melon/, [200, 120, 30]],
  [/flower|tulip|poppy|dandelion|orchid|allium|bluet|daisy|cornflower|lily_of/, [180, 180, 70]],
  [/torch|lantern|glowstone|sea_lantern|shroomlight/, [240, 210, 120]],
  [/bedrock/, [50, 50, 50]],
];
const cache = new Map();
function colorOf(name) {
  let c = cache.get(name);
  if (c) return c;
  const n = name.replace(/^minecraft:/, '');
  for (const [re, col] of COLORS) {
    if (re.test(n)) {
      c = col;
      break;
    }
  }
  if (!c) {
    // Незнакомый блок (например, из мода) — спокойный цвет по имени.
    let h = 0;
    for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    c = [110 + (h % 70), 110 + ((h >> 8) % 70), 110 + ((h >> 16) % 70)];
  }
  cache.set(name, c);
  return c;
}

/** Значение из упакованного массива long (BigInt). span — значения переходят через границу long (1.13–1.15). */
function packed(longs, index, bits, span) {
  const mask = (1n << BigInt(bits)) - 1n;
  if (!span) {
    const per = Math.floor(64 / bits);
    const li = Math.floor(index / per);
    if (li >= longs.length) return 0;
    return Number((longs[li] >> BigInt((index % per) * bits)) & mask);
  }
  const bit = index * bits;
  const li = bit >> 6;
  const off = bit & 63;
  if (li >= longs.length) return 0;
  let v = longs[li] >> BigInt(off);
  if (off + bits > 64 && li + 1 < longs.length) v |= longs[li + 1] << BigInt(64 - off);
  return Number(v & mask);
}

function readChunk(region, i) {
  const loc = region.readUInt32BE(i * 4);
  if (!loc) return null;
  const off = (loc >>> 8) * 4096;
  if (off + 5 > region.length) return null;
  const len = region.readUInt32BE(off);
  const kind = region[off + 4];
  if (len < 1 || off + 4 + len > region.length || kind & 128) return null;
  const data = region.subarray(off + 5, off + 4 + len);
  try {
    if (kind === 2) return nbt.parse(zlib.inflateSync(data), { bigLongs: true });
    if (kind === 1) return nbt.parse(zlib.gunzipSync(data), { bigLongs: true });
    if (kind === 3) return nbt.parse(data, { bigLongs: true });
  } catch {
    return null;
  }
  return null; // LZ4 и прочее — пропускаем
}

/** Верхние блоки чанка: функция (x, z) → { name, y } или null, если чанк не готов. */
function chunkTops(root) {
  const dv = root.DataVersion || 0;
  const modern = Array.isArray(root.sections);
  const lvl = modern ? root : root.Level;
  if (!lvl) return null;
  const status = String(lvl.Status || root.Status || '');
  if (status && !/full|postprocessed|fullchunk/.test(status)) return null;
  const hm = lvl.Heightmaps && (lvl.Heightmaps.WORLD_SURFACE || lvl.Heightmaps.MOTION_BLOCKING);
  if (!hm) return null;
  const sections = modern ? root.sections : lvl.Sections || [];
  const byY = new Map();
  let minSec = Infinity;
  for (const s of sections) {
    const palette = modern ? s.block_states && s.block_states.palette : s.Palette;
    if (!palette || !palette.length) continue;
    byY.set(s.Y, { palette, data: modern ? s.block_states.data : s.BlockStates });
    minSec = Math.min(minSec, s.Y);
  }
  const minY = Number.isFinite(root.yPos) ? root.yPos * 16 : modern ? Math.min(0, minSec * 16) : 0;
  const span = dv < 2529; // до 1.16 значения переходят через границу long
  const hmBits = hm.length === 37 || hm.length === 36 ? 9 : Math.ceil((hm.length * 64) / 256);
  return (x, z) => {
    const h = packed(hm, z * 16 + x, Math.min(hmBits, 9) || 9, span);
    if (!h) return null;
    let y = minY + h - 1;
    // Идём вниз, пока не встретим непрозрачный для карты блок (воздух бывает у краёв секций).
    for (let tries = 0; tries < 4; tries++, y--) {
      const sec = byY.get(Math.floor(y / 16));
      if (!sec) continue;
      let idx = 0;
      if (sec.palette.length > 1 && sec.data) {
        const bits = Math.max(4, Math.ceil(Math.log2(sec.palette.length)));
        idx = packed(sec.data, ((y & 15) * 16 + z) * 16 + x, bits, span);
      }
      const name = (sec.palette[idx] && sec.palette[idx].Name) || 'minecraft:air';
      if (!/air$/.test(name)) return { name, y };
    }
    return null;
  };
}

/** Регион → { size, rgba } (rgba — Uint8ClampedArray size×size×4, прозрачный там, где мира нет). */
function render(region, scale = 4) {
  const size = 512 / scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const heights = new Int16Array(size * size).fill(-32768);
  const per = 16 / scale;
  for (let cz = 0; cz < 32; cz++) {
    for (let cx = 0; cx < 32; cx++) {
      const root = readChunk(region, cz * 32 + cx);
      if (!root) continue;
      const top = chunkTops(root);
      if (!top) continue;
      for (let pz = 0; pz < per; pz++) {
        for (let px = 0; px < per; px++) {
          const t = top(px * scale, pz * scale);
          if (!t) continue;
          const X = cx * per + px;
          const Z = cz * per + pz;
          const c = colorOf(t.name);
          const o = (Z * size + X) * 4;
          rgba[o] = c[0];
          rgba[o + 1] = c[1];
          rgba[o + 2] = c[2];
          rgba[o + 3] = 255;
          heights[Z * size + X] = t.y;
        }
      }
    }
  }
  // Тень: выше северного соседа — светлее, ниже — темнее.
  for (let Z = 1; Z < size; Z++) {
    for (let X = 0; X < size; X++) {
      const h = heights[Z * size + X];
      const n = heights[(Z - 1) * size + X];
      if (h === -32768 || n === -32768) continue;
      const k = h > n ? 1.12 : h < n ? 0.84 : 1;
      if (k === 1) continue;
      const o = (Z * size + X) * 4;
      rgba[o] = rgba[o] * k;
      rgba[o + 1] = rgba[o + 1] * k;
      rgba[o + 2] = rgba[o + 2] * k;
    }
  }
  return { size, rgba };
}

module.exports = { render, chunkTops, packed, colorOf };
