// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- оболочка: список серверов слева, мастер создания, тема ----

let mode = 'server'; // 'server' — открыт сервер, 'wizard' — создаём новый
let servers = []; // серверы на диске (servers:list)
let pinVersion = ''; // версия открытого сервера — loadVersions держит её в списке
let theme = 'system';
const wz = { step: 1, prev: null };

const TYPE_SHORT = {
  vanilla: 'Minecraft', paper: 'Paper', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge',
  youer: 'Youer', arclight: 'Arclight', mohist: 'Mohist',
};
const KIND_TEXT = {
  vanilla: 'Обычный сервер',
  paper: 'С плагинами · Paper',
  fabric: 'С модами · Fabric',
  forge: 'С модами · Forge',
  neoforge: 'С модами · NeoForge',
  youer: 'Моды и плагины · Youer',
  arclight: 'Моды и плагины · Arclight',
  mohist: 'Моды и плагины · Mohist',
};
const kindOf = (t) => (t === 'vanilla' || t === 'paper' ? t : 'mods');

const findServer = (t, v) => servers.find((x) => x.type === t && x.version === v);
/** Название сервера: своё, если задано, иначе «Paper 1.21.4». */
function serverTitle(t, v) {
  const s = findServer(t, v);
  return (s && s.name) || `${TYPE_SHORT[t] || t} ${v}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function lastPlayedText(ms) {
  if (!ms) return 'Ещё не запускался';
  const day = 86400000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() + day - ms) / day);
  if (days <= 0) return 'Запускался сегодня';
  if (days === 1) return 'Запускался вчера';
  if (days < 30) return `Запускался ${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return 'Запускался ' + new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

// ---- список серверов ----

async function refreshServers() {
  try {
    servers = await api.call('servers:list');
  } catch {
    servers = [];
  }
  renderShell();
}

function renderServerList() {
  const box = $('srv-list');
  const rows = servers.map((s) => ({ ...s }));
  // Только что созданный сервер появляется в списке после установки — до этого показываем его сами.
  const cur = mode === 'server' && $('version').value ? { type, version: $('version').value } : null;
  if (cur && !findServer(cur.type, cur.version)) rows.unshift({ ...cur, name: null, fresh: true });
  box.replaceChildren(
    ...rows.map((s) => {
      const isRunning = !!running && running.type === s.type && running.version === s.version;
      const bgE = typeof bgList !== 'undefined' ? bgList.find((b) => b.key === `${s.type}-${s.version}`) : null;
      const st = isRunning ? state : bgE ? bgE.state : 'stopped';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'srv-row' + (st === 'running' ? ' on' : st !== 'stopped' ? ' busy' : '');
      const sel = cur && cur.type === s.type && cur.version === s.version;
      if (sel) b.setAttribute('aria-current', 'true');
      const dot = document.createElement('span');
      dot.className = 'srv-dot';
      const t = document.createElement('span');
      t.className = 't';
      const title = document.createElement('b');
      title.textContent = s.name || `${TYPE_SHORT[s.type] || s.type} ${s.version}`;
      const sub = document.createElement('span');
      sub.textContent =
        st !== 'stopped'
          ? STATE_TEXT[st]
          : s.fresh
            ? 'Новый — ещё не установлен'
            : s.name
              ? `${TYPE_SHORT[s.type]} ${s.version} · ${lastPlayedText(s.lastPlayed).replace('Запускался ', '').replace('Ещё не запускался', 'не запускался')}`
              : lastPlayedText(s.lastPlayed);
      t.append(title, sub);
      b.append(dot, t);
      b.addEventListener('click', () => {
        if (!sel) selectServer(s.type, s.version);
      });
      return b;
    })
  );
  $('srv-group').hidden = !rows.length;
  if (mode === 'wizard') $('srv-new').setAttribute('aria-current', 'true');
  else $('srv-new').removeAttribute('aria-current');
}

/** Открыть сервер из списка. */
async function selectServer(t, v) {
  if (mode === 'server' && type === t && $('version').value === v) return;
  if (!confirmDiscard()) return;
  resetConfigs();
  mode = 'server';
  type = t;
  pinVersion = v;
  store.set('type', t);
  store.set('version:' + t, v);
  $('srv-name-input').value = (findServer(t, v) || {}).name || '';
  setHint('name-hint', '');
  $('version').replaceChildren();
  await loadVersions();
}

// ---- мастер ----

function openWizard() {
  if (mode === 'wizard') return;
  if (!confirmDiscard()) return;
  resetConfigs();
  wz.prev = $('version').value && mode === 'server' ? { type, version: $('version').value } : null;
  wz.import = null;
  mode = 'wizard';
  wz.step = 1;
  pinVersion = '';
  $('wz-name').value = '';
  $('wz-seed').value = '';
  $('wz-level').value = 'normal';
  wzWorld = 'new';
  $('eula').checked = false;
  // Предлагаем то, что выбирают чаще всего; пользователь поменяет одним нажатием.
  // Если до этого был открыт сервер — начинаем с его типа.
  pickType(wz.prev ? type : 'paper', true);
}

/** Выбор типа в мастере; force — заново загрузить версии, даже если тип тот же. */
function pickType(t, force = false) {
  if (!force && type === t) {
    renderShell();
    return;
  }
  type = t;
  store.set('type', t);
  $('version').replaceChildren();
  render();
  loadVersions({ fresh: true });
}

function closeWizard() {
  wz.import = null;
  if (wz.prev) {
    // Возвращаемся к серверу, который был открыт до мастера.
    selectServer(wz.prev.type, wz.prev.version);
  } else {
    render();
  }
}

/** Поля, которые в мастере и во вкладке «Настройки» одни и те же, — переносим туда, где они нужны. */
function placeFields() {
  const put = (id, parentId) => {
    const el = $(id);
    const parent = $(parentId);
    if (el.parentElement !== parent) parent.appendChild(el);
  };
  if (mode === 'wizard' && wz.step === 2) {
    put('version-block', 'wz-version-slot');
    put('loader-row', 'wz-version-slot');
  } else {
    put('version-block', 'holder');
    put('loader-row', 'home-loader');
  }
  if (mode === 'wizard' && wz.step === 3) {
    put('launch-block', 'wz-launch-slot');
    put('eula-row', 'wz-eula-slot');
  } else {
    put('launch-block', 'home-launch');
    put('eula-row', 'home-eula');
  }
}

function wizardReady(step) {
  if (step === 1) return !!type;
  if (step === 2) return !!$('version').value && !!info && (!isModded() || !!$('loader').value);
  return true;
}

function renderWizard() {
  const s = wz.step;
  for (const el of document.querySelectorAll('.steps .step')) {
    const n = Number(el.dataset.step);
    el.classList.toggle('cur', n === s);
    el.classList.toggle('done', n < s);
    if (n === s) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  }
  for (const page of document.querySelectorAll('.wz-page')) page.hidden = Number(page.dataset.page) !== s;
  const kind = kindOf(type);
  for (const c of document.querySelectorAll('.choice')) c.setAttribute('aria-checked', String(c.dataset.kind === kind));
  $('wz-flavors').hidden = kind !== 'mods';
  for (const b of document.querySelectorAll('[data-flavor]')) b.setAttribute('aria-checked', String(b.dataset.flavor === type));
  for (const b of document.querySelectorAll('[data-wz="cancel"]')) b.hidden = !wz.prev && !servers.length;
  for (const b of document.querySelectorAll('.wz-page[data-page="1"] [data-wz="next"]')) b.disabled = !wizardReady(1);
  for (const b of document.querySelectorAll('.wz-page[data-page="2"] [data-wz="next"]')) b.disabled = !wizardReady(2);

  if (s === 3) {
    if (typeof renderWizardWorld === 'function') renderWizardWorld();
    const v = $('version').value;
    const loaderText = isModded() && $('loader').selectedOptions[0] ? `, ${$('loader').selectedOptions[0].textContent}` : '';
    $('wz-summary').textContent = wz.import
      ? `${KIND_TEXT[type]}, Minecraft ${v}${loaderText}. Из папки «${wz.import.name}» перенесутся мир, моды, плагины и настройки, а сам сервер лаунчер скачает заново.`
      : `${KIND_TEXT[type]}, Minecraft ${v}${loaderText}. Осталось выбрать память и принять лицензию Minecraft — файлы сервера скачаются при первом запуске.`;
    const create = $('wz-create');
    create.textContent = info && info.installed ? 'Открыть и запустить' : 'Создать и запустить';
    if (state !== 'stopped') {
      setHint('wz-hint', `Сейчас работает «${running ? serverTitle(running.type, running.version) : 'другой сервер'}». Остановите его — одновременно может работать только один сервер.`, 'warn');
    } else if (info && info.installed) {
      setHint('wz-hint', `Сервер ${TYPE_SHORT[type]} ${v} уже есть — откроется он, мир останется прежним.`, 'warn');
    } else {
      setHint('wz-hint', '');
    }
    const eulaOk = $('eula').checked || (info && info.eula);
    create.disabled = state !== 'stopped' || !info || !eulaOk || !renderRamHint() || !effectiveJava().java;
  }
}

async function createFromWizard() {
  const t = type;
  const v = $('version').value;
  const name = $('wz-name').value.trim();
  try {
    if (wz.import) {
      setHint('wz-hint', 'Переношу сервер…');
      await api.call('server:importCopy', { src: wz.import.path, type: t, version: v });
      wz.import = null;
    } else {
      await applyWizardWorld(t, v);
    }
    if (name) await api.call('maint:set', { type: t, version: v, settings: { name } });
  } catch (e) {
    setHint('wz-hint', e.message, 'bad');
    return;
  }
  mode = 'server';
  pinVersion = v;
  store.set('version:' + t, v);
  $('srv-name-input').value = name || (findServer(t, v) || {}).name || '';
  await startServer();
  refreshServers();
}

// ---- шапка сервера и вкладка «Настройки» ----

function renderServerHead() {
  const v = $('version').value;
  $('srv-name').textContent = v ? serverTitle(type, v) : TYPE_SHORT[type] || '';
  const loaderOpt = isModded() && $('loader').selectedOptions[0];
  $('srv-meta').textContent = v
    ? `${KIND_TEXT[type]} · Minecraft ${v}` + (loaderOpt && loaderOpt.value ? ` · ${loaderOpt.textContent}` : '')
    : '';
  $('type-line').textContent = v ? `${KIND_TEXT[type]}, Minecraft ${v}. ${TYPE_HINTS[type]}` : '';
  $('srv-name-input').placeholder = v ? `${TYPE_SHORT[type]} ${v}` : '';
}

function renderShell() {
  $('wizard').hidden = mode !== 'wizard';
  $('server').hidden = mode !== 'server';
  placeFields();
  if (mode === 'wizard') renderWizard();
  else renderServerHead();
  renderServerList();
  for (const b of document.querySelectorAll('[data-theme]')) b.setAttribute('aria-checked', String(b.dataset.theme === theme));
}

// ---- тема ----

async function loadTheme() {
  try {
    theme = await api.call('ui:getTheme');
  } catch {
    theme = 'system';
  }
  renderShell();
}
for (const b of document.querySelectorAll('[data-theme]')) {
  b.addEventListener('click', async () => {
    try {
      theme = await api.call('ui:setTheme', { theme: b.dataset.theme });
    } catch (e) {
      fail(e);
    }
    renderShell();
  });
}
// График мониторинга рисуется на canvas — перекрашиваем его вместе с темой.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!$('stats').hidden) drawStatsChart();
});

// ---- события ----

$('srv-new').addEventListener('click', openWizard);
for (const c of document.querySelectorAll('.choice')) {
  c.addEventListener('click', () => {
    const k = c.dataset.kind;
    if (k === 'mods') pickType(isModded() ? type : 'fabric');
    else pickType(k);
  });
}
for (const b of document.querySelectorAll('[data-flavor]')) b.addEventListener('click', () => pickType(b.dataset.flavor));
for (const b of document.querySelectorAll('[data-wz]')) {
  b.addEventListener('click', () => {
    const act = b.dataset.wz;
    if (act === 'cancel') return closeWizard();
    if (act === 'next' && !wizardReady(wz.step)) return;
    wz.step = Math.min(3, Math.max(1, wz.step + (act === 'next' ? 1 : -1)));
    renderShell();
    const page = document.querySelector(`.wz-page[data-page="${wz.step}"]`);
    const first = page && page.querySelector('select, input');
    if (first && wz.step > 1) first.focus();
  });
}
$('wz-create').addEventListener('click', createFromWizard);

$('srv-name-input').addEventListener('change', async () => {
  const v = $('version').value;
  if (!v) return;
  try {
    const r = await api.call('maint:set', { type, version: v, settings: { name: $('srv-name-input').value } });
    $('srv-name-input').value = r.name;
    setHint('name-hint', 'Сохранено.', 'good');
  } catch (e) {
    setHint('name-hint', e.message, 'bad');
  }
  refreshServers();
});
