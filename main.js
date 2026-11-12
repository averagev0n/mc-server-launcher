const { app, BrowserWindow, ipcMain, shell, net, clipboard, safeStorage, dialog, nativeTheme, Tray, Menu, Notification, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/core');
const mods = require('./lib/mods');
const configs = require('./lib/configs');
const pack = require('./lib/pack');
const mrpack = require('./lib/mrpack');
const backup = require('./lib/backup');
const players = require('./lib/players');
const { startMonitor } = require('./lib/monitor');
const updater = require('./lib/updater');
const diagnose = require('./lib/diagnose');
const { createVps, HostKeyError } = require('./lib/vps');
const servers = require('./lib/servers');
const upnp = require('./lib/upnp');
const { createDiscord, escapeMd } = require('./lib/discord');

// Сеть через Chromium: так учитываются системные настройки прокси.
core.setFetch((url, opts) => net.fetch(url, opts));
// Java, которую лаунчер скачивает сам, живёт в папке данных программы.
core.setJavaDir(path.join(app.getPath('userData'), 'java'));

const EULA_URL = 'https://aka.ms/MinecraftEULA';
const javaUrl = (v) => `https://adoptium.net/temurin/releases/?version=${Number(v) || 21}&os=windows&arch=x64`;
const SLUG_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// Папка с серверами: при запуске из исходников — рядом с программой, у собранной версии —
// в папке пользователя (не в «Документах»: их часто синхронизирует OneDrive, а он мешает серверу).
const ROOT = app.isPackaged
  ? path.join(app.getPath('home'), 'MinecraftServers')
  : path.join(__dirname, 'servers');

let win = null;
let child = null;
// stopped | downloading | installing | starting | running | stopping
let state = 'stopped';
let current = null; // { type, version } запущенного сервера
let killTimer = null;
let quitting = false;
let modBusy = false;
let lastStart = null; // параметры последнего запуска — для перезапуска
let restartPending = false;
let installUpdateAfterStop = false;

const serverDir = (type, version) => {
  core.checkArgs(type, version);
  return path.join(ROOT, `${type}-${version}`);
};
const isModded = (type) => core.LOADER_TYPES.includes(type);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const log = (text, kind = 'info') => send('log', { text, kind });
function setState(next) {
  const was = state;
  state = next;
  send('state', { state, current });
  if (next !== was) onState(next);
}

// Цветовые коды терминала (ESC[...m) — в окне лаунчера они не нужны.
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');
/** Строка лога как её показал бы терминал: без цветовых кодов, а «\r» перезаписывает строку (прогресс-бары). */
function cleanLine(raw) {
  const parts = raw.replace(/\r$/, '').split('\r');
  return parts[parts.length - 1].replace(ANSI_RE, '').trimEnd();
}

/** Память компьютера: всего и сколько можно отдать серверу (оставляем 2 ГБ системе). */
function memoryInfo() {
  const total = os.totalmem() / 1024 ** 3;
  return { totalGb: Math.round(total), maxGb: Math.max(1, Math.floor(total - 2)) };
}

const VPN_RE = /radmin|hamachi|zerotier|tailscale|wireguard|openvpn|vpn|tap-windows|wintun/i;

/**
 * Сетевые адреса компьютера: [{ address, name, vpn }].
 * Адреса 169.254.* пропускаем — это «пустые» адреса отключённых сетей, по ним никто не подключится.
 */
function localAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      list.push({ address: a.address, name, vpn: VPN_RE.test(name) });
    }
  }
  return list;
}

/** Java для запуска: выбранная вручную или подобранная под версию. */
async function chooseJava(type, version, javaPath) {
  const javas = await core.findJavas();
  if (!javas.length) {
    throw new Error('Java не найдена. Установите её (кнопка «Скачать Java») и перезапустите лаунчер');
  }
  const need = await core.requiredJava(version);
  if (javaPath && javaPath !== 'auto') {
    const j = javas.find((x) => x.path === javaPath);
    if (!j) throw new Error('Выбранная Java больше не найдена — выберите другую');
    if (need && j.major < need) {
      throw new Error(`Версии ${version} нужна Java ${need} или новее, а выбрана Java ${j.major}`);
    }
    return j;
  }
  const j = core.pickJava(javas, need, isModded(type));
  if (!j) throw new Error(`Версии ${version} нужна Java ${need} или новее — установите её`);
  return j;
}

async function startServer({ type, version, loader, ramGb, eula, javaPath }) {
  if (state !== 'stopped') throw new Error('Сервер уже запущен или запускается');
  core.checkArgs(type, version, loader || undefined);
  const dir = serverDir(type, version);
  const { maxGb, totalGb } = memoryInfo();
  const asked = Math.round(Number(ramGb)) || 2;
  if (asked > maxGb) {
    throw new Error(`В компьютере ${totalGb} ГБ памяти — серверу можно выделить не больше ${maxGb} ГБ`);
  }
  const ram = Math.max(1, asked);

  if (!eula && !core.eulaAccepted(dir)) {
    throw new Error('Чтобы запустить сервер, нужно принять лицензионное соглашение Minecraft (EULA)');
  }
  if (isModded(type) && !loader) throw new Error('Выберите версию загрузчика модов');
  const java = await chooseJava(type, version, javaPath);
  if (java.bits === 32 && ram > 1) {
    log('Выбрана 32-битная Java — серверу будет доступно не больше ~1 ГБ памяти.', 'error');
  }

  current = { type, version };
  let inst;
  try {
    if (core.needsInstall(type, dir, loader)) {
      setState('downloading');
      let lastSent = 0;
      inst = await core.install({
        type,
        mc: version,
        loader,
        dir,
        javaPath: java.path,
        onLog: (text, kind) => {
          if (state === 'downloading' && /установщик —/.test(text)) setState('installing');
          log(text, kind === 'error' ? 'error' : 'info');
        },
        onProgress: (got, total) => {
          const now = Date.now();
          if (now - lastSent > 100 || got === total) {
            lastSent = now;
            send('progress', { got, total });
          }
        },
      });
      log('Сервер установлен.');
    } else {
      inst = core.readInstall(dir);
    }
    if (eula) fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
    // Копия мира перед запуском — на случай, если моды или плагины что-то сломают.
    if (backup.readSettings(dir).backup.beforeStart && backup.worldDirs(dir).length) {
      log('Делаю резервную копию мира перед запуском…');
      const b = await backup.create(dir, 'auto');
      if (b) log(`Копия сохранена: ${b.file} (${fmtSize(b.size)}).`);
      send('backups', { dir });
    }
  } catch (e) {
    current = null;
    setState('stopped');
    throw e;
  }

  lastStart = { type, version, loader, ramGb, javaPath, eula: false };
  resetIssues(dir, {
    type,
    version,
    port: core.readProps(dir)['server-port'],
    ip: core.readProps(dir)['server-ip'],
    ramGb: ram,
    javaMajor: java.major,
    modded: isModded(type),
  });
  setState('starting');
  const what = `${type} ${version}${inst.loader && isModded(type) ? ' (загрузчик ' + inst.loader + ')' : ''}`;
  log(`Запускаю ${what}, память ${ram} ГБ, ${java.text}…`);
  const args = [
    `-Xms${Math.min(ram, 1)}G`,
    `-Xmx${java.bits === 32 ? 1 : ram}G`,
    '-Djava.net.useSystemProxies=true',
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    ...inst.args,
    'nogui',
  ];
  child = spawn(java.path, args, { cwd: dir, windowsHide: true });
  const proc = child;
  startedAt = Date.now();
  lastBackupAt = Date.now();
  online = new Set();
  maxPlayers = Number(core.readProps(dir)['max-players']) || 20;
  sendPlayers();
  stopMonitor = startMonitor(proc.pid, (s) => send('stats', { ...s, ramGb: java.bits === 32 ? 1 : ram, players: online.size, uptime: Date.now() - startedAt }));

  const pipe = (stream, kind) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (data) => {
      buf += data;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const raw of lines) {
        const line = cleanLine(raw);
        if (!line && raw.trim()) continue;
        if (state === 'starting' && /Done \(/.test(line)) setState('running');
        send('log', { text: line, kind });
        addLogLine(line);
      }
    });
    stream.on('end', () => {
      if (!buf) return;
      const line = cleanLine(buf);
      send('log', { text: line, kind });
      addLogLine(line);
    });
  };
  pipe(proc.stdout, 'server');
  pipe(proc.stderr, 'error');

  proc.on('error', (e) => log(`Не удалось запустить Java: ${e.message}`, 'error'));
  proc.on('close', (code) => {
    if (child !== proc) return;
    clearTimeout(killTimer);
    const stoppedByUser = state === 'stopping';
    child = null;
    current = null;
    stopMonitor();
    stopMonitor = () => {};
    online = new Set();
    sendPlayers();
    for (const w of logWaiters.splice(0)) w.reject(new Error('Сервер остановился'));
    log(`Сервер остановлен (код ${code === null ? '—' : code}).`, code ? 'error' : 'info');
    // Остановился сам с ошибкой — объясняем, что случилось.
    if (code && !stoppedByUser) {
      const found = flushIssues();
      if (!found) addIssue(diagnose.unknownCrash(code, issueCtx));
      log('Объяснение ошибки — в подсказках над консолью.', 'error');
    } else {
      flushIssues();
    }
    const ranMs = runningSince ? Date.now() - runningSince : 0;
    runningSince = 0;
    setState('stopped');
    onStopped({ dir, type, version, code, stoppedByUser });
    if (installUpdateAfterStop) {
      installUpdateAfterStop = false;
      updater.install();
    } else if (quitting) {
      closeUpnp().finally(() => app.quit());
    } else if (restartPending && lastStart) {
      restartPending = false;
      log('Перезапускаю сервер…');
      startServer(lastStart).catch((e) => log(e.message, 'error'));
    } else if (code && !stoppedByUser) {
      scheduleCrashRestart(dir, ranMs, code);
    }
    restartPending = false;
  });
}

// ---- объяснение ошибок ----

const MAX_LOG = 5000;
let logLines = []; // журнал текущего запуска — для разбора и «Скопировать журнал»
let scanned = 0;
let issueKeys = new Set();
let issueDir = null; // папка сервера, к которому относятся подсказки
let issueCtx = {};
let scanTimer = null;

function resetIssues(dir, ctx) {
  logLines = [];
  scanned = 0;
  issueKeys = new Set();
  issueDir = dir;
  issueCtx = ctx;
  clearTimeout(scanTimer);
  send('issues:clear', {});
}

function addIssue(issue) {
  if (issueKeys.has(issue.key)) return false;
  issueKeys.add(issue.key);
  send('issue', issue);
  return true;
}

/** Проверяет новые строки журнала; возвращает true, если найдена хоть одна ошибка. */
function flushIssues() {
  clearTimeout(scanTimer);
  scanTimer = null;
  let error = false;
  for (const issue of diagnose.diagnose(logLines, scanned, issueCtx)) {
    addIssue(issue);
  }
  scanned = logLines.length;
  for (const k of issueKeys) if (!/^(lag|crash-report):/.test(k)) error = true;
  return error;
}

/** Размер файла по-человечески: «850 КБ», «1,2 МБ». */
const fmtSize = (b) => (b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1).replace(".", ",") + " МБ" : Math.max(1, Math.round(b / 1024)) + " КБ");

// ---- игроки онлайн, ожидание строк журнала ----

let online = new Set();
let maxPlayers = 20;
let startedAt = 0;
let stopMonitor = () => {};
const logWaiters = []; // { re, resolve, reject, timer }

function sendPlayers() {
  send('players', { online: [...online], max: maxPlayers, running: !!child, server: current });
}

/** Дождаться строки журнала, подходящей под re (например, «Saved the game»). */
function waitForLog(re, ms) {
  return new Promise((resolve, reject) => {
    const w = { re, resolve, reject };
    w.timer = setTimeout(() => {
      const i = logWaiters.indexOf(w);
      if (i >= 0) logWaiters.splice(i, 1);
      reject(new Error('Сервер не ответил'));
    }, ms);
    logWaiters.push(w);
  });
}

function addLogLine(line) {
  const ev = players.parseLine(line);
  if (ev) {
    if (ev.join && !online.has(ev.join)) onPlayer(ev.join, true);
    if (ev.leave && online.has(ev.leave)) onPlayer(ev.leave, false);
    if (ev.join) online.add(ev.join);
    if (ev.leave) online.delete(ev.leave);
    if (ev.list) {
      online = new Set(ev.list.names);
      maxPlayers = ev.list.max;
    }
    sendPlayers();
  }
  for (let i = logWaiters.length - 1; i >= 0; i--) {
    const w = logWaiters[i];
    if (w.re.test(line)) {
      clearTimeout(w.timer);
      logWaiters.splice(i, 1);
      w.resolve(line);
    }
  }
  logLines.push(line);
  if (logLines.length > MAX_LOG) {
    const drop = logLines.length - MAX_LOG;
    logLines.splice(0, drop);
    scanned = Math.max(0, scanned - drop);
  }
  // Разбираем пачками: сервер пишет сотни строк в секунду.
  if (!scanTimer) scanTimer = setTimeout(flushIssues, 400);
}

function stopServer() {
  if (!child || state === 'stopping') return;
  setState('stopping');
  log('Останавливаю сервер, мир сохраняется…');
  try {
    child.stdin.write('stop\n');
  } catch {
    /* процесс уже завершается */
  }
  const proc = child;
  killTimer = setTimeout(() => {
    if (child === proc) {
      log('Сервер не ответил за 60 секунд — завершаю принудительно.', 'error');
      proc.kill();
    }
  }, 60000);
}

const handle = (channel, fn) =>
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      return { ok: true, data: await fn(arg || {}) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

handle('versions:list', ({ type, includePre }) => core.listVersions(type, !!includePre));
handle('loaders:list', ({ type, version }) => core.listLoaders(type, version));
handle('java:list', async ({ refresh }) =>
  (await core.findJavas(!!refresh)).map(({ path: p, major, bits, text }) => ({ path: p, major, bits, text }))
);
let javaInstalling = false;
handle('java:install', async ({ need }) => {
  if (javaInstalling) throw new Error('Java уже устанавливается');
  javaInstalling = true;
  const major = core.javaToInstall(Number(need) || null);
  let lastSent = 0;
  try {
    const exe = await core.installJava(major, {
      onLog: (text) => send('java:progress', { text }),
      onProgress: (done, total) => {
        const now = Date.now();
        if (now - lastSent > 150 || done === total) {
          lastSent = now;
          send('java:progress', { done, total });
        }
      },
    });
    return { major, exe };
  } finally {
    javaInstalling = false;
  }
});
// ---- резервные копии и расписание ----

let lastBackupAt = 0;
let backupBusy = false;
let lastRestartKey = '';
const warned = new Set();
const isCurrent = (type, version) => !!current && current.type === type && current.version === version;
const runCmd = (text) => {
  if (child) child.stdin.write(text + '\n');
};

/** Копия мира; если сервер работает — сначала просим его всё сохранить и временно не писать на диск. */
async function makeBackup(dir, reason, running) {
  if (backupBusy) throw new Error('Копия уже делается');
  backupBusy = true;
  try {
    if (running) {
      runCmd('save-off');
      runCmd('save-all flush');
      await waitForLog(/Saved the game|Saved the world|ThreadedAnvilChunkStorage.*All chunks are saved/i, 60000).catch(() => {
        log('Сервер не подтвердил сохранение — копия может отстать на несколько секунд.', 'error');
      });
    }
    log(`Делаю резервную копию мира (${backup.REASONS[reason]})…`);
    const b = await backup.create(dir, reason);
    if (b) log(`Копия сохранена: ${b.file} (${fmtSize(b.size)}).`);
    else log('Мира ещё нет — копировать нечего.');
    lastBackupAt = Date.now();
    send('backups', { dir });
    return b;
  } finally {
    if (running) runCmd('save-on');
    backupBusy = false;
  }
}

// Раз в 15 секунд: копии по расписанию и ежедневный перезапуск.
setInterval(() => {
  if (!child || state !== 'running' || !current) return;
  const dir = serverDir(current.type, current.version);
  const s = backup.readSettings(dir);
  if (s.backup.everyHours > 0 && !backupBusy && Date.now() - lastBackupAt >= s.backup.everyHours * 3600 * 1000) {
    makeBackup(dir, 'schedule', true).catch((e) => log(e.message, 'error'));
  }
  if (!s.restart.enabled) return;
  const [h, m] = s.restart.time.split(':').map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  const key = target.toDateString() + s.restart.time;
  const left = target - now;
  if (lastRestartKey === key || startedAt > target.getTime() - 60 * 1000) return;
  if (left <= 5 * 60 * 1000 && left > 60 * 1000 && !warned.has(key + '5')) {
    warned.add(key + '5');
    const mins = Math.ceil(left / 60000);
    runCmd(`say Сервер перезапустится через ${mins} ${mins === 5 ? 'минут' : 'минуты'}`);
  } else if (left <= 60 * 1000 && left > 0 && !warned.has(key + '1')) {
    warned.add(key + '1');
    runCmd('say Сервер перезапустится через 1 минуту');
  } else if (left <= 0 && left > -3 * 60 * 1000) {
    lastRestartKey = key;
    log(`Плановый перезапуск (${s.restart.time})…`);
    restartPending = true;
    stopServer();
  }
}, 15000);

handle('maint:get', ({ type, version }) => {
  const dir = serverDir(type, version);
  return { settings: backup.readSettings(dir), backups: backup.list(dir), hasWorld: backup.worldDirs(dir).length > 0 };
});
handle('maint:set', ({ type, version, settings }) => backup.writeSettings(serverDir(type, version), settings || {}));
handle('backup:create', ({ type, version }) => makeBackup(serverDir(type, version), 'manual', isCurrent(type, version) && state === 'running'));
handle('backup:restore', async ({ type, version, file }) => {
  if (isCurrent(type, version)) throw new Error('Остановите сервер перед восстановлением мира');
  const dir = serverDir(type, version);
  const r = await backup.restore(dir, file);
  send('backups', { dir });
  return r;
});
handle('backup:delete', async ({ type, version, file }) => {
  await shell.trashItem(backup.backupPath(serverDir(type, version), file));
});
handle('backup:reveal', ({ type, version, file }) => {
  const dir = serverDir(type, version);
  if (file) shell.showItemInFolder(backup.backupPath(dir, file));
  else {
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    shell.openPath(path.join(dir, 'backups'));
  }
});

// ---- игроки ----

handle('players:get', ({ type, version }) => {
  const dir = serverDir(type, version);
  const props = core.readProps(dir);
  return {
    lists: players.readLists(dir),
    online: isCurrent(type, version) ? [...online] : [],
    max: Number(props['max-players']) || 20,
    running: isCurrent(type, version) && state === 'running',
    whitelistOn: props['white-list'] === 'true',
    onlineMode: props['online-mode'] !== 'false',
  };
});
handle('players:action', async ({ type, version, list, action, value, reason }) => {
  const dir = serverDir(type, version);
  const v = String(value || '').trim();
  const live = isCurrent(type, version) && state === 'running';
  if (list === 'kick') {
    if (!live) throw new Error('Сервер не запущен');
    if (!players.NAME_RE.test(v)) throw new Error('Некорректный ник');
    runCmd(`kick ${v}${reason ? ' ' + String(reason).replace(/[\r\n]/g, ' ').slice(0, 200) : ''}`);
    return { live };
  }
  if (list === 'whitelist-toggle') {
    const on = action === 'on';
    if (live) runCmd(`whitelist ${on ? 'on' : 'off'}`);
    core.writeProps(dir, { 'white-list': on ? 'true' : 'false', 'enforce-whitelist': on ? 'true' : 'false' });
    return { live };
  }
  if (live) {
    runCmd(players.commandFor(list, action, v, reason));
    await new Promise((r) => setTimeout(r, 1200)); // сервер сразу записывает файл
    return { live };
  }
  await players.editOffline(dir, list, action, v, { reason, onlineMode: core.readProps(dir)['online-mode'] !== 'false' });
  return { live };
});

// ---- сервер из сборки .mrpack ----

let pendingPack = null;
handle('mrpack:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Сборка Modrinth для сервера',
    filters: [{ name: 'Сборка Modrinth', extensions: ['mrpack'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  mrpack.cleanup(pendingPack);
  pendingPack = await mrpack.read(r.filePaths[0]);
  const p = pendingPack;
  const dir = serverDir(p.type, p.mc);
  const hasMods = fs.existsSync(path.join(dir, 'mods')) && fs.readdirSync(path.join(dir, 'mods')).length > 0;
  return {
    name: p.name, packVersion: p.packVersion, mc: p.mc, type: p.type, loader: p.loader,
    mods: p.files.length, skipped: p.skipped.length, bad: p.bad.length, checked: p.checked,
    exists: !!core.readInstall(dir) || hasMods, hasMods,
  };
});
handle('mrpack:cancel', () => {
  mrpack.cleanup(pendingPack);
  pendingPack = null;
});
handle('mrpack:apply', async () => {
  const p = pendingPack;
  if (!p) throw new Error('Сначала выберите файл сборки');
  if (isCurrent(p.type, p.mc)) throw new Error('Остановите сервер этой версии перед установкой сборки');
  pendingPack = null;
  const dir = serverDir(p.type, p.mc);
  if (backup.worldDirs(dir).length) await backup.create(dir, 'before-pack');
  log(`Ставлю сборку «${p.name}»: ${p.files.length} модов для сервера…`);
  const r = await mrpack.apply(p, dir, {
    onLog: (t) => log(t),
    onProgress: (done, total) => send('progress', { got: done, total }),
  });
  log(`Сборка установлена. Осталось нажать «Запустить» — лаунчер поставит ${p.type} ${p.loader} для Minecraft ${p.mc}.`);
  return { type: p.type, mc: p.mc, loader: p.loader, ...r };
});

// ---- события сервера: уведомления, Discord, порт на роутере, перезапуск после падения ----

const TYPE_SHORT = {
  vanilla: 'Minecraft', paper: 'Paper', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge',
  youer: 'Youer', arclight: 'Arclight', mohist: 'Mohist',
};
const ICON = path.join(__dirname, 'build', 'icon.png');
const discord = createDiscord((url, opts) => net.fetch(url, opts), core.UA);
let runningSince = 0;
let upnpState = null; // { port, externalIp } — порт, открытый на роутере
let quitRequested = false;
let tray = null;
let trayHinted = false;

const PREF_DEFAULTS = { tray: true, notify: { started: true, players: true, crash: true } };
function prefs() {
  const p = readUi().prefs || {};
  return { tray: p.tray ?? PREF_DEFAULTS.tray, notify: { ...PREF_DEFAULTS.notify, ...(p.notify || {}) } };
}

function serverTitle(type, version) {
  try {
    return backup.readSettings(serverDir(type, version)).name || `${TYPE_SHORT[type] || type} ${version}`;
  } catch {
    return `${type} ${version}`;
  }
}
const currentSettings = () => (current ? backup.readSettings(serverDir(current.type, current.version)) : null);

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Уведомление Windows. always — показать, даже если такие уведомления выключены. */
function notify(title, body, always = false, kind = null) {
  if (!always && kind && !prefs().notify[kind]) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: kind === 'players' });
  n.on('click', showWindow);
  n.show();
}

// ---- значок в трее ----

function trayMenu() {
  const busy = state !== 'stopped' && current;
  const tip = busy
    ? `${serverTitle(current.type, current.version)} — ${state === 'running' ? `работает, игроков: ${online.size}` : 'запускается…'}`
    : 'Сервер не запущен';
  tray.setToolTip(`Лаунчер сервера Minecraft\n${tip}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть лаунчер', click: showWindow },
      { label: tip, enabled: false },
      { type: 'separator' },
      { label: 'Остановить сервер', enabled: !!child && state !== 'stopping', click: () => stopServer() },
      { label: 'Выйти', click: () => app.quit() },
    ])
  );
}
function ensureTray() {
  if (tray) return trayMenu();
  const img = nativeImage.createFromPath(ICON);
  tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  trayMenu();
}

// ---- порт на роутере ----

async function openUpnp(port) {
  try {
    const r = await upnp.openPort(port, 'Minecraft server (MC Server Launcher)');
    upnpState = { port, externalIp: r.externalIp };
    if (r.externalIp && upnp.isPrivateIp(r.externalIp)) {
      log(`Порт ${port} открыт на роутере, но у роутера «серый» адрес ${r.externalIp}: провайдер не даёт внешний IP, из интернета сервер всё равно не будет виден.`, 'error');
    } else {
      log(`Порт ${port} открыт на роутере${r.externalIp ? ` — адрес для друзей из интернета: ${r.externalIp}${port === 25565 ? '' : ':' + port}` : ''}.`);
    }
    send('net', { upnp: upnpState });
    return upnpState;
  } catch (e) {
    log(`Не удалось открыть порт на роутере: ${e.message}.`, 'error');
    throw e;
  }
}
function closeUpnp() {
  if (!upnpState) return Promise.resolve();
  const port = upnpState.port;
  upnpState = null;
  send('net', { upnp: null });
  return Promise.race([upnp.closePort(port).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

// ---- реакция на состояние ----

function onState(next) {
  if (tray) trayMenu();
  if (next === 'running' && current) {
    runningSince = Date.now();
    const { type, version } = current;
    const title = serverTitle(type, version);
    const s = currentSettings();
    notify('Сервер запущен', `«${title}» готов — можно заходить.`, false, 'started');
    if (s.discord.url && s.discord.start) discord.send(s.discord.url, `🟢 Сервер **${escapeMd(title)}** запущен (Minecraft ${version}).`);
    if (s.net.upnp) openUpnp(Number(core.readProps(serverDir(type, version))['server-port']) || 25565).catch(() => {});
  }
}

function onPlayer(name, joined) {
  if (!current) return;
  if (tray) setTimeout(trayMenu, 0);
  const s = currentSettings();
  if (!win || !win.isVisible() || !win.isFocused()) {
    notify(joined ? `${name} зашёл на сервер` : `${name} вышел с сервера`, serverTitle(current.type, current.version), false, 'players');
  }
  if (s.discord.url && s.discord.players) {
    discord.send(s.discord.url, joined ? `➡️ **${escapeMd(name)}** зашёл на сервер` : `⬅️ ${escapeMd(name)} вышел с сервера`);
  }
}

function onStopped({ dir, type, version, code, stoppedByUser }) {
  closeUpnp();
  const s = backup.readSettings(dir);
  const title = serverTitle(type, version);
  if (code && !stoppedByUser) {
    notify('Сервер упал', `«${title}» остановился с ошибкой. Объяснение — в лаунчере.`, false, 'crash');
    if (s.discord.url && s.discord.crash) discord.send(s.discord.url, `⚠️ Сервер **${escapeMd(title)}** упал (код ${code}).`);
  } else if (s.discord.url && s.discord.start) {
    discord.send(s.discord.url, `🔴 Сервер **${escapeMd(title)}** остановлен.`);
  }
}

// ---- перезапуск после падения ----

const crashTimes = [];
let crashTimer = null;

function scheduleCrashRestart(dir, ranMs, code) {
  const s = backup.readSettings(dir);
  if (!s.restart.onCrash || !lastStart) return;
  if (ranMs < 60 * 1000) {
    log('Сервер упал во время запуска — перезапускать автоматически не буду: скорее всего, дело в модах или настройках.', 'error');
    return;
  }
  const now = Date.now();
  while (crashTimes.length && now - crashTimes[0] > 30 * 60 * 1000) crashTimes.shift();
  if (crashTimes.length >= 3) {
    log('Сервер упал 3 раза за полчаса — автоматический перезапуск выключен до следующего запуска вручную.', 'error');
    return;
  }
  crashTimes.push(now);
  log(`Сервер упал (код ${code}) — перезапущу через 10 секунд. Чтобы отменить, нажмите «Запустить» или выключите это во вкладке «Обслуживание».`, 'error');
  const opts = lastStart;
  crashTimer = setTimeout(() => {
    crashTimer = null;
    if (state !== 'stopped') return;
    log('Перезапускаю сервер после падения…');
    startServer(opts).catch((e) => log(e.message, 'error'));
  }, 10000);
}
function cancelCrashRestart(resetCount) {
  clearTimeout(crashTimer);
  crashTimer = null;
  if (resetCount) crashTimes.length = 0;
}

// ---- настройки лаунчера ----

handle('ui:getPrefs', () => prefs());
handle('ui:setPrefs', (input) => {
  const cur = prefs();
  const next = {
    tray: !!(input.tray ?? cur.tray),
    notify: {
      started: !!((input.notify || {}).started ?? cur.notify.started),
      players: !!((input.notify || {}).players ?? cur.notify.players),
      crash: !!((input.notify || {}).crash ?? cur.notify.crash),
    },
  };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(UI_FILE(), JSON.stringify({ ...readUi(), prefs: next }), 'utf8');
  if (!next.tray && tray) {
    tray.destroy();
    tray = null;
  }
  return next;
});

// ---- серверы целиком: удалить, перенести на другую версию ----

const needStopped = (type, version, what) => {
  if (isCurrent(type, version) && state !== 'stopped') throw new Error(`Остановите сервер, чтобы ${what}`);
};

handle('server:delete', async ({ type, version }) => {
  needStopped(type, version, 'удалить его');
  const dir = serverDir(type, version);
  if (!fs.existsSync(dir)) return;
  await shell.trashItem(dir);
});

handle('server:upgrade', ({ type, version, to }) => {
  core.checkArgs(type, to);
  needStopped(type, version, 'перенести мир');
  return servers.copyForUpgrade(serverDir(type, version), serverDir(type, to), type);
});

// ---- миры ----

const savesDir = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft', 'saves');

handle('world:saves', () => servers.listSaves(savesDir()));
handle('world:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Папка мира Minecraft (внутри есть level.dat)',
    defaultPath: fs.existsSync(savesDir()) ? savesDir() : os.homedir(),
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const info = servers.saveInfo(r.filePaths[0]);
  if (!info) throw new Error('В этой папке нет мира Minecraft (не найден level.dat)');
  return info;
});
handle('world:import', async ({ type, version, src }) => {
  needStopped(type, version, 'заменить мир');
  const dir = serverDir(type, version);
  if (!servers.saveInfo(String(src))) throw new Error('В этой папке нет мира Minecraft (не найден level.dat)');
  if (backup.worldDirs(dir).length) await makeBackup(dir, 'before-import', false);
  const r = servers.importWorld(dir, String(src), core.readProps(dir)['level-name'] || 'world');
  log(`Мир «${r.name}» перенесён на сервер.`);
  send('backups', { dir });
  return r;
});
handle('world:setup', ({ type, version, seed, levelType }) => {
  const dir = serverDir(type, version);
  if (backup.worldDirs(dir).length) throw new Error('Мир уже создан — сид и тип мира меняются только для нового мира');
  core.writeProps(dir, { 'level-seed': String(seed || ''), 'level-type': servers.levelTypeValue(version, levelType || 'normal') });
});

// ---- доступ из интернета ----

async function getJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': core.UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

handle('net:check', async ({ type, version }) => {
  if (!isCurrent(type, version) || state !== 'running') throw new Error('Проверить можно только работающий сервер — сначала запустите его');
  const props = core.readProps(serverDir(type, version));
  if (props['server-ip']) throw new Error('Сервер привязан к одному адресу (вкладка «Настройки» → IP сервера) — из интернета он не виден');
  const port = Number(props['server-port']) || 25565;
  let publicIp;
  try {
    publicIp = (await getJson('https://api.ipify.org?format=json')).ip;
  } catch {
    throw new Error('Не удалось узнать внешний адрес — проверьте подключение к интернету');
  }
  const out = { port, publicIp, upnp: upnpState, cgnat: false, reachable: false };
  if (upnpState && upnpState.externalIp && (upnp.isPrivateIp(upnpState.externalIp) || upnpState.externalIp !== publicIp)) out.cgnat = true;
  try {
    const j = await getJson(`https://api.mcsrvstat.us/3/${encodeURIComponent(publicIp)}:${port}`);
    out.reachable = !!j.online;
  } catch {
    throw new Error('Сервис проверки (mcsrvstat.us) не ответил — попробуйте через минуту');
  }
  return out;
});

handle('net:upnp', async ({ type, version, on }) => {
  const dir = serverDir(type, version);
  backup.writeSettings(dir, { net: { upnp: !!on } });
  const live = isCurrent(type, version) && state === 'running';
  if (on && live && !upnpState) return { upnp: await openUpnp(Number(core.readProps(dir)['server-port']) || 25565) };
  if (!on && upnpState) await closeUpnp();
  return { upnp: upnpState };
});

// ---- Discord ----

handle('discord:test', async ({ type, version, url }) => {
  const dir = serverDir(type, version);
  const s = backup.writeSettings(dir, { discord: { url } }); // заодно проверяет адрес
  if (!s.discord.url) throw new Error('Вставьте адрес вебхука');
  await discord.test(s.discord.url, `✅ Лаунчер подключён: сюда будут приходить сообщения о сервере **${escapeMd(serverTitle(type, version))}**.`);
  return s;
});

// ---- карта мира (BlueMap) ----

function bluemapInfo(type, dir) {
  const jar = (sub) => {
    try {
      return fs.readdirSync(path.join(dir, sub)).some((f) => /^bluemap.*\.jar$/i.test(f));
    } catch {
      return false;
    }
  };
  const installed = jar('mods') || jar('plugins');
  const confDir = [path.join(dir, 'plugins', 'BlueMap'), path.join(dir, 'config', 'bluemap')].find((d) => fs.existsSync(path.join(d, 'core.conf')));
  let accepted = false;
  let port = 8100;
  if (confDir) {
    accepted = /^\s*accept-download\s*:\s*true/m.test(fs.readFileSync(path.join(confDir, 'core.conf'), 'utf8'));
    try {
      const m = fs.readFileSync(path.join(confDir, 'webserver.conf'), 'utf8').match(/^\s*port\s*:\s*(\d+)/m);
      if (m) port = Number(m[1]);
    } catch {
      /* настройки веб-сервера по умолчанию */
    }
  }
  return { supported: type !== 'vanilla', installed, configured: !!confDir, confDir, accepted, port };
}

handle('map:get', ({ type, version }) => {
  const { confDir, ...rest } = bluemapInfo(type, serverDir(type, version));
  return rest;
});
// Вызывается только по галочке пользователя: BlueMap скачивает файлы игры с серверов Mojang.
handle('map:accept', ({ type, version }) => {
  const info = bluemapInfo(type, serverDir(type, version));
  if (!info.confDir) throw new Error('Запустите сервер один раз — BlueMap создаст свои настройки');
  const file = path.join(info.confDir, 'core.conf');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/^(\s*accept-download\s*:\s*)false/m, '$1true'), 'utf8');
  return { ...info, accepted: true, confDir: undefined };
});
handle('map:open', ({ type, version }) => {
  const { port } = bluemapInfo(type, serverDir(type, version));
  return shell.openExternal(`http://localhost:${port}`);
});

// ---- оформление: светлая, тёмная или как в Windows ----

const UI_FILE = () => path.join(app.getPath('userData'), 'ui.json');
function readUi() {
  try {
    return JSON.parse(fs.readFileSync(UI_FILE(), 'utf8')) || {};
  } catch {
    return {};
  }
}
const themeBackground = () => (nativeTheme.shouldUseDarkColors ? '#15171b' : '#f6f4ef');
// Тема задаётся до создания окна — так страница сразу открывается в нужных цветах, без вспышки.
nativeTheme.themeSource = ['light', 'dark', 'system'].includes(readUi().theme) ? readUi().theme : 'system';
handle('ui:getTheme', () => nativeTheme.themeSource);
handle('ui:setTheme', ({ theme }) => {
  if (!['light', 'dark', 'system'].includes(theme)) throw new Error('Неизвестная тема');
  nativeTheme.themeSource = theme;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(UI_FILE(), JSON.stringify({ ...readUi(), theme }), 'utf8');
  if (win) win.setBackgroundColor(themeBackground());
  return theme;
});

// ---- список серверов: все папки вида <тип>-<версия> ----

handle('servers:list', () => {
  let dirs = [];
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const n of dirs) {
    const m = n.match(/^([a-z]+)-(.+)$/);
    if (!m || !core.TYPES.includes(m[1])) continue;
    try {
      core.checkArgs(m[1], m[2]);
    } catch {
      continue;
    }
    const dir = path.join(ROOT, n);
    const installed = !!core.readInstall(dir);
    if (!installed && !backup.worldDirs(dir).length && !fs.existsSync(path.join(dir, 'mods'))) continue;
    let packName = null;
    try {
      packName = JSON.parse(fs.readFileSync(path.join(dir, 'mcl-pack.json'), 'utf8')).name || null;
    } catch {
      /* не из сборки */
    }
    let lastPlayed = null;
    try {
      lastPlayed = fs.statSync(path.join(dir, 'logs', 'latest.log')).mtimeMs;
    } catch {
      /* ещё не запускался */
    }
    out.push({
      type: m[1],
      version: m[2],
      name: backup.readSettings(dir).name || packName || null,
      installed,
      running: isCurrent(m[1], m[2]) && state !== 'stopped',
      lastPlayed,
    });
  }
  return out.sort((a, b) => Number(b.running) - Number(a.running) || (b.lastPlayed || 0) - (a.lastPlayed || 0));
});

handle('net:addresses', () => localAddresses());
handle('app:info', () => ({ root: ROOT, addresses: localAddresses(), state, current, memory: memoryInfo() }));
handle('server:info', async ({ type, version }) => {
  const dir = serverDir(type, version);
  const inst = core.readInstall(dir);
  return {
    dir,
    installed: !!inst,
    installedLoader: inst ? inst.loader || null : null,
    packLoader: mrpack.packLoader(dir),
    eula: core.eulaAccepted(dir),
    props: core.readProps(dir),
    javaNeeded: await core.requiredJava(version),
    kinds: mods.kindsFor(type),
    flavor: core.hybridFlavor(type, inst && inst.loader),
  };
});
handle('server:start', (opts) => {
  cancelCrashRestart(true);
  return startServer(opts);
});
handle('server:stop', () => {
  cancelCrashRestart(false);
  restartPending = false;
  stopServer();
});
handle('server:restart', () => {
  if (!child || state !== 'running') throw new Error('Сервер не запущен');
  restartPending = true;
  stopServer();
});
handle('server:command', ({ text }) => {
  const line = String(text || '').replace(/[\r\n]/g, ' ').trim();
  if (!line) return;
  if (!child || state === 'stopped') throw new Error('Сервер не запущен');
  child.stdin.write(line + '\n');
  send('log', { text: '> ' + line, kind: 'input' });
});
handle('props:save', ({ type, version, values }) => {
  core.writeProps(serverDir(type, version), values || {});
});

/** Загрузчик модов гибрида: по установленной сборке, а если её нет — по выбранной. */
function flavorFor(type, version, loader) {
  const inst = core.readInstall(serverDir(type, version));
  return core.hybridFlavor(type, (inst && inst.loader) || loader);
}

handle('mods:search', ({ type, version, query, offset, kind, loader }) => {
  core.checkArgs(type, version);
  return mods.search({ type, mc: version, query, offset, kind, flavor: flavorFor(type, version, loader) });
});
handle('mods:list', ({ type, version, kind }) => mods.listInstalled(type, serverDir(type, version), kind));
handle('mods:install', async ({ type, version, projectId, kind, loader, bySlug }) => {
  if (modBusy) throw new Error('Дождитесь окончания предыдущей установки');
  modBusy = true;
  try {
    const dir = serverDir(type, version);
    const flavor = flavorFor(type, version, loader);
    const added = await mods.installProject({ type, mc: version, dir, projectId, kind, flavor, onLog: log, bySlug: !!bySlug });
    if (added.length) {
      const running = current && current.type === type && current.version === version;
      log(`Установлено: ${added.join(', ')}.${running ? ' Перезапустите сервер, чтобы моды загрузились.' : ''}`);
    }
    return added;
  } finally {
    modBusy = false;
  }
});
// ---- сборка модов для игроков ----

const packCache = new Map(); // папка mods → { items, at }

handle('pack:analyze', async ({ type, version }) => {
  if (!mods.kindsFor(type).includes('mod')) {
    throw new Error(type === 'paper' ? 'На Paper игрокам ничего ставить не нужно — плагины работают только на сервере' : 'У этого сервера нет модов');
  }
  const dir = serverDir(type, version);
  const modsDir = path.join(dir, 'mods');
  const items = await pack.analyze(modsDir);
  packCache.set(modsDir, { items, at: Date.now() });
  const inst = core.readInstall(dir);
  const loader = await core.clientLoader(type, version, inst && inst.loader);
  // Варианты адреса для списка «Сетевая игра»: VPS и адреса компьютера.
  const props = core.readProps(dir);
  const portSuffix = props['server-port'] && props['server-port'] !== '25565' ? ':' + props['server-port'] : '';
  const addresses = [];
  try {
    if (vpsApi || safeStorage.isEncryptionAvailable()) {
      for (const v of vps().list()) addresses.push({ label: `VPS «${v.name}»`, address: v.host + portSuffix });
    }
  } catch {
    /* без VPS */
  }
  for (const a of localAddresses()) addresses.push({ label: `${a.name}${a.vpn ? ' (VPN)' : ''}`, address: a.address + portSuffix });
  return {
    items: items.map(({ sha512, ...rest }) => rest),
    loader,
    hasConfig: fs.existsSync(path.join(dir, 'config')),
    addresses,
    installed: !!inst,
  };
});

handle('pack:export', async ({ type, version, files, format, name, packVersion, address, includeConfig }) => {
  const dir = serverDir(type, version);
  const modsDir = path.join(dir, 'mods');
  let cached = packCache.get(modsDir);
  if (!cached || Date.now() - cached.at > 10 * 60 * 1000) {
    cached = { items: await pack.analyze(modsDir), at: Date.now() };
    packCache.set(modsDir, cached);
  }
  const wanted = new Set(Array.isArray(files) ? files : []);
  const items = cached.items.filter((i) => wanted.has(i.file));
  if (!items.length) throw new Error('Не выбран ни один мод');
  const fmt = format === 'zip' ? 'zip' : 'mrpack';
  const title = String(name || '').trim().slice(0, 80) || `Сервер ${version}`;
  const ver = /^[\w.+-]{1,32}$/.test(String(packVersion || '')) ? packVersion : '1.0.0';
  const addr = String(address || '').trim();
  if (addr && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(addr)) throw new Error('Адрес сервера указан неверно');

  const safe = title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'modpack';
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить сборку для игроков',
    defaultPath: path.join(app.getPath('desktop'), `${safe} ${ver}.${fmt}`),
    filters: fmt === 'zip' ? [{ name: 'Архив ZIP', extensions: ['zip'] }] : [{ name: 'Сборка Modrinth', extensions: ['mrpack'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const inst = core.readInstall(dir);
  const res = pack.build({
    format: fmt,
    items,
    modsDir,
    configDir: path.join(dir, 'config'),
    includeConfig: !!includeConfig,
    name: title,
    packVersion: ver,
    mc: version,
    loader: await core.clientLoader(type, version, inst && inst.loader),
    server: addr ? { name: title, address: addr } : null,
    outFile: r.filePath,
  });
  return { path: r.filePath, ...res };
});
handle('pack:reveal', ({ path: p }) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
});

handle('mods:checkUpdates', ({ type, version, kind, loader }) =>
  mods.checkUpdates({ type, mc: version, dir: serverDir(type, version), kind, flavor: flavorFor(type, version, loader) })
);
handle('mods:update', async ({ type, version, kind, loader, file }) => {
  if (isCurrent(type, version)) throw new Error('Остановите сервер, чтобы обновить моды и плагины: пока он работает, файлы заняты');
  return mods.updateFile({ type, mc: version, dir: serverDir(type, version), kind, flavor: flavorFor(type, version, loader), file, onLog: log });
});

handle('mods:remove', async ({ type, version, file, kind }) => {
  const dir = serverDir(type, version);
  const p = mods.modPath(type, dir, String(file || ''), kind);
  try {
    await shell.trashItem(p);
  } catch {
    const running = current && current.type === type && current.version === version;
    throw new Error(running ? 'Файл занят сервером — остановите сервер и попробуйте снова' : 'Не удалось удалить файл');
  }
  mods.forgetFile(type, dir, path.basename(p), kind);
});

handle('config:list', ({ type, version }) => configs.listConfigs(type, serverDir(type, version)));
handle('config:read', ({ type, version, rel }) => configs.readConfig(serverDir(type, version), rel));
handle('config:saveFields', ({ type, version, rel, changes, fileVersion }) =>
  configs.saveFields(serverDir(type, version), rel, changes, fileVersion)
);
handle('config:saveText', ({ type, version, rel, text, fileVersion }) =>
  configs.saveText(serverDir(type, version), rel, text, fileVersion)
);
handle('config:restore', ({ type, version, rel }) => configs.restoreBackup(serverDir(type, version), rel));
handle('config:open', async ({ type, version, rel }) => {
  const err = await shell.openPath(configs.resolveFile(serverDir(type, version), rel));
  if (err) throw new Error(err);
});

handle('open:folder', async ({ type, version, sub, kind }) => {
  let dir = type && version ? serverDir(type, version) : ROOT;
  if (sub) {
    const name = mods.contentDir(type, kind);
    if (!name) throw new Error('У этого типа сервера нет папки модов');
    dir = path.join(dir, name);
  }
  fs.mkdirSync(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
});
// ---- VPS ----

let vpsApi = null;
function vps() {
  if (!vpsApi) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows не даёт зашифровать пароль — сохранить VPS нельзя');
    }
    vpsApi = createVps({
      dataDir: app.getPath('userData'),
      // Пароли храним зашифрованными средствами Windows (DPAPI): прочитать их может только этот пользователь.
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
    });
  }
  return vpsApi;
}

handle('vps:list', () => vps().list());
handle('vps:save', (input) => vps().save(input));
handle('vps:remove', ({ id }) => vps().remove(id));
handle('vps:forgetKey', ({ id }) => vps().forgetHostKey(id));
handle('vps:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Файл приватного ключа SSH',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});
handle('vps:info', async ({ id, acceptFingerprint }) => {
  try {
    return await vps().info(id, acceptFingerprint);
  } catch (e) {
    // Ключ сервера — не ошибка, а вопрос пользователю.
    if (e instanceof HostKeyError) return { hostKey: { code: e.code, fingerprint: e.fingerprint, message: e.message } };
    throw e;
  }
});
handle('vps:transfer', async ({ id, type, version, name }) => {
  const dir = serverDir(type, version);
  const install = core.readInstall(dir);
  if (!install || !install.args) throw new Error('Сначала установите сервер на ПК: запустите его хотя бы раз');
  if (current && current.type === type && current.version === version) {
    throw new Error('Остановите сервер на ПК перед переносом — иначе мир скопируется наполовину сохранённым');
  }
  const send2 = (payload) => send('vps:progress', { id, ...payload });
  const res = await vps().transfer(
    id,
    {
      localDir: dir,
      name,
      install: { ...install, type, mc: version },
      need: await core.requiredJava(version),
      modded: isModded(type),
      port: core.readProps(dir)['server-port'],
    },
    (step) => send2({ step }),
    (done, total) => send2({ done, total })
  );
  return res;
});
handle('vps:start', ({ id, name, ramGb }) => vps().start(id, name, ramGb));
handle('vps:stop', ({ id, name }) => vps().stop(id, name));
handle('vps:command', ({ id, name, text }) => vps().command(id, name, text));
handle('vps:logOpen', ({ id, name }) => vps().openLog(id, name, (line) => send('vps:log', { id, name, line: cleanLine(line) })));
handle('vps:logClose', ({ id, name }) => vps().closeLog(id, name));
handle('vps:checkPort', ({ id, port }) => {
  const p = vps().get(id);
  return vps().checkPort(p.host, port || 25565);
});

handle('issue:copyLog', () => {
  const text = logLines.slice(-500).join('\n');
  if (!text) throw new Error('Журнал пуст — запустите сервер');
  clipboard.writeText(text);
  return Math.min(logLines.length, 500);
});
handle('issue:open', async ({ path: p }) => {
  if (!issueDir) throw new Error('Неизвестно, к какому серверу относится файл');
  const abs = path.resolve(issueDir, String(p || ''));
  if (!abs.startsWith(path.resolve(issueDir) + path.sep) || !fs.existsSync(abs)) {
    throw new Error('Файл отчёта не найден');
  }
  const err = await shell.openPath(abs);
  if (err) throw new Error(err);
});
handle('issue:logs', async () => {
  if (!issueDir) throw new Error('Сервер ещё не запускался');
  const dir = path.join(issueDir, 'logs');
  const err = await shell.openPath(fs.existsSync(dir) ? dir : issueDir);
  if (err) throw new Error(err);
});

handle('update:state', () => ({
  enabled: updater.enabled(),
  version: app.getVersion(),
  state: updater.getState(),
  whatsNew: whatsNewOnce(),
}));
handle('update:check', () => updater.check(true));
handle('update:download', () => updater.download());
handle('update:install', () => {
  // Сначала аккуратно останавливаем сервер, чтобы мир сохранился, потом ставим обновление.
  if (child) {
    installUpdateAfterStop = true;
    restartPending = false;
    log('Останавливаю сервер перед установкой обновления…');
    stopServer();
    return;
  }
  updater.install();
});

handle('open:eula', () => shell.openExternal(EULA_URL));
handle('open:java', ({ version }) => shell.openExternal(javaUrl(version)));
handle('open:mod', ({ slug, kind }) => {
  if (!SLUG_RE.test(String(slug))) throw new Error('Некорректная ссылка');
  return shell.openExternal(`https://modrinth.com/${kind === 'plugin' ? 'plugin' : 'mod'}/${slug}`);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: themeBackground(),
    autoHideMenuBar: true,
    title: 'Лаунчер сервера Minecraft',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    // Сервер работает — окно прячется в трей, сервер не останавливается.
    if (!quitRequested && child && prefs().tray) {
      e.preventDefault();
      win.hide();
      ensureTray();
      if (!trayHinted) {
        trayHinted = true;
        notify('Сервер продолжает работать', 'Лаунчер свёрнут в область уведомлений. Открыть его — значок рядом с часами.', true);
      }
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

// Одна копия лаунчера: вторая просто показывает уже открытое окно.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.setAppUserModelId('local.mcserverlauncher');
  app.whenReady().then(() => {
    createWindow();
    updater.init(send);
  });
}

// «Что нового» после обновления — отдаём окну только один раз.
let whatsNewValue;
function whatsNewOnce() {
  if (whatsNewValue === undefined) {
    whatsNewValue = app.isPackaged ? updater.whatsNew() : null;
    return whatsNewValue;
  }
  return null;
}

// При закрытии окна сначала аккуратно останавливаем сервер, чтобы мир сохранился.
app.on('before-quit', (e) => {
  quitRequested = true;
  if (child) {
    e.preventDefault();
    quitting = true;
    stopServer();
  }
});
app.on('window-all-closed', () => app.quit());
// Серверы на VPS продолжают работать — закрываем только SSH-соединения.
app.on('will-quit', () => vpsApi && vpsApi.shutdown());
