// Проверка модов перед запуском: моды только для игрока, дубли, моды под другой загрузчик.
// Смотрим описание внутри каждого .jar (fabric.mod.json, mods.toml, neoforge.mods.toml).
const fs = require('fs');
const path = require('path');
const { parse: parseToml } = require('smol-toml');
const { readFiles } = require('./zipread');

// Моды, которые на сервере не работают или роняют его, хотя их описание этого не говорит.
const CLIENT_ONLY = new Set([
  'sodium', 'iris', 'oculus', 'embeddium', 'rubidium', 'optifine', 'optifabric', 'xaerominimap', 'xaeroworldmap',
  'journeymap-client', 'voxelmap', 'modmenu', 'zoomify', 'okzoomer', 'ok_zoomer', 'continuity', 'entityculling',
  'cullleaves', 'betterf3', 'controlling', 'mousetweaks', 'appleskin-client', 'dynamiclights', 'lambdynlights',
  'sodiumextra', 'sodium-extra', 'reeses-sodium-options', 'reeses_sodium_options', 'indium', 'immediatelyfast',
  'notenoughanimations', 'skinlayers3d', 'skinlayers', 'fancymenu', 'drippyloadingscreen', 'citresewn',
  'cit_resewn', 'entity_model_features', 'entity_texture_features', 'puzzle', 'yosbr', 'searchables',
  'chat_heads', 'legendarytooltips', 'equipmentcompare', 'toastcontrol', 'betterthirdperson', 'shoulder_surfing',
  'freecam', 'blur', 'nochatreports-client', 'distanthorizons-client', 'ambientsounds', 'presencefootsteps',
  'sound_physics_remastered', 'soundphysics', 'firstperson', 'firstpersonmod', 'not_enough_animations',
]);

const SERVER_LOADERS = {
  fabric: ['fabric', 'quilt'],
  forge: ['forge'],
  neoforge: ['neoforge'],
  mohist: ['forge'],
  youer: ['neoforge'],
};

function describeJar(file) {
  const files = readFiles(file, ['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml']);
  const mods = [];
  if (files['fabric.mod.json']) {
    try {
      // В fabric.mod.json встречаются переводы строк внутри значений — заменяем их пробелами.
      const j = JSON.parse(files['fabric.mod.json'].toString('utf8').replace(/[\r\n\t]+/g, ' '));
      mods.push({ id: String(j.id || ''), name: String(j.name || j.id || ''), loader: 'fabric', env: j.environment || '*', version: String(j.version || ''), provides: Array.isArray(j.provides) ? j.provides.map(String) : [], deps: j.depends && typeof j.depends === 'object' ? Object.keys(j.depends) : [] });
    } catch {
      mods.push({ id: '', name: '', loader: 'fabric', env: '*', version: '' });
    }
  }
  for (const [entry, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
    if (!files[entry]) continue;
    let t = {};
    try {
      t = parseToml(files[entry].toString('utf8'));
    } catch {
      /* старые моды пишут нестрогий TOML */
    }
    const list = Array.isArray(t.mods) ? t.mods : [{}];
    for (const m of list) {
      // В NeoForge-описании displayTest/clientSideOnly; в Forge — только displayTest, это не признак клиентского мода.
      const clientOnly = t.clientSideOnly === true || m.clientSideOnly === true;
      const dl = t.dependencies && Array.isArray(t.dependencies[m.modId]) ? t.dependencies[m.modId] : [];
      const deps = dl.filter((d) => d && (d.mandatory === true || d.type === 'required' || (d.type === undefined && d.mandatory === undefined))).map((d) => String(d.modId || ''));
      mods.push({ id: String(m.modId || ''), name: String(m.displayName || m.modId || ''), loader, env: clientOnly ? 'client' : '*', version: String(m.version || ''), provides: [], deps });
    }
    break; // neoforge.mods.toml главнее, если есть оба
  }
  return mods;
}

/**
 * Проверить папку модов сервера. Возвращает список находок:
 * { file, kind: 'client' | 'duplicate' | 'loader' | 'broken', text, mod }.
 */
function checkMods(type, dir) {
  const modsDir = path.join(dir, 'mods');
  let files = [];
  try {
    files = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    return [];
  }
  const allowed = SERVER_LOADERS[type];
  if (!allowed) return [];
  const issues = [];
  const byId = new Map();
  for (const file of files) {
    let mods;
    try {
      mods = describeJar(path.join(modsDir, file));
    } catch {
      issues.push({ file, kind: 'broken', text: 'Файл повреждён или это не мод — сервер может не запуститься' });
      continue;
    }
    if (!mods.length) continue; // библиотека без описания — не трогаем
    const m = mods[0];
    // Fabric-мод на Forge-сервере и наоборот. Некоторые моды несут описания под несколько загрузчиков.
    if (!mods.some((x) => allowed.includes(x.loader))) {
      issues.push({ file, kind: 'loader', mod: m.name, text: `Мод для ${m.loader === 'fabric' ? 'Fabric' : m.loader === 'neoforge' ? 'NeoForge' : 'Forge'}, а сервер — другой. С ним сервер не запустится.` });
      continue;
    }
    const own = mods.find((x) => allowed.includes(x.loader)) || m;
    if (own.env === 'client' || CLIENT_ONLY.has(own.id.toLowerCase())) {
      issues.push({ file, kind: 'client', mod: own.name, text: 'Мод только для игроков (графика, миникарта, интерфейс). На сервере он не нужен и часто роняет его.' });
      continue;
    }
    if (own.id) {
      if (byId.has(own.id)) {
        const first = byId.get(own.id);
        issues.push({ file, kind: 'duplicate', mod: own.name, text: `Две копии одного мода: ещё есть ${first.file}${first.version ? ' (' + first.version + ')' : ''}. Оставьте одну.` });
      } else {
        byId.set(own.id, { file, version: own.version });
      }
    }
  }
  return issues;
}

module.exports = { checkMods, describeJar, CLIENT_ONLY };
