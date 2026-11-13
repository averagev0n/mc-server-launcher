// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- сборка для игроков ----

let packData = null; // { key, items, loader, addresses, hasConfig }
const packSel = new Set();

const SIDE_BADGE = {
  required: ['нужен игрокам', 'good'],
  optional: ['и у игроков', 'good'],
  unsupported: ['только сервер', ''],
  unknown: ['не с Modrinth', 'warn'],
};

function renderPack() {
  const box = $('pack-list');
  box.replaceChildren();
  if (!packData) return;
  const fl = packData.loader && packData.loader.flavor;
  const loaderText = fl ? `${FLAVOR_NAMES[fl]}${packData.loader.version ? ' ' + packData.loader.version : ''}` : 'загрузчик модов';
  const chosen = packData.items.filter((i) => packSel.has(i.file));
  setHint(
    'pack-hint',
    packData.items.length
      ? `Игрокам понадобится Minecraft ${$('version').value} с ${loaderText} и ${chosen.length} мод(ов) из ${packData.items.length}. В .mrpack всё это ставится само.`
      : 'В папке mods сервера пока нет модов.',
    packData.items.length ? '' : 'warn'
  );
  for (const it of packData.items) {
    const { row, body } = itemShell(it.icon);
    row.classList.add('pack-item');
    row.classList.toggle('off', !packSel.has(it.file));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = packSel.has(it.file);
    cb.setAttribute('aria-label', it.title || it.file);
    const toggle = () => {
      if (cb.checked) packSel.add(it.file);
      else packSel.delete(it.file);
      renderPack();
    };
    cb.addEventListener('change', toggle);
    row.addEventListener('click', (e) => {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      toggle();
    });
    const title = document.createElement('div');
    title.className = 'item-title';
    const name = document.createElement('span');
    name.className = 'name plain';
    name.textContent = it.title || it.file;
    const [label, cls] = SIDE_BADGE[it.clientSide] || SIDE_BADGE.unknown;
    const badge = document.createElement('span');
    badge.className = `badge ${cls}`;
    badge.textContent = label;
    title.append(name, badge);
    const desc = document.createElement('p');
    desc.className = 'item-desc';
    desc.textContent = `${it.reason} · ${formatSize(it.size)}`;
    body.append(title, desc);
    row.prepend(cb);
    box.appendChild(row);
  }
  const none = !chosen.length;
  $('pack-mrpack').disabled = none;
  $('pack-zip').disabled = none;
  $('pack-app').disabled = none;
  $('pack-addr-row').hidden = !$('pack-server').checked;
  $('pack-config').disabled = !packData.hasConfig;
}

async function loadPack() {
  const key = selKey();
  if (packData && packData.key === key) return renderPack();
  packData = null;
  $('pack-list').replaceChildren();
  setHint('pack-hint', 'Проверяю моды на Modrinth…');
  setHint('pack-result', '');
  try {
    const r = await api.call('pack:analyze', selected());
    if (key !== selKey()) return;
    packData = { key, ...r };
    packSel.clear();
    for (const i of r.items) if (i.include) packSel.add(i.file);
    const fl = r.loader && r.loader.flavor;
    $('pack-name').value = `Сервер ${fl ? FLAVOR_NAMES[fl] + ' ' : ''}${$('version').value}`;
    const pick = $('pack-addr-pick');
    pick.replaceChildren(new Option('Свой адрес…', ''), ...r.addresses.map((a) => new Option(`${a.label}: ${a.address}`, a.address)));
    // По умолчанию — VPS, если он есть: так сервер доступен из интернета.
    const first = r.addresses[0];
    pick.value = first ? first.address : '';
    $('pack-addr').value = first ? first.address : '';
  } catch (e) {
    setHint('pack-hint', e.message, 'bad');
    return;
  }
  renderPack();
}

async function exportPack(format, openApp = false) {
  if (!packData) return;
  setHint('pack-result', openApp ? 'Собираю и открываю в Modrinth App…' : 'Собираю…');
  try {
    const r = await api.call('pack:export', {
      ...selected(),
      files: [...packSel],
      format,
      name: $('pack-name').value,
      packVersion: $('pack-version').value.trim(),
      address: format === 'mrpack' && $('pack-server').checked ? $('pack-addr').value.trim() : '',
      includeConfig: $('pack-config').checked,
      openApp,
    });
    if (!r) {
      setHint('pack-result', '');
      return;
    }
    if (r.noApp) {
      const el = setHint('pack-result', 'Modrinth App на этом компьютере не найден. Установите его, и кнопка поставит сборку одним нажатием. ', 'warn');
      addLink(el, 'Скачать Modrinth App', () => api.call('pack:modrinthApp').catch(fail));
      return;
    }
    if (r.opened) {
      const el = setHint('pack-result', 'Сборка открыта в Modrinth App — подтвердите установку в его окне. Друзьям отправьте этот же файл: у них она откроется так же. ', 'good');
      addLink(el, 'Показать файл', () => api.call('pack:reveal', { path: r.path }).catch(fail));
      return;
    }
    const el = setHint('pack-result', `Сохранено: ${r.path} (${formatSize(r.size)}). Отправьте этот файл игрокам. `, 'good');
    addLink(el, 'Показать в папке', () => api.call('pack:reveal', { path: r.path }).catch(fail));
  } catch (e) {
    setHint('pack-result', e.message, 'bad');
  }
}

$('pack-mrpack').addEventListener('click', () => exportPack('mrpack'));
$('pack-zip').addEventListener('click', () => exportPack('zip'));
$('pack-app').addEventListener('click', () => exportPack('mrpack', true));
$('pack-server').addEventListener('change', renderPack);
$('pack-addr-pick').addEventListener('change', () => {
  if ($('pack-addr-pick').value) $('pack-addr').value = $('pack-addr-pick').value;
  else $('pack-addr').focus();
});

function resetMods() {
  modUpdates = new Map();
  packData = null;
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
