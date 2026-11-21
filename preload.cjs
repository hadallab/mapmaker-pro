'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mmpHost', {
  kind: 'electron',
  pathForFile: file => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  openDialog: () => ipcRenderer.invoke('file:open-dialog'),
  openPath: file => ipcRenderer.invoke('file:open-path', file),
  save: payload => ipcRenderer.invoke('file:save', payload),
  exportPng: payload => ipcRenderer.invoke('file:export-png', payload),
  reveal: file => ipcRenderer.invoke('file:reveal', file),
  recent: () => ipcRenderer.invoke('recent:list'),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  storeGet: name => ipcRenderer.invoke('store:get', name),
  storeSet: (name, value) => ipcRenderer.invoke('store:set', name, value),
  writeRecovery: text => ipcRenderer.invoke('recovery:write', text),
  readRecovery: () => ipcRenderer.invoke('recovery:read'),
  clearRecovery: () => ipcRenderer.invoke('recovery:clear'),
  pendingOpen: () => ipcRenderer.invoke('app:pending-open'),
  version: () => ipcRenderer.invoke('app:version'),
  confirmClose: () => ipcRenderer.invoke('app:close-confirmed'),
  updateCheck: url => ipcRenderer.invoke('update:check', url),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateEvent: fn => ipcRenderer.on('update:event', (_e, data) => fn(data)),
  mapmakerOpen: () => ipcRenderer.invoke('mapmaker:open'),
  mapmakerStatus: () => ipcRenderer.invoke('mapmaker:status'),
  mapmakerSend: text => ipcRenderer.invoke('mapmaker:send', text),
  mapmakerPull: () => ipcRenderer.invoke('mapmaker:pull'),
  onRequestClose: fn => ipcRenderer.on('app:request-close', () => fn()),
  onOpenPath: fn => ipcRenderer.on('app:open-path', (_e, file) => fn(file))
});
