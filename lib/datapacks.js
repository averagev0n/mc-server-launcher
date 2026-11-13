// Датапаки: поиск и установка с Modrinth, свои файлы .zip, список и удаление.
// Лежат в <мир>/datapacks. Работают на любом сервере, в том числе обычном (Vanilla).

const fs = require('fs');
const path = require('path');
const { getJson, downloadFile } = require('./core');

const API = 'https://api.modrinth.com/v2';
const ID_RE = /^[A-Za-z0-9]{1,32}$/;
const FILE_RE = /^[^\\/:*?"<>|]+\.zip$/i;
const INDEX = 'mcl-datapacks.json';
const q = (o) => encodeURIComponent(JSON.stringify(o));

function folder(dir, level) {
  if (!/^[^\\/:*?"<>|]+$/.test(level) || level === '.' || level === '..') throw new Error('Некорректное имя мира');
  return path.join(dir, level, 'datapacks');
}
function readIndex(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, INDEX), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
const writeIndex = (dir, idx) => fs.writeFileSync(path.join(dir, INDEX), JSON.stringify(idx, null, 2), 'utf8');

async function search({ mc, query, offset }) {
  const facets = [['project_type:datapack'], ['versions:' + mc]];
  const text = String(query || '').trim().slice(0, 100);
  const data = await getJson(
    `${API}/search?limit=20&offset=${Math.max(0, Number(offset) || 0)}&index=${text ? 'relevance' : 'downloads'}&query=${encodeURIComponent(text)}&facets=${q(facets)}`
  );
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
      worldgen: (h.categories || []).includes('worldgen'),
    })),
  };
}

/** Установить датапак (и его обязательные датапаки-зависимости). bySlug — проект указан коротким именем. */
async function install({ mc, dir, level, projectId, bySlug, onLog }) {
  if (bySlug) {
    if (!/^[a-z0-9_-]{2,64}$/.test(projectId)) throw new Error('Некорректный проект');
    projectId = (await getJson(`${API}/project/${projectId}`)).id;
  }
  if (!ID_RE.test(projectId)) throw new Error('Некорректный проект');
  const log = onLog || (() => {});
  const out = folder(dir, level);
  fs.mkdirSync(out, { recursive: true });
  const idx = readIndex(dir);
  const added = [];
  const seen = new Set();
  async function add(pid, isDep) {
    if (seen.has(pid)) return;
    seen.add(pid);
    if (idx[pid] && fs.existsSync(path.join(out, idx[pid].file))) {
      if (!isDep) log(`«${idx[pid].title}» уже установлен.`);
      return;
    }
    const project = await getJson(`${API}/project/${pid}`);
    const list = await getJson(`${API}/project/${pid}/version?loaders=${q(['datapack'])}&game_versions=${q([mc])}`);
    const v = list.find((x) => x.version_type === 'release') || list[0];
    if (!v) {
      if (isDep) return log(`Нет датапака «${project.title}» для ${mc} — зависимость пропущена.`, 'error');
      throw new Error(`У «${project.title}» нет версии-датапака для Minecraft ${mc}`);
    }
    const f = v.files.find((x) => x.primary && FILE_RE.test(x.filename)) || v.files.find((x) => FILE_RE.test(x.filename));
    if (!f || !/^https:\/\/cdn\.modrinth\.com\//.test(f.url)) throw new Error(`У «${project.title}» нет файла .zip`);
    log(`${isDep ? 'Зависимость: ' : ''}скачиваю датапак ${project.title} ${v.version_number}…`);
    await downloadFile({ url: f.url, algo: 'sha1', hash: f.hashes && f.hashes.sha1, size: f.size }, path.join(out, f.filename));
    idx[pid] = { title: project.title, slug: project.slug, file: f.filename, version: v.version_number, icon: project.icon_url && /^https:\/\/cdn\.modrinth\.com\//.test(project.icon_url) ? project.icon_url : null };
    writeIndex(dir, idx);
    added.push(project.title);
    for (const dep of v.dependencies || []) {
      if (dep.dependency_type === 'required' && dep.project_id && ID_RE.test(dep.project_id)) await add(dep.project_id, true);
    }
  }
  await add(projectId, false);
  return added;
}

/** Свой файл: .zip или папка с pack.mcmeta. */
function addLocal(dir, level, src) {
  const out = folder(dir, level);
  const st = fs.statSync(src);
  const name = path.basename(src);
  if (st.isDirectory()) {
    if (!fs.existsSync(path.join(src, 'pack.mcmeta'))) throw new Error('В папке нет pack.mcmeta — это не датапак');
  } else if (!/\.zip$/i.test(name)) throw new Error('Датапак — это файл .zip или папка с pack.mcmeta');
  fs.mkdirSync(out, { recursive: true });
  const dest = path.join(out, name);
  if (fs.existsSync(dest)) throw new Error(`«${name}» уже есть`);
  fs.cpSync(src, dest, { recursive: true });
  return name;
}

function list(dir, level) {
  let names = [];
  try {
    names = fs.readdirSync(folder(dir, level), { withFileTypes: true });
  } catch {
    return [];
  }
  const byFile = new Map(Object.entries(readIndex(dir)).map(([id, e]) => [e.file, { id, ...e }]));
  return names
    .filter((d) => (d.isFile() && /\.zip$/i.test(d.name)) || (d.isDirectory() && fs.existsSync(path.join(folder(dir, level), d.name, 'pack.mcmeta'))))
    .map((d) => {
      const e = byFile.get(d.name);
      return { file: d.name, folder: d.isDirectory(), title: e ? e.title : null, version: e ? e.version : null, icon: e ? e.icon : null, projectId: e ? e.id : null };
    })
    .sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file));
}

/** Путь к датапаку для удаления (в корзину) — только внутри папки datapacks. */
function packPath(dir, level, name) {
  if (!/^[^\\/:*?"<>|]+$/.test(String(name)) || name === '.' || name === '..') throw new Error('Некорректное имя');
  const p = path.join(folder(dir, level), name);
  if (!fs.existsSync(p)) throw new Error('Датапак не найден');
  return p;
}
function forget(dir, name) {
  const idx = readIndex(dir);
  for (const [id, e] of Object.entries(idx)) if (e.file === name) delete idx[id];
  writeIndex(dir, idx);
}

module.exports = { search, install, addLocal, list, packPath, forget, folder };
