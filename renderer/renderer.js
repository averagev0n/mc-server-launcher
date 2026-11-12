const $ = (id) => document.getElementById(id);
const api = window.launcher;

const TYPE_HINTS = {
  vanilla: 'Официальный сервер от Mojang, без модов и плагинов.',
  paper: 'Быстрее обычного, поддерживает плагины. Игрокам ничего ставить не нужно.',
  fabric: 'Лёгкий загрузчик модов. Игрокам нужен Fabric и те же моды.',
  forge: 'Классический загрузчик, больше всего старых модов и сборок. Игрокам нужен Forge и те же моды.',
  neoforge: 'Современная ветка Forge для новых версий. Игрокам нужен NeoForge и те же моды.',
  arclight: 'Гибрид: моды Fabric, Forge или NeoForge вместе с плагинами. Бывают несовместимости — почаще копируйте мир.',
  mohist: 'Гибрид: моды Forge вместе с плагинами, версии до 1.20. Бывают несовместимости — почаще копируйте мир.',
  youer: 'Гибрид: моды NeoForge вместе с плагинами, есть свежие версии. Бывают несовместимости — почаще копируйте мир.',
};
const LOADER_NAMES = {
  fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', arclight: 'Arclight', mohist: 'Mohist', youer: 'Youer',
};
const FLAVOR_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
const MODDED = Object.keys(LOADER_NAMES);
const HYBRIDS = ['arclight', 'mohist', 'youer'];
const STATE_TEXT = {
  stopped: 'Остановлен',
  downloading: 'Скачивается…',
  installing: 'Устанавливается…',
  starting: 'Запускается…',
  running: 'Работает',
  stopping: 'Останавливается…',
};
const MAX_LINES = 3000;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* настройки просто не запомнятся */
    }
  },
};

let type = store.get('type', 'vanilla');
if (!TYPE_HINTS[type]) type = 'vanilla';
let state = 'stopped';
let running = null; // { type, version } запущенного сервера
let javas = [];
let info = null; // сведения о выбранной версии
let loaders = null; // { list, recommended }
let port = '25565';
let serverIp = ''; // server-ip запущенного/выбранного сервера
let addresses = [];
let tab = 'console';
let modsView = 'search';
let installedMods = [];
let search = { query: '', offset: 0, total: 0, hits: [], key: '' };
let installing = new Set();
let memory = null; // { totalGb, maxGb } — память компьютера
let detailsToken = 0;
let versionsToken = 0;

let modsKind = store.get('modsKind', 'mod'); // для гибридов: что показывать — моды или плагины

const isModded = (t = type) => MODDED.includes(t);
const isHybrid = (t = type) => HYBRIDS.includes(t);

/** Что можно ставить на выбранный сервер. */
function kinds() {
  if (type === 'vanilla') return [];
  if (type === 'paper') return ['plugin'];
  return isHybrid() ? ['mod', 'plugin'] : ['mod'];
}
function currentKind() {
  const k = kinds();
  return k.includes(modsKind) ? modsKind : k[0];
}
const contentWord = () => (currentKind() === 'plugin' ? { many: 'Плагины', one: 'плагин' } : { many: 'Моды', one: 'мод' });

const flavorOf = (id) => {
  const m = String(id || '').match(/^arclight-(fabric|forge|neoforge)-/);
  return m ? m[1] : null;
};
/** Загрузчик модов, на котором работает гибрид. */
function currentFlavor() {
  if (type === 'mohist') return 'forge';
  if (type === 'youer') return 'neoforge';
  if (type !== 'arclight') return null;
  return flavorOf((info && info.installedLoader) || $('loader').value);
}

const modsKey = () => `${selKey()}|${currentKind()}`;
const modsArgs = () => ({ ...selected(), kind: currentKind(), loader: isModded() ? $('loader').value : null });

// ---- журнал ----

function addLog(text, kind = 'info') {
  const box = $('log');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text;
  box.appendChild(line);
  while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

function setHint(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'hint' + (cls ? ' ' + cls : '');
  return el;
}

function addLink(el, text, onClick) {
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = text;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  el.appendChild(a);
}

const fail = (e) => addLog(e.message, 'error');

// ---- выбор ----

function selected() {
  return { type, version: $('version').value };
}
const selKey = () => `${type}|${$('version').value}`;

function isSelectedRunning() {
  return !!running && running.type === type && running.version === $('version').value;
}

/** Java, которую возьмёт лаунчер (повторяет логику main.js). */
function effectiveJava() {
  const need = info && info.javaNeeded;
  const choice = $('java').value;
  if (choice && choice !== 'auto') {
    const j = javas.find((x) => x.path === choice);
    return { java: j || null, need, manual: true };
  }
  const ok = javas.filter((j) => !need || j.major >= need);
  if (!ok.length) return { java: null, need, manual: false };
  const major = isModded() && need ? ok[ok.length - 1].major : ok[0].major;
  return { java: ok.find((j) => j.major === major), need, manual: false };
}

function needsInstall() {
  if (!info || !info.installed) return true;
  return isModded() && $('loader').value && info.installedLoader !== $('loader').value;
}

// ---- отрисовка ----

function renderJavaHint() {
  const { java, need, manual } = effectiveJava();
  const el = $('java-hint');
  el.textContent = '';
  if (!javas.length) {
    el.className = 'hint bad';
    el.textContent = 'Java не найдена — без неё сервер не запустится. ';
    addLink(el, 'Скачать Java', () => api.call('open:java', { version: need || 21 }).catch(fail));
    return false;
  }
  if (!java) {
    el.className = 'hint bad';
    el.textContent = need
      ? `Этой версии нужна Java ${need} или новее${manual ? ', а выбрана другая' : ''}. `
      : 'Выбранная Java не найдена. ';
    if (need) addLink(el, `Скачать Java ${need}`, () => api.call('open:java', { version: need }).catch(fail));
    return false;
  }
  if (need && java.major < need) {
    el.className = 'hint bad';
    el.textContent = `Этой версии нужна Java ${need}+, а выбрана Java ${java.major}.`;
    return false;
  }
  if (isModded() && need && java.major - need >= 4) {
    el.className = 'hint warn';
    el.textContent = `Будет Java ${java.major}. Старые модовые версии часто работают только на Java ${need} — если сервер не запустится, `;
    addLink(el, `установите Java ${need}`, () => api.call('open:java', { version: need }).catch(fail));
    el.append('.');
    return true;
  }
  el.className = 'hint good';
  el.textContent = `Будет Java ${java.major}${java.bits === 32 ? ' (32 бит, до 1 ГБ памяти)' : ''}` + (need ? ` — подходит (нужна ${need}+).` : '.');
  return true;
}

/** Подсказка под полем памяти; false — значение недопустимо. */
function renderRamHint() {
  const raw = String($('ram').value).trim();
  const n = Number(raw.replace(',', '.'));
  const max = memory ? memory.maxGb : 64;
  const total = memory ? memory.totalGb : null;
  if (!raw || !Number.isInteger(n) || n < 1 || n > max) {
    setHint('ram-hint', total
      ? `Можно от 1 до ${max} ГБ: в компьютере всего ${total} ГБ, часть нужна Windows.`
      : `Можно от 1 до ${max} ГБ.`, 'bad');
    return false;
  }
  if (!total) {
    setHint('ram-hint', '');
  } else if (n > total * 0.75) {
    setHint('ram-hint', `Это почти вся память компьютера (${total} ГБ). Windows и игре, если вы играете на этом же ПК, может не хватить.`, 'warn');
  } else {
    setHint('ram-hint', `В компьютере ${total} ГБ, серверу можно выделить до ${max} ГБ.`);
  }
  return true;
}

function render() {
  const busy = state !== 'stopped';
  const status = $('status');
  status.dataset.state = state;
  status.textContent = STATE_TEXT[state] + (busy && running ? ` · ${running.type} ${running.version}` : '');

  $('type').value = type;
  setHint('type-hint', TYPE_HINTS[type]);

  const modded = isModded();
  $('loader-row').hidden = !modded;
  $('loader-label').textContent = !modded
    ? ''
    : type === 'mohist' || type === 'youer'
      ? `Сборка ${LOADER_NAMES[type]}`
      : type === 'arclight'
        ? 'Загрузчик модов и версия Arclight'
        : `Версия ${LOADER_NAMES[type]}`;

  const hasVersion = !!$('version').value;
  const hasLoader = !modded || !!$('loader').value;
  const javaOk = renderJavaHint();
  const ramOk = renderRamHint();
  const eulaOk = $('eula').checked || (info && info.eula);
  const install = needsInstall();

  if (state === 'running') {
    $('start').disabled = false;
    $('start').textContent = 'Перезапустить';
  } else {
    $('start').disabled = busy || !hasVersion || !hasLoader || !info || !javaOk || !eulaOk || !ramOk;
    $('start').textContent = 'Запустить';
  }
  $('stop').disabled = !(state === 'starting' || state === 'running');
  $('cmd').disabled = $('send').disabled = !(state === 'starting' || state === 'running');

  for (const id of ['type', 'version', 'loader', 'pre', 'ram', 'java']) $(id).disabled = busy;
  $('eula-row').hidden = !!(info && info.eula);
  $('progress').hidden = !(state === 'downloading' || state === 'installing');
  $('progress').classList.toggle('busy', state === 'installing');
  $('save').disabled = !hasVersion;
  $('folder').disabled = !hasVersion;

  if (!info) {
    setHint('version-hint', '');
  } else if (!info.installed) {
    setHint('version-hint', 'Будет скачан и установлен при первом запуске.');
  } else if (install && type === 'arclight' && flavorOf(info.installedLoader) !== flavorOf($('loader').value)) {
    setHint('version-hint', `Сейчас установлен Arclight на ${FLAVOR_NAMES[flavorOf(info.installedLoader)] || '?'}. При запуске он сменится на ${FLAVOR_NAMES[flavorOf($('loader').value)]} — установленные моды под старый загрузчик работать перестанут.`, 'bad');
  } else if (install) {
    const label = loaders && loaders.list.find((l) => l.id === info.installedLoader);
    setHint('version-hint', `Установлен ${label ? label.label : info.installedLoader || '?'} — при запуске будет заменён на выбранный. Мир, моды и плагины сохранятся.`, 'warn');
  } else {
    setHint('version-hint', 'Уже установлен.');
  }

  const addr = $('address');
  addr.textContent = '';
  if (state === 'running') {
    const suffix = port === '25565' ? '' : ':' + port;
    const b = document.createElement('b');
    // Если сервер привязан к одному IP, работает только он (даже localhost — нет).
    b.textContent = serverIp
      ? serverIp + suffix
      : [`localhost${suffix}`, ...addresses.map((a) => a.address + suffix)].join('  ·  ');
    addr.append('Адрес: ', b);
  }

  renderTabs();
}

function renderTabs() {
  const words = contentWord();
  const modsTab = $('tab-mods');
  modsTab.textContent = isHybrid() ? 'Моды и плагины' : type === 'paper' ? 'Плагины' : 'Моды';
  if (installedMods.length && type !== 'vanilla' && !isHybrid()) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = installedMods.length;
    modsTab.appendChild(c);
  }
  // На вкладке «Консоль» — красный счётчик, если найдены ошибки, а пользователь на другой вкладке.
  const consoleTab = $('tab-console');
  consoleTab.textContent = 'Консоль';
  const errCount = issues.filter((i) => i.severity === 'error').length;
  if (errCount && tab !== 'console') {
    const c = document.createElement('span');
    c.className = 'count bad';
    c.textContent = errCount;
    c.title = 'Найдены ошибки — откройте консоль';
    consoleTab.appendChild(c);
  }
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  $('view-console').hidden = tab !== 'console';
  $('view-mods').hidden = tab !== 'mods';
  $('view-configs').hidden = tab !== 'configs';
  $('view-vps').hidden = tab !== 'vps';
  if (tab === 'vps' && vpsState.loaded && !vpsState.editing) renderVps();
  renderCfgHint();

  const off = type === 'vanilla';
  $('mods-off').hidden = !off;
  $('mods-on').hidden = off;
  for (const b of document.querySelectorAll('[data-mview]')) b.setAttribute('aria-selected', String(b.dataset.mview === modsView));
  $('mview-installed').textContent = `Установленные${installedMods.length ? ' · ' + installedMods.length : ''}`;
  $('mods-search').hidden = modsView !== 'search';
  $('mods-installed').hidden = modsView !== 'installed';
  $('search').placeholder = currentKind() === 'plugin' ? 'Название плагина, например: LuckPerms' : 'Название мода, например: JEI или Create';
  $('mods-kind').hidden = !isHybrid();
  for (const b of document.querySelectorAll('[data-mkind]')) b.setAttribute('aria-selected', String(b.dataset.mkind === currentKind()));

  const v = $('version').value;
  if (isSelectedRunning()) {
    setHint('mods-hint', `Изменения применятся после перезапуска сервера.`, 'warn');
  } else if (isHybrid() && v) {
    const fl = FLAVOR_NAMES[currentFlavor()];
    if (currentKind() === 'plugin') {
      setHint('mods-hint', `Плагины Paper/Bukkit для ${v}. Игрокам ставить их не нужно. На гибриде работают не все плагины.`);
    } else if (fl) {
      setHint('mods-hint', `Моды для ${fl} ${v}. Игрокам нужен ${fl} и те же моды.`);
    } else {
      setHint('mods-hint', 'Сначала выберите сборку — от неё зависит, какие моды подходят.', 'warn');
    }
  } else if (isModded() && v) {
    setHint('mods-hint', `Подбираются ${words.many.toLowerCase()} для ${LOADER_NAMES[type]} ${v}. Игрокам нужны те же ${words.many.toLowerCase()}.`);
  } else if (v) {
    setHint('mods-hint', `Подбираются плагины для Paper ${v}. Игрокам ставить ничего не нужно.`);
  } else {
    setHint('mods-hint', '');
  }
}

// ---- моды ----

function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' млн';
  if (n >= 1e3) return Math.round(n / 1e3) + ' тыс.';
  return String(n);
}
function formatSize(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(1).replace('.', ',') + ' МБ';
  return Math.max(1, Math.round(b / 1024)) + ' КБ';
}

function itemShell(iconUrl) {
  const row = document.createElement('div');
  row.className = 'item';
  const icon = document.createElement(iconUrl ? 'img' : 'div');
  icon.className = 'item-icon';
  if (iconUrl) {
    icon.src = iconUrl;
    icon.alt = '';
    icon.loading = 'lazy';
  }
  const body = document.createElement('div');
  body.className = 'item-body';
  row.append(icon, body);
  return { row, body };
}

function renderResults() {
  const box = $('results');
  box.replaceChildren();
  const have = new Set(installedMods.map((m) => m.projectId).filter(Boolean));
  for (const h of search.hits) {
    const { row, body } = itemShell(h.icon);
    const title = document.createElement('div');
    title.className = 'item-title';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'name';
    name.textContent = h.title;
    name.title = 'Открыть страницу на Modrinth';
    name.addEventListener('click', () => api.call('open:mod', { slug: h.slug, kind: h.type }).catch(fail));
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${h.author} · ${formatCount(h.downloads)} загрузок`;
    title.append(name, meta);
    const desc = document.createElement('p');
    desc.className = 'item-desc';
    desc.textContent = h.description;
    body.append(title, desc);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    if (have.has(h.id)) {
      btn.textContent = 'Установлен';
      btn.disabled = true;
    } else if (installing.has(h.id)) {
      btn.textContent = 'Ставлю…';
      btn.disabled = true;
    } else {
      btn.textContent = 'Установить';
      btn.classList.add('primary');
      btn.disabled = installing.size > 0;
      btn.addEventListener('click', () => installMod(h));
    }
    row.appendChild(btn);
    box.appendChild(row);
  }
  if (!search.hits.length && search.key) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = search.query ? 'Ничего не нашлось для этой версии.' : 'Нет ничего для этой версии.';
    box.appendChild(p);
  }
  $('more').hidden = search.hits.length >= search.total || !search.hits.length;
}

function renderInstalled() {
  const box = $('installed');
  box.replaceChildren();
  const words = contentWord();
  setHint(
    'installed-hint',
    installedMods.length
      ? `${words.many}: ${installedMods.length}. Удалённые файлы попадают в корзину.`
      : ''
  );
  for (const m of installedMods) {
    const { row, body } = itemShell(m.icon);
    const title = document.createElement('div');
    title.className = 'item-title';
    const name = document.createElement('span');
    name.className = 'name plain';
    name.textContent = m.title || m.file;
    title.appendChild(name);
    if (m.dependency) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'зависимость';
      title.appendChild(b);
    }
    const meta = document.createElement('p');
    meta.className = 'item-desc';
    meta.textContent = [m.version, m.title ? m.file : null, formatSize(m.size)].filter(Boolean).join(' · ');
    body.append(title, meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn danger';
    btn.textContent = 'Удалить';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.call('mods:remove', { ...modsArgs(), file: m.file });
        await refreshInstalled();
      } catch (e) {
        btn.disabled = false;
        setHint('installed-hint', e.message, 'bad');
      }
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  if (!installedMods.length) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = `${words.many} ещё не установлены. Найдите их во вкладке «Найти» или положите .jar-файлы в папку.`;
    box.appendChild(p);
  }
}

async function refreshInstalled() {
  const key = modsKey();
  if (type === 'vanilla' || !$('version').value) {
    installedMods = [];
  } else {
    try {
      const list = await api.call('mods:list', modsArgs());
      if (key !== modsKey()) return;
      installedMods = list;
    } catch (e) {
      fail(e);
    }
  }
  renderInstalled();
  renderResults();
  renderTabs();
}

async function runSearch(append) {
  if (type === 'vanilla' || !$('version').value) return;
  if (isHybrid() && currentKind() === 'mod' && !currentFlavor()) return;
  const key = modsKey();
  const query = append ? search.query : $('search').value.trim();
  const offset = append ? search.hits.length : 0;
  setHint('search-hint', 'Ищу на Modrinth…');
  try {
    const res = await api.call('mods:search', { ...modsArgs(), query, offset });
    if (key !== modsKey()) return;
    search = {
      key,
      query,
      total: res.total,
      hits: append ? search.hits.concat(res.hits) : res.hits,
    };
    setHint('search-hint', query ? `Найдено: ${res.total}` : `Популярное для этой версии · всего ${res.total}`);
    renderResults();
    if (!append) $('results').scrollTop = 0;
  } catch (e) {
    setHint('search-hint', 'Не удалось выполнить поиск: ' + e.message, 'bad');
  }
}

async function installMod(h) {
  installing.add(h.id);
  renderResults();
  setHint('search-hint', `Устанавливаю «${h.title}»… Подробности — во вкладке «Консоль».`);
  try {
    const added = await api.call('mods:install', { ...modsArgs(), projectId: h.id });
    const deps = added.length - 1;
    setHint(
      'search-hint',
      added.length
        ? `«${h.title}» установлен${deps > 0 ? `, а также зависимости: ${added.slice(1).join(', ')}` : ''}.`
        : `«${h.title}» уже был установлен.`,
      'good'
    );
  } catch (e) {
    setHint('search-hint', e.message, 'bad');
  }
  installing.delete(h.id);
  await refreshInstalled();
}

function resetMods() {
  search = { query: '', offset: 0, total: 0, hits: [], key: '' };
  installedMods = [];
  $('results').replaceChildren();
  $('installed').replaceChildren();
  setHint('search-hint', '');
  $('more').hidden = true;
}

/** При открытии вкладки — подгрузить список и популярное. */
function ensureMods() {
  if (tab !== 'mods' || type === 'vanilla' || !$('version').value) return;
  if (search.key !== modsKey()) runSearch(false);
}

// ---- конфиги ----

const FORMAT_NAMES = { yaml: 'YAML', json: 'JSON', toml: 'TOML', properties: 'Properties', text: 'Текст' };
const cfg = {
  key: '', // для какого сервера загружен список
  groups: [],
  file: null, // результат config:read
  mode: 'form',
  changes: new Map(), // id поля → новое значение
  invalid: new Set(),
  rows: [], // { el, section, text, field }
  textDirty: false,
  saved: false, // показывать ли «перезапустить» после сохранения
};

function cfgDirty() {
  return cfg.changes.size > 0 || cfg.textDirty;
}
function confirmDiscard() {
  return !cfgDirty() || window.confirm('Несохранённые изменения в настройках пропадут. Продолжить?');
}

function resetConfigs() {
  cfg.key = '';
  cfg.groups = [];
  cfg.file = null;
  cfg.changes.clear();
  cfg.invalid.clear();
  cfg.rows = [];
  cfg.textDirty = false;
  cfg.saved = false;
  $('cfg-tree').replaceChildren();
  $('cfg-form').replaceChildren();
}

function renderCfgHint() {
  if (!cfg.file) return;
  if (isSelectedRunning()) {
    setHint('cfg-hint', 'Сервер запущен: изменения применятся после перезапуска. Некоторые плагины перезаписывают свои файлы при остановке — если правка пропала, повторите её при остановленном сервере.', 'warn');
  } else {
    setHint('cfg-hint', cfg.mode === 'form' && cfg.file.formError ? cfg.file.formError : '', 'warn');
  }
  $('cfg-restart').hidden = !(cfg.saved && isSelectedRunning() && state === 'running');
}

function renderCfgTree() {
  const tree = $('cfg-tree');
  const q = $('cfg-find-file').value.trim().toLowerCase();
  tree.replaceChildren();
  for (const g of cfg.groups) {
    const files = g.files.filter((f) => !q || f.rel.toLowerCase().includes(q) || g.name.toLowerCase().includes(q));
    if (!files.length) continue;
    const head = document.createElement('div');
    head.className = 'cfg-group';
    head.textContent = g.name;
    tree.appendChild(head);
    for (const f of files) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cfg-file';
      b.title = f.rel;
      b.textContent = f.name;
      const folder = f.rel.split('/').slice(0, -1).pop();
      if (folder && folder !== g.name && !['plugins', 'config', 'serverconfig'].includes(folder)) {
        const dim = document.createElement('span');
        dim.className = 'dim';
        dim.textContent = ` · ${folder}`;
        b.appendChild(dim);
      }
      b.setAttribute('aria-current', String(!!cfg.file && cfg.file.rel === f.rel));
      b.addEventListener('click', () => openConfig(f.rel));
      tree.appendChild(b);
    }
  }
}

async function loadConfigList() {
  const key = selKey();
  try {
    const groups = await api.call('config:list', selected());
    if (key !== selKey()) return;
    cfg.key = key;
    cfg.groups = groups;
  } catch (e) {
    fail(e);
    return;
  }
  const empty = !cfg.groups.length;
  $('cfg-empty').hidden = !empty;
  $('cfg-main').hidden = empty;
  if (empty) {
    $('cfg-empty-text').textContent = info && info.installed
      ? 'Запустите сервер хотя бы один раз — плагины и моды создают свои файлы настроек при старте.'
      : 'Сервер ещё не установлен. Запустите его один раз — тогда появятся файлы настроек.';
  }
  if (cfg.file && !cfg.groups.some((g) => g.files.some((f) => f.rel === cfg.file.rel))) {
    cfg.file = null;
  }
  renderCfgTree();
  renderCfgEditor();
}

function ensureConfigs() {
  if (tab !== 'configs' || !$('version').value) return;
  if (cfg.key !== selKey()) {
    resetConfigs();
    loadConfigList();
  }
}

async function openConfig(rel, force) {
  if (!force && cfg.file && cfg.file.rel === rel) return;
  if (!force && !confirmDiscard()) return;
  try {
    const file = await api.call('config:read', { ...selected(), rel });
    showConfig(file);
  } catch (e) {
    setHint('cfg-status', e.message, 'bad');
  }
}

function showConfig(file, keepMode) {
  cfg.file = file;
  cfg.changes.clear();
  cfg.invalid.clear();
  cfg.textDirty = false;
  if (!keepMode) {
    cfg.mode = file.fields && file.fields.length ? 'form' : 'text';
    $('cfg-filter').value = '';
  }
  buildForm();
  $('cfg-text').value = file.text;
  renderCfgTree();
  renderCfgEditor();
}

function fieldControl(f, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'cfg-ctl';
  const id = `cfg-f-${f.id}`;
  if (f.type === 'bool') {
    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = !!f.value;
    const track = document.createElement('span');
    track.className = 'track';
    const text = document.createElement('span');
    text.textContent = f.value ? 'Да' : 'Нет';
    input.addEventListener('change', () => {
      text.textContent = input.checked ? 'Да' : 'Нет';
      onChange(input.checked, true);
    });
    label.append(input, track, text);
    wrap.appendChild(label);
  } else if (f.type === 'enum') {
    const sel = document.createElement('select');
    sel.id = id;
    for (const o of f.options) sel.appendChild(new Option(o, o));
    sel.value = f.value;
    sel.addEventListener('change', () => onChange(sel.value, true));
    wrap.appendChild(sel);
  } else if (f.type === 'list' || f.multiline) {
    const ta = document.createElement('textarea');
    ta.id = id;
    const lines = f.type === 'list' ? f.value : String(f.value).split('\n');
    ta.rows = Math.min(10, Math.max(2, lines.length + (f.type === 'list' ? 1 : 0)));
    ta.value = f.type === 'list' ? f.value.join('\n') : f.value;
    if (f.type === 'list') ta.placeholder = 'По одному значению на строку';
    ta.addEventListener('input', () => {
      if (f.type !== 'list') return onChange(ta.value, true);
      const items = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
      const ok = f.itemKind !== 'number' || items.every((x) => Number.isFinite(Number(x.replace(',', '.'))));
      onChange(items, ok);
    });
    wrap.appendChild(ta);
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.value = String(f.value);
    if (f.type === 'int' || f.type === 'float') {
      input.inputMode = f.type === 'int' ? 'numeric' : 'decimal';
      if (f.min !== undefined) input.title = `От ${f.min} до ${f.max}`;
    }
    input.addEventListener('input', () => {
      if (f.type === 'string') return onChange(input.value, true);
      const n = Number(input.value.trim().replace(',', '.'));
      let ok = input.value.trim() !== '' && Number.isFinite(n);
      if (ok && f.type === 'int') ok = Number.isInteger(n);
      if (ok && f.min !== undefined) ok = n >= f.min && n <= f.max;
      onChange(ok ? n : input.value, ok);
    });
    wrap.appendChild(input);
  }
  return wrap;
}

function sameValue(f, v) {
  if (f.type === 'list') return JSON.stringify(f.value) === JSON.stringify(v.map(String));
  return f.value === v;
}

function buildForm() {
  const box = $('cfg-form');
  box.replaceChildren();
  cfg.rows = [];
  const fields = (cfg.file && cfg.file.fields) || [];
  const frag = document.createDocumentFragment();
  let section = null;
  for (const f of fields) {
    if (f.section !== section) {
      section = f.section;
      if (section) {
        const h = document.createElement('h3');
        h.className = 'cfg-section';
        h.textContent = section;
        frag.appendChild(h);
        cfg.rows.push({ el: h, header: true, section });
      }
    }
    const row = document.createElement('div');
    row.className = 'cfg-field' + (f.type === 'list' || f.multiline ? ' wide' : '');
    const left = document.createElement('div');
    const key = document.createElement('label');
    key.className = 'cfg-key';
    key.htmlFor = `cfg-f-${f.id}`;
    key.textContent = f.key;
    left.appendChild(key);
    if (f.comment) {
      const d = document.createElement('p');
      d.className = 'cfg-desc';
      d.textContent = f.comment;
      d.title = 'Нажмите, чтобы показать полностью';
      d.addEventListener('click', () => d.classList.add('open'));
      left.appendChild(d);
    }
    const ctl = fieldControl(f, (value, ok) => {
      if (ok) cfg.invalid.delete(f.id);
      else cfg.invalid.add(f.id);
      if (ok && sameValue(f, value)) cfg.changes.delete(f.id);
      else cfg.changes.set(f.id, value);
      row.classList.toggle('changed', cfg.changes.has(f.id) && ok);
      row.classList.toggle('invalid', !ok);
      renderCfgActions();
    });
    row.append(left, ctl);
    frag.appendChild(row);
    cfg.rows.push({
      el: row,
      section: f.section,
      text: `${f.section} ${f.key} ${f.comment}`.toLowerCase(),
    });
  }
  box.appendChild(frag);
  filterForm();
}

function filterForm() {
  const q = $('cfg-filter').value.trim().toLowerCase();
  const visibleSections = new Set();
  for (const r of cfg.rows) {
    if (r.header) continue;
    r.el.hidden = !!q && !r.text.includes(q);
    if (!r.el.hidden) visibleSections.add(r.section);
  }
  for (const r of cfg.rows) if (r.header) r.el.hidden = !visibleSections.has(r.section);
}

function renderCfgActions() {
  const dirty = cfgDirty();
  $('cfg-save').disabled = !dirty || cfg.invalid.size > 0;
  $('cfg-discard').disabled = !dirty;
  if (cfg.invalid.size) setHint('cfg-status', 'Исправьте значения, выделенные красным.', 'bad');
  else if (dirty) setHint('cfg-status', cfg.mode === 'form' ? `Изменено настроек: ${cfg.changes.size}` : 'Текст изменён', 'warn');
  else if (!cfg.saved) setHint('cfg-status', '');
}

function renderCfgEditor() {
  const has = !!cfg.file;
  $('cfg-none').hidden = has;
  $('cfg-open').hidden = !has;
  if (!has) return;
  const f = cfg.file;
  $('cfg-name').textContent = f.rel.split('/').pop();
  $('cfg-path').textContent = `${f.rel} · ${FORMAT_NAMES[f.format] || f.format}`;
  const formOk = !!(f.fields && f.fields.length);
  for (const b of document.querySelectorAll('[data-cmode]')) {
    b.setAttribute('aria-selected', String(b.dataset.cmode === cfg.mode));
    if (b.dataset.cmode === 'form') b.disabled = !formOk;
  }
  $('cfg-form').hidden = cfg.mode !== 'form';
  $('cfg-text').hidden = cfg.mode !== 'text';
  $('cfg-filter').hidden = cfg.mode !== 'form';
  $('cfg-restore').disabled = !f.hasBackup;
  renderCfgHint();
  renderCfgActions();
}

async function saveConfig() {
  if (!cfg.file || !cfgDirty() || cfg.invalid.size) return;
  const base = { ...selected(), rel: cfg.file.rel, fileVersion: cfg.file.version };
  $('cfg-save').disabled = true;
  try {
    const file =
      cfg.mode === 'form'
        ? await api.call('config:saveFields', {
            ...base,
            changes: [...cfg.changes.entries()].map(([id, value]) => ({ id, value })),
          })
        : await api.call('config:saveText', { ...base, text: $('cfg-text').value });
    const scroll = $('cfg-form').scrollTop;
    showConfig(file, true);
    $('cfg-form').scrollTop = scroll;
    cfg.saved = true;
    setHint('cfg-status', 'Сохранено. Прошлая версия файла — кнопка «Вернуть прошлую».', 'good');
    renderCfgHint();
    if (file.rel === 'server.properties') refreshSidebarProps();
  } catch (e) {
    setHint('cfg-status', e.message, 'bad');
    $('cfg-save').disabled = false;
  }
}

async function refreshSidebarProps() {
  try {
    const data = await api.call('server:info', selected());
    if (info) info.props = data.props;
    fillProps(data.props);
    if (!isSelectedRunning()) {
      port = data.props['server-port'];
      serverIp = data.props['server-ip'] || '';
    }
  } catch {
    /* не критично */
  }
}

$('cfg-find-file').addEventListener('input', renderCfgTree);
$('cfg-refresh').addEventListener('click', () => loadConfigList());
$('cfg-filter').addEventListener('input', filterForm);
for (const b of document.querySelectorAll('[data-cmode]')) {
  b.addEventListener('click', () => {
    if (!cfg.file || cfg.mode === b.dataset.cmode) return;
    if (!confirmDiscard()) return;
    cfg.mode = b.dataset.cmode;
    showConfig(cfg.file, true);
  });
}
$('cfg-text').addEventListener('input', () => {
  cfg.textDirty = cfg.file && $('cfg-text').value !== cfg.file.text;
  renderCfgActions();
});
$('cfg-text').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  // YAML не допускает табуляцию — вставляем пробелы; в остальных файлах — как в самом файле.
  const indent = cfg.file.format !== 'yaml' && /^\t/m.test(cfg.file.text) ? '\t' : '  ';
  document.execCommand('insertText', false, indent);
});
$('cfg-save').addEventListener('click', saveConfig);
$('cfg-discard').addEventListener('click', () => {
  if (cfg.file) showConfig(cfg.file, true);
});
$('cfg-restart').addEventListener('click', () => {
  api.call('server:restart').catch(fail);
  cfg.saved = false;
  renderCfgHint();
});
$('cfg-external').addEventListener('click', () => {
  if (cfg.file) api.call('config:open', { ...selected(), rel: cfg.file.rel }).catch(fail);
});
$('cfg-restore').addEventListener('click', async () => {
  if (!cfg.file || !confirmDiscard()) return;
  if (!window.confirm('Вернуть файл к состоянию до последнего сохранения? Текущая версия станет резервной копией.')) return;
  try {
    const file = await api.call('config:restore', { ...selected(), rel: cfg.file.rel });
    showConfig(file, true);
    setHint('cfg-status', 'Прошлая версия восстановлена.', 'good');
  } catch (e) {
    setHint('cfg-status', e.message, 'bad');
  }
});
document.addEventListener('keydown', (e) => {
  if (tab === 'configs' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveConfig();
  }
});

// ---- объяснения ошибок ----

let issues = []; // карточки «что случилось» для текущего запуска
let issuesCollapsed = false;

function issueAction(a) {
  switch (a.type) {
    case 'search': {
      tab = 'mods';
      if (a.kind && kinds().includes(a.kind)) modsKind = a.kind;
      else if (kinds().includes('mod') && !a.kind) modsKind = 'mod';
      modsView = 'search';
      resetMods();
      $('search').value = a.query || '';
      renderTabs();
      refreshInstalled();
      runSearch(false);
      break;
    }
    case 'mods':
      tab = 'mods';
      if (a.kind && kinds().includes(a.kind)) modsKind = a.kind;
      modsView = 'installed';
      renderTabs();
      refreshInstalled();
      break;
    case 'ram':
      $('ram').scrollIntoView({ block: 'center', behavior: 'smooth' });
      $('ram').focus();
      $('ram').select();
      break;
    case 'java':
      api.call('open:java', { version: a.version }).catch(fail);
      break;
    case 'open':
      api.call('issue:open', { path: a.path }).catch(fail);
      break;
    case 'folder':
      api.call('open:folder', selected()).catch(fail);
      break;
    case 'logs':
      api.call('issue:logs').catch(fail);
      break;
    case 'copy':
      return api
        .call('issue:copyLog')
        .then((n) => `Скопировано строк: ${n}. Вставьте их в сообщение на форуме или автору мода.`);
    default:
      break;
  }
  return null;
}

function renderIssues() {
  const box = $('issues');
  box.hidden = !issues.length;
  box.classList.toggle('collapsed', issuesCollapsed);
  const errors = issues.filter((i) => i.severity === 'error').length;
  $('issues-title').textContent = errors
    ? `Что случилось — ${issues.length === 1 ? 'найдена причина' : `подсказок: ${issues.length}`}`
    : `Подсказки: ${issues.length}`;
  $('issues-toggle').textContent = issuesCollapsed ? 'Показать' : 'Свернуть';
  const list = $('issues-list');
  list.replaceChildren();
  // Ошибки — сверху, предупреждения и сведения — ниже.
  const order = { error: 0, warn: 1, info: 2 };
  for (const issue of [...issues].sort((a, b) => order[a.severity] - order[b.severity])) {
    const card = document.createElement('div');
    card.className = `issue ${issue.severity}`;
    card.setAttribute('role', 'listitem');

    const top = document.createElement('div');
    top.className = 'issue-top';
    const title = document.createElement('div');
    title.className = 'issue-title';
    title.textContent = issue.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'link-btn';
    close.textContent = 'Скрыть';
    close.addEventListener('click', () => {
      issues = issues.filter((x) => x !== issue);
      renderIssues();
      renderTabs();
    });
    top.append(title, close);
    card.appendChild(top);

    const text = document.createElement('p');
    text.className = 'issue-text';
    text.textContent = issue.text;
    card.appendChild(text);

    if (issue.fix && issue.fix.length) {
      const ul = document.createElement(issue.fix.length > 1 ? 'ol' : 'ul');
      ul.className = 'issue-fix';
      for (const f of issue.fix) {
        const li = document.createElement('li');
        li.textContent = f;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'issue-actions';
    const note = document.createElement('span');
    note.className = 'hint';
    for (const a of issue.actions || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = a.label;
      b.addEventListener('click', async () => {
        try {
          const msg = await issueAction(a);
          if (msg) {
            note.textContent = msg;
            note.className = 'hint good';
          }
        } catch (e) {
          note.textContent = e.message;
          note.className = 'hint bad';
        }
      });
      actions.appendChild(b);
    }
    let lineEl = null;
    if (issue.line) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      b.textContent = 'Строка из журнала';
      b.addEventListener('click', () => {
        lineEl.hidden = !lineEl.hidden;
      });
      actions.appendChild(b);
      lineEl = document.createElement('pre');
      lineEl.className = 'issue-line';
      lineEl.textContent = issue.line;
      lineEl.hidden = true;
    }
    actions.appendChild(note);
    if (actions.childElementCount > 1 || (issue.actions || []).length) card.appendChild(actions);
    if (lineEl) card.appendChild(lineEl);
    list.appendChild(card);
  }
}

$('issues-toggle').addEventListener('click', () => {
  issuesCollapsed = !issuesCollapsed;
  renderIssues();
});
api.on('issues:clear', () => {
  issues = [];
  issuesCollapsed = false;
  renderIssues();
  renderTabs();
});
api.on('issue', (issue) => {
  issues.push(issue);
  if (issue.severity === 'error') issuesCollapsed = false;
  renderIssues();
  renderTabs();
});

// ---- VPS ----

const vpsState = {
  loaded: false,
  list: [],
  sel: null, // id выбранного VPS
  info: null, // сведения о выбранном VPS
  editing: null, // null — форма скрыта; {} — новый; профиль — изменение
  auth: 'password',
  busy: false,
  console: null, // имя сервера, чья консоль открыта
  timer: null,
};

const vpsSel = () => vpsState.list.find((v) => v.id === vpsState.sel) || null;

function renderVpsList() {
  const box = $('vps-items');
  box.replaceChildren();
  for (const v of vpsState.list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vps-item';
    b.setAttribute('aria-current', String(v.id === vpsState.sel && !vpsState.editing));
    const n = document.createElement('b');
    n.textContent = v.name;
    const s = document.createElement('span');
    s.textContent = `${v.username}@${v.host}`;
    b.append(n, s);
    b.addEventListener('click', () => selectVps(v.id));
    box.appendChild(b);
  }
}

function renderVps() {
  renderVpsList();
  const v = vpsSel();
  $('vps-form').hidden = !vpsState.editing;
  $('vps-open').hidden = !!vpsState.editing || !v;
  $('vps-empty').hidden = !!vpsState.editing || !!v;
  if (vpsState.editing || !v) return;

  $('vps-name').textContent = v.name;
  const inf = vpsState.info;
  $('vps-sub').textContent = [
    `${v.username}@${v.host}${v.port !== 22 ? ':' + v.port : ''}`,
    inf && inf.os,
    inf && inf.memGb ? `память ${inf.memGb} ГБ` : null,
    inf && inf.diskGb !== null && inf.diskGb !== undefined ? `свободно ${inf.diskGb} ГБ` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Что переносим — сервер, выбранный в левой панели.
  const what = $('vt-what');
  const ver = $('version').value;
  let ok = true;
  if (!ver || !info) {
    what.textContent = 'Выберите сервер в левой панели.';
    ok = false;
  } else if (!info.installed) {
    what.textContent = `${LOADER_NAMES[type] || (type === 'paper' ? 'Paper' : 'Vanilla')} ${ver} ещё не установлен на ПК. Запустите его хотя бы раз — потом его можно будет перенести.`;
    what.className = 'hint warn';
    ok = false;
  } else {
    const parts = [`Будет перенесён сервер из левой панели: ${type} ${ver} — мир, моды, плагины и настройки.`];
    if (!info.eula) parts.push('На ПК не принято лицензионное соглашение — на VPS сервер не запустится. Запустите его один раз на ПК с галочкой EULA.');
    if (isSelectedRunning()) parts.push('Сначала остановите его на ПК.');
    what.textContent = parts.join(' ');
    what.className = 'hint' + (!info.eula || isSelectedRunning() ? ' warn' : '');
    if (isSelectedRunning()) ok = false;
  }
  if (ver && !$('vt-name').dataset.touched) $('vt-name').value = `${type}-${ver}`;
  $('vt-go').disabled = !ok || vpsState.busy || !inf;

  // Серверы на VPS
  const box = $('vps-servers');
  box.replaceChildren();
  const servers = (inf && inf.servers) || [];
  if (!inf) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = 'Подключаюсь…';
    box.appendChild(p);
  } else if (!servers.length) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = 'На этом VPS пока нет серверов — перенесите сервер с ПК.';
    box.appendChild(p);
  }
  const maxRam = inf && inf.memGb ? Math.max(1, inf.memGb - 1) : 64;
  for (const s of servers) {
    const row = document.createElement('div');
    row.className = 'item vps-srv';
    const body = document.createElement('div');
    body.className = 'item-body';
    const title = document.createElement('div');
    title.className = 'item-title';
    const name = document.createElement('span');
    name.className = 'name plain';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const dot = document.createElement('span');
    dot.className = 'dot' + (s.running ? ' on' : '');
    meta.append(dot, `${s.running ? 'работает' : 'остановлен'} · ${s.type || '?'} ${s.mc || ''}`);
    title.append(name, meta);
    const addr = document.createElement('p');
    addr.className = 'item-desc';
    addr.textContent = `Адрес для игроков: ${v.host}${s.port && s.port !== '25565' ? ':' + s.port : ''}`;
    body.append(title, addr);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const note = document.createElement('span');
    note.className = 'hint';
    const act = async (fn, busyText) => {
      for (const b of actions.querySelectorAll('button,input')) b.disabled = true;
      note.textContent = busyText;
      note.className = 'hint';
      try {
        const msg = await fn();
        note.textContent = msg || '';
        note.className = 'hint good';
      } catch (e) {
        note.textContent = e.message;
        note.className = 'hint bad';
      }
      await refreshVpsInfo(true);
    };
    if (s.running) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn small danger';
      stop.textContent = 'Остановить';
      stop.addEventListener('click', () =>
        act(async () => {
          const r = await api.call('vps:stop', { id: v.id, name: s.name });
          return r.killed ? 'Сервер не ответил на stop и был остановлен принудительно' : 'Остановлен, мир сохранён';
        }, 'Останавливаю (до минуты)…')
      );
      actions.appendChild(stop);
    } else {
      const ram = document.createElement('input');
      ram.type = 'number';
      ram.className = 'ram';
      ram.min = 1;
      ram.max = maxRam;
      ram.value = Math.min(maxRam, s.ramGb || 2);
      ram.title = `Память для сервера, ГБ (на VPS ${inf && inf.memGb ? inf.memGb : '?'} ГБ)`;
      const lbl = document.createElement('span');
      lbl.className = 'hint';
      lbl.textContent = 'ГБ';
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'btn small primary';
      start.textContent = 'Запустить';
      start.addEventListener('click', () =>
        act(async () => {
          const n = Math.round(Number(ram.value));
          if (!(n >= 1 && n <= maxRam)) throw new Error(`Память — от 1 до ${maxRam} ГБ`);
          await api.call('vps:start', { id: v.id, name: s.name, ramGb: n });
          openVpsConsole(s);
          return 'Запускается — следите в консоли';
        }, 'Запускаю…')
      );
      actions.append(ram, lbl, start);
    }
    const cons = document.createElement('button');
    cons.type = 'button';
    cons.className = 'btn small';
    cons.textContent = 'Консоль';
    cons.addEventListener('click', () => openVpsConsole(s));
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'btn small';
    check.textContent = 'Проверить доступ';
    check.title = 'Попробовать подключиться к серверу из интернета';
    check.addEventListener('click', async () => {
      note.textContent = 'Проверяю…';
      note.className = 'hint';
      const r = await api.call('vps:checkPort', { id: v.id, port: s.port || 25565 }).catch((e) => ({ ok: false, reason: e.message }));
      if (r.ok) {
        note.textContent = 'Порт открыт — игроки смогут подключиться';
        note.className = 'hint good';
      } else if (!s.running) {
        note.textContent = 'Сервер не запущен — сначала запустите его';
        note.className = 'hint warn';
      } else {
        note.textContent = `Порт ${s.port || 25565} закрыт. Откройте его в брандмауэре VPS (например: sudo ufw allow ${s.port || 25565}/tcp) или в панели хостинга`;
        note.className = 'hint bad';
      }
    });
    actions.append(cons, check, note);
    row.append(body, actions);
    box.appendChild(row);
  }
}

async function loadVpsList() {
  try {
    vpsState.list = await api.call('vps:list');
  } catch (e) {
    setHint('vps-hint', e.message, 'bad');
  }
  vpsState.loaded = true;
  if (!vpsSel() && vpsState.list.length) {
    await selectVps(vpsState.list[0].id);
    return;
  }
  renderVps();
}

async function selectVps(id) {
  if (vpsState.sel !== id) closeVpsConsole();
  vpsState.sel = id;
  vpsState.editing = null;
  vpsState.info = null;
  setHint('vps-hint', '');
  renderVps();
  await refreshVpsInfo(false);
}

/** Подключиться и обновить сведения. Первое подключение — спрашиваем про отпечаток ключа. */
async function refreshVpsInfo(quiet) {
  const v = vpsSel();
  if (!v) return;
  if (!quiet) setHint('vps-hint', 'Подключаюсь…');
  try {
    let r = await api.call('vps:info', { id: v.id });
    if (r.hostKey && r.hostKey.code === 'HOSTKEY_NEW') {
      const yes = window.confirm(
        `Первое подключение к ${v.host}.\n\nОтпечаток ключа сервера:\n${r.hostKey.fingerprint}\n\n` +
          'Если хостинг показывает отпечаток — сверьте его. Доверять этому серверу?'
      );
      if (!yes) {
        setHint('vps-hint', 'Подключение отменено: ключ сервера не подтверждён.', 'warn');
        return;
      }
      r = await api.call('vps:info', { id: v.id, acceptFingerprint: r.hostKey.fingerprint });
    }
    if (r.hostKey && r.hostKey.code === 'HOSTKEY_CHANGED') {
      setHint('vps-hint', r.hostKey.message, 'bad');
      const yes = window.confirm(
        `${r.hostKey.message}\n\nВы переустанавливали систему на этом VPS и доверяете новому ключу?`
      );
      if (yes) {
        await api.call('vps:forgetKey', { id: v.id });
        r = await api.call('vps:info', { id: v.id, acceptFingerprint: r.hostKey.fingerprint });
      } else {
        return;
      }
    }
    if (vpsState.sel !== v.id || r.hostKey) return;
    vpsState.info = r;
    if (!quiet) setHint('vps-hint', '');
    vpsState.list = await api.call('vps:list');
  } catch (e) {
    setHint('vps-hint', e.message, 'bad');
  }
  renderVps();
}

function showVpsForm(profile) {
  vpsState.editing = profile || {};
  const p = vpsState.editing;
  $('vps-form-title').textContent = p.id ? `Изменить «${p.name}»` : 'Новый VPS';
  $('vf-name').value = p.name || '';
  $('vf-host').value = p.host || '';
  $('vf-user').value = p.username || 'root';
  $('vf-port').value = p.port || 22;
  $('vf-key').value = p.keyPath || '';
  $('vf-pass').value = '';
  $('vf-keypass').value = '';
  $('vf-pass').placeholder = p.id && p.auth === 'password' ? 'Оставьте пустым, чтобы не менять' : '';
  setVpsAuth(p.auth || 'password');
  setHint('vf-hint', '');
  renderVps();
  $('vf-host').focus();
}

function setVpsAuth(a) {
  vpsState.auth = a;
  for (const b of document.querySelectorAll('[data-vauth]')) b.setAttribute('aria-checked', String(b.dataset.vauth === a));
  $('vf-pass-row').hidden = a !== 'password';
  $('vf-key-row').hidden = a !== 'key';
}

function openVpsConsole(s) {
  const v = vpsSel();
  if (!v) return;
  closeVpsConsole();
  vpsState.console = s.name;
  $('vps-console').hidden = false;
  $('vc-title').textContent = `Консоль: ${s.name}`;
  $('vc-addr').textContent = `${v.host}${s.port && s.port !== '25565' ? ':' + s.port : ''}`;
  $('vc-log').replaceChildren();
  api.call('vps:logOpen', { id: v.id, name: s.name }).catch((e) => addVpsLine(e.message, 'error'));
}

function closeVpsConsole() {
  const v = vpsSel();
  if (vpsState.console && v) api.call('vps:logClose', { id: v.id, name: vpsState.console }).catch(() => {});
  vpsState.console = null;
  $('vps-console').hidden = true;
}

function addVpsLine(text, kind) {
  const box = $('vc-log');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = kind || (/ERROR|Exception|^\s+at /.test(text) ? 'error' : /^=== /.test(text) ? 'info' : 'server');
  line.textContent = text;
  box.appendChild(line);
  while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

function ensureVps() {
  if (tab !== 'vps') {
    clearInterval(vpsState.timer);
    vpsState.timer = null;
    return;
  }
  if (!vpsState.loaded) loadVpsList();
  else renderVps();
  // Пока вкладка открыта — раз в 20 секунд обновляем состояние серверов.
  if (!vpsState.timer) {
    vpsState.timer = setInterval(() => {
      if (tab === 'vps' && vpsSel() && !vpsState.busy && !vpsState.editing) refreshVpsInfo(true);
    }, 20000);
  }
}

$('vps-add').addEventListener('click', () => showVpsForm(null));
$('vps-edit').addEventListener('click', () => vpsSel() && showVpsForm(vpsSel()));
$('vf-cancel').addEventListener('click', () => {
  vpsState.editing = null;
  renderVps();
});
for (const b of document.querySelectorAll('[data-vauth]')) b.addEventListener('click', () => setVpsAuth(b.dataset.vauth));
$('vf-key-pick').addEventListener('click', async () => {
  const p = await api.call('vps:pickKey').catch((e) => setHint('vf-hint', e.message, 'bad'));
  if (p) $('vf-key').value = p;
});
$('vps-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const auth = vpsState.auth;
  const input = {
    id: vpsState.editing && vpsState.editing.id,
    name: $('vf-name').value,
    host: $('vf-host').value,
    port: Number($('vf-port').value),
    username: $('vf-user').value,
    auth,
    keyPath: $('vf-key').value,
    secret: auth === 'password' ? $('vf-pass').value : $('vf-keypass').value,
  };
  $('vf-save').disabled = true;
  try {
    const saved = await api.call('vps:save', input);
    $('vf-pass').value = '';
    $('vf-keypass').value = '';
    vpsState.list = await api.call('vps:list');
    await selectVps(saved.id);
  } catch (err) {
    setHint('vf-hint', err.message, 'bad');
  }
  $('vf-save').disabled = false;
});
$('vps-del').addEventListener('click', async () => {
  const v = vpsSel();
  if (!v) return;
  if (!window.confirm(`Удалить «${v.name}» из лаунчера?\n\nСерверы на самом VPS не удалятся и продолжат работать.`)) return;
  closeVpsConsole();
  await api.call('vps:remove', { id: v.id }).catch(fail);
  vpsState.sel = null;
  vpsState.info = null;
  vpsState.list = await api.call('vps:list');
  await loadVpsList();
});
$('vps-refresh').addEventListener('click', () => refreshVpsInfo(false));
$('vt-name').addEventListener('input', () => {
  $('vt-name').dataset.touched = '1';
});
$('vt-go').addEventListener('click', async () => {
  const v = vpsSel();
  const name = $('vt-name').value.trim();
  if (!v || !name) return;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    setHint('vps-hint', 'Имя папки — только латиница, цифры, точка, дефис и подчёркивание', 'bad');
    return;
  }
  const existing = vpsState.info && vpsState.info.servers.find((s) => s.name === name);
  if (existing && !window.confirm(`На VPS уже есть сервер «${name}».\n\nЗаменить его версией с ПК? Прежняя версия (с миром) сохранится на VPS в отдельной папке-копии.`)) return;
  vpsState.busy = true;
  $('vt-steps').replaceChildren();
  $('vt-progress').hidden = false;
  $('vt-bar').style.width = '0';
  renderVps();
  try {
    await api.call('vps:transfer', { id: v.id, type, version: $('version').value, name });
  } catch (e) {
    const li = document.createElement('li');
    li.className = 'bad';
    li.textContent = e.message;
    $('vt-steps').appendChild(li);
  }
  vpsState.busy = false;
  $('vt-progress').hidden = true;
  await refreshVpsInfo(true);
});
$('vc-close').addEventListener('click', closeVpsConsole);
$('vc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = vpsSel();
  const text = $('vc-cmd').value.trim();
  if (!v || !vpsState.console || !text) return;
  try {
    await api.call('vps:command', { id: v.id, name: vpsState.console, text });
    addVpsLine('> ' + text, 'input');
    $('vc-cmd').value = '';
  } catch (err) {
    addVpsLine(err.message, 'error');
  }
});
api.on('vps:log', ({ id, name, line }) => {
  if (id === vpsState.sel && name === vpsState.console) addVpsLine(line);
});
api.on('vps:progress', ({ id, step, done, total }) => {
  if (id !== vpsState.sel) return;
  if (step) {
    const li = document.createElement('li');
    li.textContent = step;
    $('vt-steps').appendChild(li);
  }
  if (total) $('vt-bar').style.width = Math.min(100, (done / total) * 100) + '%';
});

// ---- обновления ----

const upd = { enabled: false, version: '', state: { status: 'idle' }, whatsNew: null, dismissed: '', notesOpen: false };

/** Простой markdown (заголовки, списки, `код`, **жирный**) — только через textContent, без HTML. */
function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  let list = null;
  const inline = (parent, text) => {
    for (const part of String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
      if (!part) continue;
      if (part.startsWith('`')) {
        const c = document.createElement('code');
        c.textContent = part.slice(1, -1);
        parent.appendChild(c);
      } else if (part.startsWith('**')) {
        const b = document.createElement('b');
        b.textContent = part.slice(2, -2);
        parent.appendChild(b);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  };
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (!list) {
        list = document.createElement('ul');
        frag.appendChild(list);
      }
      const li = document.createElement('li');
      inline(li, item[1]);
      list.appendChild(li);
      continue;
    }
    list = null;
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const el = document.createElement(h ? 'h4' : 'p');
    inline(el, h ? h[1] : line);
    frag.appendChild(el);
  }
  return frag;
}

function renderUpdate() {
  const box = $('update');
  const s = upd.state;
  const foot = $('check-updates');
  $('app-version').textContent = upd.version ? `Версия ${upd.version}` : '';
  foot.hidden = !upd.enabled;
  foot.disabled = s.status === 'checking' || s.status === 'downloading';
  foot.textContent =
    s.status === 'checking' ? 'Проверяю…' : s.status === 'none' && s.manual ? 'Обновлений нет' : 'Проверить обновления';

  let title = '';
  let sub = '';
  let action = '';
  let notes = '';
  let bad = false;
  const key = `${s.status}|${s.version || ''}`;
  if (['available', 'downloading', 'ready'].includes(s.status)) {
    notes = s.notes;
    if (s.status === 'available') {
      title = `Доступна версия ${s.version}`;
      sub = `у вас ${upd.version}`;
      action = s.mode === 'portable' ? 'Скачать' : 'Скачать и установить';
    } else if (s.status === 'downloading') {
      title = `Скачиваю версию ${s.version}…`;
      sub = `${s.percent || 0}%`;
    } else {
      title = `Версия ${s.version} скачана`;
      sub = isSelectedRunning() || running ? 'сервер будет остановлен с сохранением мира' : '';
      action = 'Перезапустить и обновить';
    }
  } else if (s.status === 'error' && s.manual) {
    title = 'Не удалось проверить обновления';
    sub = s.error || '';
    bad = true;
  } else if (upd.whatsNew) {
    title = `Лаунчер обновлён до версии ${upd.whatsNew.version}`;
    notes = upd.whatsNew.notes;
  }

  const show = !!title && upd.dismissed !== (upd.whatsNew && !action ? 'whatsnew' : key);
  box.hidden = !show;
  if (!show) return;
  box.classList.toggle('bad', bad);
  $('update-title').textContent = title;
  $('update-sub').textContent = sub;
  $('update-action').hidden = !action;
  $('update-action').textContent = action;
  $('update-action').disabled = s.status === 'downloading';
  $('update-toggle').hidden = !notes;
  $('update-toggle').textContent = upd.notesOpen ? 'Скрыть' : 'Что нового';
  $('update-close').hidden = s.status === 'downloading';
  const n = $('update-notes');
  n.hidden = !notes || !upd.notesOpen;
  n.replaceChildren(renderMarkdown(notes));
}

$('update-toggle').addEventListener('click', () => {
  upd.notesOpen = !upd.notesOpen;
  renderUpdate();
});
$('update-close').addEventListener('click', () => {
  const s = upd.state;
  upd.dismissed = ['available', 'ready', 'error'].includes(s.status) ? `${s.status}|${s.version || ''}` : 'whatsnew';
  if (upd.dismissed === 'whatsnew') upd.whatsNew = null;
  renderUpdate();
});
$('update-action').addEventListener('click', async () => {
  try {
    if (upd.state.status === 'ready') await api.call('update:install');
    else await api.call('update:download');
  } catch (e) {
    fail(e);
  }
});
$('check-updates').addEventListener('click', () => {
  upd.dismissed = '';
  api.call('update:check').catch(fail);
});
api.on('update', (s) => {
  const fresh = s.status === 'available' && upd.state.version !== s.version;
  upd.state = s;
  if (fresh) upd.notesOpen = false;
  renderUpdate();
});

async function loadUpdateState() {
  try {
    const u = await api.call('update:state');
    upd.enabled = u.enabled;
    upd.version = u.version;
    upd.state = u.state || { status: 'idle' };
    upd.whatsNew = u.whatsNew && u.whatsNew.notes ? u.whatsNew : null;
    if (upd.whatsNew) upd.notesOpen = true;
  } catch {
    /* не критично */
  }
  renderUpdate();
}

// ---- загрузка данных ----

/** Список IP компьютера в поле «IP сервера»; value — что сейчас в server.properties. */
function fillIpSelect(value) {
  const sel = $('p-ip');
  const opts = [new Option('Все адреса компьютера (обычно так и нужно)', '')];
  for (const a of addresses) {
    opts.push(new Option(`${a.address} — ${a.name}${a.vpn ? ' (VPN)' : ''}`, a.address));
  }
  if (value && !addresses.some((a) => a.address === value)) {
    opts.push(new Option(`${value} — нет на этом компьютере`, value));
  }
  sel.replaceChildren(...opts);
  sel.value = value || '';
  renderIpHint();
}

function renderIpHint() {
  const v = $('p-ip').value;
  const a = addresses.find((x) => x.address === v);
  if (!v) {
    setHint('ip-hint', 'Сервер доступен по всем сетям компьютера: localhost, локальная сеть и VPN (Radmin, Hamachi, ZeroTier).');
  } else if (!a) {
    setHint('ip-hint', `Адреса ${v} на этом компьютере нет — сервер не запустится. Выберите «Все адреса» или другой адрес.`, 'bad');
  } else {
    setHint('ip-hint', `Подключиться можно только по ${v}${a.vpn ? ' — через эту VPN-сеть' : ''}. По localhost и другим сетям сервер виден не будет.`, a.vpn ? '' : 'warn');
  }
}

async function refreshAddresses() {
  try {
    addresses = await api.call('net:addresses');
  } catch {
    return;
  }
  fillIpSelect($('p-ip').value);
}

function fillProps(props) {
  fillIpSelect(props['server-ip'] || '');
  $('p-port').value = props['server-port'];
  $('p-players').value = props['max-players'];
  $('p-gamemode').value = props.gamemode;
  $('p-difficulty').value = props.difficulty;
  $('p-motd').value = props.motd;
  $('p-online').checked = props['online-mode'] !== 'false';
}

function fillLoaders() {
  const select = $('loader');
  if (!isModded() || !loaders) {
    select.replaceChildren();
    return;
  }
  const opts = loaders.list.map((l) => new Option(l.label, l.id));
  const installedId = info && info.installedLoader;
  if (installedId && !loaders.list.some((l) => l.id === installedId)) {
    opts.unshift(new Option(`${installedId} — установлен`, installedId));
  }
  if (!opts.length) opts.push(new Option('Нет версий для этой игры', ''));
  select.replaceChildren(...opts);
  select.value = installedId || loaders.recommended || (loaders.list[0] && loaders.list[0].id) || '';
}

async function loadDetails() {
  const token = ++detailsToken;
  const sel = selected();
  info = null;
  loaders = null;
  resetMods();
  setHint('props-hint', '');
  $('loader').replaceChildren(new Option('Загрузка…', ''));
  render();
  if (!sel.version) {
    $('loader').replaceChildren();
    render();
    return;
  }
  try {
    const [data, lds] = await Promise.all([
      api.call('server:info', sel),
      isModded(sel.type) ? api.call('loaders:list', sel) : null,
    ]);
    if (token !== detailsToken) return;
    info = data;
    loaders = lds;
    fillLoaders();
    fillProps(data.props);
    if (state === 'stopped' || isSelectedRunning()) {
      port = data.props['server-port'];
      serverIp = data.props['server-ip'] || '';
    }
  } catch (e) {
    if (token !== detailsToken) return;
    $('loader').replaceChildren(new Option('Не удалось загрузить', ''));
    fail(e);
  }
  render();
  await refreshInstalled();
  ensureMods();
  // Тот же сервер (например, после остановки) — обновить список файлов, не теряя правок.
  if (tab === 'configs' && cfg.key === selKey()) {
    await loadConfigList();
    if (cfg.file && !cfgDirty()) openConfig(cfg.file.rel, true);
  } else {
    ensureConfigs();
  }
}

async function loadVersions() {
  const token = ++versionsToken;
  const select = $('version');
  const wanted = store.get('version:' + type, '');
  select.replaceChildren(new Option('Загрузка списка…', ''));
  info = null;
  render();
  try {
    const list = await api.call('versions:list', { type, includePre: $('pre').checked });
    if (token !== versionsToken) return;
    select.replaceChildren(...list.map((v) => new Option(v.pre ? `${v.id} (тестовая)` : v.id, v.id)));
    if (list.some((v) => v.id === wanted)) select.value = wanted;
  } catch (e) {
    if (token !== versionsToken) return;
    select.replaceChildren(new Option('Не удалось загрузить', ''));
    addLog('Не удалось получить список версий: ' + e.message, 'error');
  }
  await loadDetails();
}

async function loadJavas(refresh) {
  try {
    javas = await api.call('java:list', { refresh });
  } catch (e) {
    javas = [];
    fail(e);
  }
  const saved = store.get('java', 'auto');
  const opts = [new Option('Авто', 'auto')];
  for (const j of javas) {
    const label = `Java ${j.major}${j.bits === 32 ? ' (32 бит)' : ''}`;
    const o = new Option(label, j.path);
    o.title = j.path === 'java' ? `${j.text} — из PATH` : `${j.text} — ${j.path}`;
    opts.push(o);
  }
  $('java').replaceChildren(...opts);
  $('java').value = javas.some((j) => j.path === saved) ? saved : 'auto';
}

// ---- события ----

let lastVersion = '';
$('version').addEventListener('focus', () => {
  lastVersion = $('version').value;
});
$('type').addEventListener('change', () => {
  if (!confirmDiscard()) {
    $('type').value = type;
    return;
  }
  resetConfigs();
  type = $('type').value;
  store.set('type', type);
  $('version').replaceChildren();
  loadVersions();
});
$('version').addEventListener('change', () => {
  if (!confirmDiscard()) {
    $('version').value = lastVersion;
    return;
  }
  resetConfigs();
  lastVersion = $('version').value;
  store.set('version:' + type, $('version').value);
  loadDetails();
});
$('loader').addEventListener('change', () => {
  render();
  // У Arclight от сборки зависит загрузчик модов — значит, и список подходящих модов.
  if (type === 'arclight' && !(info && info.installed)) {
    resetMods();
    refreshInstalled();
    ensureMods();
  }
});
for (const b of document.querySelectorAll('[data-mkind]')) {
  b.addEventListener('click', () => {
    if (currentKind() === b.dataset.mkind) return;
    modsKind = b.dataset.mkind;
    store.set('modsKind', modsKind);
    resetMods();
    renderTabs();
    refreshInstalled();
    ensureMods();
  });
}
$('pre').addEventListener('change', () => {
  store.set('pre', $('pre').checked ? '1' : '');
  loadVersions();
});
$('ram').addEventListener('input', render);
$('ram').addEventListener('change', () => {
  // Выход за пределы — подтягиваем к ближайшему допустимому значению.
  const max = memory ? memory.maxGb : 64;
  const n = Math.round(Number(String($('ram').value).replace(',', '.')));
  $('ram').value = Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : Math.min(2, max);
  store.set('ram', $('ram').value);
  render();
});
$('java').addEventListener('change', () => {
  store.set('java', $('java').value);
  render();
});
$('eula').addEventListener('change', render);
$('eula-link').addEventListener('click', (e) => {
  e.preventDefault();
  api.call('open:eula').catch(fail);
});

$('start').addEventListener('click', async () => {
  if (state === 'running') {
    api.call('server:restart').catch(fail);
    return;
  }
  $('progress-bar').style.width = '0';
  tab = 'console';
  render();
  try {
    await api.call('server:start', {
      ...selected(),
      loader: isModded() ? $('loader').value : null,
      ramGb: $('ram').value,
      eula: $('eula').checked,
      javaPath: $('java').value,
    });
  } catch (e) {
    fail(e);
  }
});
$('stop').addEventListener('click', () => api.call('server:stop').catch(fail));

$('cmd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('cmd').value.trim();
  if (!text) return;
  try {
    await api.call('server:command', { text });
    $('cmd').value = '';
  } catch (err) {
    fail(err);
  }
});
$('clear').addEventListener('click', () => $('log').replaceChildren());

$('save').addEventListener('click', async () => {
  const values = {
    'server-ip': $('p-ip').value,
    'server-port': $('p-port').value,
    'max-players': $('p-players').value,
    gamemode: $('p-gamemode').value,
    difficulty: $('p-difficulty').value,
    motd: $('p-motd').value,
    'online-mode': $('p-online').checked ? 'true' : 'false',
  };
  try {
    await api.call('props:save', { ...selected(), values });
    if (isSelectedRunning()) {
      setHint('props-hint', 'Сохранено. Изменения применятся после перезапуска сервера.', 'warn');
    } else {
      port = String(values['server-port']);
      serverIp = values['server-ip'];
      setHint('props-hint', 'Сохранено.', 'good');
    }
    if (cfg.file && cfg.file.rel === 'server.properties' && !cfgDirty()) openConfig('server.properties', true);
  } catch (e) {
    setHint('props-hint', e.message, 'bad');
  }
});
$('folder').addEventListener('click', () => api.call('open:folder', selected()).catch(fail));
$('p-ip').addEventListener('change', renderIpHint);
// Сети меняются (включили VPN, переподключили Wi-Fi) — обновляем список при открытии.
$('p-ip').addEventListener('focus', refreshAddresses);

for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    tab = t.dataset.tab;
    renderTabs();
    ensureMods();
    ensureConfigs();
    ensureVps();
  });
}
for (const b of document.querySelectorAll('[data-mview]')) {
  b.addEventListener('click', () => {
    modsView = b.dataset.mview;
    renderTabs();
    if (modsView === 'installed') refreshInstalled();
  });
}
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(false);
});
$('more').addEventListener('click', () => runSearch(true));
$('mods-folder').addEventListener('click', () => {
  api.call('open:folder', { ...modsArgs(), sub: true }).catch(fail);
});

api.on('log', ({ text, kind }) => addLog(text, kind));
api.on('progress', ({ got, total }) => {
  $('progress-bar').style.width = total ? Math.min(100, (got / total) * 100) + '%' : '0';
});
api.on('state', (payload) => {
  const was = state;
  state = payload.state;
  running = payload.current;
  if (state === 'stopped' && was !== 'stopped') loadDetails();
  else render();
});

// ---- старт ----

(async () => {
  $('pre').checked = store.get('pre', '') === '1';
  const ram = Number(store.get('ram', '2'));
  $('ram').value = ram >= 1 && ram <= 64 ? ram : 2;
  render();
  try {
    const appInfo = await api.call('app:info');
    memory = appInfo.memory;
    $('ram').max = memory.maxGb;
    if (Number($('ram').value) > memory.maxGb) $('ram').value = Math.min(memory.maxGb, 2);
    addresses = appInfo.addresses;
    state = appInfo.state;
    running = appInfo.current;
  } catch (e) {
    fail(e);
  }
  loadUpdateState();
  await loadJavas(false);
  addLog('Выберите тип сервера и версию, затем нажмите «Запустить». Всё нужное скачается само.');
  await loadVersions();
})();
