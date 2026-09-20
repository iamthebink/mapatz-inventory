/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, listener) => {
  const handler = () => listener();
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('mapatzDesktop', {
  setup: (password) => ipcRenderer.invoke('desktop:setup', password),
  saveWorkbook: (bytes) => ipcRenderer.invoke('desktop:save', bytes),
  onCloseRequest: (listener) => subscribe('desktop:close-request', listener),
  approveClose: () => ipcRenderer.send('desktop:close-approved'),
  onResume: (listener) => subscribe('desktop:resume', listener),
});
