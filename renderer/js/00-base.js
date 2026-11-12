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
