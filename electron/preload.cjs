// Electron preload — runs in renderer context with Node access
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  scanNDI: () => ipcRenderer.invoke('ndi:scan'),
  getServerInfo: () => ipcRenderer.invoke('sync:getServerInfo'),
  toggleInteractive: () => ipcRenderer.invoke('sync:toggleInteractive'),
  toggleReadonly: () => ipcRenderer.invoke('sync:toggleReadonly'),
  setSleepBlock: (block) => ipcRenderer.invoke('timer:setSleepBlock', block),
  openImageDialog: () => ipcRenderer.invoke('images:openDialog'),
  saveImage: (srcPath) => ipcRenderer.invoke('images:save', srcPath),
  listImages: () => ipcRenderer.invoke('images:list'),
  deleteImage: (name) => ipcRenderer.invoke('images:delete', name),
  getImagesBaseUrl: () => ipcRenderer.invoke('images:baseUrl'),
  httpGet: (url) => ipcRenderer.invoke('net:httpGet', url),
});
