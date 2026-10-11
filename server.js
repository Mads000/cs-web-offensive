const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8081;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
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
 const list = [...rooms.entries()].map(([name, r]) => ({ name, n: r.clients.length, st: r.started ? 1 : 0 })).filter(r => r.n > 0);
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