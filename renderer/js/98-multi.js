// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- несколько серверов одновременно и сеть серверов (Velocity) ----

let bgList = []; // фоновые серверы: { key, title, state, port, kind }
let bgShown = ''; // чей журнал сейчас в #bg-log

const bgEntry = () => bgList.find((b) => b.key === `${type}-${$('version').value}`) || null;

function appendBgLine(text, kind) {
  const box = $('bg-log');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = kind || 'server';
  line.textContent = text;
  box.appendChild(line);
  while (box.childElementCount > 2000) box.firstElementChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}
async function showBgLog(key) {
  if (bgShown === key) return;
  bgShown = key;
  $('bg-log').replaceChildren();
  if (!key) return;
  try {
    for (const l of await api.call('bg:lines', { key })) appendBgLine(l);
  } catch {
    /* журнал пуст */
  }
}

api.on('bg:state', (list) => {
  bgList = list;
  render();
  if (tab === 'settings') renderNetwork();
});
api.on('bg:log', ({ key, text, kind }) => {
  if (key === bgShown) appendBgLine(text, kind);
});

// Окно: состояние выбранного сервера, если он работает в фоне.
const baseRenderMulti = render;
render = function () {
  baseRenderMulti();
  const e = bgEntry();
  const blocked = state !== 'stopped' && !isSelectedRunning();
  if (e) {
    $('status').dataset.state = e.state;
    $('status').textContent = STATE_TEXT[e.state] + ' · вместе с другими';
    $('start').disabled = true;
    $('start').textContent = 'Запустить';
    $('stop').disabled = e.state === 'stopping';
    $('cmd').disabled = $('send').disabled = e.state === 'stopping';
    setHint('start-hint', `Работает на порту ${e.port}. Журнал и команды — этого сервера.`);
    $('address').hidden = true;
  } else if (blocked && info && info.installed && $('version').value) {
    // Другой сервер уже работает — этот можно запустить рядом, на своём порту.
    const ready = renderJavaHint() && (info.eula || $('eula').checked);
    $('start').disabled = !ready;
    $('start').textContent = 'Запустить вместе';
    const h = setHint('start-hint', `Сейчас работает «${running ? serverTitle(running.type, running.version) : 'другой сервер'}». Этот можно запустить одновременно — лаунчер даст ему свободный порт.`);
    h.className = 'hint';
  }
  const showBg = !!e;
  $('log').hidden = showBg;
  $('bg-log').hidden = !showBg;
  showBgLog(e ? e.key : '');
};

const baseStartMulti = startServer;
startServer = async function () {
  if (state !== 'stopped' && !isSelectedRunning() && !bgEntry()) {
    try {
      const r = await api.call('bg:start', { ...selected(), ramGb: $('ram').value, javaPath: $('java').value });
      addLog(`«${serverTitle(type, $('version').value)}» запускается вместе с другими на порту ${r.port}.`);
    } catch (e) {
      setHint('start-hint', e.message, 'bad');
    }
    return;
  }
  return baseStartMulti();
};
// Кнопка «Остановить» и команды — фоновому серверу, если выбран он.
$('stop').addEventListener(
  'click',
  (ev) => {
    const e = bgEntry();
    if (!e) return;
    ev.stopImmediatePropagation();
    api.call('bg:stop', { key: e.key }).catch(fail);
  },
  true
);
$('cmd-form').addEventListener(
  'submit',
  (ev) => {
    const e = bgEntry();
    if (!e) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const text = $('cmd').value.trim();
    if (!text) return;
    api.call('bg:command', { key: e.key, text }).then(() => ($('cmd').value = '')).catch(fail);
  },
  true
);

// ---- сеть серверов ----

let netInfo = null;
async function renderNetwork() {
  try {
    netInfo = await api.call('net2:get');
  } catch {
    return;
  }
  const cfg = netInfo.config;
  const inNet = new Set(((cfg && cfg.servers) || []).map((s) => `${s.type}-${s.version}`));
  const box = $('nw2-list');
  if (netInfo.candidates.length < 2) {
    box.replaceChildren();
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = `Нужно хотя бы два установленных сервера Paper (сейчас: ${netInfo.candidates.length}). Создайте их через «Новый сервер» и запустите каждый один раз.`;
    box.appendChild(p);
  } else {
    box.replaceChildren(
      ...netInfo.candidates.map((c) => {
        const l = document.createElement('label');
        l.className = 'check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.version = c.version;
        cb.checked = inNet.has(`paper-${c.version}`);
        const sp = document.createElement('span');
        const inCfg = cfg && cfg.servers.find((s) => s.version === c.version);
        sp.textContent = `${c.title}${inCfg ? ` — /server ${inCfg.name}, порт ${inCfg.port}` : ''}`;
        l.append(cb, sp);
        return l;
      })
    );
  }
  if (cfg) {
    $('nw2-port').value = cfg.port;
    $('nw2-online').checked = cfg.onlineMode;
  }
  $('nw2-setup').disabled = netInfo.candidates.length < 2 || netInfo.running;
  $('nw2-setup').textContent = cfg ? 'Сохранить изменения' : 'Настроить сеть';
  $('nw2-start').hidden = !cfg || netInfo.running;
  $('nw2-stop').hidden = !netInfo.running;
  $('nw2-remove').hidden = !cfg || netInfo.running;
  const proxy = bgList.find((b) => b.key === 'velocity');
  if (proxy) setHint('nw2-hint', proxy.state === 'running' ? `Сеть работает. Игроки заходят по порту ${cfg.port}${cfg.port === 25565 ? ' (стандартный — можно не указывать)' : ''}.` : 'Сеть запускается…', proxy.state === 'running' ? 'good' : '');
}
$('nw2-setup').addEventListener('click', async () => {
  const servers = [...document.querySelectorAll('#nw2-list input:checked')].map((cb) => ({ type: 'paper', version: cb.dataset.version }));
  setHint('nw2-hint', 'Настраиваю (при первом разе скачается Velocity)…');
  try {
    await api.call('net2:setup', { servers, port: Number($('nw2-port').value), onlineMode: $('nw2-online').checked });
    setHint('nw2-hint', 'Сеть настроена. Серверы в ней теперь принимают игроков только через сеть.', 'good');
  } catch (e) {
    setHint('nw2-hint', e.message, 'bad');
  }
  renderNetwork();
});
$('nw2-start').addEventListener('click', async () => {
  setHint('nw2-hint', 'Запускаю серверы и прокси…');
  try {
    await api.call('net2:start', { ramGb: $('ram').value });
  } catch (e) {
    setHint('nw2-hint', e.message, 'bad');
  }
  renderNetwork();
});
$('nw2-stop').addEventListener('click', async () => {
  await api.call('net2:stop').catch(fail);
  setHint('nw2-hint', 'Сеть останавливается…');
});
$('nw2-remove').addEventListener('click', async () => {
  if (!window.confirm('Убрать сеть? Серверы снова станут обычными: им вернётся проверка лицензии и доступ по своему адресу.')) return;
  try {
    await api.call('net2:remove');
    setHint('nw2-hint', 'Сеть убрана.', 'good');
  } catch (e) {
    setHint('nw2-hint', e.message, 'bad');
  }
  renderNetwork();
});

const baseLoadToolsMulti = loadTools;
loadTools = async function () {
  await baseLoadToolsMulti();
  renderNetwork();
};
api.call('bg:list').then((l) => {
  bgList = l;
  render();
}).catch(() => {});
