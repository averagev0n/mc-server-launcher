// Перенос сервера на VPS (Linux) по SSH и управление им там: запуск, остановка, консоль.
//
// На VPS всё лежит в домашней папке пользователя, права root не нужны:
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
function createVps({ dataDir, encrypt, decrypt, log = () => {} }) {
  const file = path.join(dataDir, 'vps.json');
  const conns = new Map(); // id → { client, timer }
  const streams = new Map(); // `${id}/${name}` → закрыть поток журнала

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
    const client = await connect(id);
    return new Promise((resolve, reject) => client.sftp((e, s) => (e ? reject(new Error(sshMessage(e))) : resolve(s))));
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
    const r = await sh(id, script, { timeout: 30000 });
    const res = { javas: [], servers: [] };
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
    if (!NAME_RE.test(name)) throw new Error('Имя сервера может содержать только латиницу, цифры, точку, дефис и подчёркивание');
    const step = (t) => onStep(t);
    step('Подключаюсь к VPS…');
    const vinfo = await info(id);
    const existing = vinfo.servers.find((s) => s.name === name);
    if (existing && existing.running) throw new Error(`Сервер «${name}» на VPS сейчас запущен — сначала остановите его`);

    // 1. Архив
    step('Упаковываю сервер…');
    const tmp = path.join(os.tmpdir(), `mcl-upload-${process.pid}-${Date.now()}.tar.gz`);
    let total = 0;
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
      total = fs.statSync(tmp).size;
      if (vinfo.disk && Number(vinfo.disk) * 1024 < total * 3) {
        throw new Error(`На VPS мало места: свободно ${vinfo.diskGb} ГБ, а нужно примерно ${Math.ceil((total * 3) / 1024 ** 3)} ГБ`);
      }

      // 2. Загрузка
      const mb = total / 1024 / 1024;
      step(`Загружаю на VPS (${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} МБ)…`);
      await exec(id, `mkdir -p "$HOME/${BASE}/servers"`);
      const s = await sftp(id);
      const remoteTmp = `${vinfo.home}/${BASE}/upload-${name}.tar.gz`;
      await new Promise((resolve, reject) =>
        s.fastPut(tmp, remoteTmp, { step: (done) => onProgress(done, total) }, (e) => (e ? reject(new Error('Загрузка прервалась: ' + e.message)) : resolve()))
      );
      s.end();

      // 3. Распаковка (старую папку — в резервную копию)
      step('Распаковываю на VPS…');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const r = await sh(
        id,
        `set -e
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
        ramGb: 2,
        java: javaPath,
        uploadedAt: new Date().toISOString(),
      };
      const s2 = await sftp(id);
      const dir = `${vinfo.home}/${BASE}/servers/${name}`;
      const write = (p, data, mode) =>
        new Promise((resolve, reject) => s2.writeFile(p, data, { mode }, (e) => (e ? reject(e) : resolve())));
      await write(`${dir}/mcl-start.sh`, startScript(javaPath, linuxArgs(install.args)), 0o755);
      await write(`${dir}/mcl.json`, JSON.stringify(meta), 0o644);
      s2.end();
      step('Готово. Сервер на VPS можно запускать.');
      return { name, backup: backup || null };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // ---- запуск и консоль ----

  const sdir = (name) => {
    if (!NAME_RE.test(name)) throw new Error('Некорректное имя сервера');
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
    const r = await sh(
      id,
      `D=${sdir(name)}
[ -f "$D/eula.txt" ] && grep -q '^eula=true' "$D/eula.txt" || { echo "noeula"; exit 3; }
cd "$D" && sed -i 's/"ramGb":[0-9]*/"ramGb":${ram}/' mcl.json
setsid nohup sh "$D/mcl-start.sh" ${ram} > /dev/null 2>&1 < /dev/null &
sleep 1
[ -f "$D/mcl.pid" ] && echo started`,
      { timeout: 30000 }
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
    const r = await exec(id, `D=${sdir(name)}; [ -f "$D/mcl.pid" ] && kill -0 "$(cat "$D/mcl.pid")" 2>/dev/null || exit 4; printf %s ${b64} | base64 -d >> "$D/console.in"`);
    if (r.code === 4) throw new Error('Сервер на VPS не запущен');
  }

  /** Остановить: команда stop, а если через минуту не остановился — завершить процесс. */
  async function stop(id, name) {
    const r = await sh(
      id,
      `D=${sdir(name)}
[ -f "$D/mcl.pid" ] || { echo stopped; exit 0; }
P=$(cat "$D/mcl.pid")
kill -0 "$P" 2>/dev/null || { rm -f "$D/mcl.pid"; echo stopped; exit 0; }
echo stop >> "$D/console.in"
i=0; while kill -0 "$P" 2>/dev/null && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done
# Не остановился за минуту — завершаем всю группу процессов (скрипт, java, tail).
if kill -0 "$P" 2>/dev/null; then kill -TERM -- "-$P" 2>/dev/null || kill "$P"; sleep 3; kill -KILL -- "-$P" 2>/dev/null; rm -f "$D/mcl.pid"; : > "$D/mcl.done"; echo killed; else echo stopped; fi`,
      { timeout: 90000 }
    );
    return { killed: /killed/.test(r.out) };
  }

  /** Поток журнала: последние строки и всё новое. onLine(line) — на каждую строку. */
  async function openLog(id, name, onLine) {
    const key = `${id}/${name}`;
    if (streams.has(key)) streams.get(key)();
    const client = await connect(id);
    return new Promise((resolve, reject) => {
      client.exec(`tail -n 300 -F ${sdir(name)}/console.log 2>/dev/null`, (err, stream) => {
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

  return { list, save, remove, forgetHostKey, info, transfer, start, stop, command, openLog, closeLog, checkPort, get: (id) => pub(get(id)), shutdown, disconnect };
}

module.exports = { createVps, HostKeyError, NAME_RE };
