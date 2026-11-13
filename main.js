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
const probe = require('./lib/probe');
const report = require('./lib/report');
const bisect = require('./lib/bisect');
const mismatch = require('./lib/mismatch');
const recipe = require('./lib/recipe');
const { createDiscord, escapeMd } = require('./lib/discord');
const gamerules = require('./lib/gamerules');
const tps = require('./lib/tps');
const playtime = require('./lib/playtime');
const modcheck = require('./lib/modcheck');
const logsLib = require('./lib/logs');
const disk = require('./lib/disk');
const jvm = require('./lib/jvm');
const { createRemote } = require('./lib/remote');
const tar = require('tar');
const { createRunner, freePort } = require('./lib/runner');
const velocity = require('./lib/velocity');
const power = require('./lib/power');
const playercard = require('./lib/playercard');
const regions = require('./lib/regions');
const lag = require('./lib/lag');
const datapacks = require('./lib/datapacks');
const fun = require('./lib/fun');
const backupcheck = require('./lib/backupcheck');
const history = require('./lib/history');
const chat = require('./lib/chat');
const singleplayer = require('./lib/singleplayer');
const { createTelegram, parseCommand } = require('./lib/telegram');

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
let modTest = null; // идёт поиск сломанного мода: { dir, cancel }

const serverDir = (type, version) => {
  core.checkArgs(type, version);
  return path.join(ROOT, `${type}-${version}`);
};
const isModded = (type) => core.LOADER_TYPES.includes(type);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  widgetSend(channel, payload);
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
  if (modTest) throw new Error('Идёт поиск сломанного мода — дождитесь конца или отмените его');
  core.checkArgs(type, version, loader || undefined);
  if (sleeper) await sleepCancel(sleeper.type === type && sleeper.version === version);
  const dir = serverDir(type, version);
  if (runner.has(bgKey(type, version))) throw new Error('Этот сервер уже работает в фоне');
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
      // Обновление ядра или загрузчика: сначала копия мира — на случай, если новая сборка его не примет.
      const prev = core.readInstall(dir);
      if (prev && backup.worldDirs(dir).length) {
        log(`Обновляю ядро сервера${prev.loader ? ` (было ${prev.loader})` : ''} — сначала делаю копию мира…`);
        const b = await backup.create(dir, 'before-update');
        if (b) log(`Копия сохранена: ${b.file} (${fmtSize(b.size)}).`);
        send('backups', { dir });
      }
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
      if (b) mirrorBackup(dir, b.file);
      send('backups', { dir });
    }
  } catch (e) {
    current = null;
    setState('stopped');
    throw e;
  }

  lastStart = { type, version, loader, ramGb, javaPath, eula: false };
  saveLastStart(lastStart);
  tracker = playtime.createTracker(dir);
  lastTps = null;
  tpsFails = 0;
  if (runner.list().length) ensureFreePort(type, version, dir);
  resetIssues(dir, {
    type,
    version,
    port: core.readProps(dir)['server-port'],
    ip: core.readProps(dir)['server-ip'],
    ramGb: ram,
    javaMajor: java.major,
    modded: isModded(type),
  });
  const runSettings = backup.readSettings(dir);
  if (runSettings.clean.enabled) {
    const c = logsLib.clean(dir, runSettings.clean.days);
    if (c.files) log(`Автоочистка: удалено старых журналов и отчётов — ${c.files} (${fmtSize(c.bytes)}).`);
  }
  const aikar = runSettings.jvm.aikar && java.bits !== 32 && ram >= 2;
  setState('starting');
  const what = `${type} ${version}${inst.loader && isModded(type) ? ' (загрузчик ' + inst.loader + ')' : ''}`;
  log(`Запускаю ${what}, память ${ram} ГБ, ${java.text}…`);
  const args = [
    `-Xms${Math.min(ram, 1)}G`,
    `-Xmx${java.bits === 32 ? 1 : ram}G`,
    ...(aikar ? jvm.aikarFlags(ram) : []),
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
  hist = history.createHistory(dir);
  stopMonitor = startMonitor(proc.pid, (s) => {
    if (hist) hist.add({ players: online.size, tps: lastTps ? lastTps.tps : null, memMb: s.memMb, cpu: s.cpu });
    send('stats', { ...s, ramGb: java.bits === 32 ? 1 : ram, players: online.size, uptime: Date.now() - startedAt, tps: lastTps });
  });
  chatLines = [];
  gameActive = null;

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
        // Ответы на тихие запросы (поиск причин лагов, координаты игрока) — тоже.
        if (quietUntil > Date.now() && lag.REPLY_RE.test(line)) {
          quietLine(line);
          continue;
        }
        // Ответ на тихий запрос TPS — в консоль не показываем.
        if (tpsUntil > Date.now() && tps.isTpsLine(line)) {
          handleTpsLine(line);
          continue;
        }
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
  if (/ has (made the advancement|completed the challenge|reached the goal) \[/.test(line)) achLine(line);
  const said = chat.parseChat(line);
  if (said) addChat({ ...said, at: Date.now() });
  if (/chunky/i.test(line)) chunkyLine(line);
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
    if (b) mirrorBackup(dir, b.file);
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
  return openPack(r.filePaths[0]);
});

async function openPack(file) {
  mrpack.cleanup(pendingPack);
  pendingPack = await mrpack.read(file);
  const p = pendingPack;
  const dir = serverDir(p.type, p.mc);
  const hasMods = fs.existsSync(path.join(dir, 'mods')) && fs.readdirSync(path.join(dir, 'mods')).length > 0;
  return {
    name: p.name, packVersion: p.packVersion, mc: p.mc, type: p.type, loader: p.loader,
    mods: p.files.length, skipped: p.skipped.length, bad: p.bad.length, checked: p.checked,
    exists: !!core.readInstall(dir) || hasMods, hasMods,
  };
}
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
const discordRaw = createDiscord((url, opts) => net.fetch(url, opts), core.UA);
const discord = { ...discordRaw, send: (url, text) => discordRaw.send(url, T(text)), test: (url, text) => discordRaw.test(url, T(text)) };
let runningSince = 0;
let upnpState = null; // { port, externalIp } — порт, открытый на роутере
let quitRequested = false;
let tray = null;
let trayHinted = false;

const PREF_DEFAULTS = { tray: true, autostart: false, autoStartServer: false, gamePriority: true, notify: { started: true, players: true, crash: true } };
function prefs() {
  const p = readUi().prefs || {};
  return {
    tray: p.tray ?? PREF_DEFAULTS.tray,
    autostart: p.autostart ?? false,
    autoStartServer: p.autoStartServer ?? false,
    gamePriority: p.gamePriority ?? PREF_DEFAULTS.gamePriority,
    notify: { ...PREF_DEFAULTS.notify, ...(p.notify || {}) },
  };
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
// ---- язык интерфейса: русский или английский ----
// Тексты в коде русские; для английского перевод берётся из словаря renderer/i18n-en.js.
let langCache = null;
function uiLang() {
  if (langCache) return langCache;
  const l = readUi().lang;
  langCache = l === 'en' || l === 'ru' ? l : /^ru|^uk|^be|^kk/i.test(app.getLocale() || '') ? 'ru' : 'en';
  return langCache;
}
let trEn = null;
/** Перевести текст для показа (в трее, уведомлениях, Telegram), если выбран английский. */
function T(text) {
  if (uiLang() !== 'en' || typeof text !== 'string') return text;
  if (!trEn) trEn = require('./renderer/i18n').createTranslator(require('./renderer/i18n-en'));
  return trEn(text);
}
ipcMain.on('ui:lang', (e) => {
  e.returnValue = uiLang();
});
handle('ui:setLang', ({ lang }) => {
  if (!['ru', 'en'].includes(lang)) throw new Error('Неизвестный язык');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(UI_FILE(), JSON.stringify({ ...readUi(), lang }), 'utf8');
  langCache = lang;
  if (tray) trayMenu();
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.reload();
    if (widget && !widget.isDestroyed()) widget.reload();
  }, 50);
  return lang;
});
for (const fn of ['showSaveDialog', 'showOpenDialog']) {
  const orig = dialog[fn].bind(dialog);
  dialog[fn] = (w, opts = {}) => orig(w, { ...opts, title: T(opts.title), filters: (opts.filters || []).map((f) => ({ ...f, name: T(f.name) })) });
}

function notify(title, body, always = false, kind = null) {
  if (!always && kind && !prefs().notify[kind]) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: T(title), body: T(body), icon: ICON, silent: kind === 'players' });
  n.on('click', showWindow);
  n.show();
}

// ---- значок в трее ----

function trayMenu() {
  const busy = state !== 'stopped' && current;
  const tip = busy
    ? `${serverTitle(current.type, current.version)} — ${state === 'running' ? `работает, игроков: ${online.size}` : 'запускается…'}`
    : 'Сервер не запущен';
  tray.setToolTip(`${T('Блокхост')}\n${T(tip)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: T('Открыть лаунчер'), click: showWindow },
      { label: T('Мини-окно'), click: () => openWidget() },
      { label: T(tip), enabled: false },
      { type: 'separator' },
      { label: T('Остановить сервер'), enabled: !!child && state !== 'stopping', click: () => stopServer() },
      { label: T('Выйти'), click: () => app.quit() },
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
    const r = await upnp.openPort(port, 'Minecraft server (Blockhost)');
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
    msgSent.clear();
    chunky = null;
    const { type, version } = current;
    const title = serverTitle(type, version);
    const s = currentSettings();
    notify('Сервер запущен', `«${title}» готов — можно заходить.`, false, 'started');
    tgNotify('start', `🟢 Сервер «${title}» запущен (Minecraft ${version}).`);
    if (s.discord.url && s.discord.start) discord.send(s.discord.url, `🟢 Сервер **${escapeMd(title)}** запущен (Minecraft ${version}).`);
    if (s.net.upnp) openUpnp(Number(core.readProps(serverDir(type, version))['server-port']) || 25565).catch(() => {});
    if (applyGamerules(type, version)) log('Правила игры из лаунчера применены.');
    funResume();
    ipWatch(true);
    if (s.tunnel.auto && s.tunnel.address && fs.existsSync(PLAYIT_EXE()) && !playitProc) {
      startPlayit(false);
      playitAuto = true;
      log(`Туннель playit.gg запущен: ${s.tunnel.address}`);
    }
  }
}

function onPlayer(name, joined) {
  if (!current) return;
  achPlayer(name, joined);
  if (tracker) {
    if (joined) {
      tracker.join(name);
      welcome(name);
    }
    else tracker.leave(name);
  }
  if (tray) setTimeout(trayMenu, 0);
  const s = currentSettings();
  if (!win || !win.isVisible() || !win.isFocused()) {
    notify(joined ? `${name} зашёл на сервер` : `${name} вышел с сервера`, serverTitle(current.type, current.version), false, 'players');
  }
  tgNotify('players', joined ? `➡️ ${name} зашёл на сервер` : `⬅️ ${name} вышел с сервера`);
  if (s.discord.url && s.discord.players) {
    discord.send(s.discord.url, joined ? `➡️ **${escapeMd(name)}** зашёл на сервер` : `⬅️ ${escapeMd(name)} вышел с сервера`);
  }
}

function onStopped({ dir, type, version, code, stoppedByUser }) {
  const asleep = !!(sleeper && sleeper.pending && !code);
  if (!asleep) closeUpnp();
  ipWatch(false);
  if (tracker) tracker.closeAll();
  tracker = null;
  if (hist) hist.flush();
  hist = null;
  funStopTimers();
  joinAt.clear();
  lastTps = null;
  if (playitAuto && !asleep) stopPlayit();
  const s = backup.readSettings(dir);
  const title = serverTitle(type, version);
  if (code && !stoppedByUser) report.logCrash(dir);
  if (sleeper && sleeper.pending) {
    if (asleep) {
      sleeper.pending = false;
      sleepListen();
      tgNotify('start', `😴 «${title}» уснул: на нём никого не было. Проснётся, когда кто-то зайдёт.`);
      return;
    }
    sleeper = null;
  }
  if (code && !stoppedByUser) {
    notify('Сервер упал', `«${title}» остановился с ошибкой. Объяснение — в лаунчере.`, false, 'crash');
    tgNotify('crash', `⚠️ Сервер «${title}» упал (код ${code}).`);
    if (s.discord.url && s.discord.crash) discord.send(s.discord.url, `⚠️ Сервер **${escapeMd(title)}** упал (код ${code}).`);
  } else {
    tgNotify('start', `🔴 Сервер «${title}» остановлен.`);
    if (s.discord.url && s.discord.start) discord.send(s.discord.url, `🔴 Сервер **${escapeMd(title)}** остановлен.`);
  }
}

// ---- спящий сервер: никого нет — выключается, кто-то заходит — просыпается ----
// Пока сервер спит, порт слушает лаунчер (lib/probe.js): в списке серверов у игроков
// видно «сервер спит», а попытка войти будит его. Мир перед сном сохраняется обычной остановкой.

let sleeper = null; // { type, version, opts, port, probe, pending, since }
let idleSince = 0;

function sleepInfo() {
  return sleeper && !sleeper.pending ? { type: sleeper.type, version: sleeper.version, since: sleeper.since } : null;
}
function sleepTick() {
  if (state !== 'running' || !current || sleeper || modTest) return void (idleSince = 0);
  const dir = serverDir(current.type, current.version);
  const s = backup.readSettings(dir).sleep;
  const busy = online.size > 0 || backupBusy || (chunky && !chunky.done) || core.readProps(dir)['server-ip'];
  if (!s.enabled || busy) return void (idleSince = 0);
  if (!idleSince) idleSince = Date.now();
  if (Date.now() - idleSince < s.minutes * 60000) return;
  idleSince = 0;
  const { type, version } = current;
  sleeper = { type, version, opts: { ...lastStart, eula: false }, port: Number(core.readProps(dir)['server-port']) || 25565, probe: null, pending: true };
  log(`На сервере никого нет ${s.minutes} минут — сервер засыпает, чтобы не занимать память. Проснётся сам, когда кто-то попробует зайти.`);
  stopServer();
}
setInterval(sleepTick, 30000);

async function sleepListen() {
  const sl = sleeper;
  if (!sl) return;
  const title = serverTitle(sl.type, sl.version);
  try {
    sl.probe = await probe.start(sl.port, '0.0.0.0', {
      motd: `«${title}» спит — зайдите, чтобы разбудить`,
      kick: 'Сервер просыпается — зайдите снова через минуту',
      onLogin: () => wake(),
    });
    sl.since = Date.now();
    log(`Сервер спит. Лаунчер ждёт игроков на порту ${sl.port}.`);
  } catch (e) {
    log(`Не получилось ждать игроков на порту: ${e.message}. Сервер просто остановлен.`, 'error');
    if (sleeper === sl) sleeper = null;
    closeUpnp();
    if (playitAuto) stopPlayit();
  }
  send('sleep', sleepInfo());
  if (tray) trayMenu();
}
async function wake() {
  const sl = sleeper;
  if (!sl || sl.waking || sl.pending) return;
  sl.waking = true;
  if (sl.probe) await sl.probe.close();
  sleeper = null;
  send('sleep', null);
  log('Кто-то заходит — бужу сервер…');
  startServer(sl.opts).catch((e) => log(`Сервер не проснулся: ${e.message}`, 'error'));
}
/** Перестать спать. keepNet — сервер сейчас запустится сам (порт и туннель не трогаем). */
async function sleepCancel(keepNet) {
  const sl = sleeper;
  if (!sl) return;
  sleeper = null;
  if (sl.probe) await sl.probe.close();
  if (!keepNet) {
    await closeUpnp();
    if (playitAuto) stopPlayit();
    log('Сервер больше не спит: выключен.');
  }
  send('sleep', null);
  if (tray) trayMenu();
}
handle('sleep:get', () => sleepInfo());
handle('sleep:wake', () => wake());

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
    autostart: !!(input.autostart ?? cur.autostart),
    autoStartServer: !!(input.autoStartServer ?? cur.autoStartServer),
    gamePriority: !!(input.gamePriority ?? cur.gamePriority),
    notify: {
      started: !!((input.notify || {}).started ?? cur.notify.started),
      players: !!((input.notify || {}).players ?? cur.notify.players),
      crash: !!((input.notify || {}).crash ?? cur.notify.crash),
    },
  };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(UI_FILE(), JSON.stringify({ ...readUi(), prefs: next }), 'utf8');
  if (next.autostart !== cur.autostart) applyLoginItem(next.autostart);
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

async function publicIpNow() {
  try {
    return (await getJson('https://api.ipify.org?format=json')).ip;
  } catch {
    throw new Error('Не удалось узнать внешний адрес — проверьте подключение к интернету');
  }
}
async function mcsrvOnline(ip, port) {
  try {
    return !!(await getJson(`https://api.mcsrvstat.us/3/${encodeURIComponent(ip)}:${port}`)).online;
  } catch {
    throw new Error('Сервис проверки (mcsrvstat.us) не ответил — попробуйте через минуту');
  }
}

// Если сервер выключен, порт проверяется пробным ответчиком (lib/probe.js): лаунчер
// на несколько секунд занимает порт и отвечает на запрос статуса как сервер Minecraft.
// Сам сервер при этом не запускается, EULA не нужна.
handle('net:check', async ({ type, version }) => {
  const dir = serverDir(type, version);
  const props = core.readProps(dir);
  if (props['server-ip']) throw new Error('Сервер привязан к одному адресу (вкладка «Настройки» → IP сервера) — из интернета он не виден');
  const port = Number(props['server-port']) || 25565;
  const live = isCurrent(type, version) && state === 'running';
  if (!live && state !== 'stopped') throw new Error(isCurrent(type, version) ? 'Сервер запускается или останавливается — проверьте через минуту' : 'Сейчас работает другой сервер — остановите его, чтобы проверить порт этого');
  const publicIp = await publicIpNow();
  rememberIp(publicIp);
  const out = { port, publicIp, upnp: upnpState, cgnat: false, reachable: false, probe: !live };
  if (live) {
    if (upnpState && upnpState.externalIp && (upnp.isPrivateIp(upnpState.externalIp) || upnpState.externalIp !== publicIp)) out.cgnat = true;
    out.reachable = await mcsrvOnline(publicIp, port);
    return out;
  }
  const p = await probe.start(port);
  let tempUpnp = null;
  try {
    if (backup.readSettings(dir).net.upnp) {
      try {
        tempUpnp = await upnp.openPort(port, 'Minecraft server (Blockhost)');
        out.upnp = { port, externalIp: tempUpnp.externalIp };
      } catch (e) {
        out.upnpError = e.message;
      }
    }
    if (out.upnp && out.upnp.externalIp && (upnp.isPrivateIp(out.upnp.externalIp) || out.upnp.externalIp !== publicIp)) out.cgnat = true;
    out.reachable = await mcsrvOnline(publicIp, port);
    // mcsrvstat.us держит результат в кэше; подключение к нам извне — прямое доказательство.
    if (!out.reachable) out.reachable = p.external();
  } finally {
    await p.close();
    if (tempUpnp) await Promise.race([upnp.closePort(port).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
  return out;
});

// ---- слежение за внешним IP: у многих провайдеров он меняется ----

let ipTimer = null;
function rememberIp(ip) {
  const prev = readUi().publicIp;
  if (prev === ip) return null;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(UI_FILE(), JSON.stringify({ ...readUi(), publicIp: ip }), 'utf8');
  return prev || null;
}
async function ipTick() {
  if (state !== 'running' || !current) return;
  const dir = serverDir(current.type, current.version);
  const props = core.readProps(dir);
  if (props['server-ip']) return;
  let ip;
  try {
    ip = await publicIpNow();
  } catch {
    return; // нет интернета — проверим в следующий раз
  }
  const prev = rememberIp(ip);
  if (!prev) return;
  const port = Number(props['server-port']) || 25565;
  const addr = ip + (port === 25565 ? '' : ':' + port);
  log(`Внешний IP изменился: был ${prev}, теперь ${ip}. Новый адрес для друзей из интернета: ${addr}.`, 'error');
  send('net', { upnp: upnpState, ipChanged: { from: prev, to: ip, addr } });
  tgNotify('start', `🌐 Внешний IP изменился. Новый адрес сервера: ${addr}`);
}
function ipWatch(on) {
  clearInterval(ipTimer);
  ipTimer = null;
  if (!on) return;
  setTimeout(ipTick, 5000);
  ipTimer = setInterval(ipTick, 30 * 60000);
}

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

// ---- плавность (TPS): тихий запрос раз в 10 секунд ----

let lastTps = null; // { tps, mspt }
let tpsUntil = 0; // до этого момента ответы на запрос прячутся из консоли
let tpsFails = 0;
let tracker = null; // учёт времени игроков текущего запуска

function handleTpsLine(line) {
  const r = tps.parse(line);
  if (r) {
    lastTps = r;
    tpsFails = 0;
  } else if (tps.isUnknown(line)) {
    tpsFails++;
  }
}
setInterval(() => {
  if (!child || state !== 'running' || !current || tpsFails >= 2) return;
  const cmd = tps.queryFor(current.type, current.version);
  if (!cmd) return;
  tpsUntil = Date.now() + 2500;
  runCmd(cmd);
}, 10000);

// ---- правила игры ----

function applyGamerules(type, version) {
  const rules = backup.readSettings(serverDir(type, version)).gamerules;
  const cmds = gamerules.commandsFor(version, rules);
  for (const c of cmds) runCmd(c);
  return cmds.length;
}
handle('rules:set', ({ type, version, rules }) => {
  const s = backup.writeSettings(serverDir(type, version), { gamerules: rules || {} });
  const live = isCurrent(type, version) && state === 'running';
  const n = live ? applyGamerules(type, version) : 0;
  if (n) log(`Правила игры применены (${n}).`);
  return { rules: s.gamerules, applied: live };
});

// ---- игроки: кто заходил ----

handle('players:stats', ({ type, version }) => playtime.list(serverDir(type, version)));

// ---- копии в облачную папку ----

function mirrorBackup(dir, file) {
  const s = backup.readSettings(dir).backup;
  if (!s.mirror || !file) return;
  try {
    backup.mirror(dir, file, s.mirror, s.keep);
  } catch (e) {
    log(`Не удалось положить копию в «${s.mirror}»: ${e.message}`, 'error');
  }
}
handle('backup:pickMirror', async () => {
  const home = os.homedir();
  const guess = ['OneDrive', 'YandexDisk', 'Яндекс.Диск', 'Google Drive', 'Dropbox'].map((n) => path.join(home, n)).find((p) => fs.existsSync(p));
  const r = await dialog.showOpenDialog(win, {
    title: 'Папка для копий мира (например, в OneDrive или на Яндекс.Диске)',
    defaultPath: guess || home,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0] || null;
});
handle('backup:cloudGuess', () => {
  const home = os.homedir();
  return ['OneDrive', 'YandexDisk', 'Яндекс.Диск', 'Google Drive', 'Dropbox'].filter((n) => fs.existsSync(path.join(home, n)));
});

// ---- запуск вместе с Windows ----

const launchExe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
function applyLoginItem(on) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!on, path: launchExe(), args: ['--hidden'] });
}
function saveLastStart(opts) {
  try {
    const { type, version, loader, ramGb, javaPath } = opts;
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const ui = readUi();
    const starts = { ...(ui.starts || {}), [`${type}-${version}`]: { type, version, loader, ramGb, javaPath } };
    fs.writeFileSync(UI_FILE(), JSON.stringify({ ...ui, starts, lastStart: { type, version, loader, ramGb, javaPath } }), 'utf8');
  } catch {
    /* не страшно */
  }
}
/** Лаунчер запущен вместе с Windows — сразу поднимаем последний сервер, если так настроено. */
function autoStartServer() {
  const p = prefs();
  const last = readUi().lastStart;
  if (!p.autoStartServer || !last || state !== 'stopped') return;
  try {
    if (!core.eulaAccepted(serverDir(last.type, last.version))) return;
  } catch {
    return;
  }
  setTimeout(() => {
    log(`Автозапуск: ${serverTitle(last.type, last.version)}…`);
    startServer({ ...last, eula: false }).catch((e) => log(`Автозапуск не удался: ${e.message}`, 'error'));
  }, 3000);
}

// ---- готовый сервер из другой папки ----

/** Версия vanilla-сервера из version.json внутри server.jar (распаковывает встроенный в Windows tar). */
function readJarVersion(jar) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-jar-'));
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    require('child_process').execFile(tarExe, ['-xf', jar, '-C', tmp, 'version.json'], { windowsHide: true, timeout: 20000 }, () => {
      let v = null;
      try {
        v = JSON.parse(fs.readFileSync(path.join(tmp, 'version.json'), 'utf8')).id || null;
      } catch {
        /* старый server.jar без version.json */
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(v);
    });
  });
}
handle('server:importPick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Папка с готовым сервером Minecraft', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  if (path.resolve(dir).startsWith(path.resolve(ROOT) + path.sep)) throw new Error('Этот сервер уже есть в лаунчере');
  return servers.detectServer(dir, readJarVersion);
});
handle('server:importCopy', ({ src, type, version }) => {
  core.checkArgs(type, version);
  if (!fs.existsSync(String(src))) throw new Error('Папка не найдена');
  const r = servers.importServer(String(src), serverDir(type, version));
  log(`Перенесено из «${src}»: ${r.copied.join(', ') || 'ничего'}.`);
  return r;
});

// ---- новые сборки ядра ----

handle('server:paperBuild', async ({ type, version }) => {
  if (type !== 'paper') return null;
  const inst = core.readInstall(serverDir(type, version));
  if (!inst || !inst.loader) return null;
  const latest = await core.resolveDownload('paper', version);
  return { installed: inst.loader, latest: latest.build };
});
// Paper обновляется так: лаунчер забывает установку, и при следующем запуске скачивает свежую сборку.
handle('server:paperRefresh', ({ type, version }) => {
  if (type !== 'paper') throw new Error('Только для Paper');
  fs.rmSync(path.join(serverDir(type, version), 'launcher.json'), { force: true });
});

// ---- туннель playit.gg ----

const PLAYIT_DIR = () => path.join(app.getPath('userData'), 'playit');
const PLAYIT_EXE = () => path.join(PLAYIT_DIR(), 'playit.exe');
let playitProc = null;
let playitAuto = false; // запущен лаунчером вместе с сервером — и остановится вместе с ним

async function downloadPlayit() {
  if (fs.existsSync(PLAYIT_EXE())) return;
  const rel = await getJson('https://api.github.com/repos/playit-cloud/playit-agent/releases/latest');
  const asset =
    (rel.assets || []).find((a) => a.name === 'playit-windows-x86_64-signed.exe') ||
    (rel.assets || []).find((a) => a.name === 'playit-windows-x86_64.exe');
  if (!asset || !/^https:\/\/github\.com\/playit-cloud\/playit-agent\/releases\/download\//.test(asset.browser_download_url)) {
    throw new Error('Не удалось найти программу playit для Windows');
  }
  log(`Скачиваю playit ${rel.tag_name || ''}…`);
  fs.mkdirSync(PLAYIT_DIR(), { recursive: true });
  const tmp = PLAYIT_EXE() + '.part';
  await core.downloadFile({ url: asset.browser_download_url, size: asset.size }, tmp);
  fs.renameSync(tmp, PLAYIT_EXE());
}
function startPlayit(visible) {
  if (playitProc) return;
  const proc = spawn(PLAYIT_EXE(), [], { cwd: PLAYIT_DIR(), detached: visible, stdio: 'ignore', windowsHide: !visible });
  playitProc = proc;
  proc.on('error', (e) => log(`playit не запустился: ${e.message}`, 'error'));
  proc.on('exit', () => {
    if (playitProc === proc) playitProc = null;
    send('tunnel', { running: false });
  });
  send('tunnel', { running: true });
}
function stopPlayit() {
  if (!playitProc) return;
  try {
    playitProc.kill();
  } catch {
    /* уже завершился */
  }
  playitProc = null;
  playitAuto = false;
}
handle('tunnel:get', ({ type, version }) => ({
  ...backup.readSettings(serverDir(type, version)).tunnel,
  downloaded: fs.existsSync(PLAYIT_EXE()),
  running: !!playitProc,
}));
handle('tunnel:setup', async () => {
  await downloadPlayit();
  stopPlayit();
  startPlayit(true);
  return { running: true };
});
handle('tunnel:stop', () => stopPlayit());
handle('tunnel:set', ({ type, version, address, auto }) => backup.writeSettings(serverDir(type, version), { tunnel: { address, auto } }).tunnel);

// ---- проверка модов перед запуском ----

handle('mods:check', ({ type, version }) => modcheck.checkMods(type, serverDir(type, version)));
handle('mods:checkRemove', async ({ type, version, file }) => {
  needStopped(type, version, 'убирать моды');
  if (!/^[^\\/:*?"<>|]+\.jar$/i.test(String(file))) throw new Error('Некорректное имя файла');
  const p = path.join(serverDir(type, version), 'mods', String(file));
  if (!fs.existsSync(p)) return;
  await shell.trashItem(p);
  mods.forgetFile(type, serverDir(type, version), String(file), 'mod');
});

// ---- старые журналы и отчёты о сбоях ----

handle('logs:list', ({ type, version }) => logsLib.list(serverDir(type, version)));
handle('logs:read', ({ type, version, kind, name }) => {
  const dir = serverDir(type, version);
  const text = logsLib.read(dir, kind, name);
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const issues = diagnose
    .diagnose(lines, 0, { type, version, modded: isModded(type) })
    .filter((i) => (seen.has(i.key || i.title) ? false : seen.add(i.key || i.title)))
    .slice(0, 8);
  return { text: lines.slice(-4000).join('\n'), issues };
});
handle('logs:clean', ({ type, version, days }) => logsLib.clean(serverDir(type, version), Number(days) || 14));

// ---- место на диске ----

handle('disk:usage', async ({ type, version }) => {
  const u = await disk.usage(serverDir(type, version));
  return { ...u, level: disk.level(u) };
});

// ---- новый мир с копией старого ----

handle('world:new', async ({ type, version, seed, levelType }) => {
  needStopped(type, version, 'начать новый мир');
  const dir = serverDir(type, version);
  let saved = null;
  if (backup.worldDirs(dir).length) {
    saved = await makeBackup(dir, 'before-newworld', false);
    for (const w of backup.worldDirs(dir)) fs.rmSync(path.join(dir, w), { recursive: true, force: true });
  }
  core.writeProps(dir, { 'level-seed': String(seed || ''), 'level-type': servers.levelTypeValue(version, levelType || 'normal') });
  log('Старый мир сохранён копией. Новый мир создастся при следующем запуске сервера.');
  return { backup: saved && saved.file };
});

// ---- прогрузка мира заранее (Chunky) ----

let chunky = null; // { pct, eta, world, done }
const CHUNKY_RE = /Task running for (\S+)\. Processed: ([\d,]+) chunks \(([\d.,]+)%\), ETA: ([\d:]+)/i;
function chunkyLine(line) {
  const m = line.match(CHUNKY_RE);
  if (m) {
    chunky = { world: m[1], chunks: Number(m[2].replace(/,/g, '')), pct: Number(m[3].replace(',', '.')), eta: m[4], done: false };
    send('chunky', chunky);
  } else if (/\[Chunky\].*Task (finished|stopped|cancelled) for/i.test(line)) {
    chunky = { ...(chunky || {}), done: true, pct: /finished/i.test(line) ? 100 : (chunky || {}).pct || 0 };
    send('chunky', chunky);
  }
}
handle('chunky:start', ({ type, version, radius }) => {
  if (!isCurrent(type, version) || state !== 'running') throw new Error('Сначала запустите сервер');
  const r = Math.round(Number(radius));
  if (!Number.isInteger(r) || r < 100 || r > 50000) throw new Error('Радиус — от 100 до 50 000 блоков');
  runCmd('chunky center 0 0');
  runCmd(`chunky radius ${r}`);
  runCmd('chunky start');
  chunky = { pct: 0, eta: '', world: '', done: false };
  send('chunky', chunky);
});
handle('chunky:cancel', () => {
  runCmd('chunky cancel');
  runCmd('chunky confirm');
});
handle('chunky:get', () => chunky);

// ---- сообщения по расписанию и приветствие ----

const msgSent = new Map(); // номер сообщения → когда отправлено
setInterval(() => {
  if (!child || state !== 'running' || !current) return;
  const list = backup.readSettings(serverDir(current.type, current.version)).messages.list;
  const now = Date.now();
  list.forEach((m, i) => {
    const key = `${i}|${m.text}`;
    if (!msgSent.has(key)) msgSent.set(key, now); // первое — через интервал после запуска
    else if (now - msgSent.get(key) >= m.every * 60000) {
      msgSent.set(key, now);
      runCmd(`say ${m.text}`);
    }
  });
}, 15000);
function welcome(name) {
  if (!current) return;
  const text = backup.readSettings(serverDir(current.type, current.version)).messages.welcome;
  if (!text) return;
  setTimeout(() => runCmd(`tell ${name} ${text.replace(/%player%/g, name)}`), 3000);
}

// ---- набор ресурсов сервера ----

handle('pack:resource', async ({ type, version, url, require: req }) => {
  const dir = serverDir(type, version);
  const link = String(url || '').trim();
  if (!link) {
    core.writeProps(dir, { 'resource-pack': '', 'resource-pack-sha1': '', 'require-resource-pack': 'false' });
    return { sha1: '' };
  }
  if (!/^https?:\/\/\S+$/i.test(link)) throw new Error('Ссылка — вида https://…');
  const res = await net.fetch(link, { headers: { 'User-Agent': core.UA } });
  if (!res.ok) throw new Error(`Файл по ссылке не скачивается (HTTP ${res.status}). Ссылка должна вести прямо на .zip`);
  const hash = require('crypto').createHash('sha1');
  const reader = res.body.getReader();
  let size = 0;
  let head = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!head) head = Buffer.from(value.subarray(0, 4));
    size += value.length;
    if (size > 250 * 1024 * 1024) throw new Error('Набор ресурсов больше 250 МБ — Minecraft такой не примет');
    hash.update(value);
  }
  if (!head || head.readUInt32LE(0) !== 0x04034b50) throw new Error('По ссылке не zip-архив. Нужна прямая ссылка на файл набора ресурсов');
  const sha1 = hash.digest('hex');
  core.writeProps(dir, { 'resource-pack': link, 'resource-pack-sha1': sha1, 'require-resource-pack': req ? 'true' : 'false' });
  return { sha1, size };
});
handle('pack:resourceGet', ({ type, version }) => {
  const text = (() => {
    try {
      return fs.readFileSync(path.join(serverDir(type, version), 'server.properties'), 'utf8');
    } catch {
      return '';
    }
  })();
  const get = (k) => {
    const m = text.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].replace(/\\:/g, ':') : '';
  };
  return { url: get('resource-pack'), sha1: get('resource-pack-sha1'), require: get('require-resource-pack') === 'true' };
});

// ---- значок сервера ----

handle('icon:get', ({ type, version }) => {
  const p = path.join(serverDir(type, version), 'server-icon.png');
  return fs.existsSync(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : null;
});
handle('icon:pick', async ({ type, version }) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Картинка для значка сервера',
    filters: [{ name: 'Картинки', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error('Не удалось открыть картинку');
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  const png = square.resize({ width: 64, height: 64, quality: 'best' }).toPNG();
  const dir = serverDir(type, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server-icon.png'), png);
  return 'data:image/png;base64,' + png.toString('base64');
});
handle('icon:remove', ({ type, version }) => fs.rmSync(path.join(serverDir(type, version), 'server-icon.png'), { force: true }));

// ---- сборки модов поиском (Modrinth) ----

handle('mrpack:search', async ({ query }) => {
  const q = String(query || '').slice(0, 100);
  const facets = encodeURIComponent(JSON.stringify([['project_type:modpack']]));
  const j = await getJson(`https://api.modrinth.com/v2/search?limit=12&index=${q ? 'relevance' : 'downloads'}&facets=${facets}&query=${encodeURIComponent(q)}`);
  return (j.hits || []).map((h) => ({
    id: h.project_id,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
    icon: /^https:\/\/cdn\.modrinth\.com\//.test(h.icon_url || '') ? h.icon_url : null,
    versions: (h.versions || []).filter((v) => /^\d/.test(v)).slice(-3),
  }));
});
handle('mrpack:fromModrinth', async ({ projectId }) => {
  if (!/^[A-Za-z0-9]{1,32}$/.test(String(projectId))) throw new Error('Некорректная сборка');
  const versions = await getJson(`https://api.modrinth.com/v2/project/${projectId}/version`);
  const v = versions.find((x) => x.version_type === 'release') || versions[0];
  const file = v && (v.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) || v.files.find((f) => f.filename.endsWith('.mrpack')));
  if (!file || !/^https:\/\/cdn\.modrinth\.com\//.test(file.url)) throw new Error('У этой сборки нет файла .mrpack');
  const tmp = path.join(os.tmpdir(), `mcl-pack-${Date.now()}.mrpack`);
  log(`Скачиваю сборку «${v.name || file.filename}»…`);
  await core.downloadFile({ url: file.url, algo: 'sha1', hash: file.hashes && file.hashes.sha1, size: file.size }, tmp);
  try {
    return await openPack(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// ---- перенос лаунчера на другой ПК ----

const SKIP_EXPORT = new Set(['libraries', 'versions', 'cache', 'logs', 'crash-reports', '.fabric', 'bundler']);
handle('transfer:export', async ({ includeBackups }) => {
  if (state !== 'stopped') throw new Error('Остановите сервер перед переносом');
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-z]+-.+$/.test(d.name)).map((d) => d.name);
  if (!dirs.length) throw new Error('Серверов пока нет — переносить нечего');
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить архив с серверами',
    defaultPath: path.join(app.getPath('documents'), `MC-Server-Launcher-${stamp}.tar.gz`),
    filters: [{ name: 'Архив лаунчера', extensions: ['gz'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const meta = path.join(ROOT, '.mcl-launcher.json');
  const { lastStart, ...ui } = readUi();
  fs.writeFileSync(meta, JSON.stringify({ ui, lastStart, exportedAt: Date.now() }), 'utf8');
  log('Собираю архив со всеми серверами — это может занять несколько минут…');
  try {
    await tar.c(
      {
        gzip: { level: 5 },
        file: r.filePath,
        cwd: ROOT,
        portable: true,
        filter: (p) => {
          const parts = p.split(/[\\/]/);
          if (/(^|[\\/])session\.lock$/.test(p)) return false;
          if (parts.length === 2 && (/\.jar$/i.test(parts[1]) || parts[1] === 'launcher.json')) return false;
          if (parts.length >= 2 && SKIP_EXPORT.has(parts[1])) return false;
          if (!includeBackups && parts[1] === 'backups') return false;
          return true;
        },
      },
      ['.mcl-launcher.json', ...dirs]
    );
  } finally {
    fs.rmSync(meta, { force: true });
  }
  const size = fs.statSync(r.filePath).size;
  log(`Архив готов: ${r.filePath} (${fmtSize(size)}).`);
  return { file: r.filePath, size, servers: dirs.length };
});
handle('transfer:import', async () => {
  if (state !== 'stopped') throw new Error('Остановите сервер перед восстановлением');
  const r = await dialog.showOpenDialog(win, {
    title: 'Архив лаунчера с другого компьютера',
    filters: [{ name: 'Архив лаунчера', extensions: ['gz'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  const tops = new Set();
  await tar.t({ file, onentry: (e) => tops.add(String(e.path).split(/[\\/]/)[0]) });
  if (!tops.has('.mcl-launcher.json')) throw new Error('Это не архив лаунчера');
  const existing = new Set(fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []);
  const skipped = [...tops].filter((t) => t !== '.mcl-launcher.json' && existing.has(t));
  fs.mkdirSync(ROOT, { recursive: true });
  log('Распаковываю серверы…');
  await tar.x({
    file,
    cwd: ROOT,
    strict: true,
    filter: (p) => {
      const parts = String(p).split(/[\\/]/);
      if (path.isAbsolute(p) || parts.includes('..')) return false;
      if (parts[0] === '.mcl-launcher.json') return true;
      return /^[a-z]+-[^\\/]+$/.test(parts[0]) && !existing.has(parts[0]);
    },
  });
  const meta = path.join(ROOT, '.mcl-launcher.json');
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const cur = readUi();
    fs.writeFileSync(UI_FILE(), JSON.stringify({ ...cur, prefs: cur.prefs || (m.ui || {}).prefs, lastStart: cur.lastStart || m.lastStart }), 'utf8');
  } catch {
    /* настройки лаунчера не обязательны */
  }
  fs.rmSync(meta, { force: true });
  const added = [...tops].filter((t) => t !== '.mcl-launcher.json' && !existing.has(t));
  return { added, skipped };
});

// ---- управление с телефона ----

const remote = createRemote({
  status: () => {
    const last = readUi().lastStart;
    const who = current || last;
    let canStart = false;
    try {
      canStart = !!last && state === 'stopped' && core.eulaAccepted(serverDir(last.type, last.version));
    } catch {
      canStart = false;
    }
    return {
      state,
      name: who ? serverTitle(who.type, who.version) : 'Сервер не выбран',
      players: [...online],
      tps: lastTps ? Math.round(lastTps.tps * 10) / 10 : null,
      log: logLines.slice(-40),
      canStart,
    };
  },
  start: async () => {
    const last = readUi().lastStart;
    if (!last) throw new Error('Сначала запустите сервер из лаунчера хотя бы раз');
    if (state !== 'stopped') throw new Error('Сервер уже работает');
    cancelCrashRestart(true);
    log('Запуск с телефона…');
    await startServer({ ...last, eula: false });
  },
  stop: () => {
    if (!child) throw new Error('Сервер не запущен');
    log('Остановка с телефона…');
    cancelCrashRestart(false);
    restartPending = false;
    stopServer();
  },
  command: (text) => {
    if (!child || state === 'stopped') throw new Error('Сервер не запущен');
    child.stdin.write(text + '\n');
    send('log', { text: '> ' + text + ' (с телефона)', kind: 'input' });
  },
});
const remoteUrl = (port) => {
  const a = localAddresses().find((x) => !x.vpn) || localAddresses()[0];
  return a ? `http://${a.address}:${port}` : `http://localhost:${port}`;
};
const remoteInfo = () => {
  const i = remote.info();
  return { ...i, url: i.enabled ? remoteUrl(i.port) : null };
};
handle('remote:get', () => remoteInfo());
handle('remote:set', async ({ on }) => {
  if (on) await remote.enable(8765);
  else remote.disable();
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(UI_FILE(), JSON.stringify({ ...readUi(), remote: !!on }), 'utf8');
  return remoteInfo();
});
handle('remote:newCode', () => {
  remote.newCode();
  return remoteInfo();
});

// ---- несколько серверов одновременно (фоновые) ----

const runner = createRunner((ev, data) => send('bg:' + ev, data));
const bgKey = (type, version) => `${type}-${version}`;

/** Порты, занятые основным сервером и фоновыми. */
function busyPorts(exceptKey) {
  const used = runner.list().filter((e) => e.key !== exceptKey).map((e) => e.port).filter(Boolean);
  if (current && state !== 'stopped') used.push(Number(core.readProps(serverDir(current.type, current.version))['server-port']) || 25565);
  return used;
}
/** Если порт сервера занят другим запущенным — назначить свободный и сообщить. */
function ensureFreePort(type, version, dir) {
  const used = busyPorts(bgKey(type, version));
  const port = Number(core.readProps(dir)['server-port']) || 25565;
  if (!used.includes(port)) return port;
  const next = freePort(used, 25566);
  core.writeProps(dir, { 'server-port': String(next) });
  log(`Порт ${port} уже занят другим запущенным сервером — серверу «${serverTitle(type, version)}» назначен порт ${next}.`);
  return next;
}

async function bgStart({ type, version, ramGb, javaPath }) {
  const key = bgKey(type, version);
  if (runner.has(key)) throw new Error('Этот сервер уже запущен');
  if (isCurrent(type, version) && state !== 'stopped') throw new Error('Этот сервер уже запущен');
  const dir = serverDir(type, version);
  const inst = core.readInstall(dir);
  if (!inst) throw new Error('Сервер ещё не установлен. Запустите его один раз, когда другие серверы остановлены, — потом он сможет работать вместе с ними');
  if (!core.eulaAccepted(dir)) throw new Error('Сначала запустите этот сервер обычным способом и примите лицензию Minecraft');
  const port = ensureFreePort(type, version, dir);
  const java = await chooseJava(type, version, javaPath);
  const { maxGb } = memoryInfo();
  const ram = Math.max(1, Math.min(maxGb, Math.round(Number(ramGb)) || 2));
  const s = backup.readSettings(dir);
  const args = [
    `-Xms${Math.min(ram, 1)}G`,
    `-Xmx${java.bits === 32 ? 1 : ram}G`,
    ...(s.jvm.aikar && java.bits !== 32 && ram >= 2 ? jvm.aikarFlags(ram) : []),
    '-Djava.net.useSystemProxies=true',
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    ...inst.args,
    'nogui',
  ];
  runner.start({ key, title: serverTitle(type, version), cwd: dir, java: java.path, args, port });
  return { key, port };
}
handle('bg:start', (opts) => bgStart(opts));
handle('bg:stop', ({ key }) => runner.stop(String(key)));
handle('bg:command', ({ key, text }) => runner.command(String(key), text));
handle('bg:list', () => runner.list());
handle('bg:lines', ({ key }) => runner.lines(String(key)));

// ---- сеть серверов (Velocity) ----

const NET_FILE = () => path.join(app.getPath('userData'), 'network.json');
const VEL_DIR = () => path.join(ROOT, 'velocity-network');
function readNet() {
  try {
    return JSON.parse(fs.readFileSync(NET_FILE(), 'utf8'));
  } catch {
    return null;
  }
}
async function downloadVelocity() {
  const jar = path.join(VEL_DIR(), 'velocity.jar');
  if (fs.existsSync(jar)) return;
  const meta = await getJson('https://fill.papermc.io/v3/projects/velocity');
  const versions = Object.values(meta.versions || {}).flat().filter((v) => !/SNAPSHOT/i.test(v));
  if (!versions.length) throw new Error('Не удалось найти Velocity');
  // Конфиг, который пишет лаунчер, — формата Velocity 3.x; ей же хватает Java 21.
  const pick = versions.find((v) => /^3\./.test(v)) || versions[0];
  const builds = await getJson(`https://fill.papermc.io/v3/projects/velocity/versions/${encodeURIComponent(pick)}/builds`);
  const b = (Array.isArray(builds) ? builds : []).find((x) => x.channel === 'STABLE') || builds[0];
  const dl = b && b.downloads && b.downloads['server:default'];
  if (!dl) throw new Error('Не удалось найти файл Velocity');
  log(`Скачиваю Velocity ${pick} (сборка ${b.id})…`);
  fs.mkdirSync(VEL_DIR(), { recursive: true });
  await core.downloadFile({ url: dl.url, algo: 'sha256', hash: dl.checksums && dl.checksums.sha256, size: dl.size }, jar);
}
handle('net2:get', () => {
  const cfg = readNet();
  const paper = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT).filter((n) => /^paper-.+$/.test(n)).map((n) => n.slice(6)).filter((v) => {
        try {
          return !!core.readInstall(serverDir('paper', v));
        } catch {
          return false;
        }
      })
    : [];
  return {
    config: cfg,
    candidates: paper.map((v) => ({ type: 'paper', version: v, title: serverTitle('paper', v) })),
    running: runner.has('velocity'),
  };
});
handle('net2:setup', async ({ servers: list, port, onlineMode }) => {
  if (!Array.isArray(list) || list.length < 2) throw new Error('Для сети нужно хотя бы два сервера');
  if (runner.has('velocity')) throw new Error('Сначала остановите сеть');
  const p = Number(port) || 25565;
  if (!(p >= 1 && p <= 65535)) throw new Error('Некорректный порт');
  for (const s of list) {
    if (s.type !== 'paper') throw new Error('В сеть можно объединять только серверы Paper');
    if ((isCurrent(s.type, s.version) && state !== 'stopped') || runner.has(bgKey(s.type, s.version))) {
      throw new Error(`Остановите сервер «${serverTitle(s.type, s.version)}», чтобы настроить сеть`);
    }
  }
  await downloadVelocity();
  const prev = readNet();
  const secret = (prev && prev.secret) || velocity.newSecret();
  const usedNames = new Set();
  const usedPorts = [p];
  const servers = list.map((s) => {
    const port2 = freePort(usedPorts, 25566);
    usedPorts.push(port2);
    return { type: s.type, version: s.version, name: velocity.slugName(serverTitle(s.type, s.version), usedNames), port: port2 };
  });
  for (const s of servers) {
    const dir = serverDir(s.type, s.version);
    velocity.enablePaperForwarding(dir, secret);
    // Сервер в сети принимает игроков только от прокси: свой порт, только этот компьютер, без проверки лицензии (её делает прокси).
    core.writeProps(dir, { 'server-port': String(s.port), 'server-ip': '127.0.0.1', 'online-mode': 'false' });
  }
  fs.writeFileSync(path.join(VEL_DIR(), 'forwarding.secret'), secret, 'utf8');
  fs.writeFileSync(path.join(VEL_DIR(), 'velocity.toml'), velocity.velocityToml({ port: p, onlineMode: onlineMode !== false, servers }), 'utf8');
  const cfg = { servers, port: p, onlineMode: onlineMode !== false, secret };
  fs.writeFileSync(NET_FILE(), JSON.stringify(cfg, null, 2), 'utf8');
  log(`Сеть настроена: ${servers.map((s) => `${s.name} (порт ${s.port})`).join(', ')}. Игроки заходят по порту ${p} и переходят между серверами командой /server <имя>.`);
  return cfg;
});
handle('net2:start', async ({ ramGb }) => {
  const cfg = readNet();
  if (!cfg) throw new Error('Сначала настройте сеть');
  if (runner.has('velocity')) return;
  if (busyPorts('velocity').includes(cfg.port)) throw new Error(`Порт ${cfg.port} занят запущенным сервером — остановите его`);
  for (const s of cfg.servers) {
    if (!runner.has(bgKey(s.type, s.version))) await bgStart({ type: s.type, version: s.version, ramGb: ramGb || 2, javaPath: 'auto' });
  }
  const java = await chooseJava('vanilla', '1.21.1', 'auto'); // Velocity 3.4+ нужна Java 21
  runner.start({
    key: 'velocity',
    kind: 'proxy',
    title: 'Сеть серверов (Velocity)',
    cwd: VEL_DIR(),
    java: java.path,
    args: ['-Xms256M', '-Xmx512M', '-XX:+UseG1GC', '-Dfile.encoding=UTF-8', '-jar', 'velocity.jar'],
    port: cfg.port,
    readyRe: /Done \(/,
  });
  log(`Сеть запускается: адрес для игроков — порт ${cfg.port}.`);
});
handle('net2:stop', () => {
  const cfg = readNet();
  runner.stop('velocity');
  for (const s of (cfg && cfg.servers) || []) runner.stop(bgKey(s.type, s.version));
});
handle('net2:remove', () => {
  const cfg = readNet();
  if (runner.has('velocity')) throw new Error('Сначала остановите сеть');
  for (const s of (cfg && cfg.servers) || []) {
    const dir = serverDir(s.type, s.version);
    velocity.disablePaperForwarding(dir);
    core.writeProps(dir, { 'server-ip': '', 'online-mode': 'true' });
  }
  fs.rmSync(NET_FILE(), { force: true });
});

// ---- нагрузка за неделю ----

let hist = null; // учёт текущего запуска

handle('history:get', ({ type, version }) => {
  const dir = serverDir(type, version);
  const points = isCurrent(type, version) && hist ? hist.points() : history.read(dir);
  return { points, summary: history.summary(points) };
});

// ---- чат игроков ----

let chatLines = []; // { name, text, at, own?, to?, via? }
function addChat(m) {
  chatLines.push(m);
  if (chatLines.length > 300) chatLines.shift();
  send('chat', m);
}
handle('chat:get', () => ({ lines: chatLines, running: !!child && state === 'running', online: [...online] }));
handle('chat:send', ({ to, text }) => {
  if (!child || state !== 'running') throw new Error('Сервер не запущен');
  const target = to || '@a';
  runCmd(chat.tellraw(target, text));
  addChat({ name: null, to: target === '@a' ? null : target, text: String(text).trim().slice(0, 240), at: Date.now(), own: true });
});

// ---- игра на этом ПК: сервер уступает ей процессор ----

let gameActive = null;
function javawPids() {
  return new Promise((resolve) => {
    require('child_process').execFile('tasklist', ['/FI', 'IMAGENAME eq javaw.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 }, (err, out) => {
      if (err) return resolve([]);
      const pids = [];
      for (const line of String(out).split(/\r?\n/)) {
        const m = /^"javaw\.exe","(\d+)"/i.exec(line);
        if (m) pids.push(Number(m[1]));
      }
      resolve(pids);
    });
  });
}
async function gameTick() {
  if (!child || process.platform !== 'win32') return;
  const pid = child.pid;
  // Клиент Minecraft (официальный лаунчер, TLauncher, Prism) работает в javaw.exe, сервер — в java.exe.
  const active = prefs().gamePriority ? (await javawPids()).some((p) => p !== pid) : false;
  if (!child || child.pid !== pid || active === gameActive) return;
  const was = gameActive;
  gameActive = active;
  try {
    os.setPriority(pid, active ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL);
  } catch {
    return;
  }
  if (active) log('На этом компьютере открыта игра — сервер уступает ей процессор.');
  else if (was) log('Игра закрыта — сервер снова работает в полную силу.');
  send('game', { active });
}
setInterval(gameTick, 20000);

// ---- расписание работы ----

const powerPrev = new Map(); // сервер → был ли он «в окне» при прошлой проверке
const powerWarned = new Set();

function scheduledServers() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of dirs) {
    const i = name.indexOf('-');
    if (i < 1) continue;
    const type = name.slice(0, i);
    const version = name.slice(i + 1);
    try {
      core.checkArgs(type, version);
    } catch {
      continue;
    }
    const p = backup.readSettings(path.join(ROOT, name)).power;
    if (p.enabled) out.push({ type, version, key: name, p });
  }
  return out;
}

/** С какими параметрами запускать сервер без участия человека: как в прошлый раз. */
function startParams(type, version) {
  const ui = readUi();
  const s = (ui.starts || {})[`${type}-${version}`] || (ui.lastStart && ui.lastStart.type === type && ui.lastStart.version === version ? ui.lastStart : null);
  return { ...(s || { type, version, ramGb: 2 }), eula: false };
}

function powerTick() {
  const now = new Date();
  for (const { type, version, key, p } of scheduledServers()) {
    const inside = power.inWindow(p, now);
    const prev = powerPrev.get(key);
    powerPrev.set(key, inside);
    const title = serverTitle(type, version);
    const mine = isCurrent(type, version) && state === 'running';
    if (inside && prev !== true && state === 'stopped' && !runner.has(key)) {
      log(`Расписание: включаю «${title}» (${power.describe(p)}).`);
      startServer(startParams(type, version)).catch((e) => log(`Запуск по расписанию не удался: ${e.message}`, 'error'));
    }
    if (inside && mine) {
      for (const m of [5, 1]) {
        const k = `${key}|${now.toDateString()}|${p.to}|${m}`;
        if (power.inWindow(p, new Date(now.getTime() + m * 60000)) || powerWarned.has(k)) continue;
        powerWarned.add(k);
        runCmd(`say Сервер выключится по расписанию через ${m} ${m === 1 ? 'минуту' : 'минут'}`);
        break;
      }
    }
    if (!inside && prev === true && sleeper && sleeper.type === type && sleeper.version === version) sleepCancel(false);
    if (!inside && prev === true && mine) {
      log(`Расписание: выключаю «${title}».`);
      tgNotify('start', `🌙 «${title}» выключается по расписанию.`);
      stopServer();
    }
  }
}
setInterval(powerTick, 30000);
setTimeout(powerTick, 10000);

handle('power:get', ({ type, version }) => {
  const p = backup.readSettings(serverDir(type, version)).power;
  return { power: p, text: power.describe(p), inside: power.inWindow(p), autostart: prefs().autostart };
});

// ---- мир для одиночной игры ----

handle('sp:export', async ({ type, version, name, mode }) => {
  const dir = serverDir(type, version);
  if (isCurrent(type, version) && state !== 'running' && state !== 'stopped') throw new Error('Дождитесь, пока сервер запустится или остановится');
  const level = core.readProps(dir)['level-name'] || 'world';
  const title = singleplayer.safeName(name || backup.readSettings(dir).name || serverTitle(type, version));
  let file = null;
  if (mode === 'zip') {
    const r = await dialog.showSaveDialog(win, {
      title: 'Сохранить мир архивом',
      defaultPath: path.join(app.getPath('desktop'), title + '.zip'),
      filters: [{ name: 'Архив ZIP', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  } else if (!fs.existsSync(path.dirname(savesDir()))) {
    throw new Error('Не нашёл Minecraft на этом компьютере (папку .minecraft). Сохраните мир архивом и передайте его');
  }
  const running = isCurrent(type, version) && state === 'running';
  if (running) {
    runCmd('save-off');
    runCmd('save-all flush');
    await waitForLog(/Saved the game|Saved the world|All chunks are saved/i, 60000).catch(() => {});
  }
  try {
    if (file) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-sp-'));
      try {
        const res = singleplayer.exportWorld(dir, level, path.join(tmp, title));
        singleplayer.renameLevel(path.join(tmp, title, 'level.dat'), title);
        fs.rmSync(file, { force: true });
        const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        await new Promise((ok, bad) =>
          require('child_process').execFile(tarExe, ['-a', '-cf', file, '-C', tmp, title], { windowsHide: true }, (e) => (e ? bad(new Error('Не удалось собрать архив')) : ok()))
        );
        shell.showItemInFolder(file);
        return { ...res, file };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    const saves = savesDir();
    fs.mkdirSync(saves, { recursive: true });
    const folder = singleplayer.uniqueName(saves, title);
    const res = singleplayer.exportWorld(dir, level, path.join(saves, folder));
    singleplayer.renameLevel(path.join(saves, folder, 'level.dat'), folder);
    return { ...res, folder };
  } finally {
    if (running) runCmd('save-on');
  }
});
handle('sp:openSaves', () => {
  const s = savesDir();
  if (fs.existsSync(s)) shell.openPath(s);
});

// ---- Telegram ----

const TG_FILE = () => path.join(app.getPath('userData'), 'telegram.json');
const TG_EVENTS = { start: true, players: true, crash: true, report: true };
const TG_HELP = 'Команды:\n/status — что с сервером\n/report — отчёт за неделю\n/on — запустить\n/off — остановить\n/say текст — написать игрокам';
let tgCode = null; // { code, until } — код привязки чата

const tgRaw = createTelegram({
  fetchFn: (url, opts) => net.fetch(url, opts),
  onMessage: tgMessage,
  onFatal: (msg) => {
    log(`Telegram: ${msg}`, 'error');
    send('tg', tgInfo());
  },
});

// Сообщения бота — на языке интерфейса.
const tg = new Proxy(tgRaw, {
  get(t, k) {
    if (k === 'send') return (chatId, text) => t.send(chatId, T(text));
    const v = t[k];
    return typeof v === 'function' ? v.bind(t) : v;
  },
});
function tgRead() {
  try {
    return JSON.parse(fs.readFileSync(TG_FILE(), 'utf8')) || {};
  } catch {
    return {};
  }
}
function tgWrite(patch) {
  const next = { ...tgRead(), ...patch };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(TG_FILE(), JSON.stringify(next), 'utf8');
  return next;
}
function tgToken(c = tgRead()) {
  if (!c.token) return '';
  try {
    return c.enc ? safeStorage.decryptString(Buffer.from(c.token, 'base64')) : c.token;
  } catch {
    return '';
  }
}
function tgInfo() {
  const c = tgRead();
  return {
    connected: !!c.token,
    bot: c.bot || '',
    chat: c.chatName || '',
    linked: !!c.chatId,
    events: { ...TG_EVENTS, ...(c.events || {}) },
    control: !!c.control,
    running: tg.running,
    code: tgCode && tgCode.until > Date.now() ? tgCode.code : null,
  };
}
function tgNotify(kind, text) {
  const c = tgRead();
  if (!c.chatId || !{ ...TG_EVENTS, ...(c.events || {}) }[kind]) return;
  tg.send(c.chatId, text);
}
function tgBoot() {
  const t = tgToken();
  if (t) tg.start(t);
}
const tgNewCode = () => (tgCode = { code: String(require('crypto').randomInt(100000, 1000000)), until: Date.now() + 10 * 60000 });

function tgStatus() {
  if (sleeper && !sleeper.pending) return `😴 «${serverTitle(sleeper.type, sleeper.version)}» спит — проснётся, когда кто-то зайдёт.`;
  if (!current || state === 'stopped') {
    const last = readUi().lastStart;
    return `🔴 Сервер выключен.${last ? `\nПоследний: «${serverTitle(last.type, last.version)}» — /on, чтобы запустить.` : ''}`;
  }
  const title = serverTitle(current.type, current.version);
  if (state !== 'running') return `⏳ «${title}» ${state === 'stopping' ? 'останавливается' : 'запускается'}…`;
  const min = Math.floor((Date.now() - startedAt) / 60000);
  const up = min >= 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min} мин`;
  const lines = [`🟢 «${title}» работает ${up}.`, `Игроки: ${online.size} из ${maxPlayers}${online.size ? ' — ' + [...online].join(', ') : ''}.`];
  if (lastTps) lines.push(`Плавность: ${String(Math.round(lastTps.tps * 10) / 10).replace('.', ',')} TPS из 20.`);
  return lines.join('\n');
}

async function tgMessage(m) {
  const c = tgRead();
  const chatId = m.chat && m.chat.id;
  const cmd = parseCommand(m.text);
  if (!cmd || !chatId) return;
  if (!c.chatId) {
    // Привязка: только по коду, который виден в лаунчере.
    if (cmd.cmd === 'start' && tgCode && tgCode.until > Date.now() && cmd.arg === tgCode.code) {
      tgCode = null;
      const name = m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || 'чат';
      tgWrite({ chatId, chatName: name });
      await tg.send(chatId, `Готово: лаунчер привязан к этому чату.\n\n${TG_HELP}`);
      send('tg', tgInfo());
    }
    return;
  }
  if (chatId !== c.chatId) return; // чужие чаты молча пропускаем
  if (['start', 'help'].includes(cmd.cmd)) return tg.send(chatId, TG_HELP);
  if (cmd.cmd === 'status') return tg.send(chatId, tgStatus());
  if (cmd.cmd === 'report') return weeklyReport(true);
  if (!['on', 'off', 'say'].includes(cmd.cmd)) return tg.send(chatId, TG_HELP);
  if (!c.control) return tg.send(chatId, 'Управление из Telegram выключено. Включить: лаунчер → «Настройки» → «Telegram».');
  if (cmd.cmd === 'on') {
    if (state !== 'stopped') return tg.send(chatId, 'Сервер уже работает или запускается.');
    const last = readUi().lastStart;
    if (!last) return tg.send(chatId, 'Сначала запустите сервер хотя бы раз в лаунчере.');
    await tg.send(chatId, `Запускаю «${serverTitle(last.type, last.version)}»…`);
    return startServer({ ...last, eula: false }).catch((e) => tg.send(chatId, `Не запустился: ${e.message}`));
  }
  if (cmd.cmd === 'off') {
    if (!child) return tg.send(chatId, 'Сервер и так выключен.');
    runCmd('say Сервер выключается по команде администратора');
    stopServer();
    return tg.send(chatId, 'Останавливаю сервер…');
  }
  if (!child || state !== 'running') return tg.send(chatId, 'Сервер не запущен.');
  if (!cmd.arg) return tg.send(chatId, 'Напишите текст после команды: /say Всем привет');
  runCmd(chat.tellraw('@a', cmd.arg));
  addChat({ name: null, text: cmd.arg.slice(0, 240), at: Date.now(), own: true, via: 'telegram' });
  return tg.send(chatId, 'Отправлено.');
}

handle('tg:get', () => tgInfo());
handle('tg:connect', async ({ token }) => {
  const t = String(token || '').trim();
  if (!t) {
    // Уже подключён — только новый код привязки.
    if (!tgToken()) throw new Error('Вставьте токен бота');
    tgNewCode();
    return tgInfo();
  }
  const me = await tg.me(t);
  const enc = safeStorage.isEncryptionAvailable();
  tgWrite({ token: enc ? safeStorage.encryptString(t).toString('base64') : t, enc, bot: me.username, chatId: null, chatName: '' });
  tgNewCode();
  tg.start(t);
  return tgInfo();
});
handle('tg:set', ({ events, control }) => {
  const e = events || {};
  tgWrite({ events: { start: !!e.start, players: !!e.players, crash: !!e.crash, report: e.report !== false }, control: !!control });
  return tgInfo();
});
handle('tg:test', async () => {
  const c = tgRead();
  if (!c.chatId) throw new Error('Сначала привяжите чат');
  if (!tg.running) throw new Error('Бот не работает — подключите его заново');
  await tg.send(c.chatId, `✅ Проверка: лаунчер на связи.\n\n${tgStatus()}`);
});
handle('tg:disconnect', () => {
  tg.stop();
  tgCode = null;
  fs.rmSync(TG_FILE(), { force: true });
  return tgInfo();
});
handle('tg:openBot', () => {
  const c = tgRead();
  if (!/^\w{3,40}$/.test(c.bot || '')) return;
  const code = tgCode && tgCode.until > Date.now() ? tgCode.code : '';
  shell.openExternal(`https://t.me/${c.bot}${code ? `?start=${code}` : ''}`);
});
app.on('will-quit', () => tg.stop());

// ---- тихие запросы к серверу: ответы не показываются в консоли ----

let quietUntil = 0;
const quietWaiters = [];
function quietLine(line) {
  const w = quietWaiters.shift();
  if (!w) return;
  clearTimeout(w.timer);
  w.resolve(line);
}
/** Отправить команду и дождаться её ответа (по одной за раз). Пустая строка — сервер не ответил. */
function quietAsk(cmd, ms = 3000) {
  return new Promise((resolve) => {
    const w = { resolve };
    w.timer = setTimeout(() => {
      const i = quietWaiters.indexOf(w);
      if (i >= 0) quietWaiters.splice(i, 1);
      resolve('');
    }, ms);
    quietWaiters.push(w);
    quietUntil = Date.now() + ms + 500;
    runCmd(cmd);
  });
}

// ---- карточка игрока ----

const liveFor = (type, version) => isCurrent(type, version) && state === 'running';

handle('player:card', async ({ type, version, name }) => {
  if (!players.NAME_RE.test(String(name || ''))) throw new Error('Некорректный ник');
  const dir = serverDir(type, version);
  const props = core.readProps(dir);
  const level = props['level-name'] || 'world';
  const offline = props['online-mode'] === 'false';
  const uuid = playercard.uuidFromCache(dir, name) || (offline ? players.offlineUuid(name) : null);
  const isOnline = liveFor(type, version) && [...online].some((n) => n.toLowerCase() === name.toLowerCase());
  let data = null;
  try {
    data = uuid ? playercard.read(dir, level, uuid) : null;
  } catch {
    data = null;
  }
  if (isOnline) {
    const pos = lag.parseReply('pos', await quietAsk(`data get entity ${name} Pos`));
    if (pos) data = { ...(data || { items: [] }), pos, savedAt: Date.now() };
  }
  const stats = playtime.list(dir).find((p) => p.name.toLowerCase() === name.toLowerCase()) || null;
  const lists = players.readLists(dir);
  const has = (l) => l.some((x) => (x.name || '').toLowerCase() === name.toLowerCase());
  return { name, uuid, online: isOnline, data, stats, op: has(lists.ops), banned: has(lists.bans) };
});

handle('player:do', ({ type, version, name, action, item, count, target, mode }) => {
  if (!players.NAME_RE.test(String(name || ''))) throw new Error('Некорректный ник');
  if (!liveFor(type, version)) throw new Error('Сервер не запущен');
  if (action === 'give') {
    const id = String(item || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!/^([a-z0-9_.-]+:)?[a-z0-9_./-]{1,64}$/.test(id)) throw new Error('Название предмета — латиницей, например diamond или minecraft:oak_log');
    const n = Math.round(Number(count) || 1);
    if (n < 1 || n > 2304) throw new Error('Количество — от 1 до 2304');
    runCmd(`give ${name} ${id} ${n}`);
  } else if (action === 'tp') {
    const t = String(target || '').trim();
    if (players.NAME_RE.test(t)) runCmd(`tp ${name} ${t}`);
    else if (/^-?\d{1,8} -?\d{1,4} -?\d{1,8}$/.test(t)) runCmd(`tp ${name} ${t}`);
    else throw new Error('Укажите ник другого игрока или координаты «x y z»');
  } else if (action === 'mode') {
    if (!['survival', 'creative', 'adventure', 'spectator'].includes(mode)) throw new Error('Неизвестный режим');
    runCmd(`gamemode ${mode} ${name}`);
  } else if (action === 'kick') {
    runCmd(`kick ${name}`);
  } else throw new Error('Неизвестное действие');
});

// ---- граница мира ----

function chunkyInstalled(dir) {
  for (const sub of ['plugins', 'mods']) {
    try {
      if (fs.readdirSync(path.join(dir, sub)).some((f) => /chunky/i.test(f) && /\.jar$/i.test(f))) return true;
    } catch {
      /* папки нет */
    }
  }
  return false;
}
handle('border:apply', ({ type, version, size, x, z, pregen }) => {
  if (!liveFor(type, version)) throw new Error('Сначала запустите сервер');
  const s = Math.round(Number(size));
  if (!Number.isInteger(s) || s < 50 || s > 59999968) throw new Error('Размер — от 50 блоков');
  const cx = Math.round(Number(x) || 0);
  const cz = Math.round(Number(z) || 0);
  if (Math.abs(cx) > 29999984 || Math.abs(cz) > 29999984) throw new Error('Центр слишком далеко');
  const dir = serverDir(type, version);
  if (pregen) {
    if (!chunkyInstalled(dir)) throw new Error('Для прогрузки нужен Chunky — установите его в карточке «Прогрузить мир заранее» ниже');
    if (s > 100000) throw new Error('Прогрузить можно мир размером до 100 000 блоков');
  }
  runCmd(`worldborder center ${cx} ${cz}`);
  runCmd(`worldborder set ${s}`);
  if (pregen) {
    runCmd(`chunky center ${cx} ${cz}`);
    runCmd('chunky shape square');
    runCmd(`chunky radius ${Math.ceil(s / 2)}`);
    runCmd('chunky start');
    chunky = { pct: 0, eta: '', world: '', done: false };
    send('chunky', chunky);
  }
  return { chunky: !!pregen };
});
handle('border:remove', ({ type, version }) => {
  if (!liveFor(type, version)) throw new Error('Сначала запустите сервер');
  runCmd('worldborder set 59999968');
});

// ---- копии: что изменилось и откат части мира ----

handle('regions:compare', async ({ type, version, file }) => {
  const dir = serverDir(type, version);
  const res = await regions.compare(dir, backup.backupPath(dir, file), backup.worldDirs(dir));
  return { total: res.length, list: res.slice(0, 60) };
});
handle('regions:restore', async ({ type, version, file, dim, list, x, z, r }) => {
  needStopped(type, version, 'вернуть часть мира');
  if (runner.has(bgKey(type, version))) throw new Error('Остановите сервер, чтобы вернуть часть мира');
  if (!['overworld', 'nether', 'end'].includes(dim)) throw new Error('Неизвестное измерение');
  const dir = serverDir(type, version);
  const src = backup.backupPath(dir, file);
  let regs;
  if (Array.isArray(list) && list.length) {
    regs = list.map((p) => [Number(p[0]), Number(p[1])]);
    if (regs.length > 64 || regs.some(([a, b]) => !Number.isInteger(a) || !Number.isInteger(b))) throw new Error('Некорректный список областей');
  } else {
    const [cx, cz, rr] = [Number(x), Number(z), Number(r)];
    if (![cx, cz, rr].every(Number.isFinite) || rr < 0) throw new Error('Укажите координаты и радиус числами');
    regs = regions.regionsAround(Math.round(cx), Math.round(cz), Math.round(rr));
  }
  const level = core.readProps(dir)['level-name'] || 'world';
  log('Сохраняю текущий мир копией перед откатом части мира…');
  const safety = await backup.create(dir, 'before-restore');
  const res = await regions.restore(dir, src, level, dim, regs);
  send('backups', { dir });
  log(`Часть мира возвращена из копии ${file}: областей ${regs.length}.`);
  return { ...res, regions: regs.length, safety: safety && safety.file };
});

// ---- почему тормозит ----

let lagBusy = false;
let lastLag = null;
let lowTps = 0;
let lastAutoLag = 0;

async function lagCheck() {
  if (!child || state !== 'running' || !current) throw new Error('Сервер не запущен');
  if (!lag.supported(current.version)) throw new Error('Поиск причин работает с Minecraft 1.13 и новее');
  if (lagBusy) throw new Error('Уже ищу — подождите несколько секунд');
  lagBusy = true;
  try {
    const names = [...online].filter((n) => players.NAME_RE.test(n)).slice(0, 20);
    const r = {};
    for (const q of lag.queries(names)) r[q.key] = lag.parseReply(q.kind, await quietAsk(q.cmd));
    const hints = lag.analyze(r, names);
    if (chunky && !chunky.done) hints.unshift({ level: 'info', text: 'Сейчас идёт прогрузка мира (Chunky) — пока она не закончится, сервер нагружен сильнее обычного.' });
    lastLag = { at: Date.now(), server: { ...current }, tps: lastTps ? lastTps.tps : null, total: r.total, hints };
    send('lag', lastLag);
    return lastLag;
  } finally {
    lagBusy = false;
  }
}
// Плавность держится ниже 15 полминуты — ищем причину сами (не чаще раза в 15 минут).
setInterval(() => {
  if (!child || state !== 'running' || !lastTps) {
    lowTps = 0;
    return;
  }
  lowTps = lastTps.tps < 15 ? lowTps + 1 : 0;
  if (lowTps < 3 || Date.now() - lastAutoLag < 15 * 60000 || !current || !lag.supported(current.version)) return;
  lastAutoLag = Date.now();
  lagCheck()
    .then((l) => log(`Сервер тормозит (${String(Math.round(l.tps * 10) / 10).replace('.', ',')} TPS). ${l.hints[0].text} Подробнее — «Обслуживание» → «Почему тормозит».`, 'error'))
    .catch(() => {});
}, 10000);
handle('lag:check', () => lagCheck());
handle('lag:get', () => lastLag);
handle('lag:fix', ({ fix }) => {
  const cmd = lag.FIXES[fix];
  if (!cmd) throw new Error('Неизвестное действие');
  if (!child || state !== 'running') throw new Error('Сервер не запущен');
  runCmd(cmd);
  log(fix === 'items' ? 'Предметы с земли убраны.' : 'Сферы опыта убраны.');
});

// ---- новая версия Minecraft ----

const mcnewCache = new Map();
handle('mcnew:check', async ({ type, version, loader, force }) => {
  const key = `${type}-${version}`;
  const c = mcnewCache.get(key);
  if (c && !force && Date.now() - c.at < 6 * 3600 * 1000) return c.value;
  const list = (await core.listVersions(type, false)).filter((v) => !v.pre).map((v) => v.id);
  const i = list.indexOf(version);
  let value = { current: version, latest: null };
  if (i > 0) {
    const latest = list[0];
    const dir = serverDir(type, version);
    const ready = [];
    const notReady = [];
    let unknown = 0;
    for (const kind of mods.kindsFor(type)) {
      const res = await mods.checkUpdates({ type, mc: latest, dir, kind, flavor: flavorFor(type, version, loader) });
      for (const x of res) {
        if (!x.known) unknown++;
        else if (x.latest) ready.push(x.title || x.file);
        else notReady.push(x.title || x.file);
      }
    }
    value = { current: version, latest, behind: i, ready, notReady, unknown };
  }
  mcnewCache.set(key, { at: Date.now(), value });
  return value;
});

// ---- датапаки ----

const levelOf = (dir) => (core.readProps(dir)['level-name'] || 'world').trim() || 'world';
const dpReload = (type, version) => {
  if (!liveFor(type, version)) return false;
  runCmd('reload');
  return true;
};
handle('dp:search', ({ version, query, offset }) => datapacks.search({ mc: version, query, offset }));
handle('dp:list', ({ type, version }) => {
  const dir = serverDir(type, version);
  return { list: datapacks.list(dir, levelOf(dir)), hasWorld: backup.worldDirs(dir).length > 0, live: liveFor(type, version) };
});
handle('dp:install', async ({ type, version, projectId, bySlug }) => {
  const dir = serverDir(type, version);
  const added = await datapacks.install({ mc: version, dir, level: levelOf(dir), projectId, bySlug: !!bySlug, onLog: log });
  return { added, reloaded: dpReload(type, version) };
});
handle('dp:add', async ({ type, version, folder }) => {
  const dir = serverDir(type, version);
  const r = await dialog.showOpenDialog(win, {
    title: folder ? 'Папка датапака (внутри есть pack.mcmeta)' : 'Файлы датапаков',
    properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    filters: folder ? undefined : [{ name: 'Датапак', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const added = r.filePaths.map((p) => datapacks.addLocal(dir, levelOf(dir), p));
  return { added, reloaded: dpReload(type, version) };
});
handle('dp:remove', async ({ type, version, file }) => {
  const dir = serverDir(type, version);
  await shell.trashItem(datapacks.packPath(dir, levelOf(dir), String(file || '')));
  datapacks.forget(dir, file);
  return { reloaded: dpReload(type, version) };
});
handle('dp:open', ({ type, version }) => {
  const dir = serverDir(type, version);
  const f = datapacks.folder(dir, levelOf(dir));
  fs.mkdirSync(f, { recursive: true });
  shell.openPath(f);
});

// ---- шаблоны миров ----

const TEMPLATES = {
  build: { props: { 'level-type': 'flat', gamemode: 'creative', difficulty: 'peaceful' }, rules: { doDaylightCycle: false, doWeatherCycle: false, keepInventory: true } },
  void: { props: { 'level-type': 'flat' }, voidWorld: true, rules: { keepInventory: true } },
  terralith: { props: {}, pack: 'terralith' },
  tectonic: { props: {}, pack: 'tectonic' },
};
handle('world:template', async ({ type, version, template, seed }) => {
  const t = TEMPLATES[template];
  if (!t) throw new Error('Неизвестный шаблон');
  const dir = serverDir(type, version);
  if (backup.worldDirs(dir).length) throw new Error('Мир уже создан — шаблон применяется только к новому миру');
  const props = { ...t.props, 'level-seed': String(seed || '') };
  if (props['level-type']) props['level-type'] = servers.levelTypeValue(version, props['level-type']);
  if (t.voidWorld) {
    if (!/^(1\.(19|2\d)|[2-9]\d\.)/.test(version)) throw new Error('Пустой мир с платформой — для Minecraft 1.19 и новее');
    props['generator-settings'] = JSON.stringify({ layers: [{ block: 'minecraft:air', height: 1 }], biome: 'minecraft:the_void', features: true, lakes: false, structure_overrides: [] });
  }
  core.writeProps(dir, props);
  if (t.rules) backup.writeSettings(dir, { gamerules: { ...backup.readSettings(dir).gamerules, ...t.rules } });
  if (t.pack) {
    log(`Шаблон мира: ставлю датапак ${t.pack}…`);
    await datapacks.install({ mc: version, dir, level: levelOf(dir), projectId: t.pack, bySlug: true, onLog: log });
  }
});

// ---- игровые события ----

const funTimers = new Map(); // событие → таймер окончания
const FUN_FILE = (dir) => path.join(dir, 'mcl-events.json');
function funPending(dir) {
  try {
    return JSON.parse(fs.readFileSync(FUN_FILE(dir), 'utf8')) || {};
  } catch {
    return {};
  }
}
function funSavePending(dir, data) {
  if (Object.keys(data).length) fs.writeFileSync(FUN_FILE(dir), JSON.stringify(data, null, 2), 'utf8');
  else fs.rmSync(FUN_FILE(dir), { force: true });
}
function funState(type, version) {
  const dir = serverDir(type, version);
  const p = isCurrent(type, version) ? funPending(dir) : {};
  return {
    active: Object.entries(p).map(([id, e]) => ({ id, title: fun.EVENTS[id] ? fun.EVENTS[id].title : id, until: e.until })),
    achievements: fun.list(dir),
    enabled: backup.readSettings(dir).achievements,
  };
}
function funEnd(id, quiet) {
  clearTimeout(funTimers.get(id));
  funTimers.delete(id);
  if (!current) return;
  const dir = serverDir(current.type, current.version);
  const p = funPending(dir);
  const e = p[id];
  if (!e) return;
  if (child && state === 'running') {
    for (const c of e.end) runCmd(c);
    if (!quiet && e.endSay) runCmd(fun.tellAll(e.endSay, 'yellow'));
    delete p[id];
    funSavePending(dir, p);
  }
  send('fun', funState(current.type, current.version));
}
handle('fun:event', ({ type, version, id, arg }) => {
  if (!liveFor(type, version)) throw new Error('Сначала запустите сервер');
  const ev = fun.EVENTS[id];
  if (!ev) throw new Error('Неизвестное событие');
  const dir = serverDir(type, version);
  if (funPending(dir)[id]) throw new Error('Это событие уже идёт');
  const b = ev.build(version, arg);
  for (const c of b.start) runCmd(c);
  runCmd(fun.tellAll(b.say));
  if (b.end && b.minutes) {
    const p = funPending(dir);
    p[id] = { end: b.end, endSay: b.endSay, until: Date.now() + b.minutes * 60000 };
    funSavePending(dir, p);
    funTimers.set(id, setTimeout(() => funEnd(id), b.minutes * 60000));
  }
  log(`Событие «${ev.title}» запущено.`);
  return funState(type, version);
});
handle('fun:stop', ({ type, version, id }) => {
  if (!liveFor(type, version)) throw new Error('Сервер не запущен');
  funEnd(String(id));
  return funState(type, version);
});
handle('fun:get', ({ type, version }) => funState(type, version));
handle('fun:setAchievements', ({ type, version, on }) => {
  backup.writeSettings(serverDir(type, version), { achievements: !!on });
  return funState(type, version);
});
/** Сервер запустился: события, которые не успели закончиться, — завершить или продолжить. */
function funResume() {
  if (!current) return;
  const dir = serverDir(current.type, current.version);
  const p = funPending(dir);
  for (const [id, e] of Object.entries(p)) {
    const left = e.until - Date.now();
    if (left <= 0) {
      for (const c of e.end) runCmd(c);
      delete p[id];
    } else funTimers.set(id, setTimeout(() => funEnd(id), left));
  }
  funSavePending(dir, p);
}
function funStopTimers() {
  for (const t of funTimers.values()) clearTimeout(t);
  funTimers.clear();
}

// ---- достижения сервера ----

const joinAt = new Map();
function achAnnounce(a) {
  runCmd(fun.tellAll('★ ' + a.text, 'gold'));
  log('Достижение: ' + a.text);
  tgNotify('players', '🏆 ' + a.text);
  const s = currentSettings();
  if (s && s.discord.url && s.discord.players) discord.send(s.discord.url, '🏆 ' + escapeMd(a.text));
  if (current) send('fun', funState(current.type, current.version));
}
function achLine(line) {
  if (!current || state !== 'running') return;
  const dir = serverDir(current.type, current.version);
  if (!backup.readSettings(dir).achievements) return;
  const a = fun.onLine(dir, line);
  if (a) achAnnounce(a);
}
function achPlayer(name, joined) {
  if (joined) joinAt.set(name, Date.now());
  else joinAt.delete(name);
}
setInterval(() => {
  if (!child || state !== 'running' || !current || !joinAt.size) return;
  const dir = serverDir(current.type, current.version);
  if (!backup.readSettings(dir).achievements) return;
  const saved = Object.fromEntries(playtime.list(dir).map((p) => [p.name, p.total]));
  const totals = {};
  for (const [name, at] of joinAt) totals[name] = (saved[name] || 0) + (Date.now() - at);
  for (const a of fun.onHours(dir, totals)) achAnnounce(a);
}, 60000);

// ---- проверка копий ----

let verifyBusy = false;
async function verifyBackup(dir, file) {
  if (verifyBusy) throw new Error('Копия уже проверяется');
  verifyBusy = true;
  try {
    const r = await backupcheck.verify(backup.backupPath(dir, file));
    const res = { ok: true, at: Date.now(), regions: r.regions, files: r.files };
    backupcheck.saveState(dir, file, res);
    return res;
  } catch (e) {
    const res = { ok: false, at: Date.now(), error: e.message };
    backupcheck.saveState(dir, file, res);
    return res;
  } finally {
    verifyBusy = false;
  }
}
handle('bk:verify', async ({ type, version, file }) => {
  const dir = serverDir(type, version);
  const list = backup.list(dir);
  const f = file || (list[0] && list[0].file);
  if (!f) throw new Error('Копий пока нет');
  return { file: f, ...(await verifyBackup(dir, f)) };
});
handle('bk:state', ({ type, version }) => backupcheck.readState(serverDir(type, version)));
// Раз в час: если самая свежая копия сервера не проверялась, а прошлая проверка была больше недели назад, — проверить.
async function verifyTick() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(ROOT, d.name));
  } catch {
    return;
  }
  for (const dir of dirs) {
    if (backupBusy || verifyBusy) return;
    let list;
    try {
      list = backup.list(dir);
    } catch {
      continue;
    }
    if (!list.length) continue;
    const st = backupcheck.readState(dir);
    const last = Math.max(0, ...Object.values(st).map((x) => x.at || 0));
    if (st[list[0].file] || Date.now() - last < 7 * 24 * 3600 * 1000) continue;
    const r = await verifyBackup(dir, list[0].file).catch(() => null);
    if (r && !r.ok) {
      const name = path.basename(dir);
      log(`Копия мира ${list[0].file} (${name}) повреждена: ${r.error}. Сделайте новую копию.`, 'error');
      notify('Копия мира повреждена', `${name}: ${r.error}. Сделайте новую копию.`, true);
      tgNotify('crash', `⚠️ Копия мира ${name} повреждена: ${r.error}`);
    }
  }
}
setInterval(verifyTick, 3600 * 1000);
setTimeout(verifyTick, 5 * 60 * 1000);

// ---- открытка-приглашение ----

handle('invite:data', async ({ type, version }) => {
  const dir = serverDir(type, version);
  const props = core.readProps(dir);
  const iconFile = path.join(dir, 'server-icon.png');
  const icon = fs.existsSync(iconFile) ? fs.readFileSync(iconFile) : fs.readFileSync(path.join(__dirname, 'build', 'icon.png'));
  const s = backup.readSettings(dir);
  return {
    title: s.name || serverTitle(type, version),
    version,
    motd: String(props.motd || '').replace(/§./g, ''),
    tunnel: s.tunnel.address || '',
    port: Number(props['server-port']) || 25565,
    icon: new Uint8Array(icon),
    modded: isModded(type),
  };
});
function pngFromData(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Некорректная картинка');
  return Buffer.from(m[1], 'base64');
}
handle('invite:copy', ({ png }) => {
  clipboard.writeImage(nativeImage.createFromBuffer(pngFromData(png)));
});
handle('invite:save', async ({ png, name }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить открытку',
    defaultPath: path.join(app.getPath('desktop'), singleplayer.safeName(name || 'Приглашение') + '.png'),
    filters: [{ name: 'Картинка PNG', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, pngFromData(png));
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

// ---- карта мира ----

const { Worker } = require('worker_threads');
let mapWorker = null;
let mapSeq = 0;
const mapJobs = new Map();
const mapCache = new Map(); // файл|mtime|scale → { size, rgba }
function worker() {
  if (mapWorker) return mapWorker;
  // В собранной программе поток читает файлы из распакованной копии (app.asar.unpacked).
  const file = path.join(__dirname, 'lib', 'mapworker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  mapWorker = new Worker(file);
  mapWorker.on('message', (m) => {
    const job = mapJobs.get(m.id);
    if (!job) return;
    mapJobs.delete(m.id);
    if (m.error) job.reject(new Error(m.error));
    else job.resolve({ size: m.size, rgba: m.rgba });
  });
  mapWorker.on('error', (e) => {
    for (const j of mapJobs.values()) j.reject(e);
    mapJobs.clear();
    mapWorker = null;
  });
  mapWorker.unref();
  return mapWorker;
}
function mapDimDir(dir, dim) {
  const level = levelOf(dir);
  for (const p of regions.prefixesFor(level, dim)) {
    const full = path.join(dir, p, 'region');
    if (fs.existsSync(full)) return full;
  }
  return null;
}
handle('map:regions', ({ type, version, dim }) => {
  if (!['overworld', 'end'].includes(dim)) throw new Error('Неизвестное измерение');
  const dir = serverDir(type, version);
  const rd = mapDimDir(dir, dim);
  const list = [];
  if (rd) {
    for (const f of fs.readdirSync(rd)) {
      const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
      if (m && fs.statSync(path.join(rd, f)).size > 8192) list.push([Number(m[1]), Number(m[2])]);
    }
  }
  // Игроки: из их файлов (где вышли) и из живого списка.
  const level = levelOf(dir);
  const people = [];
  const known = playtime.list(dir).slice(0, 60);
  for (const p of known) {
    const uuid = playercard.uuidFromCache(dir, p.name) || (core.readProps(dir)['online-mode'] === 'false' ? players.offlineUuid(p.name) : null);
    let d = null;
    try {
      d = uuid ? playercard.read(dir, level, uuid) : null;
    } catch {
      d = null;
    }
    if (!d || !d.pos) continue;
    const pdim = /Энд/.test(d.dimension) ? 'end' : /Нижний/.test(d.dimension) ? 'nether' : 'overworld';
    if (pdim !== dim) continue;
    people.push({ name: p.name, x: d.pos[0], z: d.pos[2], online: liveFor(type, version) && online.has(p.name) });
  }
  return { list, players: people };
});
handle('map:tile', async ({ type, version, dim, rx, rz, scale }) => {
  const dir = serverDir(type, version);
  const rd = mapDimDir(dir, dim);
  if (!rd || !Number.isInteger(rx) || !Number.isInteger(rz)) return null;
  const sc = [1, 2, 4, 8].includes(scale) ? scale : 4;
  const file = path.join(rd, `r.${rx}.${rz}.mca`);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${file}|${st.mtimeMs}|${sc}`;
  if (mapCache.has(key)) return mapCache.get(key);
  const id = ++mapSeq;
  const res = await new Promise((resolve, reject) => {
    mapJobs.set(id, { resolve, reject });
    worker().postMessage({ id, file, scale: sc });
  });
  mapCache.set(key, res);
  if (mapCache.size > 300) mapCache.delete(mapCache.keys().next().value);
  return res;
});

// ---- мини-окно ----

let widget = null;
const WIDGET_EVENTS = new Set(['state', 'stats', 'players']);
function saveWidget(patch) {
  try {
    const ui = readUi();
    fs.writeFileSync(UI_FILE(), JSON.stringify({ ...ui, widget: { ...(ui.widget || {}), ...patch } }), 'utf8');
  } catch {
    /* не страшно */
  }
}
function openWidget() {
  if (widget && !widget.isDestroyed()) {
    widget.showInactive();
    return;
  }
  const b = readUi().widget || {};
  widget = new BrowserWindow({
    width: 300,
    height: 132,
    x: Number.isInteger(b.x) ? b.x : undefined,
    y: Number.isInteger(b.y) ? b.y : undefined,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: themeBackground(),
    title: 'Блокхост — мини-окно',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  widget.setAlwaysOnTop(true, 'floating');
  widget.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widget.once('ready-to-show', () => widget && widget.showInactive());
  widget.on('moved', () => {
    if (!widget) return;
    const [x, y] = widget.getPosition();
    saveWidget({ x, y });
  });
  widget.on('closed', () => {
    widget = null;
    if (!quitRequested) saveWidget({ open: false });
  });
  saveWidget({ open: true });
}
function widgetSend(channel, payload) {
  if (widget && !widget.isDestroyed() && WIDGET_EVENTS.has(channel)) widget.webContents.send(channel, payload);
}
handle('widget:open', () => openWidget());
handle('widget:close', () => {
  if (widget && !widget.isDestroyed()) widget.close();
});
handle('widget:main', () => showWindow());
handle('widget:info', () => {
  const last = readUi().lastStart;
  return {
    state,
    title: current ? serverTitle(current.type, current.version) : last ? serverTitle(last.type, last.version) : null,
    players: online.size,
    max: maxPlayers,
    tps: lastTps,
    canStart: state === 'stopped' && !!last,
  };
});
handle('widget:start', () => {
  if (state !== 'stopped') throw new Error('Сервер уже работает');
  const last = readUi().lastStart;
  if (!last) throw new Error('Сначала запустите сервер в лаунчере');
  return startServer({ ...last, eula: false });
});
app.whenReady().then(() => {
  if ((readUi().widget || {}).open) setTimeout(openWidget, 1500);
});

// ---- поиск мода, из-за которого сервер падает ----
// Запуски идут на временном мире (настоящий мир без половины модов испортился бы),
// выключенные моды лежат в mcl-modtest-off. Всё возвращается на место в любом случае.

function modtestPush() {
  send('modtest', modTest ? { ...modTest.pub } : null);
}
function modtestBoot(dir, java, ram, inst) {
  return new Promise((resolve) => {
    const tail = [];
    let done = false;
    const proc = spawn(java.path, ['-Xms1G', `-Xmx${java.bits === 32 ? 1 : ram}G`, '-Djava.net.useSystemProxies=true', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', ...inst.args, 'nogui'], { cwd: dir, windowsHide: true });
    modTest.proc = proc;
    const hang = setTimeout(() => {
      tail.push('[лаунчер] Сервер не запустился за 15 минут — считаю, что он завис.');
      proc.kill();
    }, 15 * 60000);
    const onData = (d) => {
      for (const raw of String(d).split('\n')) {
        const line = cleanLine(raw);
        if (!line) continue;
        tail.push(line);
        if (tail.length > 80) tail.shift();
        if (!done && /Done \(/.test(line)) {
          done = true;
          try {
            proc.stdin.write('stop\n');
          } catch {
            /* уже завершается */
          }
          setTimeout(() => proc.kill(), 90000).unref();
        }
      }
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => tail.push(e.message));
    proc.on('close', () => {
      clearTimeout(hang);
      modTest.proc = null;
      resolve({ ok: done, tail });
    });
  });
}

handle('modtest:get', () => (modTest ? { ...modTest.pub } : null));
handle('modtest:cancel', () => {
  if (!modTest) return;
  modTest.cancelled = true;
  if (modTest.proc) modTest.proc.kill();
  log('Поиск сломанного мода отменяется…');
});
handle('modtest:start', async ({ type, version }) => {
  if (modTest) throw new Error('Поиск уже идёт');
  if (state !== 'stopped' || child) throw new Error('Остановите сервер — поиск сам будет запускать его много раз');
  if (!isModded(type)) throw new Error('Поиск нужен только серверам с модами');
  const dir = serverDir(type, version);
  if (runner.has(bgKey(type, version))) throw new Error('Этот сервер работает в фоне — остановите его');
  if (!core.eulaAccepted(dir)) throw new Error('Сначала примите лицензионное соглашение и запустите сервер хотя бы раз');
  const inst = core.readInstall(dir);
  if (!inst) throw new Error('Сервер ещё не установлен — нажмите «Запустить» хотя бы раз');
  if (sleeper) await sleepCancel(false);
  const writeLevel = (lvl) => core.writeProps(dir, { 'level-name': lvl });
  if (bisect.pending(dir)) bisect.restore(dir, writeLevel);
  const list = bisect.graph(path.join(dir, 'mods'));
  if (!list.length) throw new Error('В папке mods нет модов');
  const params = startParams(type, version);
  const java = await chooseJava(type, version, params.javaPath);
  const ram = Math.max(1, Math.min(memoryInfo().maxGb, Math.round(Number(params.ramGb)) || 2));
  const search = bisect.createSearch(list);
  modTest = { dir, proc: null, cancelled: false, pub: { type, version, run: 0, left: search.left(), total: list.length, enabled: list.length, text: 'Делаю копию мира…' } };
  modtestPush();
  const nameOf = (f) => (list.find((m) => m.file === f) || {}).name || f;
  (async () => {
    let result = null;
    let lastTail = [];
    try {
      if (backup.worldDirs(dir).length) await makeBackup(dir, 'before-modtest', false);
      bisect.begin(dir, core.readProps(dir)['level-name'] || 'world');
      writeLevel(bisect.TEST_LEVEL);
      log(`Ищу мод, из-за которого падает сервер. Модов: ${list.length}, понадобится примерно ${search.left()} запусков. Запуски идут на временном мире — ваш мир не трогается.`);
      for (;;) {
        const step = search.next();
        if (step.done) {
          result = step;
          break;
        }
        if (modTest.cancelled) break;
        bisect.arrange(dir, step.enable);
        for (const sfx of ['', '_nether', '_the_end']) fs.rmSync(path.join(dir, bisect.TEST_LEVEL + sfx), { recursive: true, force: true });
        Object.assign(modTest.pub, { run: search.runs + 1, left: search.left(), enabled: step.enable.length, text: `Запуск ${search.runs + 1}: ${step.enable.length} модов из ${list.length}…` });
        modtestPush();
        log(modTest.pub.text);
        const r = await modtestBoot(dir, java, ram, inst);
        if (modTest.cancelled) break;
        log(r.ok ? '  → запустился нормально.' : '  → упал.', r.ok ? 'info' : 'error');
        if (!r.ok) lastTail = r.tail;
        search.report(!r.ok);
      }
    } catch (e) {
      log(`Поиск остановлен: ${e.message}`, 'error');
      result = { error: e.message };
    } finally {
      try {
        bisect.restore(dir, writeLevel);
      } catch (e) {
        log(`Не удалось вернуть всё на место: ${e.message}. Моды лежат в папке ${bisect.OFF_DIR} сервера.`, 'error');
      }
    }
    let out;
    if (modTest.cancelled) out = { cancelled: true };
    else if (!result || result.error) out = { error: (result && result.error) || 'Неизвестная ошибка' };
    else if (result.noRepro) out = { noRepro: true };
    else if (result.combo) out = { combo: true };
    else out = { culprit: { file: result.culprit, name: nameOf(result.culprit) }, needs: (result.needs || []).map(nameOf) };
    if (out.culprit) {
      log(`Нашёл: сервер падает из-за мода «${out.culprit.name}» (${out.culprit.file})${out.needs.length ? `, вместе с ${out.needs.join(', ')}` : ''}.`, 'error');
      const tail = lastTail.filter((l) => /error|exception|caused by/i.test(l)).slice(-3);
      if (tail.length) out.tail = tail;
    } else if (out.noRepro) log('Со всеми модами сервер на чистом мире запускается нормально — дело, похоже, в самом мире или в настройках.');
    else if (out.combo) log('Каждая половина модов по отдельности запускается — сервер падает только от сочетания модов.', 'error');
    else if (out.cancelled) log('Поиск отменён, всё вернул как было.');
    out.runs = search.runs;
    out.type = type;
    out.version = version;
    modTest = null;
    send('modtest', { done: true, ...out });
  })();
  return modTest.pub;
});
// Убрать найденный мод: файл переезжает в папку mods-disabled (не удаляется).
handle('modtest:disable', ({ type, version, file }) => {
  if (isCurrent(type, version) && state !== 'stopped') throw new Error('Остановите сервер');
  const dir = serverDir(type, version);
  const from = mods.modPath(type, dir, String(file || ''), 'mod');
  if (!fs.existsSync(from)) throw new Error('Файл мода не найден');
  const to = path.join(dir, 'mods-disabled', path.basename(from));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  log(`Мод ${path.basename(from)} убран в папку mods-disabled — вернуть можно, переложив его обратно в mods.`);
});
function modtestRecover() {
  try {
    for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(ROOT, d.name);
      if (bisect.pending(dir)) bisect.restore(dir, (lvl) => core.writeProps(dir, { 'level-name': lvl }));
    }
  } catch {
    /* папки серверов ещё нет */
  }
}

// ---- «моды не совпадают»: что прислал друг ----

handle('mismatch:analyze', ({ type, version, text }) => {
  const t = String(text || '').slice(0, 50000);
  if (!t.trim()) throw new Error('Вставьте текст ошибки, который видит друг');
  const r = mismatch.analyze(t, bisect.graph(path.join(serverDir(type, version), 'mods')));
  return {
    found: r.found,
    missing: r.missing.map((m) => ({ name: m.name, file: m.file })),
    mismatch: r.mismatch.map((m) => ({ name: m.name, file: m.file })),
    extra: r.extra,
  };
});

// ---- рецепт сервера ----

let pendingRecipe = null;
handle('recipe:export', async ({ type, version }) => {
  const dir = serverDir(type, version);
  const st = backup.readSettings(dir);
  const inst = core.readInstall(dir);
  const loader = (inst && inst.loader) || startParams(type, version).loader || null;
  const title = st.name || serverTitle(type, version);
  log('Собираю рецепт сервера: узнаю моды на Modrinth…');
  const { recipe: r, manual } = await recipe.build({ dir, type, mc: version, loader: isModded(type) ? loader : null, name: title, props: core.readProps(dir), gamerules: st.gamerules });
  const safe = title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'server';
  const res = await dialog.showSaveDialog(win, {
    title: 'Сохранить рецепт сервера',
    defaultPath: path.join(app.getPath('desktop'), `${safe}.${recipe.EXT}`),
    filters: [{ name: 'Рецепт Блокхоста', extensions: [recipe.EXT] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, JSON.stringify(r, null, 1), 'utf8');
  log(`Рецепт сохранён: ${res.filePath}.`);
  return { file: res.filePath, files: r.files.length, manual };
});
handle('recipe:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Рецепт сервера',
    filters: [{ name: 'Рецепт Блокхоста', extensions: [recipe.EXT] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const file = res.filePaths[0];
  if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('Файл слишком большой для рецепта');
  const plan = recipe.parse(fs.readFileSync(file, 'utf8'));
  const dir = serverDir(plan.type, plan.mc);
  pendingRecipe = plan;
  return { name: plan.name, type: plan.type, mc: plan.mc, loader: plan.loader, files: plan.files.length, manual: plan.manual, exists: fs.existsSync(dir) && fs.readdirSync(dir).length > 0 };
});
handle('recipe:apply', async () => {
  const plan = pendingRecipe;
  if (!plan) throw new Error('Сначала откройте рецепт');
  const dir = serverDir(plan.type, plan.mc);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`Сервер ${serverTitle(plan.type, plan.mc)} уже есть — удалите его или перенесите на другую версию, чтобы поставить рецепт`);
  pendingRecipe = null;
  fs.mkdirSync(dir, { recursive: true });
  try {
    log(`Ставлю сервер по рецепту «${plan.name || serverTitle(plan.type, plan.mc)}»: файлов ${plan.files.length}…`);
    await recipe.apply(plan, dir, { onLog: (t) => log(t), onProgress: (done, total) => send('progress', { got: done, total }) });
    core.writeProps(dir, plan.props);
    backup.writeSettings(dir, { gamerules: plan.gamerules, name: plan.name });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  log(`Готово. Осталось принять лицензионное соглашение и нажать «Запустить» — лаунчер сам поставит ${plan.type} для Minecraft ${plan.mc}.`);
  return { type: plan.type, mc: plan.mc, loader: plan.loader, manual: plan.manual };
});

// ---- отчёт за неделю в Telegram ----

async function weeklyReport(force) {
  const c = tgRead();
  if (!c.chatId || !tg.running) return false;
  if (!force && (!{ ...TG_EVENTS, ...(c.events || {}) }.report || !report.due(c.lastReport))) return false;
  const sizes = { ...(c.reportSizes || {}) };
  let sent = 0;
  let dirs = [];
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-z]+-.+$/.test(d.name)).map((d) => d.name);
  } catch {
    /* серверов нет */
  }
  for (const name of dirs) {
    const dir = path.join(ROOT, name);
    const r = report.collect(dir);
    if (!r.active) continue;
    const i = name.indexOf('-');
    let bytes = 0;
    for (const w of backup.worldDirs(dir)) bytes += await disk.dirSize(path.join(dir, w));
    await tg.send(c.chatId, report.text(serverTitle(name.slice(0, i), name.slice(i + 1)), r, bytes, sizes[name]));
    sizes[name] = bytes;
    sent++;
  }
  if (!sent && force) await tg.send(c.chatId, 'За неделю серверы не запускались — отчитываться не о чем.');
  tgWrite({ lastReport: Date.now(), reportSizes: sizes });
  return true;
}
setInterval(() => weeklyReport(false).catch(() => {}), 3600000);
setTimeout(() => weeklyReport(false).catch(() => {}), 60000);
handle('tg:report', () => weeklyReport(true));

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
  if (sleeper && !child) return sleepCancel(false);
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

handle('pack:export', async ({ type, version, files, format, name, packVersion, address, includeConfig, openApp }) => {
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
  // «Открыть в Modrinth App»: сборка сохраняется в папку лаунчера и сразу открывается
  // в Modrinth App — там она ставится как отдельный профиль одной кнопкой.
  if (openApp && fmt === 'mrpack') {
    const packsDir = path.join(app.getPath('userData'), 'packs');
    fs.mkdirSync(packsDir, { recursive: true });
    const out = path.join(packsDir, `${safe} ${ver}.mrpack`);
    const inst = core.readInstall(dir);
    const res = pack.build({
      format: 'mrpack',
      items,
      modsDir,
      configDir: path.join(dir, 'config'),
      includeConfig: !!includeConfig,
      name: title,
      packVersion: ver,
      mc: version,
      loader: await core.clientLoader(type, version, inst && inst.loader),
      server: addr ? { name: title, address: addr } : null,
      outFile: out,
    });
    if (!modrinthAppInstalled()) return { path: out, ...res, noApp: true };
    const err = await shell.openPath(out);
    if (err) return { path: out, ...res, noApp: true };
    log(`Сборка «${title}» открыта в Modrinth App.`);
    return { path: out, ...res, opened: true };
  }
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
function modrinthAppInstalled() {
  try {
    return !!app.getApplicationNameForProtocol('modrinth://');
  } catch {
    return false;
  }
}
handle('pack:modrinthApp', () => shell.openExternal('https://modrinth.com/app'));
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
  return shell.openExternal(`https://modrinth.com/${['plugin', 'datapack'].includes(kind) ? kind : 'mod'}/${slug}`);
});

function createWindow(hidden = false) {
  win = new BrowserWindow({
    show: !hidden,
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: themeBackground(),
    autoHideMenuBar: true,
    title: 'Блокхост — сервер Minecraft',
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
    const hidden = process.argv.includes('--hidden');
    createWindow(hidden);
    if (hidden) ensureTray();
    autoStartServer();
    if (readUi().remote) remote.enable(8765).catch((e) => log(`Управление с телефона не включилось: ${e.message}`, 'error'));
    updater.init(send);
    tgBoot();
    modtestRecover();
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
  if (sleeper) sleepCancel(false);
  if (runner.list().length) {
    e.preventDefault();
    runner.stopAll().then(() => app.quit());
    return;
  }
  if (child) {
    e.preventDefault();
    quitting = true;
    stopServer();
  }
});
app.on('window-all-closed', () => app.quit());
// Серверы на VPS продолжают работать — закрываем только SSH-соединения.
app.on('will-quit', () => {
  remote.disable();
  if (vpsApi) vpsApi.shutdown();
  if (playitAuto) stopPlayit();
});
