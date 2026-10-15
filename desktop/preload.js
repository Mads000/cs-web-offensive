// Kleine Brücke zwischen App und Spiel: nur das Nötigste (FPS-Limit-Schalter, Offline-Info)
const { contextBridge, ipcRenderer } = require('electron');
const s = ipcRenderer.sendSync('cswo:getSet');
contextBridge.exposeInMainWorld('cswoApp', {
  desktop: true,
  offline: !!s.offline,
  fpsUnlock: !!s.fpsUnlock,
  setFpsUnlock: v => ipcRenderer.send('cswo:setFps', !!v), // speichert und startet die App neu
  presence: a => ipcRenderer.send('cswo:presence', a) // Discord-Status
});
