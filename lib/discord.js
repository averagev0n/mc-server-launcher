// Сообщения в канал Discord через вебхук: сервер запущен, кто зашёл, сервер упал.
// Отправляем по одному с паузой, чтобы не упереться в ограничения Discord.

function createDiscord(fetchFn, ua) {
  const queue = [];
  let busy = false;

  async function post(url, content) {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
      // allowed_mentions: никаких @everyone и упоминаний из ников игроков.
      body: JSON.stringify({ content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    if (res.status === 429) {
      const wait = Number((await res.json().catch(() => ({}))).retry_after) || 2;
      await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
      return post(url, content);
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 404) throw new Error('Discord не принял вебхук — возможно, его удалили. Создайте новый.');
      throw new Error(`Discord ответил ошибкой ${res.status}`);
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const { url, content } = queue.shift();
      try {
        await post(url, content);
      } catch {
        /* фоновые сообщения не важнее работы сервера */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    busy = false;
  }

  return {
    /** Поставить сообщение в очередь (ошибки молча пропускаются). */
    send(url, content) {
      if (!url) return;
      queue.push({ url, content });
      if (queue.length > 50) queue.shift();
      pump();
    },
    /** Отправить сразу и сообщить об ошибке — для кнопки «Проверить». */
    test: (url, content) => post(url, content),
  };
}

/** Убрать из ника разметку Discord, чтобы «_Steve_» не превратился в курсив. */
const escapeMd = (s) => String(s).replace(/([\\*_~`|>])/g, '\\$1');

module.exports = { createDiscord, escapeMd };
