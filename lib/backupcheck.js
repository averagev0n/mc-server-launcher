// Проверка копии мира: архив читается целиком (без повреждений), в нём есть level.dat, и он разбирается.

const fs = require('fs');
const path = require('path');
const tar = require('tar');
const nbt = require('./nbt');

const FILE = '.verified.json';

async function verify(archive) {
  let levelDat = null;
  let files = 0;
  let regions = 0;
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry: (e) => {
      const p = e.path.replace(/\\/g, '/');
      files++;
      if (/\/region\/r\.-?\d+\.-?\d+\.mca$/.test(p)) regions++;
      if (/^[^/]+\/level\.dat$/.test(p) && !levelDat) {
        const parts = [];
        e.on('data', (c) => parts.push(c));
        e.on('end', () => (levelDat = Buffer.concat(parts)));
      } else e.resume();
    },
  });
  if (!levelDat) throw new Error('в копии нет level.dat');
  const data = nbt.parse(levelDat);
  if (!data.Data) throw new Error('level.dat повреждён');
  return { files, regions, name: data.Data.LevelName || null };
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'backups', FILE), 'utf8')) || {};
  } catch {
    return {};
  }
}
function saveState(dir, file, result) {
  const s = readState(dir);
  s[file] = result;
  // Храним только существующие копии.
  for (const k of Object.keys(s)) if (!fs.existsSync(path.join(dir, 'backups', k))) delete s[k];
  fs.writeFileSync(path.join(dir, 'backups', FILE), JSON.stringify(s, null, 2), 'utf8');
}

module.exports = { verify, readState, saveState };
