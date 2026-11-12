const { contextBridge, ipcRenderer } = require('electron');

const CALLS = [
  'versions:list',
  'loaders:list',
  'java:list',
  'app:info',
  'net:addresses',
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
  'open:folder',
  'open:eula',
  'open:java',
  'open:mod',
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
const EVENTS = ['log', 'state', 'progress', 'update', 'issue', 'issues:clear', 'vps:progress', 'vps:log'];

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
