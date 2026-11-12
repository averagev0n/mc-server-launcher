const { contextBridge, ipcRenderer } = require('electron');

const CALLS = [
  'versions:list',
  'loaders:list',
  'java:list',
  'app:info',
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
  'update:state',
  'update:check',
  'update:download',
  'update:install',
];
const EVENTS = ['log', 'state', 'progress', 'update'];

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
