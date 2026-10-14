const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8081;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

// ── Accounts ohne Datenbank: alles in data/users.json (Passwörter nur als scrypt-Hash) ──
const crypto = require('crypto');
const DATA_DIR = path.join(__dirname, 'data'), USERS_FILE = path.join(DATA_DIR, 'users.json');
const SYNC_KEYS = ['agent', 'bonus20', 'btnlayout', 'cases', 'cs_binds', 'cs_opts', 'custommaps', 'equip', 'gamecfg', 'inv', 'map', 'pname', 'stick'];
let USERS = {}; try { USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { }
let saveT = null;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = USERS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(USERS)); fs.renameSync(tmp, USERS_FILE); }, 500); }
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const cleanData = d => { const o = {}; if (d && typeof d === 'object') for (const k of SYNC_KEYS) if (typeof d[k] === 'string') o[k] = d[k]; return o; };
const byTok = tok => typeof tok === 'string' && tok.length === 48 ? Object.values(USERS).find(u => u.toks.includes(tok)) : null;
const newTok = u => { const t = crypto.randomBytes(24).toString('hex'); u.toks = [t, ...u.toks].slice(0, 10); return t; };
const tries = new Map(); // einfache Bremse gegen Passwort-Raten: max. 10 Versuche pro Minute und IP
function limited(ip) { const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 60000); t.push(now); tries.set(ip, t); return t.length > 10; }
function api(p, b, ip) {
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
 const u = byTok(b.tok); if (!u) return { err: 'Bitte neu einloggen.', relog: 1 };
 if (p === '/api/pull') return { ok: 1, ver: u.ver, data: u.data };
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
 res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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