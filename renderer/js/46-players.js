// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- игроки ----

let plData = null;

function chip(text, sub, buttons) {
  const c = document.createElement('span');
  c.className = 'chip';
  const t = document.createElement('span');
  t.textContent = text;
  c.appendChild(t);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    c.appendChild(s);
  }
  for (const [label, fn, cls, title] of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    c.appendChild(b);
  }
  return c;
}

async function plAction(list, action, value, reason) {
  setHint('pl-hint', 'Применяю…');
  try {
    const r = await api.call('players:action', { ...selected(), list, action, value, reason });
    await loadPlayers();
    setHint('pl-hint', r.live ? 'Готово — применено на работающем сервере.' : 'Готово — сохранено, применится при запуске сервера.', 'good');
    return true;
  } catch (e) {
    setHint('pl-hint', e.message, 'bad');
    return false;
  }
}

function renderPlayers() {
  const d = plData;
  if (!d) return;
  // Онлайн
  const on = $('pl-online');
  on.replaceChildren();
  on.dataset.empty = d.running ? 'Никого нет' : 'Сервер не запущен';
  $('pl-online-title').textContent = d.running ? `Сейчас на сервере: ${d.online.length} из ${d.max}` : 'Сейчас на сервере';
  const opNames = new Set(d.lists.ops.map((o) => o.name.toLowerCase()));
  for (const name of d.online) {
    const isOp = opNames.has(name.toLowerCase());
    on.appendChild(
      chip(name, isOp ? 'оператор' : '', [
        isOp ? ['снять OP', () => plAction('ops', 'remove', name)] : ['дать OP', () => plAction('ops', 'add', name)],
        ['кик', () => plAction('kick', 'run', name), '', 'Выкинуть с сервера (сможет зайти снова)'],
        ['бан', () => window.confirm(`Забанить ${name}?`) && plAction('bans', 'add', name), 'danger'],
      ])
    );
  }
  // Списки
  const lists = {
    ops: d.lists.ops.map((x) => [x.name, '', 'снять']),
    whitelist: d.lists.whitelist.map((x) => [x.name, '', 'убрать']),
    bans: d.lists.bans.map((x) => [x.name, x.reason && x.reason !== 'Banned by an operator.' ? x.reason : '', 'разбанить']),
    ipbans: d.lists.ipbans.map((x) => [x.ip, x.reason && x.reason !== 'Banned by an operator.' ? x.reason : '', 'разбанить']),
  };
  const empty = { ops: 'Операторов нет', whitelist: 'Список пуст', bans: 'Никто не забанен', ipbans: 'Никто не забанен' };
  for (const [key, items] of Object.entries(lists)) {
    const box = document.querySelector(`[data-chips="${key}"]`);
    box.replaceChildren();
    box.dataset.empty = empty[key];
    for (const [value, sub, label] of items) {
      box.appendChild(chip(value, sub, [[label, () => plAction(key, 'remove', value), key === 'bans' || key === 'ipbans' ? '' : 'danger']]));
    }
  }
  $('pl-wl-on').checked = d.whitelistOn;
  if (!$('pl-hint').classList.contains('bad') && !$('pl-hint').classList.contains('good')) {
    setHint(
      'pl-hint',
      d.running
        ? 'Сервер запущен — изменения применяются сразу.'
        : `Сервер остановлен — изменения сохранятся в его файлы и сработают при запуске.${d.onlineMode ? ' Для ников нужен интернет: лаунчер узнаёт UUID игрока у Mojang.' : ''}`
    );
  }
}

async function loadPlayers() {
  if (!$('version').value) return;
  try {
    plData = await api.call('players:get', selected());
  } catch (e) {
    setHint('pl-hint', e.message, 'bad');
    return;
  }
  renderPlayers();
}

function ensurePlayers() {
  if (tab !== 'players') return;
  setHint('pl-hint', '');
  loadPlayers();
}

for (const form of document.querySelectorAll('.pl-add')) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const [input, reason] = form.querySelectorAll('input');
    const value = input.value.trim();
    if (!value) return;
    const list = form.dataset.list;
    if ((list === 'bans' || list === 'ipbans') && !window.confirm(`Забанить ${value}?`)) return;
    const ok = await plAction(list, 'add', value, reason && reason.classList.contains('reason') ? reason.value : '');
    if (ok) {
      input.value = '';
      if (reason && reason.classList.contains('reason')) reason.value = '';
    }
  });
}
$('pl-wl-on').addEventListener('change', () => plAction('whitelist-toggle', $('pl-wl-on').checked ? 'on' : 'off', ''));

api.on('players', (p) => {
  if (tab !== 'players' || !plData) return;
  if (p.server && !isSelectedRunning()) return;
  plData.online = p.online;
  plData.max = p.max;
  plData.running = p.running && isSelectedRunning();
  renderPlayers();
});
