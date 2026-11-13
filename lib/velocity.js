// Сеть серверов через прокси Velocity: один адрес для игроков, переход между серверами командой /server.
// Поддерживаются серверы Paper 1.19+ (у них есть config/paper-global.yml с настройками прокси).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Имя сервера в сети: латиница, цифры, дефис (по нему игроки переходят: /server <имя>). */
function slugName(s, used) {
  let base = String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'server';
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}`;
  used.add(name);
  return name;
}

const tomlStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** velocity.toml: прокси на порту port, серверы — на 127.0.0.1 (снаружи к ним не подключиться). */
function velocityToml({ port, motd, onlineMode, servers }) {
  const list = servers.map((s) => `${s.name} = ${tomlStr(`127.0.0.1:${s.port}`)}`).join('\n');
  return `# Создано лаунчером MC Server Launcher. Сервера и порт меняются во вкладке «Настройки» → «Сеть серверов».
config-version = "2.7"
bind = ${tomlStr(`0.0.0.0:${port}`)}
motd = ${tomlStr(motd || '<#55ff55>Сеть серверов')}
show-max-players = 100
online-mode = ${onlineMode ? 'true' : 'false'}
force-key-authentication = ${onlineMode ? 'true' : 'false'}
prevent-client-proxy-connections = false
player-info-forwarding-mode = "modern"
forwarding-secret-file = "forwarding.secret"
announce-forge = false
kick-existing-players = false
ping-passthrough = "DISABLED"
enable-player-address-logging = true

[servers]
${list}
try = [${servers.length ? tomlStr(servers[0].name) : ''}]

[forced-hosts]

[advanced]
compression-threshold = 256
compression-level = -1
login-ratelimit = 3000
connection-timeout = 5000
read-timeout = 30000
haproxy-protocol = false
tcp-fast-open = false
bungee-plugin-message-channel = true
show-ping-requests = false
failover-on-unexpected-server-disconnect = true
announce-proxy-commands = true
log-command-executions = false
log-player-connections = true
accepts-transfers = false

[query]
enabled = false
port = ${port}
map = "Velocity"
show-plugins = false
`;
}

/** Включить у сервера Paper приём игроков от Velocity (modern forwarding). */
function enablePaperForwarding(serverDir, secret) {
  const file = path.join(serverDir, 'config', 'paper-global.yml');
  if (!fs.existsSync(file)) {
    throw new Error('Нет config/paper-global.yml — запустите этот сервер один раз (нужен Paper 1.19 или новее)');
  }
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  doc.setIn(['proxies', 'velocity', 'enabled'], true);
  doc.setIn(['proxies', 'velocity', 'online-mode'], true);
  doc.setIn(['proxies', 'velocity', 'secret'], secret);
  fs.writeFileSync(file, doc.toString(), 'utf8');
}
function disablePaperForwarding(serverDir) {
  const file = path.join(serverDir, 'config', 'paper-global.yml');
  if (!fs.existsSync(file)) return;
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  doc.setIn(['proxies', 'velocity', 'enabled'], false);
  fs.writeFileSync(file, doc.toString(), 'utf8');
}

const newSecret = () => crypto.randomBytes(18).toString('base64url');

module.exports = { velocityToml, enablePaperForwarding, disablePaperForwarding, slugName, newSecret, NAME_RE };
