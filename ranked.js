// ── CLUTCH Ranked: Rating (Elo), Ränge, Saison, Warteschlange, Matchmaking, Ergebnis-Prüfung ──
// Der Server rechnet & speichert alles. Das Spiel selbst simuliert der Host-Client – der Server liest dessen
// Nachrichten im Ranked-Raum mit, zählt Runden/Duelle selbst und wertet nur plausible, vollständige Matches.
const crypto = require('crypto');

const CFG = {
 start: 1000, // Start-Rating (Mitte von „Challenger II“)
 placements: 5, placementsReturn: 2, // Placement-Matches: neu / nach Saison-Reset
 k: [[0, 40], [10, 24], [50, 16]], // [ab gewertetem Match, K] – Stützpunkte
 kSmooth: true, // true: linear zwischen den Stützpunkten (keine Sprünge bei 10/50), false: Stufen
 season: +process.env.RANKED_SEASON || 1, softReset: 0.5, // neue Saison: R = start + (R - start) × 0.5
 seasonStart: process.env.RANKED_SEASON_START || '2026-11-01', seasonMonths: 3, // ab Start alle 3 Monate automatisch neue Saison
 team: { comp: +process.env.RANKED_TEAM || 5, duo: 2, v1: 1 }, // Spieler pro Team (5v5, 2v2, 1v1)
 dodge: { windowMin: 30, ban: [0, 60, 120, 300] }, // Ablehnen/Verpassen in 30 Min: 1. frei, 2. 1 Min, 3. 2 Min, ab 4. 5 Min Suchsperre (nie länger)
 hitCap: 150, // ADR-Statistik: max. Schaden pro gemeldetem Treffer
 fillSec: 30, // 2v2/5v5: nach 30 s Wartezeit freie Plätze mit Bots auffüllen (Bot-Stärke = Lobby-Durchschnitt, Bots bekommen kein Rating)
 win: { base: 100, grow: 8, max: 600, prov: 100 }, // Ratingfenster: 100 + 8/s Wartezeit, max 600, +100 im Placement
 acceptSec: 20, joinSec: 120, abandonSec: 90, // Annehmen, Beitreten, ganzes Team weg → Abbruch
 maps: ['de_dusty', 'de_bazaar', 'de_frost', 'de_moisty', 'de_foundry'], // nur offizielle Hauptmaps
 arenas: ['ar_dustyard', 'ar_frostbox', 'ar_moistpit', 'ar_skyline'], // 1v1: offizielle Arenen (rotieren je Duell)
 rules: { rounds: 15, roundTime: 115, freeze: 5, bombTime: 40, money: 800, bots: 0, hsOnly: 0, wpn: 0, grav: 100, jump: 100, speed: 100, infAmmo: 0 },
 v1Wins: 5, minRoundMs: 8000, minFirstMs: 5000, minDuelMs: 4000,
 // lückenlose Grenzen: Rang gilt ab „lo“ bis zur nächsten Grenze
 ranks: [[-Infinity, 'Recruit'], [650, 'Contender I'], [750, 'Contender II'], [850, 'Challenger I'], [950, 'Challenger II'], [1050, 'Elite I'], [1150, 'Elite II'], [1250, 'Master I'], [1350, 'Master II'], [1500, 'CLUTCH Elite']],
 keepMatches: 3000, hist: 20
};
const MODES = ['comp', 'duo', 'v1'], TEAMMODE = md => md !== 'v1'; // comp & duo = Wettkampf (Bombe), v1 = Arena-Duell
function seasonNow(now = Date.now()) { const s = new Date(CFG.seasonStart + 'T00:00:00Z'), d = new Date(now); if (isNaN(s) || d < s) return CFG.season; return Math.max(CFG.season, 1 + Math.floor(((d.getUTCFullYear() - s.getUTCFullYear()) * 12 + d.getUTCMonth() - s.getUTCMonth()) / CFG.seasonMonths)); }

// ── Mathe ──
const expected = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));
function kFactor(n, placing) {
 const K = CFG.k; if (placing || n <= K[0][0]) return K[0][1];
 for (let i = 1; i < K.length; i++) if (n < K[i][0]) return CFG.kSmooth ? K[i - 1][1] + (K[i][1] - K[i - 1][1]) * (n - K[i - 1][0]) / (K[i][0] - K[i - 1][0]) : K[i - 1][1];
 return K[K.length - 1][1];
}
function rankOf(r) {
 let i = 0; while (i + 1 < CFG.ranks.length && r >= CFG.ranks[i + 1][0]) i++;
 const lo = CFG.ranks[i][0], hi = i + 1 < CFG.ranks.length ? CFG.ranks[i + 1][0] : null;
 return { i, name: CFG.ranks[i][1], lo: lo === -Infinity ? null : lo, hi, prog: hi === null ? 1 : lo === -Infinity ? Math.max(0, Math.min(1, r / hi)) : (r - lo) / (hi - lo) };
}
const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
// Team-Elo: Teamstärke = Durchschnitt; jeder Spieler bekommt K_eigen × (S − E_Team). S0 = Ergebnis von Team 0 (1/0.5/0).
function rateTeams(t0, t1, S0) {
 const E0 = expected(avg(t0.map(p => p.r)), avg(t1.map(p => p.r))), out = [];
 for (const [t, S, E] of [[t0, S0, E0], [t1, 1 - S0, 1 - E0]]) for (const p of t) { const d = Math.round(kFactor(p.n, p.placing) * (S - E)); out.push({ key: p.key, before: p.r, after: Math.max(0, p.r + d), d }); }
 return { E0, out };
}
// 2N Spieler → zwei Teams mit möglichst gleichem Durchschnitt (alle Aufteilungen, Spieler 0 fest in Team A)
function balance(ps) {
 const N = ps.length / 2; let best = null;
 const rec = (i, a) => {
  if (a.length === N) { const A = a.map(j => ps[j]), B = ps.filter((_, j) => !a.includes(j)), d = Math.abs(avg(A.map(p => p.r)) - avg(B.map(p => p.r))); if (!best || d < best.d) best = { d, A, B }; return; }
  for (let j = i; j < ps.length; j++) rec(j + 1, [...a, j]);
 };
 rec(1, [0]); return [best.A, best.B];
}
const winOf = (e, now) => Math.min(CFG.win.max, CFG.win.base + CFG.win.grow * (now - e.t) / 1000) + (e.prov ? CFG.win.prov : 0);
// Warteschlange eines Modus → Gruppen. Längste Wartezeit zuerst; nur Spieler, deren Fenster sich gegenseitig decken.
function pickMatches(list, size, now) {
 const used = new Set(), out = [], need = size * 2;
 for (const a of [...list].sort((x, y) => x.t - y.t)) {
  if (used.has(a.key)) continue;
  const cand = list.filter(b => b !== a && !used.has(b.key) && Math.abs(b.r - a.r) <= Math.min(winOf(a, now), winOf(b, now))).sort((x, y) => Math.abs(x.r - a.r) - Math.abs(y.r - a.r)).slice(0, need - 1);
  if (cand.length < need - 1) continue;
  const g = [a, ...cand];
  g.forEach(p => used.add(p.key)); out.push(size === 1 ? [[a], [cand[0]]] : balance(g));
 }
 return out;
}
// Nach fillSec Wartezeit: Menschen im Ratingfenster sammeln (max. 2×size), per Schlange aufteilen, Rest = Bots
function fillMatches(list, size, now) {
 const used = new Set(), out = [];
 for (const a of [...list].sort((x, y) => x.t - y.t)) {
  if (used.has(a.key) || now - a.t < CFG.fillSec * 1000) continue;
  const g = [a, ...list.filter(b => b !== a && !used.has(b.key) && Math.abs(b.r - a.r) <= Math.min(winOf(a, now), winOf(b, now))).sort((x, y) => Math.abs(x.r - a.r) - Math.abs(y.r - a.r)).slice(0, size * 2 - 1)].sort((x, y) => y.r - x.r);
  const A = [], B = []; g.forEach((p, i) => ([0, 3].includes(i % 4) ? A : B).push(p)); // 1.→A, 2.+3.→B, 4.→A … (ausgeglichen)
  g.forEach(p => used.add(p.key)); out.push([A, B]);
 }
 return out;
}
const softReset = r => Math.round(CFG.start + (r - CFG.start) * CFG.softReset);

// ── Server-Teil ── RK: dauerhafte Daten { season, p: {key: Spieler}, mt: {id: Match} }; rooms: Map der WS-Räume
function createRanked({ RK, persist, rooms, auth }) {
 function init() { // nach dem Laden der Daten aufrufen
  RK.season = Math.max(RK.season || 0, seasonNow()); RK.p = RK.p || {}; RK.mt = RK.mt || {};
  for (const m of Object.values(RK.mt)) if (m.st === 'live') { m.st = 'aborted'; m.why = 'Server-Neustart'; m.t1 = Date.now(); } // laufende Matches überleben keinen Neustart
 }
 init();
 const Q = new Map(), LIVE = new Map(), BY = new Map(), DODGE = new Map(), BAN = new Map(); // Warteschlange, offene Matches, Spieler → Match-ID, Ablehnungen, Suchsperren
 const tx = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
 const newMode = pq => ({ r: CFG.start, n: 0, pl: 0, pq, w: 0, l: 0, d: 0, ab: 0, peak: CFG.start, h: [] });
 function rec(key, name) { // Spielerdaten holen, neue Saison bei Bedarf weich zurücksetzen (Historie bleibt)
  let p = RK.p[key]; if (!p) p = RK.p[key] = { n: name || key, s: RK.season, m: {}, past: [] };
  for (const md of MODES) if (!p.m[md]) p.m[md] = newMode(CFG.placements); // neue Modi (z. B. 2v2) für bestehende Spieler ergänzen
  if (name) p.n = name;
  if (p.s !== RK.season) {
   for (const md of MODES) { const M = p.m[md]; if (M.n) { p.past.push({ s: p.s, mode: md, r: M.r, rank: M.pl >= M.pq ? rankOf(M.r).name : null, peak: M.peak, w: M.w, l: M.l, d: M.d }); M.r = softReset(M.r); M.pl = 0; M.pq = CFG.placementsReturn; M.w = M.l = M.d = 0; M.peak = M.r; } }
   p.s = RK.season; persist();
  }
  return p;
 }
 const view = M => ({ r: M.r, n: M.n, pl: M.pl, pq: M.pq, placed: M.pl >= M.pq, rank: rankOf(M.r), w: M.w, l: M.l, d: M.d, ab: M.ab, peak: M.peak, k: Math.round(kFactor(M.n, M.pl < M.pq) * 10) / 10 });
 function profile(u) {
  const key = u.name.toLowerCase(), p = rec(key, u.name), out = { season: RK.season, ranks: CFG.ranks.map(([lo, n]) => [lo === -Infinity ? null : lo, n]), maps: CFG.maps, past: p.past.slice(-20), m: {} };
  for (const md of MODES) out.m[md] = Object.assign(view(p.m[md]), { size: CFG.team[md], hist: p.m[md].h.slice(0, 10).map(id => RK.mt[id]).filter(Boolean).map(mt => matchView(mt, key)) });
  const id = BY.get(key), L = id && LIVE.get(id); if (L && L.st === 'live') out.live = goMsg(L, key);
  const q = Q.get(key); if (q) out.queue = { mode: q.mode, t: q.t };
  if (BAN.get(key) > Date.now()) out.ban = BAN.get(key);
  return out;
 }
 function matchView(mt, key) {
  const side = mt.tm[0].includes(key) ? 0 : 1, c = mt.ch && mt.ch[key];
  return { id: mt.id, mode: mt.mode, t: mt.t1 || mt.t, map: mt.map, st: mt.st, why: mt.why, res: mt.res === undefined ? null : side === 0 ? mt.res : 1 - mt.res, sc: mt.sc ? (side === 0 ? mt.sc : [mt.sc[1], mt.sc[0]]) : null, d: c ? c[1] - c[0] : 0, r: c ? c[1] : null, ps: mt.stats ? mt.stats[key] : null, opp: [...mt.tm[1 - side].map(k => (RK.p[k] || {}).n || k), ...(mt.nb && mt.nb[1 - side] ? ['Bot ×' + mt.nb[1 - side]] : [])], bots: mt.nb ? mt.nb[0] + mt.nb[1] : 0, blv: mt.blv || 0 };
 }
 // ── Warteschlange (eigene WS-Verbindung des Ranked-Menüs) ──
 function queueMsg(ws, m) {
  if (m.type === 'rkq') {
   const u = auth(m.tok); if (!u) return tx(ws, { type: 'rkoff', why: 'Bitte einloggen.' }), true;
   const key = u.name.toLowerCase(), mode = MODES.includes(m.mode) ? m.mode : null; if (!mode) return true;
   if (BAN.get(key) > Date.now()) return tx(ws, { type: 'rkoff', why: 'Suchsperre wegen wiederholtem Ablehnen', ban: BAN.get(key) }), true;
   const busy = BY.get(key); if (busy && LIVE.has(busy)) { const L = LIVE.get(busy); return tx(ws, L.st === 'live' ? Object.assign({ why: 'Du bist noch in einem Ranked-Match.' }, goMsg(L, key), { type: 'rkoff', live: 1 }) : { type: 'rkoff', why: 'Match wird gerade angenommen.' }), true; }
   const q = Q.get(key); if (q && q.ws !== ws && q.ws.readyState === 1) return tx(ws, { type: 'rkoff', why: 'Du suchst bereits in einem anderen Fenster.' }), true;
   const M = rec(key, u.name).m[mode]; Q.set(key, { key, name: u.name, ws, mode, t: q && q.mode === mode ? q.t : Date.now(), r: M.r, prov: M.pl < M.pq }); ws.rkKey = key;
   status(Q.get(key), Date.now()); return true;
  }
  if (m.type === 'rkx') { const q = ws.rkKey && Q.get(ws.rkKey); if (q && q.ws === ws) Q.delete(ws.rkKey); tx(ws, { type: 'rkoff', why: '' }); return true; }
  if (m.type === 'rkacc') {
   const L = LIVE.get(m.id), key = ws.rkKey; if (!L || L.st !== 'accept' || !key || !L.keys.includes(key)) return true;
   if (!m.ok) { L.dec.add(key); cancelAccept(L); return true; }
   L.acc.add(key); if (TEAMMODE(L.mode)) { if (CFG.maps.includes(m.map)) L.votes[key] = m.map; if (CFG.maps.includes(m.ban) && m.ban !== m.map) L.bans[key] = m.ban; }
   for (const k of L.keys) tx(L.qws[k], { type: 'rkacc', a: L.acc.size, n: L.keys.length });
   if (L.acc.size === L.keys.length) go(L); return true;
  }
  return false;
 }
 function status(q, now) { tx(q.ws, { type: 'rkq', mode: q.mode, t: q.t, n: [...Q.values()].filter(x => x.mode === q.mode).length, win: Math.round(winOf(q, now)) }); }
 function wsClose(ws) { const k = ws.rkKey; if (!k) return; const q = Q.get(k); if (q && q.ws === ws) Q.delete(k); const L = LIVE.get(BY.get(k)); if (L && L.st === 'accept' && L.qws[k] === ws && !L.acc.has(k)) { L.dec.add(k); cancelAccept(L); } }
 function dodge(key, now) { // Ablehnen/Verpassen zählen → gestufte Suchsperre, nie länger als 5 Min
  const W = CFG.dodge.windowMin * 60000, t = (DODGE.get(key) || []).filter(x => now - x < W); t.push(now); DODGE.set(key, t);
  const sec = CFG.dodge.ban[Math.min(t.length, CFG.dodge.ban.length) - 1]; if (sec) BAN.set(key, now + sec * 1000); return sec;
 }
 function cancelAccept(L) { // jemand lehnt ab / Zeit abgelaufen → Annehmende zurück in die Schlange (Wartezeit bleibt), Rest raus
  if (L.st !== 'accept') return; L.st = 'cancel'; LIVE.delete(L.id); const now = Date.now(), ban = {}; for (const k of L.dec) ban[k] = dodge(k, now);
  for (const k of L.keys) { BY.delete(k); const e = L.q[k]; if (L.acc.has(k) && !L.dec.has(k) && e.ws.readyState === 1) { Q.set(k, e); tx(e.ws, { type: 'rkback', why: 'Ein Spieler hat nicht angenommen – Suche läuft weiter.' }); status(e, Date.now()); } else tx(e.ws, Object.assign({ type: 'rkoff', why: 'Match nicht angenommen.' + (ban[k] ? ' Suchsperre: ' + ban[k] / 60 + ' Min.' : L.dec.has(k) ? ' Beim nächsten Ablehnen gibt es eine kurze Suchsperre.' : '') }, ban[k] ? { ban: now + ban[k] * 1000 } : {})); }
 }
 function tick(now = Date.now()) {
  for (const md of MODES) {
   const list = [...Q.values()].filter(q => q.mode === md && q.ws.readyState === 1);
   for (const [A, B] of pickMatches(list, CFG.team[md], now)) create(md, A, B, now);
   if (TEAMMODE(md)) for (const [A, B] of fillMatches([...Q.values()].filter(q => q.mode === md && q.ws.readyState === 1), CFG.team[md], now)) create(md, A, B, now);
  }
  if (Math.floor(now / 1000) % 2 === 0) for (const q of Q.values()) status(q, now);
  if (seasonNow(now) > RK.season) newSeason(seasonNow(now));
  for (const L of [...LIVE.values()]) {
   if (L.st === 'accept' && now - L.t > CFG.acceptSec * 1000) { for (const k of L.keys) if (!L.acc.has(k)) L.dec.add(k); cancelAccept(L); continue; }
   if (L.st !== 'live') continue;
   if (!L.started && now - L.t > CFG.joinSec * 1000) { end(L, 'aborted', 'Nicht alle Spieler sind beigetreten (' + L.keys.filter(k => !connected(L).has(k)).map(k => L.q[k].name).join(', ') + ')'); continue; }
   if (L.started) { const c = connected(L); for (const t of [0, 1]) { if (!L.tm[t].length) continue; if (L.tm[t].some(k => c.has(k))) L.gone[t] = 0; else if (!L.gone[t]) L.gone[t] = now; else if (now - L.gone[t] > CFG.abandonSec * 1000) { quit(L, t, 'Team ' + (t + 1) + ' hat das Match vollständig verlassen'); break; } } }
  }
 }
 function create(md, A, B, now) {
  const id = now.toString(36) + '-' + crypto.randomBytes(4).toString('hex'), keys = [...A, ...B].map(p => p.key), size = CFG.team[md], nb = [size - A.length, size - B.length];
  const botR = nb[0] + nb[1] ? Math.round(avg([...A, ...B].map(p => p.r))) : null, blv = botR === null ? 0 : rankOf(botR).i + 1;
  const rules = nb[0] + nb[1] ? Object.assign({}, CFG.rules, { bots: 1, teamSize: size, blv }) : CFG.rules;
  const L = { id, mode: md, st: 'accept', tm: [A.map(p => p.key), B.map(p => p.key)], keys, nb, botR, rules, q: {}, qws: {}, acc: new Set(), dec: new Set(), votes: {}, bans: {}, t: now };
  for (const p of [...A, ...B]) { Q.delete(p.key); BY.set(p.key, id); L.q[p.key] = p; L.qws[p.key] = p.ws; tx(p.ws, { type: 'rkfound', id, mode: md, maps: TEAMMODE(md) ? CFG.maps : null, sec: CFG.acceptSec, n: keys.length, bots: nb[0] + nb[1], blv }); }
  LIVE.set(id, L);
 }
 function go(L) { // alle haben angenommen → Map: Punkte = Stimmen − Banns, höchste Punktzahl gewinnt, Gleichstand (auch ohne Stimmen) = Zufall
  let map = null;
  if (TEAMMODE(L.mode)) { const sc = Object.fromEntries(CFG.maps.map(m => [m, 0])); for (const v of Object.values(L.votes)) sc[v]++; for (const b of Object.values(L.bans)) sc[b]--; const top = Math.max(...Object.values(sc)), pool = CFG.maps.filter(m => sc[m] === top); map = pool[crypto.randomInt(pool.length)]; }
  Object.assign(L, { st: 'live', t: Date.now(), room: 'rk_' + L.id, map, started: false, sc: [0, 0], lastEv: 0, gone: [0, 0], gt: null, last: {}, dmg: {}, side: ['CT', 'T'] });
  RK.mt[L.id] = { id: L.id, mode: L.mode, s: RK.season, st: 'live', t: L.t, map, tm: L.tm, r0: Object.fromEntries(L.keys.map(k => [k, L.q[k].r])), nb: L.nb, botR: L.botR, blv: L.rules.blv || 0 };
  const ids = Object.keys(RK.mt); if (ids.length > CFG.keepMatches) for (const id of ids.slice(0, ids.length - CFG.keepMatches)) delete RK.mt[id];
  persist();
  for (const k of L.keys) tx(L.qws[k], goMsg(L, k));
 }
 function goMsg(L, key) { return { type: 'rkgo', id: L.id, mode: L.mode, room: L.room, map: L.map, team: L.side[L.tm[0].includes(key) ? 0 : 1], n: L.keys.length, nb: L.nb, rules: L.rules }; }
 const roomOf = L => rooms.get(L.room);
 const connected = L => new Set(((roomOf(L) || {}).clients || []).filter(c => c.readyState === 1 && c.acc).map(c => c.acc));
 // ── Ranked-Raum: Beitritt nur mit Account aus dem Match, doppelte Verbindung ersetzt die alte (Wiederverbinden) ──
 function join(ws, room) {
  if (!/^rk_/.test(String(room))) return true;
  const L = [...LIVE.values()].find(x => x.room === room);
  if (!L || L.st !== 'live' || !ws.acc || !L.keys.includes(ws.acc)) { tx(ws, { type: 'rkdeny', why: !L ? 'Dieses Ranked-Match existiert nicht mehr.' : 'Du gehörst nicht zu diesem Match.' }); return false; }
  const r = rooms.get(room); if (r) for (const old of r.clients.filter(c => c.acc === ws.acc)) { r.clients.splice(r.clients.indexOf(old), 1); try { old.close(); } catch { } }
  ws.rk = L; return true;
 }
 function joined(L) { const c = connected(L); if (!L.started) for (const cl of roomOf(L).clients) tx(cl, { type: 'rkst', n: c.size, N: L.keys.length }); }
 const HOST_ONLY = new Set(['start', 'glstart', 'roster', 'round', 'end', 'over', 'snap', 'glphase', 'glduel', 'glend', 'glstand', 'glover', 'dhstart', 'dhend', 'dhs', 'dhev', 'dhbh', 'dhdie', 'dhhit']);
 // Nachricht im Ranked-Raum: false = verwerfen, String = (umgeschriebene) Nachricht weiterleiten
 function msg(ws, r, m, raw) {
  const L = ws.rk; if (!L || L.st !== 'live' || typeof m.type !== 'string') return raw;
  const host = ws.pid === r.hostPid, now = Date.now();
  if (m.type === 'team' || m.type.startsWith('dh')) return false;
  if (HOST_ONLY.has(m.type) && !host) return false;
  if (m.type === 'hello' || m.type === 'hello2') { m.team = L.side[L.tm[0].includes(ws.acc) ? 0 : 1]; return JSON.stringify(m); }
  if (m.type === 'st') { L.last[ws.acc] = { al: !!m.al, h: +m.h || 0, k: m.k | 0, dd: m.d | 0 }; return raw; }
  if (m.type === 'dmg' && L.started) { const to = (r.clients.find(c => c.pid === m.to) || {}).acc; if (to && L.tm[0].includes(to) !== L.tm[0].includes(ws.acc)) L.dmg[ws.acc] = (L.dmg[ws.acc] || 0) + Math.max(0, Math.min(CFG.hitCap, +m.d || 0)); return raw; } // nur Statistik (ADR)
  const bad = why => { end(L, 'invalid', why); return raw; };
  if (TEAMMODE(L.mode)) {
   if (m.type === 'start') { const c = m.cfg || {}; if (m.dm || m.cmap || m.map !== L.map || Object.keys(L.rules).some(k => c[k] !== L.rules[k])) return bad('Ungültige Match-Einstellungen'); if (!L.started) { if (connected(L).size < L.keys.length) return bad('Start vor Beitritt aller Spieler'); L.started = true; L.lastEv = now; } }
   if (m.type === 'roster') { const b = Array.isArray(m.bots) ? m.bots : []; if (L.side.some((sd, i) => b.filter(x => x && x.t === sd).length !== L.nb[i]) || b.length !== L.nb[0] + L.nb[1]) return bad('Falsche Anzahl Bots'); } // nur die vom Server vorgesehenen Auffüll-Bots
   if (m.type === 'end' && L.started) { const i = L.side.indexOf(m.w), W = Math.floor(CFG.rules.rounds / 2) + 1; if (i < 0 || now - L.lastEv < (L.sc[0] + L.sc[1] ? CFG.minRoundMs : CFG.minFirstMs) || Math.max(...L.sc) >= W || L.sc[0] + L.sc[1] >= CFG.rules.rounds) return bad('Unplausible Rundenfolge'); L.sc[i]++; L.lastEv = now; }
   if (m.type === 'over' && L.started) { const sc = m.sc || {}, W = Math.floor(CFG.rules.rounds / 2) + 1; if (sc.CT !== L.sc[0] || sc.T !== L.sc[1] || (Math.max(...L.sc) < W && L.sc[0] + L.sc[1] < CFG.rules.rounds)) return bad('Endstand passt nicht zu den gezählten Runden'); end(L, 'rated', null, L.sc[0] > L.sc[1] ? 1 : L.sc[0] < L.sc[1] ? 0 : 0.5); }
  } else {
   if (m.type === 'glstart') {
    const pid2acc = new Map(r.clients.map(c => [c.pid, c.acc])), T = Array.isArray(m.teams) ? m.teams : [], mem = T.map(t => (t.members || []).map(x => pid2acc.get(x.p)));
    if (!m.v1 || (m.bots || []).length || T.length !== 2 || mem.some(a => a.length !== 1 || !a[0]) || mem[0][0] === mem[1][0] || !mem.every(a => L.keys.includes(a[0]))) return bad('Ungültiger 1v1-Start');
    if (!L.started) { L.started = true; L.lastEv = now; L.gt = { [T[0].id]: mem[0][0], [T[1].id]: mem[1][0] }; L.wins = { [T[0].id]: 0, [T[1].id]: 0 }; }
   }
   if (m.type === 'glend' && L.started) {
    const wk = L.gt[m.w], lk = L.gt[m.l], ls = L.last[lk], hostK = ws.acc;
    if (!wk || !lk || wk === lk || now - L.lastEv < CFG.minDuelMs || Object.values(L.wins).some(v => v >= CFG.v1Wins)) return bad('Unplausible Duellfolge');
    if (lk !== hostK && ls && ls.al && ls.h > ((L.last[wk] || {}).h ?? 100)) return bad('Duell-Ergebnis widerspricht dem Spielerstatus'); // Verlierer meldet selbst: lebt & mehr HP
    L.wins[m.w]++; L.lastEv = now;
   }
   if (m.type === 'glover' && L.started) { const wk = L.gt[m.w]; if (!wk || L.wins[m.w] < CFG.v1Wins) return bad('Endstand passt nicht zu den gezählten Duellen'); v1sc(L); end(L, 'rated', null, wk === L.tm[0][0] ? 1 : 0); }
  }
  return raw;
 }
 const v1sc = L => { const ids = Object.keys(L.wins || {}); L.sc = [L.wins[ids.find(i => L.gt[i] === L.tm[0][0])] | 0, L.wins[ids.find(i => L.gt[i] === L.tm[1][0])] | 0]; };
 // Team t hat das Match verlassen: vor Ende der ersten Runde / des ersten Duells → Abbruch ohne Wertung, danach → Niederlage für Team t
 function quit(L, t, why) {
  if (L.mode === 'v1') v1sc(L);
  if (L.sc[0] + L.sc[1] < 1) return end(L, 'aborted', why + ' (vor Ende der ersten Runde – keine Wertung)');
  const c = connected(L); if (L.mode !== 'v1' && L.tm[1 - t].length && !L.tm[1 - t].some(k => c.has(k))) return end(L, 'aborted', 'Beide Teams haben das Match verlassen');
  end(L, 'rated', why + ' – gewertet als Niederlage', t === 0 ? 0 : 1);
 }
 function leave(ws) { // 1v1: das Spiel kennt keinen Wiedereinstieg nach dem Start → Trennung = verlassen
  const L = ws.rk; if (!L || L.st !== 'live' || !roomOf(L)) return;
  if (L.mode === 'v1' && L.started && !connected(L).has(ws.acc)) return quit(L, L.tm[0].includes(ws.acc) ? 0 : 1, L.q[ws.acc].name + ' hat das 1v1 verlassen');
  joined(L);
 }
 // ── Abschluss: genau einmal, alle Änderungen in einem Schritt, danach eine Speicherung ──
 function end(L, st, why, S0) {
  if (L.st !== 'live') return; L.st = st; LIVE.delete(L.id); for (const k of L.keys) if (BY.get(k) === L.id) BY.delete(k);
  const mt = RK.mt[L.id] || (RK.mt[L.id] = { id: L.id, mode: L.mode, s: RK.season, t: L.t, map: L.map, tm: L.tm });
  const c = connected(L), rounds = Math.max(1, L.sc[0] + L.sc[1]); // Statistik (K/D/ADR) – fließt NICHT ins Rating
  Object.assign(mt, { st, why: why || null, t1: Date.now(), sc: L.started ? L.sc : null, stats: Object.fromEntries(L.keys.map(k => [k, Object.assign({ left: !c.has(k), adr: Math.round(((L.dmg || {})[k] || 0) / rounds) }, L.last[k] ? { k: L.last[k].k, d: L.last[k].dd } : {})])) });
  if (st === 'rated') {
   const P = k => { const M = rec(k).m[L.mode]; return { key: k, r: M.r, n: M.n, placing: M.pl < M.pq }; }, bot = () => ({ key: null, r: L.botR, n: 0 });
   const { E0, out } = rateTeams([...L.tm[0].map(P), ...Array.from({ length: L.nb[0] }, bot)], [...L.tm[1].map(P), ...Array.from({ length: L.nb[1] }, bot)], S0); mt.res = S0; mt.E0 = Math.round(E0 * 1000) / 1000; mt.ch = {};
   for (const o of out) {
    if (!o.key) continue; // Bot
    const M = rec(o.key).m[L.mode], S = L.tm[0].includes(o.key) ? S0 : 1 - S0;
    M.r = o.after; M.n++; M.pl++; if (S === 1) M.w++; else if (S === 0) M.l++; else M.d++; if (mt.stats[o.key].left) M.ab++;
    if (M.pl >= M.pq) M.peak = Math.max(M.peak, M.r); M.h.unshift(L.id); M.h.length = Math.min(M.h.length, CFG.hist); mt.ch[o.key] = [o.before, o.after];
   }
  } else if (L.started) for (const k of L.keys) { const M = rec(k).m[L.mode]; if (mt.stats[k].left) M.ab++; M.h.unshift(L.id); M.h.length = Math.min(M.h.length, CFG.hist); } // Abbruch/ungültig: in der Historie sichtbar, Rating unverändert
  persist();
  const r = roomOf(L); for (const cl of (r ? r.clients : [])) if (cl.acc) tx(cl, Object.assign({ type: 'rkdone' }, matchView(mt, cl.acc), { me: RK.p[cl.acc] ? view(RK.p[cl.acc].m[L.mode]) : null, prev: mt.ch && mt.ch[cl.acc] ? rankOf(mt.ch[cl.acc][0]).name : null }));
 }
 function newSeason(s) { RK.season = s; persist(); } // Soft-Reset passiert pro Spieler beim nächsten Zugriff (rec)
 function board(mode, key) { // Bestenliste der aktuellen Saison: nur platzierte Spieler
  if (!MODES.includes(mode)) mode = 'comp';
  const all = Object.entries(RK.p).filter(([, p]) => p.s === RK.season && p.m[mode] && p.m[mode].n && p.m[mode].pl >= p.m[mode].pq).map(([k, p]) => ({ k, n: p.n, r: p.m[mode].r, w: p.m[mode].w, l: p.m[mode].l })).sort((a, b) => b.r - a.r || b.w - a.w);
  const pos = all.findIndex(x => x.k === key);
  return { mode, season: RK.season, total: all.length, top: all.slice(0, 50).map(x => ({ n: x.n, r: x.r, rank: rankOf(x.r).name, w: x.w, l: x.l })), me: pos < 0 ? null : { pos: pos + 1, r: all[pos].r } };
 }
 return { init, queueMsg, wsClose, tick, join, joined: ws => ws.rk && joined(ws.rk), msg, leave, profile, board, newSeason, _: { Q, LIVE, BY, BAN, end } };
}

module.exports = { CFG, MODES, seasonNow, fillMatches, expected, kFactor, rankOf, rateTeams, balance, pickMatches, softReset, winOf, createRanked };
