// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- обновления ----

const upd = { enabled: false, version: '', state: { status: 'idle' }, whatsNew: null, dismissed: '', notesOpen: false };

/** Простой markdown (заголовки, списки, `код`, **жирный**) — только через textContent, без HTML. */
function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  let list = null;
  const inline = (parent, text) => {
    for (const part of String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
      if (!part) continue;
      if (part.startsWith('`')) {
        const c = document.createElement('code');
        c.textContent = part.slice(1, -1);
        parent.appendChild(c);
      } else if (part.startsWith('**')) {
        const b = document.createElement('b');
        b.textContent = part.slice(2, -2);
        parent.appendChild(b);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  };
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (!list) {
        list = document.createElement('ul');
        frag.appendChild(list);
      }
      const li = document.createElement('li');
      inline(li, item[1]);
      list.appendChild(li);
      continue;
    }
    list = null;
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const el = document.createElement(h ? 'h4' : 'p');
    inline(el, h ? h[1] : line);
    frag.appendChild(el);
  }
  return frag;
}

function renderUpdate() {
  const box = $('update');
  const s = upd.state;
  const foot = $('check-updates');
  $('app-version').textContent = upd.version ? `Версия ${upd.version}` : '';
  foot.hidden = !upd.enabled;
  foot.disabled = s.status === 'checking' || s.status === 'downloading';
  foot.textContent =
    s.status === 'checking' ? 'Проверяю…' : s.status === 'none' && s.manual ? 'Обновлений нет' : 'Проверить обновления';

  let title = '';
  let sub = '';
  let action = '';
  let notes = '';
  let bad = false;
  const key = `${s.status}|${s.version || ''}`;
  if (['available', 'downloading', 'ready'].includes(s.status)) {
    notes = s.notes;
    if (s.status === 'available') {
      title = `Доступна версия ${s.version}`;
      sub = `у вас ${upd.version}`;
      action = s.mode === 'portable' ? 'Скачать' : 'Скачать и установить';
    } else if (s.status === 'downloading') {
      title = `Скачиваю версию ${s.version}…`;
      sub = `${s.percent || 0}%`;
    } else {
      title = `Версия ${s.version} скачана`;
      sub = isSelectedRunning() || running ? 'сервер будет остановлен с сохранением мира' : '';
      action = 'Перезапустить и обновить';
    }
  } else if (s.status === 'error' && s.manual) {
    title = 'Не удалось проверить обновления';
    sub = s.error || '';
    bad = true;
  } else if (upd.whatsNew) {
    title = `Лаунчер обновлён до версии ${upd.whatsNew.version}`;
    notes = upd.whatsNew.notes;
  }

  const show = !!title && upd.dismissed !== (upd.whatsNew && !action ? 'whatsnew' : key);
  box.hidden = !show;
  if (!show) return;
  box.classList.toggle('bad', bad);
  $('update-title').textContent = title;
  $('update-sub').textContent = sub;
  $('update-action').hidden = !action;
  $('update-action').textContent = action;
  $('update-action').disabled = s.status === 'downloading';
  $('update-toggle').hidden = !notes;
  $('update-toggle').textContent = upd.notesOpen ? 'Скрыть' : 'Что нового';
  $('update-close').hidden = s.status === 'downloading';
  const n = $('update-notes');
  n.hidden = !notes || !upd.notesOpen;
  n.replaceChildren(renderMarkdown(notes));
}

$('update-toggle').addEventListener('click', () => {
  upd.notesOpen = !upd.notesOpen;
  renderUpdate();
});
$('update-close').addEventListener('click', () => {
  const s = upd.state;
  upd.dismissed = ['available', 'ready', 'error'].includes(s.status) ? `${s.status}|${s.version || ''}` : 'whatsnew';
  if (upd.dismissed === 'whatsnew') upd.whatsNew = null;
  renderUpdate();
});
$('update-action').addEventListener('click', async () => {
  try {
    if (upd.state.status === 'ready') await api.call('update:install');
    else await api.call('update:download');
  } catch (e) {
    fail(e);
  }
});
$('check-updates').addEventListener('click', () => {
  upd.dismissed = '';
  api.call('update:check').catch(fail);
});
api.on('update', (s) => {
  const fresh = s.status === 'available' && upd.state.version !== s.version;
  upd.state = s;
  if (fresh) upd.notesOpen = false;
  renderUpdate();
});

async function loadUpdateState() {
  try {
    const u = await api.call('update:state');
    upd.enabled = u.enabled;
    upd.version = u.version;
    upd.state = u.state || { status: 'idle' };
    upd.whatsNew = u.whatsNew && u.whatsNew.notes ? u.whatsNew : null;
    if (upd.whatsNew) upd.notesOpen = true;
  } catch {
    /* не критично */
  }
  renderUpdate();
}
