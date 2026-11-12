// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- сервер из сборки .mrpack ----

$('from-pack').addEventListener('click', async () => {
  if (state !== 'stopped') {
    addLog('Остановите сервер, прежде чем ставить сборку.', 'error');
    return;
  }
  let p;
  try {
    p = await api.call('mrpack:open');
  } catch (e) {
    fail(e);
    return;
  }
  if (!p) return;
  const lines = [
    `Сборка «${p.name}»${p.packVersion ? ' ' + p.packVersion : ''}`,
    `Minecraft ${p.mc}, ${LOADER_NAMES[p.type]} ${p.loader}`,
    `Модов для сервера: ${p.mods}` + (p.skipped ? ` (ещё ${p.skipped} — только для игроков, на сервер не ставятся)` : ''),
  ];
  if (!p.checked) lines.push('Не удалось свериться с Modrinth — поставятся все моды сборки.');
  if (p.bad) lines.push(`Файлов с недопустимым адресом или путём: ${p.bad} — они будут пропущены.`);
  if (p.exists) {
    lines.push('', `Сервер ${LOADER_NAMES[p.type]} ${p.mc} уже есть. ${p.hasMods ? 'Его моды будут заменены (старые сохранятся в папке backups), ' : ''}мир останется — перед установкой лаунчер сделает его копию.`);
  }
  lines.push('', 'Установить?');
  if (!window.confirm(lines.join('\n'))) {
    api.call('mrpack:cancel').catch(() => {});
    return;
  }
  tab = 'console';
  renderTabs();
  $('progress').hidden = false;
  // Кнопка в мастере показывает, что идёт установка (подробности — в консоли).
  const btn = $('from-pack');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Устанавливаю сборку — это может занять пару минут…';
  try {
    const r = await api.call('mrpack:apply');
    // Открываем сервер из сборки: тип, версия игры и загрузчик.
    await refreshServers();
    await selectServer(r.type, r.mc);
  } catch (e) {
    fail(e);
  }
  btn.disabled = false;
  btn.textContent = label;
  $('progress').hidden = true;
  render();
});
