// Резервные копии мира и настройки обслуживания сервера (копии, перезапуск по расписанию).
//
// Копии — архивы .tar.gz в папке backups/ внутри папки сервера. В архив попадают папки мира:
// основной мир и, если есть, отдельные папки Нижнего мира и Края (так их хранят Paper и гибриды).
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const { readProps } = require('./core');

const SETTINGS_FILE = 'mcl-settings.json';
const NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z-]+\.tar\.gz$/;
const REASONS = {
  manual: 'вручную',
  auto: 'перед запуском',
  schedule: 'по расписанию',
  'before-restore': 'перед восстановлением',
  'before-pack': 'перед установкой сборки',
  'before-import': 'перед заменой мира',
  'before-newworld': 'перед новым миром',
  'before-modtest': 'перед поиском сломанного мода',
  'before-update': 'перед обновлением ядра',
};

const DEFAULTS = {
  backup: { beforeStart: true, everyHours: 0, keep: 5, mirror: '' },
  restart: { enabled: false, time: '05:00', onCrash: true },
  sleep: { enabled: false, minutes: 15 },
  net: { upnp: false },
  jvm: { aikar: true },
  clean: { enabled: true, days: 14 },
  messages: { welcome: '', list: [] },
  discord: { url: '', start: true, players: true, crash: true },
};
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

// ---- настройки обслуживания ----

function readSettings(dir) {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) || {};
  } catch {
    /* по умолчанию */
  }
  return {
    backup: { ...DEFAULTS.backup, ...(s.backup || {}) },
    restart: { ...DEFAULTS.restart, ...(s.restart || {}) },
    sleep: { ...DEFAULTS.sleep, ...(s.sleep || {}) },
    net: { ...DEFAULTS.net, ...(s.net || {}) },
    jvm: { ...DEFAULTS.jvm, ...(s.jvm || {}) },
    clean: { ...DEFAULTS.clean, ...(s.clean || {}) },
    messages: { ...DEFAULTS.messages, ...(s.messages || {}) },
    discord: { ...DEFAULTS.discord, ...(s.discord || {}) },
    gamerules: s.gamerules && typeof s.gamerules === 'object' ? s.gamerules : {},
    tunnel: { address: '', auto: false, ...(s.tunnel || {}) },
    name: typeof s.name === 'string' ? s.name : '',
    power: { ...require('./power').DEFAULTS, ...(s.power || {}) },
    achievements: s.achievements !== false,
  };
}

/** Сообщения по расписанию: до 10 штук, интервал 5–1440 минут, текст до 200 символов без переводов строк. */
function cleanMessages(m) {
  const text = (v, max) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const list = Array.isArray(m.list) ? m.list : [];
  if (list.length > 10) throw new Error('Не больше 10 сообщений по расписанию');
  return {
    welcome: text(m.welcome, 200),
    list: list
      .map((x) => ({ every: Number(x.every), text: text(x.text, 200) }))
      .filter((x) => x.text)
      .map((x) => {
        if (!Number.isInteger(x.every) || x.every < 5 || x.every > 1440) throw new Error('Интервал сообщений — от 5 до 1440 минут');
        return x;
      }),
  };
}

function writeSettings(dir, input) {
  const cur = readSettings(dir);
  const b = input.backup || {};
  const r = input.restart || {};
  const hours = Number(b.everyHours ?? cur.backup.everyHours);
  const keep = Number(b.keep ?? cur.backup.keep);
  const time = String(r.time ?? cur.restart.time);
  if (![0, 1, 2, 3, 6, 12, 24].includes(hours)) throw new Error('Некорректный интервал копий');
  if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw new Error('Хранить можно от 1 до 100 копий');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Время перезапуска — в формате ЧЧ:ММ');
  let name = input.name === undefined ? cur.name : String(input.name).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length > 60) throw new Error('Название — не длиннее 60 символов');
  let mirror = b.mirror === undefined ? cur.backup.mirror : String(b.mirror || '').trim();
  if (mirror && !path.isAbsolute(mirror)) throw new Error('Папка для копий указана неверно');
  const rules = input.gamerules === undefined ? cur.gamerules : require('./gamerules').clean(input.gamerules);
  const tn = { ...cur.tunnel, ...(input.tunnel || {}) };
  tn.address = String(tn.address || '').trim().toLowerCase();
  if (tn.address && (tn.address.length > 120 || !/^[a-z0-9.-]+.[a-z]{2,}(:d{1,5})?$/.test(tn.address))) {
    throw new Error('Адрес туннеля — вида name.joinmc.link или 123.ply.gg:12345');
  }
  const sl = { ...cur.sleep, ...(input.sleep || {}) };
  const sleepMin = Number(sl.minutes);
  if (![5, 10, 15, 30, 60].includes(sleepMin)) throw new Error('Засыпать можно через 5, 10, 15, 30 или 60 минут');
  const cl = { ...cur.clean, ...(input.clean || {}) };
  const days = Number(cl.days);
  if (![3, 7, 14, 30, 90].includes(days)) throw new Error('Хранить журналы можно 3, 7, 14, 30 или 90 дней');
  const msg = input.messages === undefined ? cur.messages : cleanMessages(input.messages);
  const d = { ...cur.discord, ...(input.discord || {}) };
  d.url = String(d.url || '').trim();
  if (d.url && !WEBHOOK_RE.test(d.url)) throw new Error('Это не похоже на адрес вебхука Discord (https://discord.com/api/webhooks/…)');
  const next = {
    backup: { beforeStart: b.beforeStart ?? cur.backup.beforeStart, everyHours: hours, keep, mirror },
    gamerules: rules,
    tunnel: { address: tn.address, auto: !!tn.auto },
    restart: { enabled: !!(r.enabled ?? cur.restart.enabled), time, onCrash: !!(r.onCrash ?? cur.restart.onCrash) },
    sleep: { enabled: !!sl.enabled, minutes: sleepMin },
    net: { upnp: !!((input.net || {}).upnp ?? cur.net.upnp) },
    jvm: { aikar: !!((input.jvm || {}).aikar ?? cur.jvm.aikar) },
    clean: { enabled: !!cl.enabled, days },
    messages: msg,
    discord: { url: d.url, start: !!d.start, players: !!d.players, crash: !!d.crash },
    name,
    power: input.power === undefined ? cur.power : require('./power').clean(input.power, cur.power),
    achievements: input.achievements === undefined ? cur.achievements : !!input.achievements,
  };
  next.backup.beforeStart = !!next.backup.beforeStart;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---- копии ----

/** Папки мира, которые есть на диске. */
function worldDirs(dir) {
  const level = (readProps(dir)['level-name'] || 'world').trim() || 'world';
  if (!/^[^\\/:*?"<>|]+$/.test(level) || level === '..' || level === '.') return [];
  return [level, `${level}_nether`, `${level}_the_end`].filter((d) => {
    try {
      return fs.statSync(path.join(dir, d)).isDirectory();
    } catch {
      return false;
    }
  });
}

const backupsDir = (dir) => path.join(dir, 'backups');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function list(dir) {
  let files = [];
  try {
    files = fs.readdirSync(backupsDir(dir)).filter((f) => NAME_RE.test(f));
  } catch {
    return [];
  }
  return files
    .map((file) => {
      const m = file.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_([a-z-]+)\.tar\.gz$/);
      const st = fs.statSync(path.join(backupsDir(dir), file));
      return {
        file,
        size: st.size,
        date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString(),
        reason: m[7],
        label: REASONS[m[7]] || m[7],
      };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
}

/** Удалить лишние автоматические копии (сделанные вручную не трогаем). */
function prune(dir, keep) {
  const auto = list(dir).filter((b) => b.reason === 'auto' || b.reason === 'schedule');
  for (const b of auto.slice(keep)) fs.rmSync(path.join(backupsDir(dir), b.file), { force: true });
}

/**
 * Сделать копию мира. Возвращает { file, size } или null, если мира ещё нет.
 * Пока сервер работает, вызывать между save-off/save-all и save-on (это делает main.js).
 */
async function create(dir, reason = 'manual') {
  const worlds = worldDirs(dir);
  if (!worlds.length) return null;
  fs.mkdirSync(backupsDir(dir), { recursive: true });
  // Две копии в одну секунду получили бы одно имя, и вторая затёрла бы первую — сдвигаем время в имени.
  const kind = REASONS[reason] ? reason : 'manual';
  const now = Date.now();
  let file;
  for (let i = 0; ; i++) {
    file = `${stamp(new Date(now + i * 1000))}_${kind}.tar.gz`;
    const taken = fs.readdirSync(backupsDir(dir)).some((f) => f.slice(0, 19) === file.slice(0, 19));
    if (!taken) break;
  }
  const full = path.join(backupsDir(dir), file);
  const tmp = full + '.part';
  try {
    await tar.c(
      {
        gzip: { level: 4 },
        file: tmp,
        cwd: dir,
        portable: true,
        // session.lock занят работающим сервером и в копии не нужен.
        filter: (p) => !/(^|[\\/])session\.lock$/.test(p),
      },
      worlds
    );
    fs.renameSync(tmp, full);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error('Не удалось сделать копию мира: ' + e.message);
  }
  if (reason === 'auto' || reason === 'schedule') prune(dir, readSettings(dir).backup.keep);
  return { file, size: fs.statSync(full).size };
}

/**
 * Скопировать архив ещё и в «облачную» папку (OneDrive, Яндекс.Диск…): в подпапку с именем сервера.
 * Лишние автоматические копии там удаляются так же, как и в основной папке.
 */
function mirror(dir, file, root, keep) {
  if (!root) return null;
  if (!fs.existsSync(root)) throw new Error(`Папка для копий не найдена: ${root}`);
  const target = path.join(root, path.basename(dir));
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(backupsDir(dir), file), path.join(target, file));
  const auto = fs
    .readdirSync(target)
    .filter((f) => NAME_RE.test(f) && /_(auto|schedule).tar.gz$/.test(f))
    .sort()
    .reverse();
  for (const f of auto.slice(keep)) fs.rmSync(path.join(target, f), { force: true });
  return path.join(target, file);
}

function backupPath(dir, file) {
  if (!NAME_RE.test(String(file))) throw new Error('Некорректное имя копии');
  const p = path.join(backupsDir(dir), file);
  if (!fs.existsSync(p)) throw new Error('Копия не найдена');
  return p;
}

/**
 * Восстановить мир из копии (сервер должен быть остановлен).
 * Сначала сохраняем текущий мир отдельной копией — так восстановление можно отменить.
 */
async function restore(dir, file) {
  const src = backupPath(dir, file);
  const safety = await create(dir, 'before-restore');
  const moved = [];
  const suffix = `.old-${Date.now()}`;
  try {
    // Текущие папки мира — в сторону (не удаляем, пока не распаковали копию).
    for (const w of worldDirs(dir)) {
      fs.renameSync(path.join(dir, w), path.join(dir, w + suffix));
      moved.push(w);
    }
    await tar.x({
      file: src,
      cwd: dir,
      strict: true,
      // В копии могут быть только папки мира — ничего за пределами папки сервера.
      filter: (p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'),
    });
  } catch (e) {
    // Не вышло — возвращаем всё как было.
    for (const w of moved) {
      fs.rmSync(path.join(dir, w), { recursive: true, force: true });
      fs.renameSync(path.join(dir, w + suffix), path.join(dir, w));
    }
    throw new Error('Не удалось восстановить мир: ' + e.message);
  }
  for (const w of moved) fs.rmSync(path.join(dir, w + suffix), { recursive: true, force: true });
  return { safety: safety && safety.file };
}

module.exports = { readSettings, writeSettings, list, create, restore, backupPath, worldDirs, mirror, REASONS };
