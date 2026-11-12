// Сборка модов для игроков: какие моды сервера нужны в игре и экспорт в .mrpack или .zip.
//
// .mrpack — формат Modrinth: Modrinth App, Prism Launcher, ATLauncher и другие ставят из него
// нужную версию игры, загрузчик и моды одной кнопкой. Моды с Modrinth в сборку не кладутся,
// а скачиваются игроком с официального сайта по ссылке; файлы не с Modrinth кладутся внутрь.
// .zip — папка mods и инструкция для тех, кто играет через официальный лаунчер.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { getJson, postJson } = require('./core');

const API = 'https://api.modrinth.com/v2';
const FILE_RE = /^[^\\/:*?"<>|]+\.jar$/i;
const MRPACK_LOADER_KEY = { fabric: 'fabric-loader', forge: 'forge', neoforge: 'neoforge' };
const LOADER_NAME = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };

const sha = (algo, buf) => crypto.createHash(algo).update(buf).digest('hex');

/**
 * Разбор папки mods: что это за моды и нужны ли они игрокам.
 * Возвращает [{ file, size, sha1, title, projectId, clientSide, serverSide, download, sha512, include, reason }].
 */
async function analyze(modsDir) {
  let files = [];
  try {
    files = fs.readdirSync(modsDir).filter((f) => FILE_RE.test(f));
  } catch {
    return [];
  }
  const items = files.map((file) => {
    const buf = fs.readFileSync(path.join(modsDir, file));
    return { file, size: buf.length, sha1: sha('sha1', buf), sha512: sha('sha512', buf) };
  });
  if (!items.length) return [];

  // Modrinth узнаёт файлы по контрольной сумме — даже скачанные не через лаунчер.
  let versions = {};
  let projects = [];
  try {
    versions = await postJson(`${API}/version_files`, { hashes: items.map((i) => i.sha1), algorithm: 'sha1' });
    const ids = [...new Set(Object.values(versions).map((v) => v.project_id))];
    if (ids.length) projects = await getJson(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
  } catch (e) {
    throw new Error('Не удалось проверить моды на Modrinth: ' + e.message);
  }

  for (const it of items) {
    const v = versions[it.sha1];
    const p = v && projects.find((x) => x.id === v.project_id);
    const f = v && v.files.find((x) => x.hashes && x.hashes.sha1 === it.sha1);
    if (v && p && f && /^https:\/\/cdn\.modrinth\.com\//.test(f.url)) {
      it.title = p.title;
      it.projectId = p.id;
      it.icon = p.icon_url && /^https:\/\/cdn\.modrinth\.com\//.test(p.icon_url) ? p.icon_url : null;
      it.clientSide = p.client_side; // required | optional | unsupported | unknown
      it.serverSide = p.server_side;
      it.download = f.url;
      it.include = p.client_side !== 'unsupported';
      it.reason =
        p.client_side === 'unsupported'
          ? 'Только для сервера — игрокам не нужен'
          : p.client_side === 'required'
            ? 'Нужен игрокам'
            : 'Работает и у игроков — лучше оставить';
    } else {
      it.title = null;
      it.clientSide = 'unknown';
      it.include = true;
      it.reason = 'Не найден на Modrinth — файл будет положен в сборку как есть. Если это мод только для сервера, снимите галочку';
    }
  }
  return items.sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file));
}

// ---- ZIP (без сторонних библиотек: .mrpack — это тоже zip) ----

function zip(entries) {
  // entries: [{ name, data: Buffer }]
  const parts = [];
  const central = [];
  let offset = 0;
  const dosTime = 0x0000; // 00:00:00
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const deflated = zlib.deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const crc = zlib.crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(useDeflate ? 8 : 0, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---- servers.dat: сервер сразу в списке «Сетевая игра» ----

function nbtString(s) {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}
function serversDat(name, address) {
  const tagStr = (key, val) => Buffer.concat([Buffer.from([8]), nbtString(key), nbtString(val)]);
  const count = Buffer.alloc(4);
  count.writeInt32BE(1);
  return Buffer.concat([
    Buffer.from([10]), nbtString(''), // корневой compound
    Buffer.from([9]), nbtString('servers'), Buffer.from([10]), count, // list из compound
    tagStr('name', name),
    tagStr('ip', address),
    Buffer.from([0]), // конец сервера
    Buffer.from([0]), // конец корня
  ]);
}

// ---- экспорт ----

/** Файлы из папки config (настройки модов), без резервных копий. */
function configEntries(configDir, prefix) {
  const out = [];
  const walk = (rel, depth) => {
    if (depth > 5) return;
    let list = [];
    try {
      list = fs.readdirSync(path.join(configDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (e.isFile() && !/\.(bak|launcher-tmp)$/i.test(e.name)) {
        const st = fs.statSync(path.join(configDir, r));
        if (st.size <= 2 * 1024 * 1024) out.push({ name: `${prefix}${r}`, data: fs.readFileSync(path.join(configDir, r)) });
      }
    }
  };
  walk('', 0);
  return out;
}

/**
 * Собрать файл сборки.
 * opts: { format: 'mrpack'|'zip', items (из analyze, только выбранные), modsDir, configDir, includeConfig,
 *         name, packVersion, mc, loader: { flavor, version }, server: { name, address } | null, outFile }
 */
function build(opts) {
  const { format, items, modsDir, name, mc, loader } = opts;
  const entries = [];
  const overrides = format === 'mrpack' ? 'overrides/' : '';

  if (format === 'mrpack') {
    const files = [];
    for (const it of items) {
      if (it.download) {
        files.push({
          path: `mods/${it.file}`,
          hashes: { sha1: it.sha1, sha512: it.sha512 },
          // Всё, что выбрано, — обязательно: иначе игрок может снять галочку с библиотеки,
          // и моды, которым она нужна, не запустятся.
          env: { client: 'required', server: 'unsupported' },
          downloads: [it.download],
          fileSize: it.size,
        });
      } else {
        entries.push({ name: `overrides/mods/${it.file}`, data: fs.readFileSync(path.join(modsDir, it.file)) });
      }
    }
    const dependencies = { minecraft: mc };
    if (loader && loader.flavor && loader.version) dependencies[MRPACK_LOADER_KEY[loader.flavor]] = loader.version;
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: opts.packVersion || '1.0.0',
      name,
      summary: `Моды для сервера: Minecraft ${mc}${loader && loader.flavor ? ', ' + LOADER_NAME[loader.flavor] : ''}`,
      files,
      dependencies,
    };
    entries.unshift({ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2), 'utf8') });
  } else {
    for (const it of items) entries.push({ name: `mods/${it.file}`, data: fs.readFileSync(path.join(modsDir, it.file)) });
    const loaderLine = loader && loader.flavor
      ? `${LOADER_NAME[loader.flavor]}${loader.version ? ' ' + loader.version : ''}`
      : 'загрузчик модов';
    const readme = [
      `Сборка «${name}» для Minecraft ${mc} (${loaderLine}).`,
      '',
      'Как установить через официальный лаунчер Minecraft:',
      `1. Установите ${loaderLine} для Minecraft ${mc}:`,
      loader && loader.flavor === 'fabric' ? '   https://fabricmc.net/use/installer/' : '',
      loader && loader.flavor === 'forge' ? '   https://files.minecraftforge.net/' : '',
      loader && loader.flavor === 'neoforge' ? '   https://neoforged.net/' : '',
      '2. Откройте папку игры: Win+R → введите %appdata%\\.minecraft → Enter.',
      '3. Скопируйте папку mods из этого архива в папку .minecraft (с заменой).',
      opts.includeConfig ? '4. Скопируйте и папку config — это настройки модов.' : '',
      `${opts.includeConfig ? '5' : '4'}. В лаунчере выберите профиль ${LOADER_NAME[loader && loader.flavor] || 'с модами'} и играйте.`,
      opts.server ? `\nАдрес сервера: ${opts.server.address}` : '',
      '',
      'Проще: установите Modrinth App (modrinth.com/app) и откройте в нём файл .mrpack — всё поставится само.',
    ]
      .filter((l) => l !== '')
      .join('\r\n');
    entries.push({ name: 'КАК УСТАНОВИТЬ.txt', data: Buffer.from('﻿' + readme, 'utf8') });
  }

  if (opts.includeConfig && opts.configDir && fs.existsSync(opts.configDir)) {
    entries.push(...configEntries(opts.configDir, `${overrides}config/`));
  }
  if (opts.server && opts.server.address && format === 'mrpack') {
    entries.push({ name: `${overrides}servers.dat`, data: serversDat(opts.server.name || name, opts.server.address) });
  }

  const data = zip(entries);
  const tmp = opts.outFile + '.part';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, opts.outFile);
  return { size: data.length, bundled: entries.filter((e) => /mods\//.test(e.name)).length };
}

module.exports = { analyze, build, serversDat, zip };
