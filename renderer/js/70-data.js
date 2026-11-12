// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
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
  // Если сервер ставили из сборки — по умолчанию берём загрузчик, который она просит.
  const packId = info && info.packLoader && loaders.list.some((l) => l.id === info.packLoader) ? info.packLoader : null;
  select.value = installedId || packId || loaders.recommended || (loaders.list[0] && loaders.list[0].id) || '';
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
  if (tab === 'players') loadPlayers();
  if (tab === 'maint') loadMaint();
}

/**
 * Загрузить список версий для выбранного типа.
 * fresh — для нового сервера: берём самую новую версию, а не ту, что открывали раньше.
 * pinVersion (из 90-shell.js) — версия открытого сервера: она будет в списке, даже если её там нет
 * (тестовая версия или список не загрузился без интернета).
 */
async function loadVersions({ fresh = false } = {}) {
  const token = ++versionsToken;
  const select = $('version');
  const pin = typeof pinVersion === 'string' ? pinVersion : '';
  const wanted = fresh ? '' : pin || store.get('version:' + type, '');
  select.replaceChildren(new Option('Загрузка списка…', ''));
  info = null;
  render();
  try {
    const list = await api.call('versions:list', { type, includePre: $('pre').checked });
    if (token !== versionsToken) return;
    const opts = list.map((v) => new Option(v.pre ? `${v.id} (тестовая)` : v.id, v.id));
    if (pin && !list.some((v) => v.id === pin)) opts.unshift(new Option(pin, pin));
    select.replaceChildren(...opts);
    if (wanted && opts.some((o) => o.value === wanted)) select.value = wanted;
  } catch (e) {
    if (token !== versionsToken) return;
    select.replaceChildren(pin ? new Option(pin, pin) : new Option('Не удалось загрузить', ''));
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
