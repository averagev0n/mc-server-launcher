'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createTranslator } = require('../renderer/i18n');
const EN = require('../renderer/i18n-en');

const tr = createTranslator(EN);
const CYR = /[А-Яа-яЁё]/;

test('i18n: точные строки и шаблоны с подстановками', () => {
  assert.strictEqual(tr('Остановлен'), 'Stopped');
  assert.strictEqual(tr('Порт 25565 открыт на роутере.'), 'Port 25565 opened on the router.');
  // Подстановка сама переводится: «Порт {0}» внутри «{0} не виден…»
  assert.match(tr('Порт 25565 не виден из интернета: порт закрыт на роутере.'), /^Port 25565 isn't visible from the internet/);
  // Пробелы по краям узла сохраняются
  assert.strictEqual(tr('  Скопировать '), '  Copy ');
  // Чего нет в словаре — остаётся как было
  assert.strictEqual(tr('Привет от игрока'), 'Привет от игрока');
  assert.strictEqual(tr('Hello'), 'Hello');
});

test('i18n: несколько строк переводятся построчно', () => {
  assert.strictEqual(tr('Установить?\nОтмена'), 'Install?\nCancel');
});

test('i18n: все подписи в окне лаунчера переведены', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<div class="theme no-tr">[\s\S]*?<\/div>\s*<\/div>/, '');
  const left = [];
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const t = m[1].replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    if (CYR.test(t) && CYR.test(tr(t))) left.push(t);
  }
  for (const m of html.matchAll(/\s(?:placeholder|title|aria-label)="([^"]*)"/g)) {
    if (CYR.test(m[1]) && CYR.test(tr(m[1]))) left.push(m[1]);
  }
  assert.deepStrictEqual(left, []);
});

test('i18n: в переводах сохранены все подстановки', () => {
  for (const [k, v] of Object.entries(EN)) {
    const a = (k.match(/\{\d+\}/g) || []).sort().join();
    const b = (v.match(/\{\d+\}/g) || []).sort().join();
    assert.strictEqual(a, b, k);
  }
});
