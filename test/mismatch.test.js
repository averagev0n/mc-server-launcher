'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { analyze } = require('../lib/mismatch');

const mods = [
  { file: 'create-1.20.1-0.5.1.jar', name: 'Create', ids: ['create'] },
  { file: 'jei.jar', name: 'Just Enough Items', ids: ['jei'] },
  { file: 'waystones.jar', name: 'Waystones', ids: ['waystones'] },
  { file: 'fabric-api.jar', name: 'Fabric API', ids: ['fabric-api', 'fabric'] },
];

test('mismatch: Forge — список недостающих модов у клиента', () => {
  const r = analyze('Connection closed - mismatched mod channel list\nMod rejections [create, waystones]', mods);
  assert.deepStrictEqual(r.missing.map((m) => m.name).sort(), ['Create', 'Waystones']);
  assert.deepStrictEqual(r.extra, []);
});

test('mismatch: Fabric — записи реестра, которых нет у клиента', () => {
  const r = analyze('Received a registry sync packet with missing entries\nSome registry entries are missing on client: minecraft:item: [create:wrench, create:cogwheel]', mods);
  assert.deepStrictEqual(r.missing.map((m) => m.name), ['Create']);
});

test('mismatch: у друга лишний мод, которого нет на сервере', () => {
  const r = analyze('The server is missing the following mods: [xaerominimap, sodium]', mods);
  assert.deepStrictEqual(r.extra, ['sodium', 'xaerominimap']);
  assert.deepStrictEqual(r.missing, []);
});

test('mismatch: NeoForge — разные версии', () => {
  const r = analyze('Mod version mismatch: jei@15.2.0 (client) vs jei@15.3.0 (server)', mods);
  assert.deepStrictEqual(r.mismatch.map((m) => m.name), ['Just Enough Items']);
});

test('mismatch: непонятный текст — ничего не нашли', () => {
  assert.strictEqual(analyze('Connection timed out', mods).found, false);
});
