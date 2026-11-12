// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- обслуживание: резервные копии и перезапуск по расписанию ----

let mtData = null;
let mtBusy = false;

function renderMaint() {
  const d = mtData;
  if (!d) return;
  const running = isSelectedRunning();
  $('bk-before').checked = d.settings.backup.beforeStart;
  $('bk-every').value = String(d.settings.backup.everyHours);
  $('bk-keep').value = d.settings.backup.keep;
  $('rs-on').checked = d.settings.restart.enabled;
  $('rs-time').value = d.settings.restart.time;
  $('bk-now').disabled = mtBusy || !d.hasWorld;

  const box = $('bk-list');
  box.replaceChildren();
  if (!d.hasWorld && !d.backups.length) {
    setHint('bk-hint', 'Мира ещё нет — он появится после первого запуска сервера.');
  } else if (!$('bk-hint').classList.contains('good') && !$('bk-hint').classList.contains('bad')) {
    setHint('bk-hint', running
      ? 'Сервер запущен: копия делается на ходу — лаунчер сначала попросит сервер сохранить мир. Восстанавливать — только при остановленном сервере.'
      : `Копий: ${d.backups.length}. При восстановлении текущий мир тоже сохранится копией — отменить можно всегда.`);
  }
  for (const b of d.backups) {
    const { row, body } = itemShell(null);
    row.querySelector('.item-icon').remove();
    const title = document.createElement('div');
    title.className = 'item-title';
    const name = document.createElement('span');
    name.className = 'name plain';
    name.textContent = new Date(b.date).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = b.label;
    title.append(name, badge);
    const meta = document.createElement('p');
    meta.className = 'item-desc';
    meta.textContent = formatSize(b.size);
    body.append(title, meta);
    const btns = document.createElement('div');
    btns.className = 'row';
    const mk = (label, cls, fn, disabled, tip) => {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = `btn small ${cls}`;
      x.textContent = label;
      x.disabled = !!disabled;
      if (tip) x.title = tip;
      x.addEventListener('click', fn);
      btns.appendChild(x);
    };
    mk('Восстановить', '', () => restoreBackup(b), running || mtBusy, running ? 'Сначала остановите сервер' : '');
    mk('Показать', '', () => api.call('backup:reveal', { ...selected(), file: b.file }).catch(fail));
    mk('Удалить', 'danger', () => deleteBackup(b), mtBusy);
    row.appendChild(btns);
    box.appendChild(row);
  }
}

async function loadMaint() {
  if (!$('version').value) return;
  try {
    mtData = await api.call('maint:get', selected());
  } catch (e) {
    setHint('bk-hint', e.message, 'bad');
    return;
  }
  renderMaint();
}

function ensureMaint() {
  if (tab !== 'maint') return;
  setHint('bk-hint', '');
  setHint('mt-hint', '');
  loadMaint();
}

async function restoreBackup(b) {
  const when = new Date(b.date).toLocaleString('ru-RU');
  if (!window.confirm(`Вернуть мир к состоянию на ${when}?\n\nВсё, что было построено после этого, пропадёт из мира — но текущий мир сначала сохранится отдельной копией, так что это можно отменить.`)) return;
  mtBusy = true;
  setHint('bk-hint', 'Восстанавливаю мир…');
  renderMaint();
  try {
    const r = await api.call('backup:restore', { ...selected(), file: b.file });
    setHint('bk-hint', `Мир восстановлен. Прежний мир сохранён копией${r.safety ? ` (${r.safety})` : ''}.`, 'good');
  } catch (e) {
    setHint('bk-hint', e.message, 'bad');
  }
  mtBusy = false;
  await loadMaint();
}

async function deleteBackup(b) {
  if (!window.confirm('Удалить эту копию? Файл попадёт в корзину.')) return;
  try {
    await api.call('backup:delete', { ...selected(), file: b.file });
    setHint('bk-hint', 'Копия перемещена в корзину.', 'good');
  } catch (e) {
    setHint('bk-hint', e.message, 'bad');
  }
  await loadMaint();
}

async function saveMaint() {
  const settings = {
    backup: { beforeStart: $('bk-before').checked, everyHours: Number($('bk-every').value), keep: Number($('bk-keep').value) },
    restart: { enabled: $('rs-on').checked, time: $('rs-time').value || '05:00' },
  };
  try {
    mtData.settings = await api.call('maint:set', { ...selected(), settings });
    const r = mtData.settings.restart;
    setHint('mt-hint', r.enabled ? `Сохранено. Сервер будет перезапускаться каждый день в ${r.time}, пока лаунчер открыт.` : 'Сохранено.', 'good');
  } catch (e) {
    setHint('mt-hint', e.message, 'bad');
  }
}

for (const id of ['bk-before', 'bk-every', 'bk-keep', 'rs-on', 'rs-time']) $(id).addEventListener('change', saveMaint);
$('bk-now').addEventListener('click', async () => {
  mtBusy = true;
  setHint('bk-hint', 'Делаю копию…');
  renderMaint();
  try {
    const b = await api.call('backup:create', selected());
    setHint('bk-hint', b ? `Копия сохранена (${formatSize(b.size)}).` : 'Мира ещё нет — копировать нечего.', b ? 'good' : 'warn');
  } catch (e) {
    setHint('bk-hint', e.message, 'bad');
  }
  mtBusy = false;
  await loadMaint();
});
$('bk-folder').addEventListener('click', () => api.call('backup:reveal', selected()).catch(fail));
api.on('backups', () => {
  if (tab === 'maint') loadMaint();
});
