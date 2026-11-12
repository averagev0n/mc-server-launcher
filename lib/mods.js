// Моды и плагины с Modrinth: поиск, установка с зависимостями, список, удаление.
// У гибридных серверов (Arclight, Mohist, Youer) есть и моды, и плагины одновременно.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getJson, postJson, downloadFile, HYBRID_TYPES } = require('./core');

const API = 'https://api.modrinth.com/v2';
const INDEX_FILE = 'modrinth.json';
const FILE_RE = /^[^\\/:*?"<>|]+\.jar$/i;
const ID_RE = /^[A-Za-z0-9]{1,32}$/;
const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit'];

/** Что можно ставить на сервер этого типа: ['mod'], ['plugin'], оба или ничего. */
function kindsFor(type) {
  if (type === 'paper') return ['plugin'];
  if (['fabric', 'forge', 'neoforge'].includes(type)) return ['mod'];
  if (HYBRID_TYPES.includes(type)) return ['mod', 'plugin'];
  return [];
}

/**
 * Куда и что искать: { kind, dir, loaders, projectType, serverOnly }.
 * flavor — загрузчик модов гибрида (fabric / forge / neoforge).
 */
function target(type, kind, flavor) {
  const kinds = kindsFor(type);
  if (!kinds.length) throw new Error('Для этого типа сервера моды и плагины не поддерживаются');
  const k = kind && kinds.includes(kind) ? kind : kinds[0];
  if (k === 'plugin') {
    return { kind: k, dir: 'plugins', loaders: PLUGIN_LOADERS, projectType: 'plugin', serverOnly: false };
  }
  const loader = HYBRID_TYPES.includes(type) ? flavor : type;
  if (!loader) throw new Error('Не удалось понять, какой загрузчик модов у этого сервера');
  return { kind: k, dir: 'mods', loaders: [loader], projectType: 'mod', serverOnly: true };
}

/** Папка для модов/плагинов; null — тип без них. */
function contentDir(type, kind) {
  const kinds = kindsFor(type);
  if (!kinds.length) return null;
  const k = kind && kinds.includes(kind) ? kind : kinds[0];
  return k === 'plugin' ? 'plugins' : 'mods';
}

// У гибридов один и тот же проект может стоять и модом, и плагином (например, LuckPerms).
const indexKey = (type, kind, pid) => (HYBRID_TYPES.includes(type) ? `${kind}:${pid}` : pid);
const entryKind = (type, e) => e.kind || kindsFor(type)[0];

const q = (obj) => encodeURIComponent(JSON.stringify(obj));

function readIndex(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}
function writeIndex(dir, index) {
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');
}

async function search({ type, mc, query, offset, kind, flavor }) {
  const t = target(type, kind, flavor);
  const facets = [
    t.loaders.map((l) => 'categories:' + l),
    ['versions:' + mc],
    ['project_type:' + t.projectType],
  ];
  if (t.serverOnly) facets.push(['server_side:required', 'server_side:optional']);
  const text = String(query || '').trim().slice(0, 100);
  const url =
    `${API}/search?limit=20&offset=${Math.max(0, Number(offset) || 0)}` +
    `&index=${text ? 'relevance' : 'downloads'}&query=${encodeURIComponent(text)}&facets=${q(facets)}`;
  const data = await getJson(url);
  return {
    total: data.total_hits || 0,
    hits: (data.hits || []).map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      author: h.author,
      description: h.description,
      downloads: h.downloads,
      icon: h.icon_url && /^https:\/\/cdn\.modrinth\.com\//.test(h.icon_url) ? h.icon_url : null,
      type: t.projectType,
    })),
  };
}

/** Подходящая версия проекта: сначала релизы, потом бета/альфа. */
async function pickVersion(t, mc, projectId) {
  const list = await getJson(`${API}/project/${projectId}/version?loaders=${q(t.loaders)}&game_versions=${q([mc])}`);
  const usable = list.filter((v) => v.environment !== 'client_only');
  return usable.find((v) => v.version_type === 'release') || usable[0] || null;
}

/**
 * Ставит проект и его обязательные зависимости.
 * Возвращает список установленных названий.
 */
async function installProject({ type, mc, dir, projectId, kind, flavor, onLog }) {
  const t = target(type, kind, flavor);
  if (!ID_RE.test(projectId)) throw new Error('Некорректный проект');
  const log = onLog || (() => {});
  const folder = path.join(dir, t.dir);
  fs.mkdirSync(folder, { recursive: true });
  const index = readIndex(dir);
  const seen = new Set();
  const added = [];
  const what = t.kind === 'plugin' ? 'плагина' : 'мода';

  async function add(pid, versionId, isDep) {
    if (seen.has(pid)) return;
    seen.add(pid);
    const key = indexKey(type, t.kind, pid);
    if (index[key] && fs.existsSync(path.join(folder, index[key].file))) {
      if (!isDep) log(`«${index[key].title}» уже установлен.`);
      return;
    }
    const project = await getJson(`${API}/project/${pid}`);
    let version = null;
    if (versionId && ID_RE.test(versionId)) {
      version = await getJson(`${API}/version/${versionId}`);
      // Зависимость, привязанная к версии под другой загрузчик, нам не подходит.
      if (!version.loaders.some((l) => t.loaders.includes(l))) version = null;
    }
    if (!version) version = await pickVersion(t, mc, pid);
    if (!version) {
      const msg = `Нет версии ${what} «${project.title}» для ${t.loaders[0]} ${mc}`;
      if (!isDep) throw new Error(msg);
      log(msg + ' — зависимость пропущена, сервер может не запуститься.', 'error');
      return;
    }
    const file = version.files.find((f) => f.primary) || version.files[0];
    if (!file || !FILE_RE.test(file.filename) || !/^https:\/\/cdn\.modrinth\.com\//.test(file.url)) {
      throw new Error(`У «${project.title}» нет подходящего файла`);
    }
    log(`${isDep ? 'Зависимость: ' : ''}скачиваю ${project.title} ${version.version_number}…`);
    await downloadFile(
      { url: file.url, algo: 'sha1', hash: file.hashes && file.hashes.sha1, size: file.size },
      path.join(folder, file.filename)
    );
    index[key] = {
      title: project.title,
      slug: project.slug,
      kind: t.kind,
      file: file.filename,
      version: version.version_number,
      versionId: version.id,
      icon: project.icon_url && /^https:\/\/cdn\.modrinth\.com\//.test(project.icon_url) ? project.icon_url : null,
      dependency: isDep,
    };
    writeIndex(dir, index);
    added.push(project.title);
    for (const dep of version.dependencies || []) {
      if (dep.dependency_type === 'required' && dep.project_id && ID_RE.test(dep.project_id)) {
        await add(dep.project_id, dep.version_id, true);
      }
    }
  }

  await add(projectId, null, false);
  return added;
}

/** Файлы в папке модов или плагинов с данными из Modrinth, если есть. */
function listInstalled(type, dir, kind) {
  const sub = contentDir(type, kind);
  if (!sub) return [];
  const k = sub === 'plugins' ? 'plugin' : 'mod';
  const folder = path.join(dir, sub);
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((f) => /\.jar$/i.test(f));
  } catch {
    return [];
  }
  const byFile = new Map(
    Object.entries(readIndex(dir))
      .filter(([, e]) => e && entryKind(type, e) === k)
      .map(([key, e]) => [e.file, { id: key.split(':').pop(), ...e }])
  );
  return files
    .map((file) => {
      const e = byFile.get(file);
      let size = 0;
      try {
        size = fs.statSync(path.join(folder, file)).size;
      } catch {
        /* файл пропал между чтениями */
      }
      return {
        file,
        size,
        projectId: e ? e.id : null,
        title: e ? e.title : null,
        version: e ? e.version : null,
        icon: e && typeof e.icon === 'string' && /^https:\/\/cdn\.modrinth\.com\//.test(e.icon) ? e.icon : null,
        dependency: e ? !!e.dependency : false,
      };
    })
    .sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file));
}

/** Путь к файлу мода/плагина (с проверкой, что он внутри нужной папки). */
function modPath(type, dir, file, kind) {
  const sub = contentDir(type, kind);
  if (!sub || !FILE_RE.test(file)) throw new Error('Некорректное имя файла');
  return path.join(dir, sub, file);
}

function forgetFile(type, dir, file, kind) {
  const sub = contentDir(type, kind);
  const k = sub === 'plugins' ? 'plugin' : 'mod';
  const index = readIndex(dir);
  for (const [key, e] of Object.entries(index)) {
    if (e && e.file === file && entryKind(type, e) === k) delete index[key];
  }
  writeIndex(dir, index);
}

// ---- обновления ----

const sha1Of = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

/**
 * Какие моды/плагины можно обновить. Modrinth узнаёт файлы по контрольной сумме —
 * даже установленные вручную. Возвращает [{ file, title, current, latest, latestType, update }].
 */
async function checkUpdates({ type, mc, dir, kind, flavor }) {
  const t = target(type, kind, flavor);
  const folder = path.join(dir, t.dir);
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((f) => FILE_RE.test(f));
  } catch {
    return [];
  }
  if (!files.length) return [];
  const hashes = files.map((f) => sha1Of(path.join(folder, f)));
  const [cur, latest] = await Promise.all([
    postJson(`${API}/version_files`, { hashes, algorithm: 'sha1' }),
    postJson(`${API}/version_files/update`, { hashes, algorithm: 'sha1', loaders: t.loaders, game_versions: [mc] }),
  ]);
  const ids = [...new Set(Object.values(cur).map((v) => v.project_id))];
  const projects = ids.length ? await getJson(`${API}/projects?ids=${q(ids)}`) : [];
  return files
    .map((file, i) => {
      const h = hashes[i];
      const c = cur[h];
      const l = latest[h];
      const p = c && projects.find((x) => x.id === c.project_id);
      const newFile = l && (l.files.find((f) => f.primary) || l.files[0]);
      return {
        file,
        title: p ? p.title : null,
        known: !!c,
        current: c ? c.version_number : null,
        latest: l ? l.version_number : null,
        latestType: l ? l.version_type : null,
        update: !!(c && l && l.id !== c.id && newFile && newFile.hashes.sha1 !== h),
      };
    })
    .sort((a, b) => Number(b.update) - Number(a.update) || (a.title || a.file).localeCompare(b.title || b.file));
}

/** Обновить один файл: новая версия скачивается, старая уходит в backups/mods-<дата>. */
async function updateFile({ type, mc, dir, kind, flavor, file, onLog }) {
  const t = target(type, kind, flavor);
  if (!FILE_RE.test(file)) throw new Error('Некорректное имя файла');
  const folder = path.join(dir, t.dir);
  const oldPath = path.join(folder, file);
  if (!fs.existsSync(oldPath)) throw new Error('Файл не найден');
  const h = sha1Of(oldPath);
  const latest = await postJson(`${API}/version_files/update`, { hashes: [h], algorithm: 'sha1', loaders: t.loaders, game_versions: [mc] });
  const v = latest[h];
  if (!v) throw new Error('Для этого файла обновлений нет');
  const nf = v.files.find((f) => f.primary) || v.files[0];
  if (!nf || !FILE_RE.test(nf.filename) || !/^https:\/\/cdn\.modrinth\.com\//.test(nf.url)) throw new Error('У новой версии нет подходящего файла');
  if (nf.hashes.sha1 === h) return { file, unchanged: true };
  const project = await getJson(`${API}/project/${v.project_id}`);
  (onLog || (() => {}))(`Обновляю ${project.title}: ${v.version_number}…`);

  // Сначала качаем во временный файл, потом убираем старый в резервную папку.
  const tmp = path.join(folder, nf.filename + '.update');
  await downloadFile({ url: nf.url, algo: 'sha1', hash: nf.hashes.sha1, size: nf.size }, tmp);
  const stamp = new Date().toISOString().slice(0, 10);
  const bdir = path.join(dir, 'backups', `${t.dir}-${stamp}`);
  fs.mkdirSync(bdir, { recursive: true });
  try {
    fs.renameSync(oldPath, path.join(bdir, file));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Не удалось заменить ${file} — файл занят. Остановите сервер и попробуйте снова`);
  }
  fs.renameSync(tmp, path.join(folder, nf.filename));

  const index = readIndex(dir);
  const k = t.kind;
  const key = Object.keys(index).find((x) => index[x] && index[x].file === file && entryKind(type, index[x]) === k) || indexKey(type, k, v.project_id);
  index[key] = {
    ...(index[key] || { dependency: false }),
    title: project.title,
    slug: project.slug,
    kind: k,
    file: nf.filename,
    version: v.version_number,
    versionId: v.id,
    icon: project.icon_url && /^https:\/\/cdn\.modrinth\.com\//.test(project.icon_url) ? project.icon_url : null,
  };
  writeIndex(dir, index);
  return { file: nf.filename, title: project.title, version: v.version_number, backup: path.relative(dir, bdir) };
}

module.exports = { kindsFor, contentDir, search, installProject, listInstalled, modPath, forgetFile, checkUpdates, updateFile };
