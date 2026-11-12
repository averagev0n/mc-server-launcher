const { app, BrowserWindow, ipcMain, shell, net, clipboard, safeStorage, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/core');
const mods = require('./lib/mods');
const configs = require('./lib/configs');
const updater = require('./lib/updater');
const diagnose = require('./lib/diagnose');
const { createVps, HostKeyError } = require('./lib/vps');

// Сеть через Chromium: так учитываются системные настройки прокси.
core.setFetch((url, opts) => net.fetch(url, opts));

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
  state = next;
  send('state', { state, current });
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
    log(`Сервер остановлен (код ${code === null ? '—' : code}).`, code ? 'error' : 'info');
    // Остановился сам с ошибкой — объясняем, что случилось.
    if (code && !stoppedByUser) {
      const found = flushIssues();
      if (!found) addIssue(diagnose.unknownCrash(code, issueCtx));
      log('Объяснение ошибки — в подсказках над консолью.', 'error');
    } else {
      flushIssues();
    }
    setState('stopped');
    if (installUpdateAfterStop) {
      installUpdateAfterStop = false;
      updater.install();
    } else if (quitting) {
      app.quit();
    } else if (restartPending && lastStart) {
      restartPending = false;
      log('Перезапускаю сервер…');
      startServer(lastStart).catch((e) => log(e.message, 'error'));
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

function addLogLine(line) {
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
handle('net:addresses', () => localAddresses());
handle('app:info', () => ({ root: ROOT, addresses: localAddresses(), state, current, memory: memoryInfo() }));
handle('server:info', async ({ type, version }) => {
  const dir = serverDir(type, version);
  const inst = core.readInstall(dir);
  return {
    dir,
    installed: !!inst,
    installedLoader: inst ? inst.loader || null : null,
    eula: core.eulaAccepted(dir),
    props: core.readProps(dir),
    javaNeeded: await core.requiredJava(version),
    kinds: mods.kindsFor(type),
    flavor: core.hybridFlavor(type, inst && inst.loader),
  };
});
handle('server:start', (opts) => startServer(opts));
handle('server:stop', () => {
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
handle('mods:install', async ({ type, version, projectId, kind, loader }) => {
  if (modBusy) throw new Error('Дождитесь окончания предыдущей установки');
  modBusy = true;
  try {
    const dir = serverDir(type, version);
    const flavor = flavorFor(type, version, loader);
    const added = await mods.installProject({ type, mc: version, dir, projectId, kind, flavor, onLog: log });
    if (added.length) {
      const running = current && current.type === type && current.version === version;
      log(`Установлено: ${added.join(', ')}.${running ? ' Перезапустите сервер, чтобы моды загрузились.' : ''}`);
    }
    return added;
  } finally {
    modBusy = false;
  }
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
    backgroundColor: '#14171c',
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
  win.on('closed', () => {
    win = null;
  });
}

// Одна копия лаунчера: вторая просто показывает уже открытое окно.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
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
  if (child) {
    e.preventDefault();
    quitting = true;
    stopServer();
  }
});
app.on('window-all-closed', () => app.quit());
// Серверы на VPS продолжают работать — закрываем только SSH-соединения.
app.on('will-quit', () => vpsApi && vpsApi.shutdown());
