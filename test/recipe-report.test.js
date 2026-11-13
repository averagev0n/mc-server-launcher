'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const recipe = require('../lib/recipe');
const report = require('../lib/report');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));

test('recipe: собирает ссылки Modrinth, неизвестные файлы — в «перенести вручную»', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'mods', 'known.jar'), 'known');
  fs.writeFileSync(path.join(dir, 'mods', 'own.jar'), 'own');
  const sha1 = crypto.createHash('sha1').update('known').digest('hex');
  const sha512 = crypto.createHash('sha512').update('known').digest('hex');
  const lookup = async (hashes) => {
    assert.strictEqual(hashes.length, 2);
    return { [sha1]: { files: [{ url: 'https://cdn.modrinth.com/data/x/known.jar', size: 5, hashes: { sha1, sha512 } }] } };
  };
  const { recipe: r, manual } = await recipe.build({ dir, type: 'fabric', mc: '1.21.1', loader: '0.16.5', name: 'Друзья', props: { gamemode: 'creative', 'server-port': '25566' }, gamerules: { keepInventory: true } }, lookup);
  assert.deepStrictEqual(manual, ['mods/own.jar']);
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.props.gamemode, 'creative');
  assert.strictEqual(r.props['server-port'], undefined, 'порт — настройка конкретного ПК');
  const back = recipe.parse(JSON.stringify(r));
  assert.strictEqual(back.files[0].path, 'mods/known.jar');
  assert.strictEqual(back.gamerules.keepInventory, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recipe: чужой рецепт не может положить файлы куда угодно или качать не с Modrinth', () => {
  const good = 'a'.repeat(128);
  const r = recipe.parse(JSON.stringify({
    format: recipe.FORMAT, v: 1, type: 'fabric', mc: '1.21.1', loader: '0.16.5',
    files: [
      { path: '../evil.jar', url: 'https://cdn.modrinth.com/a.jar', sha512: good },
      { path: 'mods/../../x.jar', url: 'https://cdn.modrinth.com/a.jar', sha512: good },
      { path: 'config/a.jar', url: 'https://cdn.modrinth.com/a.jar', sha512: good },
      { path: 'mods/a.exe', url: 'https://cdn.modrinth.com/a.jar', sha512: good },
      { path: 'mods/b.jar', url: 'https://evil.example/b.jar', sha512: good },
      { path: 'mods/c.jar', url: 'http://cdn.modrinth.com/c.jar', sha512: good },
      { path: 'mods/d.jar', url: 'https://cdn.modrinth.com/d.jar', sha512: 'zz' },
      { path: 'mods/ok.jar', url: 'https://cdn.modrinth.com/ok.jar', sha512: good },
    ],
    props: { 'server-ip': '1.2.3.4', gamemode: 'hardcore?', motd: 'hi' },
  }));
  assert.deepStrictEqual(r.files.map((f) => f.path), ['mods/ok.jar']);
  assert.strictEqual(r.props['server-ip'], undefined);
  assert.throws(() => recipe.parse('{"format":"x"}'), /не рецепт/);
  assert.throws(() => recipe.parse(JSON.stringify({ format: recipe.FORMAT, v: 1, type: 'evil', mc: '1.21' })), /тип/);
});

test('report: время игроков за неделю, сбои и текст', () => {
  const dir = tmp();
  const now = Date.UTC(2026, 10, 16, 12);
  const h = 3600000;
  report.logSession(dir, 'Steve', now - 2 * h, now - h);
  report.logSession(dir, 'Alex', now - 30 * h, now - 27 * h);
  report.logSession(dir, 'Old', now - 9 * 24 * h, now - 9 * 24 * h + h); // старше недели
  report.logCrash(dir, now - 5 * h);
  const r = report.collect(dir, now);
  assert.deepStrictEqual(r.players.map((p) => p.name), ['Alex', 'Steve']);
  assert.strictEqual(r.crashes, 1);
  const t = report.text('Друзья', r, 300 * 1024 ** 2, 250 * 1024 ** 2);
  assert.match(t, /Alex — 3 ч/);
  assert.match(t, /Сбоев: 1/);
  assert.match(t, /\+50 МБ/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('report: когда пора слать', () => {
  const mon = new Date(2026, 10, 16, 11); // понедельник
  assert.strictEqual(report.due(null, mon), true);
  assert.strictEqual(report.due(mon.getTime() - 3600000, mon), false);
  assert.strictEqual(report.due(null, new Date(2026, 10, 16, 9)), false);
  assert.strictEqual(report.due(null, new Date(2026, 10, 17, 11)), false);
});
