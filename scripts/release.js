// Выпуск новой версии на GitHub.
//
//   npm run release            — выпустить версию, указанную в package.json
//   npm run release -- 1.0.2   — поставить версию 1.0.2 и выпустить её
//
// Перед запуском допишите в CHANGELOG.md раздел «## 1.0.2 — ГГГГ-ММ-ДД» с описанием изменений:
// он станет описанием выпуска на GitHub и окном «Что нового» в лаунчере.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}
const step = (msg) => console.log(`\n▶ ${msg}`);

function ghPath() {
  const candidates = ['C:\\Program Files\\GitHub CLI\\gh.exe'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'gh';
}
const GH = ghPath();
const gh = (args, opts = {}) => execFileSync(GH, args, { cwd: ROOT, encoding: 'utf8', ...opts });
const git = (args, opts = {}) =>
  (execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }) || '').trim();

function notesFor(version) {
  const text = fs.readFileSync(CHANGELOG, 'utf8');
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`^## ${esc}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
}

// ---- проверки ----

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const wanted = process.argv[2];
if (wanted && !/^\d+\.\d+\.\d+$/.test(wanted)) fail(`Версия должна быть вида 1.2.3, а не «${wanted}»`);
const version = wanted || pkg.version;
const tag = `v${version}`;

const notes = notesFor(version);
if (!notes) fail(`В CHANGELOG.md нет раздела «## ${version} — дата» с описанием. Допишите его и запустите снова.`);

try {
  gh(['auth', 'status'], { stdio: 'pipe' });
} catch {
  fail('Нет входа в GitHub. Выполните: gh auth login');
}
const repoFile = path.join(ROOT, 'lib', 'repo.json');
if (!fs.existsSync(repoFile)) fail('Нет lib/repo.json с владельцем и названием репозитория.');
const { owner, repo } = JSON.parse(fs.readFileSync(repoFile, 'utf8'));

try {
  gh(['release', 'view', tag, '--repo', `${owner}/${repo}`], { stdio: 'pipe' });
  fail(`Версия ${version} уже выпущена. Поднимите номер версии: npm run release -- x.y.z`);
} catch (e) {
  if (e.status === undefined) throw e;
}

// В рабочей копии допустимы только правки версии и списка изменений.
// Без trim: в формате porcelain первые символы строки — это статус (« M файл»).
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3))
  .filter((f) => !['package.json', 'package-lock.json', 'CHANGELOG.md'].includes(f));
if (dirty.length) fail(`Есть незакоммиченные изменения:\n  ${dirty.join('\n  ')}\nСначала закоммитьте их.`);

// ---- версия и коммит ----

if (pkg.version !== version) {
  step(`Ставлю версию ${version}`);
  pkg.version = version;
  fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  execSync(`npm version ${version} --no-git-tag-version --allow-same-version`, { cwd: ROOT, stdio: 'ignore' });
}
if (git(['status', '--porcelain'])) {
  git(['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
  git(['commit', '-m', `Версия ${version}`]);
}

// ---- сборка ----

step('Собираю установщик и портативную версию');
// dist не очищаем целиком: старая портативная версия может быть запущена и держать свой файл.
execSync('npx electron-builder --win --publish never', { cwd: ROOT, stdio: 'inherit' });

const dist = path.join(ROOT, 'dist');
const files = [
  `MC-Server-Launcher-Setup-${version}.exe`,
  `MC-Server-Launcher-Setup-${version}.exe.blockmap`,
  'latest.yml', // по нему установленная версия узнаёт об обновлении
  `MC-Server-Launcher-Portable-${version}.exe`,
].map((f) => path.join(dist, f));
for (const f of files) if (!fs.existsSync(f)) fail(`После сборки не найден файл ${path.basename(f)}`);

// ---- публикация ----

step(`Отправляю код и метку ${tag} на GitHub`);
// Метка могла остаться от прерванного запуска — тогда она должна указывать на текущий коммит.
let tagged = '';
try {
  tagged = git(['rev-list', '-n', '1', tag], { stdio: 'pipe' });
} catch {
  /* метки ещё нет */
}
if (!tagged) git(['tag', '-a', tag, '-m', `Версия ${version}`]);
else if (tagged !== git(['rev-parse', 'HEAD'])) fail(`Метка ${tag} уже есть и указывает на другой коммит.`);
// Отправляем с учётной записью gh, не трогая общие настройки git.
git(['-c', 'credential.helper=', '-c', `credential.helper=!'${GH.replace(/\\/g, '/')}' auth git-credential`,
  'push', 'origin', 'HEAD', '--follow-tags'], { stdio: 'inherit' });

step(`Создаю выпуск ${tag}`);
const notesFile = path.join(os.tmpdir(), `release-notes-${version}.md`);
fs.writeFileSync(notesFile, notes + '\n', 'utf8');
gh(
  ['release', 'create', tag, ...files, '--repo', `${owner}/${repo}`, '--title', `Версия ${version}`,
    '--notes-file', notesFile, '--verify-tag'],
  { stdio: 'inherit' }
);
fs.rmSync(notesFile, { force: true });

console.log(`\n✔ Готово: https://github.com/${owner}/${repo}/releases/tag/${tag}\n`);
