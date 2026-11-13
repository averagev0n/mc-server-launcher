// Телеграм-бот: уведомления о сервере и команды из одного привязанного чата.
// Работает через длинный опрос getUpdates — без входящих подключений и открытых портов.

const TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,60}$/;
const API = 'https://api.telegram.org/bot';

/** «/say@MyBot привет» → { cmd: 'say', arg: 'привет' }. */
function parseCommand(text) {
  const m = /^\/([A-Za-z_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

function createTelegram({ fetchFn, onMessage, onFatal }) {
  let token = '';
  let running = false;
  let offset = 0;
  let ctrl = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(method, body, tok = token, signal) {
    let res;
    try {
      res = await fetchFn(API + tok + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw new Error('Нет связи с Telegram — проверьте интернет');
    }
    const j = await res.json().catch(() => ({}));
    if (!j.ok) {
      const e = new Error(res.status === 401 || res.status === 404 ? 'Telegram не принял токен — скопируйте его у @BotFather ещё раз' : j.description || `Telegram ответил ошибкой ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return j.result;
  }

  async function loop(tok) {
    while (running && token === tok) {
      try {
        ctrl = new AbortController();
        const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, tok, ctrl.signal);
        for (const u of ups) {
          offset = u.update_id + 1;
          if (u.message && typeof u.message.text === 'string') {
            try {
              await onMessage(u.message);
            } catch {
              /* одна команда не должна останавливать бота */
            }
          }
        }
      } catch (e) {
        if (!running || token !== tok) break;
        if (e.status === 401 || e.status === 404) {
          running = false;
          onFatal(e.message);
          break;
        }
        // 409 — тот же бот опрашивается в другом месте; остальное — сеть. Ждём и пробуем снова.
        await sleep(e.status === 409 ? 30000 : 10000);
      }
    }
  }

  return {
    /** Проверить токен: вернёт { username, first_name }. */
    me: (tok) => {
      if (!TOKEN_RE.test(tok)) return Promise.reject(new Error('Это не похоже на токен бота (вида 123456789:AA…)'));
      return call('getMe', {}, tok);
    },
    start(tok) {
      if (running && token === tok) return;
      this.stop();
      token = tok;
      running = true;
      loop(tok);
    },
    stop() {
      running = false;
      token = '';
      if (ctrl) ctrl.abort();
    },
    get running() {
      return running;
    },
    send(chatId, text) {
      if (!running || !chatId) return Promise.resolve();
      return call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }).catch(() => {});
    },
  };
}

module.exports = { createTelegram, parseCommand, TOKEN_RE };
