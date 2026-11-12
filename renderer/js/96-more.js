// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- консоль, плавность, правила игры, туннель, облако, игроки, приглашение, готовый сервер ----

// ---- консоль: история, подсказки, быстрые команды, поиск ----

const COMMANDS = [
  ['op ', 'дать права оператора'],
  ['deop ', 'снять права оператора'],
  ['kick ', 'выкинуть игрока'],
  ['ban ', 'забанить игрока'],
  ['pardon ', 'разбанить игрока'],
  ['whitelist add ', 'добавить в белый список'],
  ['whitelist remove ', 'убрать из белого списка'],
  ['gamemode survival ', 'режим выживания игроку'],
  ['gamemode creative ', 'творческий режим игроку'],
  ['gamemode spectator ', 'режим наблюдателя игроку'],
  ['tp ', 'телепортировать: tp Кого Куда'],
  ['give ', 'выдать предмет: give Ник minecraft:diamond 5'],
  ['time set day', 'сделать день'],
  ['time set night', 'сделать ночь'],
  ['weather clear', 'ясная погода'],
  ['weather rain', 'дождь'],
  ['difficulty peaceful', 'мирная сложность'],
  ['difficulty normal', 'нормальная сложность'],
  ['say ', 'сообщение всем игрокам'],
  ['tell ', 'личное сообщение: tell Ник текст'],
  ['list', 'кто сейчас на сервере'],
  ['save-all', 'сохранить мир'],
  ['seed', 'узнать сид мира'],
  ['setworldspawn', 'точка появления — где стоите'],
];
$('cmd-list').replaceChildren(
  ...COMMANDS.map(([value, label]) => {
    const o = document.createElement('option');
    o.value = value;
    o.label = label;
    return o;
  })
);

let cmdHistory = [];
try {
  cmdHistory = JSON.parse(store.get('cmdHistory', '[]')).filter((x) => typeof x === 'string').slice(-50);
} catch {
  cmdHistory = [];
}
let histPos = cmdHistory.length;
$('cmd-form').addEventListener('submit', () => {
  const text = $('cmd').value.trim();
  if (!text) return;
  if (cmdHistory[cmdHistory.length - 1] !== text) cmdHistory.push(text);
  cmdHistory = cmdHistory.slice(-50);
  histPos = cmdHistory.length;
  store.set('cmdHistory', JSON.stringify(cmdHistory));
});
$('cmd').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (!cmdHistory.length) return;
  e.preventDefault();
  histPos = Math.max(0, Math.min(cmdHistory.length, histPos + (e.key === 'ArrowUp' ? -1 : 1)));
  $('cmd').value = cmdHistory[histPos] || '';
});

for (const b of document.querySelectorAll('[data-quick]')) {
  b.addEventListener('click', () => {
    const c = b.dataset.quick;
    if (c.endsWith(' ')) {
      $('cmd').value = c;
      $('cmd').focus();
      return;
    }
    api.call('server:command', { text: c }).catch(fail);
  });
}
function renderQuick() {
  const on = state === 'running' && isSelectedRunning();
  for (const b of document.querySelectorAll('[data-quick]')) b.disabled = !on;
}

let logQuery = '';
function applyLogFilter() {
  for (const line of $('log').children) line.hidden = !!logQuery && !line.textContent.toLowerCase().includes(logQuery);
}
$('log-search').addEventListener('input', () => {
  logQuery = $('log-search').value.trim().toLowerCase();
  applyLogFilter();
});
$('log-errors').addEventListener('change', () => $('log').classList.toggle('only-errors', $('log-errors').checked));
const baseAddLog = addLog;
addLog = function (text, kind) {
  baseAddLog(text, kind);
  if (logQuery) {
    const el = $('log').lastElementChild;
    if (el && !String(text).toLowerCase().includes(logQuery)) el.hidden = true;
  }
};

// ---- плавность (TPS) ----

api.on('stats', (s) => {
  const box = $('st-tps-box');
  if (!s.tps) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const el = $('st-tps');
  const t = s.tps.tps;
  el.textContent = `${String(Math.round(t * 10) / 10).replace('.', ',')} TPS`;
  el.className = t < 15 ? 'bad' : t < 18.5 ? 'warn' : '';
  box.title =
    (t >= 18.5 ? 'Сервер успевает (норма — 20).' : t >= 15 ? 'Сервер слегка не успевает — возможны подлагивания.' : 'Сервер тормозит: игроки заметят задержки.') +
    (s.tps.mspt ? ` Тик длится ${String(s.tps.mspt.toFixed(1)).replace('.', ',')} мс из 50.` : '');
});

// ---- вкладка «Настройки»: обновление ядра, правила, туннель ----

const RULE_DEFAULTS = {
  keepInventory: false,
  mobGriefing: true,
  doInsomnia: true,
  playersSleepingPercentage: false,
  doImmediateRespawn: false,
  doDaylightCycle: true,
  doWeatherCycle: true,
  announceAdvancements: true,
};
let storedRules = {};
let tunnel = { address: '', auto: false, downloaded: false, running: false };

function renderRules() {
  for (const box of document.querySelectorAll('[data-rule]')) {
    const id = box.dataset.rule;
    const value = id in storedRules ? storedRules[id] : RULE_DEFAULTS[id];
    box.checked = box.hasAttribute('data-invert') ? !value : value;
  }
}
for (const box of document.querySelectorAll('[data-rule]')) {
  box.addEventListener('change', async () => {
    const id = box.dataset.rule;
    const value = box.hasAttribute('data-invert') ? !box.checked : box.checked;
    try {
      const r = await api.call('rules:set', { ...selected(), rules: { ...storedRules, [id]: value } });
      storedRules = r.rules;
      setHint('rules-hint', r.applied ? 'Применено на работающем сервере.' : 'Сохранено — применится при запуске сервера.', 'good');
    } catch (e) {
      setHint('rules-hint', e.message, 'bad');
      renderRules();
    }
  });
}

function renderTunnel() {
  $('tn-port').textContent = $('p-port').value || '25565';
  $('tn-addr').value = tunnel.address;
  $('tn-auto').checked = tunnel.auto;
  $('tn-stop').hidden = !tunnel.running;
  $('tn-setup').textContent = tunnel.downloaded ? 'Открыть playit' : 'Настроить';
}
async function loadTunnel() {
  try {
    tunnel = await api.call('tunnel:get', selected());
  } catch {
    /* по умолчанию */
  }
  renderTunnel();
  render();
}
$('tn-setup').addEventListener('click', async () => {
  $('tn-setup').disabled = true;
  setHint('tn-hint', tunnel.downloaded ? 'Открываю playit…' : 'Скачиваю playit с GitHub…');
  try {
    await api.call('tunnel:setup');
    tunnel.downloaded = true;
    tunnel.running = true;
    setHint('tn-hint', 'Окно playit открыто — следуйте шагам выше. Когда туннель заработает, вставьте его адрес.', 'good');
  } catch (e) {
    setHint('tn-hint', e.message, 'bad');
  }
  $('tn-setup').disabled = false;
  renderTunnel();
});
$('tn-stop').addEventListener('click', async () => {
  await api.call('tunnel:stop').catch(fail);
  tunnel.running = false;
  renderTunnel();
});
async function saveTunnel() {
  try {
    const t = await api.call('tunnel:set', { ...selected(), address: $('tn-addr').value, auto: $('tn-auto').checked });
    Object.assign(tunnel, t);
    setHint('tn-hint', t.address ? 'Сохранено. Адрес туннеля появится в строке «Адрес для друзей».' : 'Сохранено.', 'good');
  } catch (e) {
    setHint('tn-hint', e.message, 'bad');
  }
  render();
}
$('tn-addr').addEventListener('change', saveTunnel);
$('tn-auto').addEventListener('change', saveTunnel);
api.on('tunnel', (t) => {
  tunnel.running = t.running;
  if (tab === 'settings') renderTunnel();
});

/** Вышла ли свежая сборка ядра (Paper, Fabric, Forge, NeoForge, гибриды). */
async function checkBuild() {
  setHint('build-hint', '');
  if (!info || !info.installed) return;
  const key = selKey();
  if (isModded() && loaders && info.installedLoader && loaders.recommended && info.installedLoader !== loaders.recommended) {
    const ids = loaders.list.map((l) => l.id);
    const iRec = ids.indexOf(loaders.recommended);
    const iCur = ids.indexOf(info.installedLoader);
    if (iRec < 0 || (iCur >= 0 && iRec >= iCur)) return; // установлена такая же или более новая
    const label = (loaders.list[iRec] || {}).label || loaders.recommended;
    const el = setHint('build-hint', `Вышла новая сборка: ${label}. `, 'warn');
    addLink(el, 'Обновить', () => {
      $('loader').value = loaders.recommended;
      render();
      setHint('build-hint', `При следующем запуске сервер обновится до ${label}. Мир, моды и настройки сохранятся.`, 'good');
    });
    return;
  }
  if (type === 'paper') {
    try {
      const b = await api.call('server:paperBuild', selected());
      if (key !== selKey() || !b || !(Number(b.latest) > Number(b.installed))) return;
      const el = setHint('build-hint', `Вышла новая сборка Paper: #${b.latest} (у вас #${b.installed}) — с исправлениями. `, 'warn');
      addLink(el, 'Обновить', async () => {
        await api.call('server:paperRefresh', selected()).catch(fail);
        info.installed = false;
        render();
        setHint('build-hint', `Сборка #${b.latest} скачается при следующем запуске. Мир и плагины сохранятся.`, 'good');
      });
    } catch {
      /* без интернета — просто не подсказываем */
    }
  }
}

async function loadMore() {
  try {
    const m = await api.call('maint:get', selected());
    storedRules = m.settings.gamerules || {};
  } catch {
    storedRules = {};
  }
  renderRules();
  setHint('rules-hint', '');
  setHint('tn-hint', '');
  loadTunnel();
  checkBuild();
}
const baseLoadSettingsExtras = loadSettingsExtras;
loadSettingsExtras = async function (force) {
  const before = extrasKey;
  await baseLoadSettingsExtras(force);
  if (extrasKey !== before || force) loadMore();
};

// ---- запуск вместе с Windows ----

const baseLoadPrefs = loadPrefs;
loadPrefs = async function () {
  await baseLoadPrefs();
  try {
    const p = await api.call('ui:getPrefs');
    $('pf-autostart').checked = p.autostart;
    $('pf-autoserver').checked = p.autoStartServer;
  } catch {
    /* по умолчанию */
  }
};
for (const id of ['pf-autostart', 'pf-autoserver']) {
  $(id).addEventListener('change', () =>
    api.call('ui:setPrefs', { autostart: $('pf-autostart').checked, autoStartServer: $('pf-autoserver').checked }).catch(fail)
  );
}

// ---- копии в облачную папку ----

const baseRenderMaint = renderMaint;
renderMaint = function () {
  baseRenderMaint();
  if (!mtData) return;
  const m = mtData.settings.backup.mirror || '';
  $('bk-mirror').value = m;
  $('bk-mirror-off').hidden = !m;
};
async function setMirror(mirror) {
  try {
    mtData.settings = await api.call('maint:set', { ...selected(), settings: { backup: { mirror } } });
    renderMaint();
    setHint('bk-mirror-hint', mirror ? `Копии будут складываться ещё и в «${mirror}».` : 'Копии хранятся только на этом компьютере.', 'good');
  } catch (e) {
    setHint('bk-mirror-hint', e.message, 'bad');
  }
}
$('bk-mirror-pick').addEventListener('click', async () => {
  const dir = await api.call('backup:pickMirror').catch((e) => (fail(e), null));
  if (dir) setMirror(dir);
});
$('bk-mirror-off').addEventListener('click', () => setMirror(''));

// ---- игроки: кто заходил ----

function durText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'меньше минуты';
  const h = Math.floor(min / 60);
  return h ? `${h} ч ${min % 60} мин` : `${min} мин`;
}
function agoText(ms) {
  if (!ms) return '—';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (Date.now() - ms < 3600000) return 'только что';
  if (new Date(ms).toDateString() === new Date().toDateString()) return 'сегодня';
  if (days <= 1) return 'вчера';
  if (days < 30) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
async function loadPlayerStats() {
  const box = $('pl-all');
  let list = [];
  try {
    list = await api.call('players:stats', selected());
  } catch {
    list = [];
  }
  if (!list.length) {
    box.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Пока никто не заходил — здесь появятся игроки, их время в игре и последний вход.';
    box.appendChild(p);
    return;
  }
  box.replaceChildren(
    ...list.map((pl) => {
      const row = document.createElement('div');
      row.className = 'pl-row';
      const img = document.createElement('img');
      img.className = 'pl-face';
      img.alt = '';
      img.loading = 'lazy';
      img.src = `https://mc-heads.net/avatar/${encodeURIComponent(pl.name)}/32`;
      img.addEventListener('error', () => img.classList.add('none'));
      const t = document.createElement('div');
      t.className = 'pl-t';
      const b = document.createElement('b');
      b.textContent = pl.name;
      const sub = document.createElement('span');
      sub.textContent = `В игре ${durText(pl.total)} · последний вход: ${agoText(pl.last)}`;
      t.append(b, sub);
      const acts = document.createElement('div');
      acts.className = 'pl-acts';
      for (const [label, fn, cls] of [
        ['Оператор', () => plAction('ops', 'add', pl.name)],
        ['В белый список', () => plAction('whitelist', 'add', pl.name)],
        ['Бан', () => window.confirm(`Забанить ${pl.name}?`) && plAction('bans', 'add', pl.name), 'danger'],
      ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn small' + (cls ? ' ' + cls : '');
        btn.textContent = label;
        btn.addEventListener('click', fn);
        acts.appendChild(btn);
      }
      row.append(img, t, acts);
      return row;
    })
  );
}
const baseLoadPlayers = loadPlayers;
loadPlayers = async function () {
  await baseLoadPlayers();
  loadPlayerStats();
};

// ---- приглашение друзей ----

let lastPublic = ''; // адрес, который проверка доступа из интернета подтвердила
function inviteText() {
  const v = $('version').value;
  const suffix = port === '25565' ? '' : ':' + port;
  const vpn = addresses.find((a) => a.vpn);
  let addr;
  let note = '';
  if (tunnel.address) addr = tunnel.address;
  else if (lastPublic) addr = lastPublic;
  else if (serverIp) addr = serverIp + suffix;
  else if (vpn) {
    addr = vpn.address + suffix;
    note = `\nСначала подключись к моей сети в ${/radmin/i.test(vpn.name) ? 'Radmin VPN' : /hamachi/i.test(vpn.name) ? 'Hamachi' : /zerotier/i.test(vpn.name) ? 'ZeroTier' : 'VPN'} (${vpn.name}).`;
  } else {
    const lan = addresses[0];
    addr = (lan ? lan.address : 'localhost') + suffix;
    note = '\nЭто адрес в домашней сети — работает, если ты подключён к тому же Wi-Fi.';
  }
  const lines = [
    `Заходи ко мне на сервер Minecraft «${serverTitle(type, v)}»!`,
    `Адрес: ${addr}`,
    `Версия игры: Minecraft ${v}`,
  ];
  if (kinds().includes('mod')) {
    const flavor = FLAVOR_NAMES[isHybrid() ? currentFlavor() : type] || LOADER_NAMES[type];
    lines.push(`Нужны моды (${flavor}) — пришлю сборку файлом. Проще всего открыть её в Modrinth App или Prism Launcher: всё поставится само.`);
  }
  lines.push('В игре: «Сетевая игра» → «Добавить» → вставь адрес.');
  return lines.join('\n') + note;
}
function toggleInvite() {
  let box = $('invite');
  if (box) {
    box.remove();
    return;
  }
  box = document.createElement('div');
  box.id = 'invite';
  box.className = 'invite';
  const ta = document.createElement('textarea');
  ta.value = inviteText();
  ta.rows = 6;
  ta.setAttribute('aria-label', 'Текст приглашения');
  const row = document.createElement('div');
  row.className = 'row';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn primary small';
  copy.textContent = 'Скопировать';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(ta.value).catch(() => {});
    copy.textContent = 'Скопировано';
    setTimeout(() => (copy.textContent = 'Скопировать'), 1500);
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn small';
  close.textContent = 'Закрыть';
  close.addEventListener('click', () => box.remove());
  row.append(copy, close);
  box.append(ta, row);
  $('address').after(box);
}
const baseRenderAddress = renderAddress;
renderAddress = function (show) {
  baseRenderAddress(show);
  if (!show) {
    const inv = $('invite');
    if (inv) inv.remove();
    return;
  }
  const box = $('address');
  if (tunnel.address) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'addr-chip';
    chip.title = 'Скопировать адрес';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = 'через playit.gg';
    chip.append(tunnel.address, sub);
    chip.addEventListener('click', () => navigator.clipboard.writeText(tunnel.address).catch(() => {}));
    box.querySelector('.label').after(chip);
  }
  const inv = document.createElement('button');
  inv.type = 'button';
  inv.className = 'link-btn invite-btn';
  inv.textContent = 'Пригласить друзей';
  inv.addEventListener('click', toggleInvite);
  box.insertBefore(inv, box.querySelector('.net-check'));
  renderQuick();
};
// Запоминаем адрес, если проверка подтвердила, что сервер виден из интернета.
const baseCheckInternet = checkInternet;
checkInternet = async function () {
  await baseCheckInternet();
  const text = $('net-result').textContent;
  const m = text.match(/Адрес для друзей: (\S+)/);
  if (m) lastPublic = m[1];
};

// ---- готовый сервер из другой папки ----

$('import-server').addEventListener('click', async () => {
  let r;
  try {
    r = await api.call('server:importPick');
  } catch (e) {
    setHint('type-hint', e.message, 'bad');
    return;
  }
  if (!r) return;
  wz.import = r;
  const what = [r.hasWorld ? 'мир' : null, r.mods ? `моды (${r.mods})` : null, r.plugins ? `плагины (${r.plugins})` : null, 'настройки'].filter(Boolean).join(', ');
  if (!r.type) {
    setHint('type-hint', `Папка «${r.name}»: не удалось понять, какой это сервер. Выберите тип сам — затем версию. Перенесутся ${what}.`, 'warn');
    return;
  }
  type = r.type;
  store.set('type', type);
  pinVersion = r.version || '';
  wz.step = 2;
  $('version').replaceChildren();
  render();
  await loadVersions();
  setHint('version-hint', `Найден сервер ${TYPE_SHORT[r.type]} ${r.version || '(версию выберите сами)'} в папке «${r.name}». Перенесутся ${what}; исходная папка не изменится.`, 'good');
});
const baseFillLoaders = fillLoaders;
fillLoaders = function () {
  baseFillLoaders();
  const want = mode === 'wizard' && wz.import && wz.import.loader;
  if (want && [...$('loader').options].some((o) => o.value === want)) $('loader').value = want;
};

// Обновлять быстрые кнопки вместе с остальным окном.
const baseRenderShellMore = renderShell;
renderShell = function () {
  baseRenderShellMore();
  renderQuick();
};
