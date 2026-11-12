// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- отрисовка ----

// ---- автоустановка Java ----

const javaInstall = { active: false, text: '', pct: null, error: '' };
const LTS = [8, 11, 17, 21, 25];
const ltsFor = (need) => LTS.find((v) => v >= (need || 21)) || 25;

/** Скачать и поставить Java сама (в папку лаунчера), потом обновить список. */
async function installJavaAuto(need) {
  if (javaInstall.active) return;
  Object.assign(javaInstall, { active: true, text: `Готовлю Java ${ltsFor(need)}…`, pct: null, error: '' });
  render();
  try {
    const r = await api.call('java:install', { need });
    await loadJavas(true);
    // Если раньше была выбрана конкретная Java — переключаемся на «Авто», чтобы подхватилась новая.
    if ($('java').value !== 'auto') {
      $('java').value = 'auto';
      store.set('java', 'auto');
    }
    addLog(`Java ${r.major} установлена и будет использоваться автоматически.`);
  } catch (e) {
    javaInstall.error = e.message;
  }
  javaInstall.active = false;
  render();
}

api.on('java:progress', ({ text, done, total }) => {
  if (text) javaInstall.text = text;
  if (total) javaInstall.pct = Math.round((done / total) * 100);
  renderJavaHint();
});

/** Ссылка «Установить Java N» (сама) и запасная — на сайт. */
function javaOffer(el, need, label) {
  const major = ltsFor(need);
  addLink(el, label || `Установить Java ${major} автоматически`, () => installJavaAuto(need));
  el.append(' (или ');
  addLink(el, 'скачать с сайта', () => api.call('open:java', { version: major }).catch(fail));
  el.append(')');
}

function renderJavaHint() {
  const { java, need, manual } = effectiveJava();
  const el = $('java-hint');
  el.textContent = '';
  if (javaInstall.active) {
    el.className = 'hint';
    el.textContent = javaInstall.text + (javaInstall.pct !== null && javaInstall.pct < 100 ? ` ${javaInstall.pct}%` : '');
    return false;
  }
  if (javaInstall.error) {
    el.className = 'hint bad';
    el.textContent = `Не удалось установить Java: ${javaInstall.error}. `;
    javaOffer(el, need, 'Попробовать ещё раз');
    return false;
  }
  if (!javas.length) {
    el.className = 'hint bad';
    el.textContent = 'Java не найдена — без неё сервер не запустится. ';
    javaOffer(el, need);
    return false;
  }
  if (!java) {
    el.className = 'hint bad';
    el.textContent = need
      ? `Этой версии нужна Java ${need} или новее${manual ? ', а выбрана другая' : ''}. `
      : 'Выбранная Java не найдена. ';
    if (need) javaOffer(el, need);
    return false;
  }
  if (need && java.major < need) {
    el.className = 'hint bad';
    el.textContent = `Этой версии нужна Java ${need}+, а выбрана Java ${java.major}.`;
    return false;
  }
  if (isModded() && need && java.major - need >= 4) {
    el.className = 'hint warn';
    el.textContent = `Будет Java ${java.major}. Старые модовые версии часто работают только на Java ${need} — если сервер не запустится, `;
    addLink(el, `установите Java ${ltsFor(need)}`, () => installJavaAuto(need));
    el.append(' — лаунчер сделает это сам.');
    return true;
  }
  el.className = 'hint good';
  el.textContent = `Будет Java ${java.major}${java.bits === 32 ? ' (32 бит, до 1 ГБ памяти)' : ''}` + (need ? ` — подходит (нужна ${need}+).` : '.');
  return true;
}

/** Подсказка под полем памяти; false — значение недопустимо. */
function renderRamHint() {
  const raw = String($('ram').value).trim();
  const n = Number(raw.replace(',', '.'));
  const max = memory ? memory.maxGb : 64;
  const total = memory ? memory.totalGb : null;
  if (!raw || !Number.isInteger(n) || n < 1 || n > max) {
    setHint('ram-hint', total
      ? `Можно от 1 до ${max} ГБ: в компьютере всего ${total} ГБ, часть нужна Windows.`
      : `Можно от 1 до ${max} ГБ.`, 'bad');
    return false;
  }
  if (!total) {
    setHint('ram-hint', '');
  } else if (n > total * 0.75) {
    setHint('ram-hint', `Это почти вся память компьютера (${total} ГБ). Windows и игре, если вы играете на этом же ПК, может не хватить.`, 'warn');
  } else {
    setHint('ram-hint', `В компьютере ${total} ГБ, серверу можно выделить до ${max} ГБ.`);
  }
  return true;
}

/** Почему нельзя запустить выбранный сервер (поля с ошибками — во вкладке «Настройки»). */
function renderStartHint({ blocked, javaOk, ramOk }) {
  const el = setHint('start-hint', '');
  const toSettings = () => {
    tab = 'settings';
    renderTabs();
  };
  if (blocked) {
    el.className = 'hint warn';
    el.textContent = `Сейчас работает «${running ? serverTitle(running.type, running.version) : 'другой сервер'}». Остановите его, чтобы запустить этот. `;
    if (running) addLink(el, 'Перейти к нему', () => selectServer(running.type, running.version));
  } else if (state === 'stopped' && info && !javaOk) {
    el.className = 'hint bad';
    el.textContent = 'Нет подходящей Java. ';
    addLink(el, 'Открыть настройки запуска', toSettings);
  } else if (state === 'stopped' && !ramOk) {
    el.className = 'hint bad';
    el.textContent = 'Недопустимый объём памяти. ';
    addLink(el, 'Открыть настройки запуска', toSettings);
  }
}

/** Адреса для подключения: каждый копируется одним нажатием. */
function renderAddress(show) {
  const box = $('address');
  box.replaceChildren();
  box.hidden = !show;
  if (!show) {
    setHint('net-result', '');
    return;
  }
  const suffix = port === '25565' ? '' : ':' + port;
  // Если сервер привязан к одному IP, работает только он (даже localhost — нет).
  const list = serverIp
    ? [{ text: serverIp + suffix, sub: '' }]
    : [
        ...addresses.map((a) => ({ text: a.address + suffix, sub: a.vpn ? `VPN · ${a.name}` : a.name })),
        { text: 'localhost' + suffix, sub: 'с этого компьютера' },
      ];
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Адрес для друзей';
  box.appendChild(label);
  for (const item of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'addr-chip';
    b.title = 'Скопировать адрес';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = item.sub;
    b.append(item.text, sub);
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.text);
      } catch {
        return;
      }
      b.classList.add('copied');
      sub.textContent = 'Скопировано';
      setTimeout(() => {
        b.classList.remove('copied');
        sub.textContent = item.sub;
      }, 1600);
    });
    box.appendChild(b);
  }
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'link-btn net-check';
  check.textContent = serverIp ? '' : 'Проверить доступ из интернета';
  check.hidden = !!serverIp;
  check.addEventListener('click', () => checkInternet());
  box.appendChild(check);
}

function render() {
  const busy = state !== 'stopped';
  const mine = isSelectedRunning(); // запущен (или запускается) именно выбранный сервер
  const myState = mine ? state : 'stopped';
  const status = $('status');
  status.dataset.state = myState;
  status.textContent = STATE_TEXT[myState];

  $('type').value = type;
  setHint('type-hint', TYPE_HINTS[type]);

  const modded = isModded();
  $('loader-row').hidden = !modded;
  $('loader-label').textContent = !modded
    ? ''
    : type === 'mohist' || type === 'youer'
      ? `Сборка ${LOADER_NAMES[type]}`
      : type === 'arclight'
        ? 'Загрузчик модов и версия Arclight'
        : `Версия ${LOADER_NAMES[type]}`;

  const hasVersion = !!$('version').value;
  const hasLoader = !modded || !!$('loader').value;
  const javaOk = renderJavaHint();
  const ramOk = renderRamHint();
  const eulaOk = $('eula').checked || (info && info.eula);
  const install = needsInstall();

  const blocked = busy && !mine; // работает другой сервер — два сразу не запустить
  if (state === 'running' && mine) {
    $('start').disabled = false;
    $('start').textContent = 'Перезапустить';
  } else {
    $('start').disabled = busy || !hasVersion || !hasLoader || !info || !javaOk || !eulaOk || !ramOk;
    $('start').textContent = 'Запустить';
  }
  $('stop').disabled = !(mine && (state === 'starting' || state === 'running'));
  $('cmd').disabled = $('send').disabled = !(state === 'starting' || state === 'running');

  for (const id of ['type', 'version', 'loader', 'pre', 'ram', 'java']) $(id).disabled = mine && busy;
  renderStartHint({ blocked, javaOk, ramOk });
  $('eula-row').hidden = !!(info && info.eula);
  $('progress').hidden = !(mine && (state === 'downloading' || state === 'installing'));
  $('progress').classList.toggle('busy', state === 'installing');
  $('save').disabled = !hasVersion;
  $('folder').disabled = !hasVersion;

  if (!info) {
    setHint('version-hint', '');
  } else if (!info.installed) {
    setHint('version-hint', 'Будет скачан и установлен при первом запуске.');
  } else if (install && type === 'arclight' && flavorOf(info.installedLoader) !== flavorOf($('loader').value)) {
    setHint('version-hint', `Сейчас установлен Arclight на ${FLAVOR_NAMES[flavorOf(info.installedLoader)] || '?'}. При запуске он сменится на ${FLAVOR_NAMES[flavorOf($('loader').value)]} — установленные моды под старый загрузчик работать перестанут.`, 'bad');
  } else if (install) {
    const label = loaders && loaders.list.find((l) => l.id === info.installedLoader);
    setHint('version-hint', `Установлен ${label ? label.label : info.installedLoader || '?'} — при запуске будет заменён на выбранный. Мир, моды и плагины сохранятся.`, 'warn');
  } else {
    setHint('version-hint', 'Уже установлен.');
  }

  renderAddress(mine && state === 'running');
  if (typeof renderShell === 'function') renderShell();
  renderTabs();
}

function renderTabs() {
  const words = contentWord();
  const modsTab = $('tab-mods');
  modsTab.textContent = isHybrid() ? 'Моды и плагины' : type === 'paper' ? 'Плагины' : 'Моды';
  if (installedMods.length && type !== 'vanilla' && !isHybrid()) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = installedMods.length;
    modsTab.appendChild(c);
  }
  // На вкладке «Консоль» — красный счётчик, если найдены ошибки, а пользователь на другой вкладке.
  const consoleTab = $('tab-console');
  consoleTab.textContent = 'Консоль';
  const errCount = issues.filter((i) => i.severity === 'error').length;
  if (errCount && tab !== 'console') {
    const c = document.createElement('span');
    c.className = 'count bad';
    c.textContent = errCount;
    c.title = 'Найдены ошибки — откройте консоль';
    consoleTab.appendChild(c);
  }
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  $('view-console').hidden = tab !== 'console';
  $('view-mods').hidden = tab !== 'mods';
  $('view-configs').hidden = tab !== 'configs';
  $('view-vps').hidden = tab !== 'vps';
  $('view-players').hidden = tab !== 'players';
  $('view-maint').hidden = tab !== 'maint';
  $('view-settings').hidden = tab !== 'settings';
  if (tab === 'vps' && vpsState.loaded && !vpsState.editing) renderVps();
  renderCfgHint();

  const off = type === 'vanilla';
  $('mods-off').hidden = !off;
  $('mods-on').hidden = off;
  // «Сборка для игроков» — только там, где есть моды (на Paper игрокам ничего не нужно).
  const canPack = kinds().includes('mod');
  $('mview-pack').hidden = !canPack;
  if (!canPack && modsView === 'pack') modsView = 'search';
  for (const b of document.querySelectorAll('[data-mview]')) b.setAttribute('aria-selected', String(b.dataset.mview === modsView));
  $('mview-installed').textContent = `Установленные${installedMods.length ? ' · ' + installedMods.length : ''}`;
  $('mods-search').hidden = modsView !== 'search';
  $('mods-installed').hidden = modsView !== 'installed';
  $('mods-pack').hidden = modsView !== 'pack';
  $('search').placeholder = currentKind() === 'plugin' ? 'Название плагина, например: LuckPerms' : 'Название мода, например: JEI или Create';
  $('mods-kind').hidden = !isHybrid() || modsView === 'pack';
  for (const b of document.querySelectorAll('[data-mkind]')) b.setAttribute('aria-selected', String(b.dataset.mkind === currentKind()));

  const v = $('version').value;
  if (isSelectedRunning()) {
    setHint('mods-hint', `Изменения применятся после перезапуска сервера.`, 'warn');
  } else if (isHybrid() && v) {
    const fl = FLAVOR_NAMES[currentFlavor()];
    if (currentKind() === 'plugin') {
      setHint('mods-hint', `Плагины Paper/Bukkit для ${v}. Игрокам ставить их не нужно. На гибриде работают не все плагины.`);
    } else if (fl) {
      setHint('mods-hint', `Моды для ${fl} ${v}. Игрокам нужен ${fl} и те же моды.`);
    } else {
      setHint('mods-hint', 'Сначала выберите сборку — от неё зависит, какие моды подходят.', 'warn');
    }
  } else if (isModded() && v) {
    setHint('mods-hint', `Подбираются ${words.many.toLowerCase()} для ${LOADER_NAMES[type]} ${v}. Игрокам нужны те же ${words.many.toLowerCase()}.`);
  } else if (v) {
    setHint('mods-hint', `Подбираются плагины для Paper ${v}. Игрокам ставить ничего не нужно.`);
  } else {
    setHint('mods-hint', '');
  }
}
