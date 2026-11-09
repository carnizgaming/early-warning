// The only bridge between the pages and the app: a handful of named calls, nothing else.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ew', {
  getData: () => ipcRenderer.invoke('ew:get-data'),
  refresh: () => ipcRenderer.invoke('ew:refresh'),
  onData: cb => ipcRenderer.on('ew:data', (e, d) => cb(d)),
  getSettings: () => ipcRenderer.invoke('ew:get-settings'),
  feedsFor: s => ipcRenderer.invoke('ew:feeds-for', s),
  locate: pc => ipcRenderer.invoke('ew:locate', pc),
  saveSettings: (s, autostart) => ipcRenderer.invoke('ew:save-settings', s, autostart),
  openSettings: () => ipcRenderer.invoke('ew:open-settings'),
  openLog: () => ipcRenderer.invoke('ew:open-log')
});
