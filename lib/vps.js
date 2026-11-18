// Перенос сервера на VPS (Linux или Windows) по SSH и управление им там: запуск, остановка, консоль.
// Система VPS определяется при подключении: на Linux команды идут через sh, на Windows — скриптами
// PowerShell (lib/vps-windows.js; нужен OpenSSH-сервер и tar.exe, они есть в Windows 10 и Server 2019+).
//
// На VPS всё лежит в домашней папке пользователя, права администратора не нужны:
//   ~/mc-launcher/java/<версия>/      — Java (Temurin), если подходящей нет в системе
//   ~/mc-launcher/servers/<имя>/       — сервер; mcl-start.sh запускает его в фоне,
//                                       console.log — журнал, console.in — команды серверу.
// Сервер на VPS продолжает работать, когда лаунчер закрыт.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
const tar = require('tar');
const win = require('./vps-windows');
const manage = require('./vps-manage');
const auto = require('./vps-auto');
const playersLib = require('./players');

const BASE = 'mc-launcher'; // относительно домашней папки на VPS
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const JAVA_LTS = [8, 11, 17, 21, 25];
// Что не нужно переносить: журналы, отчёты о падениях, резервные и временные файлы.
const SKIP_TOP = new Set(['logs', 'crash-reports', 'debug', '.cache', 'cache', 'backups']);
const SKIP_FILE = /\.(bak|part|launcher-tmp|log\.gz)$/i;

/** Строка в одинарных кавычках для sh: можно безопасно вставлять в команду. */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class HostKeyError extends Error {
  constructor(code, fingerprint, message) {
    super(message);
    this.code = code;
    this.fingerprint = fingerprint;
  }
}

/**
 * dataDir — где хранить список VPS; encrypt/decrypt — шифрование паролей (в Electron — safeStorage).
 */
function createVps({ dataDir, encrypt, decrypt, log = () => {}, openSftp = null, translate = (s) => s, lang = () => 'ru' }) {
  const file = path.join(dataDir, 'vps.json');
  const conns = new Map(); // id → { client, timer }
  const streams = new Map(); // `${id}/${name}` → закрыть поток журнала
  const platforms = new Map(); // id → 'linux' | 'windows' (определяется при подключении)

  // ---- профили ----

  function load() {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function store(list) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  }
  const pub = (p) => ({
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    auth: p.auth,
    keyPath: p.keyPath || '',
    hasSecret: !!p.secret,
    trusted: !!p.hostKey,
  });
  function get(id) {
    const p = load().find((x) => x.id === id);
    if (!p) throw new Error('VPS не найден — возможно, его удалили');
    return p;
  }

  function list() {
    return load().map(pub);
  }

  /** Добавить или изменить VPS. secret — пароль (или пароль ключа); пустой — оставить прежний. */
  function save(input) {
    const name = String(input.name || '').trim().slice(0, 60) || String(input.host || '').trim();
    const host = String(input.host || '').trim();
    const port = Number(input.port || 22);
    const username = String(input.username || '').trim();
    const auth = input.auth === 'key' ? 'key' : 'password';
    if (!(net.isIP(host) || HOST_RE.test(host))) throw new Error('Адрес VPS указан неверно');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт SSH должен быть от 1 до 65535');
    if (!USER_RE.test(username)) throw new Error('Имя пользователя указано неверно');
    const keyPath = auth === 'key' ? String(input.keyPath || '') : '';
    if (auth === 'key' && (!keyPath || !fs.existsSync(keyPath))) throw new Error('Выберите файл ключа');

    const all = load();
    const old = input.id ? all.find((x) => x.id === input.id) : null;
    const p = old || { id: crypto.randomUUID() };
    // Сменили адрес — прежний отпечаток ключа больше не относится к этому серверу.
    if (old && (old.host !== host || old.port !== port)) delete p.hostKey;
    Object.assign(p, { name, host, port, username, auth, keyPath });
    if (input.secret) p.secret = encrypt(String(input.secret));
    else if (old && old.auth !== auth) delete p.secret;
    if (!p.secret && auth === 'password') throw new Error('Введите пароль');
    if (!old) all.push(p);
    store(all);
    disconnect(p.id);
    return pub(p);
  }

  /** Забыть сохранённый отпечаток (после переустановки системы на VPS). */
  function forgetHostKey(id) {
    disconnect(id);
    const all = load();
    const p = all.find((x) => x.id === id);
    if (p) {
      delete p.hostKey;
      store(all);
    }
  }

  function remove(id) {
    disconnect(id);
    store(load().filter((x) => x.id !== id));
  }

  // ---- соединение ----

  function disconnect(id) {
    const c = conns.get(id);
    if (!c) return;
    clearTimeout(c.timer);
    conns.delete(id);
    platforms.delete(id);
    for (const [key, close] of streams) if (key.startsWith(id + '/')) close();
    try {
      c.client.end();
    } catch {
      /* уже закрыто */
    }
  }

  /**
   * Подключение (с кэшем на 5 минут бездействия).
   * acceptFingerprint — пользователь подтвердил отпечаток нового сервера.
   */
  function connect(id, acceptFingerprint) {
    const cached = conns.get(id);
    if (cached && cached.ready) {
      touch(id);
      return Promise.resolve(cached.client);
    }
    if (cached && cached.pending) return cached.pending;
    const p = get(id);
    const client = new Client();
    const entry = { client, ready: false, timer: null };
    let hostKeyError = null;

    const opts = {
      host: p.host,
      port: p.port,
      username: p.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      hostVerifier: (key) => {
        const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        if (p.hostKey) {
          if (p.hostKey === fp) return true;
          hostKeyError = new HostKeyError(
            'HOSTKEY_CHANGED',
            fp,
            `Отпечаток ключа VPS изменился (был ${p.hostKey}, сейчас ${fp}). ` +
              'Это бывает после переустановки системы на VPS — но так же выглядит и попытка перехвата. ' +
              'Если вы не переустанавливали VPS, не подключайтесь.'
          );
          return false;
        }
        if (acceptFingerprint && acceptFingerprint === fp) {
          const all = load();
          const rec = all.find((x) => x.id === id);
          if (rec) {
            rec.hostKey = fp;
            store(all);
          }
          return true;
        }
        hostKeyError = new HostKeyError('HOSTKEY_NEW', fp, 'Первое подключение к этому VPS — подтвердите отпечаток ключа.');
        return false;
      },
    };
    try {
      if (p.auth === 'key') {
        opts.privateKey = fs.readFileSync(p.keyPath);
        if (p.secret) opts.passphrase = decrypt(p.secret);
      } else {
        opts.password = decrypt(p.secret);
      }
    } catch (e) {
      return Promise.reject(new Error('Не удалось прочитать ключ или пароль: ' + e.message));
    }

    entry.pending = new Promise((resolve, reject) => {
      client
        .on('ready', () => {
          entry.ready = true;
          entry.pending = null;
          touch(id);
          resolve(client);
        })
        .on('error', (e) => {
          conns.delete(id);
          if (hostKeyError) return reject(hostKeyError);
          reject(new Error(sshMessage(e)));
        })
        .on('close', () => {
          if (conns.get(id) === entry) conns.delete(id);
        })
        .connect(opts);
    });
    conns.set(id, entry);
    return entry.pending;
  }

  function touch(id) {
    const c = conns.get(id);
    if (!c) return;
    clearTimeout(c.timer);
    // Пока открыта консоль — соединение не закрываем.
    c.timer = setTimeout(() => {
      const hasStream = [...streams.keys()].some((k) => k.startsWith(id + '/'));
      if (!hasStream) disconnect(id);
      else touch(id);
    }, 5 * 60 * 1000);
  }

  function sshMessage(e) {
    const m = String((e && e.message) || e);
    if (/authentication methods failed|All configured authentication/i.test(m)) return 'Неверное имя пользователя, пароль или ключ';
    if (/ECONNREFUSED/.test(m)) return 'VPS не принимает подключения на этом порту — проверьте адрес и порт SSH';
    if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(m)) return 'VPS не отвечает — проверьте адрес, порт и интернет';
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Адрес VPS не найден — проверьте, что он написан правильно';
    if (/Cannot parse privateKey|Unsupported key format|bad passphrase|Encrypted private key detected/i.test(m)) {
      return 'Не удалось открыть файл ключа — возможно, нужен пароль ключа или ключ в неподдерживаемом формате';
    }
    return 'Ошибка SSH: ' + m;
  }

  /** Выполнить команду; возвращает { code, out, err }. */
  async function exec(id, cmd, { timeout = 120000 } = {}) {
    const client = await connect(id);
    touch(id);
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) return reject(new Error(sshMessage(err)));
        let out = '';
        let errText = '';
        const t = setTimeout(() => {
          stream.close();
          reject(new Error('VPS слишком долго выполняет команду'));
        }, timeout);
        stream
          .on('close', (code) => {
            clearTimeout(t);
            resolve({ code, out, err: errText });
          })
          .on('data', (d) => (out += d))
          .stderr.on('data', (d) => (errText += d));
      });
    });
  }

  async function sh(id, script, opts) {
    // Скрипт передаём через base64, чтобы кавычки и спецсимволы не ломали команду.
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    return exec(id, `printf %s ${b64} | base64 -d | sh`, opts);
  }

  async function sftp(id) {
    if (openSftp) return openSftp(id); // в тестах — папка на диске вместо VPS
    const client = await connect(id);
    return new Promise((resolve, reject) => client.sftp((e, s) => (e ? reject(new Error(sshMessage(e))) : resolve(s))));
  }

  /** Система VPS: 'linux' (и другие Unix) или 'windows'. */
  async function platformOf(id) {
    if (platforms.has(id)) return platforms.get(id);
    let plat = null;
    const u = await exec(id, 'uname -s', { timeout: 20000 }).catch(() => null);
    if (u && u.code === 0 && u.out.trim()) {
      // Git Bash / Cygwin на Windows тоже отвечают на uname, но скрипты sh там не работают.
      plat = /^(MINGW|MSYS|CYGWIN)/i.test(u.out.trim()) ? 'windows' : 'linux';
    } else {
      const w = await exec(id, 'powershell -NoProfile -NonInteractive -Command "[Environment]::OSVersion.Platform"', { timeout: 30000 }).catch(() => null);
      if (w && /Win32NT/i.test(w.out)) plat = 'windows';
    }
    if (!plat) throw new Error('Не удалось определить систему VPS. Поддерживаются Linux и Windows (с OpenSSH-сервером и PowerShell)');
    platforms.set(id, plat);
    return plat;
  }

  /** Выполнить скрипт PowerShell на Windows VPS: загружаем файл по SFTP и запускаем через -File. */
  async function psh(id, script, opts) {
    const rel = `${BASE}/run-${crypto.randomBytes(4).toString('hex')}.ps1`;
    const s = await sftp(id);
    try {
      await new Promise((resolve) => s.mkdir(BASE, () => resolve())); // папка может уже быть
      // BOM нужен, чтобы PowerShell 5 прочитал русские буквы в скрипте как UTF-8.
      const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, 'utf8')]);
      await new Promise((resolve, reject) => s.writeFile(rel, data, (e) => (e ? reject(new Error('Не удалось записать скрипт на VPS: ' + e.message)) : resolve())));
      return await exec(id, `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${rel.replace(/\//g, '\\')}"`, opts);
    } finally {
      await new Promise((resolve) => s.unlink(rel, () => resolve()));
      s.end();
    }
  }

  /** Выполнить сценарий на VPS: тексты для Linux (sh) и Windows (PowerShell). */
  async function run(id, { linux, windows }, opts) {
    return (await platformOf(id)) === 'windows' ? psh(id, windows, opts) : sh(id, linux, opts);
  }

  // ---- сведения о VPS ----

  /** Подключиться (или проверить), вернуть сведения о VPS и его серверах. */
  async function info(id, acceptFingerprint) {
    await connect(id, acceptFingerprint);
    const script = `
B="$HOME/${BASE}"
echo "arch=$(uname -m)"
echo "os=$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s)"
echo "mem=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null)"
echo "memfree=$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null)"
echo "disk=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
echo "dl=$(command -v curl >/dev/null && echo curl || (command -v wget >/dev/null && echo wget))"
echo "home=$HOME"
for j in "$B"/java/*/bin/java; do [ -x "$j" ] && echo "java=$j|$("$j" -version 2>&1 | head -n1)"; done
command -v java >/dev/null && echo "java=$(command -v java)|$(java -version 2>&1 | head -n1)"
for d in "$B"/servers/*/; do
  [ -f "$d/mcl.json" ] || continue
  n=$(basename "$d"); st=stopped
  if [ -f "$d/mcl.pid" ] && kill -0 "$(cat "$d/mcl.pid")" 2>/dev/null; then st=running; fi
  echo "server=$n|$st|$(tr -d '\\n' < "$d/mcl.json")"
done
`;
    const r = await run(id, { linux: script, windows: win.infoScript() }, { timeout: 60000 });
    const res = { javas: [], servers: [], platform: 'linux' };
    for (const line of r.out.split('\n')) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i);
      const v = line.slice(i + 1).trim();
      if (k === 'java') {
        const [p, text] = v.split('|');
        const m = (text || '').match(/version "(\d+)(?:\.(\d+))?/);
        if (m) res.javas.push({ path: p, major: m[1] === '1' ? Number(m[2]) : Number(m[1]), text });
      } else if (k === 'server') {
        const [name, status, ...rest] = v.split('|');
        let meta = {};
        try {
          meta = JSON.parse(rest.join('|'));
        } catch {
          /* битый mcl.json */
        }
        res.servers.push({ name, running: status === 'running', type: meta.type, mc: meta.mc, ramGb: meta.ramGb, uploadedAt: meta.uploadedAt, port: meta.port });
      } else {
        res[k] = v;
      }
    }
    res.memGb = res.mem ? Math.round(Number(res.mem) / 1024 / 1024) : null;
    res.memFreeGb = res.memfree ? Math.round((Number(res.memfree) / 1024 / 1024) * 10) / 10 : null;
    res.diskGb = res.disk ? Math.round(Number(res.disk) / 1024 / 1024) : null;
    return res;
  }

  // ---- перенос ----

  /** Подходящая Java на VPS или скачанная Temurin. */
  async function ensureJava(id, need, modded, vinfo, step) {
    const ok = vinfo.javas.filter((j) => !need || j.major >= need).sort((a, b) => a.major - b.major);
    // Для модов — самая старая из подходящих (старые Forge не дружат с новой Java), для остальных — новая.
    const pick = modded ? ok[0] : ok[ok.length - 1];
    if (pick) {
      step(`На VPS уже есть Java ${pick.major}.`);
      return pick.path;
    }
    const major = JAVA_LTS.find((v) => v >= (need || 21)) || 25;
    const arch = { x86_64: 'x64', amd64: 'x64', aarch64: 'aarch64', arm64: 'aarch64' }[vinfo.arch];
    if (!arch) throw new Error(`Процессор VPS (${vinfo.arch}) не поддерживается — установите Java ${major} на VPS вручную`);
    if (vinfo.platform === 'windows') {
      step(`Скачиваю на VPS Java ${major} (Temurin), это пара минут…`);
      const r = await psh(id, win.javaInstallScript(major, arch), { timeout: 20 * 60 * 1000 });
      if (r.code !== 0) throw new Error(`Не удалось установить Java на VPS: ${(r.err || r.out).trim().split('\n').pop()}`);
      step(`Java ${major} установлена: ${r.out.trim()}`);
      return `${vinfo.home}\\${BASE}\\java\\${major}\\bin\\java.exe`;
    }
    if (!vinfo.dl) throw new Error('На VPS нет ни curl, ни wget — нечем скачать Java. Установите одну из них или Java вручную');
    step(`Скачиваю на VPS Java ${major} (Temurin), это пара минут…`);
    const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${arch}/jre/hotspot/normal/eclipse`;
    const dir = `$HOME/${BASE}/java/${major}`;
    const get = vinfo.dl === 'curl' ? `curl -fsSL --retry 3 -o "$T" ${sq(url)}` : `wget -q -O "$T" ${sq(url)}`;
    const r = await sh(
      id,
      `set -e
T="$HOME/${BASE}/java-${major}.tar.gz"
mkdir -p "$HOME/${BASE}/java"
${get}
rm -rf "${dir}" && mkdir -p "${dir}"
tar -xzf "$T" -C "${dir}" --strip-components=1
rm -f "$T"
"${dir}/bin/java" -version 2>&1 | head -n1`,
      { timeout: 15 * 60 * 1000 }
    );
    if (r.code !== 0) throw new Error(`Не удалось установить Java на VPS: ${(r.err || r.out).trim().split('\n').pop()}`);
    step(`Java ${major} установлена: ${r.out.trim()}`);
    return `${vinfo.home}/${BASE}/java/${major}/bin/java`;
  }

  /** Аргументы запуска для Linux: Forge/NeoForge кладут отдельный файл unix_args.txt. */
  function linuxArgs(args) {
    return args.map((a) => a.replace(/win_args\.txt$/, 'unix_args.txt'));
  }

  function startScript(javaPath, args) {
    return `#!/bin/sh
# Запуск сервера Minecraft в фоне. Создано программой «Блокхост».
cd "$(dirname "$0")" || exit 1
RAM="\${1:-2}"
if [ -f mcl.pid ] && kill -0 "$(cat mcl.pid)" 2>/dev/null; then echo "already running"; exit 0; fi
echo $$ > mcl.pid
# Старый журнал не даём разрастись больше 20 МБ.
if [ -f console.log ] && [ "$(wc -c < console.log)" -gt 20000000 ]; then mv -f console.log console.old.log; fi
: > console.in
rm -f exit.code mcl.done
echo "=== Запуск $(date '+%Y-%m-%d %H:%M:%S'), память \${RAM} ГБ ===" >> console.log
# Команды серверу: раз в секунду новые строки из console.in уходят ему на вход.
# Цикл заканчивается сам, когда сервер остановился (появился mcl.done).
{
  n=0
  while [ ! -f mcl.done ]; do
    t=$(wc -l < console.in)
    if [ "$t" -gt "$n" ]; then sed -n "$((n + 1)),\${t}p" console.in; n=$t; fi
    sleep 1
  done
} | {
  ${sq(javaPath)} -Xms1G -Xmx\${RAM}G -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 ${args.map(sq).join(' ')} nogui >> console.log 2>&1
  echo $? > exit.code
  : > mcl.done
}
echo "=== Сервер остановлен (код $(cat exit.code)) ===" >> console.log
rm -f mcl.pid mcl.done
`;
  }

  /**
   * Перенести сервер с ПК на VPS.
   * localDir — папка сервера на ПК; install — его launcher.json; need — нужная версия Java.
   * На VPS прежняя папка с тем же именем не удаляется, а переименовывается в резервную копию.
   */
  async function transfer(id, { localDir, name, install, need, modded, port }, onStep, onProgress) {
    if (!manage.safeName(name)) throw new Error('Имя сервера может содержать только латиницу, цифры, точку, дефис и подчёркивание');
    onStep('Упаковываю сервер…');
    const tmp = path.join(os.tmpdir(), `mcl-upload-${process.pid}-${Date.now()}.tar.gz`);
    try {
      const entries = fs.readdirSync(localDir).filter((f) => !SKIP_TOP.has(f.toLowerCase()) && !SKIP_FILE.test(f));
      await tar.c(
        {
          gzip: { level: 6 },
          file: tmp,
          cwd: localDir,
          portable: true,
          filter: (p, st) => !SKIP_FILE.test(p) && !(st && st.isSymbolicLink && st.isSymbolicLink()),
        },
        entries
      );
      return await uploadTar(id, { tarFile: tmp, name, install, need, modded, port }, onStep, onProgress);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /**
   * Загрузить готовый архив сервера на VPS, распаковать и подготовить запуск.
   * install — { type, mc, loader, args } (args — для Windows, на Linux заменяются сами).
   */
  async function uploadTar(id, { tarFile, name, install, need, modded, port }, onStep, onProgress) {
    if (!manage.safeName(name)) throw new Error('Имя сервера может содержать только латиницу, цифры, точку, дефис и подчёркивание');
    const step = (t) => onStep(t);
    step('Подключаюсь к VPS…');
    const vinfo = await info(id);
    const existing = vinfo.servers.find((s) => s.name === name);
    if (existing && existing.running) throw new Error(`Сервер «${name}» на VPS сейчас запущен — сначала остановите его`);
    const isWin = vinfo.platform === 'windows';
    if (isWin && vinfo.tar !== '1') throw new Error('На этом VPS нет tar.exe — он есть в Windows 10 (1803 и новее) и Windows Server 2019 и новее. Обновите систему на VPS');
    if (isWin) step(`VPS: ${vinfo.os || 'Windows'}.`);
    const tmp = tarFile;
    let total = 0;
    {
      total = fs.statSync(tmp).size;
      if (vinfo.disk && Number(vinfo.disk) * 1024 < total * 3) {
        throw new Error(`На VPS мало места: свободно ${vinfo.diskGb} ГБ, а нужно примерно ${Math.ceil((total * 3) / 1024 ** 3)} ГБ`);
      }

      // 2. Загрузка
      const mb = total / 1024 / 1024;
      step(`Загружаю на VPS (${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} МБ)…`);
      const s = await sftp(id);
      if (isWin) {
        // На Windows пути для SFTP — относительно профиля пользователя (там же, где стартует SFTP).
        for (const d of [BASE, `${BASE}/servers`]) await new Promise((resolve) => s.mkdir(d, () => resolve()));
      } else {
        await exec(id, `mkdir -p "$HOME/${BASE}/servers"`);
      }
      const remoteTmp = isWin ? `${BASE}/upload-${name}.tar.gz` : `${vinfo.home}/${BASE}/upload-${name}.tar.gz`;
      await new Promise((resolve, reject) =>
        s.fastPut(tmp, remoteTmp, { step: (done) => onProgress(done, total) }, (e) => (e ? reject(new Error('Загрузка прервалась: ' + e.message)) : resolve()))
      );
      s.end();

      // 3. Распаковка (старую папку — в резервную копию)
      step('Распаковываю на VPS…');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const r = await run(
        id,
        {
          windows: win.extractScript(name, stamp),
          linux: `set -e
S="$HOME/${BASE}/servers"
D="$S/${name}"
if [ -d "$D" ]; then mv "$D" "$S/${name}.backup-${stamp}"; echo "backup=${name}.backup-${stamp}"; fi
mkdir -p "$D"
tar -xzf "$HOME/${BASE}/upload-${name}.tar.gz" -C "$D"
rm -f "$HOME/${BASE}/upload-${name}.tar.gz"
# IP компьютера на VPS не существует — слушаем все адреса.
[ -f "$D/server.properties" ] && sed -i 's/^server-ip=.*/server-ip=/' "$D/server.properties"
rm -f "$D/mcl.pid" "$D/run.bat"
echo ok`,
        },
        { timeout: 10 * 60 * 1000 }
      );
      if (r.code !== 0) throw new Error('Не удалось распаковать сервер на VPS: ' + (r.err || r.out).trim().split('\n').pop());
      const backup = (r.out.match(/backup=(\S+)/) || [])[1];
      if (backup) step(`Прежняя версия сервера на VPS сохранена в папке ${backup}.`);

      // 4. Java и скрипт запуска
      const javaPath = await ensureJava(id, need, modded, vinfo, step);
      const meta = {
        name,
        type: install.type,
        mc: install.mc,
        loader: install.loader || null,
        port: port || '25565',
        ramGb: Number(install.ramGb) || 2,
        java: javaPath,
        args: install.args,
        uploadedAt: new Date().toISOString(),
      };
      const s2 = await sftp(id);
      const dir = isWin ? `${BASE}/servers/${name}` : `${vinfo.home}/${BASE}/servers/${name}`;
      const write = (p, data, mode) =>
        new Promise((resolve, reject) => s2.writeFile(p, data, { mode }, (e) => (e ? reject(e) : resolve())));
      if (isWin) {
        // BOM — чтобы PowerShell 5 прочитал русские буквы в скрипте как UTF-8.
        await write(`${dir}/mcl-start.ps1`, '﻿' + win.startScript(javaPath, auto.argsFor(install.args, 'windows')), 0o644);
      } else {
        await write(`${dir}/mcl-start.sh`, startScript(javaPath, linuxArgs(install.args)), 0o755);
      }
      await write(`${dir}/mcl.json`, JSON.stringify(meta), 0o644);
      s2.end();
      step('Готово. Сервер на VPS можно запускать.');
      if (isWin) {
        step(`Если игроки не смогут зайти, откройте порт ${port || '25565'} в брандмауэре Windows на VPS (PowerShell от администратора): New-NetFirewallRule -DisplayName "Minecraft" -Direction Inbound -Protocol TCP -LocalPort ${port || '25565'} -Action Allow`);
      }
      return { name, backup: backup || null };
    }
  }

  // ---- запуск и консоль ----

  const sdir = (name) => {
    if (!manage.safeName(name)) throw new Error('Некорректное имя сервера');
    return `"$HOME/${BASE}/servers/${name}"`;
  };

  async function start(id, name, ramGb) {
    const ram = Math.max(1, Math.round(Number(ramGb)) || 2);
    const vinfo = await info(id);
    const srv = vinfo.servers.find((s) => s.name === name);
    if (!srv) throw new Error('Сервер на VPS не найден');
    if (srv.running) return { already: true };
    if (vinfo.memGb && ram > Math.max(1, vinfo.memGb - 1)) {
      throw new Error(`На VPS ${vinfo.memGb} ГБ памяти — серверу можно выделить не больше ${Math.max(1, vinfo.memGb - 1)} ГБ`);
    }
    sdir(name); // проверка имени
    const r = await run(
      id,
      {
        windows: win.launchScript(name, ram),
        linux: `D=${sdir(name)}
[ -f "$D/eula.txt" ] && grep -q '^eula=true' "$D/eula.txt" || { echo "noeula"; exit 3; }
cd "$D" && sed -i 's/"ramGb":[0-9]*/"ramGb":${ram}/' mcl.json
setsid nohup sh "$D/mcl-start.sh" ${ram} > /dev/null 2>&1 < /dev/null &
sleep 1
# mcl.want — «сервер должен работать»: по нему фоновый скрипт поднимает упавший сервер.
[ -f "$D/mcl.pid" ] && : > "$D/mcl.want" && echo started`,
      },
      { timeout: 60000 }
    );
    if (/noeula/.test(r.out)) {
      throw new Error('На VPS не принято лицензионное соглашение: запустите сервер один раз на ПК с галочкой EULA и перенесите снова');
    }
    if (!/started/.test(r.out)) throw new Error('Сервер на VPS не запустился: ' + (r.err || r.out).trim());
    return { started: true };
  }

  async function command(id, name, text) {
    const line = String(text || '').replace(/[\r\n]/g, ' ').trim();
    if (!line) return;
    const b64 = Buffer.from(line + '\n', 'utf8').toString('base64');
    sdir(name); // проверка имени
    const r =
      (await platformOf(id)) === 'windows'
        ? await psh(id, win.commandScript(name, b64))
        : await exec(id, `D=${sdir(name)}; [ -f "$D/mcl.pid" ] && kill -0 "$(cat "$D/mcl.pid")" 2>/dev/null || exit 4; printf %s ${b64} | base64 -d >> "$D/console.in"`);
    if (r.code === 4) throw new Error('Сервер на VPS не запущен');
  }

  /** Остановить: команда stop, а если через минуту не остановился — завершить процесс. */
  async function stop(id, name) {
    sdir(name); // проверка имени
    const r = await run(
      id,
      {
        windows: win.stopScript(name),
        linux: `D=${sdir(name)}
rm -f "$D/mcl.want"
[ -f "$D/mcl.pid" ] || { echo stopped; exit 0; }
P=$(cat "$D/mcl.pid")
kill -0 "$P" 2>/dev/null || { rm -f "$D/mcl.pid"; echo stopped; exit 0; }
echo stop >> "$D/console.in"
i=0; while kill -0 "$P" 2>/dev/null && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done
# Не остановился за минуту — завершаем всю группу процессов (скрипт, java, tail).
if kill -0 "$P" 2>/dev/null; then kill -TERM -- "-$P" 2>/dev/null || kill "$P"; sleep 3; kill -KILL -- "-$P" 2>/dev/null; rm -f "$D/mcl.pid"; : > "$D/mcl.done"; echo killed; else echo stopped; fi`,
      },
      { timeout: 90000 }
    );
    return { killed: /killed/.test(r.out) };
  }

  /** Поток журнала: последние строки и всё новое. onLine(line) — на каждую строку. */
  async function openLog(id, name, onLine) {
    const key = `${id}/${name}`;
    if (streams.has(key)) streams.get(key)();
    const client = await connect(id);
    sdir(name); // проверка имени
    const tail = (await platformOf(id)) === 'windows' ? win.tailCommand(name) : `tail -n 300 -F ${sdir(name)}/console.log 2>/dev/null`;
    return new Promise((resolve, reject) => {
      client.exec(tail, (err, stream) => {
        if (err) return reject(new Error(sshMessage(err)));
        let buf = '';
        stream.on('data', (d) => {
          buf += d;
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const l of lines) onLine(l.replace(/\r$/, ''));
        });
        const close = () => {
          streams.delete(key);
          try {
            stream.close();
          } catch {
            /* уже закрыт */
          }
        };
        stream.on('close', () => streams.delete(key));
        streams.set(key, close);
        resolve();
      });
    });
  }
  function closeLog(id, name) {
    const close = streams.get(`${id}/${name}`);
    if (close) close();
  }

  // ---- настройки, нагрузка, удаление ----

  // SFTP и на Linux, и на Windows начинает в домашней папке — пути относительно неё.
  const remote = (name, file) => {
    if (!manage.safeName(name)) throw new Error('Некорректное имя сервера');
    return `${BASE}/servers/${name}/${file}`;
  };
  const sread = (s, p) => new Promise((resolve, reject) => s.readFile(p, (e, d) => (e ? reject(e) : resolve(d.toString('utf8')))));
  const swrite = (s, p, data) =>
    new Promise((resolve, reject) => s.writeFile(p, data, (e) => (e ? reject(new Error('Не удалось записать файл на VPS: ' + e.message)) : resolve())));

  async function readMeta(s, name) {
    const file = remote(name, 'mcl.json'); // неверное имя — своя ошибка, не «не найден»
    try {
      return JSON.parse(await sread(s, file));
    } catch {
      throw new Error('Сервер на VPS не найден');
    }
  }

  /** Настройки сервера: все строки server.properties и память из mcl.json. */
  async function settings(id, name) {
    const s = await sftp(id);
    try {
      const meta = await readMeta(s, name);
      const text = await sread(s, remote(name, 'server.properties')).catch(() => '');
      return { props: manage.parseProps(text), ramGb: Number(meta.ramGb) || 2, port: meta.port || '25565', hasFile: !!text };
    } finally {
      s.end();
    }
  }

  /** Сохранить изменения: values — только изменённые ключи server.properties; ramGb — память. */
  async function saveSettings(id, name, { values = {}, ramGb } = {}) {
    const s = await sftp(id);
    try {
      const meta = await readMeta(s, name);
      const text = await sread(s, remote(name, 'server.properties')).catch(() => '');
      const clean = manage.validateProps(manage.parseProps(text), values);
      if (Object.keys(clean).length) await swrite(s, remote(name, 'server.properties'), manage.patchProps(text, clean));
      let metaChanged = false;
      if (ramGb !== undefined && ramGb !== null) {
        const n = Math.round(Number(ramGb));
        if (!(n >= 1 && n <= 256)) throw new Error('Память — от 1 до 256 ГБ');
        if (meta.ramGb !== n) {
          meta.ramGb = n;
          metaChanged = true;
        }
      }
      if (clean['server-port'] && meta.port !== clean['server-port']) {
        meta.port = clean['server-port'];
        metaChanged = true;
      }
      if (metaChanged) await swrite(s, remote(name, 'mcl.json'), JSON.stringify(meta));
      return { changed: Object.keys(clean).length + (metaChanged ? 1 : 0) };
    } finally {
      s.end();
    }
  }

  const lastStats = new Map(); // `${id}/${name}` → прошлый замер (для процентов процессора)

  async function sample(id, name, withSize) {
    const r = await run(id, { linux: manage.linuxStatsScript(name, withSize), windows: win.statsScript(name, withSize) }, { timeout: 60000 });
    if (r.code !== 0 && !r.out.trim()) throw new Error('Не удалось снять показания с VPS: ' + (r.err || '').trim().split('\n').pop());
    return manage.parseStats(r.out);
  }

  /** Нагрузка сейчас: процессор и память сервера и всего VPS, место на диске. */
  async function stats(id, name, withSize) {
    const key = `${id}/${name}`;
    let prev = lastStats.get(key) || null;
    // Первый замер: проценты считаются по разнице, поэтому меряем дважды с паузой.
    if (!prev || (prev.at && Date.now() - prev.at > 5 * 60 * 1000)) {
      prev = await sample(id, name, false);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const cur = await sample(id, name, withSize);
    cur.at = Date.now();
    lastStats.set(key, cur);
    return { ...cur, ...manage.computeLoad(prev, cur) };
  }

  /** Удалить сервер с VPS вместе с миром. Только остановленный. */
  async function removeServer(id, name) {
    if (!manage.safeName(name)) throw new Error('Некорректное имя сервера');
    const r = await run(id, { linux: manage.linuxDeleteScript(name), windows: win.deleteScript(name) }, { timeout: 10 * 60 * 1000 });
    if (/running/.test(r.out)) throw new Error('Сервер на VPS запущен — сначала остановите его');
    if (/notfound/.test(r.out)) throw new Error('Сервер на VPS не найден');
    if (!/deleted/.test(r.out)) throw new Error('Не удалось удалить сервер: ' + ((r.err || r.out).trim().split('\n').pop() || 'неизвестная ошибка'));
    closeLog(id, name);
    lastStats.delete(`${id}/${name}`);
    return { deleted: true };
  }

  // ---- SFTP: мелкие помощники ----

  const sp = (fn) => new Promise((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));
  /** Путь на VPS для файла внутри папки сервера (rel уже проверен safeRel). */
  const rpath = (name, rel) => (rel ? remote(name, rel) : remote(name, '').replace(/\/$/, ''));
  const isDirAttrs = (a) => a && (a.mode & 0o170000) === 0o040000;
  const isLinkAttrs = (a) => a && (a.mode & 0o170000) === 0o120000;

  async function withSftp(id, fn) {
    const s = await sftp(id);
    try {
      return await fn(s);
    } finally {
      s.end();
    }
  }

  /** Работает ли сервер (короткая проверка по mcl.pid). */
  async function isRunning(id, name) {
    sdir(name);
    const r = await run(
      id,
      {
        linux: `D=${sdir(name)}; [ -f "$D/mcl.pid" ] && kill -0 "$(cat "$D/mcl.pid")" 2>/dev/null && echo yes || echo no`,
        windows: `${'$'}d = Join-Path $env:USERPROFILE (Join-Path 'mc-launcher\\servers' ${win.psq(name)})
$pf = Join-Path $d 'mcl.pid'
$p = 0
if (Test-Path -LiteralPath $pf) { $p = [int](Get-Content -LiteralPath $pf -TotalCount 1) }
if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { 'yes' } else { 'no' }`,
      },
      { timeout: 30000 }
    );
    return /yes/.test(r.out);
  }

  // ---- фоновые задачи (mcl-tick) ----

  const tickState = new Map(); // id → версия скрипта, установленная в этом сеансе

  /** Записать файл «атомарно»: сначала под другим именем, потом переименовать (sh читает скрипт по ходу работы). */
  async function sreplace(s, p, data, mode) {
    const tmp = `${p}.new`;
    await sp((cb) => s.writeFile(tmp, data, { mode }, cb));
    try {
      await sp((cb) => s.ext_openssh_rename(tmp, p, cb));
    } catch {
      await sp((cb) => s.unlink(p, cb)).catch(() => {});
      await sp((cb) => s.rename(tmp, p, cb));
    }
  }

  /** Поставить (или обновить) скрипт фоновых задач и запуск раз в минуту. Возвращает { warn }. */
  async function ensureTick(id) {
    const plat = await platformOf(id);
    const want = auto.tickVersion(lang());
    if (tickState.get(id) === want) return { warn: null };
    const file = `${BASE}/${plat === 'windows' ? 'mcl-tick.ps1' : 'mcl-tick.sh'}`;
    await withSftp(id, async (s) => {
      const cur = auto.installedVersion(await sread(s, file).catch(() => ''));
      if (cur === want) return;
      await sp((cb) => s.mkdir(BASE, cb)).catch(() => {});
      const text = auto.tickScript(plat, translate, lang());
      // BOM — чтобы PowerShell 5 прочитал русские буквы в скрипте как UTF-8.
      const data = plat === 'windows' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8');
      await sreplace(s, file, data, plat === 'windows' ? 0o644 : 0o755);
    });
    const r = await run(id, { linux: auto.linuxInstallScript(), windows: auto.windowsInstallScript() }, { timeout: 60000 });
    if (/nocron/.test(r.out)) {
      throw new Error('На VPS нет cron, а без него фоновые задачи не работают. Установите его: sudo apt install cron (Debian, Ubuntu) или sudo dnf install cronie (Fedora, CentOS)');
    }
    const tf = r.out.match(/taskfail=(.*)/);
    if (tf) throw new Error(`Не удалось создать задание в Планировщике Windows: ${tf[1].trim()}. Нужен пользователь с правами администратора`);
    if (!/installed/.test(r.out)) throw new Error('Не удалось включить фоновые задачи на VPS: ' + ((r.err || r.out).trim().split('\n').pop() || 'неизвестная ошибка'));
    tickState.set(id, want);
    return { warn: /nocrond/.test(r.out) ? 'Служба cron на VPS не запущена — включите её: sudo systemctl enable --now cron' : null };
  }

  /** Выполнить действие скрипта фоновых задач: backup / restore / restart. */
  async function tickRun(id, mode, name, arg, timeout) {
    if (!manage.safeName(name)) throw new Error('Некорректное имя сервера');
    if (arg && !/^[A-Za-z0-9._-]{1,120}$/.test(arg)) throw new Error('Некорректный файл');
    await ensureTick(id);
    const cmd =
      (await platformOf(id)) === 'windows'
        ? `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${BASE}\\mcl-tick.ps1" -Mode ${mode} -Name ${name}${arg ? ' -Arg ' + arg : ''}`
        : `sh "$HOME/${BASE}/mcl-tick.sh" ${mode} ${name}${arg ? ' ' + arg : ''}`;
    return exec(id, cmd, { timeout });
  }

  /** Настройки фоновых задач сервера (время — по UTC, как в mcl.conf). */
  async function autoGet(id, name) {
    const plat = await platformOf(id);
    return withSftp(id, async (s) => {
      await readMeta(s, name);
      const text = await sread(s, remote(name, 'mcl.conf')).catch(() => '');
      const script = await sread(s, `${BASE}/${plat === 'windows' ? 'mcl-tick.ps1' : 'mcl-tick.sh'}`).catch(() => '');
      return { conf: auto.parseConf(text), installed: !!auto.installedVersion(script), platform: plat };
    });
  }

  async function autoSave(id, name, input) {
    const conf = auto.validateConf(input);
    const { warn } = await ensureTick(id);
    await withSftp(id, async (s) => {
      await readMeta(s, name);
      await swrite(s, remote(name, 'mcl.conf'), auto.confText(conf));
    });
    return { conf, warn };
  }

  /** Включить фоновые задачи без изменения настроек (для истории нагрузки). */
  async function autoEnable(id) {
    return ensureTick(id);
  }

  // ---- история нагрузки и события ----

  async function history(id, name) {
    return withSftp(id, async (s) => {
      await readMeta(s, name);
      let text;
      try {
        text = await sread(s, remote(name, 'mcl-stats.log'));
      } catch {
        return { text: null };
      }
      return { text };
    });
  }

  async function events(id, name) {
    return withSftp(id, async (s) => auto.parseEvents(await sread(s, remote(name, 'mcl-events.log')).catch(() => '')));
  }

  // ---- бэкапы ----

  async function backups(id, name) {
    return withSftp(id, async (s) => {
      await readMeta(s, name);
      let list = [];
      try {
        list = await sp((cb) => s.readdir(remote(name, 'backups'), cb));
      } catch {
        return [];
      }
      return list
        .filter((e) => auto.BACKUP_RE.test(e.filename) && !isDirAttrs(e.attrs))
        .map((e) => ({ file: e.filename, size: e.attrs.size, mtime: e.attrs.mtime * 1000, kind: e.filename.match(auto.BACKUP_RE)[1] }))
        .sort((a, b) => b.file.slice(-30).localeCompare(a.file.slice(-30)) || b.mtime - a.mtime);
    });
  }

  async function backupNow(id, name) {
    const r = await tickRun(id, 'backup', name, 'manual', 60 * 60 * 1000);
    if (/busy/.test(r.out)) throw new Error('Бэкап этого сервера уже делается — подождите');
    const file = (r.out.match(/file=(\S+)/) || [])[1];
    if (!file) throw new Error('Не удалось сделать бэкап: ' + ((r.out.match(/error=(.*)/) || [])[1] || (r.err || '').trim().split('\n').pop() || 'неизвестная ошибка'));
    return { file, size: Number((r.out.match(/size=(\d+)/) || [])[1]) || 0 };
  }

  async function restoreBackup(id, name, file) {
    if (!auto.BACKUP_RE.test(String(file))) throw new Error('Некорректный файл бэкапа');
    const r = await tickRun(id, 'restore', name, file, 60 * 60 * 1000);
    if (/running/.test(r.out)) throw new Error('Сервер на VPS запущен — сначала остановите его');
    if (/nofile/.test(r.out)) throw new Error('Такого бэкапа больше нет');
    if (/nosafety/.test(r.out)) throw new Error('Не удалось сохранить копию текущего мира перед восстановлением — восстановление отменено. Проверьте место на диске VPS');
    if (!/restored/.test(r.out)) throw new Error('Не удалось восстановить: ' + ((r.err || r.out).trim().split('\n').pop() || 'неизвестная ошибка'));
    return { restored: true };
  }

  async function deleteBackup(id, name, file) {
    if (!auto.BACKUP_RE.test(String(file))) throw new Error('Некорректный файл бэкапа');
    await withSftp(id, (s) => sp((cb) => s.unlink(remote(name, `backups/${file}`), cb)));
  }

  async function downloadBackup(id, name, file, localPath, onProgress = () => {}) {
    if (!auto.BACKUP_RE.test(String(file))) throw new Error('Некорректный файл бэкапа');
    await withSftp(id, (s) =>
      sp((cb) => s.fastGet(remote(name, `backups/${file}`), localPath, { step: (done, _c, total) => onProgress(done, total) }, cb)).catch((e) => {
        throw new Error('Скачивание прервалось: ' + e.message);
      })
    );
  }

  // ---- игроки ----

  async function playerLists(id, name) {
    return withSftp(id, async (s) => {
      await readMeta(s, name);
      const raw = {};
      for (const [k, f] of Object.entries(playersLib.FILES)) {
        try {
          const v = JSON.parse(await sread(s, remote(name, f)));
          raw[k] = Array.isArray(v) ? v : [];
        } catch {
          raw[k] = [];
        }
      }
      const props = new Map(manage.parseProps(await sread(s, remote(name, 'server.properties')).catch(() => '')));
      return { ...playersLib.mapLists(raw), onlineMode: props.get('online-mode') !== 'false', whitelistOn: props.get('white-list') === 'true' };
    });
  }

  /** Действие над списком: на работающем сервере — командой, на остановленном — правкой файла. */
  async function playerAction(id, name, { list, action, value, reason }) {
    const v = String(value || '').trim();
    if (list === 'kick') {
      if (!playersLib.NAME_RE.test(v)) throw new Error('Ник — до 16 символов: латиница, цифры и _');
      if (!(await isRunning(id, name))) throw new Error('Сервер на VPS не запущен');
      const why = String(reason || '').replace(/[\r\n]/g, ' ').trim().slice(0, 200);
      await command(id, name, `kick ${v}${why ? ' ' + why : ''}`);
      return { via: 'command' };
    }
    if (await isRunning(id, name)) {
      await command(id, name, playersLib.commandFor(list, action, v, reason));
      return { via: 'command' };
    }
    if (!playersLib.FILES[list]) throw new Error('Неизвестный список');
    await withSftp(id, async (s) => {
      await readMeta(s, name);
      const file = remote(name, playersLib.FILES[list]);
      let data = [];
      try {
        data = JSON.parse(await sread(s, file));
      } catch {
        /* файла ещё нет */
      }
      const props = new Map(manage.parseProps(await sread(s, remote(name, 'server.properties')).catch(() => '')));
      const next = await playersLib.editList(data, list, action, v, { reason, onlineMode: props.get('online-mode') !== 'false' });
      await swrite(s, file, JSON.stringify(next, null, 2));
    });
    return { via: 'file' };
  }

  // ---- файлы сервера ----

  async function files(id, name, rel) {
    const r = auto.safeRel(rel);
    return withSftp(id, async (s) => {
      await readMeta(s, name);
      let list;
      try {
        list = await sp((cb) => s.readdir(rpath(name, r), cb));
      } catch {
        throw new Error('Папка не найдена');
      }
      const items = list
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .map((e) => {
          const p = r ? `${r}/${e.filename}` : e.filename;
          return { name: e.filename, dir: isDirAttrs(e.attrs), link: isLinkAttrs(e.attrs), size: e.attrs.size, mtime: e.attrs.mtime * 1000, protected: auto.isProtected(p) };
        })
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return { rel: r, items };
    });
  }

  const TEXT_MAX = 1024 * 1024;

  async function fileRead(id, name, rel) {
    const r = auto.safeRel(rel);
    if (!r) throw new Error('Выберите файл');
    return withSftp(id, async (s) => {
      const st = await sp((cb) => s.stat(rpath(name, r), cb));
      if (isDirAttrs(st)) throw new Error('Это папка');
      if (st.size > TEXT_MAX) throw new Error('Файл больше 1 МБ — скачайте его, чтобы открыть');
      const buf = await sp((cb) => s.readFile(rpath(name, r), cb));
      if (buf.includes(0)) throw new Error('Это не текстовый файл — его можно только скачать');
      return { text: buf.toString('utf8'), size: st.size, protected: auto.isProtected(r) };
    });
  }

  async function fileWrite(id, name, rel, text) {
    const r = auto.safeRel(rel);
    if (!r) throw new Error('Выберите файл');
    if (auto.isProtected(r)) throw new Error('Этот файл лаунчер ведёт сам — меняйте его настройки в лаунчере');
    const data = Buffer.from(String(text ?? ''), 'utf8');
    if (data.length > TEXT_MAX) throw new Error('Текст больше 1 МБ');
    await withSftp(id, (s) => swrite(s, rpath(name, r), data));
  }

  async function removeTree(s, p) {
    const st = await sp((cb) => s.lstat(p, cb));
    if (!isDirAttrs(st)) return sp((cb) => s.unlink(p, cb));
    for (const e of await sp((cb) => s.readdir(p, cb))) {
      if (e.filename === '.' || e.filename === '..') continue;
      await removeTree(s, `${p}/${e.filename}`);
    }
    return sp((cb) => s.rmdir(p, cb));
  }

  async function fileRemove(id, name, rel) {
    const r = auto.safeRel(rel);
    if (!r) throw new Error('Папку сервера целиком удаляет кнопка «Удалить сервер»');
    if (auto.isProtected(r)) throw new Error('Этот файл нужен лаунчеру — его нельзя удалить');
    await withSftp(id, (s) => removeTree(s, rpath(name, r)));
  }

  async function fileMkdir(id, name, rel, entry) {
    const r = auto.safeRel(rel);
    const n = auto.safeEntryName(entry);
    await withSftp(id, (s) => sp((cb) => s.mkdir(rpath(name, r ? `${r}/${n}` : n), cb)).catch(() => {
      throw new Error('Не удалось создать папку — возможно, такая уже есть');
    }));
  }

  async function fileRename(id, name, rel, entry) {
    const r = auto.safeRel(rel);
    if (!r) throw new Error('Выберите файл');
    if (auto.isProtected(r)) throw new Error('Этот файл нужен лаунчеру — его нельзя переименовать');
    const n = auto.safeEntryName(entry);
    const parent = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
    const to = parent ? `${parent}/${n}` : n;
    if (auto.isProtected(to)) throw new Error('Такое имя занято служебным файлом лаунчера');
    await withSftp(id, (s) => sp((cb) => s.rename(rpath(name, r), rpath(name, to), cb)).catch(() => {
      throw new Error('Не удалось переименовать — возможно, файл с таким именем уже есть');
    }));
  }

  /** Загрузить файлы с ПК в папку rel на VPS. */
  async function fileUpload(id, name, rel, localPaths, onProgress = () => {}) {
    const r = auto.safeRel(rel);
    const list = (localPaths || []).map(String).filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!list.length) throw new Error('Выберите файлы');
    const total = list.reduce((a, p) => a + fs.statSync(p).size, 0);
    let before = 0;
    await withSftp(id, async (s) => {
      for (const p of list) {
        const n = auto.safeEntryName(path.basename(p));
        const to = r ? `${r}/${n}` : n;
        if (auto.isProtected(to)) throw new Error(`«${n}» — служебный файл лаунчера, его нельзя заменить`);
        const size = fs.statSync(p).size;
        await sp((cb) => s.fastPut(p, rpath(name, to), { step: (done) => onProgress(before + done, total) }, cb)).catch((e) => {
          throw new Error(`Не удалось загрузить «${n}»: ${e.message}`);
        });
        before += size;
      }
    });
    return { count: list.length };
  }

  async function fileDownload(id, name, rel, localPath, onProgress = () => {}) {
    const r = auto.safeRel(rel);
    if (!r) throw new Error('Выберите файл');
    await withSftp(id, async (s) => {
      const st = await sp((cb) => s.stat(rpath(name, r), cb));
      if (isDirAttrs(st)) throw new Error('Папку целиком скачать нельзя — скачайте файлы или сделайте бэкап');
      await sp((cb) => s.fastGet(rpath(name, r), localPath, { step: (done) => onProgress(done, st.size) }, cb)).catch((e) => {
        throw new Error('Скачивание прервалось: ' + e.message);
      });
    });
  }

  // ---- перенос с VPS: на ПК или на другой VPS ----

  /** Сведения для переноса: mcl.json и аргументы запуска. */
  async function serverMeta(id, name) {
    const plat = await platformOf(id);
    return withSftp(id, async (s) => {
      const meta = await readMeta(s, name);
      let args = Array.isArray(meta.args) ? meta.args : null;
      if (!args) {
        const text = await sread(s, remote(name, plat === 'windows' ? 'mcl-start.ps1' : 'mcl-start.sh')).catch(() => '');
        args = auto.parseStartArgs(text, plat);
      }
      return { ...meta, args, platform: plat };
    });
  }

  /**
   * Упаковать сервер на VPS и скачать архив на ПК. full — со всеми файлами ядра (для другого VPS);
   * без него — только мир, моды, плагины и настройки (ядро лаунчер на ПК поставит сам).
   */
  async function downloadServer(id, name, localTar, { full = false } = {}, onStep = () => {}, onProgress = () => {}) {
    if (!manage.safeName(name)) throw new Error('Некорректное имя сервера');
    if (await isRunning(id, name)) throw new Error('Сервер на VPS запущен — остановите его перед переносом, иначе мир скопируется наполовину сохранённым');
    onStep('Упаковываю сервер на VPS…');
    const extraSkip = full ? '' : '|libraries|versions|.fabric|bundler|cache';
    const r = await run(
      id,
      {
        linux: `D=${sdir(name)}
T="$HOME/${BASE}/download-${name}.tar.gz"
[ -f "$D/mcl.json" ] || { echo notfound; exit 5; }
cd "$D" || exit 5
set --
for f in * .[!.]*; do
  [ -e "$f" ] || continue
  case "$f" in backups|logs|crash-reports|debug|console.log|console.old.log|console.in|exit.code|mcl.*|mcl-*|.mcl-*${extraSkip}) continue ;; esac
  set -- "$@" "$f"
done
tar -czf "$T" "$@"
c=$?
[ $c -le 1 ] && [ -s "$T" ] || { rm -f "$T"; echo tarfail; exit 7; }
echo "size=$(wc -c < "$T" | tr -d ' ')"`,
        windows: `${'$'}ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$B = Join-Path $env:USERPROFILE 'mc-launcher'
$d = Join-Path $B (Join-Path 'servers' ${win.psq(name)})
$T = Join-Path $B ${win.psq(`download-${name}.tar.gz`)}
if (-not (Test-Path -LiteralPath (Join-Path $d 'mcl.json'))) { 'notfound'; exit 5 }
$skip = '^(backups|logs|crash-reports|debug|console\\.log|console\\.old\\.log|console\\.in|exit\\.code${extraSkip.replace(/\./g, '\\.')})$'
$items = @(Get-ChildItem -LiteralPath $d -Force | Where-Object { $_.Name -notmatch $skip -and $_.Name -notlike 'mcl.*' -and $_.Name -notlike 'mcl-*' -and $_.Name -notlike '.mcl-*' } | ForEach-Object { $_.Name })
$tar = Join-Path $env:SystemRoot 'System32\\tar.exe'
& $tar -czf $T -C $d @items
if ($LASTEXITCODE -gt 1) { 'tarfail'; exit 7 }
"size=$((Get-Item -LiteralPath $T).Length)"`,
      },
      { timeout: 30 * 60 * 1000 }
    );
    if (/notfound/.test(r.out)) throw new Error('Сервер на VPS не найден');
    const size = Number((r.out.match(/size=(\d+)/) || [])[1]);
    if (!size) throw new Error('Не удалось упаковать сервер на VPS: ' + ((r.err || r.out).trim().split('\n').pop() || 'неизвестная ошибка'));
    const mb = size / 1024 / 1024;
    onStep(`Скачиваю с VPS (${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} МБ)…`);
    const rel = `${BASE}/download-${name}.tar.gz`;
    try {
      await withSftp(id, (s) =>
        sp((cb) => s.fastGet(rel, localTar, { step: (done) => onProgress(done, size) }, cb)).catch((e) => {
          throw new Error('Скачивание прервалось: ' + e.message);
        })
      );
    } finally {
      await withSftp(id, (s) => sp((cb) => s.unlink(rel, cb))).catch(() => {});
    }
    return { size };
  }

  // ---- Chunky: прогрузка мира заранее ----

  async function chunkyInfo(id, name) {
    return withSftp(id, async (s) => {
      const meta = await readMeta(s, name);
      let installed = false;
      for (const dir of ['mods', 'plugins']) {
        const list = await sp((cb) => s.readdir(remote(name, dir), cb)).catch(() => []);
        if (list.some((e) => /chunky/i.test(e.filename) && /\.jar$/i.test(e.filename))) installed = true;
      }
      return { installed, type: meta.type, mc: meta.mc, loader: meta.loader || null };
    });
  }

  /** Последние строки Chunky из журнала сервера. */
  async function chunkyLines(id, name) {
    sdir(name);
    const r = await run(
      id,
      {
        linux: `tail -n 2000 ${sdir(name)}/console.log 2>/dev/null | grep -i chunky | tail -n 5`,
        windows: `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$f = Join-Path $env:USERPROFILE (Join-Path 'mc-launcher\\servers' (Join-Path ${win.psq(name)} 'console.log'))
if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f -Tail 2000 -Encoding UTF8 | Select-String -Pattern 'chunky' | Select-Object -Last 5 | ForEach-Object { $_.Line } }`,
      },
      { timeout: 30000 }
    );
    return r.out.split(/\r?\n/).filter(Boolean);
  }

  /** Положить файлы модов/плагинов (уже скачанные на ПК) в папку mods или plugins на VPS. */
  async function uploadJars(id, name, dir, localFiles) {
    if (!['mods', 'plugins'].includes(dir)) throw new Error('Некорректная папка');
    await withSftp(id, async (s) => {
      await readMeta(s, name);
      await sp((cb) => s.mkdir(remote(name, dir), cb)).catch(() => {});
      for (const p of localFiles) {
        const n = path.basename(p);
        if (!/^[^\\/:*?"<>|]+\.jar$/i.test(n)) continue;
        await sp((cb) => s.fastPut(p, remote(name, `${dir}/${n}`), cb));
      }
    });
  }

  /** Виден ли сервер из интернета: пробуем подключиться к порту с ПК. */
  function checkPort(host, port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port: Number(port), timeout: 6000 });
      const done = (ok, reason) => {
        sock.destroy();
        resolve({ ok, reason });
      };
      sock.on('connect', () => done(true));
      sock.on('timeout', () => done(false, 'timeout'));
      sock.on('error', (e) => done(false, e.code));
    });
  }

  function shutdown() {
    for (const id of [...conns.keys()]) disconnect(id);
  }

  return {
    list, save, remove, forgetHostKey, info, transfer, uploadTar, start, stop, command, openLog, closeLog, checkPort,
    settings, saveSettings, stats, removeServer, isRunning,
    autoGet, autoSave, autoEnable, history, events,
    backups, backupNow, restoreBackup, deleteBackup, downloadBackup,
    playerLists, playerAction,
    files, fileRead, fileWrite, fileRemove, fileMkdir, fileRename, fileUpload, fileDownload,
    serverMeta, downloadServer, chunkyInfo, chunkyLines, uploadJars,
    platformOf, get: (id) => pub(get(id)), shutdown, disconnect,
    startScript: (javaPath, args) => startScript(javaPath, linuxArgs(args)), // для проверок
  };
}

module.exports = { createVps, HostKeyError, NAME_RE };
