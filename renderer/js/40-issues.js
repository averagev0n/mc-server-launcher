// Часть интерфейса лаунчера. Все файлы из renderer/js подключаются по порядку в index.html
// и видят общие переменные друг друга (обычные скрипты, без сборщика).
// ---- объяснения ошибок ----

let issues = []; // карточки «что случилось» для текущего запуска
let issuesCollapsed = false;

function issueAction(a) {
  switch (a.type) {
    case 'search': {
      tab = 'mods';
      if (a.kind && kinds().includes(a.kind)) modsKind = a.kind;
      else if (kinds().includes('mod') && !a.kind) modsKind = 'mod';
      modsView = 'search';
      resetMods();
      $('search').value = a.query || '';
      renderTabs();
      refreshInstalled();
      runSearch(false);
      break;
    }
    case 'mods':
      tab = 'mods';
      if (a.kind && kinds().includes(a.kind)) modsKind = a.kind;
      modsView = 'installed';
      renderTabs();
      refreshInstalled();
      break;
    case 'ram':
      $('ram').scrollIntoView({ block: 'center', behavior: 'smooth' });
      $('ram').focus();
      $('ram').select();
      break;
    case 'java':
      installJavaAuto(a.version);
      return Promise.resolve(`Устанавливаю Java ${ltsFor(a.version)} — прогресс в блоке «Запуск» слева. Потом запустите сервер снова.`);
    case 'open':
      api.call('issue:open', { path: a.path }).catch(fail);
      break;
    case 'folder':
      api.call('open:folder', selected()).catch(fail);
      break;
    case 'logs':
      api.call('issue:logs').catch(fail);
      break;
    case 'copy':
      return api
        .call('issue:copyLog')
        .then((n) => `Скопировано строк: ${n}. Вставьте их в сообщение на форуме или автору мода.`);
    default:
      break;
  }
  return null;
}

function renderIssues() {
  const box = $('issues');
  box.hidden = !issues.length;
  box.classList.toggle('collapsed', issuesCollapsed);
  const errors = issues.filter((i) => i.severity === 'error').length;
  $('issues-title').textContent = errors
    ? `Что случилось — ${issues.length === 1 ? 'найдена причина' : `подсказок: ${issues.length}`}`
    : `Подсказки: ${issues.length}`;
  $('issues-toggle').textContent = issuesCollapsed ? 'Показать' : 'Свернуть';
  const list = $('issues-list');
  list.replaceChildren();
  // Ошибки — сверху, предупреждения и сведения — ниже.
  const order = { error: 0, warn: 1, info: 2 };
  for (const issue of [...issues].sort((a, b) => order[a.severity] - order[b.severity])) {
    const card = document.createElement('div');
    card.className = `issue ${issue.severity}`;
    card.setAttribute('role', 'listitem');

    const top = document.createElement('div');
    top.className = 'issue-top';
    const title = document.createElement('div');
    title.className = 'issue-title';
    title.textContent = issue.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'link-btn';
    close.textContent = 'Скрыть';
    close.addEventListener('click', () => {
      issues = issues.filter((x) => x !== issue);
      renderIssues();
      renderTabs();
    });
    top.append(title, close);
    card.appendChild(top);

    const text = document.createElement('p');
    text.className = 'issue-text';
    text.textContent = issue.text;
    card.appendChild(text);

    if (issue.fix && issue.fix.length) {
      const ul = document.createElement(issue.fix.length > 1 ? 'ol' : 'ul');
      ul.className = 'issue-fix';
      for (const f of issue.fix) {
        const li = document.createElement('li');
        li.textContent = f;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'issue-actions';
    const note = document.createElement('span');
    note.className = 'hint';
    for (const a of issue.actions || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = a.label;
      b.addEventListener('click', async () => {
        try {
          const msg = await issueAction(a);
          if (msg) {
            note.textContent = msg;
            note.className = 'hint good';
          }
        } catch (e) {
          note.textContent = e.message;
          note.className = 'hint bad';
        }
      });
      actions.appendChild(b);
    }
    let lineEl = null;
    if (issue.line) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      b.textContent = 'Строка из журнала';
      b.addEventListener('click', () => {
        lineEl.hidden = !lineEl.hidden;
      });
      actions.appendChild(b);
      lineEl = document.createElement('pre');
      lineEl.className = 'issue-line';
      lineEl.textContent = issue.line;
      lineEl.hidden = true;
    }
    actions.appendChild(note);
    if (actions.childElementCount > 1 || (issue.actions || []).length) card.appendChild(actions);
    if (lineEl) card.appendChild(lineEl);
    list.appendChild(card);
  }
}

$('issues-toggle').addEventListener('click', () => {
  issuesCollapsed = !issuesCollapsed;
  renderIssues();
});
api.on('issues:clear', () => {
  issues = [];
  issuesCollapsed = false;
  renderIssues();
  renderTabs();
});
api.on('issue', (issue) => {
  issues.push(issue);
  if (issue.severity === 'error') issuesCollapsed = false;
  renderIssues();
  renderTabs();
});
