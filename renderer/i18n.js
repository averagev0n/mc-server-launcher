// Английский интерфейс. Тексты в коде остаются русскими, а перевод подставляется
// по словарю (renderer/i18n-en.js): в окне — на лету для всего, что появляется на странице,
// в main.js — для меню в трее, уведомлений, окон выбора файлов и сообщений в Telegram.
(function (root) {
  const CYR = /[А-Яа-яЁё]/;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function createTranslator(dict) {
    const exact = new Map();
    const patterns = [];
    for (const [k, v] of Object.entries(dict || {})) {
      if (!/\{\d+\}/.test(k)) {
        exact.set(k, v);
        continue;
      }
      // «Порт {0} открыт» → /^Порт (.+?) открыт$/; порядок подстановок берём из ключа.
      const order = [];
      const parts = k.split(/(\{\d+\})/).filter((p) => p !== '');
      const re = parts
        .map((part, idx) => {
          const m = part.match(/^\{(\d+)\}$/);
          if (!m) return escapeRe(part);
          order.push(Number(m[1]));
          // {0}{1} подряд: первая подстановка — одно «слово» (число, версия), иначе граница неоднозначна.
          const next = parts[idx + 1];
          return next && /^\{\d+\}$/.test(next) ? '(\\S+)' : '([\\s\\S]*?)';
        })
        .join('');
      const literal = k.replace(/\{\d+\}/g, '').length;
      if (literal < 2) continue; // «{0} {1}» — переводить нечего
      patterns.push({ re: new RegExp(`^${re}$`), order, to: v, literal });
    }
    // Сначала более «конкретные» шаблоны — с длинным постоянным текстом.
    patterns.sort((a, b) => b.literal - a.literal);
    const cache = new Map();

    function core(s, depth) {
      if (!CYR.test(s)) return s;
      const hit = exact.get(s);
      if (hit !== undefined) return hit;
      if (depth > 3) return s;
      for (const p of patterns) {
        const m = p.re.exec(s);
        if (!m) continue;
        const vals = {};
        p.order.forEach((n, i) => (vals[n] = tr(m[i + 1], depth + 1)));
        return p.to.replace(/\{(\d+)\}/g, (_, n) => (vals[n] !== undefined ? vals[n] : ''));
      }
      return null;
    }

    /** Перевести строку; если перевода нет — вернуть как есть. */
    function tr(text, depth = 0) {
      if (typeof text !== 'string' || !CYR.test(text)) return text;
      if (text.includes('\n')) return text.split('\n').map((l) => tr(l, depth)).join('\n');
      const lead = text.match(/^\s*/)[0];
      const tail = text.match(/\s*$/)[0];
      const body = text.slice(lead.length, text.length - tail.length).replace(/\s+/g, ' ');
      if (!body) return text;
      if (depth === 0 && cache.has(body)) return lead + cache.get(body) + tail;
      let out = core(body, depth);
      if (out === null) out = body;
      if (depth === 0) {
        if (cache.size > 5000) cache.clear();
        cache.set(body, out);
      }
      return lead + out + tail;
    }
    return tr;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createTranslator };
    return;
  }

  // ---- окно лаунчера ----
  const lang = (root.launcher && root.launcher.lang) || 'ru';
  root.I18N_LANG = lang;
  root.I18N_LOCALE = lang === 'en' ? 'en-US' : 'ru-RU';
  document.documentElement.lang = lang;
  if (lang !== 'en' || !root.I18N_EN) {
    root.tr = (s) => s;
    return;
  }
  const tr = createTranslator(root.I18N_EN);
  root.tr = tr;

  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
  // Элементы с классом no-tr не переводятся (например, текст, который пишут игроки).
  const isUserText = (el) => !!(el && el.closest && el.closest('.no-tr'));

  function textNode(n) {
    const p = n.parentElement;
    if (!p || SKIP.has(p.tagName) || p.isContentEditable || isUserText(p)) return;
    const v = n.data;
    if (!CYR.test(v)) return;
    const t = tr(v);
    if (t !== v) n.data = t;
  }
  function element(el) {
    if (SKIP.has(el.tagName) || isUserText(el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && CYR.test(v)) {
        const t = tr(v);
        if (t !== v) el.setAttribute(a, t);
      }
    }
    if (el.tagName === 'OPTION' || el.tagName === 'OPTGROUP') {
      const l = el.getAttribute('label');
      if (l && CYR.test(l)) el.setAttribute('label', tr(l));
    }
  }
  function walk(rootNode) {
    if (rootNode.nodeType === 3) return textNode(rootNode);
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
    if (rootNode.nodeType === 1) {
      if (SKIP.has(rootNode.tagName) || isUserText(rootNode)) return;
      element(rootNode);
    }
    const it = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n = it.nextNode();
    while (n) {
      if (n.nodeType === 3) textNode(n);
      else element(n);
      n = it.nextNode();
    }
  }
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') textNode(m.target);
      else if (m.type === 'attributes') element(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  document.addEventListener('DOMContentLoaded', () => {
    walk(document.body);
    document.title = tr(document.title);
  });

  // Окна подтверждения тоже на английском.
  for (const fn of ['confirm', 'alert', 'prompt']) {
    const orig = root[fn].bind(root);
    root[fn] = (msg, ...rest) => orig(tr(String(msg ?? '')), ...rest);
  }
})(this);
