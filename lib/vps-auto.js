'use strict';
// Фоновые задачи на VPS: автозапуск и перезапуск после падения, расписание перезапусков и бэкапов,
// история нагрузки, события для уведомлений и Discord. Работу делает скрипт mcl-tick.sh (Linux, cron)
// или mcl-tick.ps1 (Windows, Планировщик заданий) — тексты лежат в lib/vps-scripts.
// Здесь только чистые функции: подготовка скриптов, проверка настроек, разбор ответов.
const fs = require('fs');
const path = require('path');

const TICK_VERSION = 1;
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const BACKUP_RE = /^[A-Za-z0-9._-]{1,64}-\d{8}-\d{6}-(auto|manual|before-restore)\.tar\.gz$/;

// Тексты для Discord и чата. {0}, {1} — переменные скрипта (имена — ниже, для каждой системы свои).
const MESSAGES = {
  CRASH: ['Сервер «{0}» упал (код {1}) — запускаю заново', 'NM', 'CODE'],
  CRASHED: ['Сервер «{0}» упал (код {1})', 'NM', 'CODE'],
  BOOT: ['VPS перезагрузился — сервер «{0}» запускается', 'NM'],
  GAVEUP: ['Сервер «{0}» падает при каждом запуске — автоперезапуск остановлен. Загляните в консоль.', 'NM'],
  SCHED: ['Сервер «{0}» перезапущен по расписанию', 'NM'],
  WARN: ['Сервер перезапустится через {0} мин.', 'MIN'],
  NOW: ['Перезапуск сервера…'],
  BACKUP: ['Бэкап сервера «{0}» готов ({1} МБ)', 'NM', 'MB'],
  BACKUPFAIL: ['Не удалось сделать бэкап сервера «{0}»', 'NM'],
  DISK: ['На VPS осталось мало места: {0} МБ (сервер «{1}»)', 'FREE', 'NM'],
  JOIN: ['{0} зашёл на сервер «{1}»', 'W', 'NM'],
  LEAVE: ['{0} вышел с сервера «{1}»', 'W', 'NM'],
};
const SH_VARS = { NM: '${NM}', CODE: '${CODE}', MIN: '${MIN}', MB: '${MB}', FREE: '${FREE}', W: '${W}' };
const PS_VARS = { NM: '$($NM)', CODE: '$($CodeT)', MIN: '$($Min)', MB: '$($Mb)', FREE: '$($Free)', W: '$($W)' };

/** Текст для вставки в строку скрипта: без кавычек, обратной косой черты и знаков подстановки. */
const scrub = (s) => String(s).replace(/["\\`$|]/g, '').replace(/[\r\n]+/g, ' ');

/** Текст скрипта mcl-tick для системы VPS; tr — перевод сообщений (русский по умолчанию). */
function tickScript(platform, tr = (s) => s, lang = 'ru') {
  const isWin = platform === 'windows';
  const file = path.join(__dirname, 'vps-scripts', isWin ? 'mcl-tick.ps1' : 'mcl-tick.sh');
  const vars = isWin ? PS_VARS : SH_VARS;
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  text = text.replace('__VERSION__', tickVersion(lang));
  for (const [key, [ru, ...names]] of Object.entries(MESSAGES)) {
    const msg = scrub(tr(ru)).replace(/\{(\d)\}/g, (m, i) => (names[i] ? vars[names[i]] : ''));
    text = text.split(`__T_${key}__`).join(msg);
  }
  return isWin ? text.replace(/\n/g, '\r\n') : text;
}
const tickVersion = (lang) => `${TICK_VERSION}-${lang === 'en' ? 'en' : 'ru'}`;

/** Версия установленного скрипта по его тексту (null — не установлен или не наш). */
function installedVersion(text) {
  const m = String(text || '').match(/mcl-tick-version: (\S+)/);
  return m ? m[1] : null;
}

/** Linux: строки cron — раз в минуту и после перезагрузки. */
function linuxInstallScript() {
  return `command -v crontab >/dev/null 2>&1 || { echo nocron; exit 6; }
chmod 755 "$HOME/mc-launcher/mcl-tick.sh" 2>/dev/null
L1='* * * * * sh "$HOME/mc-launcher/mcl-tick.sh" tick >/dev/null 2>&1'
L2='@reboot sleep 30 && sh "$HOME/mc-launcher/mcl-tick.sh" tick >/dev/null 2>&1'
cur=$(crontab -l 2>/dev/null | grep -v 'mc-launcher/mcl-tick.sh')
{ [ -n "$cur" ] && printf '%s\\n' "$cur"; echo "$L1"; echo "$L2"; } | crontab - || { echo cronfail; exit 7; }
if command -v pgrep >/dev/null 2>&1 && ! pgrep -x cron >/dev/null 2>&1 && ! pgrep -x crond >/dev/null 2>&1 && ! pgrep -f cronie >/dev/null 2>&1; then echo nocrond; fi
echo installed
`;
}

/** Windows: задание Планировщика от имени этого пользователя, работает и без входа в систему. */
function windowsInstallScript() {
  return `$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$B = Join-Path $env:USERPROFILE 'mc-launcher'
$tick = Join-Path $B 'mcl-tick.ps1'
$arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $tick + '" -Mode tick'
try {
  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $B
  $t1 = New-ScheduledTaskTrigger -AtStartup
  $t2 = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
  $s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName 'Blockhost mc-launcher' -Action $a -Trigger @($t1, $t2) -Principal $p -Settings $s -Force | Out-Null
  'installed'
} catch {
  "taskfail=$($_.Exception.Message)"
  exit 7
}
`;
}

// ---- настройки (mcl.conf) ----

const DEFAULT_CONF = { auto: false, restart: '', warn: 5, backup: '', keep: 7, discord: '', dcrash: true, dbackup: false, djoin: false, ddisk: true };

/** Время «ЧЧ:ММ», сдвинутое на minutes (через полночь — по кругу). */
function shiftTime(hhmm, minutes) {
  const m = String(hhmm || '').match(TIME_RE);
  if (!m) return '';
  const t = (((Number(m[1]) * 60 + Number(m[2]) + Math.round(minutes)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Проверить настройки из окна; время — уже по UTC. */
function validateConf(input) {
  const c = { ...DEFAULT_CONF };
  const src = input || {};
  for (const k of ['auto', 'dcrash', 'dbackup', 'djoin', 'ddisk']) if (k in src) c[k] = !!src[k];
  for (const k of ['restart', 'backup']) {
    const v = String(src[k] ?? '').trim();
    if (v && !TIME_RE.test(v)) throw new Error('Время — в виде ЧЧ:ММ, например 05:00');
    c[k] = v;
  }
  const int = (k, min, max, label) => {
    if (!(k in src)) return;
    const n = Number(src[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} — от ${min} до ${max}`);
    c[k] = n;
  };
  int('warn', 0, 30, 'Предупреждение, минут');
  int('keep', 1, 60, 'Сколько бэкапов хранить');
  const url = String(src.discord ?? '').trim();
  if (url && !WEBHOOK_RE.test(url)) throw new Error('Это не похоже на адрес вебхука Discord (https://discord.com/api/webhooks/…)');
  c.discord = url;
  return c;
}

function confText(c) {
  const b = (v) => (v ? '1' : '0');
  return [
    '# Настройки фоновых задач. Создано программой «Блокхост» — меняйте в лаунчере.',
    `auto=${b(c.auto)}`,
    `restart=${c.restart}`,
    `warn=${c.warn}`,
    `backup=${c.backup}`,
    `keep=${c.keep}`,
    `discord=${c.discord}`,
    `dcrash=${b(c.dcrash)}`,
    `dbackup=${b(c.dbackup)}`,
    `djoin=${b(c.djoin)}`,
    `ddisk=${b(c.ddisk)}`,
    '',
  ].join('\n');
}

function parseConf(text) {
  const kv = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([a-z]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  const c = { ...DEFAULT_CONF };
  for (const k of ['auto', 'dcrash', 'dbackup', 'djoin', 'ddisk']) if (k in kv) c[k] = kv[k] === '1';
  for (const k of ['restart', 'backup']) if (TIME_RE.test(kv[k] || '')) c[k] = kv[k];
  if (/^\d+$/.test(kv.warn || '')) c.warn = Math.min(30, Number(kv.warn));
  if (/^\d+$/.test(kv.keep || '')) c.keep = Math.max(1, Math.min(60, Number(kv.keep)));
  if (WEBHOOK_RE.test(kv.discord || '')) c.discord = kv.discord;
  return c;
}

// ---- события и история ----

const EVENT_KINDS = new Set(['crash', 'crashed', 'boot', 'gaveup', 'sched', 'backup', 'backupfail', 'disk', 'join', 'leave', 'noeula']);

/** mcl-events.log → [{ ts, kind, server, arg }] (ts — секунды). */
function parseEvents(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^(\d{9,11}) ([a-z]+) ([A-Za-z0-9._-]{1,64})(?: (\S{1,40}))?\s*$/);
    if (m && EVENT_KINDS.has(m[2])) out.push({ ts: Number(m[1]), kind: m[2], server: m[3], arg: m[4] || '' });
  }
  return out;
}

/**
 * mcl-stats.log → точки по минутам: { t (мс), cpu, sysCpu, mem, sysUsed, total, players }.
 * Процессор считается по разнице соседних строк; ncpu — число ядер VPS.
 */
function parseHistory(text, ncpu = 1) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^\d{9,11}$/.test(f[0])) continue;
    const n = (v) => (v === '-' || v === '' || !/^-?\d+(\.\d+)?$/.test(v) ? null : Number(v));
    rows.push({ ts: Number(f[0]), pc: n(f[1]), pr: n(f[2]), a: n(f[3]), b: n(f[4]), mt: n(f[5]), mf: n(f[6]), cn: n(f[7]), nc: n(f[8] || '') });
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const p = rows[i - 1];
    const dt = p ? r.ts - p.ts : 0;
    const cores = Math.max(1, r.nc || Number(ncpu) || 1);
    let cpu = null;
    if (p && dt > 0 && dt < 600 && r.pc !== null && p.pc !== null && r.pc >= p.pc) cpu = Math.min(100, Math.round(((r.pc - p.pc) / 100 / dt / cores) * 1000) / 10);
    let sysCpu = null;
    if (r.b === -1) sysCpu = r.a; // Windows: готовые проценты
    else if (p && p.b !== null && r.b !== null && r.b > p.b && dt < 600) sysCpu = Math.round(((r.a - p.a) / (r.b - p.b)) * 1000) / 10;
    if (sysCpu !== null) sysCpu = Math.max(0, Math.min(100, sysCpu));
    out.push({
      t: r.ts * 1000,
      cpu,
      sysCpu,
      mem: r.pr,
      sysUsed: r.mt !== null && r.mf !== null ? (r.mt - r.mf) * 1024 : null,
      total: r.mt !== null ? r.mt * 1024 : null,
      players: r.cn,
    });
  }
  return out;
}

/**
 * Сжать точки до count отрезков от from до to (мс): среднее по отрезку; пустой отрезок — null (разрыв).
 * players — максимум за отрезок: так виден пик.
 */
function bucket(points, from, to, count) {
  const step = (to - from) / count;
  const res = [];
  const keys = ['cpu', 'sysCpu', 'mem', 'sysUsed', 'total'];
  for (let i = 0; i < count; i++) res.push({ t: from + step * (i + 1), n: {}, s: {}, players: null });
  for (const p of points) {
    if (p.t <= from || p.t > to) continue;
    const i = Math.min(count - 1, Math.floor((p.t - from) / step));
    const b = res[i];
    for (const k of keys) {
      if (p[k] === null || p[k] === undefined) continue;
      b.s[k] = (b.s[k] || 0) + p[k];
      b.n[k] = (b.n[k] || 0) + 1;
    }
    if (p.players !== null && p.players !== undefined) b.players = Math.max(b.players ?? 0, p.players);
  }
  return res.map((b) => {
    const o = { t: b.t, players: b.players };
    for (const k of keys) o[k] = b.n[k] ? b.s[k] / b.n[k] : null;
    return o;
  });
}

// ---- перенос между VPS: аргументы запуска из mcl-start ----

/** Аргументы запуска сервера (после настроек памяти и кодировки, до nogui) из скрипта mcl-start. */
function parseStartArgs(text, platform) {
  const t = String(text || '');
  if (platform === 'windows') {
    const m = t.match(/-Dstderr\.encoding=UTF-8 (.*?) nogui/);
    if (!m) return null;
    return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  }
  const m = t.match(/-Dstderr\.encoding=UTF-8 (.*?) nogui >>/);
  if (!m) return null;
  const args = [];
  const re = /'((?:[^']|'\\'')*)'/g;
  let x;
  while ((x = re.exec(m[1]))) args.push(x[1].replace(/'\\''/g, "'"));
  return args;
}

/** Аргументы для другой системы: у Forge/NeoForge файлы unix_args.txt и win_args.txt. */
function argsFor(args, platform) {
  return (args || []).map((a) => (platform === 'windows' ? a.replace(/unix_args\.txt$/, 'win_args.txt') : a.replace(/win_args\.txt$/, 'unix_args.txt')));
}

// ---- файлы сервера ----

// Служебные файлы лаунчера: их не удаляем и не правим из окна «Файлы».
const PROTECTED = /^(mcl\.json|mcl\.conf|mcl\.pid|mcl\.want|mcl-start\.(sh|ps1)|mcl-tick\.(sh|ps1)|console\.in)$/;

/** Путь внутри папки сервера: «a/b/c» без «..», абсолютных путей и странных символов. '' — сама папка. */
function safeRel(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s) return '';
  if (s.length > 400) throw new Error('Слишком длинный путь');
  const parts = s.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || /[\x00-\x1f:*?"<>|]/.test(p)) throw new Error('Некорректный путь');
  }
  return parts.join('/');
}

/** Имя нового файла или папки (без «/»). */
function safeEntryName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 120 || s === '.' || s === '..' || /[\x00-\x1f/\\:*?"<>|]/.test(s)) throw new Error('Имя может содержать любые буквы и цифры, но не / \\ : * ? " < > |');
  return s;
}

const isProtected = (rel) => !rel.includes('/') && PROTECTED.test(rel);

module.exports = {
  TICK_VERSION,
  WEBHOOK_RE,
  BACKUP_RE,
  MESSAGES,
  tickScript,
  tickVersion,
  installedVersion,
  linuxInstallScript,
  windowsInstallScript,
  DEFAULT_CONF,
  shiftTime,
  validateConf,
  confText,
  parseConf,
  parseEvents,
  parseHistory,
  bucket,
  parseStartArgs,
  argsFor,
  safeRel,
  safeEntryName,
  isProtected,
};
