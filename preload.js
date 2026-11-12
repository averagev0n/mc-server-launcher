const { contextBridge, ipcRenderer } = require('electron');

const CALLS = [
  'versions:list',
  'loaders:list',
  'java:list',
  'java:install',
  'app:info',
  'net:addresses',
  'ui:getTheme',
  'ui:setTheme',
  'servers:list', 'ui:getPrefs', 'ui:setPrefs', 'server:delete', 'server:upgrade', 'world:saves', 'world:pick', 'world:import', 'world:setup', 'net:check', 'net:upnp', 'discord:test', 'map:get', 'map:accept', 'map:open',
  'server:info',
  'server:start',
  'server:stop',
  'server:restart',
  'config:list',
  'config:read',
  'config:saveFields',
  'config:saveText',
  'config:restore',
  'config:open',
  'server:command',
  'props:save',
  'mods:search',
  'mods:list',
  'mods:install',
  'mods:remove',
  'mods:checkUpdates',
  'mods:update',
  'open:folder',
  'open:eula',
  'open:java',
  'open:mod',
  'maint:get',
  'maint:set',
  'backup:create',
  'backup:restore',
  'backup:delete',
  'backup:reveal',
  'players:get',
  'players:action',
  'mrpack:open',
  'mrpack:cancel',
  'mrpack:apply',
  'pack:analyze',
  'pack:export',
  'pack:reveal',
  'vps:list',
  'vps:save',
  'vps:remove',
  'vps:forgetKey',
  'vps:pickKey',
  'vps:info',
  'vps:transfer',
  'vps:start',
  'vps:stop',
  'vps:command',
  'vps:logOpen',
  'vps:logClose',
  'vps:checkPort',
  'issue:copyLog',
  'issue:open',
  'issue:logs',
  'update:state',
  'update:check',
  'update:download',
  'update:install',
];
const EVENTS = ['log', 'state', 'progress', 'update', 'issue', 'issues:clear', 'vps:progress', 'vps:log', 'java:progress', 'stats', 'players', 'backups', 'net'];

contextBridge.exposeInMainWorld('launcher', {
  // Возвращает данные или бросает ошибку с понятным текстом.
  async call(channel, arg) {
    if (!CALLS.includes(channel)) throw new Error('Неизвестная команда');
    const res = await ipcRenderer.invoke(channel, arg);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  on(channel, fn) {
    if (!EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (_event, payload) => fn(payload));
  },
});
