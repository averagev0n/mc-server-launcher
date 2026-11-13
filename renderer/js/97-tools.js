// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- здоровье, диск, журналы, новый мир, Chunky, значок, описание, ресурсы, сообщения,
//      защита входа, сборки поиском, память, флаги Java, телефон, перенос ----

const gbText = (b) => {
  if (b === null || b === undefined) return '—';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1).replace('.', ',') + ' ГБ';
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + ' МБ';
  return Math.max(1, Math.round(b / 1024)) + ' КБ';
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const btnEl = (label, fn, cls = 'btn small') => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
};
let toolsSettings = null; // настройки сервера из maint:get

// ---- подбор памяти ----

function recommendRam({ modded, mods = 0, plugins = 0, players = 10 }) {
  let rec;
  if (modded) rec = mods >= 250 ? 10 : mods >= 150 ? 8 : mods >= 80 ? 6 : mods >= 20 ? 5 : 4;
  else rec = 2 + (plugins >= 30 ? 1 : 0);
  rec += players > 20 ? 2 : players > 10 ? 1 : 0;
  return { min: modded ? Math.max(3, rec - 2) : 2, rec };
}
function ramAdvice() {
  const word = currentKind();
  const count = word ? installedMods.length : 0;
  const modded = kinds().includes('mod');
  return recommendRam({
    modded,
    mods: modded ? count : 0,
    plugins: !modded ? count : 0,
    players: Number($('p-players').value) || 10,
  });
}
const baseRenderRamHint = renderRamHint;
renderRamHint = function () {
  const ok = baseRenderRamHint();
  if (!ok || !memory) return ok;
  const { min, rec } = ramAdvice();
  const n = Number($('ram').value);
  const target = Math.min(rec, memory.maxGb);
  if (n < Math.min(min, memory.maxGb)) {
    const h = $('ram-hint');
    h.className = 'hint warn';
    h.textContent = `Мало для этого сервера${installedMods.length && kinds().includes('mod') ? ` (${installedMods.length} модов)` : ''}: лучше ${target} ГБ — иначе возможны вылеты. `;
    addLink(h, `Поставить ${target} ГБ`, () => {
      $('ram').value = target;
      store.set('ram', String(target));
      render();
    });
  } else if (n >= min && n < target && memory.maxGb >= target) {
    const h = $('ram-hint');
    h.append(` Рекомендуем ${target} ГБ.`);
  }
  return ok;
};

// ---- проверка модов перед запуском ----

async function modIssues() {
  if (!kinds().includes('mod') || !$('version').value) return [];
  try {
    return await api.call('mods:check', selected());
  } catch {
    return [];
  }
}
const baseStartServer = startServer;
startServer = async function () {
  const issues = await modIssues();
  if (issues.length) {
    const list = issues.slice(0, 12).map((i) => `• ${i.file} — ${i.text}`).join('\n');
    const more = issues.length > 12 ? `\n…и ещё ${issues.length - 12}` : '';
    if (window.confirm(`Найдены проблемы с модами (${issues.length}):\n\n${list}${more}\n\nУбрать эти моды в корзину и запустить? «Отмена» — запустить как есть.`)) {
      for (const i of issues) {
        if (i.kind === 'duplicate' || i.kind === 'client' || i.kind === 'loader' || i.kind === 'broken') {
          await api.call('mods:checkRemove', { ...selected(), file: i.file }).catch(fail);
        }
      }
      addLog(`Убрано модов: ${issues.length}. Они в корзине Windows — оттуда можно вернуть.`);
      refreshInstalled();
    }
  }
  return baseStartServer();
};

// ---- здоровье сервера ----

async function renderHealth() {
  const box = $('health');
  if (!$('version').value) return;
  box.replaceChildren(el('li', 'hint', 'Проверяю…'));
  const key = selKey();
  const items = [];
  const add = (level, text, action) => items.push({ level, text, action });
  const [usage, m, issues] = await Promise.all([
    api.call('disk:usage', selected()).catch(() => null),
    api.call('maint:get', selected()).catch(() => null),
    modIssues(),
  ]);
  if (key !== selKey()) return;
  if (usage) {
    if (usage.level === 'bad') add('bad', `На диске осталось ${gbText(usage.free)} — при нехватке места мир может повредиться при сохранении.`);
    else if (usage.level === 'warn') add('warn', `На диске осталось ${gbText(usage.free)}. Стоит освободить место.`);
    else add('ok', `Свободно на диске: ${gbText(usage.free)}.`);
  }
  if (m) {
    const last = m.backups[0];
    const age = last ? (Date.now() - new Date(last.date).getTime()) / 86400000 : null;
    if (!m.hasWorld) add('ok', 'Мира ещё нет — копировать пока нечего.');
    else if (!last) add('warn', 'Ни одной копии мира.', ['Сделать копию', () => $('bk-now').click()]);
    else if (age > 3) add('warn', `Последняя копия мира — ${Math.floor(age)} дн. назад.`, ['Сделать копию', () => $('bk-now').click()]);
    else add('ok', 'Копия мира свежая.');
  }
  if (issues.length) {
    for (const i of issues.slice(0, 6)) {
      add('bad', `${i.file}: ${i.text}`, ['Убрать', async () => {
        await api.call('mods:checkRemove', { ...selected(), file: i.file }).catch(fail);
        refreshInstalled();
        renderHealth();
      }]);
    }
    if (issues.length > 6) add('bad', `…и ещё проблемных модов: ${issues.length - 6}.`);
  } else if (kinds().includes('mod')) add('ok', 'С модами всё в порядке.');
  const { java } = effectiveJava();
  if (!java) add('bad', 'Нет подходящей Java — сервер не запустится.', ['Открыть настройки', () => { tab = 'settings'; renderTabs(); }]);
  if (memory) {
    const { min, rec } = ramAdvice();
    const n = Number($('ram').value);
    const target = Math.min(rec, memory.maxGb);
    if (n < Math.min(min, memory.maxGb)) add('warn', `Памяти ${n} ГБ — для этого сервера лучше ${target} ГБ.`, [`Поставить ${target} ГБ`, () => { $('ram').value = target; store.set('ram', String(target)); render(); renderHealth(); }]);
    else add('ok', `Памяти достаточно (${n} ГБ).`);
  }
  if (!$('p-online').checked && !hasAuthPlugin()) {
    add('warn', 'Сервер пускает без лицензии, а защиты входа паролем нет — любой может зайти под чужим ником.', ['Поставить защиту', () => offerAuth(true)]);
  }
  if ($('build-hint').textContent) add('warn', $('build-hint').textContent.replace(/\s*Обновить$/, ''), ['Открыть настройки', () => { tab = 'settings'; renderTabs(); }]);
  box.replaceChildren(
    ...items.map((it) => {
      const li = el('li', 'health-item ' + it.level);
      li.append(el('span', 'health-dot'), el('span', 'health-text', it.text));
      if (it.action) li.appendChild(btnEl(it.action[0], it.action[1]));
      return li;
    })
  );
}
$('health-refresh').addEventListener('click', () => {
  renderHealth();
  renderDisk();
});

// ---- место на диске ----

async function renderDisk() {
  if (!$('version').value) return;
  let u;
  try {
    u = await api.call('disk:usage', selected());
  } catch (e) {
    setHint('disk-hint', e.message, 'bad');
    return;
  }
  const box = $('disk');
  box.replaceChildren(
    ...[
      ['Мир', u.world],
      ['Копии мира', u.backups],
      ['Остальное', u.other],
      ['Свободно на диске', u.free],
    ].map(([label, v]) => {
      const d = el('div', 'disk-item');
      d.append(el('span', 'stat-label', label), el('b', '', gbText(v)));
      return d;
    })
  );
  if (u.level === 'bad') setHint('disk-hint', 'Места почти не осталось. Удалите старые копии мира и журналы или освободите диск — иначе мир может повредиться.', 'bad');
  else if (u.level === 'warn') setHint('disk-hint', 'Места становится мало — стоит почистить диск.', 'warn');
  else setHint('disk-hint', '');
}

// ---- журналы и отчёты о сбоях ----

async function renderLogs() {
  if (!$('version').value) return;
  let list = [];
  try {
    list = await api.call('logs:list', selected());
  } catch {
    list = [];
  }
  const box = $('lg-list');
  if (!list.length) {
    box.replaceChildren(el('p', 'hint', 'Журналов пока нет — они появятся после первого запуска.'));
    return;
  }
  box.replaceChildren(
    ...list.slice(0, 80).map((it) => {
      const b = el('button', 'lg-item' + (it.kind === 'crash' ? ' crash' : ''));
      b.type = 'button';
      const when = new Date(it.mtime).toLocaleString(I18N_LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      b.append(el('b', '', it.kind === 'crash' ? 'Сбой сервера' : it.name === 'latest.log' ? 'Последний запуск' : it.name.replace(/\.log(\.gz)?$/, '')), el('span', '', `${when} · ${gbText(it.size)}`));
      b.addEventListener('click', () => openLog(it, b));
      return b;
    })
  );
}
async function openLog(it, b) {
  for (const x of document.querySelectorAll('.lg-item')) x.removeAttribute('aria-current');
  b.setAttribute('aria-current', 'true');
  $('lg-text').textContent = 'Открываю…';
  try {
    const r = await api.call('logs:read', { ...selected(), kind: it.kind, name: it.name });
    $('lg-text').textContent = r.text || '(пусто)';
    $('lg-text').scrollTop = $('lg-text').scrollHeight;
    const box = $('lg-issues');
    box.replaceChildren(
      ...r.issues.map((i) => {
        const d = el('div', 'issue ' + (i.severity || 'error'));
        d.append(el('div', 'issue-title', i.title));
        if (i.text) d.append(el('p', 'issue-text', i.text));
        if (Array.isArray(i.fix) && i.fix.length) {
          const ul = el('ul', 'issue-fix');
          for (const f of i.fix) ul.appendChild(el('li', '', typeof f === 'string' ? f : f.text || ''));
          d.appendChild(ul);
        }
        return d;
      })
    );
    if (!r.issues.length) box.replaceChildren(el('p', 'hint', it.kind === 'crash' ? 'Понятного объяснения не нашлось — пролистайте отчёт: причина обычно в первых строках после «Description».' : 'Известных ошибок в этом журнале не найдено.'));
  } catch (e) {
    $('lg-text').textContent = e.message;
  }
}
$('lg-clean').addEventListener('click', async () => {
  const days = Number($('cl-days').value);
  if (!window.confirm(`Удалить журналы и отчёты о сбоях старше ${days} дней?`)) return;
  try {
    const r = await api.call('logs:clean', { ...selected(), days });
    setHint('lg-hint', r.files ? `Удалено файлов: ${r.files}, освобождено ${gbText(r.bytes)}.` : 'Удалять нечего — старых файлов нет.', 'good');
  } catch (e) {
    setHint('lg-hint', e.message, 'bad');
  }
  renderLogs();
  renderDisk();
});
async function saveClean() {
  try {
    await api.call('maint:set', { ...selected(), settings: { clean: { enabled: $('cl-on').checked, days: Number($('cl-days').value) } } });
    setHint('lg-hint', 'Сохранено.', 'good');
  } catch (e) {
    setHint('lg-hint', e.message, 'bad');
  }
}
$('cl-on').addEventListener('change', saveClean);
$('cl-days').addEventListener('change', saveClean);

const baseEnsureMaint = ensureMaint;
ensureMaint = function () {
  baseEnsureMaint();
  if (tab !== 'maint') return;
  renderHealth();
  renderDisk();
  renderLogs();
  setHint('lg-hint', '');
  api.call('maint:get', selected()).then((m) => {
    $('cl-on').checked = m.settings.clean.enabled;
    $('cl-days').value = String(m.settings.clean.days);
  }).catch(() => {});
};

// ---- новый мир ----

$('nw-open').addEventListener('click', () => ($('nw-box').hidden = !$('nw-box').hidden));
$('nw-go').addEventListener('click', async () => {
  if (!window.confirm(`Начать новый мир на сервере «${serverTitle(type, $('version').value)}»?\n\nТекущий мир сохранится копией — его можно вернуть во вкладке «Обслуживание».`)) return;
  setHint('nw-hint', 'Сохраняю старый мир…');
  try {
    await api.call('world:new', { ...selected(), seed: $('nw-seed').value.trim(), levelType: $('nw-level').value });
    setHint('nw-hint', 'Готово: новый мир создастся при следующем запуске. Старый — в копиях.', 'good');
  } catch (e) {
    setHint('nw-hint', e.message, 'bad');
  }
});

// ---- прогрузка мира (Chunky) ----

let chunkyInstalled = false;
async function renderChunky() {
  const card = $('ck-card');
  card.hidden = type === 'vanilla';
  if (card.hidden) return;
  const kind = type === 'paper' || isHybrid() ? 'plugin' : 'mod';
  try {
    const list = await api.call('mods:list', { ...selected(), kind });
    chunkyInstalled = list.some((x) => /chunky/i.test(x.slug || x.file || x.title || ''));
  } catch {
    chunkyInstalled = false;
  }
  $('ck-install').hidden = chunkyInstalled;
  $('ck-go').hidden = !chunkyInstalled;
  const st = await api.call('chunky:get').catch(() => null);
  showChunky(st);
}
function showChunky(st) {
  const running = st && !st.done;
  $('ck-progress').hidden = !st;
  $('ck-cancel').hidden = !running;
  $('ck-go').disabled = !!running;
  if (!st) {
    setHint('ck-hint', chunkyInstalled ? (isSelectedRunning() && state === 'running' ? '' : 'Прогрузка идёт на работающем сервере — сначала запустите его.') : '');
    return;
  }
  $('ck-bar').style.width = Math.min(100, st.pct || 0) + '%';
  setHint('ck-hint', st.done ? (st.pct >= 100 ? 'Мир прогружен.' : 'Прогрузка остановлена.') : `Прогружено ${String(st.pct || 0).replace('.', ',')}%${st.eta ? ` · осталось примерно ${st.eta}` : ''}`, st.done ? 'good' : '');
}
api.on('chunky', (st) => {
  if (tab === 'settings') showChunky(st);
});
$('ck-install').addEventListener('click', async () => {
  setHint('ck-hint', 'Устанавливаю Chunky…');
  try {
    await api.call('mods:install', { ...selected(), projectId: 'chunky', bySlug: true, kind: type === 'paper' || isHybrid() ? 'plugin' : 'mod', loader: isModded() ? $('loader').value : null });
    setHint('ck-hint', isSelectedRunning() ? 'Установлен — перезапустите сервер, чтобы Chunky заработал.' : 'Установлен.', 'good');
  } catch (e) {
    setHint('ck-hint', e.message, 'bad');
  }
  renderChunky();
});
$('ck-go').addEventListener('click', async () => {
  try {
    await api.call('chunky:start', { ...selected(), radius: Number($('ck-radius').value) });
  } catch (e) {
    setHint('ck-hint', e.message, 'bad');
  }
});
$('ck-cancel').addEventListener('click', () => api.call('chunky:cancel').catch(fail));

// ---- значок сервера ----

function showIcon(src) {
  $('ic-img').hidden = !src;
  $('ic-empty').hidden = !!src;
  $('ic-remove').hidden = !src;
  if (src) $('ic-img').src = src;
  const prev = $('motd-icon');
  prev.style.backgroundImage = src ? `url("${src}")` : '';
}
$('ic-pick').addEventListener('click', async () => {
  try {
    const src = await api.call('icon:pick', selected());
    if (src) showIcon(src);
  } catch (e) {
    setHint('srv-hint', e.message, 'bad');
  }
});
$('ic-remove').addEventListener('click', async () => {
  await api.call('icon:remove', selected()).catch(fail);
  showIcon(null);
});

// ---- цветное описание ----

const MC_COLORS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};
/** Из server.properties (§ или §) — в удобные коды «&a». */
const motdFromProps = (v) => String(v || '').replace(/\\u00a7/gi, '&').replace(/§/g, '&');
/** Обратно: «&a» → «§a» (так server.properties понимает любой сервер). */
function motdToProps(v) {
  return String(v).replace(/&([0-9a-fk-or])/gi, (_, c) => '\\u00A7' + c.toLowerCase());
}
function renderMotdPreview() {
  const out = $('motd-preview');
  out.replaceChildren();
  const text = $('p-motd').value || 'A Minecraft Server';
  let style = { color: '#AAAAAA', b: false, i: false, u: false, s: false };
  let line = el('div');
  out.appendChild(line);
  const parts = text.split(/(&[0-9a-fk-or]|\\n)/i);
  for (const part of parts) {
    if (!part) continue;
    if (part.toLowerCase() === '\\n') {
      line = el('div');
      out.appendChild(line);
      continue;
    }
    const m = part.match(/^&([0-9a-fk-or])$/i);
    if (m) {
      const c = m[1].toLowerCase();
      if (MC_COLORS[c]) style = { color: MC_COLORS[c], b: false, i: false, u: false, s: false };
      else if (c === 'l') style.b = true;
      else if (c === 'o') style.i = true;
      else if (c === 'n') style.u = true;
      else if (c === 'm') style.s = true;
      else if (c === 'r') style = { color: '#AAAAAA', b: false, i: false, u: false, s: false };
      continue;
    }
    const span = el('span', '', part);
    span.style.color = style.color;
    if (style.b) span.style.fontWeight = '700';
    if (style.i) span.style.fontStyle = 'italic';
    span.style.textDecoration = [style.u ? 'underline' : '', style.s ? 'line-through' : ''].join(' ').trim() || 'none';
    line.appendChild(span);
  }
  $('motd-name').textContent = serverTitle(type, $('version').value || '');
}
$('p-motd').addEventListener('input', renderMotdPreview);
// Цвет кнопок задаём из скрипта: встроенные стили в разметке запрещены политикой безопасности.
for (const b of document.querySelectorAll('.motd-c')) b.style.setProperty('--c', MC_COLORS[b.dataset.code.slice(1)]);
for (const b of document.querySelectorAll('#motd-tools [data-code]')) {
  b.addEventListener('click', () => {
    const input = $('p-motd');
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + b.dataset.code + input.value.slice(input.selectionEnd ?? pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + b.dataset.code.length;
    renderMotdPreview();
  });
}
const baseFillProps = fillProps;
fillProps = function (props) {
  baseFillProps(props);
  $('p-motd').value = motdFromProps(props.motd);
  renderMotdPreview();
};

// ---- защита входа для «пиратских» клиентов ----

let authInstalled = false;
function hasAuthPlugin() {
  return authInstalled;
}
async function refreshAuthState() {
  authInstalled = false;
  if (type === 'vanilla' || !$('version').value) return;
  try {
    const kind = type === 'paper' || isHybrid() ? 'plugin' : 'mod';
    const list = await api.call('mods:list', { ...selected(), kind });
    authInstalled = list.some((x) => /authme|easyauth|nlogin|librelogin/i.test(x.slug || x.file || x.title || ''));
  } catch {
    authInstalled = false;
  }
}
function authChoice() {
  if (type === 'paper' || isHybrid()) return { slug: 'authmereloaded', kind: 'plugin', name: 'AuthMe' };
  if (type === 'fabric') return { slug: 'easyauth', kind: 'mod', name: 'EasyAuth' };
  return null;
}
async function offerAuth(fromHealth) {
  await refreshAuthState();
  if (authInstalled) return;
  const c = authChoice();
  if (!c) {
    setHint('props-hint', 'Для этого типа сервера нет готовой защиты входа паролем. Включите белый список во вкладке «Игроки» — тогда зайдут только те, кого вы добавили.', 'warn');
    return;
  }
  const ok = window.confirm(
    `Друзья смогут заходить с TLauncher и других клиентов без лицензии.\n\nНо тогда любой может зайти под чужим ником — например, под вашим, и получить права администратора.\n\nПоставить ${c.name}? Каждый игрок при первом входе придумает пароль (/register), а потом будет входить командой /login.`
  );
  if (!ok) {
    if (!fromHealth) setHint('props-hint', 'Защита входа не установлена. Если передумаете — она есть в «Обслуживание» → «Здоровье сервера».', 'warn');
    return;
  }
  setHint('props-hint', `Устанавливаю ${c.name}…`);
  try {
    await api.call('mods:install', { ...selected(), projectId: c.slug, bySlug: true, kind: c.kind, loader: isModded() ? $('loader').value : null });
    authInstalled = true;
    setHint('props-hint', `${c.name} установлен. Не забудьте нажать «Сохранить» и перезапустить сервер.`, 'good');
    refreshInstalled();
  } catch (e) {
    setHint('props-hint', `${c.name} не установился: ${e.message}`, 'bad');
  }
}
$('p-online').addEventListener('change', () => {
  if (!$('p-online').checked) offerAuth(false);
});

// ---- сборки модов поиском ----

$('mp-open').addEventListener('click', () => {
  $('mp').hidden = !$('mp').hidden;
  if (!$('mp').hidden) {
    $('mp-q').focus();
    if (!$('mp-list').children.length) searchPacks('');
  }
});
async function searchPacks(q) {
  setHint('mp-hint', 'Ищу…');
  let list = [];
  try {
    list = await api.call('mrpack:search', { query: q });
  } catch (e) {
    setHint('mp-hint', e.message, 'bad');
    return;
  }
  setHint('mp-hint', list.length ? '' : 'Ничего не нашлось.');
  $('mp-list').replaceChildren(
    ...list.map((p) => {
      const row = el('div', 'item');
      const img = el('img', 'item-icon');
      img.alt = '';
      if (p.icon) img.src = p.icon;
      const body = el('div', 'item-body');
      const title = el('div', 'item-title');
      title.append(el('span', 'name plain', p.title), el('span', 'meta', `${formatCount(p.downloads)} загрузок${p.versions.length ? ' · Minecraft ' + p.versions[p.versions.length - 1] : ''}`));
      body.append(title, el('p', 'item-desc', p.description));
      const go = btnEl('Создать сервер', async () => {
        if (state !== 'stopped') return setHint('mp-hint', 'Остановите сервер, прежде чем ставить сборку.', 'warn');
        go.disabled = true;
        setHint('mp-hint', `Скачиваю «${p.title}»…`);
        try {
          const info = await api.call('mrpack:fromModrinth', { projectId: p.id });
          setHint('mp-hint', '');
          await confirmAndApplyPack(info);
        } catch (e) {
          setHint('mp-hint', e.message, 'bad');
        }
        go.disabled = false;
      }, 'btn small primary');
      row.append(img, body, go);
      return row;
    })
  );
}
$('mp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  searchPacks($('mp-q').value.trim());
});

// ---- флаги Java, ресурсы, сообщения ----

$('jvm-aikar').addEventListener('change', () =>
  api.call('maint:set', { ...selected(), settings: { jvm: { aikar: $('jvm-aikar').checked } } }).catch(fail)
);

$('rp-save').addEventListener('click', async () => {
  setHint('rp-hint', $('rp-url').value.trim() ? 'Скачиваю набор, чтобы посчитать контрольную сумму…' : '');
  try {
    const r = await api.call('pack:resource', { ...selected(), url: $('rp-url').value.trim(), require: $('rp-require').checked });
    setHint('rp-hint', r.sha1 ? `Сохранено (${gbText(r.size)}). Игрокам предложат набор при входе${isSelectedRunning() ? ' — после перезапуска сервера' : ''}.` : 'Набор ресурсов убран.', 'good');
  } catch (e) {
    setHint('rp-hint', e.message, 'bad');
  }
});

const EVERY = [[15, 'каждые 15 минут'], [30, 'каждые 30 минут'], [60, 'каждый час'], [120, 'каждые 2 часа'], [240, 'каждые 4 часа']];
function msgRow(m = { every: 60, text: '' }) {
  const row = el('div', 'msg-row');
  const sel = el('select');
  sel.replaceChildren(...EVERY.map(([v, l]) => new Option(l, String(v))));
  sel.value = String(EVERY.some(([v]) => v === m.every) ? m.every : 60);
  const input = el('input');
  input.type = 'text';
  input.maxLength = 200;
  input.placeholder = 'Текст в чат, например: Наш Discord — discord.gg/…';
  input.value = m.text;
  row.append(sel, input, btnEl('✕', () => row.remove(), 'btn small'));
  return row;
}
$('msg-add').addEventListener('click', () => {
  if ($('msg-list').children.length >= 10) return setHint('msg-hint', 'Не больше 10 сообщений.', 'warn');
  $('msg-list').appendChild(msgRow());
});
$('msg-save').addEventListener('click', async () => {
  const list = [...$('msg-list').children].map((r) => ({ every: Number(r.querySelector('select').value), text: r.querySelector('input').value.trim() }));
  try {
    await api.call('maint:set', { ...selected(), settings: { messages: { welcome: $('msg-welcome').value.trim(), list } } });
    setHint('msg-hint', 'Сохранено.', 'good');
  } catch (e) {
    setHint('msg-hint', e.message, 'bad');
  }
});

// ---- управление с телефона ----

function showRemote(r) {
  $('rm-on').checked = r.enabled;
  $('rm-box').hidden = !r.enabled;
  $('rm-url').textContent = r.url || '';
  $('rm-code').textContent = r.code || '';
}
$('rm-on').addEventListener('change', async () => {
  try {
    showRemote(await api.call('remote:set', { on: $('rm-on').checked }));
    setHint('rm-hint', $('rm-on').checked ? 'Если Windows спросит про доступ к сети — разрешите для частных сетей.' : '');
  } catch (e) {
    $('rm-on').checked = false;
    setHint('rm-hint', e.message, 'bad');
  }
});
$('rm-new').addEventListener('click', async () => showRemote(await api.call('remote:newCode')));

// ---- перенос на другой ПК ----

$('tr-export').addEventListener('click', async () => {
  setHint('tr-hint', 'Собираю архив…');
  try {
    const r = await api.call('transfer:export', { includeBackups: $('tr-backups').checked });
    setHint('tr-hint', r ? `Готово: ${r.file} (${gbText(r.size)}, серверов: ${r.servers}). Перенесите файл на новый компьютер.` : '', 'good');
  } catch (e) {
    setHint('tr-hint', e.message, 'bad');
  }
});
$('tr-import').addEventListener('click', async () => {
  setHint('tr-hint', 'Восстанавливаю…');
  try {
    const r = await api.call('transfer:import');
    if (!r) return setHint('tr-hint', '');
    await refreshServers();
    setHint('tr-hint', `Добавлено серверов: ${r.added.length}${r.skipped.length ? `. Уже были и не тронуты: ${r.skipped.join(', ')}` : ''}. При первом запуске каждого сервера его файлы скачаются заново.`, 'good');
  } catch (e) {
    setHint('tr-hint', e.message, 'bad');
  }
});

// ---- загрузка для вкладки «Настройки» ----

async function loadTools() {
  const key = selKey();
  showIcon(null);
  for (const id of ['nw-hint', 'ck-hint', 'rp-hint', 'msg-hint', 'rm-hint', 'tr-hint']) setHint(id, '');
  $('nw-box').hidden = true;
  const [m, icon, rp, rm] = await Promise.all([
    api.call('maint:get', selected()).catch(() => null),
    api.call('icon:get', selected()).catch(() => null),
    api.call('pack:resourceGet', selected()).catch(() => null),
    api.call('remote:get').catch(() => null),
  ]);
  if (key !== selKey()) return;
  showIcon(icon);
  if (m) {
    toolsSettings = m.settings;
    $('jvm-aikar').checked = m.settings.jvm.aikar;
    $('msg-welcome').value = m.settings.messages.welcome;
    $('msg-list').replaceChildren(...m.settings.messages.list.map(msgRow));
  }
  if (rp) {
    $('rp-url').value = rp.url;
    $('rp-require').checked = rp.require;
  }
  if (rm) showRemote(rm);
  renderChunky();
  refreshAuthState();
  renderMotdPreview();
}
const baseLoadMore = loadMore;
loadMore = async function () {
  await baseLoadMore();
  loadTools();
};
