// Чат игроков: разбор строк журнала и команда для ответа от имени сервера.

// «[12:00:00] [Server thread/INFO]: <Steve> привет», у Paper — «[Async Chat Thread - #0/INFO]: [Not Secure] <Steve> привет».
const CHAT_RE = /\]:\s(?:\[Not Secure\]\s)?<([.\w]{1,17})>\s(.*)$/;

function parseChat(line) {
  const m = CHAT_RE.exec(String(line));
  return m ? { name: m[1], text: m[2] } : null;
}

const TARGET_RE = /^(@a|\.?[A-Za-z0-9_]{1,16})$/;

/** Сообщение игрокам: всем (@a) или одному по нику. Строки и спецсимволы JSON экранируются. */
function tellraw(target, text) {
  if (!TARGET_RE.test(target)) throw new Error('Некорректный ник');
  const clean = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240);
  if (!clean) throw new Error('Пустое сообщение');
  const tag = target === '@a' ? '[Сервер] ' : '[Сервер → вам] ';
  return `tellraw ${target} ["",{"text":${JSON.stringify(tag)},"color":"gold"},{"text":${JSON.stringify(clean)}}]`;
}

module.exports = { parseChat, tellraw };
