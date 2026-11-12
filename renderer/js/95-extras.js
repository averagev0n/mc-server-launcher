// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- вкладка «Настройки»: версия, мир, интернет, Discord, карта, лаунчер; готовые наборы модов ----

let extrasKey = '';
let saves = null; // миры одиночной игры (загружаются один раз)
let wzWorld = 'new';

const selName = () => serverTitle(type, $('version').value);
const fmtDate = (ms) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

async function loadSaves(force) {
  if (saves && !force) return saves;
  try {
    saves = await api.call('world:saves');
  } catch {
    saves = [];
  }
  return saves;
}
function fillSaveSelect(sel, picked) {
  const opts = saves.map((s) => new Option(`${s.name} · ${fmtDate(s.mtime)}`, s.path));
  if (picked && !saves.some((s) => s.path === picked.path)) opts.unshift(new Option(`${picked.name} · другая папка`, picked.path));
  if (!opts.length) opts.push(new Option('Миры одиночной игры не найдены — выберите папку', ''));
  sel.replaceChildren(...opts);
  if (picked) sel.value = picked.path;
}
async function pickSave(sel, hintId) {
  try {
    const s = await api.call('world:pick');
    if (s) fillSaveSelect(sel, s);
  } catch (e) {
    if (hintId) setHint(hintId, e.message, 'bad');
    else fail(e);
  }
}

/** Загрузить всё для вкладки «Настройки» выбранного сервера. */
async function loadSettingsExtras(force) {
  const v = $('version').value;
  if (!v || mode !== 'server') return;
  const key = selKey();
  if (key === extrasKey && !force) return;
  extrasKey = key;
  $('up-row').hidden = true;
  for (const id of ['srv-hint', 'wi-hint', 'net-hint', 'dc-hint', 'up-hint']) setHint(id, '');
  try {
    const m = await api.call('maint:get', selected());
    if (key !== selKey()) return;
    $('net-upnp').checked = m.settings.net.upnp;
    $('dc-url').value = m.settings.discord.url;
    $('dc-start').checked = m.settings.discord.start;
    $('dc-players').checked = m.settings.discord.players;
    $('dc-crash').checked = m.settings.discord.crash;
  } catch (e) {
    setHint('srv-hint', e.message, 'bad');
  }
  await loadSaves();
  fillSaveSelect($('wi-save'));
  renderMap();
}

// ---- перенос на другую версию ----

$('up-open').addEventListener('click', async () => {
  const row = $('up-row');
  row.hidden = !row.hidden;
  if (row.hidden) return;
  const sel = $('up-version');
  sel.replaceChildren(new Option('Загрузка…', ''));
  $('up-go').disabled = true;
  try {
    const list = await api.call('versions:list', { type, includePre: false });
    const idx = list.findIndex((x) => x.id === $('version').value);
    const newer = idx < 0 ? list : list.slice(0, idx);
    if (!newer.length) {
      sel.replaceChildren(new Option('Это самая новая версия', ''));
      return;
    }
    sel.replaceChildren(...newer.map((x) => new Option(x.id, x.id)));
    $('up-go').disabled = false;
    setHint(
      'up-hint',
      isModded() && type !== 'mohist' && type !== 'arclight' && type !== 'youer'
        ? 'Моды не переносятся: для новой версии их нужно поставить заново (подходящих версий модов может ещё не быть).'
        : isModded()
          ? 'Плагины перенесутся, моды — нет: их нужно будет поставить заново.'
          : type === 'paper'
            ? 'Плагины перенесутся, но некоторые могут потребовать обновления под новую версию.'
            : 'Вернуться на старую версию с новым миром нельзя — поэтому старый сервер остаётся нетронутым.'
    );
  } catch (e) {
    sel.replaceChildren(new Option('Не удалось загрузить список', ''));
    setHint('up-hint', e.message, 'bad');
  }
});
$('up-go').addEventListener('click', async () => {
  const to = $('up-version').value;
  const from = $('version').value;
  if (!to) return;
  if (!window.confirm(`Создать сервер на Minecraft ${to} с копией мира «${selName()}»?\n\nСтарый сервер на ${from} останется как есть.`)) return;
  $('up-go').disabled = true;
  setHint('up-hint', 'Копирую мир и настройки…');
  try {
    const r = await api.call('server:upgrade', { ...selected(), to });
    await refreshServers();
    await selectServer(type, to);
    addLog(`Мир перенесён на ${to}. Нажмите «Запустить» — сервер скачается и обновит мир под новую версию.`);
    if (r.modsLeft) addLog(`Моды (${r.modsLeft}) остались на старом сервере — поставьте их заново во вкладке «Моды».`, 'error');
  } catch (e) {
    setHint('up-hint', e.message, 'bad');
  }
  $('up-go').disabled = false;
});

// ---- удаление ----

$('srv-delete').addEventListener('click', async () => {
  const name = selName();
  if (!window.confirm(`Удалить сервер «${name}»?\n\nПапка сервера с миром, модами и копиями попадёт в корзину Windows — оттуда её можно вернуть.`)) return;
  try {
    await api.call('server:delete', selected());
  } catch (e) {
    setHint('srv-hint', e.message, 'bad');
    return;
  }
  addLog(`Сервер «${name}» перемещён в корзину.`);
  await refreshServers();
  const next = servers[0];
  extrasKey = '';
  if (next) {
    await selectServer(next.type, next.version);
  } else {
    $('version').replaceChildren();
    openWizard();
  }
});

// ---- мир из одиночной игры ----

$('wi-pick').addEventListener('click', () => pickSave($('wi-save'), 'wi-hint'));
$('wi-go').addEventListener('click', async () => {
  const src = $('wi-save').value;
  if (!src) return setHint('wi-hint', 'Сначала выберите мир.', 'warn');
  const label = $('wi-save').selectedOptions[0].textContent.split(' · ')[0];
  if (!window.confirm(`Поставить на сервер мир «${label}»?\n\nТекущий мир сервера сначала сохранится копией — его можно вернуть во вкладке «Обслуживание».`)) return;
  $('wi-go').disabled = true;
  setHint('wi-hint', 'Переношу мир…');
  try {
    await api.call('world:import', { ...selected(), src });
    setHint('wi-hint', `Готово: на сервере мир «${label}». Прежний мир сохранён копией.`, 'good');
    refreshServers();
  } catch (e) {
    setHint('wi-hint', e.message, 'bad');
  }
  $('wi-go').disabled = false;
});

// ---- доступ из интернета ----

$('net-upnp').addEventListener('change', async () => {
  const on = $('net-upnp').checked;
  setHint('net-hint', on ? 'Открываю порт…' : '');
  try {
    const r = await api.call('net:upnp', { ...selected(), on });
    if (on) {
      setHint('net-hint', r.upnp ? `Порт открыт${r.upnp.externalIp ? `, внешний адрес роутера ${r.upnp.externalIp}` : ''}.` : 'Порт откроется при следующем запуске сервера.', 'good');
    }
  } catch (e) {
    setHint('net-hint', `Не получилось: ${e.message}.`, 'bad');
  }
});

async function checkInternet() {
  const el = setHint('net-result', 'Проверяю, виден ли сервер из интернета (через mcsrvstat.us)…');
  try {
    const r = await api.call('net:check', selected());
    const addr = r.publicIp + (r.port === 25565 ? '' : ':' + r.port);
    el.textContent = '';
    if (r.reachable) {
      el.className = 'hint good';
      el.textContent = `Сервер виден из интернета. Адрес для друзей: ${addr} `;
      addLink(el, 'Скопировать', () => navigator.clipboard.writeText(addr).catch(() => {}));
    } else if (r.cgnat) {
      el.className = 'hint bad';
      el.textContent =
        'Из интернета сервер не виден: провайдер не выдаёт вам внешний («белый») IP, порт на роутере тут не поможет. Играйте через VPN (Radmin VPN, ZeroTier) — адрес будет в строке выше — или перенесите сервер на VPS (вкладка «VPS»). Можно и попросить у провайдера белый IP.';
    } else if (!r.upnp) {
      el.className = 'hint warn';
      el.textContent = 'Из интернета сервер не виден: порт закрыт на роутере. ';
      addLink(el, 'Открыть порт автоматически (UPnP)', async () => {
        $('net-upnp').checked = true;
        setHint('net-result', 'Открываю порт на роутере…');
        try {
          await api.call('net:upnp', { ...selected(), on: true });
          setTimeout(checkInternet, 2000);
        } catch (e) {
          setHint('net-result', `Роутер не дал открыть порт: ${e.message}. Откройте порт ${r.port} (TCP) в настройках роутера вручную или играйте через VPN.`, 'bad');
        }
      });
    } else {
      el.className = 'hint bad';
      el.textContent = `Порт ${r.port} открыт на роутере, но сервер всё равно не виден. Проверьте, что брандмауэр Windows разрешает Java входящие подключения, — или играйте через VPN (Radmin VPN, ZeroTier) либо VPS.`;
    }
  } catch (e) {
    setHint('net-result', e.message, 'bad');
  }
}
api.on('net', () => {
  if (tab === 'settings') extrasKey = '';
});

// ---- Discord ----

const dcSettings = () => ({
  url: $('dc-url').value.trim(),
  start: $('dc-start').checked,
  players: $('dc-players').checked,
  crash: $('dc-crash').checked,
});
$('dc-save').addEventListener('click', async () => {
  try {
    await api.call('maint:set', { ...selected(), settings: { discord: dcSettings() } });
    setHint('dc-hint', $('dc-url').value.trim() ? 'Сохранено.' : 'Сообщения в Discord выключены.', 'good');
  } catch (e) {
    setHint('dc-hint', e.message, 'bad');
  }
});
$('dc-test').addEventListener('click', async () => {
  setHint('dc-hint', 'Отправляю…');
  try {
    await api.call('maint:set', { ...selected(), settings: { discord: dcSettings() } });
    await api.call('discord:test', { ...selected(), url: $('dc-url').value.trim() });
    setHint('dc-hint', 'Сообщение отправлено — проверьте канал в Discord.', 'good');
  } catch (e) {
    setHint('dc-hint', e.message, 'bad');
  }
});

// ---- карта мира (BlueMap) ----

let mapBusy = false;
async function renderMap() {
  const card = $('map-card');
  card.hidden = type === 'vanilla';
  if (card.hidden) return;
  let m;
  try {
    m = await api.call('map:get', selected());
  } catch (e) {
    setHint('map-hint', e.message, 'bad');
    return;
  }
  $('map-install').hidden = m.installed;
  $('map-install').disabled = mapBusy;
  $('map-accept-row').hidden = !m.configured || m.accepted;
  $('map-accept').checked = false;
  $('map-open').hidden = !m.accepted;
  if (!m.installed) setHint('map-hint', '');
  else if (!m.configured) setHint('map-hint', 'BlueMap установлен. Запустите сервер один раз — BlueMap создаст свои настройки, и здесь появится следующий шаг.', 'warn');
  else if (!m.accepted) setHint('map-hint', 'Остался один шаг: разрешите BlueMap скачать файлы игры, затем перезапустите сервер.', 'warn');
  else {
    const lan = addresses.find((a) => !a.vpn) || addresses[0];
    setHint('map-hint', `Карта работает, пока запущен сервер: http://localhost:${m.port}${lan ? ` — друзьям в вашей сети: http://${lan.address}:${m.port}` : ''}. Первая отрисовка большого мира занимает время.`, 'good');
  }
}
$('map-install').addEventListener('click', async () => {
  mapBusy = true;
  $('map-install').disabled = true;
  setHint('map-hint', 'Устанавливаю BlueMap…');
  try {
    const kind = type === 'paper' || isHybrid() ? 'plugin' : 'mod';
    await api.call('mods:install', { ...selected(), projectId: 'bluemap', bySlug: true, kind, loader: isModded() ? $('loader').value : null });
    refreshInstalled();
  } catch (e) {
    setHint('map-hint', e.message, 'bad');
    mapBusy = false;
    $('map-install').disabled = false;
    return;
  }
  mapBusy = false;
  renderMap();
});
$('map-accept').addEventListener('change', async () => {
  if (!$('map-accept').checked) return;
  try {
    await api.call('map:accept', selected());
    addLog(isSelectedRunning() ? 'BlueMap: разрешение сохранено — перезапустите сервер, чтобы карта начала рисоваться.' : 'BlueMap: разрешение сохранено.');
  } catch (e) {
    setHint('map-hint', e.message, 'bad');
  }
  renderMap();
});
$('map-eula').addEventListener('click', (e) => {
  e.preventDefault();
  api.call('open:eula').catch(fail);
});
$('map-open').addEventListener('click', () => api.call('map:open', selected()).catch(fail));

// ---- настройки лаунчера ----

async function loadPrefs() {
  try {
    const p = await api.call('ui:getPrefs');
    $('pf-tray').checked = p.tray;
    $('pf-started').checked = p.notify.started;
    $('pf-players').checked = p.notify.players;
    $('pf-crash').checked = p.notify.crash;
  } catch {
    /* по умолчанию */
  }
}
for (const id of ['pf-tray', 'pf-started', 'pf-players', 'pf-crash']) {
  $(id).addEventListener('change', () =>
    api
      .call('ui:setPrefs', {
        tray: $('pf-tray').checked,
        notify: { started: $('pf-started').checked, players: $('pf-players').checked, crash: $('pf-crash').checked },
      })
      .catch(fail)
  );
}

// ---- готовые наборы модов и плагинов ----

const PRESETS = {
  plugin: {
    label: 'Основные плагины',
    what: 'LuckPerms — права игроков, EssentialsX — /home, /tpa и другие команды, CoreProtect — откат гриферства, Chunky — заранее прогрузить мир',
    slugs: ['luckperms', 'essentialsx', 'coreprotect', 'chunky'],
  },
  fabric: { label: 'Оптимизация', what: 'Lithium, FerriteCore, Krypton, ModernFix и spark — сервер меньше тормозит и ест меньше памяти', slugs: ['lithium', 'ferrite-core', 'krypton', 'modernfix', 'spark'] },
  neoforge: { label: 'Оптимизация', what: 'Lithium, FerriteCore, ModernFix и spark — сервер меньше тормозит и ест меньше памяти', slugs: ['lithium', 'ferrite-core', 'modernfix', 'spark'] },
  forge: { label: 'Оптимизация', what: 'FerriteCore, ModernFix и spark — сервер меньше тормозит и ест меньше памяти', slugs: ['ferrite-core', 'modernfix', 'spark'] },
};
function currentPreset() {
  const k = currentKind();
  if (!k) return null;
  if (k === 'plugin') return PRESETS.plugin;
  return PRESETS[isHybrid() ? currentFlavor() : type] || null;
}
let presetBusy = false;
function renderPresets() {
  const p = currentPreset();
  $('presets').hidden = !p;
  if (!p) return;
  $('preset-go').textContent = presetBusy ? 'Устанавливаю…' : p.label;
  $('preset-go').disabled = presetBusy;
  if (!presetBusy) $('preset-what').textContent = p.what;
}
const baseRenderTabs = renderTabs;
renderTabs = function () {
  baseRenderTabs();
  renderPresets();
  if (tab === 'settings' && mode === 'server') loadSettingsExtras();
};
$('preset-go').addEventListener('click', async () => {
  const p = currentPreset();
  if (!p || presetBusy) return;
  const word = currentKind() === 'plugin' ? 'плагины' : 'моды';
  if (!window.confirm(`Поставить ${word}: ${p.what}?\n\nУже установленные пропустятся.`)) return;
  presetBusy = true;
  renderPresets();
  const failed = [];
  for (const slug of p.slugs) {
    $('preset-what').textContent = `Ставлю ${slug}…`;
    try {
      await api.call('mods:install', { ...modsArgs(), projectId: slug, bySlug: true });
    } catch (e) {
      failed.push(`${slug}: ${e.message}`);
    }
  }
  presetBusy = false;
  renderPresets();
  if (failed.length) addLog(`Не всё получилось поставить:\n${failed.join('\n')}`, 'error');
  $('preset-what').textContent = failed.length ? `Готово, кроме ${failed.length} — подробности в консоли.` : 'Готово — набор установлен.';
  refreshInstalled();
});

// ---- мир в мастере ----

function renderWizardWorld() {
  const existing = !!(info && info.installed) || !!wz.import;
  $('wz-world').hidden = existing;
  for (const b of document.querySelectorAll('[data-world]')) b.setAttribute('aria-checked', String(b.dataset.world === wzWorld));
  $('wz-world-new').hidden = existing || wzWorld !== 'new';
  $('wz-world-import').hidden = existing || wzWorld !== 'import';
}
for (const b of document.querySelectorAll('[data-world]')) {
  b.addEventListener('click', async () => {
    wzWorld = b.dataset.world;
    if (wzWorld === 'import') {
      await loadSaves();
      if (!$('wz-save').options.length) fillSaveSelect($('wz-save'));
    }
    renderWizardWorld();
  });
}
$('wz-save-pick').addEventListener('click', () => pickSave($('wz-save'), 'wz-hint'));

/** Настройки мира из мастера — вызывается перед первым запуском нового сервера. */
async function applyWizardWorld(t, v) {
  if (info && info.installed) return;
  if (wzWorld === 'import') {
    const src = $('wz-save').value;
    if (!src) throw new Error('Выберите мир из одиночной игры или переключитесь на «Новый мир»');
    await api.call('world:import', { type: t, version: v, src });
  } else if ($('wz-seed').value.trim() || $('wz-level').value !== 'normal') {
    await api.call('world:setup', { type: t, version: v, seed: $('wz-seed').value.trim(), levelType: $('wz-level').value });
  }
}
