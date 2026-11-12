// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- события ----

let lastVersion = '';
$('version').addEventListener('focus', () => {
  lastVersion = $('version').value;
});
$('type').addEventListener('change', () => {
  if (!confirmDiscard()) {
    $('type').value = type;
    return;
  }
  resetConfigs();
  type = $('type').value;
  store.set('type', type);
  $('version').replaceChildren();
  loadVersions();
});
$('version').addEventListener('change', () => {
  if (!confirmDiscard()) {
    $('version').value = lastVersion;
    return;
  }
  resetConfigs();
  lastVersion = $('version').value;
  store.set('version:' + type, $('version').value);
  loadDetails();
});
$('loader').addEventListener('change', () => {
  render();
  // У Arclight от сборки зависит загрузчик модов — значит, и список подходящих модов.
  if (type === 'arclight' && !(info && info.installed)) {
    resetMods();
    refreshInstalled();
    ensureMods();
  }
});
for (const b of document.querySelectorAll('[data-mkind]')) {
  b.addEventListener('click', () => {
    if (currentKind() === b.dataset.mkind) return;
    modsKind = b.dataset.mkind;
    store.set('modsKind', modsKind);
    resetMods();
    renderTabs();
    refreshInstalled();
    ensureMods();
  });
}
$('pre').addEventListener('change', () => {
  store.set('pre', $('pre').checked ? '1' : '');
  loadVersions();
});
$('ram').addEventListener('input', render);
$('ram').addEventListener('change', () => {
  // Выход за пределы — подтягиваем к ближайшему допустимому значению.
  const max = memory ? memory.maxGb : 64;
  const n = Math.round(Number(String($('ram').value).replace(',', '.')));
  $('ram').value = Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : Math.min(2, max);
  store.set('ram', $('ram').value);
  render();
});
$('java').addEventListener('change', () => {
  store.set('java', $('java').value);
  render();
});
$('eula').addEventListener('change', render);
$('eula-link').addEventListener('click', (e) => {
  e.preventDefault();
  api.call('open:eula').catch(fail);
});

/** Запустить выбранный сервер (кнопка «Запустить» и последний шаг мастера). */
async function startServer() {
  $('progress-bar').style.width = '0';
  tab = 'console';
  render();
  try {
    await api.call('server:start', {
      ...selected(),
      loader: isModded() ? $('loader').value : null,
      ramGb: $('ram').value,
      eula: $('eula').checked,
      javaPath: $('java').value,
    });
  } catch (e) {
    fail(e);
  }
}
$('start').addEventListener('click', () => {
  if (state === 'running' && isSelectedRunning()) {
    api.call('server:restart').catch(fail);
    return;
  }
  startServer();
});
$('stop').addEventListener('click', () => api.call('server:stop').catch(fail));

$('cmd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('cmd').value.trim();
  if (!text) return;
  try {
    await api.call('server:command', { text });
    $('cmd').value = '';
  } catch (err) {
    fail(err);
  }
});
$('clear').addEventListener('click', () => $('log').replaceChildren());

$('save').addEventListener('click', async () => {
  const values = {
    'server-ip': $('p-ip').value,
    'server-port': $('p-port').value,
    'max-players': $('p-players').value,
    gamemode: $('p-gamemode').value,
    difficulty: $('p-difficulty').value,
    motd: $('p-motd').value,
    'online-mode': $('p-online').checked ? 'true' : 'false',
  };
  try {
    await api.call('props:save', { ...selected(), values });
    if (isSelectedRunning()) {
      setHint('props-hint', 'Сохранено. Изменения применятся после перезапуска сервера.', 'warn');
    } else {
      port = String(values['server-port']);
      serverIp = values['server-ip'];
      setHint('props-hint', 'Сохранено.', 'good');
    }
    if (cfg.file && cfg.file.rel === 'server.properties' && !cfgDirty()) openConfig('server.properties', true);
  } catch (e) {
    setHint('props-hint', e.message, 'bad');
  }
});
$('folder').addEventListener('click', () => api.call('open:folder', selected()).catch(fail));
$('p-ip').addEventListener('change', renderIpHint);
// Сети меняются (включили VPN, переподключили Wi-Fi) — обновляем список при открытии.
$('p-ip').addEventListener('focus', refreshAddresses);

for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    tab = t.dataset.tab;
    renderTabs();
    ensureMods();
    ensureConfigs();
    ensureVps();
    ensurePlayers();
    ensureMaint();
  });
}
for (const b of document.querySelectorAll('[data-mview]')) {
  b.addEventListener('click', () => {
    modsView = b.dataset.mview;
    renderTabs();
    if (modsView === 'installed') refreshInstalled();
    if (modsView === 'pack') loadPack();
  });
}
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(false);
});
$('more').addEventListener('click', () => runSearch(true));
$('mods-folder').addEventListener('click', () => {
  api.call('open:folder', { ...modsArgs(), sub: true }).catch(fail);
});

api.on('log', ({ text, kind }) => addLog(text, kind));
api.on('progress', ({ got, total }) => {
  $('progress-bar').style.width = total ? Math.min(100, (got / total) * 100) + '%' : '0';
});
api.on('state', (payload) => {
  const was = state;
  state = payload.state;
  running = payload.current;
  if (state === 'stopped' && was !== 'stopped') loadDetails();
  else render();
  // Сервер установился или сменил состояние — обновляем список слева.
  if (state !== was && ['running', 'starting', 'stopped'].includes(state)) refreshServers();
});
