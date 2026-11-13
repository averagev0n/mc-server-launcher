// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- чат, расписание работы, Telegram, нагрузка за неделю, обновления разом, мир для одиночной игры ----

// ---- чат ----

let chatLines = [];
let chatOnline = [];
let chatUnread = 0;
const hhmm = (t) => new Date(t).toLocaleTimeString(I18N_LOCALE, { hour: '2-digit', minute: '2-digit' });

function chatRow(m) {
  const row = document.createElement('div');
  row.className = 'chat-msg' + (m.own ? ' own' : '');
  const time = document.createElement('span');
  time.className = 'chat-time';
  time.textContent = hhmm(m.at);
  let name;
  if (m.own) {
    name = document.createElement('b');
    name.textContent = m.to ? `Вы → ${m.to}` : m.via === 'telegram' ? 'Вы (из Telegram)' : 'Вы';
  } else {
    name = document.createElement('button');
    name.type = 'button';
    name.textContent = m.name;
    name.title = 'Ответить лично';
    name.addEventListener('click', () => {
      fillChatTo(m.name);
      $('chat-text').focus();
    });
  }
  name.classList.add('chat-name');
  const text = document.createElement('span');
  text.className = 'chat-text';
  text.textContent = m.text;
  row.append(time, name, text);
  return row;
}

function fillChatTo(pick) {
  const sel = $('chat-to');
  const want = pick || sel.value;
  const names = [...new Set([...chatOnline, ...(pick && pick !== '@a' ? [pick] : [])])].sort((a, b) => a.localeCompare(b));
  sel.replaceChildren(new Option('Всем', '@a'), ...names.map((n) => new Option(`Лично: ${n}`, n)));
  sel.value = names.includes(want) ? want : '@a';
}

const chatLive = () => state === 'running' && isSelectedRunning() && !bgEntry();

function renderChat() {
  const box = $('chat-log');
  box.replaceChildren(...chatLines.map(chatRow));
  box.scrollTop = box.scrollHeight;
  renderChatControls();
}
function renderChatControls() {
  const live = chatLive();
  $('chat-text').disabled = $('chat-send').disabled = $('chat-to').disabled = !live;
  let hint = '';
  if (!live) hint = isSelectedRunning() || !running ? 'Чат работает, когда этот сервер запущен.' : 'Чат показывает только сервер, запущенный первым.';
  else if (!chatLines.length) hint = 'Здесь появятся сообщения игроков. Нажмите на ник, чтобы ответить лично.';
  setHint('chat-hint', hint);
}

async function loadChat() {
  try {
    const r = await api.call('chat:get');
    chatLines = r.lines;
    chatOnline = r.online;
    fillChatTo();
    renderChat();
  } catch {
    /* сервер не отвечает — пустой чат */
  }
}

api.on('chat', (m) => {
  chatLines.push(m);
  if (chatLines.length > 300) chatLines.shift();
  if (tab === 'chat') {
    const box = $('chat-log');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.appendChild(chatRow(m));
    if (stick) box.scrollTop = box.scrollHeight;
    setHint('chat-hint', '');
  } else if (!m.own) {
    chatUnread++;
    renderTabs();
  }
});
api.on('players', (p) => {
  chatOnline = p.online || [];
  fillChatTo();
});
api.on('state', (s) => {
  if (s.state === 'starting') {
    chatLines = [];
    if (tab === 'chat') renderChat();
  }
  setTimeout(renderChatControls, 0);
});

$('chat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = $('chat-text').value.trim();
  if (!text) return;
  try {
    await api.call('chat:send', { to: $('chat-to').value, text });
    $('chat-text').value = '';
  } catch (e) {
    setHint('chat-hint', e.message, 'bad');
  }
});

// Вкладка «Чат»: показать, отметить непрочитанное.
let chatWasOpen = false;
const baseRenderTabsLife = renderTabs;
renderTabs = function () {
  baseRenderTabsLife();
  $('view-chat').hidden = tab !== 'chat';
  const t = $('tab-chat');
  if (tab === 'chat') chatUnread = 0;
  t.textContent = 'Чат';
  if (chatUnread) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = chatUnread > 99 ? '99+' : chatUnread;
    t.appendChild(c);
  }
  if (tab === 'chat' && !chatWasOpen) loadChat();
  chatWasOpen = tab === 'chat';
};

// ---- обновления модов и плагинов разом ----

let uaFound = [];
async function checkAllUpdates() {
  const ks = kinds();
  if (!ks.length) return;
  const key = selKey();
  $('ua-run').hidden = true;
  $('ua-list').replaceChildren();
  setHint('ua-hint', 'Проверяю на Modrinth…');
  try {
    const found = [];
    let unknown = 0;
    for (const kind of ks) {
      const list = await api.call('mods:checkUpdates', { ...modsArgs(), kind });
      unknown += list.filter((x) => !x.known).length;
      found.push(...list.filter((x) => x.update).map((x) => ({ ...x, kind })));
    }
    if (key !== selKey()) return;
    uaFound = found;
    $('ua-list').replaceChildren(
      ...found.map((x) => {
        const li = document.createElement('li');
        const n = document.createElement('span');
        n.textContent = x.title || x.file;
        const v = document.createElement('span');
        v.className = 'ver';
        v.textContent = `${x.current} → ${x.latest}`;
        li.append(n, v);
        return li;
      })
    );
    $('ua-run').hidden = !found.length;
    $('ua-run').textContent = `Обновить всё (${found.length})`;
    const extra = unknown ? ` Ещё ${unknown} не с Modrinth — их лаунчер не проверяет.` : '';
    setHint('ua-hint', (found.length ? `Есть обновления: ${found.length}.` : 'Всё актуально.') + extra, found.length ? 'warn' : 'good');
  } catch (e) {
    setHint('ua-hint', e.message, 'bad');
  }
}
async function runAllUpdates() {
  if (isSelectedRunning() && state !== 'stopped') {
    setHint('ua-hint', 'Сначала остановите сервер: пока он работает, файлы заняты.', 'bad');
    return;
  }
  $('ua-run').disabled = $('ua-check').disabled = true;
  let done = 0;
  const failed = [];
  for (const x of uaFound) {
    setHint('ua-hint', `Обновляю ${done + failed.length + 1} из ${uaFound.length}: ${x.title || x.file}…`);
    try {
      await api.call('mods:update', { ...modsArgs(), kind: x.kind, file: x.file });
      done++;
    } catch (e) {
      failed.push(`${x.title || x.file}: ${e.message}`);
    }
  }
  $('ua-run').disabled = $('ua-check').disabled = false;
  await checkAllUpdates();
  if (typeof refreshInstalled === 'function') refreshInstalled().catch(() => {});
  setHint('ua-hint', `Обновлено: ${done}.${failed.length ? ` Не получилось: ${failed.join('; ')}.` : ''} Старые файлы — в папке backups сервера.`, failed.length ? 'warn' : 'good');
}
$('ua-check').addEventListener('click', checkAllUpdates);
$('ua-run').addEventListener('click', runAllUpdates);

// ---- нагрузка за неделю ----

let weekData = null;
const DAY = 24 * 3600 * 1000;
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function drawWeek() {
  const c = $('wk-chart');
  if (!weekData || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = (n, d) => css.getPropertyValue(n).trim() || d;
  const muted = col('--muted', '#676b72');
  const lineC = col('--line', '#e4e0d8');
  const left = 74;
  const right = w - 6;
  const now = Date.now();
  const from = now - 7 * DAY;
  const X = (t) => left + ((t - from) / (7 * DAY)) * (right - left);
  const pts = weekData.points.filter((p) => p.t >= from);
  const rows = [
    { label: 'Игроки', top: 4, hgt: 52 },
    { label: 'Плавность', top: 70, hgt: 52 },
    { label: 'Память', top: 136, hgt: 52 },
  ];
  g.font = `12px ${col('--sans', 'sans-serif')}`;
  g.textBaseline = 'middle';
  // Сетка по дням и подписи.
  g.strokeStyle = lineC;
  g.lineWidth = 1;
  const d0 = new Date(from);
  d0.setHours(0, 0, 0, 0);
  for (let t = d0.getTime() + DAY; t < now; t += DAY) {
    const x = Math.round(X(t)) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 190);
    g.stroke();
    const d = new Date(t);
    g.fillStyle = muted;
    g.fillText(`${WD[d.getDay()]} ${d.getDate()}`, x + 4, 202);
  }
  for (const r of rows) {
    g.fillStyle = muted;
    g.fillText(r.label, 0, r.top + r.hgt / 2);
    g.strokeStyle = lineC;
    g.beginPath();
    g.moveTo(left, r.top + r.hgt + 0.5);
    g.lineTo(right, r.top + r.hgt + 0.5);
    g.stroke();
  }
  const bw = Math.max(1, (right - left) / (7 * 144) - 0.3);
  // Игроки — столбики.
  const maxP = Math.max(1, ...pts.map((p) => p.p));
  g.fillStyle = col('--accent', '#2f5bea');
  for (const p of pts) {
    if (!p.p) continue;
    const hh = (p.p / maxP) * rows[0].hgt;
    g.fillRect(X(p.t), rows[0].top + rows[0].hgt - hh, bw, hh);
  }
  // Плавность — столбики от 20 вниз: чем ниже, тем хуже; цвет по порогам.
  for (const p of pts) {
    if (!Number.isFinite(p.tps)) continue;
    const v = Math.max(0, Math.min(20, p.tps));
    const hh = Math.max(1.5, (v / 20) * rows[1].hgt);
    g.fillStyle = v < 15 ? col('--danger', '#c4362b') : v < 18.5 ? col('--warn', '#9a5f0c') : col('--ok', '#1a8a4a');
    g.fillRect(X(p.t), rows[1].top + rows[1].hgt - hh, bw, hh);
  }
  // Память — столбики в ГБ.
  const maxM = Math.max(1024, ...pts.map((p) => p.mem));
  g.fillStyle = col('--chart-2', '#9a6bd6');
  for (const p of pts) {
    const hh = (p.mem / maxM) * rows[2].hgt;
    g.fillRect(X(p.t), rows[2].top + rows[2].hgt - hh, bw, hh);
  }
  // Подписи максимумов справа от названия.
  g.fillStyle = muted;
  g.font = `11px ${col('--sans', 'sans-serif')}`;
  g.fillText(`до ${maxP}`, 0, rows[0].top + rows[0].hgt / 2 + 14);
  g.fillText('из 20 TPS', 0, rows[1].top + rows[1].hgt / 2 + 14);
  g.fillText(`до ${(maxM / 1024).toFixed(1).replace('.', ',')} ГБ`, 0, rows[2].top + rows[2].hgt / 2 + 14);
}

async function loadWeek() {
  try {
    weekData = await api.call('history:get', selected());
  } catch {
    return;
  }
  const s = weekData.summary;
  if (!weekData.points.length) {
    setHint('wk-hint', 'Данные появятся, когда сервер поработает хотя бы несколько минут. Хранится последняя неделя.');
  } else {
    const parts = [`Сервер работал около ${Math.max(1, Math.round(s.hours))} ч за неделю.`];
    if (s.maxPlayers) parts.push(`Больше всего игроков — ${s.maxPlayers}.`);
    if (s.peakHour !== null) parts.push(`Чаще всего играют около ${String(s.peakHour).padStart(2, '0')}:00.`);
    if (s.worst) {
      const d = new Date(s.worst.t);
      parts.push(`Сильнее всего тормозило: ${WD[d.getDay()]} в ${hhmm(s.worst.t)} (${String(s.worst.tps).replace('.', ',')} TPS).`);
    } else parts.push('Сервер не тормозил.');
    setHint('wk-hint', parts.join(' '));
  }
  drawWeek();
}
$('wk-refresh').addEventListener('click', loadWeek);
window.addEventListener('resize', () => {
  if (tab === 'maint') drawWeek();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawWeek());

// ---- мир для одиночной игры ----

async function exportSingle(mode) {
  setHint('sp-hint', 'Копирую мир…');
  $('sp-saves').disabled = $('sp-zip').disabled = true;
  try {
    const r = await api.call('sp:export', { ...selected(), name: $('sp-name').value.trim(), mode });
    if (!r) setHint('sp-hint', '');
    else if (r.file) setHint('sp-hint', 'Архив сохранён. Его можно распаковать в папку saves игры — на этом или другом компьютере.', 'good');
    else setHint('sp-hint', `Готово: мир «${r.folder}» появится в игре в разделе «Одиночная игра».${isModded() ? ' Для мира с модами в игре нужны те же моды.' : ''}`, 'good');
  } catch (e) {
    setHint('sp-hint', e.message, 'bad');
  }
  $('sp-saves').disabled = $('sp-zip').disabled = false;
}
$('sp-saves').addEventListener('click', () => exportSingle('saves'));
$('sp-zip').addEventListener('click', () => exportSingle('zip'));

const baseLoadMaintLife = loadMaint;
loadMaint = async function () {
  await baseLoadMaintLife();
  if (tab !== 'maint') return;
  const k = kinds();
  $('ua-card').hidden = !k.length;
  if (k.length && $('ua-list').dataset.key !== selKey()) {
    $('ua-list').dataset.key = selKey();
    uaFound = [];
    $('ua-list').replaceChildren();
    $('ua-run').hidden = true;
    setHint('ua-hint', `${k.length > 1 ? 'Проверяет сразу и моды, и плагины' : k[0] === 'plugin' ? 'Проверяет все плагины сразу' : 'Проверяет все моды сразу'}. Старые файлы остаются в папке backups сервера.`);
  }
  if (!$('sp-name').value || $('sp-name').dataset.key !== selKey()) {
    $('sp-name').dataset.key = selKey();
    $('sp-name').value = serverTitle(type, $('version').value);
    setHint('sp-hint', '');
  }
  loadWeek();
};

// ---- расписание работы ----

const PW_DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
$('pw-days').replaceChildren(
  ...PW_DAYS.map((d, i) => {
    const l = document.createElement('label');
    l.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.day = i;
    const sp = document.createElement('span');
    sp.textContent = d;
    l.append(cb, sp);
    return l;
  })
);
const pwDays = () => [...document.querySelectorAll('#pw-days input')];

function showPower(r) {
  $('pw-on').checked = r.power.enabled;
  $('pw-from').value = r.power.from;
  $('pw-to').value = r.power.to;
  pwDays().forEach((cb, i) => (cb.checked = r.power.days[i]));
  pwToggle();
  if (!r.power.enabled) setHint('pw-hint', 'Например: по будням с 18:00 до 23:00. За 5 минут и за минуту до выключения игроки получат предупреждение.');
  else setHint('pw-hint', `Работает: ${r.text}.${r.autostart ? '' : ' Лаунчер должен быть открыт — включите ниже «Запускать лаунчер вместе с Windows», чтобы расписание работало и после перезагрузки.'}`, r.autostart ? 'good' : 'warn');
}
function pwToggle() {
  const on = $('pw-on').checked;
  for (const el of [$('pw-from'), $('pw-to'), ...pwDays()]) el.disabled = !on;
}
$('pw-on').addEventListener('change', pwToggle);
$('pw-save').addEventListener('click', async () => {
  try {
    await api.call('maint:set', {
      ...selected(),
      settings: { power: { enabled: $('pw-on').checked, from: $('pw-from').value, to: $('pw-to').value, days: pwDays().map((cb) => cb.checked) } },
    });
    showPower(await api.call('power:get', selected()));
  } catch (e) {
    setHint('pw-hint', e.message, 'bad');
  }
});

// ---- Telegram ----

function showTg(t) {
  $('tg-setup').hidden = t.connected;
  $('tg-link').hidden = !t.connected || t.linked;
  $('tg-ready').hidden = !t.linked;
  if (t.connected && !t.linked) {
    $('tg-link-text').textContent = t.code
      ? `Бот @${t.bot} подключён. Осталось привязать чат: нажмите «Открыть бота» и в Telegram нажмите «Запустить». Или отправьте боту: /start ${t.code}`
      : `Бот @${t.bot} подключён. Нажмите «Новый код», чтобы привязать чат.`;
    $('tg-open').disabled = !t.code;
  }
  if (t.linked) {
    $('tg-who').textContent = `Бот @${t.bot} пишет в чат «${t.chat}».${t.running ? '' : ' Сейчас не на связи — проверьте интернет.'}`;
    $('tg-start').checked = t.events.start;
    $('tg-players').checked = t.events.players;
    $('tg-crash').checked = t.events.crash;
    $('tg-report').checked = t.events.report !== false;
    $('tg-control').checked = t.control;
  }
}
async function tgDo(fn, okText) {
  try {
    const t = await fn();
    if (t && typeof t === 'object' && 'connected' in t) showTg(t);
    setHint('tg-hint', okText || '', okText ? 'good' : '');
  } catch (e) {
    setHint('tg-hint', e.message, 'bad');
  }
}
$('tg-connect').addEventListener('click', () =>
  tgDo(async () => {
    setHint('tg-hint', 'Проверяю токен…');
    const t = await api.call('tg:connect', { token: $('tg-token').value.trim() });
    $('tg-token').value = '';
    return t;
  })
);
$('tg-open').addEventListener('click', () => api.call('tg:openBot').catch(fail));
$('tg-newcode').addEventListener('click', () => tgDo(() => api.call('tg:connect', {})));
for (const id of ['tg-cancel', 'tg-off']) {
  $(id).addEventListener('click', () => {
    if (!window.confirm('Отключить Telegram-бота? Лаунчер забудет токен и чат.')) return;
    tgDo(() => api.call('tg:disconnect'), 'Бот отключён.');
  });
}
$('tg-save').addEventListener('click', () =>
  tgDo(
    () => api.call('tg:set', { events: { start: $('tg-start').checked, players: $('tg-players').checked, crash: $('tg-crash').checked, report: $('tg-report').checked }, control: $('tg-control').checked }),
    'Сохранено.'
  )
);
$('tg-test').addEventListener('click', () => tgDo(() => api.call('tg:test'), 'Сообщение отправлено — проверьте Telegram.'));
api.on('tg', (t) => {
  showTg(t);
  if (t.linked) setHint('tg-hint', 'Чат привязан.', 'good');
});

const baseLoadToolsLife = loadTools;
loadTools = async function () {
  await baseLoadToolsLife();
  const [p, t] = await Promise.all([api.call('power:get', selected()).catch(() => null), api.call('tg:get').catch(() => null)]);
  if (p) showPower(p);
  if (t) showTg(t);
};

// ---- игра на этом ПК ----

const baseLoadPrefsLife = loadPrefs;
loadPrefs = async function () {
  await baseLoadPrefsLife();
  try {
    $('pf-game').checked = (await api.call('ui:getPrefs')).gamePriority;
  } catch {
    /* по умолчанию */
  }
};
$('pf-game').addEventListener('change', () => api.call('ui:setPrefs', { gamePriority: $('pf-game').checked }).catch(fail));
