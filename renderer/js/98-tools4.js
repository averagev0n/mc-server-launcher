// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- спящий режим, поиск сломанного мода, «моды не совпадают», рецепт сервера ----

// ---- спящий режим ----

let sleepState = null; // { type, version, since } — какой сервер сейчас спит

const isSelectedAsleep = () => !!(sleepState && sleepState.type === type && sleepState.version === $('version').value);

const baseRenderT4 = render;
render = function () {
  baseRenderT4();
  if (!isSelectedAsleep() || state !== 'stopped') return;
  const st = $('status');
  st.dataset.state = 'sleeping';
  st.textContent = 'Спит';
  $('stop').disabled = false;
  const el = setHint('start-hint', 'Сервер спит: проснётся сам, когда кто-то попробует зайти. ');
  addLink(el, 'Разбудить сейчас', () => api.call('sleep:wake').catch(fail));
};
api.on('sleep', (d) => {
  sleepState = d || null;
  render();
});
api.call('sleep:get').then((d) => {
  sleepState = d || null;
  render();
}).catch(() => {});

function renderSleep() {
  if (!mtData) return;
  const s = mtData.settings.sleep || { enabled: false, minutes: 15 };
  $('sl-on').checked = s.enabled;
  $('sl-min').value = String(s.minutes);
  $('sl-min').disabled = !s.enabled;
  if (!$('sl-hint').classList.contains('bad')) {
    setHint('sl-hint', isSelectedAsleep() ? 'Сейчас сервер спит.' : s.enabled ? `Сервер уснёт, если на нём никого не будет ${s.minutes === 60 ? 'час' : s.minutes + ' минут'}.` : '');
  }
}
async function saveSleep() {
  try {
    mtData.settings = await api.call('maint:set', { ...selected(), settings: { sleep: { enabled: $('sl-on').checked, minutes: Number($('sl-min').value) } } });
    setHint('sl-hint', '');
    renderSleep();
  } catch (e) {
    setHint('sl-hint', e.message, 'bad');
  }
}
$('sl-on').addEventListener('change', saveSleep);
$('sl-min').addEventListener('change', saveSleep);

// ---- поиск сломанного мода ----

let bsState = null; // идёт поиск: { type, version, run, left, total, enabled, text }

function renderBisect() {
  const card = $('bs-card');
  card.hidden = !isModded();
  if (card.hidden) return;
  const mine = bsState && bsState.type === type && bsState.version === $('version').value;
  $('bs-run').hidden = !!bsState;
  $('bs-cancel').hidden = !mine;
  $('bs-run').disabled = state !== 'stopped';
  $('bs-bar').hidden = !mine;
  if (mine) {
    const all = bsState.run + bsState.left;
    $('bs-fill').style.width = `${Math.round((Math.max(0, bsState.run - 1) / Math.max(1, all)) * 100)}%`;
    setHint('bs-hint', `${bsState.text} Осталось примерно ${bsState.left} ${bsState.left === 1 ? 'запуск' : bsState.left < 5 ? 'запуска' : 'запусков'}.`);
  } else if (bsState) {
    setHint('bs-hint', 'Идёт поиск на другом сервере.');
  }
}
$('bs-run').addEventListener('click', async () => {
  const msg = 'Лаунчер несколько раз запустит сервер с частью модов на временном мире. Это займёт от 5 минут до получаса. Ваш мир не трогается, перед началом делается копия.\n\nНачать?';
  if (!window.confirm(msg)) return;
  try {
    bsState = await api.call('modtest:start', selected());
    renderBisect();
  } catch (e) {
    setHint('bs-hint', e.message, 'bad');
  }
});
$('bs-cancel').addEventListener('click', () => api.call('modtest:cancel').catch(fail));
api.on('modtest', (d) => {
  if (!d || !d.done) {
    bsState = d;
    renderBisect();
    return;
  }
  bsState = null;
  renderBisect();
  if (d.type !== type || d.version !== $('version').value) return;
  const runs = `Запусков: ${d.runs}.`;
  if (d.culprit) {
    const el = setHint('bs-hint', `Нашёл: сервер падает из-за мода «${d.culprit.name}» (${d.culprit.file})${d.needs.length ? ` — вместе с ${d.needs.join(', ')}` : ''}. ${runs} Обновите этот мод или уберите его. `, 'bad');
    addLink(el, 'Убрать мод', async () => {
      try {
        await api.call('modtest:disable', { ...selected(), file: d.culprit.file });
        setHint('bs-hint', `Мод «${d.culprit.name}» убран в папку mods-disabled. Попробуйте запустить сервер.`, 'good');
      } catch (e) {
        setHint('bs-hint', e.message, 'bad');
      }
    });
  } else if (d.noRepro) {
    setHint('bs-hint', `Со всеми модами сервер на чистом мире запускается нормально. Значит, дело в самом мире или в настройках модов (папка config). ${runs}`, 'warn');
  } else if (d.combo) {
    setHint('bs-hint', `Сервер падает только от сочетания модов, а не от одного. Посмотрите объяснение ошибки во вкладке «Консоль». ${runs}`, 'warn');
  } else if (d.cancelled) {
    setHint('bs-hint', 'Поиск отменён, моды и мир вернулись на место.');
  } else {
    setHint('bs-hint', `Поиск остановлен: ${d.error}`, 'bad');
  }
});
api.call('modtest:get').then((d) => {
  bsState = d || null;
  renderBisect();
}).catch(() => {});

const baseLoadMaintT4 = loadMaint;
loadMaint = async function () {
  await baseLoadMaintT4();
  renderSleep();
  renderBisect();
};

// ---- «моды не совпадают» ----

$('mm-go').addEventListener('click', async () => {
  const out = $('mm-out');
  out.replaceChildren();
  let r;
  try {
    r = await api.call('mismatch:analyze', { ...selected(), text: $('mm-text').value });
  } catch (e) {
    const p = document.createElement('p');
    p.className = 'hint bad';
    p.textContent = e.message;
    out.append(p);
    return;
  }
  const block = (title, items, cls) => {
    if (!items.length) return;
    const h = document.createElement('p');
    h.className = `hint ${cls}`;
    h.textContent = title;
    const ul = document.createElement('ul');
    ul.className = 'mm-list';
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = it;
      ul.append(li);
    }
    out.append(h, ul);
  };
  if (!r.found) {
    const p = document.createElement('p');
    p.className = 'hint warn';
    p.textContent = 'В этом тексте не нашлось названий модов. Попросите друга прислать ошибку целиком — или просто отправьте ему свежую сборку кнопкой выше.';
    out.append(p);
    return;
  }
  block('У друга не хватает этих модов:', r.missing.map((m) => m.name), 'bad');
  block('У друга другая версия этих модов:', r.mismatch.map((m) => m.name), 'warn');
  block('У друга лишние моды, которых нет на сервере, — их нужно убрать:', r.extra, 'warn');
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = 'Проще всего — отправить другу свежую сборку: с ней у него будут ровно те моды, что на сервере. ';
  addLink(p, 'Открыть сборку в Modrinth App', () => $('pack-app').click());
  out.append(p);
});

// ---- рецепт сервера ----

$('rc-save').addEventListener('click', async () => {
  setHint('rc-hint', 'Собираю рецепт…');
  try {
    const r = await api.call('recipe:export', selected());
    if (!r) return setHint('rc-hint', '');
    const extra = r.manual.length
      ? ` Не нашлись на Modrinth, их другу нужно положить вручную: ${r.manual.map((x) => x.split('/').pop()).join(', ')}.`
      : '';
    setHint('rc-hint', `Рецепт сохранён: ${r.file}. Модов и плагинов по ссылкам: ${r.files}.${extra}`, r.manual.length ? 'warn' : 'good');
  } catch (e) {
    setHint('rc-hint', e.message, 'bad');
  }
});

async function openRecipe(hintId) {
  if (state !== 'stopped') return addLog('Остановите сервер, прежде чем ставить новый.', 'error');
  let p;
  try {
    p = await api.call('recipe:open');
  } catch (e) {
    return hintId ? setHint(hintId, e.message, 'bad') : fail(e);
  }
  if (!p) return;
  const lines = [
    `Рецепт${p.name ? ` «${p.name}»` : ''}`,
    `Minecraft ${p.mc}, ${LOADER_NAMES[p.type] || p.type}${p.loader ? ' ' + p.loader : ''}`,
    `Модов и плагинов: ${p.files}`,
  ];
  if (p.manual.length) lines.push(`Не перенесутся (их нет на Modrinth): ${p.manual.length}`);
  if (p.exists) {
    window.alert(`${lines.join('\n')}\n\nСервер ${LOADER_NAMES[p.type] || p.type} ${p.mc} у вас уже есть. Удалите его или перенесите на другую версию, чтобы поставить рецепт.`);
    return;
  }
  if (!window.confirm(`${lines.join('\n')}\n\nСоздать такой сервер?`)) return;
  if (typeof closeWizard === 'function' && !$('wizard').hidden) closeWizard();
  tab = 'console';
  renderTabs();
  $('progress').hidden = false;
  try {
    const r = await api.call('recipe:apply');
    await refreshServers();
    await selectServer(r.type, r.mc);
    if (r.manual.length) addLog(`Положите вручную в папку сервера: ${r.manual.join(', ')}`, 'error');
  } catch (e) {
    fail(e);
  }
  $('progress').hidden = true;
  render();
}
$('rc-open').addEventListener('click', () => openRecipe('rc-hint'));
$('rc-open-wz').addEventListener('click', () => openRecipe(null));

// ---- отчёт за неделю ----

$('tg-report-now').addEventListener('click', async () => {
  try {
    await api.call('tg:report');
    setHint('tg-hint', 'Отчёт отправлен в Telegram.', 'good');
  } catch (e) {
    setHint('tg-hint', e.message, 'bad');
  }
});

// ---- язык интерфейса ----

for (const b of document.querySelectorAll('[data-lang]')) {
  b.setAttribute('aria-checked', String(b.dataset.lang === (window.I18N_LANG || 'ru')));
  b.addEventListener('click', () => {
    if (b.dataset.lang === window.I18N_LANG) return;
    api.call('ui:setLang', { lang: b.dataset.lang }).catch(fail); // окно перезагрузится само
  });
}
