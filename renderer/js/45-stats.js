// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- мониторинг ресурсов ----

const STATS_POINTS = 150; // 150 замеров × 2 с = 5 минут
const statsHist = { cpu: [], mem: [] };

function formatUptime(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'меньше минуты';
  const h = Math.floor(min / 60);
  return h ? `${h} ч ${String(min % 60).padStart(2, '0')} мин` : `${min} мин`;
}
const gb = (mb) => (mb / 1024).toFixed(1).replace('.', ',');

function drawStatsChart() {
  const c = $('st-chart');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== w * dpr) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  // Сетка: 50%
  g.strokeStyle = css.getPropertyValue('--line').trim() || '#e4e0d8';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, Math.round(h / 2) + 0.5);
  g.lineTo(w, Math.round(h / 2) + 0.5);
  g.stroke();
  const line = (arr, color) => {
    if (arr.length < 2) return;
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    arr.forEach((v, i) => {
      const x = w - (arr.length - 1 - i) * (w / (STATS_POINTS - 1));
      const y = h - 2 - (Math.min(100, v) / 100) * (h - 4);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
  };
  line(statsHist.mem, css.getPropertyValue('--chart-2').trim() || '#9a6bd6');
  line(statsHist.cpu, css.getPropertyValue('--accent').trim() || '#2f5bea');
}

api.on('stats', (s) => {
  statsHist.cpu.push(s.cpu);
  statsHist.mem.push(s.ramGb ? (s.memMb / (s.ramGb * 1024)) * 100 : 0);
  for (const k of ['cpu', 'mem']) if (statsHist[k].length > STATS_POINTS) statsHist[k].shift();
  $('stats').hidden = false;
  const cpu = $('st-cpu');
  cpu.textContent = `${String(s.cpu).replace('.', ',')}%`;
  cpu.className = s.cpu > 85 ? 'bad' : s.cpu > 60 ? 'warn' : '';
  const mem = $('st-mem');
  mem.textContent = `${gb(s.memMb)} из ${s.ramGb} ГБ`;
  // Java занимает чуть больше выделенного (сама JVM), тревожно — только когда упёрлись в предел.
  mem.className = s.memMb > s.ramGb * 1024 * 1.05 ? 'warn' : '';
  const sys = $('st-sys');
  sys.textContent = `${gb(s.sysFreeMb)} ГБ`;
  sys.className = s.sysFreeMb < 1024 ? 'bad' : s.sysFreeMb < 2048 ? 'warn' : '';
  $('st-players').textContent = String(s.players);
  $('st-uptime').textContent = formatUptime(s.uptime);
  $('st-chart').title = 'Зелёная линия — процессор, голубая — память сервера (за последние 5 минут)';
  drawStatsChart();
});

api.on('state', ({ state: st }) => {
  if (st === 'stopped' || st === 'starting') {
    statsHist.cpu = [];
    statsHist.mem = [];
    $('stats').hidden = true;
  }
});
