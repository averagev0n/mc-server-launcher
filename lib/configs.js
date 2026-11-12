// Конфиги плагинов и модов: список файлов, разбор в поля формы и точечная запись.
// Меняется только текст изменённых значений — комментарии и оформление файла остаются как были.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const TOML = require('smol-toml');
const JSONC = require('jsonc-parser');

const FORMATS = {
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.json': 'json',
  '.jsonc': 'json',
  '.toml': 'toml',
  '.properties': 'properties',
  '.json5': 'text',
  '.cfg': 'text',
  '.conf': 'text',
  '.ini': 'text',
  '.txt': 'text',
};
const MAX_SIZE = 1024 * 1024;
const MAX_FILES = 1500;
const MAX_FIELDS = 5000;
// Папки с данными, а не настройками (например, тысячи файлов игроков у Essentials).
const SKIP_DIRS = new Set(['userdata', 'playerdata', 'players', 'data', 'logs', 'cache', 'backups',
  'backup', 'libs', 'lib', 'libraries', 'crash-reports', '.paper-remapped', 'translations', 'lang', 'locale']);
const PAPER_FILES = ['bukkit.yml', 'spigot.yml', 'commands.yml', 'permissions.yml', 'help.yml',
  'config/paper-global.yml', 'config/paper-world-defaults.yml'];

const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex');
const formatOf = (file) => FORMATS[path.extname(file).toLowerCase()] || null;

// ---- список файлов ----

function walk(dir, rel, depth, out) {
  if (depth > 4 || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(dir, r, depth + 1, out);
    } else if (e.isFile() && formatOf(e.name)) {
      out.push(r);
    }
  }
}

function fileInfo(dir, rel) {
  try {
    const st = fs.statSync(path.join(dir, rel));
    if (!st.isFile() || st.size > MAX_SIZE) return null;
    return { rel, name: path.basename(rel), size: st.size, format: formatOf(rel) };
  } catch {
    return null;
  }
}

function levelName(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').match(/^level-name=(.*)$/m);
    const name = m ? m[1].trim() : 'world';
    return /^[^\\/:*?"<>|]+$/.test(name) && name !== '..' ? name : 'world';
  } catch {
    return 'world';
  }
}

/** Группы файлов настроек: [{ name, files: [{ rel, name, size, format }] }]. */
function listConfigs(type, dir) {
  const groups = new Map();
  const add = (group, rel) => {
    const info = fileInfo(dir, rel);
    if (!info) return;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(info);
  };

  const hybrid = ['arclight', 'mohist', 'youer'].includes(type);
  add('Сервер', 'server.properties');
  if (type === 'paper' || hybrid) {
    for (const f of PAPER_FILES) add('Сервер', f);
    if (hybrid) {
      add('Сервер', 'arclight.conf');
      const own = [];
      walk(dir, 'mohist-config', 0, own);
      walk(dir, 'youer-config', 0, own);
      for (const rel of own) add('Сервер', rel);
    }
    const files = [];
    walk(dir, 'plugins', 0, files);
    for (const rel of files) {
      const parts = rel.split('/');
      add(parts.length > 2 ? (hybrid ? `Плагин: ${parts[1]}` : parts[1]) : 'Прочее', rel);
    }
  }
  if (['fabric', 'forge', 'neoforge'].includes(type) || hybrid) {
    const files = [];
    walk(dir, 'config', 0, files);
    const level = levelName(dir);
    walk(dir, `${level}/serverconfig`, 0, files);
    for (const rel of files) {
      const parts = rel.split('/');
      const inSub = rel.startsWith('config/') ? parts.length > 2 : parts.length > 3;
      const group = inSub
        ? parts[parts.length - 2]
        : path.basename(rel).replace(/\.[^.]+$/, '').split(/-(?:common|server|client)$|-/)[0];
      add(group, rel);
    }
  }

  const list = [...groups.entries()].map(([name, files]) => ({
    name,
    files: files.sort((a, b) => a.rel.localeCompare(b.rel)),
  }));
  const server = list.filter((g) => g.name === 'Сервер');
  const rest = list
    .filter((g) => g.name !== 'Сервер')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return server.concat(rest);
}

/** Абсолютный путь с проверкой, что файл внутри папки сервера и это поддерживаемый формат. */
function resolveFile(dir, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) throw new Error('Некорректный файл');
  const abs = path.resolve(dir, rel);
  const root = path.resolve(dir) + path.sep;
  if (!abs.startsWith(root) || !formatOf(abs)) throw new Error('Некорректный файл');
  return abs;
}

// ---- общие помощники для полей ----

function cleanComment(text) {
  if (!text) return '';
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[#!]+ ?/, '').replace(/^\s/, '').trimEnd())
    .map((l) => l.replace(/\s*#+$/, '').replace(/^\|\s?(.*?)\s*\|$/, '$1').trim()) // рамки вида | текст |
    .filter((l) => !/^[-=#*~_+| ]{4,}$/.test(l)) // строки-разделители вида ##########
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n')
    .trim();
}

/** Метаданные из комментариев Forge/NeoForge: «Range: 1 ~ 10», «Allowed Values: A, B». */
function commentMeta(comment) {
  const meta = {};
  const range = comment.match(/Range:\s*(-?[\d.]+(?:E\d+)?)\s*~\s*(-?[\d.]+(?:E\d+)?)/i);
  if (range) {
    meta.min = Number(range[1]);
    meta.max = Number(range[2]);
  }
  const allowed = comment.match(/Allowed Values:\s*(.+)/i);
  if (allowed) meta.options = allowed[1].split(',').map((s) => s.trim()).filter(Boolean);
  return meta;
}

function scalarType(value, isFloat) {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) && !isFloat ? 'int' : 'float';
  return 'string';
}

function makeField(fields, base, value, comment, extra = {}) {
  if (fields.length >= MAX_FIELDS) return null;
  const f = { id: fields.length, ...base, comment, ...extra };
  if (Array.isArray(value)) {
    f.type = 'list';
    f.value = value.map(String);
    f.itemKind = value.length && value.every((x) => typeof x === 'number') ? 'number' : 'string';
  } else {
    f.type = extra.type || scalarType(value, extra.isFloat);
    f.value = value === null || value === undefined ? '' : value;
    const meta = commentMeta(comment);
    if (f.type === 'string' && meta.options && meta.options.includes(String(f.value))) {
      f.type = 'enum';
      f.options = meta.options;
    }
    if ((f.type === 'int' || f.type === 'float') && meta.min !== undefined) {
      f.min = meta.min;
      f.max = meta.max;
    }
    if (f.type === 'string' && String(f.value).includes('\n')) f.multiline = true;
  }
  delete f.isFloat;
  fields.push(f);
  return f;
}

/** Проверяет и приводит новое значение к типу поля. */
function coerce(field, value) {
  const name = `«${field.key}»`;
  switch (field.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw new Error(`${name}: нужно да или нет`);
      return value;
    case 'int':
    case 'float': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error(`${name}: нужно число`);
      if (field.type === 'int' && !Number.isInteger(n)) throw new Error(`${name}: нужно целое число`);
      if (field.min !== undefined && (n < field.min || n > field.max)) {
        throw new Error(`${name}: допустимо от ${field.min} до ${field.max}`);
      }
      return n;
    }
    case 'enum':
      if (!field.options.includes(value)) throw new Error(`${name}: недопустимое значение`);
      return value;
    case 'list': {
      if (!Array.isArray(value)) throw new Error(`${name}: нужен список`);
      const items = value.map((x) => String(x).trim()).filter((x) => x !== '');
      if (field.itemKind === 'number') {
        return items.map((x) => {
          const n = Number(x.replace(',', '.'));
          if (!Number.isFinite(n)) throw new Error(`${name}: «${x}» — не число`);
          return n;
        });
      }
      return items;
    }
    default:
      if (typeof value !== 'string' || value.length > 100000) throw new Error(`${name}: некорректный текст`);
      return value;
  }
}

/** Заменяет участки текста [start, end) — с конца, чтобы смещения не поехали. */
function splice(text, edits) {
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

// ---- YAML ----

function yamlScalar(value, type) {
  const doc = new YAML.Document();
  const s = new YAML.Scalar(value);
  if (typeof value === 'string' && value.includes('\n')) s.type = 'QUOTE_DOUBLE';
  else if (type && type !== 'BLOCK_LITERAL' && type !== 'BLOCK_FOLDED') s.type = type;
  doc.contents = s;
  return doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
}

function yamlParse(text) {
  const doc = YAML.parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) {
    const e = doc.errors[0];
    const line = e.linePos && e.linePos[0] ? e.linePos[0].line : null;
    throw new Error(`Ошибка в YAML${line ? ' в строке ' + line : ''}: ${e.message.split('\n')[0]}`);
  }
  return doc;
}

function yamlModel(text) {
  const doc = yamlParse(text);
  const fields = [];
  const nodes = [];
  const walkMap = (map, keys) => {
    map.items.forEach((pair, i) => {
      if (!pair.key || !YAML.isScalar(pair.key)) return;
      const key = String(pair.key.value);
      let comment = cleanComment(
        [i === 0 ? map.commentBefore : null, pair.key.commentBefore].filter(Boolean).join('\n')
      );
      // У первого ключа файла сверху обычно шапка всего файла — оставляем только последний абзац.
      if (i === 0 && !keys.length) comment = comment.split(/\n\s*\n/).pop().trim();
      const v = pair.value;
      const base = { key, section: keys.join(' › ') };
      if (v === null || (YAML.isScalar(v) && v.range)) {
        if (v && (v.type === 'BLOCK_LITERAL' || v.type === 'BLOCK_FOLDED')) return; // многострочный блок — только в тексте
        // Пустое значение (часто это список, у которого все элементы закомментированы) или дата —
        // тип неясен, такие правятся только в тексте.
        if (!v || v.value === null || typeof v.value === 'object') return;
        const f = makeField(fields, base, v.value, comment + (v.comment ? '\n' + cleanComment(v.comment) : ''), {
          isFloat: typeof v.value === 'number' && v.minFractionDigits > 0,
        });
        if (f) nodes[f.id] = v;
      } else if (YAML.isSeq(v) && v.items.every((x) => YAML.isScalar(x) && typeof x.value !== 'object')) {
        const f = makeField(fields, base, v.items.map((x) => x.value), comment);
        if (f) nodes[f.id] = v;
      } else if (YAML.isMap(v)) {
        walkMap(v, keys.concat(key));
      }
    });
  };
  if (YAML.isMap(doc.contents)) walkMap(doc.contents, []);
  return { fields, nodes };
}

function yamlEdits(text, nodes, field, value) {
  const node = nodes[field.id];
  if (YAML.isScalar(node)) {
    return { start: node.range[0], end: node.range[1], text: yamlScalar(value, node.type) };
  }
  // список
  let end = node.range[1];
  while (end > node.range[0] && /\s/.test(text[end - 1])) end--;
  const items = value.map((x) => yamlScalar(x, 'PLAIN'));
  if (node.flow || !node.items.length || !items.length) {
    return { start: node.range[0], end, text: `[${items.join(', ')}]` };
  }
  const lineStart = text.lastIndexOf('\n', node.range[0] - 1) + 1;
  const indent = ' '.repeat(node.range[0] - lineStart);
  return { start: node.range[0], end, text: items.map((x) => `- ${x}`).join(eolOf(text) + indent) };
}

// ---- JSON ----

function jsonParse(text) {
  const errors = [];
  const tree = JSONC.parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !tree) {
    const off = errors.length ? errors[0].offset : 0;
    throw new Error(`Ошибка в JSON в строке ${lineOf(text, off)}: ${JSONC.printParseErrorCode(errors[0] ? errors[0].error : 0)}`);
  }
  return tree;
}

function jsonModel(text) {
  const tree = jsonParse(text);
  const fields = [];
  const nodes = [];
  const walkObj = (obj, keys) => {
    for (const prop of obj.children || []) {
      const [k, v] = prop.children || [];
      if (!k || !v) continue;
      const key = String(k.value);
      const base = { key, section: keys.join(' › ') };
      if (['string', 'number', 'boolean'].includes(v.type)) {
        const raw = text.slice(v.offset, v.offset + v.length);
        const f = makeField(fields, base, v.value, '', { isFloat: v.type === 'number' && /[.eE]/.test(raw) });
        if (f) nodes[f.id] = v;
      } else if (v.type === 'array' && (v.children || []).every((c) => ['string', 'number', 'boolean'].includes(c.type))) {
        const f = makeField(fields, base, v.children.map((c) => c.value), '');
        if (f) nodes[f.id] = v;
      } else if (v.type === 'object') {
        walkObj(v, keys.concat(key));
      }
    }
  };
  if (tree.type === 'object') walkObj(tree, []);
  return { fields, nodes };
}

function jsonNumber(n, isFloat) {
  const s = JSON.stringify(n);
  return isFloat && !/[.eE]/.test(s) ? s + '.0' : s;
}

function jsonEdits(text, nodes, field, value) {
  const node = nodes[field.id];
  const start = node.offset;
  const end = node.offset + node.length;
  const one = (x) => (typeof x === 'number' ? jsonNumber(x, field.type === 'float') : JSON.stringify(x));
  if (node.type !== 'array') return { start, end, text: one(value) };
  const original = text.slice(start, end);
  const items = value.map((x) => JSON.stringify(x));
  if (!original.includes('\n') || !items.length || !node.children.length) {
    return { start, end, text: `[${items.join(', ')}]` };
  }
  const first = node.children[0].offset;
  const ind = text.slice(text.lastIndexOf('\n', first - 1) + 1, first);
  const closeLine = text.lastIndexOf('\n', end - 1) + 1;
  const closeInd = text.slice(closeLine, end - 1);
  const nl = eolOf(text);
  return { start, end, text: `[${nl}${ind}${items.join(',' + nl + ind)}${nl}${/^\s*$/.test(closeInd) ? closeInd : ''}]` };
}

// ---- TOML ----

/** Позиция начала комментария в строке (вне кавычек); -1 — комментария нет. */
function tomlCommentAt(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return i;
  }
  return -1;
}

const TOML_KEY = /^(\s*)((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)(\s*=\s*)(.*)$/;

function tomlKeyParts(k) {
  return (k.match(/[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'/g) || []).map((p) =>
    p.startsWith('"') ? JSON.parse(p) : p.startsWith("'") ? p.slice(1, -1) : p
  );
}

function tomlValue(s) {
  try {
    return { ok: true, value: TOML.parse(`x = ${s}`).x };
  } catch {
    return { ok: false };
  }
}

function tomlParse(text) {
  try {
    return TOML.parse(text);
  } catch (e) {
    throw new Error(`Ошибка в TOML${e.line ? ' в строке ' + e.line : ''}: ${String(e.message).split('\n')[0]}`);
  }
}

function tomlModel(text) {
  tomlParse(text);
  const lines = text.split('\n');
  const offsets = [];
  let off = 0;
  for (const l of lines) {
    offsets.push(off);
    off += l.length + 1;
  }
  const fields = [];
  const nodes = [];
  let section = [];
  let comment = [];
  const arrayCount = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const t = line.trim();
    if (!t) {
      comment = [];
      continue;
    }
    if (t.startsWith('#')) {
      comment.push(t);
      continue;
    }
    const arr = t.match(/^\[\[\s*(.+?)\s*\]\]/);
    const tbl = !arr && t.match(/^\[\s*(.+?)\s*\]/);
    if (arr || tbl) {
      const parts = tomlKeyParts((arr || tbl)[1]);
      if (arr) {
        const name = parts.join('.');
        const n = (arrayCount.get(name) || 0) + 1;
        arrayCount.set(name, n);
        parts[parts.length - 1] += ` #${n}`;
      }
      section = parts;
      comment = [];
      continue;
    }
    const m = line.match(TOML_KEY);
    if (!m) {
      comment = [];
      continue;
    }
    const rest = m[4];
    const c = tomlCommentAt(rest);
    const valueText = (c >= 0 ? rest.slice(0, c) : rest).trimEnd();
    const parsed = tomlValue(valueText);
    if (!parsed.ok) {
      // многострочное значение: пропускаем строки до его конца
      let acc = rest;
      for (let j = i + 1; j < lines.length && j < i + 2000; j++) {
        acc += '\n' + lines[j].replace(/\r$/, '');
        if (tomlValue(acc).ok) {
          i = j;
          break;
        }
      }
      comment = [];
      continue;
    }
    const v = parsed.value;
    const keyParts = tomlKeyParts(m[2]);
    const base = { key: keyParts[keyParts.length - 1], section: section.concat(keyParts.slice(0, -1)).join(' › ') };
    const cmt = cleanComment(comment.join('\n') + (c >= 0 ? '\n' + rest.slice(c) : ''));
    comment = [];
    let f = null;
    if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
      f = makeField(fields, base, v, cmt, { isFloat: typeof v === 'number' && /[.eE]|inf|nan/i.test(valueText) && !/^0x/i.test(valueText) });
    } else if (typeof v === 'bigint') {
      continue;
    } else if (Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) {
      f = makeField(fields, base, v, cmt);
    }
    if (f) {
      const start = offsets[i] + m[1].length + m[2].length + m[3].length;
      nodes[f.id] = { start, end: start + valueText.length };
    }
  }
  return { fields, nodes };
}

// JSON-строка годится как строка TOML; разделители строк U+2028/2029 экранируем отдельно.
const LINE_SEPS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
function tomlString(s) {
  return JSON.stringify(s).replace(LINE_SEPS, (c) => '\\u' + c.charCodeAt(0).toString(16));
}
function tomlNumber(n, isFloat) {
  const s = String(n);
  return isFloat && !/[.eE]/.test(s) ? s + '.0' : s;
}

function tomlEdits(text, nodes, field, value) {
  const node = nodes[field.id];
  let out;
  if (field.type === 'list') {
    out = `[${value.map((x) => (typeof x === 'number' ? tomlNumber(x, false) : tomlString(x))).join(', ')}]`;
  } else if (typeof value === 'boolean') out = String(value);
  else if (typeof value === 'number') out = tomlNumber(value, field.type === 'float');
  else out = tomlString(value);
  return { start: node.start, end: node.end, text: out };
}

// ---- .properties ----

function propsModel(text) {
  const lines = text.split('\n');
  const fields = [];
  const nodes = [];
  let comment = [];
  let off = 0;
  for (const raw of lines) {
    const lineStart = off;
    off += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (!t) {
      comment = [];
      continue;
    }
    if (t.startsWith('#') || t.startsWith('!')) {
      comment.push(t);
      continue;
    }
    const m = line.match(/^(\s*)((?:\\.|[^=:\s\\])+)(\s*[=:]\s*|\s+)(.*)$/);
    if (!m || line.endsWith('\\')) {
      comment = [];
      continue;
    }
    const rawValue = m[4];
    let value = rawValue;
    let type = 'string';
    if (/^(true|false)$/.test(rawValue)) {
      value = rawValue === 'true';
      type = 'bool';
    } else if (/^-?\d{1,15}$/.test(rawValue)) {
      value = Number(rawValue);
      type = 'int';
    }
    const f = makeField(fields, { key: m[2], section: '' }, value, cleanComment(comment.join('\n')), { type });
    comment = [];
    if (f) {
      const start = lineStart + m[1].length + m[2].length + m[3].length;
      nodes[f.id] = { start, end: start + rawValue.length };
    }
  }
  return { fields, nodes };
}

function propsEdits(text, nodes, field, value) {
  const node = nodes[field.id];
  return { start: node.start, end: node.end, text: String(value).replace(/\r?\n/g, ' ') };
}

// ---- чтение и запись ----

const MODELS = { yaml: yamlModel, json: jsonModel, toml: tomlModel, properties: propsModel };
const EDITS = { yaml: yamlEdits, json: jsonEdits, toml: tomlEdits, properties: propsEdits };

function validate(format, text) {
  if (format === 'yaml') yamlParse(text);
  else if (format === 'json') jsonParse(text);
  else if (format === 'toml') tomlParse(text);
}

function readRaw(abs) {
  const st = fs.statSync(abs);
  if (st.size > MAX_SIZE) throw new Error('Файл слишком большой для редактора');
  const buf = fs.readFileSync(abs);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { text: buf.toString('utf8', bom ? 3 : 0), bom };
}

/** { rel, format, text, version, fields, formError, hasBackup }. */
function readConfig(dir, rel) {
  const abs = resolveFile(dir, rel);
  const { text } = readRaw(abs);
  const format = formatOf(abs);
  let fields = null;
  let formError = null;
  if (MODELS[format]) {
    try {
      fields = MODELS[format](text).fields;
      if (!fields.length) formError = 'В этом файле нет простых настроек для формы — откройте режим «Текст».';
    } catch (e) {
      formError = e.message;
    }
  } else {
    formError = 'Этот формат можно править только как текст.';
  }
  return { rel, format, text, version: hashOf(text), fields, formError, hasBackup: fs.existsSync(abs + '.bak') };
}

function writeChecked(abs, bom, current, next, version) {
  if (hashOf(current) !== version) {
    throw new Error('Файл изменился на диске (его мог перезаписать сервер или плагин). Откройте его заново.');
  }
  if (next === current) return;
  fs.copyFileSync(abs, abs + '.bak');
  const tmp = abs + '.launcher-tmp';
  fs.writeFileSync(tmp, (bom ? '﻿' : '') + next, 'utf8');
  fs.renameSync(tmp, abs);
}

function saveText(dir, rel, text, version) {
  if (typeof text !== 'string' || text.length > MAX_SIZE) throw new Error('Некорректный текст');
  const abs = resolveFile(dir, rel);
  const { text: current, bom } = readRaw(abs);
  validate(formatOf(abs), text);
  writeChecked(abs, bom, current, text, version);
  return readConfig(dir, rel);
}

function saveFields(dir, rel, changes, version) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('Нет изменений');
  const abs = resolveFile(dir, rel);
  const format = formatOf(abs);
  if (!MODELS[format]) throw new Error('Этот файл правится только как текст');
  const { text: current, bom } = readRaw(abs);
  if (hashOf(current) !== version) {
    throw new Error('Файл изменился на диске (его мог перезаписать сервер или плагин). Откройте его заново.');
  }
  const { fields, nodes } = MODELS[format](current);
  const seen = new Set();
  const edits = changes.map(({ id, value }) => {
    const field = fields[id];
    if (!field || seen.has(id)) throw new Error('Настройки устарели — откройте файл заново');
    seen.add(id);
    return EDITS[format](current, nodes, field, coerce(field, value));
  });
  const next = splice(current, edits);
  validate(format, next);
  writeChecked(abs, bom, current, next, version);
  return readConfig(dir, rel);
}

function restoreBackup(dir, rel) {
  const abs = resolveFile(dir, rel);
  if (!fs.existsSync(abs + '.bak')) throw new Error('Резервной копии нет');
  const current = fs.readFileSync(abs);
  fs.copyFileSync(abs + '.bak', abs);
  fs.writeFileSync(abs + '.bak', current); // можно вернуть обратно ещё одним нажатием
  return readConfig(dir, rel);
}

module.exports = { listConfigs, readConfig, saveText, saveFields, restoreBackup, resolveFile };
