// Управление с телефона: маленькая веб-страница в домашней сети.
// Выключено по умолчанию. Вход — по 6-значному коду, который показывает лаунчер.
const http = require('http');
const crypto = require('crypto');

const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Сервер Minecraft</title>
<style>
:root{--bg:#f6f4ef;--card:#fff;--line:#e4e0d8;--text:#1c1e22;--muted:#676b72;--ok:#1a8a4a;--warn:#9a5f0c;--bad:#c4362b;--ink:#1c1e22;--ink-t:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--card:#1d2025;--line:#2c3037;--text:#ecebe7;--muted:#9a9ea6;--ok:#3fbf77;--warn:#e0b04f;--bad:#ef6b63;--ink:#ecebe7;--ink-t:#15171b;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,"Segoe UI",sans-serif;padding:16px}
h1{font-size:22px;margin:4px 0 2px}.muted{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-top:12px}
.state{font-weight:700}.state.running{color:var(--ok)}.state.busy{color:var(--warn)}
button{font:inherit;font-weight:600;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--text);height:46px;padding:0 18px}
button.primary{background:var(--ink);color:var(--ink-t);border-color:var(--ink)}button:disabled{opacity:.45}
.row{display:flex;gap:8px}.row>*{flex:1}input{font:inherit;height:46px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--text);padding:0 12px;width:100%}
.log{font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;max-height:40vh;overflow:auto;color:var(--muted)}
.err{color:var(--bad);font-size:14px;min-height:1em;margin-top:8px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{padding:3px 10px;border-radius:14px;border:1px solid var(--line);font-size:14px}
</style></head><body>
<div id="login"><h1>Сервер Minecraft</h1><p class="muted">Введите код из лаунчера (вкладка «Настройки» → «Управление с телефона»).</p>
<div class="card"><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Код"><div style="height:8px"></div><button class="primary" id="enter" style="width:100%">Войти</button><div class="err" id="lerr"></div></div></div>
<div id="app" hidden><h1 id="name">Сервер</h1><div class="muted"><span id="state" class="state"></span> <span id="meta"></span></div>
<div class="card row"><button class="primary" id="start">Запустить</button><button id="stop">Остановить</button></div>
<div class="card"><b>На сервере</b><div class="chips" id="players" style="margin-top:8px"></div></div>
<div class="card"><form class="row" id="cmdf"><input id="cmd" placeholder="Команда, например: say Привет" autocomplete="off"><button style="flex:0 0 auto">Отправить</button></form><div class="err" id="err"></div></div>
<div class="card"><b>Журнал</b><div class="log" id="log"></div></div></div>
<script>
const $=(id)=>document.getElementById(id);
async function api(p,body){const r=await fetch(p,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Mcl':'1'},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j.error||('Ошибка '+r.status)),{status:r.status});return j}
const T={stopped:'Остановлен',downloading:'Скачивается…',installing:'Устанавливается…',starting:'Запускается…',running:'Работает',stopping:'Останавливается…'};
async function tick(){try{const s=await api('/api/status');$('login').hidden=true;$('app').hidden=false;$('name').textContent=s.name||'Сервер';
const st=$('state');st.textContent=T[s.state]||s.state;st.className='state '+(s.state==='running'?'running':s.state==='stopped'?'':'busy');
$('meta').textContent=s.state==='running'?('· игроков '+s.players.length+(s.tps?(' · '+s.tps+' TPS'):'')):'';
$('start').disabled=s.state!=='stopped'||!s.canStart;$('stop').disabled=!(s.state==='running'||s.state==='starting');
$('players').textContent='';if(!s.players.length){$('players').textContent='никого';}for(const p of s.players){const c=document.createElement('span');c.className='chip';c.textContent=p;$('players').appendChild(c)}
const l=$('log');const stick=l.scrollHeight-l.scrollTop-l.clientHeight<30;l.textContent=s.log.join('\\n');if(stick)l.scrollTop=l.scrollHeight;
}catch(e){if(e.status===401){$('app').hidden=true;$('login').hidden=false}}}
$('enter').onclick=async()=>{$('lerr').textContent='';try{await api('/api/login',{code:$('code').value.trim()});tick()}catch(e){$('lerr').textContent=e.message}};
$('start').onclick=()=>api('/api/start',{}).then(tick).catch(e=>$('err').textContent=e.message);
$('stop').onclick=()=>{if(confirm('Остановить сервер?'))api('/api/stop',{}).then(tick).catch(e=>$('err').textContent=e.message)};
$('cmdf').onsubmit=(e)=>{e.preventDefault();const t=$('cmd').value.trim();if(!t)return;$('err').textContent='';api('/api/command',{text:t}).then(()=>{$('cmd').value='';tick()}).catch(e=>$('err').textContent=e.message)};
tick();setInterval(tick,3000);
</script></body></html>`;

/**
 * hooks: { status() → {state, name, players, tps, log, canStart}, start(), stop(), command(text) }
 */
function createRemote(hooks) {
  let server = null;
  let code = null;
  let port = null;
  const tokens = new Set();
  const fails = { count: 0, until: 0 };

  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };
  const tokenOf = (req) => {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)mcl=([a-f0-9]{48})/);
    return m && tokens.has(m[1]) ? m[1] : null;
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 4096) {
          reject(new Error('Слишком большой запрос'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('Некорректный запрос'));
        }
      });
    });

  async function handler(req, res) {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      return res.end(PAGE);
    }
    if (!url.startsWith('/api/')) return json(res, 404, { error: 'Не найдено' });
    // Защита от запросов с чужих страниц: только fetch с нашим заголовком.
    if (req.headers['x-mcl'] !== '1') return json(res, 403, { error: 'Запрещено' });
    try {
      if (url === '/api/login' && req.method === 'POST') {
        if (Date.now() < fails.until) return json(res, 429, { error: 'Слишком много попыток — подождите 5 минут' });
        const body = await readBody(req);
        const ok = typeof body.code === 'string' && code && body.code.length === code.length &&
          crypto.timingSafeEqual(Buffer.from(body.code), Buffer.from(code));
        if (!ok) {
          if (++fails.count >= 8) {
            fails.until = Date.now() + 5 * 60 * 1000;
            fails.count = 0;
          }
          return json(res, 401, { error: 'Неверный код' });
        }
        fails.count = 0;
        const t = crypto.randomBytes(24).toString('hex');
        tokens.add(t);
        return json(res, 200, { ok: true }, { 'Set-Cookie': `mcl=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
      }
      if (!tokenOf(req)) return json(res, 401, { error: 'Нужен вход' });
      if (url === '/api/status' && req.method === 'GET') return json(res, 200, await hooks.status());
      if (req.method !== 'POST') return json(res, 405, { error: 'Нельзя' });
      const body = await readBody(req);
      if (url === '/api/start') await hooks.start();
      else if (url === '/api/stop') await hooks.stop();
      else if (url === '/api/command') {
        const text = String(body.text || '').replace(/[\r\n]/g, ' ').trim().slice(0, 300);
        if (!text) throw new Error('Пустая команда');
        await hooks.command(text);
      } else return json(res, 404, { error: 'Не найдено' });
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message || String(e) });
    }
  }

  return {
    enable(wantPort = 8765) {
      if (server) return this.info();
      code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      tokens.clear();
      port = wantPort;
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => handler(req, res).catch(() => json(res, 500, { error: 'Ошибка' })));
        server.once('error', (e) => {
          server = null;
          reject(new Error(e.code === 'EADDRINUSE' ? `Порт ${port} занят другой программой` : e.message));
        });
        server.listen(port, '0.0.0.0', () => resolve(this.info()));
      });
    },
    disable() {
      if (server) server.close();
      server = null;
      code = null;
      tokens.clear();
    },
    newCode() {
      code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      tokens.clear(); // старые входы больше не действуют
      return this.info();
    },
    info: () => ({ enabled: !!server, code: server ? code : null, port }),
  };
}

module.exports = { createRemote };
