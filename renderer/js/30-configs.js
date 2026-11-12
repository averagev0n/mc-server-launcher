// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
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
