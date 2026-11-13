// Фоновые серверы: второй, третий… сервер одновременно с основным, а также прокси Velocity.
// У каждого — свой процесс, журнал последних строк, состояние, остановка командой stop.
const { spawn } = require('child_process');

const MAX_LINES = 2000;
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');

function createRunner(onEvent) {
  const procs = new Map(); // key → { key, title, proc, state, lines, port, killTimer }

  const pub = (e) => ({ key: e.key, title: e.title, state: e.state, port: e.port, kind: e.kind });
  const emit = () => onEvent('state', [...procs.values()].map(pub));

  function start({ key, title, cwd, java, args, port, kind = 'server', readyRe = /Done \(|Listening on/ }) {
    if (procs.has(key)) throw new Error('Уже запущен');
    const proc = spawn(java, args, { cwd, windowsHide: true });
    const e = { key, title, proc, state: 'starting', lines: [], port, kind, killTimer: null };
    procs.set(key, e);
    const push = (text, cls) => {
      e.lines.push(text);
      if (e.lines.length > MAX_LINES) e.lines.splice(0, e.lines.length - MAX_LINES);
      onEvent('log', { key, text, kind: cls });
      if (e.state === 'starting' && readyRe.test(text)) {
        e.state = 'running';
        emit();
      }
    };
    const pipe = (stream, cls) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const raw of parts) push(raw.replace(ANSI_RE, '').replace(/\r$/, ''), cls);
      });
    };
    pipe(proc.stdout, 'server');
    pipe(proc.stderr, 'error');
    proc.on('error', (err) => push(`Не удалось запустить Java: ${err.message}`, 'error'));
    proc.on('close', (code) => {
      clearTimeout(e.killTimer);
      push(`Остановлен (код ${code === null ? '—' : code}).`, code ? 'error' : 'info');
      procs.delete(key);
      emit();
    });
    emit();
  }

  function stop(key) {
    const e = procs.get(key);
    if (!e || e.state === 'stopping') return;
    e.state = 'stopping';
    emit();
    try {
      // У Velocity команда остановки — end, у серверов — stop.
      e.proc.stdin.write(e.kind === 'proxy' ? 'end\n' : 'stop\n');
    } catch {
      /* уже завершается */
    }
    e.killTimer = setTimeout(() => {
      try {
        e.proc.kill();
      } catch {
        /* уже завершился */
      }
    }, 60000);
  }

  function command(key, text) {
    const e = procs.get(key);
    if (!e) throw new Error('Сервер не запущен');
    e.proc.stdin.write(String(text).replace(/[\r\n]/g, ' ') + '\n');
    onEvent('log', { key, text: '> ' + text, kind: 'input' });
  }

  /** Остановить всё и дождаться завершения (при выходе из лаунчера). */
  function stopAll() {
    const waits = [...procs.values()].map(
      (e) =>
        new Promise((resolve) => {
          e.proc.once('close', resolve);
          stop(e.key);
        })
    );
    return Promise.all(waits);
  }

  return {
    start,
    stop,
    command,
    stopAll,
    list: () => [...procs.values()].map(pub),
    lines: (key) => (procs.get(key) || { lines: [] }).lines.slice(),
    has: (key) => procs.has(key),
    ports: () => [...procs.values()].map((e) => e.port).filter(Boolean),
  };
}

/** Первый свободный порт, начиная с from, которого нет в занятых. */
function freePort(used, from = 25566) {
  const set = new Set(used.map(Number));
  let p = from;
  while (set.has(p)) p++;
  return p;
}

module.exports = { createRunner, freePort };
