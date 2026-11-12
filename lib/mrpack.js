// Сервер из сборки Modrinth (.mrpack): какая версия игры и загрузчик нужны,
// какие моды нужны серверу (моды только для игроков пропускаются), плюс файлы overrides.
//
// .mrpack — это zip. Он приходит от пользователя (чужой файл), поэтому:
//   • распаковываем в отдельную новую временную папку и ничего оттуда не запускаем;
//   • качаем моды только с разрешённых форматом сайтов и сверяем контрольные суммы;
//   • не даём файлам сборки выйти за папку сервера или подменить файлы запуска.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { downloadFile, getJson, postJson } = require('./core');

const API = 'https://api.modrinth.com/v2';
// Папки, которые нужны только игроку, — на сервер не ставим.
const CLIENT_DIRS = /^(resourcepacks|shaderpacks)\//i;

const ALLOWED_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const LOADERS = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge' };
// Эти файлы запускают сервер или принадлежат лаунчеру — сборке их менять нельзя.
const PROTECTED_TOP = /^(launcher\.json|run\.(bat|sh|cmd)|user_jvm_args\.txt|eula\.txt|modrinth\.json|mcl-[\w.-]+|server\.jar|[\w.-]*installer[\w.-]*\.jar)$/i;
const EXEC_EXT = /\.(exe|bat|cmd|com|ps1|vbs|js|msi|scr|sh)$/i;

/**
 * Безопасный относительный путь внутри папки сервера; null — путь недопустим.
 * Разрешены только обычные имена: без «..», абсолютных путей и исполняемых файлов.
 */
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.length > 300) return null;
  const parts = p.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || /[:*?"<>|\0]/.test(x))) return null;
  if (/^[a-z]:/i.test(p) || p.startsWith('/') || p.startsWith('\\')) return null;
  if (parts.length === 1 && PROTECTED_TOP.test(parts[0])) return null;
  if (EXEC_EXT.test(parts[parts.length - 1])) return null;
  return parts.join('/');
}

function unzip(file, dest) {
  const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) =>
    execFile(tarExe, ['-xf', file, '-C', dest], { windowsHide: true, timeout: 5 * 60 * 1000 }, (e) =>
      e ? reject(new Error('Не удалось распаковать сборку — файл повреждён или это не .mrpack')) : resolve()
    )
  );
}

/** Прочитать сборку. Возвращает план установки; tmpDir потом нужно удалить (apply/cleanup). */
async function read(file) {
  const st = fs.statSync(file);
  if (st.size > 2 * 1024 ** 3) throw new Error('Файл сборки слишком большой');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-mrpack-'));
  try {
    await unzip(file, tmpDir);
    let index;
    try {
      index = JSON.parse(fs.readFileSync(path.join(tmpDir, 'modrinth.index.json'), 'utf8'));
    } catch {
      throw new Error('В файле нет modrinth.index.json — это не сборка Modrinth');
    }
    if (index.game !== 'minecraft' || !index.dependencies || !index.dependencies.minecraft) {
      throw new Error('Сборка не для Minecraft или без версии игры');
    }
    const deps = index.dependencies;
    if (deps['quilt-loader']) throw new Error('Сборки на Quilt лаунчер пока не поддерживает — выберите сборку на Fabric, Forge или NeoForge');
    const key = Object.keys(LOADERS).find((k) => deps[k]);
    if (!key) throw new Error('Сборка без загрузчика модов — для неё подойдёт обычный сервер Vanilla');

    const files = [];
    const skipped = [];
    const bad = [];
    for (const f of Array.isArray(index.files) ? index.files : []) {
      const rel = safeRel(f.path);
      const server = (f.env && f.env.server) || 'required';
      if (server === 'unsupported') {
        skipped.push(f.path);
        continue;
      }
      const url = (f.downloads || []).find((u) => {
        try {
          const x = new URL(u);
          return x.protocol === 'https:' && ALLOWED_HOSTS.has(x.host);
        } catch {
          return false;
        }
      });
      const sha512 = f.hashes && f.hashes.sha512;
      if (!rel || !url || !/^[0-9a-f]{128}$/i.test(String(sha512 || ''))) {
        bad.push(f.path);
        continue;
      }
      if (CLIENT_DIRS.test(rel)) {
        skipped.push(f.path);
        continue;
      }
      const sha1 = f.hashes && /^[0-9a-f]{40}$/i.test(String(f.hashes.sha1 || '')) ? f.hashes.sha1.toLowerCase() : null;
      files.push({ path: rel, url, sha512, sha1, size: f.fileSize || 0 });
    }

    // Авторы сборок часто не помечают моды «только для игрока». Сверяемся с Modrinth:
    // если мод там помечен как не нужный серверу (шейдеры, миникарты, меню) — не ставим.
    let checked = false;
    const hashes = files.map((f) => f.sha1).filter(Boolean);
    if (hashes.length) {
      try {
        const versions = await postJson(`${API}/version_files`, { hashes, algorithm: 'sha1' });
        const ids = [...new Set(Object.values(versions).map((v) => v.project_id))];
        const projects = ids.length ? await getJson(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`) : [];
        const clientOnly = new Set(projects.filter((p) => p.server_side === 'unsupported').map((p) => p.id));
        for (let i = files.length - 1; i >= 0; i--) {
          const v = files[i].sha1 && versions[files[i].sha1];
          if (v && clientOnly.has(v.project_id)) {
            skipped.push(files[i].path);
            files.splice(i, 1);
          }
        }
        checked = true;
      } catch {
        /* нет связи с Modrinth — ставим всё, что в сборке */
      }
    }
    return {
      tmpDir,
      name: String(index.name || path.basename(file, '.mrpack')).slice(0, 80),
      packVersion: String(index.versionId || '').slice(0, 40),
      mc: String(deps.minecraft),
      type: LOADERS[key],
      loader: String(deps[key]),
      files,
      skipped,
      bad,
      checked,
      overrides: ['overrides', 'server-overrides'].filter((d) => fs.existsSync(path.join(tmpDir, d))),
    };
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

/** Скопировать папку overrides в папку сервера, пропуская недопустимые пути. */
function copyOverrides(from, dir, rejected) {
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const safe = safeRel(r);
        if (!safe) {
          rejected.push(r);
          continue;
        }
        const dest = path.join(dir, safe);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(from, r), dest);
      }
    }
  };
  walk('');
}

/**
 * Установить содержимое сборки в папку сервера.
 * Старые моды (если были) уезжают в backups/mods-before-pack-<дата>.
 */
async function apply(plan, dir, { onLog = () => {}, onProgress = () => {} } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const mods = path.join(dir, 'mods');
    let movedMods = null;
    if (fs.existsSync(mods) && fs.readdirSync(mods).length) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      movedMods = path.join('backups', `mods-before-pack-${stamp}`);
      fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
      fs.renameSync(mods, path.join(dir, movedMods));
      onLog(`Прежние моды сохранены в ${movedMods}.`);
    }
    let i = 0;
    for (const f of plan.files) {
      i++;
      onLog(`Скачиваю ${i} из ${plan.files.length}: ${path.basename(f.path)}`);
      const dest = path.join(dir, f.path);
      if (!dest.startsWith(path.resolve(dir) + path.sep)) throw new Error('Недопустимый путь в сборке');
      await downloadFile({ url: f.url, algo: 'sha512', hash: f.sha512, size: f.size }, dest);
      onProgress(i, plan.files.length);
    }
    const rejected = [];
    // Сначала общие overrides, затем серверные — они важнее.
    for (const o of plan.overrides) copyOverrides(path.join(plan.tmpDir, o), dir, rejected);
    if (rejected.length) onLog(`Пропущены недопустимые файлы сборки: ${rejected.slice(0, 5).join(', ')}${rejected.length > 5 ? '…' : ''}`);
    fs.writeFileSync(
      path.join(dir, 'mcl-pack.json'),
      JSON.stringify({ name: plan.name, version: plan.packVersion, type: plan.type, mc: plan.mc, loader: plan.loader }, null, 2),
      'utf8'
    );
    return { mods: plan.files.length, movedMods, rejected: rejected.length };
  } finally {
    cleanup(plan);
  }
}

function cleanup(plan) {
  if (plan && plan.tmpDir) fs.rmSync(plan.tmpDir, { recursive: true, force: true });
}

/** Загрузчик, который просит сборка, установленная в эту папку (для выбора по умолчанию). */
function packLoader(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'mcl-pack.json'), 'utf8'));
    return typeof p.loader === 'string' ? p.loader : null;
  } catch {
    return null;
  }
}

module.exports = { read, apply, cleanup, packLoader, safeRel };
