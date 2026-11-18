// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- VPS: игроки, файлы, бэкапы, автоматика, перенос, Chunky (вкладки панели сервера) ----

const vmx = {
  players: null, // { id, name, port } — пока открыта вкладка «Игроки»
  ptimer: null,
  pdata: null,
  files: null, // { id, name, rel }
  edit: null, // rel открытого в редакторе файла
  editText: '',
  backups: null,
  auto: null,
  more: null,
  cktimer: null,
};
const vmSame = (a, b) => a && b && a.id === b.id && a.name === b.name;
const vmArgs = (o) => ({ id: o.id, name: o.name });

/** Блокировать кнопки на время действия; текст — в подсказку hintId. */
async function vmDo(hintId, busyText, fn, buttons = []) {
  for (const b of buttons) b.disabled = true;
  setHint(hintId, busyText);
  try {
    const msg = await fn();
    if (msg !== undefined) setHint(hintId, msg || '', msg ? 'good' : '');
    return true;
  } catch (e) {
    setHint(hintId, e.message, 'bad');
    return false;
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

// ---- игроки ----

VPANES.players = {
  open(o) {
    vmx.players = { ...o };
    vmx.pdata = null;
    setHint('vp-hint', 'Загружаю…');
    for (const id of ['vp-online', 'vp-whitelist', 'vp-ops', 'vp-bans', 'vp-ipbans']) $(id).replaceChildren();
    vpListChanged();
    loadVpsPlayers();
    clearInterval(vmx.ptimer);
    vmx.ptimer = setInterval(() => tab === 'vps' && !document.hidden && loadVpsPlayers(true), 20000);
  },
  close() {
    vmx.players = null;
    clearInterval(vmx.ptimer);
  },
};

async function loadVpsPlayers(quiet) {
  const o = vmx.players;
  if (!o) return;
  try {
    const r = await api.call('vps:players', { ...vmArgs(o), port: (vman.cur && vman.cur.port) || o.port });
    if (vmx.players !== o) return;
    vmx.pdata = r;
    renderVpsPlayers();
    if (!quiet) {
      setHint(
        'vp-hint',
        vmRunning()
          ? 'Сервер запущен — изменения применяются сразу.'
          : `Сервер остановлен — изменения сохранятся в его файлы и сработают при запуске.${r.onlineMode ? ' Для ников нужен интернет: лаунчер узнаёт UUID игрока у Mojang.' : ''}`
      );
    }
  } catch (e) {
    if (vmx.players === o) setHint('vp-hint', e.message, 'bad');
  }
}

function renderVpsPlayers() {
  const d = vmx.pdata;
  if (!d) return;
  const running = vmRunning();
  const on = $('vp-online');
  on.replaceChildren();
  on.dataset.empty = running ? (d.online ? 'Никого нет' : 'Не видно: порт сервера закрыт снаружи или сервер ещё загружается') : 'Сервер не запущен';
  $('vp-count').textContent = running && d.online ? `${d.online.count} из ${d.max || d.online.max}` : '';
  const opNames = new Set(d.ops.map((x) => String(x.name).toLowerCase()));
  for (const name of (running && d.online && d.online.names) || []) {
    const isOp = opNames.has(name.toLowerCase());
    on.appendChild(
      chip(name, isOp ? 'оператор' : '', [
        isOp ? ['снять OP', () => vpAction('ops', 'remove', name)] : ['дать OP', () => vpAction('ops', 'add', name)],
        ['кик', () => vpAction('kick', 'run', name), '', 'Выкинуть с сервера (сможет зайти снова)'],
        ['бан', () => window.confirm(`Забанить ${name}?`) && vpAction('bans', 'add', name), 'danger'],
      ])
    );
  }
  if (running && d.online && d.online.count > d.online.names.length) {
    const more = document.createElement('span');
    more.className = 'hint';
    more.textContent = `и ещё ${d.online.count - d.online.names.length}`;
    on.appendChild(more);
  }
  const lists = {
    whitelist: d.whitelist.map((x) => [x.name, '', 'убрать', 'danger']),
    ops: d.ops.map((x) => [x.name, '', 'снять', 'danger']),
    bans: d.bans.map((x) => [x.name, x.reason && x.reason !== 'Banned by an operator.' ? x.reason : '', 'разбанить', '']),
    ipbans: d.ipbans.map((x) => [x.ip, x.reason && x.reason !== 'Banned by an operator.' ? x.reason : '', 'разбанить', '']),
  };
  for (const [key, items] of Object.entries(lists)) {
    const box = $('vp-' + key);
    box.replaceChildren();
    for (const [value, sub, label, cls] of items) box.appendChild(chip(value, sub, [[label, () => vpAction(key, 'remove', value), cls]]));
  }
  $('vp-wl-state').textContent = d.whitelistOn ? '(включён)' : '(выключен — заходят все)';
}

async function vpAction(list, action, value, reason) {
  const o = vmx.players;
  if (!o) return false;
  let ok = false;
  await vmDo('vp-hint', 'Применяю…', async () => {
    const r = await api.call('vps:playerAction', { ...vmArgs(o), list, action, value, reason });
    ok = true;
    // Командам серверу нужна секунда, чтобы он обновил свои файлы.
    if (r.via === 'command') await new Promise((res) => setTimeout(res, 1500));
    await loadVpsPlayers(true);
    return r.via === 'command' ? 'Готово — применено на работающем сервере.' : 'Готово — сохранено, применится при запуске сервера.';
  });
  return ok;
}

function vpListChanged() {
  const l = $('vp-list').value;
  $('vp-value-label').textContent = l === 'ipbans' ? 'IP-адрес' : 'Ник';
  $('vp-value').placeholder = l === 'ipbans' ? '203.0.113.5' : 'Steve';
  $('vp-reason-row').hidden = !(l === 'bans' || l === 'ipbans');
}
$('vp-list').addEventListener('change', vpListChanged);
$('vp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('vp-value').value.trim();
  if (!value) return;
  const list = $('vp-list').value;
  if ((list === 'bans' || list === 'ipbans') && !window.confirm(`Забанить ${value}?`)) return;
  if (await vpAction(list, 'add', value, $('vp-reason').value)) {
    $('vp-value').value = '';
    $('vp-reason').value = '';
  }
});

// ---- файлы ----

VPANES.files = {
  open(o) {
    const keep = vmx.files && vmSame(vmx.files, o) ? vmx.files.rel : '';
    vmx.files = { ...vmArgs(o), rel: keep };
    closeVpsFile();
    loadVpsFiles();
  },
  // Уйти с вкладки, когда в редакторе несохранённый текст, — только после вопроса.
  canLeave: () => !vmx.edit || $('vfl-text').value === vmx.editText || window.confirm('В файле есть несохранённые изменения. Закрыть без сохранения?'),
  close() {
    vmx.edit = null;
  },
};

const vfJoin = (rel, n) => (rel ? `${rel}/${n}` : n);

async function loadVpsFiles(rel) {
  const o = vmx.files;
  if (!o) return;
  if (rel !== undefined) o.rel = rel;
  setHint('vfl-hint', 'Загружаю…');
  try {
    const r = await api.call('vps:files', { ...vmArgs(o), rel: o.rel });
    if (vmx.files !== o) return;
    renderVpsFiles(r);
    setHint('vfl-hint', o.rel === '' && vmRunning() ? 'Сервер запущен: моды и плагины заработают после перезапуска, а конфиги, которые сервер держит открытыми, он может перезаписать.' : '');
  } catch (e) {
    if (vmx.files !== o) return;
    // Папку могли удалить — возвращаемся в корень.
    if (o.rel) return loadVpsFiles('');
    setHint('vfl-hint', e.message, 'bad');
  }
}

function renderVpsFiles(r) {
  const o = vmx.files;
  const path = $('vfl-path');
  path.replaceChildren();
  const crumbs = [['', vman.cur ? vman.cur.name : '/']];
  let acc = '';
  for (const p of r.rel ? r.rel.split('/') : []) {
    acc = vfJoin(acc, p);
    crumbs.push([acc, p]);
  }
  crumbs.forEach(([rel, label], i) => {
    if (i) path.append(' / ');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'linkish no-tr';
    b.textContent = label;
    b.disabled = i === crumbs.length - 1;
    b.addEventListener('click', () => loadVpsFiles(rel));
    path.appendChild(b);
  });
  $('vfl-up').disabled = !r.rel;

  const box = $('vfl-list');
  box.replaceChildren();
  if (!r.items.length) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = 'Папка пуста.';
    box.appendChild(p);
  }
  for (const it of r.items) {
    const rel = vfJoin(r.rel, it.name);
    const row = document.createElement('div');
    row.className = 'vf-row';
    row.setAttribute('role', 'listitem');
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'vf-name no-tr' + (it.dir ? ' dir' : '');
    name.textContent = (it.dir ? '▸ ' : '') + it.name;
    name.title = it.dir ? 'Открыть папку' : 'Открыть файл';
    name.addEventListener('click', () => (it.dir ? loadVpsFiles(rel) : openVpsFile(rel)));
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [it.dir ? '' : formatSize(it.size), it.mtime ? new Date(it.mtime).toLocaleString(window.I18N_LOCALE || 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '']
      .filter(Boolean)
      .join(' · ');
    const acts = document.createElement('span');
    acts.className = 'vf-acts';
    const mk = (label, fn, cls, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small' + (cls ? ' ' + cls : '');
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', fn);
      acts.appendChild(b);
    };
    if (!it.dir) mk('Скачать', () => downloadVpsFile(rel));
    if (it.protected) {
      const lock = document.createElement('span');
      lock.className = 'hint';
      lock.textContent = 'служебный';
      lock.title = 'Этот файл ведёт лаунчер — его нельзя удалить или изменить отсюда';
      acts.appendChild(lock);
    } else {
      mk('Переименовать', () => renameVpsFile(rel, it.name));
      mk('Удалить', () => removeVpsFile(rel, it), 'danger');
    }
    row.append(name, meta, acts);
    box.appendChild(row);
  }
}

async function openVpsFile(rel) {
  const o = vmx.files;
  if (!o) return;
  if (vmx.edit && $('vfl-text').value !== vmx.editText && !window.confirm('В открытом файле есть несохранённые изменения. Открыть другой без сохранения?')) return;
  setHint('vfl-hint', 'Открываю…');
  try {
    const r = await api.call('vps:fileRead', { ...vmArgs(o), rel });
    if (vmx.files !== o) return;
    vmx.edit = rel;
    vmx.editText = r.text;
    $('vfl-edit').hidden = false;
    $('vfl-edit-name').textContent = rel;
    $('vfl-edit-name').classList.add('no-tr');
    $('vfl-edit-sub').textContent = r.protected ? 'только просмотр — файл ведёт лаунчер' : formatSize(r.size);
    $('vfl-text').value = r.text;
    $('vfl-text').readOnly = !!r.protected;
    $('vfl-save').hidden = !!r.protected;
    setHint('vfl-hint', '');
    $('vfl-edit').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('vfl-text').focus();
  } catch (e) {
    setHint('vfl-hint', e.message, 'bad');
  }
}

function closeVpsFile() {
  vmx.edit = null;
  vmx.editText = '';
  $('vfl-edit').hidden = true;
  $('vfl-text').value = '';
}

async function saveVpsFile() {
  const o = vmx.files;
  const rel = vmx.edit;
  if (!o || !rel) return;
  const text = $('vfl-text').value;
  await vmDo('vfl-hint', 'Сохраняю…', async () => {
    await api.call('vps:fileWrite', { ...vmArgs(o), rel, text });
    vmx.editText = text;
    loadVpsFiles();
    return vmRunning() ? `«${rel}» сохранён. Чтобы сервер увидел изменения, перезапустите его.` : `«${rel}» сохранён.`;
  }, [$('vfl-save')]);
}

async function downloadVpsFile(rel) {
  const o = vmx.files;
  if (!o) return;
  $('vfl-progress').hidden = false;
  $('vfl-bar').style.width = '0';
  await vmDo('vfl-hint', 'Скачиваю…', async () => {
    const r = await api.call('vps:fileDownload', { ...vmArgs(o), rel });
    return r ? `Сохранено: ${r.path}` : '';
  });
  $('vfl-progress').hidden = true;
}

async function renameVpsFile(rel, old) {
  const o = vmx.files;
  const entry = window.prompt('Новое имя:', old);
  if (!o || !entry || entry === old) return;
  await vmDo('vfl-hint', 'Переименовываю…', async () => {
    await api.call('vps:fileRename', { ...vmArgs(o), rel, entry });
    if (vmx.edit === rel) closeVpsFile();
    await loadVpsFiles();
    return 'Переименовано.';
  });
}

async function removeVpsFile(rel, it) {
  const o = vmx.files;
  if (!o) return;
  const msg = it.dir ? `Удалить папку «${it.name}» со всем содержимым?` : `Удалить файл «${it.name}»?`;
  if (!window.confirm(`${msg}\n\nВернуть его будет нельзя.`)) return;
  await vmDo('vfl-hint', 'Удаляю…', async () => {
    await api.call('vps:fileRemove', { ...vmArgs(o), rel });
    if (vmx.edit === rel || (vmx.edit && vmx.edit.startsWith(rel + '/'))) closeVpsFile();
    await loadVpsFiles();
    return 'Удалено.';
  });
}

$('vfl-up').addEventListener('click', () => {
  const o = vmx.files;
  if (o && o.rel) loadVpsFiles(o.rel.includes('/') ? o.rel.slice(0, o.rel.lastIndexOf('/')) : '');
});
$('vfl-refresh').addEventListener('click', () => loadVpsFiles());
$('vfl-mkdir').addEventListener('click', async () => {
  const o = vmx.files;
  const entry = o && window.prompt('Имя новой папки:');
  if (!entry) return;
  await vmDo('vfl-hint', 'Создаю…', async () => {
    await api.call('vps:fileMkdir', { ...vmArgs(o), rel: o.rel, entry });
    await loadVpsFiles();
    return 'Папка создана.';
  });
});
$('vfl-upload').addEventListener('click', async () => {
  const o = vmx.files;
  if (!o) return;
  $('vfl-progress').hidden = false;
  $('vfl-bar').style.width = '0';
  await vmDo('vfl-hint', 'Загружаю на VPS…', async () => {
    const r = await api.call('vps:fileUpload', { ...vmArgs(o), rel: o.rel });
    if (!r) return '';
    await loadVpsFiles();
    const where = o.rel ? `в «${o.rel}»` : 'в папку сервера';
    return `Загружено файлов: ${r.count} — ${where}.${vmRunning() && /^(mods|plugins)$/.test(o.rel) ? ' Перезапустите сервер, чтобы они заработали.' : ''}`;
  }, [$('vfl-upload')]);
  $('vfl-progress').hidden = true;
});
$('vfl-save').addEventListener('click', saveVpsFile);
$('vfl-edit-close').addEventListener('click', () => {
  if (vmx.edit && $('vfl-text').value !== vmx.editText && !window.confirm('В файле есть несохранённые изменения. Закрыть без сохранения?')) return;
  closeVpsFile();
});
$('vfl-text').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!$('vfl-save').hidden) saveVpsFile();
  }
});

// ---- бэкапы ----

VPANES.backups = {
  open(o) {
    vmx.backups = { ...vmArgs(o) };
    $('vb-progress').hidden = true;
    setHint('vb-hint', '');
    $('vb-sched').textContent = '';
    loadVpsBackups();
    // Расписание — в «Автоматике»; здесь только напоминание, когда следующий.
    api.call('vps:autoGet', vmArgs(o)).then((r) => {
      if (vmx.backups && vmSame(vmx.backups, o)) {
        $('vb-sched').textContent = r.conf.backup ? `По расписанию: каждый день в ${utcToLocal(r.conf.backup)}, хранить ${r.conf.keep}` : 'Бэкапы по расписанию — во вкладке «Автоматика».';
      }
    }, () => {});
  },
  close() {
    vmx.backups = null;
  },
};

const BK_KIND = { auto: 'по расписанию', manual: 'вручную', 'before-restore': 'перед восстановлением' };

async function loadVpsBackups() {
  const o = vmx.backups;
  if (!o) return;
  try {
    const list = await api.call('vps:backups', vmArgs(o));
    if (vmx.backups === o) renderVpsBackups(list);
  } catch (e) {
    if (vmx.backups === o) setHint('vb-hint', e.message, 'bad');
  }
}

function renderVpsBackups(list) {
  {
    const box = $('vb-list');
    box.replaceChildren();
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'list-empty';
      p.textContent = 'Бэкапов пока нет.';
      box.appendChild(p);
    }
    for (const b of list) {
      const row = document.createElement('div');
      row.className = 'item vb-row';
      const body = document.createElement('div');
      body.className = 'item-body';
      const title = document.createElement('div');
      title.className = 'item-title';
      const name = document.createElement('span');
      name.className = 'name plain';
      const m = b.file.match(/-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)-/);
      const when = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(b.mtime);
      name.textContent = when.toLocaleString(window.I18N_LOCALE || 'ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${formatSize(b.size)} · ${BK_KIND[b.kind] || ''}`;
      title.append(name, meta);
      body.appendChild(title);
      const acts = document.createElement('div');
      acts.className = 'vf-acts';
      const mk = (label, fn, cls) => {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'btn small' + (cls ? ' ' + cls : '');
        x.textContent = label;
        x.addEventListener('click', fn);
        acts.appendChild(x);
      };
      mk('Скачать на ПК', () => downloadVpsBackup(b));
      mk('Восстановить', () => restoreVpsBackup(b, name.textContent));
      mk('Удалить', () => deleteVpsBackup(b, name.textContent), 'danger');
      row.append(body, acts);
      box.appendChild(row);
    }
  }
}

async function downloadVpsBackup(b) {
  const o = vmx.backups;
  $('vb-progress').hidden = false;
  $('vb-bar').style.width = '0';
  await vmDo('vb-hint', 'Скачиваю…', async () => {
    const r = await api.call('vps:backupDownload', { ...vmArgs(o), file: b.file });
    return r ? `Сохранено: ${r.path}` : '';
  });
  $('vb-progress').hidden = true;
}

async function restoreVpsBackup(b, when) {
  const o = vmx.backups;
  if (vmRunning()) return setHint('vb-hint', 'Сервер на VPS запущен — сначала остановите его', 'bad');
  if (!window.confirm(`Восстановить сервер «${o.name}» из бэкапа от ${when}?\n\nТекущий мир и настройки заменятся содержимым бэкапа. Перед этим лаунчер сам сохранит их отдельным бэкапом «перед восстановлением» — так что отменить можно.`)) return;
  await vmDo('vb-hint', 'Восстанавливаю (может занять несколько минут)…', async () => {
    await api.call('vps:restore', { ...vmArgs(o), file: b.file });
    await loadVpsBackups();
    return 'Восстановлено. Можно запускать сервер.';
  }, [...document.querySelectorAll('#vb-list button'), $('vb-now')]);
}

async function deleteVpsBackup(b, when) {
  const o = vmx.backups;
  if (!window.confirm(`Удалить бэкап от ${when}?\n\nВернуть его будет нельзя.`)) return;
  await vmDo('vb-hint', 'Удаляю…', async () => {
    await api.call('vps:backupDelete', { ...vmArgs(o), file: b.file });
    await loadVpsBackups();
    return 'Бэкап удалён.';
  });
}

$('vb-now').addEventListener('click', async () => {
  const o = vmx.backups;
  if (!o) return;
  await vmDo('vb-hint', vmRunning() ? 'Сохраняю мир и упаковываю (сервер продолжает работать)…' : 'Упаковываю…', async () => {
    const r = await api.call('vps:backupNow', vmArgs(o));
    await loadVpsBackups();
    return `Бэкап готов: ${formatSize(r.size)}.`;
  }, [$('vb-now')]);
});

// ---- автоматика ----

// Время в mcl.conf — по UTC; в окне — по часам компьютера.
const tzShift = () => new Date().getTimezoneOffset(); // минут: UTC − местное
function shiftHm(hm, min) {
  const m = /^(\d\d):(\d\d)$/.exec(hm || '');
  if (!m) return '';
  const t = (((+m[1] * 60 + +m[2] + min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
const utcToLocal = (hm) => shiftHm(hm, -tzShift());
const localToUtc = (hm) => shiftHm(hm, tzShift());

VPANES.auto = {
  async open(o) {
    vmx.auto = { ...vmArgs(o) };
    const cur = vmx.auto;
    $('va-body').hidden = true;
    setHint('va-hint', '');
    setHint('va-load', 'Загружаю…');
    try {
      const [r, n] = await Promise.all([api.call('vps:autoGet', vmArgs(o)), api.call('vps:notifyGet', vmArgs(o))]);
      if (vmx.auto === cur) fillVpsAuto(r, n);
    } catch (e) {
      if (vmx.auto === cur) setHint('va-load', e.message, 'bad');
    }
  },
  close() {
    vmx.auto = null;
  },
};

function fillVpsAuto(r, n) {
  const c = r.conf;
  $('va-auto').checked = c.auto;
  $('va-restart-on').checked = !!c.restart;
  $('va-restart').value = c.restart ? utcToLocal(c.restart) : '05:00';
  $('va-warn').value = c.warn;
  $('va-backup-on').checked = !!c.backup;
  $('va-backup').value = c.backup ? utcToLocal(c.backup) : '04:00';
  $('va-keep').value = c.keep;
  $('va-discord').value = c.discord;
  for (const k of ['dcrash', 'dbackup', 'djoin', 'ddisk']) $('va-' + k).checked = c[k];
  for (const k of ['crash', 'backup', 'join', 'disk']) $('va-n' + k).checked = n[k];
  vaSync();
  setHint(
    'va-load',
    r.installed ? '' : 'Всё это делает на VPS небольшой фоновый скрипт лаунчера: он запускается раз в минуту (через cron на Linux или Планировщик заданий на Windows). Он поставится при сохранении.'
  );
  $('va-body').hidden = false;
}

function vaSync() {
  $('va-restart').disabled = $('va-warn').disabled = !$('va-restart-on').checked;
  $('va-backup').disabled = $('va-keep').disabled = !$('va-backup-on').checked;
  const hasUrl = !!$('va-discord').value.trim();
  for (const k of ['dcrash', 'dbackup', 'djoin', 'ddisk']) $('va-' + k).disabled = !hasUrl;
  $('va-discord-test').disabled = !hasUrl;
}
for (const id of ['va-restart-on', 'va-backup-on']) $(id).addEventListener('change', vaSync);
$('va-discord').addEventListener('input', vaSync);

$('va-save').addEventListener('click', async () => {
  const o = vmx.auto;
  if (!o) return;
  const conf = {
    auto: $('va-auto').checked,
    restart: $('va-restart-on').checked ? localToUtc($('va-restart').value) : '',
    warn: Math.round(Number($('va-warn').value) || 0),
    backup: $('va-backup-on').checked ? localToUtc($('va-backup').value) : '',
    keep: Math.round(Number($('va-keep').value) || 7),
    discord: $('va-discord').value.trim(),
  };
  for (const k of ['dcrash', 'dbackup', 'djoin', 'ddisk']) conf[k] = $('va-' + k).checked;
  if ($('va-restart-on').checked && !conf.restart) return setHint('va-hint', 'Укажите время перезапуска', 'bad');
  if ($('va-backup-on').checked && !conf.backup) return setHint('va-hint', 'Укажите время бэкапа', 'bad');
  const prefs = {};
  for (const k of ['crash', 'backup', 'join', 'disk']) prefs[k] = $('va-n' + k).checked;
  await vmDo('va-hint', 'Сохраняю на VPS…', async () => {
    const r = await api.call('vps:autoSave', { ...vmArgs(o), conf });
    await api.call('vps:notifySet', { ...vmArgs(o), prefs });
    setHint('va-load', '');
    if (r.warn) throw new Error(`Сохранено, но: ${r.warn}`);
    return 'Сохранено. Работает на VPS, даже когда лаунчер закрыт.';
  }, [$('va-save')]);
});
$('va-discord-test').addEventListener('click', () =>
  vmDo('va-hint', 'Отправляю…', async () => {
    await api.call('vps:discordTest', { url: $('va-discord').value.trim() });
    return 'Сообщение отправлено — проверьте канал в Discord.';
  }, [$('va-discord-test')])
);

// ---- ещё: перенос, Chunky, удаление ----

VPANES.more = {
  open(o) {
    vmx.more = { ...vmArgs(o) };
    $('vmo-progress').hidden = true;
    $('vmo-steps').replaceChildren();
    setHint('vmo-del-hint', '');
    const others = vpsState.list.filter((v) => v.id !== o.id);
    const sel = $('vmo-dst');
    sel.replaceChildren();
    for (const v of others) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.host})`;
      sel.appendChild(opt);
    }
    sel.disabled = $('vmo-tovps').disabled = $('vmo-name').disabled = !others.length;
    if (!others.length) {
      const opt = document.createElement('option');
      opt.textContent = 'Добавьте второй VPS слева';
      sel.appendChild(opt);
    }
    $('vmo-name').value = o.name;
    $('vmo-delete').disabled = vmRunning();
    $('vmo-del-hint').textContent = vmRunning() ? 'Сначала остановите сервер.' : '';
    loadVpsChunky();
    clearInterval(vmx.cktimer);
    vmx.cktimer = setInterval(() => tab === 'vps' && !document.hidden && vmx.ck && vmx.ck.watch && loadVpsChunkyStatus(), 10000);
  },
  close() {
    vmx.more = null;
    clearInterval(vmx.cktimer);
  },
};

function vmoStep(text, cls) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.textContent = text;
  $('vmo-steps').appendChild(li);
}

$('vmo-topc').addEventListener('click', async () => {
  const o = vmx.more;
  if (!o) return;
  if (vmRunning()) return vmoStep('Сервер на VPS запущен — остановите его перед переносом, иначе мир скопируется наполовину сохранённым', 'bad');
  const btns = [$('vmo-topc'), $('vmo-tovps')];
  btns.forEach((b) => (b.disabled = true));
  $('vmo-steps').replaceChildren();
  $('vmo-progress').hidden = false;
  $('vmo-bar').style.width = '0';
  vmx.job = `tp:${o.id}/${o.name}`;
  try {
    let r = await api.call('vps:toPc', { ...vmArgs(o) });
    if (r.exists) {
      const label = `${LOADER_NAMES[r.type] || r.type} ${r.version}`;
      if (!window.confirm(`На этом компьютере уже есть сервер ${label}.\n\nЗаменить его сервером с VPS? Прежний не удалится — лаунчер переложит его в папку копий.`)) {
        vmoStep('Перенос отменён.');
        return;
      }
      r = await api.call('vps:toPc', { ...vmArgs(o), replace: true });
    }
    if (r.saved) vmoStep(`Прежний сервер с ПК лежит здесь: ${r.saved}`);
    await refreshServers();
  } catch (e) {
    vmoStep(e.message, 'bad');
  } finally {
    btns.forEach((b) => (b.disabled = false));
    $('vmo-progress').hidden = true;
    vmx.job = null;
  }
});

$('vmo-tovps').addEventListener('click', async () => {
  const o = vmx.more;
  const dstId = $('vmo-dst').value;
  const dstName = $('vmo-name').value.trim();
  const dst = vpsState.list.find((v) => v.id === dstId);
  if (!o || !dst) return;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(dstName)) return vmoStep('Имя папки — только латиница, цифры, точка, дефис и подчёркивание', 'bad');
  if (vmRunning()) return vmoStep('Сервер на VPS запущен — остановите его перед переносом, иначе мир скопируется наполовину сохранённым', 'bad');
  if (!window.confirm(`Скопировать «${o.name}» на VPS «${dst.name}» в папку «${dstName}»?\n\nСервер пройдёт через этот компьютер: сначала скачается, потом загрузится. На этом VPS он останется как был. Если на другом VPS уже есть папка с таким именем, она сохранится как копия.`)) return;
  const btns = [$('vmo-topc'), $('vmo-tovps')];
  btns.forEach((b) => (b.disabled = true));
  $('vmo-steps').replaceChildren();
  $('vmo-progress').hidden = false;
  $('vmo-bar').style.width = '0';
  vmx.job = `tv:${o.id}/${o.name}`;
  try {
    await api.call('vps:toVps', { ...vmArgs(o), dstId, dstName });
    vmoStep(`Готово. Откройте VPS «${dst.name}» слева, чтобы запустить сервер там.`, 'good');
  } catch (e) {
    vmoStep(e.message, 'bad');
  } finally {
    btns.forEach((b) => (b.disabled = false));
    $('vmo-progress').hidden = true;
    vmx.job = null;
  }
});

api.on('vps:job', ({ key, step, done, total }) => {
  if (step && key === vmx.job) vmoStep(step);
  const bars = { tp: 'vmo-bar', tv: 'vmo-bar', bk: 'vb-bar', fu: 'vfl-bar', fd: 'vfl-bar' };
  const bar = bars[String(key).slice(0, 2)];
  if (total && bar) $(bar).style.width = Math.min(100, (done / total) * 100) + '%';
});

// Chunky
async function loadVpsChunky() {
  const o = vmx.more;
  if (!o) return;
  vmx.ck = null;
  for (const id of ['vmo-ck-install', 'vmo-ck-go', 'vmo-ck-cancel', 'vmo-ck-radius-row', 'vmo-ck-progress']) $(id).hidden = true;
  setHint('vmo-ck-hint', 'Проверяю…');
  try {
    const r = await api.call('vps:chunkyInfo', vmArgs(o));
    if (vmx.more !== o) return;
    vmx.ck = { installed: r.installed, watch: false };
    if (r.type === 'vanilla' || !r.type) {
      setHint('vmo-ck-hint', 'На ванильный сервер Chunky не поставить — нужен Paper, Fabric, Forge или NeoForge.');
      return;
    }
    $('vmo-ck-install').hidden = r.installed;
    $('vmo-ck-go').hidden = $('vmo-ck-radius-row').hidden = !r.installed;
    if (!r.installed) return setHint('vmo-ck-hint', 'Chunky не установлен.');
    setHint('vmo-ck-hint', vmRunning() ? '' : 'Прогрузка идёт на работающем сервере — сначала запустите его.');
    if (vmRunning()) loadVpsChunkyStatus();
  } catch (e) {
    if (vmx.more === o) setHint('vmo-ck-hint', e.message, 'bad');
  }
}

async function loadVpsChunkyStatus() {
  const o = vmx.more;
  if (!o) return;
  try {
    const st = await api.call('vps:chunkyStatus', vmArgs(o));
    if (vmx.more !== o || !st) return;
    const active = !st.done;
    vmx.ck.watch = active;
    $('vmo-ck-progress').hidden = false;
    $('vmo-ck-bar').style.width = Math.min(100, st.pct || 0) + '%';
    $('vmo-ck-cancel').hidden = !active;
    $('vmo-ck-go').hidden = active;
    $('vmo-ck-radius-row').hidden = active;
    if (active) setHint('vmo-ck-hint', `${String(st.pct).replace('.', ',')}% · осталось примерно ${st.eta || '…'}`);
    else setHint('vmo-ck-hint', st.pct >= 100 ? 'Мир прогружен.' : 'Прогрузка остановлена.', st.pct >= 100 ? 'good' : '');
  } catch {
    /* не страшно — попробуем позже */
  }
}

$('vmo-ck-install').addEventListener('click', () => {
  const o = vmx.more;
  return vmDo('vmo-ck-hint', 'Скачиваю Chunky с Modrinth и загружаю на VPS…', async () => {
    const r = await api.call('vps:chunkyInstall', vmArgs(o));
    await loadVpsChunky();
    return r.running ? 'Установлен — перезапустите сервер, чтобы Chunky заработал.' : 'Установлен.';
  }, [$('vmo-ck-install')]);
});
$('vmo-ck-go').addEventListener('click', () => {
  const o = vmx.more;
  const radius = Math.round(Number($('vmo-ck-radius').value));
  return vmDo('vmo-ck-hint', 'Запускаю…', async () => {
    await api.call('vps:chunkyStart', { ...vmArgs(o), radius });
    vmx.ck.watch = true;
    setTimeout(loadVpsChunkyStatus, 4000);
    return 'Прогрузка началась. Игроки могут заходить, но сервер будет нагружен сильнее обычного.';
  }, [$('vmo-ck-go')]);
});
$('vmo-ck-cancel').addEventListener('click', () => {
  const o = vmx.more;
  return vmDo('vmo-ck-hint', 'Останавливаю…', async () => {
    await api.call('vps:chunkyCancel', vmArgs(o));
    setTimeout(loadVpsChunkyStatus, 3000);
    return 'Остановлено.';
  }, [$('vmo-ck-cancel')]);
});

$('vmo-delete').addEventListener('click', async () => {
  const o = vmx.more;
  const v = vpsSel();
  const srv = o && vpsServerOf(o.name);
  if (!o || !v || !srv) return;
  if (srv.running) return setHint('vmo-del-hint', 'Сначала остановите сервер.', 'bad');
  const sure = window.confirm(
    `Удалить сервер «${o.name}» с VPS «${v.name}»?\n\n` + 'Папка сервера на VPS будет стёрта вместе с миром, модами, настройками и бэкапами. Вернуть её будет нельзя.'
  );
  if (!sure) return;
  await vmDo('vmo-del-hint', 'Удаляю…', async () => {
    await deleteVpsServer(srv);
    await refreshVpsInfo(true);
  }, [$('vmo-delete')]);
});
