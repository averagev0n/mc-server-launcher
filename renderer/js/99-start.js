// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- старт ----

(async () => {
  $('pre').checked = store.get('pre', '') === '1';
  const ram = Number(store.get('ram', '2'));
  $('ram').value = ram >= 1 && ram <= 64 ? ram : 2;
  render();
  try {
    const appInfo = await api.call('app:info');
    memory = appInfo.memory;
    $('ram').max = memory.maxGb;
    if (Number($('ram').value) > memory.maxGb) $('ram').value = Math.min(memory.maxGb, 2);
    addresses = appInfo.addresses;
    state = appInfo.state;
    running = appInfo.current;
  } catch (e) {
    fail(e);
  }
  loadUpdateState();
  loadTheme();
  loadPrefs();
  await loadJavas(false);
  addLog('Нажмите «Запустить» — всё нужное скачается само.');
  await refreshServers();
  // Открываем запущенный сервер, иначе тот, что открывали в прошлый раз, иначе первый в списке.
  const lastType = store.get('type', '');
  const lastVer = store.get('version:' + lastType, '');
  const pick =
    (running && servers.find((x) => x.type === running.type && x.version === running.version)) ||
    servers.find((x) => x.type === lastType && x.version === lastVer) ||
    servers[0];
  if (running && !pick) await selectServer(running.type, running.version);
  else if (pick) await selectServer(pick.type, pick.version);
  else openWizard();
})();
