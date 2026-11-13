// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- карта мира, датапаки, события и достижения, проверка копий, открытка, мини-окно, шаблоны миров ----

// ---- вкладки «Карта» и «Датапаки» ----

const baseRenderTabsT3 = renderTabs;
let t3Last = '';
renderTabs = function () {
  baseRenderTabsT3();
  $('view-map').hidden = tab !== 'map';
  $('view-dp').hidden = tab !== 'dp';
  const key = tab + '|' + selKey();
  if (key !== t3Last) {
    t3Last = key;
    if (tab === 'map') mapOpen();
    if (tab === 'dp') dpLoad();
  }
  if (tab === 'map') requestAnimationFrame(mapDraw);
};

// ---- датапаки ----

let dpData = { list: [], hasWorld: false, live: false };
let dpSearch = { q: '', hits: [], total: 0 };
const dpBusy = new Set();

function dpRow(icon, titleText, metaText, descText) {
  const { row, body } = itemShell(icon);
  const title = document.createElement('div');
  title.className = 'item-title';
  const name = document.createElement('span');
  name.className = 'name plain';
  name.textContent = titleText;
  title.appendChild(name);
  if (metaText) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = metaText;
    title.appendChild(meta);
  }
  body.appendChild(title);
  if (descText) {
    const d = document.createElement('p');
    d.className = 'item-desc';
    d.textContent = descText;
    body.appendChild(d);
  }
  return row;
}
function dpAfterChange(r, what) {
  const how = r && r.reloaded ? 'Сервер уже подхватил изменения.' : 'Изменения вступят в силу при следующем запуске сервера.';
  setHint('dp-hint', `${what} ${how}`, 'good');
}
function dpRender() {
  const box = $('dp-list');
  box.replaceChildren(
    ...dpData.list.map((d) => {
      const row = dpRow(d.icon, d.title || d.file, [d.version, d.folder ? 'папка' : ''].filter(Boolean).join(' · '), d.title ? d.file : '');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = 'Удалить';
      b.addEventListener('click', async () => {
        if (!window.confirm(`Удалить датапак «${d.title || d.file}»? Он уйдёт в корзину.`)) return;
        try {
          dpAfterChange(await api.call('dp:remove', { ...selected(), file: d.file }), 'Удалено.');
          dpLoad(true);
        } catch (e) {
          setHint('dp-hint', e.message, 'bad');
        }
      });
      row.appendChild(b);
      return row;
    })
  );
  if (!dpData.list.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Датапаков пока нет. Датапаки работают на любом сервере, даже на обычном, и не нужны игрокам.';
    box.appendChild(p);
  }
  const have = new Set(dpData.list.map((d) => d.projectId).filter(Boolean));
  $('dp-results').replaceChildren(
    ...dpSearch.hits.map((h) => {
      const row = dpRow(h.icon, h.title, `${h.author} · ${formatCount(h.downloads)} загрузок${h.worldgen ? ' · меняет генерацию мира' : ''}`, h.description);
      row.querySelector('.name').classList.remove('plain');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      if (have.has(h.id)) {
        b.textContent = 'Установлен';
        b.disabled = true;
      } else if (dpBusy.has(h.id)) {
        b.textContent = 'Ставлю…';
        b.disabled = true;
      } else {
        b.textContent = 'Установить';
        b.classList.add('primary');
        b.addEventListener('click', () => dpInstall(h));
      }
      row.appendChild(b);
      return row;
    })
  );
  $('dp-more').hidden = dpSearch.hits.length >= dpSearch.total || !dpSearch.hits.length;
}
async function dpLoad(keepHint) {
  if (!$('version').value) return;
  try {
    dpData = await api.call('dp:list', selected());
  } catch (e) {
    setHint('dp-hint', e.message, 'bad');
    return;
  }
  if (!keepHint) setHint('dp-hint', dpData.hasWorld ? '' : 'Мира ещё нет — датапаки применятся, когда сервер создаст мир при первом запуске.');
  dpRender();
  if (!dpSearch.hits.length) dpFind(false);
}
async function dpFind(more) {
  const q = more ? dpSearch.q : $('dp-q').value.trim();
  try {
    const r = await api.call('dp:search', { version: $('version').value, query: q, offset: more ? dpSearch.hits.length : 0 });
    dpSearch = { q, hits: more ? [...dpSearch.hits, ...r.hits] : r.hits, total: r.total };
    dpRender();
  } catch (e) {
    setHint('dp-hint', e.message, 'bad');
  }
}
async function dpInstall(h) {
  dpBusy.add(h.id);
  dpRender();
  try {
    const r = await api.call('dp:install', { ...selected(), projectId: h.id });
    dpAfterChange(r, `Установлено: ${r.added.join(', ') || h.title}.${h.worldgen ? ' Новая генерация будет только в ещё не открытых местах мира.' : ''}`);
  } catch (e) {
    setHint('dp-hint', e.message, 'bad');
  }
  dpBusy.delete(h.id);
  await dpLoad(true);
}
$('dp-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  dpFind(false);
});
$('dp-more').addEventListener('click', () => dpFind(true));
for (const [id, folder] of [['dp-add', false], ['dp-add-folder', true]]) {
  $(id).addEventListener('click', async () => {
    try {
      const r = await api.call('dp:add', { ...selected(), folder });
      if (r) dpAfterChange(r, `Добавлено: ${r.added.join(', ')}.`);
      dpLoad(true);
    } catch (e) {
      setHint('dp-hint', e.message, 'bad');
    }
  });
}
$('dp-open').addEventListener('click', () => api.call('dp:open', selected()).catch(fail));

// ---- карта мира ----

const map = { dim: 'overworld', cx: 0, cz: 0, scale: 0.5, list: [], players: [], tiles: new Map(), queue: [], loading: 0, changes: new Map(), sel: null, selRegions: new Set(), key: '' };
const mapKey = (rx, rz) => `${rx},${rz}`;

async function mapOpen() {
  const key = selKey() + '|' + map.dim;
  setHint('wm-hint', 'Загружаю…');
  let r;
  try {
    r = await api.call('map:regions', { ...selected(), dim: map.dim });
  } catch (e) {
    setHint('wm-hint', e.message, 'bad');
    return;
  }
  if (map.key !== key) {
    map.key = key;
    map.tiles.clear();
    map.changes.clear();
    map.selRegions.clear();
    map.list = r.list;
    mapFit();
  }
  map.list = r.list;
  map.players = r.players;
  for (const b of document.querySelectorAll('[data-mapdim]')) b.setAttribute('aria-selected', String(b.dataset.mapdim === map.dim));
  // Копии для сравнения и отката.
  try {
    const m = await api.call('maint:get', selected());
    const sel = $('map-backup');
    const keep = sel.value;
    sel.replaceChildren(...m.backups.map((b) => new Option(`Копия: ${new Date(b.date).toLocaleString(I18N_LOCALE, { dateStyle: 'short', timeStyle: 'short' })}`, b.file)));
    if (m.backups.some((b) => b.file === keep)) sel.value = keep;
    $('map-changes').disabled = !m.backups.length;
  } catch {
    /* без копий */
  }
  setHint(
    'wm-hint',
    r.list.length
      ? 'Перетаскивайте карту мышью, колесо — приближение. Точки — игроки (где были при выходе, зелёные — сейчас в игре).'
      : 'Мира ещё нет или он пуст — карта появится после первого запуска сервера.'
  );
  mapDraw();
}
function mapFit() {
  const c = $('map');
  if (!map.list.length) {
    map.cx = 0;
    map.cz = 0;
    map.scale = 0.5;
    return;
  }
  const xs = map.list.map((r) => r[0]);
  const zs = map.list.map((r) => r[1]);
  const x1 = Math.min(...xs) * 512;
  const x2 = (Math.max(...xs) + 1) * 512;
  const z1 = Math.min(...zs) * 512;
  const z2 = (Math.max(...zs) + 1) * 512;
  map.cx = (x1 + x2) / 2;
  map.cz = (z1 + z2) / 2;
  const w = c.clientWidth || 800;
  const h = c.clientHeight || 500;
  map.scale = Math.max(0.05, Math.min(2, Math.min(w / (x2 - x1), h / (z2 - z1)) * 0.95));
}
function mapPump() {
  while (map.loading < 2 && map.queue.length) {
    const [rx, rz, key] = map.queue.shift();
    const k = mapKey(rx, rz);
    const t = map.tiles.get(k);
    if (!t || t.bmp || t.failed || key !== map.key) continue;
    map.loading++;
    api
      .call('map:tile', { ...selected(), dim: map.dim, rx, rz, scale: 4 })
      .then(async (res) => {
        if (key !== map.key) return;
        if (!res) t.failed = true;
        else t.bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(res.rgba), res.size, res.size));
      })
      .catch(() => (t.failed = true))
      .finally(() => {
        map.loading--;
        mapDraw();
        mapPump();
      });
  }
}
let mapDrawQueued = false;
function mapDraw() {
  if (mapDrawQueued) return;
  mapDrawQueued = true;
  requestAnimationFrame(() => {
    mapDrawQueued = false;
    mapPaint();
  });
}
function mapPaint() {
  const c = $('map');
  if (tab !== 'map' || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = (n, d) => css.getPropertyValue(n).trim() || d;
  const sx = (x) => (x - map.cx) * map.scale + w / 2;
  const sz = (z) => (z - map.cz) * map.scale + h / 2;
  const size = 512 * map.scale;
  for (const [rx, rz] of map.list) {
    const x = sx(rx * 512);
    const y = sz(rz * 512);
    if (x > w || y > h || x + size < 0 || y + size < 0) continue;
    const k = mapKey(rx, rz);
    let t = map.tiles.get(k);
    if (!t) {
      t = {};
      map.tiles.set(k, t);
      map.queue.push([rx, rz, map.key]);
    }
    if (t.bmp) g.drawImage(t.bmp, x, y, size, size);
    else {
      g.fillStyle = col('--line', '#ddd');
      g.fillRect(x + 1, y + 1, size - 2, size - 2);
    }
    const ch = map.changes.get(k);
    if (ch) {
      g.fillStyle = `rgba(255, 140, 0, ${Math.min(0.55, 0.15 + ch / 600)})`;
      g.fillRect(x, y, size, size);
    }
    if (map.selRegions.has(k)) {
      g.fillStyle = 'rgba(47, 91, 234, 0.25)';
      g.fillRect(x, y, size, size);
      g.strokeStyle = col('--accent', '#2f5bea');
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, size - 2, size - 2);
    }
    if (size > 60) {
      g.strokeStyle = 'rgba(0,0,0,0.12)';
      g.lineWidth = 1;
      g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(size), Math.round(size));
    }
  }
  mapPump();
  if (map.sel) {
    const { x1, z1, x2, z2 } = map.sel;
    g.setLineDash([5, 4]);
    g.strokeStyle = col('--accent', '#2f5bea');
    g.lineWidth = 1.5;
    g.strokeRect(sx(Math.min(x1, x2)), sz(Math.min(z1, z2)), Math.abs(x2 - x1) * map.scale, Math.abs(z2 - z1) * map.scale);
    g.setLineDash([]);
  }
  g.font = `12px ${col('--sans', 'sans-serif')}`;
  g.textBaseline = 'middle';
  for (const p of map.players) {
    const x = sx(p.x);
    const y = sz(p.z);
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fillStyle = p.online ? '#22c55e' : '#f8fafc';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#111';
    g.stroke();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(p.name, x + 9, y);
    g.fillStyle = '#fff';
    g.fillText(p.name, x + 9, y);
  }
}
function mapToBlock(ev) {
  const c = $('map');
  const r = c.getBoundingClientRect();
  return { x: Math.floor((ev.clientX - r.left - r.width / 2) / map.scale + map.cx), z: Math.floor((ev.clientY - r.top - r.height / 2) / map.scale + map.cz) };
}
function mapSelUpdate() {
  map.selRegions.clear();
  if (map.sel) {
    const have = new Set(map.list.map(([a, b]) => mapKey(a, b)));
    const [x1, x2] = [Math.min(map.sel.x1, map.sel.x2), Math.max(map.sel.x1, map.sel.x2)];
    const [z1, z2] = [Math.min(map.sel.z1, map.sel.z2), Math.max(map.sel.z1, map.sel.z2)];
    for (let rx = Math.floor(x1 / 512); rx <= Math.floor(x2 / 512); rx++) {
      for (let rz = Math.floor(z1 / 512); rz <= Math.floor(z2 / 512); rz++) if (have.has(mapKey(rx, rz)) && map.selRegions.size < 64) map.selRegions.add(mapKey(rx, rz));
    }
  }
  const n = map.selRegions.size;
  $('map-sel').hidden = !n;
  $('map-sel-text').textContent = `Выделено областей: ${n} (по 512 × 512 блоков)`;
}
let mapDrag = null;
$('map').addEventListener('pointerdown', (ev) => {
  $('map').setPointerCapture(ev.pointerId);
  const b = mapToBlock(ev);
  if ($('map-select').checked) {
    map.sel = { x1: b.x, z1: b.z, x2: b.x, z2: b.z };
    mapDrag = { select: true };
  } else {
    mapDrag = { x: ev.clientX, y: ev.clientY, cx: map.cx, cz: map.cz };
    $('map').classList.add('dragging');
  }
});
$('map').addEventListener('pointermove', (ev) => {
  const b = mapToBlock(ev);
  $('map-coords').textContent = `X ${b.x}  Z ${b.z}`;
  if (!mapDrag) return;
  if (mapDrag.select) {
    map.sel.x2 = b.x;
    map.sel.z2 = b.z;
    mapSelUpdate();
  } else {
    map.cx = mapDrag.cx - (ev.clientX - mapDrag.x) / map.scale;
    map.cz = mapDrag.cz - (ev.clientY - mapDrag.y) / map.scale;
  }
  mapDraw();
});
const mapUp = () => {
  if (mapDrag && mapDrag.select) map.sel = null;
  mapDrag = null;
  $('map').classList.remove('dragging');
  mapDraw();
};
$('map').addEventListener('pointerup', mapUp);
$('map').addEventListener('pointercancel', mapUp);
$('map').addEventListener('pointerleave', () => ($('map-coords').textContent = ''));
$('map').addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const before = mapToBlock(ev);
    map.scale = Math.max(0.03, Math.min(4, map.scale * (ev.deltaY < 0 ? 1.2 : 1 / 1.2)));
    const after = mapToBlock(ev);
    map.cx += before.x - after.x;
    map.cz += before.z - after.z;
    mapDraw();
  },
  { passive: false }
);
$('map-select').addEventListener('change', () => $('map').classList.toggle('selecting', $('map-select').checked));
$('map-clear').addEventListener('click', () => {
  map.selRegions.clear();
  $('map-sel').hidden = true;
  mapDraw();
});
for (const b of document.querySelectorAll('[data-mapdim]')) {
  b.addEventListener('click', () => {
    map.dim = b.dataset.mapdim;
    mapOpen();
  });
}
$('map-refresh').addEventListener('click', () => {
  map.key = '';
  mapOpen();
});
$('map-changes').addEventListener('click', async () => {
  setHint('wm-hint', 'Сравниваю с копией…');
  try {
    const r = await api.call('regions:compare', { ...selected(), file: $('map-backup').value });
    map.changes.clear();
    for (const x of r.list) if (x.dim === map.dim) map.changes.set(mapKey(x.rx, x.rz), x.changed + x.added + x.removed);
    setHint('wm-hint', map.changes.size ? `Оранжевым — области, где что-то менялось после этой копии (${map.changes.size}). Чем ярче, тем больше изменений.` : 'С этой копии мир не менялся.');
  } catch (e) {
    setHint('wm-hint', e.message, 'bad');
  }
  mapDraw();
});
$('map-restore').addEventListener('click', async () => {
  const list = [...map.selRegions].map((k) => k.split(',').map(Number));
  if (!list.length) return;
  if (!window.confirm(`Вернуть ${list.length} обл. из копии? Всё, что построено там после копии, пропадёт. Текущий мир перед этим сохранится копией.`)) return;
  setHint('wm-hint', 'Возвращаю…');
  try {
    const r = await api.call('regions:restore', { ...selected(), file: $('map-backup').value, dim: map.dim, list });
    setHint('wm-hint', `Готово: возвращено областей — ${r.regions}. Текущий мир перед этим сохранён копией.`, 'good');
    map.selRegions.clear();
    $('map-sel').hidden = true;
    map.key = '';
    mapOpen();
  } catch (e) {
    setHint('wm-hint', e.message, 'bad');
  }
});
window.addEventListener('resize', () => tab === 'map' && mapDraw());

// ---- события и достижения ----

function funRender(f) {
  if (!f) return;
  $('ev-active').replaceChildren(
    ...f.active.map((e) => {
      const d = document.createElement('div');
      const t = document.createElement('span');
      t.textContent = `Идёт «${e.title}» — до ${hhmm(e.until)}`;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = 'Закончить';
      b.addEventListener('click', () => funCall('fun:stop', { id: e.id }, 'Событие закончено.'));
      d.append(t, b);
      return d;
    })
  );
  $('ach-on').checked = f.enabled;
  const box = $('ach-list');
  const rows = [
    ...f.achievements.firsts.map((a) => ['★', a.name, a.text, new Date(a.at).toLocaleDateString(I18N_LOCALE)]),
    ...f.achievements.hours.map((a) => ['⏱', a.name, `${a.hours} ч в игре`, '']),
  ];
  box.replaceChildren(
    ...rows.map(([i, name, text, when]) => {
      const d = document.createElement('div');
      d.className = 'ach';
      const s = document.createElement('span');
      s.textContent = i;
      const b = document.createElement('b');
      b.textContent = name;
      const t = document.createElement('span');
      t.textContent = text;
      const w = document.createElement('span');
      w.className = 'when';
      w.textContent = when;
      d.append(s, b, t, w);
      return d;
    })
  );
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Пока пусто — первые достижения появятся, когда игроки начнут играть.';
    box.appendChild(p);
  }
}
async function funCall(ch, args, ok) {
  try {
    funRender(await api.call(ch, { ...selected(), ...args }));
    setHint('ev-hint', ok, 'good');
  } catch (e) {
    setHint('ev-hint', e.message, 'bad');
  }
}
for (const b of document.querySelectorAll('[data-event]')) {
  b.addEventListener('click', () => funCall('fun:event', { id: b.dataset.event }, `«${b.textContent}» — объявлено в чате.`));
}
$('ev-gift-form').addEventListener('submit', (e) => {
  e.preventDefault();
  funCall('fun:event', { id: 'gift', arg: $('ev-gift').value || 'cake' }, 'Подарок выдан всем, кто сейчас на сервере.');
});
$('ach-on').addEventListener('change', () => funCall('fun:setAchievements', { on: $('ach-on').checked }, $('ach-on').checked ? 'Достижения включены.' : 'Достижения выключены.'));
api.on('fun', (f) => funRender(f));
const baseLoadPlayersT3 = loadPlayers;
loadPlayers = async function () {
  await baseLoadPlayersT3();
  try {
    funRender(await api.call('fun:get', selected()));
  } catch {
    /* сервер не выбран */
  }
};

// ---- проверка копий ----

async function bkShow() {
  let st;
  try {
    st = await api.call('bk:state', selected());
  } catch {
    return;
  }
  const last = Object.entries(st).sort((a, b) => b[1].at - a[1].at)[0];
  $('bv-verify').disabled = !(mtData && mtData.backups.length);
  if (!last) return setHint('bv-hint', 'Раз в неделю лаунчер сам проверяет, что последнюю копию мира можно прочитать и восстановить. Проверок ещё не было.');
  const [file, r] = last;
  const when = new Date(r.at).toLocaleString(I18N_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
  if (r.ok) setHint('bv-hint', `Копия ${file.slice(0, 16).replace('_', ' ')} проверена ${when}: читается целиком, мир в ней цел (областей: ${r.regions}).`, 'good');
  else setHint('bv-hint', `Копия ${file.slice(0, 16).replace('_', ' ')} повреждена: ${r.error}. Сделайте новую копию.`, 'bad');
}
$('bv-verify').addEventListener('click', async () => {
  setHint('bv-hint', 'Проверяю копию — читаю её целиком…');
  $('bv-verify').disabled = true;
  try {
    await api.call('bk:verify', selected());
  } catch (e) {
    setHint('bv-hint', e.message, 'bad');
  }
  $('bv-verify').disabled = false;
  bkShow();
});
const baseLoadMaintT3 = loadMaint;
loadMaint = async function () {
  await baseLoadMaintT3();
  if (tab === 'maint') bkShow();
};

// ---- открытка-приглашение ----

let ivData = null;
let ivIcon = null;
async function ivLoad() {
  try {
    ivData = await api.call('invite:data', selected());
  } catch {
    return;
  }
  ivIcon = await createImageBitmap(new Blob([ivData.icon], { type: 'image/png' })).catch(() => null);
  $('iv-title').value = ivData.title;
  const lan = (typeof addresses !== 'undefined' && addresses.find((a) => !a.vpn)) || null;
  const port = ivData.port === 25565 ? '' : ':' + ivData.port;
  $('iv-addr').value = ivData.tunnel || (lan ? lan.address + port : '');
  if (!$('iv-note').value) $('iv-note').value = 'Заходи — играем вместе!';
  await document.fonts.load('700 64px Onest').catch(() => {});
  ivDraw();
}
function ivDraw() {
  if (!ivData) return;
  const c = $('iv-canvas');
  const g = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1f3b2c');
  bg.addColorStop(1, '#16202e');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // Пиксельная трава снизу.
  const cell = 24;
  for (let x = 0; x < W; x += cell) {
    const depth = 2 + ((x / cell) * 7) % 3;
    for (let r = 0; r < 4; r++) {
      const y = H - (4 - r) * cell;
      g.fillStyle = r < depth - 1 ? ['#5fae44', '#4a9135', '#6dbb4f'][(x / cell + r) % 3] : ['#7a5536', '#6b4a2f'][(x / cell + r) % 2];
      g.fillRect(x, y, cell, cell);
    }
  }
  if (ivIcon) {
    g.imageSmoothingEnabled = false;
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(64, 72, 176, 176);
    g.drawImage(ivIcon, 56, 64, 176, 176);
  }
  const font = (w, s) => `${w} ${s}px Onest, "Segoe UI", sans-serif`;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#a7f3a0';
  g.font = font(600, 26);
  g.fillText('ПРИГЛАШЕНИЕ НА СЕРВЕР', 272, 104);
  g.fillStyle = '#ffffff';
  let size = 64;
  const title = $('iv-title').value || ivData.title;
  g.font = font(800, size);
  while (g.measureText(title).width > W - 300 && size > 30) g.font = font(800, (size -= 4));
  g.fillText(title, 272, 104 + size + 6);
  g.fillStyle = '#c9d4e3';
  g.font = font(500, 26);
  g.fillText(`Minecraft ${ivData.version}${ivData.modded ? ' · с модами — сборку пришлю' : ''}`, 272, 104 + size + 52);
  const addr = $('iv-addr').value.trim();
  if (addr) {
    g.font = font(500, 24);
    g.fillStyle = '#a9b6c8';
    g.fillText('Адрес для входа:', 56, 318);
    g.font = `700 44px "JetBrains Mono", Consolas, monospace`;
    const aw = g.measureText(addr).width;
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.fillRect(48, 334, Math.min(W - 96, aw + 36), 66);
    g.fillStyle = '#ffd23f';
    g.fillText(addr, 66, 382);
  }
  const note = $('iv-note').value.trim();
  if (note) {
    g.font = font(600, 28);
    g.fillStyle = '#ffffff';
    g.fillText(note, 56, 448);
  }
}
for (const id of ['iv-title', 'iv-addr', 'iv-note']) $(id).addEventListener('input', ivDraw);
$('iv-copy').addEventListener('click', async () => {
  try {
    await api.call('invite:copy', { png: $('iv-canvas').toDataURL('image/png') });
    setHint('iv-hint', 'Скопировано — вставьте в чат сочетанием Ctrl+V.', 'good');
  } catch (e) {
    setHint('iv-hint', e.message, 'bad');
  }
});
$('iv-save').addEventListener('click', async () => {
  try {
    const p = await api.call('invite:save', { png: $('iv-canvas').toDataURL('image/png'), name: $('iv-title').value });
    if (p) setHint('iv-hint', 'Сохранено.', 'good');
  } catch (e) {
    setHint('iv-hint', e.message, 'bad');
  }
});
const baseLoadToolsT3 = loadTools;
loadTools = async function () {
  await baseLoadToolsT3();
  ivLoad();
};

// ---- шаблоны миров в мастере ----

const baseApplyWizardWorld = applyWizardWorld;
applyWizardWorld = async function (t, v) {
  const lvl = $('wz-level').value;
  if (wzWorld !== 'import' && lvl.startsWith('tpl:')) {
    if (info && info.installed) return;
    await api.call('world:template', { type: t, version: v, template: lvl.slice(4), seed: $('wz-seed').value.trim() });
    return;
  }
  return baseApplyWizardWorld(t, v);
};

// ---- вкладки не помещаются в узком окне: колесо мыши листает их вбок ----

const tabsBar = document.querySelector('.tabs');
tabsBar.addEventListener(
  'wheel',
  (ev) => {
    if (tabsBar.scrollWidth <= tabsBar.clientWidth || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    ev.preventDefault();
    tabsBar.scrollLeft += ev.deltaY;
  },
  { passive: false }
);
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => t.scrollIntoView({ block: 'nearest', inline: 'nearest' }));

// ---- мини-окно ----

$('widget-open').addEventListener('click', () => api.call('widget:open').catch(fail));
