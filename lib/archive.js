'use strict';
// Архивы zip на любой системе: в Windows — встроенный tar.exe (быстро, без памяти),
// в Linux — свой код на Node (там системный tar не понимает zip, а unzip/zip может не быть).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const zipread = require('./zipread');

const WIN = process.platform === 'win32';
const tarExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

function runTar(args, timeout, message) {
  return new Promise((resolve, reject) =>
    execFile(tarExe(), args, { windowsHide: true, timeout }, (e) => (e ? reject(new Error(message || e.message)) : resolve()))
  );
}

/** Распаковать zip в папку dest. */
async function unzip(file, dest, message) {
  if (WIN) return runTar(['-xf', file, '-C', dest], 5 * 60 * 1000, message);
  try {
    zipread.extractAll(file, dest);
  } catch (e) {
    throw new Error(message || e.message);
  }
}

function walk(dir, base, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isDirectory()) walk(full, rel, out);
    else if (d.isFile()) out.push({ name: rel, data: fs.readFileSync(full) });
  }
  return out;
}

/** Упаковать папку parent/name в zip-файл out (внутри архива — папка name). */
async function zipFolder(parent, name, out, message) {
  if (WIN) return runTar(['-a', '-cf', out, '-C', parent, name], 30 * 60 * 1000, message);
  const { zip } = require('./pack');
  fs.writeFileSync(out, zip(walk(path.join(parent, name), name, [])));
}

module.exports = { unzip, zipFolder };
