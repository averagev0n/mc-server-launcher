// Логика без Electron: версии, загрузчики модов, установка сервера, Java, server.properties.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { execFile, spawn } = require('child_process');

const UA = 'mc-server-launcher/1.0';
const VANILLA_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEO_VERSIONS = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

const ARCLIGHT_RELEASES = 'https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=100';
const MOHIST_API = 'https://api.mohistmc.com/project';

const TYPES = ['vanilla', 'paper', 'fabric', 'forge', 'neoforge', 'arclight', 'mohist', 'youer'];
// Гибриды: моды + плагины Bukkit/Paper на одном сервере.
const HYBRID_TYPES = ['arclight', 'mohist', 'youer'];
const LOADER_TYPES = ['fabric', 'forge', 'neoforge', ...HYBRID_TYPES];
const FLAVOR_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const FORGE_MIN = '1.12.2'; // старее — другой установщик и только Java 8
const LAUNCH_FILE = 'launcher.json';

// ---- сеть ----

// В Electron сюда подставляется net.fetch — он учитывает системный прокси.
let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

// До трёх попыток при сетевых сбоях и ответах 5xx.
async function request(url) {
  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': UA } });
    } catch {
      lastErr = new Error(`Нет связи с ${host}. Проверьте интернет`);
      continue;
    }
    if (res.ok) return res;
    if (host === 'api.github.com' && (res.status === 403 || res.status === 429)) {
      throw new Error('GitHub временно ограничил число запросов с вашего адреса — попробуйте через час');
    }
    lastErr = new Error(`${host} ответил ошибкой ${res.status}`);
    if (res.status < 500) break;
  }
  throw lastErr;
}
const getJson = async (url) => (await request(url)).json();

/** POST с JSON (через тот же сетевой слой, что учитывает прокси). */
async function postJson(url, body) {
  const host = new URL(url).host;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Нет связи с ${host}. Проверьте интернет`);
  }
  if (!res.ok) throw new Error(`${host} ответил ошибкой ${res.status}`);
  return res.json();
}
const getText = async (url) => (await request(url)).text();

// Кэш на 10 минут; ошибка не кэшируется.
const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < 10 * 60 * 1000) return hit.promise;
  const promise = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { time: Date.now(), promise });
  return promise;
}

const vanillaManifest = () => cached('vanilla', () => getJson(VANILLA_MANIFEST));

/** Сравнение версий по числовым частям: '1.20.10' > '1.20.9'. */
function cmpVer(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function checkArgs(type, version, loader) {
  if (!TYPES.includes(type)) throw new Error('Неизвестный тип сервера');
  if (version !== undefined && !VERSION_RE.test(version)) throw new Error('Некорректная версия');
  if (loader !== undefined && loader !== null && !VERSION_RE.test(loader)) {
    throw new Error('Некорректная версия загрузчика');
  }
}

/** Оставляет версии, известные Mojang, и сортирует их от новых к старым. */
async function sortByManifest(ids) {
  const m = await vanillaManifest();
  const order = new Map(m.versions.map((v, i) => [v.id, i]));
  return [...new Set(ids)].filter((id) => order.has(id)).sort((a, b) => order.get(a) - order.get(b));
}

// ---- данные загрузчиков ----

function forgeData() {
  return cached('forge', async () => {
    const [xml, promos] = await Promise.all([
      getText(`${FORGE_MAVEN}/maven-metadata.xml`),
      getJson(FORGE_PROMOS).catch(() => ({ promos: {} })),
    ]);
    const byMc = new Map();
    for (const [, full] of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
      const m = full.match(/^(\d[\d.]*)-(\d[\d.]*)$/);
      if (!m || cmpVer(m[1], FORGE_MIN) < 0) continue;
      if (!byMc.has(m[1])) byMc.set(m[1], []);
      byMc.get(m[1]).push(m[2]);
    }
    for (const list of byMc.values()) list.sort((a, b) => cmpVer(b, a));
    return { byMc, promos: promos.promos || {} };
  });
}

/** Версия NeoForge → версия Minecraft: 21.1.77 → 1.21.1, 21.0.5 → 1.21, 26.1.2.126 → 26.1.2. */
function neoMc(v) {
  const p = v.replace(/-beta$/, '').split('.');
  if (p.length < 3 || !p.every((x) => /^\d+$/.test(x))) return null;
  if (Number(p[0]) >= 26) {
    if (p.length < 4) return null;
    return p[2] === '0' ? `${p[0]}.${p[1]}` : `${p[0]}.${p[1]}.${p[2]}`;
  }
  return p[1] === '0' ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
}

function neoData() {
  return cached('neoforge', async () => {
    const data = await getJson(NEO_VERSIONS);
    const byMc = new Map();
    for (const v of data.versions || []) {
      const mc = neoMc(v);
      if (!mc) continue;
      if (!byMc.has(mc)) byMc.set(mc, []);
      byMc.get(mc).push(v);
    }
    for (const list of byMc.values()) list.sort((a, b) => cmpVer(b, a));
    return byMc;
  });
}

// ---- гибридные ядра ----

/** Сборки Arclight с GitHub: [{ id, flavor, mc, version, pre, url, sha256, size, date }], новые первыми. */
function arclightBuilds() {
  return cached('arclight', async () => {
    const releases = await getJson(ARCLIGHT_RELEASES);
    const builds = [];
    for (const r of releases) {
      if (r.draft) continue;
      for (const a of r.assets || []) {
        const m = a.name.match(/^arclight-(fabric|forge|neoforge)-(\d[\d.]*)-(.+)\.jar$/);
        if (!m || !/^https:\/\/github\.com\//.test(a.browser_download_url)) continue;
        const digest = typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : null;
        builds.push({
          id: a.name.replace(/\.jar$/, ''),
          flavor: m[1],
          mc: m[2],
          version: String(r.tag_name).split('/').pop(),
          pre: !!r.prerelease || /snapshot/i.test(a.name),
          url: a.browser_download_url,
          sha256: digest,
          size: a.size,
          date: r.published_at,
        });
      }
    }
    return builds.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  });
}

/** Сборки Mohist/Youer по версиям игры: Map(mc → [{ id, sha256, date, loader }]). */
function mohistBuilds(type) {
  return cached('hybrid:' + type, async () => {
    const versions = await getJson(`${MOHIST_API}/${type}/versions`);
    const names = versions
      .map((v) => v.name)
      .filter((n) => typeof n === 'string' && VERSION_RE.test(n) && cmpVer(n, FORGE_MIN) >= 0);
    const lists = await Promise.all(
      names.map((n) => getJson(`${MOHIST_API}/${type}/${encodeURIComponent(n)}/builds`).catch(() => []))
    );
    const byMc = new Map();
    names.forEach((n, i) => {
      const builds = (Array.isArray(lists[i]) ? lists[i] : [])
        .filter((b) => Number.isInteger(b.id))
        .sort((a, b) => b.id - a.id);
      if (builds.length) byMc.set(n, builds);
    });
    return byMc;
  });
}

/** На каком загрузчике модов работает гибрид: fabric / forge / neoforge (null — не гибрид). */
function hybridFlavor(type, loader) {
  if (type === 'mohist') return 'forge';
  if (type === 'youer') return 'neoforge';
  if (type === 'arclight') {
    const m = String(loader || '').match(/^arclight-(fabric|forge|neoforge)-/);
    return m ? m[1] : null;
  }
  return null;
}

/**
 * Какой загрузчик модов ставить игрокам: { flavor, version }.
 * У гибридов он «спрятан» внутри ядра — берём ту версию Forge/NeoForge, на которой собрано ядро.
 */
async function clientLoader(type, mc, installedLoader) {
  if (['fabric', 'forge', 'neoforge'].includes(type)) {
    const version = installedLoader || (await listLoaders(type, mc)).recommended;
    return { flavor: type, version };
  }
  if (type === 'mohist' || type === 'youer') {
    const b = ((await mohistBuilds(type)).get(mc) || []).find((x) => String(x.id) === String(installedLoader));
    const l = (b && b.loader) || {};
    const flavor = type === 'mohist' ? 'forge' : 'neoforge';
    const version = type === 'mohist' ? l.forge_version : l.neoforge_version;
    return { flavor, version: version || (await listLoaders(flavor, mc)).recommended };
  }
  if (type === 'arclight') {
    const flavor = hybridFlavor(type, installedLoader);
    if (!flavor) return { flavor: null, version: null };
    return { flavor, version: (await listLoaders(flavor, mc)).recommended };
  }
  return { flavor: null, version: null };
}

const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU');
};

/** Список версий Minecraft: [{ id, pre }] — от новых к старым. */
async function listVersions(type, includePre) {
  checkArgs(type);
  if (type === 'arclight') {
    const builds = await arclightBuilds();
    const ids = await sortByManifest(builds.map((b) => b.mc));
    return ids
      .map((id) => ({ id, pre: builds.filter((b) => b.mc === id).every((b) => b.pre) }))
      .filter((v) => includePre || !v.pre);
  }
  if (type === 'mohist' || type === 'youer') {
    const byMc = await mohistBuilds(type);
    return (await sortByManifest([...byMc.keys()])).map((id) => ({ id, pre: false }));
  }
  if (type === 'vanilla') {
    const m = await vanillaManifest();
    return m.versions
      .filter((v) => v.type === 'release' || (includePre && v.type === 'snapshot'))
      .map((v) => ({ id: v.id, pre: v.type !== 'release' }));
  }
  if (type === 'paper') {
    const p = await cached('paper', () => getJson(PAPER_API));
    return Object.values(p.versions)
      .flat()
      .map((id) => ({ id, pre: /-(rc|pre|snapshot)/i.test(id) }))
      .filter((v) => includePre || !v.pre);
  }
  if (type === 'fabric') {
    const games = await cached('fabric-games', () => getJson(`${FABRIC_META}/versions/game`));
    return games
      .filter((g) => g.stable || includePre)
      .map((g) => ({ id: g.version, pre: !g.stable }));
  }
  if (type === 'forge') {
    const { byMc } = await forgeData();
    return (await sortByManifest([...byMc.keys()])).map((id) => ({ id, pre: false }));
  }
  const byMc = await neoData();
  const ids = await sortByManifest([...byMc.keys()]);
  return ids
    .map((id) => ({ id, pre: byMc.get(id).every((v) => v.endsWith('-beta')) }))
    .filter((v) => includePre || !v.pre);
}

/** Версии загрузчика для версии игры: { list: [{ id, label }], recommended }. */
async function listLoaders(type, mc) {
  checkArgs(type, mc);
  if (type === 'fabric') {
    const items = await getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`);
    const list = items.slice(0, 60).map((x) => ({
      id: x.loader.version,
      label: x.loader.version + (x.loader.stable ? '' : ' (бета)'),
      stable: x.loader.stable,
    }));
    const rec = list.find((x) => x.stable) || list[0];
    return { list, recommended: rec ? rec.id : null };
  }
  if (type === 'forge') {
    const { byMc, promos } = await forgeData();
    const rec = promos[`${mc}-recommended`];
    const latest = promos[`${mc}-latest`];
    const list = (byMc.get(mc) || []).slice(0, 60).map((id) => ({
      id,
      label: id + (id === rec ? ' — рекомендуемая' : id === latest ? ' — последняя' : ''),
    }));
    return { list, recommended: rec || latest || (list[0] && list[0].id) || null };
  }
  if (type === 'neoforge') {
    const byMc = await neoData();
    const list = (byMc.get(mc) || []).slice(0, 60).map((id) => ({
      id,
      label: id.endsWith('-beta') ? id.replace(/-beta$/, ' (бета)') : id,
    }));
    const rec = list.find((x) => !x.id.endsWith('-beta')) || list[0];
    return { list, recommended: rec ? rec.id : null };
  }
  if (type === 'arclight') {
    const builds = (await arclightBuilds()).filter((b) => b.mc === mc);
    const list = builds.map((b) => ({
      id: b.id,
      label: `${FLAVOR_NAMES[b.flavor]} · ${b.version.replace(/-SNAPSHOT$/i, '')}${b.pre ? ' (тестовая)' : ''}`,
      flavor: b.flavor,
    }));
    const stable = builds.filter((b) => !b.pre);
    const rec = stable.find((b) => b.flavor === 'neoforge') || stable[0] ||
      builds.find((b) => b.flavor === 'neoforge') || builds[0];
    return { list, recommended: rec ? rec.id : null };
  }
  if (type === 'mohist' || type === 'youer') {
    const builds = ((await mohistBuilds(type)).get(mc) || []).slice(0, 40);
    const list = builds.map((b) => {
      const l = b.loader || {};
      const base = type === 'mohist' ? (l.forge_version ? `Forge ${l.forge_version}` : '') : (l.neoforge_version ? `NeoForge ${l.neoforge_version}` : '');
      return {
        id: String(b.id),
        label: [`Сборка ${b.id}`, shortDate(b.build_date), base].filter(Boolean).join(' · '),
        flavor: hybridFlavor(type),
      };
    });
    return { list, recommended: list[0] ? list[0].id : null };
  }
  return { list: [], recommended: null };
}

/** Какая Java нужна версии игры (по данным Mojang); null, если неизвестно. */
async function requiredJava(version) {
  try {
    const m = await vanillaManifest();
    const entry = m.versions.find((v) => v.id === version);
    if (!entry) return null;
    const meta = await cached('meta:' + version, () => getJson(entry.url));
    return (meta.javaVersion && meta.javaVersion.majorVersion) || null;
  } catch {
    return null;
  }
}

/** Откуда качать vanilla/Paper: { url, algo, hash, size, name, build }. */
async function resolveDownload(type, version) {
  checkArgs(type, version);
  if (type === 'vanilla') {
    const m = await vanillaManifest();
    const entry = m.versions.find((v) => v.id === version);
    if (!entry) throw new Error(`Версия ${version} не найдена`);
    const meta = await getJson(entry.url);
    const dl = meta.downloads && meta.downloads.server;
    if (!dl) throw new Error(`Для версии ${version} Mojang не публикует серверный файл`);
    return { url: dl.url, algo: 'sha1', hash: dl.sha1, size: dl.size, name: `vanilla ${version}`, build: null };
  }
  if (type !== 'paper') throw new Error('Этот тип сервера ставится через установщик');
  const builds = await getJson(`${PAPER_API}/versions/${encodeURIComponent(version)}/builds`);
  if (!Array.isArray(builds) || builds.length === 0) {
    throw new Error(`Для Paper ${version} нет готовых сборок`);
  }
  const build = builds.find((b) => b.channel === 'STABLE') || builds[0];
  const dl = build.downloads && build.downloads['server:default'];
  if (!dl) throw new Error(`У сборки Paper ${version} #${build.id} нет серверного файла`);
  return {
    url: dl.url,
    algo: 'sha256',
    hash: dl.checksums && dl.checksums.sha256,
    size: dl.size,
    name: `Paper ${version} #${build.id}${build.channel === 'STABLE' ? '' : ' (' + build.channel + ')'}`,
    build: String(build.id),
  };
}

/** Скачивает файл во временный .part, сверяет контрольную сумму (если есть) и переименовывает. */
async function downloadFile(info, dest, onProgress) {
  const res = await request(info.url);
  if (!res.body) throw new Error('Пустой ответ сервера при скачивании');
  const total = Number(res.headers.get('content-length')) || info.size || 0;
  const tmp = dest + '.part';
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(tmp);
  const hash = info.algo ? crypto.createHash(info.algo) : null;
  let got = 0;
  try {
    for await (const chunk of res.body) {
      if (hash) hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      got += chunk.length;
      if (onProgress) onProgress(got, total);
    }
    out.end();
    await once(out, 'finish');
    if (hash && info.hash && hash.digest('hex') !== info.hash.toLowerCase()) {
      throw new Error('Контрольная сумма скачанного файла не совпала — файл повреждён');
    }
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    out.destroy();
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

// ---- Java ----

/** { path, major, text } по выводу `java -version`; null — не Java. */
function javaInfo(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      const text = String(stderr || stdout || '');
      const m = text.match(/version "(\d+)(?:\.(\d+))?/);
      if (err || !m) return resolve(null);
      const major = m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1]);
      // 32-битная Java не даёт серверу больше ~1,5 ГБ памяти.
      const bits = /64-Bit/i.test(text) ? 64 : 32;
      resolve({ path: exe, major, bits, text: text.split(/\r?\n/)[0].trim() + (bits === 32 ? ' (32 бит)' : '') });
    });
  });
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

// Папка, куда лаунчер сам ставит Java (задаётся из main.js: <данные программы>/java).
let ownJavaDir = null;
function setJavaDir(dir) {
  ownJavaDir = dir;
}

const JAVA_LTS = [8, 11, 17, 21, 25];
/** Какую Java ставить для нужной версии: ближайшую LTS не ниже нужной. */
const javaToInstall = (need) => JAVA_LTS.find((v) => v >= (need || 21)) || JAVA_LTS[JAVA_LTS.length - 1];

/**
 * Скачать Java (Eclipse Temurin JRE) в папку лаунчера — без установщика и прав администратора.
 * Возвращает путь к java.exe.
 */
async function installJava(major, { onProgress, onLog } = {}) {
  if (!ownJavaDir) throw new Error('Папка для Java не задана');
  if (!JAVA_LTS.includes(Number(major))) throw new Error('Неподдерживаемая версия Java');
  const log = onLog || (() => {});
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const assets = await getJson(
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=windows&architecture=${arch}&image_type=jre&vendor=eclipse`
  );
  const pkg = assets && assets[0] && assets[0].binary && assets[0].binary.package;
  if (!pkg || !/^https:\/\/github\.com\/adoptium\//.test(pkg.link)) throw new Error(`Не нашёл Java ${major} для Windows`);

  fs.mkdirSync(ownJavaDir, { recursive: true });
  const zipFile = path.join(ownJavaDir, `java-${major}.zip`);
  const tmpDir = path.join(ownJavaDir, `${major}.tmp`);
  const target = path.join(ownJavaDir, String(major));
  log(`Скачиваю Java ${major} (${Math.round(pkg.size / 1024 / 1024)} МБ)…`);
  await downloadFile({ url: pkg.link, algo: 'sha256', hash: pkg.checksum, size: pkg.size }, zipFile, onProgress);
  try {
    log('Распаковываю…');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    // В Windows 10/11 есть встроенный tar, он умеет распаковывать zip.
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await new Promise((resolve, reject) =>
      execFile(tarExe, ['-xf', zipFile, '-C', tmpDir], { windowsHide: true, timeout: 5 * 60 * 1000 }, (e) =>
        e ? reject(new Error('Не удалось распаковать Java: ' + e.message)) : resolve()
      )
    );
    const inner = subdirs(tmpDir).find((d) => fs.existsSync(path.join(d, 'bin', 'java.exe')));
    if (!inner) throw new Error('В архиве Java не нашлось java.exe');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(inner, target);
  } finally {
    fs.rmSync(zipFile, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  const exe = path.join(target, 'bin', 'java.exe');
  const info = await javaInfo(exe);
  if (!info) throw new Error('Java скачалась, но не запускается');
  cache.delete('javas');
  log(`Готово: ${info.text}`);
  return exe;
}

/** Все найденные на компьютере Java, от новых к старым. */
function findJavas(refresh) {
  if (refresh) cache.delete('javas');
  return cached('javas', async () => {
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    const cands = new Set(['java']);
    if (process.env.JAVA_HOME) cands.add(path.join(process.env.JAVA_HOME, 'bin', exe));
    const vendors = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto',
      'Semeru', 'OpenJDK', 'Eclipse Foundation', 'AdoptOpenJDK', 'Liberica'];
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
      .filter(Boolean)
      .flatMap((pf) => vendors.map((v) => path.join(pf, v)));
    if (process.env.USERPROFILE) roots.push(path.join(process.env.USERPROFILE, '.jdks'));
    if (ownJavaDir) roots.push(ownJavaDir); // Java, которую поставил сам лаунчер
    for (const root of new Set(roots)) {
      for (const d of subdirs(root)) cands.add(path.join(d, 'bin', exe));
    }
    // Java, которую скачивает официальный лаунчер Minecraft.
    const mcRuntimes = [
      process.env.APPDATA && path.join(process.env.APPDATA, '.minecraft', 'runtime'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Minecraft Launcher', 'runtime'),
    ].filter(Boolean);
    for (const rt of mcRuntimes) {
      for (const comp of subdirs(rt)) {
        for (const plat of subdirs(comp)) {
          for (const d of subdirs(plat)) cands.add(path.join(d, 'bin', exe));
        }
      }
    }
    const found = await Promise.all(
      [...cands].filter((c) => c === 'java' || fs.existsSync(c)).map(javaInfo)
    );
    const seen = new Set();
    return found
      .filter((j) => j && !seen.has(j.text) && seen.add(j.text))
      .sort((a, b) => b.major - a.major || b.bits - a.bits);
  });
}

/**
 * Подходящая Java: для модовых серверов — самая старая из подходящих
 * (старые Forge ломаются на новой Java), для остальных — самая новая.
 */
function pickJava(javas, need, modded) {
  const ok = javas.filter((j) => !need || j.major >= need);
  if (!ok.length) return null;
  const major = modded && need ? ok[ok.length - 1].major : ok[0].major;
  return ok.find((j) => j.major === major); // при равной версии первой идёт 64-битная
}

// ---- установка ----

/** Что запускать: { type, mc, loader, args } или null, если сервер не установлен. */
function readInstall(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, LAUNCH_FILE), 'utf8'));
    if (Array.isArray(data.args) && data.args.every((a) => typeof a === 'string')) return data;
  } catch {
    /* нет файла — смотрим дальше */
  }
  // Папки, созданные первой версией лаунчера: просто server.jar.
  if (fs.existsSync(path.join(dir, 'server.jar'))) return { loader: null, args: ['-jar', 'server.jar'] };
  return null;
}

/** Нужна ли (пере)установка: нет сервера или выбран другой загрузчик. */
function needsInstall(type, dir, loader) {
  const inst = readInstall(dir);
  if (!inst) return true;
  return LOADER_TYPES.includes(type) && !!loader && inst.loader !== loader;
}

function runInstaller(dir, jarName, onLog, javaPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaPath || 'java', ['-Djava.net.useSystemProxies=true', '-jar', jarName, '--installServer'], {
      cwd: dir,
      windowsHide: true,
    });
    const pipe = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) if (l.trim()) onLog(l);
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Установщик завершился с ошибкой (код ${code})`))
    );
  });
}

/** Аргументы запуска из run.bat, который создают установщики Forge/NeoForge. */
function argsFromRunBat(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'run.bat'), 'utf8');
  } catch {
    return null;
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^java\s/i.test(l) && !/--onlyCheckJava/.test(l));
  if (!lines.length) return null;
  const line = lines[lines.length - 1].split('||')[0];
  const args = line
    .split(/\s+/)
    .slice(1)
    .filter((a) => a && a !== '%*' && !/^@user_jvm_args\.txt$/i.test(a) && !/^nogui$/i.test(a));
  return args.length ? args : null;
}

/**
 * Устанавливает сервер в dir и записывает launcher.json.
 * Возвращает { type, mc, loader, args }.
 */
async function install({ type, mc, loader, dir, javaPath, onProgress, onLog }) {
  checkArgs(type, mc, loader);
  const log = onLog || (() => {});
  await fs.promises.mkdir(dir, { recursive: true });
  let result;

  if (type === 'vanilla' || type === 'paper') {
    const info = await resolveDownload(type, mc);
    log(`Скачиваю ${info.name}…`);
    await downloadFile(info, path.join(dir, 'server.jar'), onProgress);
    result = { type, mc, loader: info.build, args: ['-jar', 'server.jar'] };
  } else if (HYBRID_TYPES.includes(type)) {
    if (!loader) throw new Error('Не выбрана сборка');
    let info;
    if (type === 'arclight') {
      const b = (await arclightBuilds()).find((x) => x.id === loader && x.mc === mc);
      if (!b) throw new Error('Сборка Arclight не найдена — обновите список');
      info = { url: b.url, algo: b.sha256 ? 'sha256' : null, hash: b.sha256, size: b.size };
      log(`Скачиваю Arclight ${b.version} (${FLAVOR_NAMES[b.flavor]}) для Minecraft ${mc}…`);
    } else {
      const b = ((await mohistBuilds(type)).get(mc) || []).find((x) => String(x.id) === loader);
      if (!b) throw new Error('Сборка не найдена — обновите список');
      info = {
        url: `${MOHIST_API}/${type}/${encodeURIComponent(mc)}/builds/${b.id}/download`,
        algo: b.file_sha256 ? 'sha256' : null,
        hash: b.file_sha256,
      };
      log(`Скачиваю ${type === 'mohist' ? 'Mohist' : 'Youer'} (сборка ${b.id}) для Minecraft ${mc}…`);
    }
    const jar = `${type}.jar`;
    await downloadFile(info, path.join(dir, jar), onProgress);
    log('При первом запуске ядро само докачает библиотеки — это может занять несколько минут.');
    result = { type, mc, loader, args: ['-jar', jar] };
  } else if (type === 'fabric') {
    if (!loader) throw new Error('Не выбрана версия Fabric');
    const installers = await cached('fabric-installers', () => getJson(`${FABRIC_META}/versions/installer`));
    const inst = installers.find((i) => i.stable) || installers[0];
    if (!inst) throw new Error('Не удалось найти установщик Fabric');
    const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/${encodeURIComponent(inst.version)}/server/jar`;
    log(`Скачиваю Fabric ${loader} для Minecraft ${mc}…`);
    await downloadFile({ url }, path.join(dir, 'fabric-server-launch.jar'), onProgress);
    log('При первом запуске Fabric сам докачает файлы игры.');
    result = { type, mc, loader, args: ['-jar', 'fabric-server-launch.jar'] };
  } else {
    if (!loader) throw new Error('Не выбрана версия загрузчика');
    const isForge = type === 'forge';
    const full = isForge ? `${mc}-${loader}` : loader;
    const base = isForge ? `${FORGE_MAVEN}/${full}/forge-${full}` : `${NEO_MAVEN}/${full}/neoforge-${full}`;
    const url = `${base}-installer.jar`;
    const sha1 = await getText(url + '.sha1')
      .then((t) => t.trim().slice(0, 40))
      .catch(() => null);
    const jarName = 'launcher-installer.jar';
    const jarPath = path.join(dir, jarName);
    log(`Скачиваю установщик ${isForge ? 'Forge' : 'NeoForge'} ${loader}…`);
    await downloadFile({ url, algo: sha1 ? 'sha1' : null, hash: sha1 }, jarPath, onProgress);
    if (onProgress) onProgress(0, 0);
    log('Запускаю установщик — он скачает библиотеки, это может занять несколько минут…');
    await fs.promises.rm(path.join(dir, 'run.bat'), { force: true });
    try {
      await runInstaller(dir, jarName, log, javaPath);
    } finally {
      await fs.promises.rm(jarPath, { force: true });
      await fs.promises.rm(jarPath + '.log', { force: true });
    }
    let args = argsFromRunBat(dir);
    if (!args) {
      // Старые Forge (1.12–1.16) создают forge-<версия>.jar.
      const jar = fs
        .readdirSync(dir)
        .find((f) => /^(neo)?forge-.*\.jar$/i.test(f) && f.includes(loader) && !/installer/i.test(f));
      if (!jar) throw new Error('Установщик отработал, но не понятно, как запускать сервер');
      args = ['-jar', jar];
    }
    result = { type, mc, loader, args };
  }

  fs.writeFileSync(path.join(dir, LAUNCH_FILE), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

// ---- server.properties ----

const PROP_KEYS = ['server-ip', 'server-port', 'max-players', 'gamemode', 'difficulty', 'online-mode', 'motd',
  'level-name', 'white-list', 'enforce-whitelist', 'level-seed', 'level-type'];
const PROP_DEFAULTS = {
  'level-name': 'world',
  'white-list': 'false',
  'enforce-whitelist': 'false',
  'server-ip': '',
  'server-port': '25565',
  'max-players': '20',
  gamemode: 'survival',
  difficulty: 'easy',
  'online-mode': 'true',
  motd: 'A Minecraft Server',
};

function readProps(dir) {
  const result = { ...PROP_DEFAULTS };
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  } catch {
    return result;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    if (PROP_KEYS.includes(key)) result[key] = line.slice(i + 1);
  }
  return result;
}

function validateProps(values) {
  const clean = {};
  for (const key of PROP_KEYS) {
    if (values[key] === undefined) continue;
    clean[key] = String(values[key]).replace(/[\r\n]/g, ' ').trim();
  }
  const ip = clean['server-ip'];
  if (ip && !require('net').isIP(ip)) throw new Error('IP сервера указан неверно');
  const port = Number(clean['server-port']);
  if (clean['server-port'] !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw new Error('Порт должен быть числом от 1 до 65535');
  }
  const players = Number(clean['max-players']);
  if (clean['max-players'] !== undefined && !(Number.isInteger(players) && players >= 1 && players <= 1000)) {
    throw new Error('Число игроков должно быть от 1 до 1000');
  }
  if (clean.gamemode && !['survival', 'creative', 'adventure', 'spectator'].includes(clean.gamemode)) {
    throw new Error('Некорректный режим игры');
  }
  if (clean.difficulty && !['peaceful', 'easy', 'normal', 'hard'].includes(clean.difficulty)) {
    throw new Error('Некорректная сложность');
  }
  for (const k of ['online-mode', 'white-list', 'enforce-whitelist']) {
    if (clean[k] && !['true', 'false'].includes(clean[k])) throw new Error(`Некорректное значение ${k}`);
  }
  if (clean['level-seed'] !== undefined && clean['level-seed'].length > 64) throw new Error('Сид мира — не длиннее 64 символов');
  if (clean['level-type'] && !/^(minecraft:[a-z_]+|default|flat|largeBiomes|amplified)$/i.test(clean['level-type'])) {
    throw new Error('Некорректный тип мира');
  }
  const level = clean['level-name'];
  if (level !== undefined && (!level || !/^[^\\/:*?"<>|]+$/.test(level) || level === '..' || level === '.')) {
    throw new Error('Имя мира не может быть пустым и содержать \\ / : * ? " < > |');
  }
  return clean;
}

/** Меняет только известные ключи, остальные строки файла не трогает. */
function writeProps(dir, values) {
  const clean = validateProps(values);
  const file = path.join(dir, 'server.properties');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    /* файла ещё нет — сервер допишет остальные настройки при запуске */
  }
  const left = new Set(Object.keys(clean));
  lines = lines.map((line) => {
    if (line.startsWith('#')) return line;
    const i = line.indexOf('=');
    if (i < 0) return line;
    const key = line.slice(0, i).trim();
    if (!left.has(key)) return line;
    left.delete(key);
    return `${key}=${clean[key]}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const key of left) lines.push(`${key}=${clean[key]}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function eulaAccepted(dir) {
  try {
    return /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'));
  } catch {
    return false;
  }
}

module.exports = {
  UA,
  setFetch,
  TYPES,
  LOADER_TYPES,
  HYBRID_TYPES,
  hybridFlavor,
  clientLoader,
  getJson,
  postJson,
  cmpVer,
  checkArgs,
  neoMc,
  listVersions,
  listLoaders,
  requiredJava,
  resolveDownload,
  downloadFile,
  findJavas,
  pickJava,
  setJavaDir,
  installJava,
  javaToInstall,
  readInstall,
  needsInstall,
  install,
  argsFromRunBat,
  readProps,
  writeProps,
  eulaAccepted,
};
