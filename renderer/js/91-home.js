// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- «Мои миры»: все серверы карточками с картой мира ----
// Режим 'home' показывается поверх выбранного сервера: тот остаётся загруженным,
// и открыть его из карточки можно мгновенно.

const homeMaps = new Map(); // `${type}|${version}` → data:-картинка карты или null
let homeStats = null; // последние stats работающего сервера
let homeOnline = []; // кто сейчас на работающем сервере

const homeKey = (s) => `${s.type}|${s.version}`;

/** Состояние сервера из списка: работает ли он (обычно или в фоне). */
function homeState(s) {
  if (running && running.type === s.type && running.version === s.version && state !== 'stopped') return state;
  const bg = typeof bgList !== 'undefined' ? bgList.find((b) => b.key === `${s.type}-${s.version}`) : null;
  return bg ? bg.state : 'stopped';
}
const isMainRunning = (s) => !!running && running.type === s.type && running.version === s.version && state !== 'stopped';

function openHome() {
  if (mode === 'wizard' && typeof confirmDiscard === 'function' && !confirmDiscard()) return;
  mode = 'home';
  renderShell();
}

/** Открыть сервер из карточки; then — что сделать после (запустить, остановить). */
async function openFromHome(s, then) {
  if (type === s.type && $('version').value === s.version && mode === 'home') {
    mode = 'server';
    renderShell();
    render();
  } else {
    await selectServer(s.type, s.version);
  }
  if (then === 'start') $('start').click();
  if (then === 'stop') $('stop').click();
}

function worldMap(s, cls = '') {
  const box = el('div', 'world-map' + (cls ? ' ' + cls : ''));
  const url = homeMaps.get(homeKey(s));
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    box.appendChild(img);
  } else if (url === null) {
    box.appendChild(el('div', 'empty', s.installed ? 'Карта появится, когда в мире кто-нибудь побегает' : 'Мир создастся при первом запуске'));
  }
  return box;
}

function stateChip(st) {
  const txt = { running: 'Работает', starting: 'Запускается', stopping: 'Останавливается', downloading: 'Скачивается', installing: 'Устанавливается' }[st] || 'Выключен';
  return el('span', 'wstate' + (st === 'running' ? ' on' : st !== 'stopped' ? ' busy' : ''), txt);
}

function friendAddress(s) {
  const suffix = s.port === 25565 ? '' : ':' + s.port;
  if (s.tunnel) return { text: s.tunnel, sub: 'Через playit.gg — из любой сети' };
  const lan = (addresses || []).find((a) => !a.vpn) || (addresses || [])[0];
  return lan ? { text: lan.address + suffix, sub: 'Для друзей в вашей сети' } : null;
}

function uptimeText(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function renderHero(s) {
  const box = $('home-hero');
  box.replaceChildren();
  if (!s) return;
  const st = homeState(s);
  const live = isMainRunning(s);
  const wrap = el('section', 'home-hero');
  const map = worldMap(s, st === 'stopped' ? 'off' : '');
  if (homeMaps.get(homeKey(s))) map.appendChild(el('span', 'map-legend', 'Карта мира вокруг точки 0, 0'));
  wrap.appendChild(map);
  // Где игроки: последние сохранённые места, работающие — ярче.
  if (homeMaps.get(homeKey(s))) {
    api
      .call('map:regions', { type: s.type, version: s.version, dim: 'overworld' })
      .then((r) => {
        for (const p of (r.players || []).slice(0, 8)) {
          if (Math.abs(p.x) >= 512 || Math.abs(p.z) >= 512) continue;
          const pin = el('div', 'pin' + (p.online ? '' : ' off'));
          pin.style.left = ((p.x + 512) / 1024) * 100 + '%';
          pin.style.top = ((p.z + 512) / 1024) * 100 + '%';
          const tag = el('span');
          const head = document.createElement('img');
          head.src = `https://mc-heads.net/avatar/${encodeURIComponent(p.name)}/18`;
          head.alt = '';
          tag.append(head, p.name);
          pin.appendChild(tag);
          map.appendChild(pin);
        }
      })
      .catch(() => {});
  }

  const info = el('div', 'hero-info');
  const top = el('div');
  top.append(stateChip(st));
  const h = el('h2', '', s.name || `${TYPE_SHORT[s.type] || s.type} ${s.version}`);
  top.append(h, el('div', 'meta', `${KIND_TEXT[s.type] || s.type} · Minecraft ${s.version}`));
  info.appendChild(top);

  const addr = friendAddress(s);
  if (addr && st !== 'stopped') {
    const a = el('div', 'hero-addr');
    const t = el('div');
    t.append(el('small', '', addr.sub), el('b', '', addr.text));
    const copy = el('button', 'btn small', 'Скопировать');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(addr.text);
        copy.textContent = 'Скопировано';
        setTimeout(() => (copy.textContent = 'Скопировать'), 1600);
      } catch {
        /* буфер обмена недоступен */
      }
    });
    a.append(t, copy);
    info.appendChild(a);
  }

  const facts = el('div', 'hero-facts');
  const fact = (k, v, cls = '') => {
    const d = el('div');
    d.append(el('small', '', k), el('b', cls, v));
    facts.appendChild(d);
  };
  if (live && state === 'running') {
    fact('Игроки', `${homeOnline.length} из ${s.maxPlayers}`);
    const tps = homeStats && homeStats.tps ? homeStats.tps.tps : null;
    if (tps == null) fact('Плавность', '—');
    else if (tps >= 18) fact('Плавность', 'Без лагов', 'ok');
    else fact('Плавность', `${String(Math.round(tps * 10) / 10).replace('.', ',')} TPS`);
    fact('Работает', homeStats ? uptimeText(homeStats.uptime) : '—');
  } else {
    fact('Запускался', s.lastPlayed ? lastPlayedText(s.lastPlayed).replace(/^Запускался /, '') : '—');
    fact('Игроков', `до ${s.maxPlayers}`);
    fact('Порт', String(s.port));
  }
  info.appendChild(facts);

  const acts = el('div', 'hero-acts');
  const btn = (text, cls, fn) => {
    const b = el('button', 'btn ' + cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    acts.appendChild(b);
  };
  if (st === 'stopped') {
    btn('Запустить', 'primary big', () => openFromHome(s, 'start'));
    btn('Открыть', 'big', () => openFromHome(s));
  } else {
    btn('Открыть сервер', 'primary big', () => openFromHome(s));
    btn('Остановить', 'ghost big', () => openFromHome(s, 'stop'));
  }
  info.appendChild(acts);
  wrap.appendChild(info);
  box.appendChild(wrap);
}

function renderHome() {
  const list = servers.slice();
  // Главная карточка — работающий сервер, иначе тот, в который играли последним.
  const hero = list.find((s) => homeState(s) !== 'stopped') || list[0] || null;
  const live = list.filter((s) => homeState(s) === 'running');
  const people = homeOnline.length;
  $('home-sub').innerHTML = '';
  if (live.length) {
    const b = el('b', '', `${live.length} ${plural(live.length, 'сервер работает', 'сервера работают', 'серверов работают')}`);
    $('home-sub').append(b, people ? `, в игре ${people} ${plural(people, 'человек', 'человека', 'человек')}` : ', пока никого нет');
  } else {
    $('home-sub').textContent = list.length ? `${list.length} ${plural(list.length, 'мир', 'мира', 'миров')} · все выключены` : 'Здесь появятся ваши серверы';
  }
  renderHero(hero);

  const grid = $('home-grid');
  grid.replaceChildren(
    ...list
      .filter((s) => s !== hero)
      .map((s) => {
        const st = homeState(s);
        const card = el('div', 'world');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        const map = worldMap(s, st === 'stopped' ? 'off' : '');
        map.appendChild(stateChip(st));
        const row = el('div', 'w-row');
        if (s.icon) {
          const ic = document.createElement('img');
          ic.className = 'w-ico';
          ic.src = s.icon;
          ic.alt = '';
          row.appendChild(ic);
        }
        const t = el('div');
        t.append(el('h3', '', s.name || `${TYPE_SHORT[s.type] || s.type} ${s.version}`), el('small', '', `${TYPE_SHORT[s.type] || s.type} ${s.version} · ${st === 'stopped' ? lastPlayedText(s.lastPlayed).toLowerCase() : 'работает'}`));
        row.appendChild(t);
        const b = el('button', 'btn small' + (st === 'stopped' ? ' primary' : ''), st === 'stopped' ? 'Запустить' : 'Открыть');
        b.type = 'button';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          openFromHome(s, st === 'stopped' ? 'start' : null);
        });
        row.appendChild(b);
        card.append(map, row);
        card.addEventListener('click', () => openFromHome(s));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFromHome(s);
          }
        });
        return card;
      }),
    (() => {
      const n = el('button', 'world new-world');
      n.type = 'button';
      n.append(el('b', '', '+'), 'Новый мир');
      n.addEventListener('click', openWizard);
      return n;
    })()
  );
  loadHomeMaps(list);
}

let homeMapsBusy = false;
async function loadHomeMaps(list) {
  if (homeMapsBusy) return;
  const todo = list.filter((s) => !homeMaps.has(homeKey(s)));
  if (!todo.length) return;
  homeMapsBusy = true;
  for (const s of todo) {
    try {
      homeMaps.set(homeKey(s), await api.call('map:preview', { type: s.type, version: s.version }));
    } catch {
      homeMaps.set(homeKey(s), null);
    }
  }
  homeMapsBusy = false;
  if (mode === 'home') renderHome();
}

// ---- встраиваемся в оболочку ----

const baseRenderShellHome = renderShell;
renderShell = function () {
  $('home').hidden = mode !== 'home';
  baseRenderShellHome();
  if (mode === 'home') {
    $('server').hidden = true;
    $('wizard').hidden = true;
    renderHome();
  }
  $('srv-home').setAttribute('aria-current', String(mode === 'home'));
};
const baseCloseWizardHome = closeWizard;
closeWizard = function () {
  if (!wz.prev && servers.length) {
    wz.import = null;
    openHome();
    return;
  }
  baseCloseWizardHome();
};

$('srv-home').addEventListener('click', openHome);
$('home-new').addEventListener('click', openWizard);
api.on('stats', (s) => {
  homeStats = s;
});
api.on('players', (p) => {
  homeOnline = Array.isArray(p.online) ? p.online : [];
  if (mode === 'home') renderHome();
});
api.on('state', () => {
  if (state === 'stopped') {
    homeOnline = [];
    homeStats = null;
  }
});
// Карта меняется, пока в мире играют, — раз в 5 минут перечитываем.
setInterval(() => {
  homeMaps.clear();
  if (mode === 'home') renderHome();
}, 5 * 60000);
