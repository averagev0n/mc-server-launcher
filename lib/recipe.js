'use strict';
// «Рецепт» сервера: тип, версия, загрузчик, моды или плагины и основные настройки — без мира.
// Маленький JSON-файл .blockhost. Моды не кладём внутрь, а записываем ссылки Modrinth
// с контрольными суммами: при открытии рецепта ставятся ровно те же файлы.
// Рецепт приходит от другого человека, поэтому при чтении всё проверяется: только
// cdn.modrinth.com, только папки mods/plugins, только известные настройки.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { downloadFile, postJson, TYPES } = require('./core');

const FORMAT = 'blockhost-recipe';
const EXT = 'blockhost';
const API = 'https://api.modrinth.com/v2';
const PROPS = ['max-players', 'gamemode', 'difficulty', 'online-mode', 'motd', 'level-seed', 'level-type', 'generator-settings', 'resource-pack', 'resource-pack-sha1', 'require-resource-pack', 'white-list'];
const DIRS = ['mods', 'plugins'];
const FILE_RE = /^[\w .+()[\]-]{1,120}\.jar$/;
const MAX_FILES = 1000;

const hashOf = (file, algo) => crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');

function jarsIn(dir) {
  const out = [];
  for (const sub of DIRS) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(dir, sub)).filter((f) => FILE_RE.test(f));
    } catch {
      continue;
    }
    for (const f of files) out.push({ rel: `${sub}/${f}`, full: path.join(dir, sub, f) });
  }
  return out;
}

/**
 * Собрать рецепт. lookup(hashes) — запрос к Modrinth (по умолчанию POST /version_files).
 * Возвращает { recipe, manual } — manual: файлы, которых нет на Modrinth (их не перенести рецептом).
 */
async function build({ dir, type, mc, loader, name, props, gamerules }, lookup = (hashes) => postJson(`${API}/version_files`, { hashes, algorithm: 'sha1' })) {
  const jars = jarsIn(dir).map((j) => ({ ...j, sha1: hashOf(j.full, 'sha1') }));
  let versions = {};
  if (jars.length) {
    try {
      versions = (await lookup(jars.map((j) => j.sha1))) || {};
    } catch {
      throw new Error('Modrinth не ответил — рецепт без ссылок на моды бесполезен, попробуйте через минуту');
    }
  }
  const files = [];
  const manual = [];
  for (const j of jars) {
    const v = versions[j.sha1];
    const f = v && (v.files || []).find((x) => x.hashes && x.hashes.sha1 === j.sha1);
    if (!f || !/^https:\/\/cdn\.modrinth\.com\//.test(f.url)) {
      manual.push(j.rel);
      continue;
    }
    files.push({ path: j.rel, url: f.url, sha512: f.hashes.sha512, size: f.size || 0 });
  }
  const p = {};
  for (const k of PROPS) if (props && props[k] !== undefined && props[k] !== '') p[k] = String(props[k]);
  const recipe = {
    format: FORMAT,
    v: 1,
    name: String(name || '').slice(0, 80),
    type,
    mc,
    loader: loader || null,
    props: p,
    gamerules: gamerules && typeof gamerules === 'object' ? gamerules : {},
    files,
    manual,
    createdAt: new Date().toISOString(),
  };
  return { recipe, manual };
}

/** Проверить чужой рецепт. Возвращает очищенный план или бросает понятную ошибку. */
function parse(text) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    throw new Error('Это не рецепт Блокхоста — файл повреждён');
  }
  if (!r || r.format !== FORMAT) throw new Error('Это не рецепт Блокхоста');
  if (r.v !== 1) throw new Error('Рецепт сделан более новой версией Блокхоста — обновите лаунчер');
  if (!TYPES.includes(r.type)) throw new Error('Неизвестный тип сервера в рецепте');
  if (!/^[\w.+-]{1,40}$/.test(String(r.mc || ''))) throw new Error('Неверная версия Minecraft в рецепте');
  if (r.loader !== null && r.loader !== undefined && !/^[\w.+-]{1,60}$/.test(String(r.loader))) throw new Error('Неверная версия загрузчика в рецепте');
  const files = [];
  const seen = new Set();
  for (const f of Array.isArray(r.files) ? r.files.slice(0, MAX_FILES) : []) {
    const [sub, name, extra] = String((f && f.path) || '').split('/');
    if (extra !== undefined || !DIRS.includes(sub) || !FILE_RE.test(name || '') || seen.has(`${sub}/${name}`)) continue;
    let url;
    try {
      url = new URL(f.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.host !== 'cdn.modrinth.com') continue;
    if (!/^[0-9a-f]{128}$/i.test(String(f.sha512 || ''))) continue;
    seen.add(`${sub}/${name}`);
    files.push({ path: `${sub}/${name}`, url: url.href, sha512: f.sha512.toLowerCase(), size: Number(f.size) || 0 });
  }
  const props = {};
  for (const k of PROPS) if (r.props && typeof r.props[k] === 'string') props[k] = r.props[k].slice(0, 1000);
  const gamerules = {};
  if (r.gamerules && typeof r.gamerules === 'object') {
    for (const [k, v] of Object.entries(r.gamerules).slice(0, 200)) {
      if (/^[A-Za-z_]{1,64}$/.test(k) && ['boolean', 'number', 'string'].includes(typeof v)) gamerules[k] = v;
    }
  }
  const manual = (Array.isArray(r.manual) ? r.manual : []).map(String).filter((x) => x.length < 200).slice(0, 200);
  return {
    name: String(r.name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 80),
    type: r.type,
    mc: r.mc,
    loader: r.loader ? String(r.loader) : null,
    props,
    gamerules,
    files,
    manual,
  };
}

/** Скачать файлы рецепта в папку сервера (контрольные суммы сверяются). */
async function apply(plan, dir, { onLog = () => {}, onProgress = () => {} } = {}) {
  let i = 0;
  for (const f of plan.files) {
    i++;
    onLog(`Скачиваю ${i} из ${plan.files.length}: ${path.basename(f.path)}`);
    const dest = path.join(dir, ...f.path.split('/'));
    if (!path.resolve(dest).startsWith(path.resolve(dir) + path.sep)) throw new Error('Недопустимый путь в рецепте');
    await downloadFile({ url: f.url, algo: 'sha512', hash: f.sha512, size: f.size }, dest);
    onProgress(i, plan.files.length);
  }
  if (plan.loader) {
    fs.writeFileSync(path.join(dir, 'mcl-pack.json'), JSON.stringify({ name: plan.name, type: plan.type, mc: plan.mc, loader: plan.loader }, null, 2), 'utf8');
  }
  return { files: plan.files.length };
}

module.exports = { build, parse, apply, FORMAT, EXT, PROPS };
