// Старые журналы (logs/*.log, *.log.gz) и отчёты о сбоях (crash-reports), автоочистка.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LOG_RE = /^[\w.-]+\.log(\.gz)?$/;
const CRASH_RE = /^crash-[\w.-]+\.txt$/;
const MAX_READ = 8 * 1024 * 1024;

function listDir(dir, re, kind) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => re.test(n));
  } catch {
    return [];
  }
  return names.map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { kind, name, size: st.size, mtime: st.mtimeMs };
  });
}

/** Журналы и отчёты о сбоях сервера, новые сверху. */
function list(serverDir) {
  return [
    ...listDir(path.join(serverDir, 'crash-reports'), CRASH_RE, 'crash'),
    ...listDir(path.join(serverDir, 'logs'), LOG_RE, 'log'),
  ].sort((a, b) => b.mtime - a.mtime);
}

function filePath(serverDir, kind, name) {
  const re = kind === 'crash' ? CRASH_RE : LOG_RE;
  if (!re.test(String(name))) throw new Error('Некорректное имя файла');
  return path.join(serverDir, kind === 'crash' ? 'crash-reports' : 'logs', name);
}

/** Текст журнала (архивы .gz распаковываются). */
function read(serverDir, kind, name) {
  const p = filePath(serverDir, kind, name);
  let buf = fs.readFileSync(p);
  if (name.endsWith('.gz')) buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_READ });
  if (buf.length > MAX_READ) buf = buf.subarray(buf.length - MAX_READ);
  return buf.toString('utf8');
}

/** Удалить журналы и отчёты старше days дней. latest.log не трогаем. Возвращает { files, bytes }. */
function clean(serverDir, days) {
  const limit = Date.now() - Math.max(1, days) * 86400000;
  let files = 0;
  let bytes = 0;
  for (const item of list(serverDir)) {
    if (item.name === 'latest.log' || item.mtime > limit) continue;
    try {
      fs.rmSync(filePath(serverDir, item.kind, item.name), { force: true });
      files++;
      bytes += item.size;
    } catch {
      /* занят — пропускаем */
    }
  }
  return { files, bytes };
}

module.exports = { list, read, clean };
