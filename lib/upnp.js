// Открытие порта на домашнем роутере через UPnP (IGD) — чтобы друзья могли зайти из интернета.
// Без сторонних библиотек: поиск роутера по SSDP и два SOAP-запроса.
const dgram = require('dgram');
const os = require('os');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const SERVICE_RE = /urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d/;

// ---- разбор ответов (вынесено отдельно, чтобы проверять тестами) ----

function parseSsdp(text) {
  const m = String(text).match(/^location:\s*(\S+)/im);
  return m ? m[1] : null;
}

const xmlValue = (xml, tag) => {
  const m = String(xml).match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, 'i'));
  return m ? m[1].trim() : null;
};

/** Найти в описании роутера службу WANIPConnection/WANPPPConnection и её адрес управления. */
function findService(xml, location) {
  const blocks = String(xml).match(/<service>[\s\S]*?<\/service>/gi) || [];
  const base = xmlValue(xml, 'URLBase') || location;
  for (const b of blocks) {
    const type = xmlValue(b, 'serviceType');
    const control = xmlValue(b, 'controlURL');
    if (type && SERVICE_RE.test(type) && control) {
      return { type, control: new URL(control, base).toString() };
    }
  }
  return null;
}

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function envelope(serviceType, action, args) {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`
  );
}

/** Частный, «серый» адрес: такой роутер получает от провайдера при CGNAT. */
function isPrivateIp(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254)
  );
}

/** Адрес этого компьютера в той же сети, что и роутер. */
function localIpFor(gateway) {
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) all.push(a.address);
  }
  const prefix = String(gateway).split('.').slice(0, 3).join('.') + '.';
  return all.find((a) => a.startsWith(prefix)) || all[0] || null;
}

// ---- сеть ----

function discover(timeout = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* уже закрыт */
      }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeout);
    sock.on('error', () => finish(null));
    sock.on('message', (msg, rinfo) => {
      const location = parseSsdp(msg.toString());
      if (location) finish({ location, gateway: rinfo.address });
    });
    sock.bind(() => {
      for (const st of SEARCH_TARGETS) {
        const msg = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
        );
        sock.send(msg, SSDP_PORT, SSDP_ADDR, () => {});
      }
    });
  });
}

async function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error('роутер не ответил')), ms)))]).finally(
    () => clearTimeout(t)
  );
}

async function soap(service, action, args = {}) {
  const res = await withTimeout(
    fetch(service.control, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.type}#${action}"` },
      body: envelope(service.type, action, args),
    }),
    6000
  );
  const text = await res.text();
  if (!res.ok) {
    const desc = xmlValue(text, 'errorDescription') || `HTTP ${res.status}`;
    const code = xmlValue(text, 'errorCode');
    throw new Error(code ? `${desc} (${code})` : desc);
  }
  return text;
}

let cached = null; // { service, gateway }

async function gateway() {
  if (cached) return cached;
  const found = await discover();
  if (!found) throw new Error('Роутер с UPnP не найден — в настройках роутера UPnP может быть выключен');
  const res = await withTimeout(fetch(found.location), 5000);
  const service = findService(await res.text(), found.location);
  if (!service) throw new Error('Роутер не позволяет открывать порты через UPnP');
  cached = { service, gateway: found.gateway };
  return cached;
}

/** Открыть TCP-порт на роутере. Возвращает внешний адрес роутера. */
async function openPort(port, description = 'Minecraft server') {
  const gw = await gateway();
  const internal = localIpFor(gw.gateway);
  if (!internal) throw new Error('Не удалось определить адрес компьютера в домашней сети');
  const args = (lease) => ({
    NewRemoteHost: '',
    NewExternalPort: port,
    NewProtocol: 'TCP',
    NewInternalPort: port,
    NewInternalClient: internal,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: lease,
  });
  try {
    await soap(gw.service, 'AddPortMapping', args(0));
  } catch {
    // Некоторые роутеры не принимают «бессрочно» — просим сутки.
    await soap(gw.service, 'AddPortMapping', args(86400));
  }
  let externalIp = null;
  try {
    externalIp = xmlValue(await soap(gw.service, 'GetExternalIPAddress'), 'NewExternalIPAddress');
  } catch {
    /* адрес не обязателен */
  }
  return { externalIp, internalIp: internal };
}

async function closePort(port) {
  const gw = await gateway();
  await soap(gw.service, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' });
}

module.exports = { openPort, closePort, parseSsdp, findService, envelope, isPrivateIp, xmlValue };
