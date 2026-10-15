// CS:WO als Desktop-App: lädt die Online-Version (Updates kommen automatisch, sobald die Website aktualisiert ist)
const { app, BrowserWindow, shell, Menu } = require('electron');

const GAME_URL = 'https://cs-web-offensive.onrender.com';

// Leistung: starke Grafikkarte erzwingen (Laptops), GPU-Sperrliste ignorieren, im Hintergrund nicht drosseln
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Nur ein Fenster gleichzeitig
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const waitPage = (msg) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#0a0e13;color:#e8c98a;font:bold 20px Arial">
<div>CS:WO</div><div style="margin-top:12px;font:14px Arial;color:#8fa3b8">${msg}</div></body></html>`);

function loadGame() {
  win.loadURL(GAME_URL).catch(() => { });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 960, minHeight: 540,
    backgroundColor: '#0a0e13', title: 'CS:WO', show: false, autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // Server schläft (Render Free) oder kein Internet → Hinweis zeigen und alle 5 s neu versuchen
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3 = abgebrochen (normal bei Neuladen)
    win.loadURL(waitPage('Server wird gestartet oder keine Internetverbindung … neuer Versuch in 5 s')).catch(() => { });
    setTimeout(loadGame, 5000);
  });
  // Links nach außen (z. B. GitHub) im normalen Browser öffnen
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // F11 = Vollbild, Strg+R / F5 = neu laden
  win.webContents.on('before-input-event', (e, inp) => {
    if (inp.type !== 'keyDown') return;
    if (inp.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (inp.key === 'F5' || (inp.control && inp.key.toLowerCase() === 'r')) { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
  });
  win.loadURL(waitPage('Verbinde mit dem Server …')).then(loadGame).catch(loadGame);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
