// CS:WO als Desktop-App
// Online: lädt die Website (Spiel-Updates kommen automatisch) und speichert die neueste Version für den Offline-Modus.
// Offline: startet die gespeicherte bzw. mitgelieferte Version (Bots ohne Internet).
// Dazu: App-Updates über GitHub Releases, FPS-Limit abschaltbar, Entwickler-Konsole gesperrt.
const { app, BrowserWindow, shell, Menu, protocol, net, session, ipcMain } = require('electron');
const path = require('path'), fs = require('fs');
if (process.env.CSWO_TEST) app.setPath('userData', path.join(app.getPath('temp'), 'cswo-test')); // automatische Tests: eigener Datenordner

const GAME_URL = process.env.CSWO_URL || 'https://cs-web-offensive.onrender.com'; // CSWO_URL nur zum Testen
const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const OFFLINE_CODES = new Set([-105, -106, -109, -118, -130, -137, -21]); // kein DNS / kein Internet / Netz geändert / Verbindung unmöglich

// Einstellungen der App (userData/app-settings.json)
const SET_FILE = path.join(app.getPath('userData'), 'app-settings.json');
let SET = { fpsUnlock: false }; try { SET = Object.assign(SET, JSON.parse(fs.readFileSync(SET_FILE, 'utf8'))); } catch (e) { }
const saveSet = () => { try { fs.writeFileSync(SET_FILE, JSON.stringify(SET)); } catch (e) { } };

// Leistung: starke Grafikkarte, GPU-Sperrliste ignorieren, im Hintergrund nicht drosseln; optional ohne FPS-Limit
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (SET.fpsUnlock) { app.commandLine.appendSwitch('disable-frame-rate-limit'); app.commandLine.appendSwitch('disable-gpu-vsync'); }

// app://game/… = lokale Spieldateien (Offline-Modus)
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const BUNDLED = app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..', 'public');
const VENDOR = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, 'vendor');
const CACHE = path.join(app.getPath('userData'), 'game-cache'); // neueste Online-Version (nur index.html ändert sich bei Updates)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

if (!app.requestSingleInstanceLock()) app.quit();
let win = null, offline = false;

const waitPage = msg => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#0a0e13;color:#e8c98a;font:bold 20px Arial">
<div>CS:WO</div><div style="margin-top:12px;font:14px Arial;color:#8fa3b8">${msg}</div></body></html>`);

// Neueste index.html vom Server für den Offline-Modus sichern
async function cacheLatest() {
  try {
    const r = await net.fetch(GAME_URL + '/index.html', { cache: 'no-store' }); if (!r.ok) return;
    const html = await r.text(); if (html.length < 10000 || !html.includes('<script')) return;
    fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, 'index.html'), html);
  } catch (e) { }
}

function loadOnline() { offline = false; win.loadURL(GAME_URL).catch(() => { }); }
function loadOffline() { offline = true; win.loadURL('app://game/index.html').catch(() => { }); }

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 960, minHeight: 540,
    backgroundColor: '#0a0e13', title: 'CS:WO', show: false, autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, devTools: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || offline) return; // -3 = abgebrochen (normal beim Neuladen)
    if (OFFLINE_CODES.has(code)) return loadOffline(); // kein Internet → Offline-Modus
    win.loadURL(waitPage('Server wird gestartet … neuer Versuch in 5 s')).catch(() => { }); // Server schläft (Render) → später nochmal
    setTimeout(loadOnline, 5000);
  });
  win.webContents.on('did-finish-load', () => { if (!offline && win.webContents.getURL().startsWith(GAME_URL)) cacheLatest(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // F11 = Vollbild, F5 / Strg+R = neu laden (versucht dabei wieder online zu gehen); Konsolen-Tastenkürzel blockiert
  win.webContents.on('before-input-event', (e, inp) => {
    if (inp.type !== 'keyDown') return; const k = inp.key.toLowerCase();
    if (inp.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (inp.key === 'F5' || (inp.control && k === 'r')) { e.preventDefault(); loadOnline(); }
    else if (inp.key === 'F12' || (inp.control && inp.shift && 'ijc'.includes(k))) e.preventDefault();
  });
  win.loadURL(waitPage('Verbinde mit dem Server …')).then(loadOnline).catch(loadOnline);
}

// Brücke zum Spiel (preload.js): FPS-Limit-Schalter
ipcMain.on('cswo:getSet', e => { e.returnValue = { fpsUnlock: !!SET.fpsUnlock, offline }; });
ipcMain.on('cswo:setFps', (e, v) => { SET.fpsUnlock = !!v; saveSet(); app.relaunch(); app.exit(0); });

// App-Updates: prüft beim Start GitHub Releases, lädt im Hintergrund und installiert beim Beenden
function checkAppUpdate() {
  if (!app.isPackaged) return;
  try { const { autoUpdater } = require('electron-updater'); autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.checkForUpdates().catch(() => { }); } catch (e) { }
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  // Lokale Dateien ausliefern: index.html bevorzugt aus dem Cache (neueste Online-Version), sonst aus der App
  protocol.handle('app', req => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.startsWith('api/')) return new Response('{"err":"offline"}', { status: 503, headers: { 'content-type': 'application/json' } });
    const bases = rel === 'three.min.js' ? [VENDOR] : [CACHE, BUNDLED];
    for (const b of bases) { const f = path.resolve(b, rel); if (!f.startsWith(path.resolve(b) + path.sep)) continue; /* nur Dateien innerhalb des Spielordners */ try { return new Response(fs.readFileSync(f), { headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } }); } catch (e) { } }
    return new Response('not found', { status: 404 });
  });
  // three.js: im Offline-Modus aus der App statt vom CDN
  session.defaultSession.webRequest.onBeforeRequest({ urls: [THREE_CDN] }, (d, cb) => cb(offline ? { redirectURL: 'app://game/three.min.js' } : {}));
  createWindow(); checkAppUpdate();
  if (process.env.CSWO_TEST) setTimeout(async () => { // nur für automatische Tests: Zustand in Datei schreiben und beenden
    const r = await win.webContents.executeJavaScript("JSON.stringify({ url: location.href, menu: !!document.getElementById('csmenu'), three: typeof THREE, app: window.cswoApp, toast: [...document.querySelectorAll('.toast')].map(t => t.innerText) })").catch(e => 'FEHLER ' + e.message);
    fs.writeFileSync(process.env.CSWO_TEST, r); app.exit(0);
  }, 9000);
});
app.on('window-all-closed', () => app.quit());
