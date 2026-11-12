// Общие помощники для тестов: временная папка, которая удаляется после теста.
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

module.exports = { tmpDir };
