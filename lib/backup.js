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
};

const DEFAULTS = {
  backup: { beforeStart: true, everyHours: 0, keep: 5 },
  restart: { enabled: false, time: '05:00', onCrash: true },
  net: { upnp: false },
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
    net: { ...DEFAULTS.net, ...(s.net || {}) },
    discord: { ...DEFAULTS.discord, ...(s.discord || {}) },
    name: typeof s.name === 'string' ? s.name : '',
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
  const d = { ...cur.discord, ...(input.discord || {}) };
  d.url = String(d.url || '').trim();
  if (d.url && !WEBHOOK_RE.test(d.url)) throw new Error('Это не похоже на адрес вебхука Discord (https://discord.com/api/webhooks/…)');
  const next = {
    backup: { beforeStart: b.beforeStart ?? cur.backup.beforeStart, everyHours: hours, keep },
    restart: { enabled: !!(r.enabled ?? cur.restart.enabled), time, onCrash: !!(r.onCrash ?? cur.restart.onCrash) },
    net: { upnp: !!((input.net || {}).upnp ?? cur.net.upnp) },
    discord: { url: d.url, start: !!d.start, players: !!d.players, crash: !!d.crash },
    name,
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
  const file = `${stamp()}_${REASONS[reason] ? reason : 'manual'}.tar.gz`;
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

module.exports = { readSettings, writeSettings, list, create, restore, backupPath, worldDirs, REASONS };
