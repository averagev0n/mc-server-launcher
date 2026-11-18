// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- VPS: панель сервера (вкладки), графики нагрузки, настройки и удаление ----

const VS_POINTS = 360; // 360 замеров × 5 с = 30 минут
const vman = {
  cur: null, // { id, name, port } — чей сервер открыт в панели
  pane: 'stats',
  stats: null, // то же, пока открыта вкладка «Графики»
  set: null, // { id, name } — пока открыта вкладка «Настройки»
  range: 'live', // live | 24h | 7d
  long: null, // { points, from, to } — история за сутки/неделю
  timer: null,
  busy: false,
  tick: 0,
  hist: new Map(), // `${id}/${name}` → [{ cpu, sysCpu, mem, sysUsed, total, players }]
  sizes: new Map(), // `${id}/${name}` → размер папки сервера, байт
  last: null,
  props: new Map(),
  ram: 2,
};
// Ключи, у которых в настройках есть отдельное поле (остальные — в «Все параметры»).
const VSET_DEFAULTS = { motd: 'A Minecraft Server', 'max-players': '20', gamemode: 'survival', difficulty: 'easy', 'server-port': '25565', 'online-mode': 'true', pvp: 'true', 'white-list': 'false' };
// Что делает каждая вкладка при открытии и закрытии; другие части интерфейса дописывают свои.
const VPANES = {};

const vsKey = (o) => `${o.id}/${o.name}`;
const vsGb = (bytes) => (bytes / 1024 ** 3).toFixed(1).replace('.', ',');
const vpsServerOf = (name) => (vpsState.info && vpsState.info.servers.find((s) => s.name === name)) || null;

// ---- панель сервера ----

/** Открыть панель сервера s на вкладке pane. */
function openVpsPane(s, pane) {
  const v = vpsSel();
  if (!v) return;
  const same = vman.cur && vman.cur.id === v.id && vman.cur.name === s.name;
  if (!same) closeVpsMan();
  vman.cur = { id: v.id, name: s.name, port: s.port || '25565' };
  $('vps-man').hidden = false;
  $('vm-title').textContent = s.name;
  $('vm-sub').textContent = `${s.type || '?'} ${s.mc || ''} · ${v.host}${s.port && s.port !== '25565' ? ':' + s.port : ''}`;
  showVpsPane(pane || vman.pane || 'stats', !same);
  $('vps-man').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showVpsPane(pane, force) {
  if (!VPANES[pane]) pane = 'stats';
  if (vman.pane === pane && !force && !$('vps-man').hidden && vman.opened === pane) return;
  const prev = vman.opened && VPANES[vman.opened];
  if (prev && prev.canLeave && vman.opened !== pane && !prev.canLeave()) return;
  if (prev && prev.close) prev.close();
  vman.pane = pane;
  vman.opened = pane;
  for (const b of document.querySelectorAll('[data-vpane]')) b.setAttribute('aria-selected', String(b.dataset.vpane === pane));
  for (const p of document.querySelectorAll('.vm-pane')) p.hidden = p.dataset.pane !== pane;
  VPANES[pane].open(vman.cur);
}

function closeVpsMan() {
  if (vman.opened && VPANES[vman.opened] && VPANES[vman.opened].close) VPANES[vman.opened].close();
  vman.opened = null;
  vman.cur = null;
  $('vps-man').hidden = true;
}

/** Работает ли сервер, открытый в панели (по последним сведениям о VPS). */
const vmRunning = () => {
  const srv = vman.cur && vpsServerOf(vman.cur.name);
  return !!(srv && srv.running);
};

// Совместимость: кнопки строки сервера открывают нужную вкладку.
function openVpsStats(s) {
  openVpsPane(s, 'stats');
}
function openVpsSettings(s) {
  openVpsPane(s, 'set');
}
function closeVpsStats() {
  if (vman.opened === 'stats') closeVpsMan();
}
function closeVpsSettings() {
  if (vman.opened === 'set') closeVpsMan();
}

// ---- графики ----

VPANES.stats = {
  open(o) {
    vman.stats = { ...o };
    vman.tick = 0;
    vman.last = null;
    for (const id of ['vs-cpu', 'vs-mem', 'vs-players', 'vs-up', 'vs-syscpu', 'vs-sysmem', 'vs-disk', 'vs-size']) {
      $(id).textContent = '…';
      $(id).className = '';
    }
    setVsRange(vman.range, true);
    clearInterval(vman.timer);
    vman.timer = setInterval(pollVpsStats, 5000);
    pollVpsStats();
  },
  close() {
    vman.stats = null;
    clearInterval(vman.timer);
    vman.timer = null;
  },
};

function setVsRange(range, quiet) {
  vman.range = range;
  for (const b of document.querySelectorAll('[data-vrange]')) b.setAttribute('aria-checked', String(b.dataset.vrange === range));
  $('vs-enable-row').hidden = true;
  $('vs-axis').hidden = range === 'live';
  if (range === 'live') {
    $('vs-sub').textContent = 'обновляется каждые 5 секунд';
    if (!quiet || !vman.last) setHint('vs-hint', 'Снимаю показания…');
    vman.long = null;
    drawVpsCharts();
    return;
  }
  $('vs-sub').textContent = range === '7d' ? 'за неделю, по часам с VPS' : 'за сутки, по 5 минут';
  vman.long = null;
  drawVpsCharts();
  loadVpsHistory(range);
}

async function loadVpsHistory(range) {
  const o = vman.stats;
  if (!o) return;
  setHint('vs-hint', 'Загружаю историю с VPS…');
  try {
    const r = await api.call('vps:history', { id: o.id, name: o.name, range });
    if (vman.stats !== o || vman.range !== range) return;
    if (!r.installed) {
      setHint('vs-hint', 'История за сутки и неделю пишется на самом VPS фоновым скриптом лаунчера — раз в минуту, даже когда лаунчер закрыт. Сейчас он не включён.', 'warn');
      $('vs-enable-row').hidden = false;
      return;
    }
    vman.long = r;
    const any = r.points.some((p) => p.sysCpu !== null);
    setHint('vs-hint', any ? '' : 'Записей пока нет — первые появятся через пару минут.');
    const fmt = (t) => new Date(t).toLocaleString(window.I18N_LOCALE || 'ru-RU', range === '7d' ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });
    $('vs-from').textContent = fmt(r.from);
    $('vs-to').textContent = 'сейчас';
    drawVpsCharts();
  } catch (e) {
    if (vman.stats === o) setHint('vs-hint', e.message, 'bad');
  }
}

async function pollVpsStats() {
  const o = vman.stats;
  if (!o || vman.busy) return;
  if (!vpsSel() || vpsSel().id !== o.id) return closeVpsMan();
  if (tab !== 'vps' || document.hidden) return; // вкладка не видна — не нагружаем VPS
  vman.busy = true;
  const size = vman.tick % 12 === 0; // размер папки — раз в минуту, он считается дольше
  vman.tick++;
  try {
    const r = await api.call('vps:stats', { id: o.id, name: o.name, port: o.port, size });
    if (vman.stats !== o) return;
    const key = vsKey(o);
    const h = vman.hist.get(key) || [];
    h.push({
      cpu: r.running ? r.cpu : null,
      sysCpu: r.sysCpu,
      mem: r.running ? r.procMem : null,
      sysUsed: r.memTotal !== null && r.memFree !== null ? r.memTotal - r.memFree : null,
      total: r.memTotal,
      players: r.players,
    });
    while (h.length > VS_POINTS) h.shift();
    vman.hist.set(key, h);
    if (r.size !== null && r.size !== undefined) vman.sizes.set(key, r.size);
    vman.last = r;
    renderVpsStats(r);
  } catch (e) {
    if (vman.stats === o && vman.range === 'live') setHint('vs-hint', e.message, 'bad');
  } finally {
    vman.busy = false;
  }
}

function setStat(id, text, cls) {
  $(id).textContent = text;
  $(id).className = cls || '';
}

function renderVpsStats(r) {
  const o = vman.stats;
  const srv = vpsServerOf(o.name);
  const ram = (srv && srv.ramGb) || 2;
  if (r.running) {
    setStat('vs-cpu', r.cpu === null ? '…' : `${String(r.cpu).replace('.', ',')}%`, r.cpu > 85 ? 'bad' : r.cpu > 60 ? 'warn' : '');
    setStat('vs-mem', r.procMem === null ? '—' : `${vsGb(r.procMem)} из ${ram} ГБ`, r.procMem > ram * 1024 ** 3 * 1.05 ? 'warn' : '');
    setStat('vs-up', r.age === null ? '—' : formatUptime(r.age * 1000));
    setStat('vs-players', r.players === null ? '—' : `${r.players} из ${r.maxPlayers}`);
    $('vs-players').title = r.playerNames && r.playerNames.length ? r.playerNames.join(', ') : '';
  } else {
    setStat('vs-cpu', 'остановлен');
    setStat('vs-mem', '—');
    setStat('vs-up', '—');
    setStat('vs-players', '—');
  }
  setStat('vs-syscpu', r.sysCpu === null ? '…' : `${String(r.sysCpu).replace('.', ',')}%`, r.sysCpu > 90 ? 'bad' : r.sysCpu > 70 ? 'warn' : '');
  if (r.memTotal !== null && r.memFree !== null) {
    setStat('vs-sysmem', `${vsGb(r.memFree)} из ${vsGb(r.memTotal)} ГБ`, r.memFree < 512 * 1024 ** 2 ? 'bad' : r.memFree < 1024 ** 3 ? 'warn' : '');
  }
  if (r.disk !== null) setStat('vs-disk', `${vsGb(r.disk)} ГБ`, r.disk < 2 * 1024 ** 3 ? 'bad' : r.disk < 5 * 1024 ** 3 ? 'warn' : '');
  const size = vman.sizes.get(vsKey(o));
  if (size !== undefined) setStat('vs-size', `${vsGb(size)} ГБ`);

  if (vman.range !== 'live') return; // подсказка — про историю, её не трогаем
  if (!r.running) setHint('vs-hint', 'Сервер остановлен — графики показывают только сам VPS.');
  else if (r.players === null) setHint('vs-hint', 'Сколько игроков, не видно: порт сервера закрыт снаружи или сервер ещё загружается.', 'warn');
  else setHint('vs-hint', '');
  drawVpsCharts();
}

/** Линии на canvas: series — [{ data, color }], значения null — разрыв линии; count — точек на ширину. */
function drawSeriesChart(c, series, max, label, count = VS_POINTS) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== w * dpr || c.height !== h * dpr) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const top = 14;
  g.strokeStyle = css.getPropertyValue('--line').trim() || '#e4e0d8';
  g.lineWidth = 1;
  g.beginPath();
  for (const y of [top, Math.round((top + h) / 2), h - 1]) {
    g.moveTo(0, y + 0.5);
    g.lineTo(w, y + 0.5);
  }
  g.stroke();
  g.fillStyle = css.getPropertyValue('--muted').trim() || '#888';
  g.font = '10.5px ' + (css.getPropertyValue('--mono').trim() || 'monospace');
  g.textBaseline = 'top';
  g.fillText(label, 2, 1);
  const step = w / (count - 1);
  for (const s of series) {
    g.strokeStyle = s.color;
    g.lineWidth = 1.6;
    g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    let lone = null;
    s.data.forEach((v, i) => {
      if (v === null || v === undefined) {
        if (lone) g.rect(lone[0] - 0.8, lone[1] - 0.8, 1.6, 1.6); // одиночная точка между разрывами
        pen = false;
        lone = null;
        return;
      }
      const x = w - (s.data.length - 1 - i) * step;
      const y = h - 2 - (Math.min(max, Math.max(0, v)) / max) * (h - top - 2);
      if (pen) {
        g.lineTo(x, y);
        lone = null;
      } else {
        g.moveTo(x, y);
        lone = [x, y];
      }
      pen = true;
    });
    g.stroke();
  }
}

function drawVpsCharts() {
  if ($('vps-man').hidden || !vman.stats || vman.opened !== 'stats') return;
  const long = vman.range !== 'live';
  const h = long ? (vman.long ? vman.long.points : []) : vman.hist.get(vsKey(vman.stats)) || [];
  const count = long ? Math.max(2, h.length || 288) : VS_POINTS;
  const css = getComputedStyle(document.documentElement);
  const c1 = css.getPropertyValue('--accent').trim() || '#2f5bea';
  const c2 = css.getPropertyValue('--chart-2').trim() || '#9a6bd6';
  drawSeriesChart($('vs-ch-cpu'), [{ data: h.map((p) => p.sysCpu), color: c2 }, { data: h.map((p) => p.cpu), color: c1 }], 100, '100%', count);
  const total = h.reduce((m, p) => Math.max(m, p.total || 0), 0) || 1024 ** 3;
  const gb = 1024 ** 3;
  drawSeriesChart(
    $('vs-ch-mem'),
    [{ data: h.map((p) => (p.sysUsed === null ? null : p.sysUsed / gb)), color: c2 }, { data: h.map((p) => (p.mem === null ? null : p.mem / gb)), color: c1 }],
    total / gb,
    `${vsGb(total)} ГБ`,
    count
  );
  const peak = h.reduce((m, p) => Math.max(m, p.players || 0), 0);
  const maxP = Math.max(4, Math.ceil((peak + 1) / 4) * 4);
  drawSeriesChart($('vs-ch-players'), [{ data: h.map((p) => p.players), color: c1 }], maxP, String(maxP), count);
}

// ---- настройки ----

VPANES.set = {
  async open(o) {
    vman.set = { id: o.id, name: o.name };
    const cur = vman.set;
    $('vset-body').hidden = true;
    $('vset-restart').hidden = true;
    setHint('vset-hint', '');
    setHint('vset-load', 'Загружаю настройки с VPS…');
    try {
      const r = await api.call('vps:settings', cur);
      if (vman.set !== cur) return;
      vman.props = new Map(r.props);
      vman.ram = r.ramGb;
      fillVpsSettings(r);
      setHint('vset-load', r.hasFile ? '' : 'На VPS ещё нет файла server.properties — он появится после первого запуска. Основные параметры можно задать заранее.', r.hasFile ? '' : 'warn');
      $('vset-body').hidden = false;
    } catch (e) {
      if (vman.set === cur) setHint('vset-load', e.message, 'bad');
    }
  },
  close() {
    vman.set = null;
  },
};

/** Значение параметра для поля: что в файле, а если ключа нет — значение по умолчанию. */
const vsetValue = (k) => (vman.props.has(k) ? vman.props.get(k) : VSET_DEFAULTS[k]);
const vsetShown = (k) => vman.props.has(k) || k in VSET_DEFAULTS;

function fillVpsSettings(r) {
  const own = new Set();
  for (const el of document.querySelectorAll('[data-vprop]')) {
    const k = el.dataset.vprop;
    own.add(k);
    el.closest('.field, .check').hidden = !vsetShown(k);
    const v = vsetValue(k);
    if (el.type === 'checkbox') el.checked = v === 'true';
    else if (k === 'motd') el.value = motdFromProps(v || '');
    else el.value = v === undefined ? '' : v;
  }
  const mem = vpsState.info && vpsState.info.memGb;
  $('vset-ram').max = mem ? Math.max(1, mem - 1) : 256;
  $('vset-ram').value = r.ramGb;

  const box = $('vset-all');
  box.replaceChildren();
  const rest = r.props.filter(([k]) => !own.has(k));
  $('vset-count').textContent = rest.length ? `(${rest.length})` : '';
  if (!rest.length) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = 'Других параметров в файле нет.';
    box.appendChild(p);
  }
  for (const [k, v] of rest) {
    const row = document.createElement('label');
    row.className = 'vset-row';
    const name = document.createElement('code');
    name.textContent = k;
    let input;
    if (v === 'true' || v === 'false') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = v === 'true';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = v;
      input.spellcheck = false;
    }
    input.dataset.vall = k;
    row.append(name, input);
    box.appendChild(row);
  }
}

/** Что изменилось: { ключ: значение } — только отличия от файла. */
function collectVpsSettings() {
  const values = {};
  const put = (k, v) => {
    const old = vsetValue(k);
    if (String(v) !== String(old === undefined ? '' : old)) values[k] = String(v);
  };
  for (const el of document.querySelectorAll('[data-vprop]')) {
    const k = el.dataset.vprop;
    if (!vsetShown(k)) continue;
    if (el.type === 'checkbox') put(k, el.checked ? 'true' : 'false');
    else if (k === 'motd') {
      // «&a» → «§a»: так описание понимает любой сервер.
      const v = el.value.trim().replace(/&([0-9a-fk-or])/gi, (_, c) => '§' + c.toLowerCase());
      if (v !== String(vsetValue(k) || '')) values[k] = v;
    } else put(k, el.value.trim());
  }
  for (const el of document.querySelectorAll('[data-vall]')) put(el.dataset.vall, el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value.trim());
  return values;
}

async function saveVpsSettings() {
  const o = vman.set;
  if (!o) return;
  const values = collectVpsSettings();
  const ram = Math.round(Number($('vset-ram').value));
  const max = Number($('vset-ram').max) || 256;
  if (!(ram >= 1 && ram <= max)) return setHint('vset-hint', `Память — от 1 до ${max} ГБ`, 'bad');
  const ramChanged = ram !== vman.ram;
  if (!Object.keys(values).length && !ramChanged) return setHint('vset-hint', 'Ничего не изменилось.');
  $('vset-save').disabled = true;
  setHint('vset-hint', 'Сохраняю…');
  try {
    await api.call('vps:saveSettings', { ...o, values, ramGb: ramChanged ? ram : undefined });
    for (const [k, v] of Object.entries(values)) vman.props.set(k, v);
    vman.ram = ram;
    const running = vmRunning();
    setHint('vset-hint', running ? 'Сохранено. Изменения заработают после перезапуска сервера.' : 'Сохранено. Изменения заработают при следующем запуске.', 'good');
    $('vset-restart').hidden = !running;
    await refreshVpsInfo(true);
    if (vman.cur && vman.cur.name === o.name && values['server-port']) vman.cur.port = values['server-port'];
  } catch (e) {
    setHint('vset-hint', e.message, 'bad');
  }
  $('vset-save').disabled = false;
}

async function restartVpsServer() {
  const o = vman.set;
  if (!o) return;
  if (!window.confirm(`Перезапустить «${o.name}»?\n\nСервер сохранит мир и остановится, игроков отключит примерно на минуту.`)) return;
  $('vset-restart').disabled = true;
  setHint('vset-hint', 'Останавливаю (до минуты)…');
  try {
    await api.call('vps:stop', o);
    setHint('vset-hint', 'Запускаю…');
    await api.call('vps:start', { ...o, ramGb: vman.ram });
    setHint('vset-hint', 'Сервер запускается заново с новыми настройками.', 'good');
    $('vset-restart').hidden = true;
  } catch (e) {
    setHint('vset-hint', e.message, 'bad');
  }
  $('vset-restart').disabled = false;
  await refreshVpsInfo(true);
}

// ---- удаление ----

/** Удалить сервер с VPS (подтверждение спрашивает кнопка). Возвращает текст для подсказки. */
async function deleteVpsServer(s) {
  const v = vpsSel();
  if (!v) return null;
  await api.call('vps:removeServer', { id: v.id, name: s.name });
  // Строка сервера исчезнет из списка — сообщение показываем вверху.
  setHint('vps-hint', `Сервер «${s.name}» удалён с VPS.`, 'good');
  if (vpsState.console === s.name) closeVpsConsole();
  if (vman.cur && vman.cur.name === s.name) closeVpsMan();
  vman.hist.delete(`${v.id}/${s.name}`);
  return `Сервер «${s.name}» удалён с VPS.`;
}

// Сменили VPS — закрываем панель сервера прежнего.
{
  const baseSelect = selectVps;
  selectVps = async function (id) {
    if (vpsState.sel !== id) closeVpsMan();
    return baseSelect(id);
  };
}
// Сервер пропал из списка (удалили на VPS) — закрываем его панель.
{
  const baseRender = renderVps;
  renderVps = function () {
    baseRender();
    if (vman.cur && vpsState.info && !vpsServerOf(vman.cur.name)) closeVpsMan();
  };
}

$('vm-close').addEventListener('click', () => {
  const p = vman.opened && VPANES[vman.opened];
  if (p && p.canLeave && !p.canLeave()) return;
  closeVpsMan();
  renderVps();
});
for (const b of document.querySelectorAll('[data-vpane]')) b.addEventListener('click', () => vman.cur && showVpsPane(b.dataset.vpane));
for (const b of document.querySelectorAll('[data-vrange]')) b.addEventListener('click', () => vman.stats && setVsRange(b.dataset.vrange));
$('vs-enable').addEventListener('click', async () => {
  const o = vman.stats;
  if (!o) return;
  $('vs-enable').disabled = true;
  setHint('vs-hint', 'Включаю…');
  try {
    const r = await api.call('vps:autoEnable', { id: o.id });
    $('vs-enable-row').hidden = true;
    setHint('vs-hint', r.warn || 'Включено. Первые записи появятся через пару минут.', r.warn ? 'warn' : 'good');
  } catch (e) {
    setHint('vs-hint', e.message, 'bad');
  }
  $('vs-enable').disabled = false;
});
$('vset-save').addEventListener('click', saveVpsSettings);
$('vset-restart').addEventListener('click', restartVpsServer);
window.addEventListener('resize', () => drawVpsCharts());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawVpsCharts());
