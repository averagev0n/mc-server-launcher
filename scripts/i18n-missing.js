// Какие русские строки интерфейса ещё не переведены на английский (renderer/i18n-en.js).
// Запуск: node scripts/i18n-missing.js. Подстановки ${…} в шаблонах показываются как {0}, {1}…
// Новые переводы дописываются прямо в renderer/i18n-en.js в том же виде.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CYR = /[А-Яа-яЁё]/;
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function tokenize(src, out, file) {
  let i = 0;
  let lastSig = ''; // последний значимый токен — чтобы отличить regex от деления
  const regexAllowed = () => !lastSig || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSig) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(lastSig);
  function readString(q) {
    let s = '';
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const n = src[i + 1];
        s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        i += 2;
        continue;
      }
      s += src[i++];
    }
    i++;
    return s;
  }
  function readTemplate() {
    // возвращает { text: 'a {0} b', exprs: [...] }
    i++;
    let text = '';
    let n = 0;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') {
        const c = src[i + 1];
        text += c === 'n' ? '\n' : c;
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        const start = i;
        let depth = 1;
        // выражение: может содержать строки и вложенные шаблоны
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === '`') {
            const t = readTemplate();
            add(t.text, file, true);
            continue;
          }
          if (c === '"' || c === "'") {
            const s = readString(c);
            add(s, file, false);
            continue;
          }
          if (c === '{') depth++;
          if (c === '}') depth--;
          i++;
        }
        text += `{${n++}}`;
        continue;
      }
      text += src[i++];
    }
    i++;
    return { text };
  }
  function add(s, f, tpl) {
    if (!CYR.test(s)) return;
    // строки из нескольких строк — переводим построчно
    for (const line of s.split('\n')) {
      const k = norm(line);
      if (!CYR.test(k)) continue;
      if (!out.has(k)) out.set(k, { tpl: /\{\d+\}/.test(k), files: new Set() });
      out.get(k).files.add(f);
    }
  }
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      add(readString(c), file, false);
      lastSig = 'str';
      continue;
    }
    if (c === '`') {
      add(readTemplate().text, file, true);
      lastSig = 'str';
      continue;
    }
    if (c === '/' && regexAllowed()) {
      // regex literal
      i++;
      let cls = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        else if (d === '\n') break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] || '')) i++;
      lastSig = 're';
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[\w$]/.test(c)) {
      let w = '';
      while (i < src.length && /[\w$]/.test(src[i])) w += src[i++];
      lastSig = w;
      continue;
    }
    lastSig = c;
    i++;
  }
}

function fromHtml(src, out, file) {
  src = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const add = (s) => {
    const k = norm(s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
    if (!CYR.test(k)) return;
    if (!out.has(k)) out.set(k, { tpl: false, files: new Set() });
    out.get(k).files.add(file);
  };
  for (const m of src.matchAll(/>([^<>]+)</g)) add(m[1]);
  for (const m of src.matchAll(/\s(?:placeholder|title|aria-label|alt|data-tip)="([^"]*)"/g)) add(m[1]);
  const t = src.match(/<title>([^<]*)<\/title>/);
  if (t) add(t[1]);
}

const out = new Map();
const files = [
  ...fs.readdirSync(path.join(ROOT, 'renderer/js')).map((f) => 'renderer/js/' + f),
  'renderer/widget.js',
  'main.js',
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f),
];
for (const f of files) tokenize(fs.readFileSync(path.join(ROOT, f), 'utf8'), out, f);
for (const f of ['renderer/index.html', 'renderer/widget.html']) fromHtml(fs.readFileSync(path.join(ROOT, f), 'utf8'), out, f);

const EN = require(path.join(ROOT, 'renderer', 'i18n-en.js'));
const { createTranslator } = require(path.join(ROOT, 'renderer', 'i18n.js'));
const tr = createTranslator(EN);
const missing = [...out].filter(([k]) => !/remote.js|vps.js/.test([...out.get(k).files].join()) && CYR.test(tr(k.replace(/{d+}/g, '1'))));
for (const [k, v] of missing) console.log([...v.files].map((f) => path.basename(f)).join(',') + '	' + k);
console.log('Без перевода:', missing.length, 'из', out.size);
