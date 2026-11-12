// Обновления с GitHub Releases.
// Установленная версия (NSIS) скачивает и ставит обновление сама (electron-updater),
// портативная — показывает описание новой версии и открывает страницу загрузки.
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const core = require('./core');

let REPO = null;
try {
  REPO = require('./repo.json'); // { owner, repo } — заполняется при подготовке выпуска
} catch {
  REPO = null;
}

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;
const releasesApi = () => `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases`;
const releasePage = (v) => `https://github.com/${REPO.owner}/${REPO.repo}/releases/tag/v${v}`;

let send = () => {};
let autoUpdater = null;
let state = { status: 'idle' }; // idle | checking | none | available | downloading | ready | error
let checking = false;

function setState(patch) {
  state = { ...state, ...patch };
  send('update', state);
}

/** Описание версии со страницы выпуска на GitHub (markdown). */
async function releaseNotes(version) {
  try {
    const r = await core.getJson(`${releasesApi()}/tags/v${encodeURIComponent(version)}`);
    return typeof r.body === 'string' ? r.body : '';
  } catch {
    return '';
  }
}

/** Описание версии из CHANGELOG.md, который едет внутри программы. */
function changelogNotes(version) {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp(`^## ${esc}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

async function check(manual) {
  if (!REPO || !app.isPackaged || checking) return state;
  if (['downloading', 'ready'].includes(state.status)) return state;
  checking = true;
  setState({ status: 'checking', manual: !!manual });
  try {
    if (isPortable()) {
      const r = await core.getJson(`${releasesApi()}/latest`);
      const latest = String(r.tag_name || '').replace(/^v/, '');
      if (latest && core.cmpVer(latest, app.getVersion()) > 0) {
        setState({ status: 'available', version: latest, notes: r.body || '', mode: 'portable' });
      } else {
        setState({ status: 'none' });
      }
    } else {
      const res = await autoUpdater.checkForUpdates();
      const v = res && res.updateInfo && res.updateInfo.version;
      if (!v || core.cmpVer(v, app.getVersion()) <= 0) setState({ status: 'none' });
      // иначе состояние выставит событие update-available
    }
  } catch (e) {
    setState({ status: 'error', error: e && e.message ? e.message.split('\n')[0] : String(e) });
  } finally {
    checking = false;
  }
  return state;
}

async function download() {
  if (state.status !== 'available') throw new Error('Нет доступного обновления');
  if (state.mode === 'portable') {
    await shell.openExternal(releasePage(state.version));
    return;
  }
  setState({ status: 'downloading', percent: 0 });
  autoUpdater.downloadUpdate().catch((e) => setState({ status: 'error', error: e.message.split('\n')[0] }));
}

function install() {
  if (state.status !== 'ready') throw new Error('Обновление ещё не скачано');
  autoUpdater.quitAndInstall(false, true);
}

/** Показать «что нового» один раз после обновления. */
function whatsNew() {
  const file = path.join(app.getPath('userData'), 'last-version.txt');
  let last = null;
  try {
    last = fs.readFileSync(file, 'utf8').trim();
  } catch {
    /* первый запуск */
  }
  const current = app.getVersion();
  try {
    fs.writeFileSync(file, current, 'utf8');
  } catch {
    /* не критично */
  }
  if (last && last !== current && core.cmpVer(current, last) > 0) {
    return { version: current, notes: changelogNotes(current) };
  }
  return null;
}

function init(sendFn) {
  send = sendFn;
  if (!REPO || !app.isPackaged) return;
  if (!isPortable()) {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', async (info) => {
      const notes = (await releaseNotes(info.version)) || changelogNotes(info.version);
      setState({ status: 'available', version: info.version, notes, mode: 'install' });
    });
    autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', () => setState({ status: 'ready' }));
    autoUpdater.on('error', (e) => {
      if (state.status === 'downloading') setState({ status: 'error', error: String(e && e.message || e).split('\n')[0] });
    });
  }
  setTimeout(() => check(false), 8000);
  setInterval(() => check(false), 6 * 60 * 60 * 1000);
}

module.exports = {
  init,
  check,
  download,
  install,
  whatsNew,
  getState: () => state,
  enabled: () => !!REPO && app.isPackaged,
};
