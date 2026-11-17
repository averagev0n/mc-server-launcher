// Мониторинг ресурсов сервера: загрузка процессора и память процесса Java.
// На Windows один фоновый PowerShell раз в 2 секунды печатает время процессора и память процесса —
// это дешевле, чем запускать отдельную команду на каждый замер.
const os = require('os');
const { spawn } = require('child_process');

/** Начать замеры процесса pid. onSample({ cpu, memMb, sysFreeMb, sysTotalMb }). Возвращает stop(). */
function startMonitor(pid, onSample) {
  if (!Number.isInteger(pid)) return () => {};
  if (process.platform === 'linux') return startProcMonitor(pid, onSample);
  if (process.platform !== 'win32') return () => {};
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    'while ($p -and -not $p.HasExited) { $p.Refresh(); ' +
    // Время замера берём здесь же, а не по приходу строки: строки могут прийти пачкой.
    '[Console]::Out.WriteLine(("{0} {1} {2}" -f [long]$p.TotalProcessorTime.TotalMilliseconds, $p.WorkingSet64, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())); ' +
    'Start-Sleep -Seconds 2 }';
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const cores = os.cpus().length || 1;
  let prev = null;
  let buf = '';
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) {
      const m = l.trim().match(/^(\d+) (\d+) (\d+)$/);
      if (!m) continue;
      const now = Number(m[3]);
      const cpuMs = Number(m[1]);
      if (prev && now - prev.at < 500) continue;
      let cpu = null;
      if (prev) cpu = Math.max(0, Math.min(100, ((cpuMs - prev.cpuMs) / (now - prev.at) / cores) * 100));
      prev = { cpuMs, at: now };
      if (cpu === null) continue;
      onSample({
        cpu: Math.round(cpu * 10) / 10,
        memMb: Math.round(Number(m[2]) / 1024 / 1024),
        sysFreeMb: Math.round(os.freemem() / 1024 / 1024),
        sysTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      });
    }
  });
  ps.on('error', () => {});
  return () => {
    try {
      ps.kill();
    } catch {
      /* уже завершён */
    }
  };
}

// Linux: /proc/<pid>/stat (время процессора в тиках) и /proc/<pid>/status (VmRSS) раз в 2 секунды.
const fs = require('fs');
const TICKS = 100; // USER_HZ почти везде 100

/** Время процессора процесса в мс из строки /proc/<pid>/stat (поля 14 и 15 после имени в скобках). */
function procCpuMs(statText) {
  const rest = String(statText).slice(String(statText).lastIndexOf(')') + 2).split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? ((utime + stime) * 1000) / TICKS : null;
}
function procRssMb(statusText) {
  const m = /VmRSS:\s+(\d+)\s+kB/.exec(String(statusText));
  return m ? Math.round(Number(m[1]) / 1024) : null;
}
function startProcMonitor(pid, onSample) {
  const cores = os.cpus().length || 1;
  let prev = null;
  const timer = setInterval(() => {
    let cpuMs;
    let memMb;
    try {
      cpuMs = procCpuMs(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      memMb = procRssMb(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    } catch {
      clearInterval(timer); // процесс завершился
      return;
    }
    const now = Date.now();
    if (cpuMs === null) return;
    if (prev) {
      const cpu = Math.max(0, Math.min(100, ((cpuMs - prev.cpuMs) / (now - prev.at) / cores) * 100));
      onSample({
        cpu: Math.round(cpu * 10) / 10,
        memMb: memMb || 0,
        sysFreeMb: Math.round(os.freemem() / 1024 / 1024),
        sysTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      });
    }
    prev = { cpuMs, at: now };
  }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startMonitor, procCpuMs, procRssMb };
