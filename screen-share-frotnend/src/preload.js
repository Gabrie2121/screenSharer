const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Controles de janela
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  // Captura de tela
  getSources: () => ipcRenderer.invoke('get-sources'),

  // Log básico do app (grava em disco via processo principal)
  log: (level, message) => ipcRenderer.send('renderer-log', level, message),
})