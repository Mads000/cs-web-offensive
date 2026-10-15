const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8081;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/manifest+json', '.svg': 'image/svg+xml' };

// ── Accounts ohne Datenbank (Passwörter nur als scrypt-Hash) ──
// Mit GIST_ID + GIST_TOKEN (Umgebungsvariablen, z.B. bei Render) → dauerhaft in einem privaten GitHub-Gist,
// sonst lokal in data/users.json. Render löscht die Festplatte bei jedem Deploy/Neustart, daher der Gist.
const crypto = require('crypto');
const PUBLISH_CODE = 'baumeister42'; // Code zum Veröffentlichen von Community-Karten – hier ändern
const DATA_DIR = path.join(__dirname, 'data'), USERS_FILE = path.join(DATA_DIR, 'users.json'), PUB_FILE = path.join(DATA_DIR, 'maps.json'), LB_FILE = path.join(DATA_DIR, 'leaderboard.json'), SKIN_FILE = path.join(DATA_DIR, 'skins.json');
const SYNC_KEYS = ['agent', 'bonus20', 'btnlayout', 'cases', 'cs_binds', 'cs_opts', 'custommaps', 'equip', 'gamecfg', 'inv', 'map', 'pname', 'stick', 'customarenas', 'arenaoff', 'prog', 'duckhat', 'knifetype'];
const GIST_ID = process.env.GIST_ID, GIST_TOKEN = process.env.GIST_TOKEN, GIST_FILE = 'users.json';
const GH = { Authorization: 'Bearer ' + GIST_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'cs-web-offensive' };
let CSK = {}; // Community-Skins: id → { id, w, n, c, c2, c3, p, r, by, sold, t }
let USERS = {}, PUB = {}, LB = { all: [], day: '', today: [] }, loaded = false, saveT = null, writing = false, again = false;
async function loadUsers() {
 if (!GIST_ID || !GIST_TOKEN) { try { USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { } try { PUB = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8')); } catch { } try { LB = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); } catch { } try { CSK = JSON.parse(fs.readFileSync(SKIN_FILE, 'utf8')); } catch { } loaded = true; console.log('Accounts: lokale Datei (' + Object.keys(USERS).length + ')'); return; }
 try {
 const r = await fetch('https://api.github.com/gists/' + GIST_ID, { headers: GH }); if (!r.ok) throw new Error('HTTP ' + r.status);
 const files = (await r.json()).files, read = async f => !f ? '{}' : f.truncated ? await (await fetch(f.raw_url, { headers: GH })).text() : f.content;
 USERS = JSON.parse(await read(files[GIST_FILE]) || '{}'); PUB = JSON.parse(await read(files['maps.json']) || '{}'); LB = Object.assign({ all: [], day: '', today: [] }, JSON.parse(await read(files['leaderboard.json']) || '{}')); CSK = JSON.parse(await read(files['skins.json']) || '{}'); loaded = true; console.log('Accounts: Gist geladen (' + Object.keys(USERS).length + ')');
 } catch (e) { console.error('Gist laden fehlgeschlagen (' + e.message + ') – neuer Versuch in 10 s'); setTimeout(loadUsers, 10000); } // nie mit leerem Stand überschreiben
}
async function writeUsers() {
 if (!loaded) return; if (writing) { again = true; return; } writing = true;
 try {
 if (GIST_ID && GIST_TOKEN) { const r = await fetch('https://api.github.com/gists/' + GIST_ID, { method: 'PATCH', headers: GH, body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(USERS) }, 'maps.json': { content: JSON.stringify(PUB) }, 'leaderboard.json': { content: JSON.stringify(LB) }, 'skins.json': { content: JSON.stringify(CSK) } } }) }); if (!r.ok) throw new Error('HTTP ' + r.status); }
 else { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = USERS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(USERS)); fs.renameSync(tmp, USERS_FILE); fs.writeFileSync(PUB_FILE, JSON.stringify(PUB)); fs.writeFileSync(LB_FILE, JSON.stringify(LB)); fs.writeFileSync(SKIN_FILE, JSON.stringify(CSK)); }
 } catch (e) { console.error('Accounts speichern fehlgeschlagen: ' + e.message); again = true; }
 writing = false; if (again) { again = false; persist(); }
}
function persist() { clearTimeout(saveT); saveT = setTimeout(writeUsers, GIST_ID ? 3000 : 500); } // Gist: Änderungen 3 s sammeln (schont das GitHub-Limit)
loadUsers();
// Render beendet den Server mit SIGTERM (Deploy/Ruhemodus) → offene Änderungen vorher noch speichern
process.on('SIGTERM', async () => { clearTimeout(saveT); while (writing) await new Promise(r => setTimeout(r, 100)); await writeUsers(); process.exit(0); });
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const cleanData = d => { const o = {}; if (d && typeof d === 'object') for (const k of SYNC_KEYS) if (typeof d[k] === 'string') o[k] = d[k]; return o; };
const byTok = tok => typeof tok === 'string' && tok.length === 48 ? Object.values(USERS).find(u => u.toks.includes(tok)) : null;
const newTok = u => { const t = crypto.randomBytes(24).toString('hex'); u.toks = [t, ...u.toks].slice(0, 10); return t; };
const tries = new Map(); // einfache Bremse gegen Passwort-Raten: max. 10 Versuche pro Minute und IP
function limited(ip) { const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 60000); t.push(now); tries.set(ip, t); return t.length > 10; }
function api(p, b, ip) {
 if (!loaded) return { err: 'Server startet gerade – bitte in ein paar Sekunden nochmal.' };
 if (p === '/api/register' || p === '/api/login') {
 if (limited(ip)) return { err: 'Zu viele Versuche – bitte kurz warten.' };
 const name = String(b.u || '').trim(), key = name.toLowerCase(), pw = String(b.p || '');
 if (!/^[a-zA-Z0-9_äöüÄÖÜß-]{3,16}$/.test(name)) return { err: 'Name: 3–16 Zeichen (Buchstaben, Zahlen, _ -)' };
 if (pw.length < 4 || pw.length > 64) return { err: 'Passwort: 4–64 Zeichen' };
 if (p === '/api/register') {
 if (USERS[key]) return { err: 'Name ist schon vergeben.' };
 const salt = crypto.randomBytes(16).toString('hex'), u = USERS[key] = { name, salt, hash: hashPw(pw, salt), toks: [], ver: 1, data: cleanData(b.data) };
 const tok = newTok(u); persist(); return { ok: 1, u: name, tok, ver: u.ver };
 }
 const u = USERS[key]; if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) return { err: 'Name oder Passwort falsch.' };
 const tok = newTok(u); persist(); return { ok: 1, u: u.name, tok, ver: u.ver, data: u.data };
 }
 // ── Community-Skins: Liste für alle ──
 if (p === '/api/skins') return { ok: 1, skins: Object.values(CSK) };
 // ── Community-Karten: jeder sieht sie, veröffentlichen/entfernen nur mit Code ──
 if (p === '/api/maps') return { ok: 1, maps: PUB };
 // ── Entenjagd-Bestenliste: Top 10 heute + Top 10 aller Zeiten (pro Name nur der beste Wert) ──
 const today = new Date().toISOString().slice(0, 10); LB.w = LB.w || {}; if (LB.day !== today) { LB.day = today; LB.today = []; for (const k in LB.w) LB.w[k].today = []; }
 const wk = ['ak47', 'pump', 'awp'].includes(b.w) ? b.w : 'ak47', L = wk === 'ak47' ? LB : (LB.w[wk] = LB.w[wk] || { all: [], today: [] }); // eigene Liste je Waffe
 if (p === '/api/dhlb') return { ok: 1, all: L.all, today: L.today };
 if (p === '/api/dhscore') {
 if (limited(ip)) return { err: 'Zu viele Anfragen.' };
 const name = String(b.n || 'Gast').replace(/[<>"'&`]/g, '').trim().slice(0, 16) || 'Gast', sc = Math.floor(+b.s), ducks = Math.floor(+b.d) || 0;
 if (!(sc > 0) || sc > 5000 || ducks > 400) return { err: 'Ungültige Punktzahl.' }; // Plausibilität: 2 Min Entenjagd
 const put = list => { const old = list.find(e => e.n.toLowerCase() === name.toLowerCase()); if (old) { if (sc <= old.s) return list; old.s = sc; old.d = ducks; } else list.push({ n: name, s: sc, d: ducks }); return list.sort((a, c) => c.s - a.s).slice(0, 10); };
 L.all = put(L.all); L.today = put(L.today); persist();
 const rank = l => { const i = l.findIndex(e => e.n.toLowerCase() === name.toLowerCase() && e.s === sc); return i < 0 ? 0 : i + 1; };
 return { ok: 1, all: L.all, today: L.today, rAll: rank(L.all), rToday: rank(L.today) };
 }
 if (p === '/api/publish' || p === '/api/unpublish') {
 if (limited(ip)) return { err: 'Zu viele Versuche – bitte kurz warten.' };
 const c = Buffer.from(String(b.code || '')), want = Buffer.from(PUBLISH_CODE);
 if (c.length !== want.length || !crypto.timingSafeEqual(c, want)) return { err: 'Falscher Code.' };
 const k = String(b.k || ''); if (!/^puba?_[a-z0-9_]{1,40}$/.test(k)) return { err: 'Ungültige Karte.' }; const AR = k.startsWith('puba_'); // puba_ = Arena (11×18, ohne Bombsites)
 if (p === '/api/unpublish') { delete PUB[k]; persist(); return { ok: 1 }; }
 const m = b.map || {}, HEX = /^#[0-9a-f]{6}$/i;
 if (!Array.isArray(m.g) || m.g.length !== (AR ? 18 : 28) || !m.g.every(r => typeof r === 'string' && (AR ? /^[#.cCh=1-6TKsbDW]{11}$/ : /^[#.cCh=1-6ABTKsbDWR]{28}$/).test(r))) return { err: 'Ungültige Kartendaten.' };
 if (!PUB[k] && Object.keys(PUB).length >= 50) return { err: 'Maximal 50 Community-Karten.' };
 const col = {}; for (const f of ['sky', 'fog', 'floor', 'wall']) if (m.col && HEX.test(m.col[f])) col[f] = m.col[f];
 PUB[k] = { n: String(m.n || 'Karte').replace(/[<>"'&`]/g, '').slice(0, 20), th: /^de_[a-z]+$/.test(m.th) ? m.th : 'de_dusty', col, tod: [0, 1, 2].includes(+m.tod) ? +m.tod : 0, em: Array.from(String(m.em || '').replace(/[<>"'&`]/g, '')).slice(0, 2).join(''), emc: HEX.test(m.emc) ? m.emc : '', by: String(b.by || '').replace(/[<>"'&`]/g, '').slice(0, 16), g: m.g };
 persist(); return { ok: 1 };
 }
 const u = byTok(b.tok); if (!u) return { err: 'Bitte neu einloggen.', relog: 1 };
 if (p === '/api/pull') return { ok: 1, ver: u.ver, data: u.data };
 // Community-Skins: erstellen (max. 10 je Spieler, 300 gesamt), löschen, kaufen, Verkaufs-Coins abholen
 if (p === '/api/mkskin') {
 const k = b.s || {}, W = ['knife', 'awp', 'scout', 'ak47', 'm4a1', 'pump', 'mp5', 'deagle', 'usp', 'glock', 'he', 'flash', 'smoke', 'molly', 'c4'], P = ['solid', 'fade', 'stripes', 'tiger', 'carbon', 'neon', 'camo', 'doppler', 'gold', 'dragon', 'asiimov', 'paint'], col = v => Math.max(0, Math.min(0xffffff, Math.floor(+v) || 0));
 if (!W.includes(k.w) || !P.includes(k.p) || ![1, 2, 3, 4].includes(+k.r)) return { err: 'Ungültiger Skin.' };
 const img = k.p === 'paint' ? String(k.img || '') : ''; if (k.p === 'paint' && (img.length > 16000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img))) return { err: 'Bild ungültig oder zu groß.' };
 const name = String(k.n || '').replace(/[<>"'&`|]/g, '').trim().slice(0, 20); if (name.length < 2) return { err: 'Name: mindestens 2 Zeichen.' };
 const all = Object.values(CSK); if (all.filter(x => x.by === u.name).length >= 10) return { err: 'Maximal 10 eigene Skins.' }; if (all.length >= 300) return { err: 'Der Shop ist voll (300 Skins).' };
 const id = 'u_' + crypto.randomBytes(5).toString('hex'); CSK[id] = { id, w: k.w, km: k.w === 'knife' && ['butterfly', 'karambit'].includes(k.km) ? k.km : undefined, n: name, c: col(k.c), c2: col(k.c2), c3: col(k.c3), p: k.p, img: img || undefined, r: +k.r, by: u.name, sold: 0, t: Date.now() }; persist(); return { ok: 1, skin: CSK[id] };
 }
 if (p === '/api/rmskin') { const k = CSK[b.id]; if (!k || k.by !== u.name) return { err: 'Nicht Dein Skin.' }; delete CSK[b.id]; persist(); return { ok: 1 }; }
 if (p === '/api/buyskin') {
 const k = CSK[b.id]; if (!k) return { err: 'Skin gibt es nicht mehr.' }; k.sold++;
 const owner = USERS[k.by.toLowerCase()]; if (owner && owner !== u) owner.earn = (owner.earn || 0) + Math.floor(({ 1: 150, 2: 400, 3: 900, 4: 2500 })[k.r] / 2); persist(); return { ok: 1 };
 }
 if (p === '/api/claim') { const c = u.earn || 0; if (c) { u.earn = 0; persist(); } return { ok: 1, coins: c }; }
 if (p === '/api/save') { u.data = cleanData(b.data); u.ver++; persist(); return { ok: 1, ver: u.ver }; }
 if (p === '/api/logout') { u.toks = u.toks.filter(t => t !== b.tok); persist(); return { ok: 1 }; }
 return { err: 'Unbekannt' };
}

const server = http.createServer((req, res) => {
 if (req.method === 'POST' && req.url.startsWith('/api/')) {
 let body = '', big = false;
 req.on('data', c => { body += c; if (body.length > 512 * 1024) { big = true; req.destroy(); } });
 req.on('end', () => {
 if (big) return; let out;
 try { out = api(req.url, JSON.parse(body || '{}'), req.headers['cf-connecting-ip'] || req.socket.remoteAddress); } catch { out = { err: 'Ungültige Anfrage' }; }
 res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
 });
 return;
 }
 let p = decodeURIComponent(req.url.split('?')[0]);
 if (p === '/') p = '/index.html';
 const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
 fs.readFile(file, (err, data) => {
 if (err) { res.writeHead(404); res.end('Nicht gefunden'); return; }
 // Spielseite, Service Worker & Manifest nie zwischenspeichern → Updates kommen sofort an; Icons etc. 1 Std.
 const fresh = /\.(html|json)$|sw\.js$/.test(file);
 res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'public, max-age=3600' });
 res.end(data);
 });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
wss.on('connection', ws => {
 ws.on('message', raw => {
 let m; try { m = JSON.parse(raw) } catch { return }
 if (m.type === 'rooms') {
 const list = [...rooms.entries()].map(([name, r]) => ({ name, n: r.clients.length, st: r.started ? 1 : 0, mode: r.mode || null })).filter(r => r.n > 0);
 ws.send(JSON.stringify({ type: 'rooms', rooms: list }));
 return;
 }
 if (m.type === 'join') {
 ws.room = m.room; ws.pid = m.pid;
 if (!rooms.has(m.room)) rooms.set(m.room, { clients: [], hostPid: null });
 const r = rooms.get(m.room);
 const isHost = r.clients.length === 0;
 if (isHost) r.hostPid = m.pid;
 ws.send(JSON.stringify({ type: 'joined', host: isHost }));
 r.clients.push(ws);
  } else if (ws.room) {
 const r = rooms.get(ws.room);
 if (r && (m.type === 'start' || m.type === 'glstart')) r.started = true;
 if (r && m.type === 'lmode') r.mode = m.mode;
 for (const c of (r ? r.clients : []))
 if (c !== ws && c.readyState === 1) c.send(raw.toString());
 }
 });
 ws.on('close', () => {
 if (!ws.room) return;
 const r = rooms.get(ws.room); if (!r) return;
 const i = r.clients.indexOf(ws); if (i >= 0) r.clients.splice(i, 1);
 for (const c of r.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'leave', pid: ws.pid }));
 if (r.clients.length === 0) { rooms.delete(ws.room); return; }
 if (ws.pid === r.hostPid) {
 const next = r.clients[0];
 r.hostPid = next.pid;
 if (next.readyState === 1) next.send(JSON.stringify({ type: 'promote' }));
 for (const c of r.clients) if (c !== next && c.readyState === 1) c.send(JSON.stringify({ type: 'newhost', pid: next.pid }));
 }
 });
});
server.listen(PORT, () => console.log('CS-Server (HTTP + WS) läuft auf Port ' + PORT));





// const { WebSocketServer } = require('ws');
// const wss = new WebSocketServer({ port: 8081 });
// const rooms = new Map();
// wss.on('connection', ws => {
//  ws.on('message', raw => {
//  let m; try { m = JSON.parse(raw) } catch { return }
//  if (m.type === 'join') {
//  ws.room = m.room; ws.pid = m.pid;
//  if (!rooms.has(m.room)) rooms.set(m.room, { clients: [], hostPid: null });
//  const r = rooms.get(m.room);
//  const isHost = r.clients.length === 0;
//  if (isHost) r.hostPid = m.pid;
//  ws.send(JSON.stringify({ type: 'joined', host: isHost }));
//  r.clients.push(ws);
//  } else if (ws.room) {
//  const r = rooms.get(ws.room);
//  for (const c of (r ? r.clients : []))
//  if (c !== ws && c.readyState === 1) c.send(raw.toString());
//  }
//  });
//  ws.on('close', () => {
//  if (!ws.room) return;
//  const r = rooms.get(ws.room); if (!r) return;
//  const i = r.clients.indexOf(ws); if (i >= 0) r.clients.splice(i, 1);
//  for (const c of r.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'leave', pid: ws.pid }));
//  if (r.clients.length === 0) { rooms.delete(ws.room); return; }
//  // Host weg? → dienstältesten Client befördern
//  if (ws.pid === r.hostPid) {
//  const next = r.clients[0];
//  r.hostPid = next.pid;
//  if (next.readyState === 1) next.send(JSON.stringify({ type: 'promote' }));
//  for (const c of r.clients) if (c !== next && c.readyState === 1) c.send(JSON.stringify({ type: 'newhost', pid: next.pid }));
//  }
//  });
// });
// console.log('CS-Server läuft auf ws://localhost:8081');