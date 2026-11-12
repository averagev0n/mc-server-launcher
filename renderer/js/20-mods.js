// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
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

// ---- обновления модов и плагинов ----

let modUpdates = new Map(); // файл → { update, latest, latestType }

async function checkModUpdates() {
  setHint('installed-hint', 'Проверяю обновления на Modrinth…');
  try {
    const list = await api.call('mods:checkUpdates', modsArgs());
    modUpdates = new Map(list.map((x) => [x.file, x]));
    const n = list.filter((x) => x.update).length;
    renderInstalled();
    setHint('installed-hint', n ? `Можно обновить: ${n}.` : 'Всё актуально.', n ? 'warn' : 'good');
  } catch (e) {
    setHint('installed-hint', e.message, 'bad');
  }
}

async function updateMods(files) {
  let done = 0;
  for (const file of files) {
    setHint('installed-hint', `Обновляю ${done + 1} из ${files.length}…`);
    try {
      await api.call('mods:update', { ...modsArgs(), file });
      done++;
    } catch (e) {
      setHint('installed-hint', e.message, 'bad');
      break;
    }
  }
  await refreshInstalled();
  await checkModUpdates();
  if (done) setHint('installed-hint', `Обновлено: ${done}. Старые файлы сохранены в папке backups сервера.`, 'good');
}

$('mods-upd-check').addEventListener('click', checkModUpdates);
$('mods-upd-all').addEventListener('click', () => {
  const files = [...modUpdates.values()].filter((x) => x.update).map((x) => x.file);
  if (files.length) updateMods(files);
});

function renderInstalled() {
  $('mods-upd-all').hidden = ![...modUpdates.values()].some((x) => x.update);
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
    const upd = modUpdates.get(m.file);
    if (upd && upd.update) {
      const b = document.createElement('span');
      b.className = 'badge good';
      b.textContent = `обновление: ${upd.latest}${upd.latestType && upd.latestType !== 'release' ? ' (бета)' : ''}`;
      title.appendChild(b);
    }
    const meta = document.createElement('p');
    meta.className = 'item-desc';
    meta.textContent = [m.version, m.title ? m.file : null, formatSize(m.size)].filter(Boolean).join(' · ');
    body.append(title, meta);
    if (upd && upd.update) {
      const ub = document.createElement('button');
      ub.type = 'button';
      ub.className = 'btn primary';
      ub.textContent = 'Обновить';
      ub.addEventListener('click', () => updateMods([m.file]));
      row.appendChild(ub);
    }
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
