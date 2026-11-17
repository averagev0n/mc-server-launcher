'use strict';
// Управление сервером на VPS: настройки server.properties, замеры нагрузки, удаление.
// Здесь только чистые функции (тексты скриптов для Linux, разбор и проверка данных) —
// подключение по SSH и запуск скриптов — в lib/vps.js, скрипты для Windows — в lib/vps-windows.js.

const net = require('net');

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Имя папки сервера на VPS: латиница, цифры, точка, дефис, подчёркивание; не «.» и не «..». */
const safeName = (name) => NAME_RE.test(String(name)) && !/^\.+$/.test(String(name));

// ---- server.properties ----

/** Значение из файла в обычный текст: \uXXXX, \: \= \\ и т. п. (так пишет Java). */
function unescapeValue(v) {
  return v.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[c] || c;
  });
}

/** Обратно: только то, что Java прочтёт одинаково в любой кодировке файла. */
function escapeValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Разобрать server.properties: [[ключ, значение], …] в порядке файла. */
function parseProps(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line[0] === '#' || line[0] === '!') continue;
    const m = line.match(/^((?:\\.|[^=:\s\\])+)\s*[=:]?\s*(.*)$/);
    if (!m) continue;
    out.push([unescapeValue(m[1]), unescapeValue(m[2])]);
  }
  return out;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ENUMS = {
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
};
const RANGES = {
  'server-port': [1, 65535, 'Порт'],
  'query.port': [1, 65535, 'Порт query'],
  'rcon.port': [1, 65535, 'Порт RCON'],
  'max-players': [1, 1000, 'Число игроков'],
  'view-distance': [2, 32, 'Дальность прорисовки'],
  'simulation-distance': [2, 32, 'Дальность симуляции'],
  'spawn-protection': [0, 10000, 'Защита спавна'],
  'max-world-size': [1, 29999984, 'Размер мира'],
  'player-idle-timeout': [0, 100000, 'Выкидывать бездействующих через'],
};

/**
 * Проверить изменения. current — что сейчас в файле ([[k, v]]), values — {ключ: новое значение}.
 * Возвращает очищенные значения; при ошибке — исключение с понятным текстом.
 */
function validateProps(current, values) {
  const now = new Map(current);
  const clean = {};
  for (const [key, val] of Object.entries(values || {})) {
    if (!KEY_RE.test(key)) throw new Error(`Некорректное имя параметра: ${key}`);
    const v = String(val ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (v.length > 4000) throw new Error(`Слишком длинное значение ${key}`);
    const old = now.has(key) ? String(now.get(key)).trim() : null;
    if (ENUMS[key] && !ENUMS[key].includes(v)) throw new Error(`Некорректное значение ${key}`);
    if (RANGES[key]) {
      const [min, max, label] = RANGES[key];
      const n = Number(v);
      if (!(v !== '' && Number.isInteger(n) && n >= min && n <= max)) throw new Error(`${label} — целое число от ${min} до ${max}`);
    }
    // Было «да/нет» — должно остаться «да/нет»; было число — должно остаться числом.
    if ((old === 'true' || old === 'false') && v !== 'true' && v !== 'false') throw new Error(`${key}: нужно true или false`);
    if (old !== null && /^-?\d+$/.test(old) && !/^-?\d+$/.test(v)) throw new Error(`${key}: нужно целое число`);
    if (key === 'server-ip' && v && !net.isIP(v)) throw new Error('IP сервера указан неверно — на VPS его лучше оставить пустым');
    if (key === 'level-name' && (!v || /[\\/:*?"<>|]/.test(v) || /^\.+$/.test(v))) throw new Error('Имя мира не может быть пустым и содержать \\ / : * ? " < > |');
    clean[key] = v;
  }
  return clean;
}

/** Поменять значения в тексте файла; комментарии и прочие строки остаются как были. */
function patchProps(text, values) {
  const left = new Map(Object.entries(values));
  const lines = String(text || '').split(/\r?\n/);
  const out = lines.map((raw) => {
    const line = raw.replace(/^\s+/, '');
    if (!line || line[0] === '#' || line[0] === '!') return raw;
    const m = line.match(/^((?:\\.|[^=:\s\\])+)/);
    if (!m) return raw;
    const key = unescapeValue(m[1]);
    if (!left.has(key)) return raw;
    const v = left.get(key);
    left.delete(key);
    return `${m[1]}=${escapeValue(v)}`;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of left) out.push(`${k}=${escapeValue(v)}`);
  return out.join('\n') + '\n';
}

// ---- замеры нагрузки ----

/** Скрипт замера для Linux: система целиком и все процессы сервера (группа процессов mcl-start.sh). */
function linuxStatsScript(name, withSize) {
  if (!safeName(name)) throw new Error('Некорректное имя сервера');
  return `D="$HOME/mc-launcher/servers/${name}"
[ -d "$D" ] || { echo "nodir=1"; exit 0; }
read -r up _ < /proc/uptime; echo "up=$up"
echo "clk=$(getconf CLK_TCK 2>/dev/null || echo 100)"
echo "page=$(getconf PAGESIZE 2>/dev/null || echo 4096)"
echo "ncpu=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
head -n1 /proc/stat | sed 's/^cpu */cpu=/'
echo "mem=$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
echo "memfree=$(awk '/^MemAvailable:/ {a=$2} /^MemFree:/ {f=$2} /^Buffers:/ {b=$2} /^Cached:/ {c=$2} END {print (a != "" ? a : f + b + c)}' /proc/meminfo)"
echo "disk=$(df -Pk "$D" 2>/dev/null | awk 'NR==2 {print $4}')"
${withSize ? `echo "size=$( (timeout 15 du -sk "$D" 2>/dev/null || du -sk "$D" 2>/dev/null) | cut -f1)"` : ''}
P=$(cat "$D/mcl.pid" 2>/dev/null)
if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then
  t=0; r=0
  for f in /proc/[0-9]*/stat; do
    read -r l < "$f" 2>/dev/null || continue
    set -- \${l##*") "}
    [ "$3" = "$P" ] || continue
    t=$((t + \${12} + \${13})); r=$((r + \${22}))
  done
  read -r l < "/proc/$P/stat"
  set -- \${l##*") "}
  echo "proc=$t $r \${20}"
fi
`;
}

/** Скрипт удаления сервера на Linux. Удаляет только папку, где лежит mcl.json, и только остановленный сервер. */
function linuxDeleteScript(name) {
  if (!safeName(name)) throw new Error('Некорректное имя сервера');
  return `D="$HOME/mc-launcher/servers/${name}"
[ -f "$D/mcl.json" ] || { echo notfound; exit 5; }
if [ -f "$D/mcl.pid" ] && kill -0 "$(cat "$D/mcl.pid")" 2>/dev/null; then echo running; exit 4; fi
rm -rf -- "$D" && echo deleted
`;
}

/** Ответ скрипта замера «ключ=значение» → объект. */
function parseKv(text) {
  const res = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) res[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return res;
}

/**
 * Сырой замер → числа в одних единицах (секунды, байты):
 * { wall, procCpu, procMem, age, ncpu, sysBusy, sysTotal, sysCpu, memTotal, memFree, disk, size, running }
 * На Linux загрузку всей системы считаем по разнице двух замеров (busy/total), на Windows она приходит готовой (sysCpu).
 */
function parseStats(text) {
  const kv = parseKv(text);
  if (kv.nodir) throw new Error('Сервер на VPS не найден');
  const num = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const s = {
    ncpu: Math.max(1, num(kv.ncpu) || 1),
    memTotal: num(kv.mem) !== null ? num(kv.mem) * 1024 : null,
    memFree: num(kv.memfree) !== null ? num(kv.memfree) * 1024 : null,
    disk: num(kv.disk) !== null ? num(kv.disk) * 1024 : null,
    size: num(kv.size) !== null ? num(kv.size) * 1024 : null,
    running: false,
    procCpu: null,
    procMem: null,
    age: null,
    sysCpu: null,
    sysBusy: null,
    sysTotal: null,
  };
  if (kv.now !== undefined) {
    // Windows: время в тиках по 100 нс, память в байтах.
    s.wall = num(kv.now) / 1e7;
    s.sysCpu = num(kv.syscpu);
    if (kv.wproc) {
      const [t, b, age] = kv.wproc.split(/\s+/).map(Number);
      Object.assign(s, { running: true, procCpu: t / 1e7, procMem: b, age });
    }
  } else {
    const clk = num(kv.clk) || 100;
    const page = num(kv.page) || 4096;
    s.wall = num(kv.up);
    if (kv.cpu) {
      const f = kv.cpu.split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
      // user nice system idle iowait irq softirq steal …; guest уже входит в user.
      const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
      const idle = (f[3] || 0) + (f[4] || 0);
      s.sysTotal = total;
      s.sysBusy = total - idle;
    }
    if (kv.proc) {
      const [t, r, start] = kv.proc.split(/\s+/).map(Number);
      Object.assign(s, { running: true, procCpu: t / clk, procMem: r * page, age: s.wall !== null ? Math.max(0, s.wall - start / clk) : null });
    }
  }
  return s;
}

/** Два замера подряд → проценты загрузки. prev может быть null (первый замер — без процессора). */
function computeLoad(prev, cur) {
  const res = { cpu: null, sysCpu: cur.sysCpu };
  if (!prev || prev.wall === null || cur.wall === null) return res;
  const dt = cur.wall - prev.wall;
  if (!(dt > 0.2)) return res;
  if (cur.running && prev.running && cur.procCpu !== null && prev.procCpu !== null && cur.procCpu >= prev.procCpu) {
    res.cpu = Math.min(100, Math.round(((cur.procCpu - prev.procCpu) / dt / cur.ncpu) * 1000) / 10);
  }
  if (res.sysCpu === null && cur.sysTotal !== null && prev.sysTotal !== null && cur.sysTotal > prev.sysTotal) {
    res.sysCpu = Math.round(((cur.sysBusy - prev.sysBusy) / (cur.sysTotal - prev.sysTotal)) * 1000) / 10;
  }
  if (res.sysCpu !== null) res.sysCpu = Math.max(0, Math.min(100, res.sysCpu));
  return res;
}

module.exports = {
  safeName,
  parseProps,
  validateProps,
  patchProps,
  escapeValue,
  unescapeValue,
  linuxStatsScript,
  linuxDeleteScript,
  parseStats,
  computeLoad,
  parseKv,
};
