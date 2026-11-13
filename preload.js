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
  'servers:list', 'ui:getPrefs', 'ui:setPrefs', 'server:delete', 'server:upgrade', 'world:saves', 'world:pick', 'world:import', 'world:setup', 'net:check', 'net:upnp', 'discord:test', 'map:get', 'map:accept', 'map:open', 'rules:set', 'players:stats', 'backup:pickMirror', 'backup:cloudGuess', 'server:importPick', 'server:importCopy', 'server:paperBuild', 'server:paperRefresh', 'tunnel:get', 'tunnel:setup', 'tunnel:stop', 'tunnel:set', 'mods:check', 'mods:checkRemove', 'logs:list', 'logs:read', 'logs:clean', 'disk:usage', 'world:new', 'chunky:start', 'chunky:cancel', 'chunky:get', 'pack:resource', 'pack:resourceGet', 'icon:get', 'icon:pick', 'icon:remove', 'mrpack:search', 'mrpack:fromModrinth', 'transfer:export', 'transfer:import', 'remote:get', 'remote:set', 'remote:newCode', 'bg:start', 'bg:stop', 'bg:command', 'bg:list', 'bg:lines', 'net2:get', 'net2:setup', 'net2:start', 'net2:stop', 'net2:remove', 'power:get', 'dp:search', 'dp:list', 'dp:install', 'dp:add', 'dp:remove', 'dp:open', 'world:template', 'fun:event', 'fun:stop', 'fun:get', 'fun:setAchievements', 'bk:verify', 'bk:state', 'invite:data', 'invite:copy', 'invite:save', 'map:regions', 'map:tile', 'widget:open', 'widget:close', 'widget:main', 'widget:info', 'widget:start', 'player:card', 'player:do', 'border:apply', 'border:remove', 'regions:compare', 'regions:restore', 'lag:check', 'lag:get', 'lag:fix', 'mcnew:check', 'chat:get', 'chat:send', 'history:get', 'sp:export', 'sp:openSaves', 'tg:get', 'tg:connect', 'tg:set', 'tg:test', 'tg:disconnect', 'tg:openBot',
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
const EVENTS = ['log', 'state', 'progress', 'update', 'issue', 'issues:clear', 'vps:progress', 'vps:log', 'java:progress', 'stats', 'players', 'backups', 'net', 'tunnel', 'chunky', 'bg:state', 'bg:log', 'chat', 'tg', 'game', 'lag', 'fun'];

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
