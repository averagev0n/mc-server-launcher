// Чтение файлов NBT (level.dat, playerdata/*.dat) — только чтение, в простые объекты JS.

const zlib = require('zlib');

/** opts.bigLongs — массивы long (тег 12) оставить как BigInt: нужно для упакованных данных чанков. */
function parse(input, opts = {}) {
  let buf = input;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  else if (buf[0] === 0x78) buf = zlib.inflateSync(buf);
  let o = 0;
  const need = (n) => {
    if (o + n > buf.length) throw new Error('Файл NBT обрезан');
  };
  const str = () => {
    need(2);
    const n = buf.readUInt16BE(o);
    o += 2;
    need(n);
    const s = buf.toString('utf8', o, o + n);
    o += n;
    return s;
  };
  function payload(t, depth) {
    if (depth > 64) throw new Error('Слишком глубокий NBT');
    switch (t) {
      case 1: need(1); return buf.readInt8(o++);
      case 2: need(2); o += 2; return buf.readInt16BE(o - 2);
      case 3: need(4); o += 4; return buf.readInt32BE(o - 4);
      case 4: need(8); o += 8; return Number(buf.readBigInt64BE(o - 8));
      case 5: need(4); o += 4; return buf.readFloatBE(o - 4);
      case 6: need(8); o += 8; return buf.readDoubleBE(o - 8);
      case 7: {
        need(4);
        const n = buf.readInt32BE(o);
        o += 4;
        need(n);
        const a = [...buf.subarray(o, o + n)].map((b) => (b > 127 ? b - 256 : b));
        o += n;
        return a;
      }
      case 8: return str();
      case 9: {
        need(5);
        const et = buf.readUInt8(o);
        const n = buf.readInt32BE(o + 1);
        o += 5;
        const a = [];
        for (let i = 0; i < n; i++) a.push(payload(et, depth + 1));
        return a;
      }
      case 10: {
        const obj = {};
        for (;;) {
          need(1);
          const ct = buf.readUInt8(o++);
          if (ct === 0) return obj;
          const name = str();
          obj[name] = payload(ct, depth + 1);
        }
      }
      case 11:
      case 12: {
        need(4);
        const n = buf.readInt32BE(o);
        o += 4;
        const size = t === 11 ? 4 : 8;
        need(n * size);
        const a = [];
        for (let i = 0; i < n; i++) {
          if (t === 11) a.push(buf.readInt32BE(o + i * 4));
          else a.push(opts.bigLongs ? buf.readBigUInt64BE(o + i * 8) : Number(buf.readBigInt64BE(o + i * 8)));
        }
        o += n * size;
        return a;
      }
      default:
        throw new Error('Неизвестный тег NBT ' + t);
    }
  }
  need(1);
  const t = buf.readUInt8(o++);
  if (t !== 10) throw new Error('Это не файл NBT');
  str();
  return payload(10, 0);
}

module.exports = { parse };
