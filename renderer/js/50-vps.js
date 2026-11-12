// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- VPS ----

const vpsState = {
  loaded: false,
  list: [],
  sel: null, // id выбранного VPS
  info: null, // сведения о выбранном VPS
  editing: null, // null — форма скрыта; {} — новый; профиль — изменение
  auth: 'password',
  busy: false,
  console: null, // имя сервера, чья консоль открыта
  timer: null,
};

const vpsSel = () => vpsState.list.find((v) => v.id === vpsState.sel) || null;

function renderVpsList() {
  const box = $('vps-items');
  box.replaceChildren();
  for (const v of vpsState.list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vps-item';
    b.setAttribute('aria-current', String(v.id === vpsState.sel && !vpsState.editing));
    const n = document.createElement('b');
    n.textContent = v.name;
    const s = document.createElement('span');
    s.textContent = `${v.username}@${v.host}`;
    b.append(n, s);
    b.addEventListener('click', () => selectVps(v.id));
    box.appendChild(b);
  }
}

function renderVps() {
  renderVpsList();
  const v = vpsSel();
  $('vps-form').hidden = !vpsState.editing;
  $('vps-open').hidden = !!vpsState.editing || !v;
  $('vps-empty').hidden = !!vpsState.editing || !!v;
  if (vpsState.editing || !v) return;

  $('vps-name').textContent = v.name;
  const inf = vpsState.info;
  $('vps-sub').textContent = [
    `${v.username}@${v.host}${v.port !== 22 ? ':' + v.port : ''}`,
    inf && inf.os,
    inf && inf.memGb ? `память ${inf.memGb} ГБ` : null,
    inf && inf.diskGb !== null && inf.diskGb !== undefined ? `свободно ${inf.diskGb} ГБ` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Что переносим — сервер, выбранный в левой панели.
  const what = $('vt-what');
  const ver = $('version').value;
  let ok = true;
  if (!ver || !info) {
    what.textContent = 'Выберите сервер в левой панели.';
    ok = false;
  } else if (!info.installed) {
    what.textContent = `${LOADER_NAMES[type] || (type === 'paper' ? 'Paper' : 'Vanilla')} ${ver} ещё не установлен на ПК. Запустите его хотя бы раз — потом его можно будет перенести.`;
    what.className = 'hint warn';
    ok = false;
  } else {
    const parts = [`Будет перенесён сервер из левой панели: ${type} ${ver} — мир, моды, плагины и настройки.`];
    if (!info.eula) parts.push('На ПК не принято лицензионное соглашение — на VPS сервер не запустится. Запустите его один раз на ПК с галочкой EULA.');
    if (isSelectedRunning()) parts.push('Сначала остановите его на ПК.');
    what.textContent = parts.join(' ');
    what.className = 'hint' + (!info.eula || isSelectedRunning() ? ' warn' : '');
    if (isSelectedRunning()) ok = false;
  }
  if (ver && !$('vt-name').dataset.touched) $('vt-name').value = `${type}-${ver}`;
  $('vt-go').disabled = !ok || vpsState.busy || !inf;

  // Серверы на VPS
  const box = $('vps-servers');
  box.replaceChildren();
  const servers = (inf && inf.servers) || [];
  if (!inf) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = 'Подключаюсь…';
    box.appendChild(p);
  } else if (!servers.length) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = 'На этом VPS пока нет серверов — перенесите сервер с ПК.';
    box.appendChild(p);
  }
  const maxRam = inf && inf.memGb ? Math.max(1, inf.memGb - 1) : 64;
  for (const s of servers) {
    const row = document.createElement('div');
    row.className = 'item vps-srv';
    const body = document.createElement('div');
    body.className = 'item-body';
    const title = document.createElement('div');
    title.className = 'item-title';
    const name = document.createElement('span');
    name.className = 'name plain';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const dot = document.createElement('span');
    dot.className = 'dot' + (s.running ? ' on' : '');
    meta.append(dot, `${s.running ? 'работает' : 'остановлен'} · ${s.type || '?'} ${s.mc || ''}`);
    title.append(name, meta);
    const addr = document.createElement('p');
    addr.className = 'item-desc';
    addr.textContent = `Адрес для игроков: ${v.host}${s.port && s.port !== '25565' ? ':' + s.port : ''}`;
    body.append(title, addr);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const note = document.createElement('span');
    note.className = 'hint';
    const act = async (fn, busyText) => {
      for (const b of actions.querySelectorAll('button,input')) b.disabled = true;
      note.textContent = busyText;
      note.className = 'hint';
      try {
        const msg = await fn();
        note.textContent = msg || '';
        note.className = 'hint good';
      } catch (e) {
        note.textContent = e.message;
        note.className = 'hint bad';
      }
      await refreshVpsInfo(true);
    };
    if (s.running) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn small danger';
      stop.textContent = 'Остановить';
      stop.addEventListener('click', () =>
        act(async () => {
          const r = await api.call('vps:stop', { id: v.id, name: s.name });
          return r.killed ? 'Сервер не ответил на stop и был остановлен принудительно' : 'Остановлен, мир сохранён';
        }, 'Останавливаю (до минуты)…')
      );
      actions.appendChild(stop);
    } else {
      const ram = document.createElement('input');
      ram.type = 'number';
      ram.className = 'ram';
      ram.min = 1;
      ram.max = maxRam;
      ram.value = Math.min(maxRam, s.ramGb || 2);
      ram.title = `Память для сервера, ГБ (на VPS ${inf && inf.memGb ? inf.memGb : '?'} ГБ)`;
      const lbl = document.createElement('span');
      lbl.className = 'hint';
      lbl.textContent = 'ГБ';
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'btn small primary';
      start.textContent = 'Запустить';
      start.addEventListener('click', () =>
        act(async () => {
          const n = Math.round(Number(ram.value));
          if (!(n >= 1 && n <= maxRam)) throw new Error(`Память — от 1 до ${maxRam} ГБ`);
          await api.call('vps:start', { id: v.id, name: s.name, ramGb: n });
          openVpsConsole(s);
          return 'Запускается — следите в консоли';
        }, 'Запускаю…')
      );
      actions.append(ram, lbl, start);
    }
    const cons = document.createElement('button');
    cons.type = 'button';
    cons.className = 'btn small';
    cons.textContent = 'Консоль';
    cons.addEventListener('click', () => openVpsConsole(s));
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'btn small';
    check.textContent = 'Проверить доступ';
    check.title = 'Попробовать подключиться к серверу из интернета';
    check.addEventListener('click', async () => {
      note.textContent = 'Проверяю…';
      note.className = 'hint';
      const r = await api.call('vps:checkPort', { id: v.id, port: s.port || 25565 }).catch((e) => ({ ok: false, reason: e.message }));
      if (r.ok) {
        note.textContent = 'Порт открыт — игроки смогут подключиться';
        note.className = 'hint good';
      } else if (!s.running) {
        note.textContent = 'Сервер не запущен — сначала запустите его';
        note.className = 'hint warn';
      } else {
        note.textContent = `Порт ${s.port || 25565} закрыт. Откройте его в брандмауэре VPS (например: sudo ufw allow ${s.port || 25565}/tcp) или в панели хостинга`;
        note.className = 'hint bad';
      }
    });
    actions.append(cons, check, note);
    row.append(body, actions);
    box.appendChild(row);
  }
}

async function loadVpsList() {
  try {
    vpsState.list = await api.call('vps:list');
  } catch (e) {
    setHint('vps-hint', e.message, 'bad');
  }
  vpsState.loaded = true;
  if (!vpsSel() && vpsState.list.length) {
    await selectVps(vpsState.list[0].id);
    return;
  }
  renderVps();
}

async function selectVps(id) {
  if (vpsState.sel !== id) closeVpsConsole();
  vpsState.sel = id;
  vpsState.editing = null;
  vpsState.info = null;
  setHint('vps-hint', '');
  renderVps();
  await refreshVpsInfo(false);
}

/** Подключиться и обновить сведения. Первое подключение — спрашиваем про отпечаток ключа. */
async function refreshVpsInfo(quiet) {
  const v = vpsSel();
  if (!v) return;
  if (!quiet) setHint('vps-hint', 'Подключаюсь…');
  try {
    let r = await api.call('vps:info', { id: v.id });
    if (r.hostKey && r.hostKey.code === 'HOSTKEY_NEW') {
      const yes = window.confirm(
        `Первое подключение к ${v.host}.\n\nОтпечаток ключа сервера:\n${r.hostKey.fingerprint}\n\n` +
          'Если хостинг показывает отпечаток — сверьте его. Доверять этому серверу?'
      );
      if (!yes) {
        setHint('vps-hint', 'Подключение отменено: ключ сервера не подтверждён.', 'warn');
        return;
      }
      r = await api.call('vps:info', { id: v.id, acceptFingerprint: r.hostKey.fingerprint });
    }
    if (r.hostKey && r.hostKey.code === 'HOSTKEY_CHANGED') {
      setHint('vps-hint', r.hostKey.message, 'bad');
      const yes = window.confirm(
        `${r.hostKey.message}\n\nВы переустанавливали систему на этом VPS и доверяете новому ключу?`
      );
      if (yes) {
        await api.call('vps:forgetKey', { id: v.id });
        r = await api.call('vps:info', { id: v.id, acceptFingerprint: r.hostKey.fingerprint });
      } else {
        return;
      }
    }
    if (vpsState.sel !== v.id || r.hostKey) return;
    vpsState.info = r;
    if (!quiet) setHint('vps-hint', '');
    vpsState.list = await api.call('vps:list');
  } catch (e) {
    setHint('vps-hint', e.message, 'bad');
  }
  renderVps();
}

function showVpsForm(profile) {
  vpsState.editing = profile || {};
  const p = vpsState.editing;
  $('vps-form-title').textContent = p.id ? `Изменить «${p.name}»` : 'Новый VPS';
  $('vf-name').value = p.name || '';
  $('vf-host').value = p.host || '';
  $('vf-user').value = p.username || 'root';
  $('vf-port').value = p.port || 22;
  $('vf-key').value = p.keyPath || '';
  $('vf-pass').value = '';
  $('vf-keypass').value = '';
  $('vf-pass').placeholder = p.id && p.auth === 'password' ? 'Оставьте пустым, чтобы не менять' : '';
  setVpsAuth(p.auth || 'password');
  setHint('vf-hint', '');
  renderVps();
  $('vf-host').focus();
}

function setVpsAuth(a) {
  vpsState.auth = a;
  for (const b of document.querySelectorAll('[data-vauth]')) b.setAttribute('aria-checked', String(b.dataset.vauth === a));
  $('vf-pass-row').hidden = a !== 'password';
  $('vf-key-row').hidden = a !== 'key';
}

function openVpsConsole(s) {
  const v = vpsSel();
  if (!v) return;
  closeVpsConsole();
  vpsState.console = s.name;
  $('vps-console').hidden = false;
  $('vc-title').textContent = `Консоль: ${s.name}`;
  $('vc-addr').textContent = `${v.host}${s.port && s.port !== '25565' ? ':' + s.port : ''}`;
  $('vc-log').replaceChildren();
  api.call('vps:logOpen', { id: v.id, name: s.name }).catch((e) => addVpsLine(e.message, 'error'));
}

function closeVpsConsole() {
  const v = vpsSel();
  if (vpsState.console && v) api.call('vps:logClose', { id: v.id, name: vpsState.console }).catch(() => {});
  vpsState.console = null;
  $('vps-console').hidden = true;
}

function addVpsLine(text, kind) {
  const box = $('vc-log');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = kind || (/ERROR|Exception|^\s+at /.test(text) ? 'error' : /^=== /.test(text) ? 'info' : 'server');
  line.textContent = text;
  box.appendChild(line);
  while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

function ensureVps() {
  if (tab !== 'vps') {
    clearInterval(vpsState.timer);
    vpsState.timer = null;
    return;
  }
  if (!vpsState.loaded) loadVpsList();
  else renderVps();
  // Пока вкладка открыта — раз в 20 секунд обновляем состояние серверов.
  if (!vpsState.timer) {
    vpsState.timer = setInterval(() => {
      if (tab === 'vps' && vpsSel() && !vpsState.busy && !vpsState.editing) refreshVpsInfo(true);
    }, 20000);
  }
}

$('vps-add').addEventListener('click', () => showVpsForm(null));
$('vps-edit').addEventListener('click', () => vpsSel() && showVpsForm(vpsSel()));
$('vf-cancel').addEventListener('click', () => {
  vpsState.editing = null;
  renderVps();
});
for (const b of document.querySelectorAll('[data-vauth]')) b.addEventListener('click', () => setVpsAuth(b.dataset.vauth));
$('vf-key-pick').addEventListener('click', async () => {
  const p = await api.call('vps:pickKey').catch((e) => setHint('vf-hint', e.message, 'bad'));
  if (p) $('vf-key').value = p;
});
$('vps-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const auth = vpsState.auth;
  const input = {
    id: vpsState.editing && vpsState.editing.id,
    name: $('vf-name').value,
    host: $('vf-host').value,
    port: Number($('vf-port').value),
    username: $('vf-user').value,
    auth,
    keyPath: $('vf-key').value,
    secret: auth === 'password' ? $('vf-pass').value : $('vf-keypass').value,
  };
  $('vf-save').disabled = true;
  try {
    const saved = await api.call('vps:save', input);
    $('vf-pass').value = '';
    $('vf-keypass').value = '';
    vpsState.list = await api.call('vps:list');
    await selectVps(saved.id);
  } catch (err) {
    setHint('vf-hint', err.message, 'bad');
  }
  $('vf-save').disabled = false;
});
$('vps-del').addEventListener('click', async () => {
  const v = vpsSel();
  if (!v) return;
  if (!window.confirm(`Удалить «${v.name}» из лаунчера?\n\nСерверы на самом VPS не удалятся и продолжат работать.`)) return;
  closeVpsConsole();
  await api.call('vps:remove', { id: v.id }).catch(fail);
  vpsState.sel = null;
  vpsState.info = null;
  vpsState.list = await api.call('vps:list');
  await loadVpsList();
});
$('vps-refresh').addEventListener('click', () => refreshVpsInfo(false));
$('vt-name').addEventListener('input', () => {
  $('vt-name').dataset.touched = '1';
});
$('vt-go').addEventListener('click', async () => {
  const v = vpsSel();
  const name = $('vt-name').value.trim();
  if (!v || !name) return;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    setHint('vps-hint', 'Имя папки — только латиница, цифры, точка, дефис и подчёркивание', 'bad');
    return;
  }
  const existing = vpsState.info && vpsState.info.servers.find((s) => s.name === name);
  if (existing && !window.confirm(`На VPS уже есть сервер «${name}».\n\nЗаменить его версией с ПК? Прежняя версия (с миром) сохранится на VPS в отдельной папке-копии.`)) return;
  vpsState.busy = true;
  $('vt-steps').replaceChildren();
  $('vt-progress').hidden = false;
  $('vt-bar').style.width = '0';
  renderVps();
  try {
    await api.call('vps:transfer', { id: v.id, type, version: $('version').value, name });
  } catch (e) {
    const li = document.createElement('li');
    li.className = 'bad';
    li.textContent = e.message;
    $('vt-steps').appendChild(li);
  }
  vpsState.busy = false;
  $('vt-progress').hidden = true;
  await refreshVpsInfo(true);
});
$('vc-close').addEventListener('click', closeVpsConsole);
$('vc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = vpsSel();
  const text = $('vc-cmd').value.trim();
  if (!v || !vpsState.console || !text) return;
  try {
    await api.call('vps:command', { id: v.id, name: vpsState.console, text });
    addVpsLine('> ' + text, 'input');
    $('vc-cmd').value = '';
  } catch (err) {
    addVpsLine(err.message, 'error');
  }
});
api.on('vps:log', ({ id, name, line }) => {
  if (id === vpsState.sel && name === vpsState.console) addVpsLine(line);
});
api.on('vps:progress', ({ id, step, done, total }) => {
  if (id !== vpsState.sel) return;
  if (step) {
    const li = document.createElement('li');
    li.textContent = step;
    $('vt-steps').appendChild(li);
  }
  if (total) $('vt-bar').style.width = Math.min(100, (done / total) * 100) + '%';
});
