// Мини-окно поверх всех окон: состояние сервера и главные кнопки.
const $ = (id) => document.getElementById(id);
const TEXT = { stopped: 'Выключен', starting: 'Запускается…', running: 'Работает', stopping: 'Останавливается…' };
let st = 'stopped';
let canStart = false;

function render() {
  $('w-state').dataset.state = st;
  $('w-state').textContent = TEXT[st] || st;
  $('w-start').disabled = st !== 'stopped' || !canStart;
  $('w-stop').disabled = st === 'stopped' || st === 'stopping';
  if (st === 'stopped') {
    $('w-players').textContent = '—';
    $('w-tps').textContent = '—';
    $('w-mem').textContent = '—';
  }
}
async function refresh() {
  try {
    const i = await window.launcher.call('widget:info');
    st = i.state;
    canStart = i.canStart;
    if (i.title) $('w-title').textContent = i.title;
    if (st !== 'stopped') $('w-players').textContent = `${i.players} из ${i.max}`;
  } catch {
    /* окно лаунчера ещё загружается */
  }
  render();
}
window.launcher.on('state', () => refresh());
window.launcher.on('players', (p) => {
  $('w-players').textContent = p.running ? `${p.online.length} из ${p.max}` : '—';
});
window.launcher.on('stats', (s) => {
  const el = $('w-tps');
  if (s.tps) {
    const t = s.tps.tps;
    el.textContent = String(Math.round(t * 10) / 10).replace('.', ',');
    el.className = t < 15 ? 'bad' : t < 18.5 ? 'warn' : '';
  }
  $('w-mem').textContent = `${(s.memMb / 1024).toFixed(1).replace('.', ',')} ГБ`;
  $('w-players').textContent = `${s.players}`;
});
$('w-start').addEventListener('click', () => window.launcher.call('widget:start').catch(() => window.launcher.call('widget:main')));
$('w-stop').addEventListener('click', () => window.launcher.call('server:stop').catch(() => {}));
$('w-main').addEventListener('click', () => window.launcher.call('widget:main'));
$('w-close').addEventListener('click', () => window.launcher.call('widget:close'));
refresh();
