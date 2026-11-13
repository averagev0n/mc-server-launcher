// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- журнал с подсветкой, карточка игрока, почему тормозит, новая версия, откат части мира, граница мира ----

// ---- журнал: подсветка и фильтр ----

const LOG_RULES = [
  [/\/(ERROR|FATAL)\]|^\s+at [\w$.<>]+\(|^[\w.$]+(Exception|Error):/, 'lvl-error'],
  [/\/WARN\]/, 'lvl-warn'],
  [/ joined the game$| left the game$| lost connection: /, 'ev-join'],
  [/\]:\s(?:\[Not Secure\]\s)?<[.\w]{1,17}>\s/, 'ev-chat'],
  [/UUID of player|logged in with entity id|Preparing spawn area|Saving chunks|Saving the game|Saved the game|Automatic saving|ThreadedAnvilChunkStorage|Preparing level|Loading properties|Default game type|Generating keypair/, 'ev-noise'],
];
function tagLine(el) {
  if (!el || !/^(server|error)$/.test(el.className)) return;
  const t = el.textContent;
  for (const [re, cls] of LOG_RULES) {
    if (re.test(t)) {
      el.classList.add(cls);
      return;
    }
  }
}
const baseAddLogT2 = addLog;
addLog = function (text, kind) {
  baseAddLogT2(text, kind);
  tagLine($('log').lastElementChild);
};
for (const el of $('log').children) tagLine(el);

function applyLogView() {
  $('log').dataset.show = $('log-show').value;
  $('log').classList.toggle('plain', !$('log-color').checked);
  $('log').scrollTop = $('log').scrollHeight;
}
$('log-show').value = ['all', 'problems', 'people', 'quiet'].includes(store.get('logShow', 'all')) ? store.get('logShow', 'all') : 'all';
$('log-color').checked = store.get('logColor', '1') === '1';
$('log-show').addEventListener('change', () => {
  store.set('logShow', $('log-show').value);
  applyLogView();
});
$('log-color').addEventListener('change', () => {
  store.set('logColor', $('log-color').checked ? '1' : '0');
  applyLogView();
});
applyLogView();

// ---- карточка игрока ----

let pcName = null;
function fact(label, value) {
  const d = document.createElement('div');
  d.className = 'pc-fact';
  const s = document.createElement('span');
  s.textContent = label;
  const b = document.createElement('b');
  b.textContent = value;
  d.append(s, b);
  return d;
}
async function openPlayer(name) {
  pcName = name;
  const card = $('pc-card');
  card.hidden = false;
  $('pc-name').textContent = name;
  $('pc-face').src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/44`;
  setHint('pc-sub', 'Загружаю…');
  setHint('pc-hint', '');
  $('pc-facts').replaceChildren();
  $('pc-inv').replaceChildren();
  card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  let c;
  try {
    c = await api.call('player:card', { ...selected(), name });
  } catch (e) {
    setHint('pc-sub', e.message, 'bad');
    return;
  }
  if (pcName !== name) return;
  const tags = [c.online ? 'сейчас на сервере' : 'не в сети'];
  if (c.op) tags.push('оператор');
  if (c.banned) tags.push('забанен');
  setHint('pc-sub', tags.join(' · '), c.online ? 'good' : '');
  const d = c.data;
  const facts = [];
  if (d && d.pos) facts.push(fact('Где', `${d.pos.join(' ')}${d.dimension ? ' · ' + d.dimension : ''}`));
  if (d && d.health !== null && d.health !== undefined) facts.push(fact('Здоровье', `${d.health} из 20`));
  if (d && d.food !== null && d.food !== undefined) facts.push(fact('Сытость', `${d.food} из 20`));
  if (d && d.level !== null && d.level !== undefined) facts.push(fact('Уровень', String(d.level)));
  if (d && d.mode) facts.push(fact('Режим', d.mode));
  if (c.stats) {
    facts.push(fact('Всего в игре', durText(c.stats.total)));
    facts.push(fact('Последний вход', c.online ? 'сейчас' : agoText(c.stats.last)));
  }
  $('pc-facts').replaceChildren(...facts);
  const items = (d && d.items) || [];
  $('pc-inv-title').textContent = !d
    ? 'Сервер ещё не сохранил данные этого игрока.'
    : items.length
      ? `Инвентарь${c.online ? '' : ` (на момент выхода, ${new Date(d.savedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })})`}`
      : 'Инвентарь пуст';
  $('pc-inv').replaceChildren(
    ...items.map((it) => {
      const s = document.createElement('span');
      s.className = 'pc-item';
      s.textContent = it.id.replace(/^minecraft:/, '').replace(/_/g, ' ');
      if (it.count > 1) {
        const b = document.createElement('b');
        b.textContent = `×${it.count}`;
        s.appendChild(b);
      }
      return s;
    })
  );
  $('pc-actions').hidden = !c.online;
  if (!c.online) setHint('pc-hint', 'Выдать предмет, телепортировать или сменить режим можно, когда игрок на сервере.');
}
async function pcDo(args, okText) {
  try {
    await api.call('player:do', { ...selected(), name: pcName, ...args });
    setHint('pc-hint', okText, 'good');
  } catch (e) {
    setHint('pc-hint', e.message, 'bad');
  }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  const row = e.target.closest('#pl-all .pl-row');
  const b = row && row.querySelector('b');
  if (b) return openPlayer(b.textContent);
  const ch = e.target.closest('#pl-online .chip > span:first-child');
  if (ch) openPlayer(ch.textContent);
});
$('pc-close').addEventListener('click', () => {
  $('pc-card').hidden = true;
  pcName = null;
});
$('pc-face').addEventListener('error', () => $('pc-face').classList.add('none'));
$('pc-mode').addEventListener('change', () => {
  const m = $('pc-mode').value;
  if (!m) return;
  $('pc-mode').value = '';
  pcDo({ action: 'mode', mode: m }, 'Режим изменён.').then(() => openPlayer(pcName));
});
$('pc-kick').addEventListener('click', () => window.confirm(`Выкинуть ${pcName} с сервера? Он сможет зайти снова.`) && pcDo({ action: 'kick' }, 'Игрок выкинут.'));
$('pc-give-form').addEventListener('submit', (e) => {
  e.preventDefault();
  pcDo({ action: 'give', item: $('pc-item').value, count: $('pc-count').value }, 'Выдано.');
});
$('pc-tp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  pcDo({ action: 'tp', target: $('pc-tp').value }, 'Телепортирован.').then(() => setTimeout(() => pcName && openPlayer(pcName), 600));
});

// ---- почему тормозит ----

function renderLag(l) {
  const box = $('lag-list');
  if (!l || !l.server || l.server.type !== type || l.server.version !== $('version').value) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    ...l.hints.map((h) => {
      const li = document.createElement('li');
      li.className = h.level;
      const t = document.createElement('span');
      t.textContent = h.text;
      li.appendChild(t);
      if (h.fix) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small';
        b.textContent = h.fix === 'items' ? 'Убрать предметы с земли' : 'Убрать сферы опыта';
        b.addEventListener('click', async () => {
          if (!window.confirm(h.fix === 'items' ? 'Убрать все предметы, лежащие на земле во всём мире? Вещи в сундуках и у игроков не пострадают.' : 'Убрать все сферы опыта на земле?')) return;
          try {
            await api.call('lag:fix', { fix: h.fix });
            b.disabled = true;
            b.textContent = 'Убрано';
          } catch (e) {
            setHint('lag-hint', e.message, 'bad');
          }
        });
        li.appendChild(b);
      }
      return li;
    })
  );
  const tpsText = Number.isFinite(l.tps) ? `, плавность ${String(Math.round(l.tps * 10) / 10).replace('.', ',')} TPS` : '';
  setHint('lag-hint', `Проверено в ${hhmm(l.at)}${tpsText}, всего существ: ${l.total}.`);
}
$('lag-run').addEventListener('click', async () => {
  setHint('lag-hint', 'Считаю существ и предметы…');
  $('lag-run').disabled = true;
  try {
    renderLag(await api.call('lag:check'));
  } catch (e) {
    setHint('lag-hint', e.message, 'bad');
  }
  $('lag-run').disabled = false;
});
api.on('lag', (l) => {
  if (tab === 'maint') renderLag(l);
});

// ---- новая версия Minecraft ----

async function loadMcNew(key) {
  let r;
  try {
    r = await api.call('mcnew:check', { ...selected(), loader: isModded() ? $('loader').value : null });
  } catch {
    return;
  }
  if (key !== selKey()) return;
  $('mcn-card').hidden = !r.latest;
  if (!r.latest) return;
  $('mcn-title').textContent = `Вышел Minecraft ${r.latest}`;
  const total = r.ready.length + r.notReady.length;
  let text = `Сервер сейчас на ${r.current}.`;
  if (total) {
    text += ` Под ${r.latest} уже есть ${r.ready.length} из ${total} ${kinds().includes('mod') ? 'модов' : 'плагинов'}.`;
    if (r.notReady.length) text += ` Ещё не обновились: ${r.notReady.slice(0, 8).join(', ')}${r.notReady.length > 8 ? ` и ещё ${r.notReady.length - 8}` : ''}.`;
  }
  $('mcn-text').textContent = text;
  setHint(
    'mcn-hint',
    r.notReady.length
      ? 'Без этих модов сервер на новой версии может не запуститься — лучше подождать, пока их обновят.'
      : total
        ? 'Всё готово к переходу. Перенос сделает копию — старый сервер останется как был.'
        : 'Перенос сделает копию — старый сервер останется как был.' + (r.unknown ? '' : ''),
    r.notReady.length ? 'warn' : 'good'
  );
  if (r.unknown) $('mcn-hint').textContent += ` ${r.unknown} файлов не с Modrinth — их проверьте сами.`;
}
$('mcn-go').addEventListener('click', () => {
  tab = 'settings';
  renderTabs();
  setTimeout(() => {
    const c = $('up-row').closest('.card');
    if (c) c.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 300);
});

// ---- что изменилось с копии и откат части мира ----

const DIM_TITLES = { overworld: 'Обычный мир', nether: 'Нижний мир', end: 'Энд' };
function fillBackupSelect() {
  const sel = $('rg-file');
  const keep = sel.value;
  const list = (mtData && mtData.backups) || [];
  sel.replaceChildren(...list.map((b) => new Option(`${new Date(b.date).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })} · ${b.label}`, b.file)));
  if (list.some((b) => b.file === keep)) sel.value = keep;
  const none = !list.length;
  $('rg-compare').disabled = $('rg-restore-xz').disabled = none;
  if (none) setHint('rg-hint', 'Копий мира пока нет — сделайте её в карточке «Резервные копии» выше.');
}
$('rg-compare').addEventListener('click', async () => {
  setHint('rg-hint', 'Сравниваю — для большого мира это может занять минуту…');
  $('rg-list').replaceChildren();
  $('rg-actions').hidden = true;
  $('rg-compare').disabled = true;
  try {
    const r = await api.call('regions:compare', { ...selected(), file: $('rg-file').value });
    $('rg-list').replaceChildren(
      ...r.list.map((x) => {
        const l = document.createElement('label');
        l.className = 'check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.dim = x.dim;
        cb.dataset.rx = x.rx;
        cb.dataset.rz = x.rz;
        const t = document.createElement('span');
        t.textContent = `${DIM_TITLES[x.dim]} · X ${x.x1}…${x.x2}, Z ${x.z1}…${x.z2}`;
        const sub = document.createElement('span');
        sub.className = 'sub';
        const parts = [];
        if (x.changed) parts.push(`изменено чанков: ${x.changed}`);
        if (x.added) parts.push(`новых: ${x.added}`);
        if (x.removed) parts.push(`пропало: ${x.removed}`);
        sub.textContent = parts.join(', ');
        t.appendChild(sub);
        l.append(cb, t);
        return l;
      })
    );
    $('rg-actions').hidden = !r.list.length;
    setHint(
      'rg-hint',
      r.total ? `Менялось областей: ${r.total}${r.total > r.list.length ? ` (показаны ${r.list.length} самых изменённых)` : ''}. Изменение — это и постройки, и просто бродившие мобы.` : 'С этой копии мир не менялся.'
    );
  } catch (e) {
    setHint('rg-hint', e.message, 'bad');
  }
  $('rg-compare').disabled = false;
});
async function rgRestore(calls, what) {
  if (!window.confirm(`Вернуть ${what} из копии? Всё, что построено там после копии, пропадёт. Текущий мир перед этим сохранится копией.`)) return;
  setHint('rg-hint', 'Возвращаю…');
  try {
    let n = 0;
    for (const c of calls) n += (await api.call('regions:restore', { ...selected(), file: $('rg-file').value, ...c })).regions;
    setHint('rg-hint', `Готово: возвращено областей — ${n}. Текущий мир перед этим сохранён копией.`, 'good');
    $('rg-list').replaceChildren();
    $('rg-actions').hidden = true;
    loadMaint();
  } catch (e) {
    setHint('rg-hint', e.message, 'bad');
  }
}
$('rg-restore').addEventListener('click', () => {
  const byDim = {};
  for (const cb of document.querySelectorAll('#rg-list input:checked')) (byDim[cb.dataset.dim] ||= []).push([Number(cb.dataset.rx), Number(cb.dataset.rz)]);
  const calls = Object.entries(byDim).map(([dim, list]) => ({ dim, list }));
  if (!calls.length) return setHint('rg-hint', 'Отметьте области, которые нужно вернуть.', 'warn');
  const n = calls.reduce((s, c) => s + c.list.length, 0);
  rgRestore(calls, `${n} ${n === 1 ? 'область' : n < 5 ? 'области' : 'областей'}`);
});
$('rg-restore-xz').addEventListener('click', () =>
  rgRestore([{ dim: $('rg-dim').value, x: $('rg-x').value, z: $('rg-z').value, r: $('rg-r').value }], `область вокруг ${$('rg-x').value} ${$('rg-z').value}`)
);

const baseLoadMaintT2 = loadMaint;
loadMaint = async function () {
  await baseLoadMaintT2();
  if (tab !== 'maint') return;
  const key = selKey();
  fillBackupSelect();
  if ($('rg-list').dataset.key !== key) {
    $('rg-list').dataset.key = key;
    $('rg-list').replaceChildren();
    $('rg-actions').hidden = true;
    if (mtData && mtData.backups.length) setHint('rg-hint', '');
  }
  renderLag(await api.call('lag:get').catch(() => null));
  loadMcNew(key);
};

// ---- граница мира ----

function wbLoad() {
  const s = store.get('wb:' + selKey(), '');
  const [size, x, z] = s ? s.split(',') : ['5000', '0', '0'];
  $('wb-size').value = size;
  $('wb-x').value = x;
  $('wb-z').value = z;
  setHint('wb-hint', '');
}
$('wb-apply').addEventListener('click', async () => {
  const size = Number($('wb-size').value);
  try {
    const r = await api.call('border:apply', { ...selected(), size, x: $('wb-x').value, z: $('wb-z').value, pregen: $('wb-pregen').checked });
    store.set('wb:' + selKey(), [size, $('wb-x').value, $('wb-z').value].join(','));
    setHint('wb-hint', `Граница поставлена: ${size} × ${size} блоков.${r.chunky ? ' Мир внутри прогружается — прогресс в карточке ниже.' : ''}`, 'good');
  } catch (e) {
    setHint('wb-hint', e.message, 'bad');
  }
});
$('wb-remove').addEventListener('click', async () => {
  try {
    await api.call('border:remove', selected());
    setHint('wb-hint', 'Граница убрана.', 'good');
  } catch (e) {
    setHint('wb-hint', e.message, 'bad');
  }
});
const baseLoadToolsT2 = loadTools;
loadTools = async function () {
  await baseLoadToolsT2();
  wbLoad();
};
