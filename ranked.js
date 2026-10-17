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
 team: { comp: +process.env.RANKED_TEAM || 5, duo: 2, v1: 1, ur: 5, qdm: 5, qgl: 4, qv1: 1 }, // Spieler pro Team (5v5, 2v2, 1v1, Unranked 5v5)
 ur: { fillSec: 15 },
 quick: { fillSec: 10 }, // Matchmaking Deathmatch (bis 10) / Gauntlet (bis 8, Duos) / 1v1: ohne Rang, Bots füllen nach 10 s auf (1v1: nur Menschen) // Unranked: Spielersuche wie Ranked, Bots füllen schon nach 15 s auf; versteckte Spielstärke nur für Matchmaking & Bot-Stufe, keine Suchsperre
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
 keepMatches: 3000, hist: 20,
 party: { max: 5, invMin: 5, offSec: 120, tradeMs: 5000 } // Gruppe: max. Größe, Einladung gültig (Min), getrennte Mitglieder fliegen nach 120 s raus (nicht während eines Matches), Trade-Fenster für KAST
};
const MODES = ['comp', 'duo', 'v1'], QMODES = [...MODES, 'ur', 'qdm', 'qgl', 'qv1'], TEAMMODE = md => md !== 'v1' && md !== 'qv1' && md !== 'qgl', QUICK = md => /^q(dm|gl|v1)$/.test(md), VOTE = md => TEAMMODE(md); // QUICK = Matchmaking ohne Rang & ohne Ergebnisprüfung; VOTE = Map-Voting // comp & duo = Wettkampf (Bombe), v1 = Arena-Duell; ur = Unranked (eigene Schlange, kein Rang)
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
// Warteschlange → Einheiten: Gruppe (gleiche Party-ID pt) = eine Einheit (Rating = Durchschnitt), Einzelspieler = Einheit aus 1.
// Unvollständige Gruppen (pn = Gruppengröße beim Start der Suche) werden übersprungen → Gruppen werden nie getrennt.
function units(list, size) {
 const m = new Map(); for (const q of list) { const k = q.pt || q.key; if (!m.has(k)) m.set(k, []); m.get(k).push(q); }
 return [...m.entries()].map(([key, ps]) => ({ key, ps, r: avg(ps.map(p => p.r)), t: Math.min(...ps.map(p => p.t)), prov: ps.some(p => p.prov) })).filter(u => u.ps.length === (u.ps[0].pn || 1) && u.ps.length <= size);
}
// Einheiten → zwei Teams à size Spieler, möglichst gleicher Durchschnitt (Einheit 0 fest in Team A); null = nicht aufteilbar
function split(g, size) {
 if (g.every(u => u.ps.length === 1)) { const ps = g.map(u => u.ps[0]); return size === 1 ? [[ps[0]], [ps[1]]] : balance(ps); }
 const all = g.flatMap(u => u.ps); let best = null;
 const rec = (i, a, n) => {
  if (n === size) { const A = a.flatMap(u => u.ps), B = all.filter(p => !A.includes(p)), d = Math.abs(avg(A.map(p => p.r)) - avg(B.map(p => p.r))); if (!best || d < best.d) best = { d, A, B }; return; }
  for (let j = i; j < g.length; j++) if (n + g[j].ps.length <= size) rec(j + 1, [...a, g[j]], n + g[j].ps.length);
 };
 rec(1, [g[0]], g[0].ps.length); return best && [best.A, best.B];
}
// Warteschlange eines Modus → Matches. Längste Wartezeit zuerst; nur Einheiten, deren Fenster sich gegenseitig decken.
function pickMatches(list, size, now) {
 const used = new Set(), out = [], need = size * 2, U = units(list, size);
 for (const a of [...U].sort((x, y) => x.t - y.t)) {
  if (used.has(a.key)) continue;
  const cand = U.filter(b => b !== a && !used.has(b.key) && Math.abs(b.r - a.r) <= Math.min(winOf(a, now), winOf(b, now))).sort((x, y) => Math.abs(x.r - a.r) - Math.abs(y.r - a.r));
  const g = [a]; let n = a.ps.length, sp = null;
  for (const b of cand) { if (n + b.ps.length > need) continue; g.push(b); n += b.ps.length; if (n === need) { sp = split(g, size); if (sp) break; g.pop(); n -= b.ps.length; } }
  if (!sp) continue;
  g.forEach(u => used.add(u.key)); out.push(sp);
 }
 return out;
}
// Nach fillSec Wartezeit: Menschen im Ratingfenster sammeln (max. 2×size), per Schlange aufteilen, Rest = Bots
function fillMatches(list, size, now, sec = CFG.fillSec) {
 const used = new Set(), out = [], U = units(list, size);
 for (const a of [...U].sort((x, y) => x.t - y.t)) {
  if (used.has(a.key) || now - a.t < sec * 1000) continue;
  const near = U.filter(b => b !== a && !used.has(b.key) && Math.abs(b.r - a.r) <= Math.min(winOf(a, now), winOf(b, now))).sort((x, y) => Math.abs(x.r - a.r) - Math.abs(y.r - a.r));
  const g = [a]; let n = a.ps.length; for (const b of near) if (n + b.ps.length <= size * 2) { g.push(b); n += b.ps.length; }
  const A = [], B = [];
  if (g.every(u => u.ps.length === 1)) g.map(u => u.ps[0]).sort((x, y) => y.r - x.r).forEach((p, i) => ([0, 3].includes(i % 4) ? A : B).push(p)); // 1.→A, 2.+3.→B, 4.→A … (ausgeglichen)
  else for (const u of [...g].sort((x, y) => y.ps.length - x.ps.length || y.r - x.r)) { // Gruppen zuerst, jeweils ins kleinere (bei Gleichstand schwächere) Team
   const sum = T => T.reduce((s, p) => s + p.r, 0), fit = [A, B].filter(T => T.length + u.ps.length <= size).sort((x, y) => x.length - y.length || sum(x) - sum(y));
   if (fit.length) fit[0].push(...u.ps); else g.splice(g.indexOf(u), 1);
  }
  g.forEach(u => used.add(u.key)); out.push([A, B]);
 }
 return out;
}
const softReset = r => Math.round(CFG.start + (r - CFG.start) * CFG.softReset);

// ── Server-Teil ── RK: dauerhafte Daten { season, p: {key: Spieler}, mt: {id: Match} }; rooms: Map der WS-Räume
// Optionale Hooks von server.js: user(name) → Account, friends(a, b) → befreundet?, info(key) → { av, bd } (Profilbild, Badges),
// maps() → zusätzliche offizielle (Community-)Maps im Pool, mapData(k) → Kartendaten dazu
function createRanked({ RK, persist, rooms, auth, user = () => null, friends = () => false, info = () => ({}), maps = () => [], mapData = () => null }) {
 const pool = () => [...CFG.maps, ...maps().filter(k => !CFG.maps.includes(k))];
 function init() { // nach dem Laden der Daten aufrufen
  RK.season = Math.max(RK.season || 0, seasonNow()); RK.p = RK.p || {}; RK.mt = RK.mt || {};
  for (const m of Object.values(RK.mt)) if (m.st === 'live') { m.st = 'aborted'; m.why = 'Server-Neustart'; m.t1 = Date.now(); } // laufende Matches überleben keinen Neustart
 }
 init();
 const Q = new Map(), LIVE = new Map(), BY = new Map(), DODGE = new Map(), BAN = new Map(); // Warteschlange, offene Matches, Spieler → Match-ID, Ablehnungen, Suchsperren
 const PT = new Map(), PBY = new Map(), CON = new Map(), OFF = new Map(); // Gruppen (nur im Speicher), Spieler → Gruppen-ID, aktuelle Ranked-Verbindung, getrennt seit
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
 function urRec(key, name) { // Unranked: versteckte Spielstärke, startet beim 5v5-Ranked-Rating; Ranked-Werte bleiben unberührt
  const p = rec(key, name); if (!p.u) p.u = { r: p.m.comp.r, n: 0, w: 0, l: 0, d: 0, ab: 0, h: [] }; return p.u;
 }
 const view = M => ({ r: M.r, n: M.n, pl: M.pl, pq: M.pq, placed: M.pl >= M.pq, rank: rankOf(M.r), w: M.w, l: M.l, d: M.d, ab: M.ab, peak: M.peak, k: Math.round(kFactor(M.n, M.pl < M.pq) * 10) / 10 });
 function profile(u) {
  const key = u.name.toLowerCase(), p = rec(key, u.name), out = { season: RK.season, ranks: CFG.ranks.map(([lo, n]) => [lo === -Infinity ? null : lo, n]), maps: pool(), past: p.past.slice(-20), m: {} };
  for (const md of MODES) out.m[md] = Object.assign(view(p.m[md]), { size: CFG.team[md], hist: p.m[md].h.slice(0, 10).map(id => RK.mt[id]).filter(Boolean).map(mt => matchView(mt, key)) });
  const U = urRec(key, u.name); out.ur = { n: U.n, w: U.w, l: U.l, d: U.d, ab: U.ab, size: CFG.team.ur, fill: CFG.ur.fillSec, hist: U.h.slice(0, 10).map(id => RK.mt[id]).filter(Boolean).map(mt => matchView(mt, key)) }; // ohne Rating-Zahl
  const id = BY.get(key), L = id && LIVE.get(id); if (L && L.st === 'live') out.live = goMsg(L, key);
  const q = Q.get(key); if (q) out.queue = { mode: q.mode, t: q.t };
  if (BAN.get(key) > Date.now()) out.ban = BAN.get(key);
  return out;
 }
 function matchView(mt, key) {
  const side = mt.tm[0].includes(key) ? 0 : 1, c = mt.ch && mt.ch[key];
  return { id: mt.id, mode: mt.mode, t: mt.t1 || mt.t, map: mt.map, st: mt.st, why: mt.why, res: mt.res === undefined ? null : side === 0 ? mt.res : 1 - mt.res, sc: mt.sc ? (side === 0 ? mt.sc : [mt.sc[1], mt.sc[0]]) : null, d: c ? c[1] - c[0] : 0, r: c ? c[1] : null, ps: mt.stats ? mt.stats[key] : null, opp: [...mt.tm[1 - side].map(k => (RK.p[k] || {}).n || k), ...(mt.nb && mt.nb[1 - side] ? ['Bot ×' + mt.nb[1 - side]] : [])], bots: mt.nb ? mt.nb[0] + mt.nb[1] : 0, blv: mt.blv || 0 };
 }
 // ── Öffentliches Profil (für andere sichtbar): Rang je Modus + Durchschnittswerte aus server-gezählten, gewerteten Matches ──
 // ADR = Schaden / Runden, K/D = Kills / Tode, HS % = Headshot-Kills / Kills, KAST = Runden mit Kill, Assist, Überlebt oder Trade / Runden (nur 5v5 & 2v2).
 // n = Anzahl Matches mit Server-Statistik (ältere Matches ohne diese Zählung fließen nicht ein); fehlt die Grundlage → null statt einer erfundenen Zahl.
 const aggView = A => !A || !A.n ? { n: 0 } : { n: A.n, adr: A.rd ? Math.round(A.dmg / A.rd) : null, kd: A.d ? Math.round(A.k / A.d * 100) / 100 : null, k: A.k, d: A.d, a: A.a, hs: A.k ? Math.round(A.hs / A.k * 100) : null, kast: A.krd ? Math.round(A.kast / A.krd * 100) : null };
 function pub(key) {
  const out = { season: RK.season, m: {} }; if (!RK.p[key]) return out; const p = rec(key);
  for (const md of MODES) { const M = p.m[md], placed = M.pl >= M.pq; out.m[md] = { placed, rank: placed ? rankOf(M.r).name : null, r: placed ? M.r : null, pl: M.pl, pq: M.pq, w: M.w, l: M.l, d: M.d, st: aggView((p.agg || {})[md]), hist: M.h.slice(0, 5).map(id => RK.mt[id]).filter(Boolean).map(mt => { const v = matchView(mt, key); return { mode: v.mode, t: v.t, map: v.map, st: v.st, res: v.res, sc: v.sc, d: v.d }; }) }; }
  if (p.u) out.ur = { w: p.u.w, l: p.u.l, d: p.u.d, st: aggView((p.agg || {}).ur), hist: p.u.h.slice(0, 5).map(id => RK.mt[id]).filter(Boolean).map(mt => { const v = matchView(mt, key); return { mode: v.mode, t: v.t, map: v.map, st: v.st, res: v.res, sc: v.sc, d: 0 }; }) };
  return out;
 }
 // ── Gruppen (Party): Leiter lädt Freunde ein, startet/bricht die Suche ab; alles läuft hier auf dem Server ──
 const party = k => PT.get(PBY.get(k)), busy = k => Q.has(k) || BY.has(k); // busy = sucht gerade oder steckt in einem Match (Annehmen/läuft)
 const fresh = i => Date.now() - i.t < CFG.party.invMin * 60000;
 function pView(P) {
  const rkOf = k => { const p = RK.p[k]; return Object.fromEntries(MODES.map(md => { const M = p && p.m[md]; return [md, M && M.pl >= M.pq ? rankOf(M.r).name : null]; })); };
  return { id: P.id, lead: P.nm[P.lead], mem: P.mem.map(k => Object.assign({ n: P.nm[k], on: !!(CON.get(k) && CON.get(k).readyState === 1), lead: k === P.lead, q: Q.has(k), rk: rkOf(k) }, info(k))), inv: [...P.inv.entries()].filter(([, i]) => fresh(i)).map(([, i]) => i.n) };
 }
 const pSend = P => { const v = pView(P); for (const k of P.mem) tx(CON.get(k), { type: 'rkpst', pt: v }); };
 const invsFor = k => [...PT.values()].filter(P => P.inv.has(k) && fresh(P.inv.get(k))).map(P => ({ id: P.id, from: P.nm[P.lead] }));
 function prune(P, why) { // abgelaufene Einladungen weg; Gruppe ohne Mitspieler & ohne offene Einladung → auflösen
  for (const [k, i] of P.inv) if (!fresh(i)) P.inv.delete(k);
  if (P.mem.length > 1 || (P.mem.length === 1 && P.inv.size)) return pSend(P);
  for (const k of P.mem) { PBY.delete(k); tx(CON.get(k), { type: 'rkpst', pt: null, why: why || 'Gruppe aufgelöst.' }); } PT.delete(P.id);
 }
 function leaveParty(k, why) {
  const P = party(k); if (!P) return; const q = Q.get(k); if (q && q.pt === P.id) dequeue(q, P.nm[k] + ' hat die Gruppe verlassen – Suche beendet.');
  P.mem = P.mem.filter(x => x !== k); PBY.delete(k); OFF.delete(k); if (P.lead === k && P.mem.length) P.lead = P.mem[0]; // Leiter weg → nächstes Mitglied übernimmt
  tx(CON.get(k), { type: 'rkpst', pt: null, why: why || '' }); prune(P);
 }
 function dequeue(q, why) { // Suche beenden – bei Gruppen immer für alle Mitglieder gleichzeitig
  const all = q.pt ? [...Q.values()].filter(x => x.pt === q.pt) : [q];
  for (const x of all) { Q.delete(x.key); tx(x.ws, { type: 'rkoff', why: x === q ? '' : why || '' }); }
  const P = q.pt && PT.get(q.pt); if (P) pSend(P);
 }
 function partyMsg(ws, m, now) {
  const me = ws.rkKey, err = why => (tx(ws, { type: 'rkperr', why }), true); if (!me || CON.get(me) !== ws) return err('Bitte Ranked neu öffnen.');
  if (m.type === 'rkpinv') {
   const t = user(String(m.n || '').trim()), P0 = party(me); if (!t) return err('Spieler nicht gefunden.'); const tk = t.name.toLowerCase();
   if (tk === me) return err('Das bist Du selbst.'); if (!friends(me, tk)) return err('Nur Freunde können eingeladen werden.');
   if (P0 && P0.lead !== me) return err('Nur der Gruppenleiter kann einladen.'); if (P0 && P0.mem.includes(tk)) return err(t.name + ' ist schon in Deiner Gruppe.');
   if ((P0 ? P0.mem : [me]).some(busy)) return err('Während Suche oder Match keine Einladungen.');
   if (P0 && P0.mem.length + [...P0.inv.entries()].filter(([k, i]) => fresh(i) && k !== tk).length >= CFG.party.max) return err('Gruppe ist voll (max. ' + CFG.party.max + ').');
   const P = P0 || { id: 'pt_' + crypto.randomBytes(5).toString('hex'), lead: me, mem: [me], nm: { [me]: ws.rkName || me }, inv: new Map() };
   if (!P0) { PT.set(P.id, P); PBY.set(me, P.id); }
   P.inv.set(tk, { t: now, n: t.name }); tx(CON.get(tk), { type: 'rkpinv', inv: invsFor(tk) }); pSend(P); tx(ws, { type: 'rkperr', why: '✓ Einladung an ' + t.name + ' gesendet', ok: 1 }); return true;
  }
  if (m.type === 'rkpjoin') {
   const P = PT.get(m.id), i = P && P.inv.get(me); if (!i || !fresh(i)) return err('Einladung ist abgelaufen.');
   if (busy(me)) return err('Beende zuerst Deine Suche bzw. Dein Match.'); if (P.mem.some(busy)) return err('Die Gruppe sucht gerade oder spielt – später nochmal.');
   if (P.mem.length >= CFG.party.max) return err('Gruppe ist voll.');
   if (party(me) && party(me) !== P) leaveParty(me); P.inv.delete(me); if (!P.mem.includes(me)) P.mem.push(me); P.nm[me] = ws.rkName || me; PBY.set(me, P.id); pSend(P); return true;
  }
  if (m.type === 'rkpdec') { const P = PT.get(m.id); if (P && P.inv.delete(me)) prune(P); tx(ws, { type: 'rkpinv', inv: invsFor(me) }); return true; }
  if (m.type === 'rkpleave') { leaveParty(me, ''); return true; }
  if (m.type === 'rkpkick') {
   const P = party(me), tk = String(m.n || '').toLowerCase(); if (!P || P.lead !== me) return err('Nur der Gruppenleiter kann Mitglieder entfernen.');
   if (tk === me || !P.mem.includes(tk)) return err('Nicht in Deiner Gruppe.'); leaveParty(tk, 'Du wurdest aus der Gruppe entfernt.'); return true;
  }
  return true;
 }
 // ── Warteschlange (eigene WS-Verbindung des Ranked-Menüs) ──
 function queueMsg(ws, m) {
  const now = Date.now();
  if (m.type === 'rkhi') { // Ranked-Menü verbunden → Gruppe & Einladungen zustellen
   const u = auth(m.tok); if (!u) return true; const key = u.name.toLowerCase(); ws.rkKey = key; ws.rkName = u.name; CON.set(key, ws); OFF.delete(key);
   const P = party(key); if (P) pSend(P); else tx(ws, { type: 'rkpst', pt: null }); tx(ws, { type: 'rkpinv', inv: invsFor(key) }); return true;
  }
  if (m.type.startsWith('rkp')) return partyMsg(ws, m, now);
  if (m.type === 'rkq') {
   const u = auth(m.tok); if (!u) return tx(ws, { type: 'rkoff', why: 'Bitte einloggen.' }), true;
   const key = u.name.toLowerCase(), mode = QMODES.includes(m.mode) ? m.mode : null; if (!mode) return true;
   if (BAN.get(key) > Date.now()) return tx(ws, { type: 'rkoff', why: 'Suchsperre wegen wiederholtem Ablehnen', ban: BAN.get(key) }), true;
   const busyId = BY.get(key); if (busyId && LIVE.has(busyId)) { const L = LIVE.get(busyId); return tx(ws, L.st === 'live' ? Object.assign({ why: 'Du bist noch in einem Ranked-Match.' }, goMsg(L, key), { type: 'rkoff', live: 1 }) : { type: 'rkoff', why: 'Match wird gerade angenommen.' }), true; }
   const q = Q.get(key); if (q && q.ws !== ws && q.ws.readyState === 1) return tx(ws, { type: 'rkoff', why: 'Du suchst bereits in einem anderen Fenster.' }), true;
   ws.rkKey = key; ws.rkName = u.name; CON.set(key, ws); OFF.delete(key);
   const P = party(key), mem = P && P.mem.length > 1 ? P.mem : [key];
   if (P && P.mem.length > 1) { // Gruppe: nur der Leiter sucht, alle müssen verbunden & frei sein, Größe muss zum Modus passen
    if (P.lead !== key) return tx(ws, { type: 'rkoff', why: 'Nur der Gruppenleiter (' + P.nm[P.lead] + ') kann die Suche starten.' }), true;
    const cap = mode === 'qgl' ? 2 : CFG.team[mode]; if (mem.length > cap) return tx(ws, { type: 'rkoff', why: 'Gruppe zu groß für ' + ({ comp: '5v5', duo: '2v2', v1: '1v1', ur: 'Unranked', qdm: 'Deathmatch', qgl: 'Gauntlet (Duos)', qv1: '1v1' })[mode] + ' (max. ' + cap + ').' }), true;
    for (const k of mem) { if (k === key) continue; const c = CON.get(k), n = P.nm[k];
     if (!c || c.readyState !== 1) return tx(ws, { type: 'rkoff', why: n + ' ist nicht im Ranked-Menü verbunden.' }), true;
     if (BAN.get(k) > now) return tx(ws, { type: 'rkoff', why: n + ' hat gerade eine Suchsperre.' }), true;
     if (BY.has(k)) return tx(ws, { type: 'rkoff', why: n + ' ist noch in einem Ranked-Match.' }), true; }
   }
   const t0 = q && q.mode === mode ? q.t : now;
   for (const k of mem) { const nm = k === key ? u.name : P.nm[k], M = mode === 'ur' || QUICK(mode) ? urRec(k, nm) : rec(k, nm).m[mode]; Q.set(k, { key: k, name: nm, ws: k === key ? ws : CON.get(k), mode, t: t0, r: M.r, prov: MODES.includes(mode) && M.pl < M.pq, pt: mem.length > 1 ? P.id : undefined, pn: mem.length }); }
   for (const k of mem) status(Q.get(k), now); if (P) pSend(P); return true;
  }
  if (m.type === 'rkx') { const q = ws.rkKey && Q.get(ws.rkKey); if (q && q.ws === ws) dequeue(q, q.pt ? (q.name + ' hat die Suche abgebrochen.') : ''); else tx(ws, { type: 'rkoff', why: '' }); return true; }
  if (m.type === 'rkacc') {
   const L = LIVE.get(m.id), key = ws.rkKey; if (!L || L.st !== 'accept' || !key || !L.keys.includes(key)) return true;
   if (!m.ok) { L.dec.add(key); cancelAccept(L); return true; }
   L.acc.add(key); if (VOTE(L.mode)) { if (L.maps.includes(m.map)) L.votes[key] = m.map; if (L.maps.includes(m.ban) && m.ban !== m.map) L.bans[key] = m.ban; }
   for (const k of L.keys) tx(L.qws[k], { type: 'rkacc', a: L.acc.size, n: L.keys.length });
   if (L.acc.size === L.keys.length) go(L); return true;
  }
  return false;
 }
 function status(q, now) { tx(q.ws, { type: 'rkq', mode: q.mode, t: q.t, n: [...Q.values()].filter(x => x.mode === q.mode).length, win: Math.round(winOf(q, now)), pn: q.pn || 1 }); }
 function wsClose(ws) { const k = ws.rkKey; if (!k) return; const q = Q.get(k); if (q && q.ws === ws) dequeue(q, q.name + ' hat die Verbindung verloren – Suche beendet.');
  if (CON.get(k) === ws) { CON.delete(k); OFF.set(k, Date.now()); const P = party(k); if (P) pSend(P); } // Gruppe bleibt kurz erhalten (Seite neu laden, Match-Start)
  const L = LIVE.get(BY.get(k)); if (L && L.st === 'accept' && L.qws[k] === ws && !L.acc.has(k)) { L.dec.add(k); cancelAccept(L); } }
 function dodge(key, now) { // Ablehnen/Verpassen zählen → gestufte Suchsperre, nie länger als 5 Min
  const W = CFG.dodge.windowMin * 60000, t = (DODGE.get(key) || []).filter(x => now - x < W); t.push(now); DODGE.set(key, t);
  const sec = CFG.dodge.ban[Math.min(t.length, CFG.dodge.ban.length) - 1]; if (sec) BAN.set(key, now + sec * 1000); return sec;
 }
 function cancelAccept(L) { // jemand lehnt ab / Zeit abgelaufen → Annehmende zurück in die Schlange (Wartezeit bleibt), Rest raus
  if (L.st !== 'accept') return; L.st = 'cancel'; LIVE.delete(L.id); const now = Date.now(), ban = {}; if (MODES.includes(L.mode)) for (const k of L.dec) ban[k] = dodge(k, now); // Unranked: keine Suchsperre
  for (const k of L.keys) { BY.delete(k); const e = L.q[k], pdec = e.pt && L.keys.some(j => L.q[j].pt === e.pt && L.dec.has(j)); if (L.acc.has(k) && !L.dec.has(k) && !pdec && e.ws.readyState === 1) { Q.set(k, e); tx(e.ws, { type: 'rkback', why: 'Ein Spieler hat nicht angenommen – Suche läuft weiter.' }); status(e, Date.now()); } else tx(e.ws, Object.assign({ type: 'rkoff', why: (pdec && !L.dec.has(k) ? 'Ein Gruppenmitglied hat nicht angenommen.' : 'Match nicht angenommen.') + (ban[k] ? ' Suchsperre: ' + ban[k] / 60 + ' Min.' : L.dec.has(k) && MODES.includes(L.mode) ? ' Beim nächsten Ablehnen gibt es eine kurze Suchsperre.' : '') }, ban[k] ? { ban: now + ban[k] * 1000 } : {})); }
 }
 function tick(now = Date.now()) {
  for (const md of QMODES) {
   const list = [...Q.values()].filter(q => q.mode === md && q.ws.readyState === 1);
   for (const [A, B] of pickMatches(list, CFG.team[md], now)) create(md, A, B, now);
   if (md === 'qdm' || md === 'qgl' || TEAMMODE(md)) for (const [A, B] of fillMatches([...Q.values()].filter(q => q.mode === md && q.ws.readyState === 1), CFG.team[md], now, QUICK(md) ? CFG.quick.fillSec : md === 'ur' ? CFG.ur.fillSec : CFG.fillSec)) create(md, A, B, now);
  }
  if (Math.floor(now / 1000) % 2 === 0) for (const q of Q.values()) status(q, now);
  if (seasonNow(now) > RK.season) newSeason(seasonNow(now));
  for (const [k, t] of OFF) if (now - t > CFG.party.offSec * 1000 && !BY.has(k)) { OFF.delete(k); leaveParty(k); } // getrennt & nicht im Match → aus der Gruppe
  for (const L of [...LIVE.values()]) {
   if (L.st === 'accept' && now - L.t > CFG.acceptSec * 1000) { for (const k of L.keys) if (!L.acc.has(k)) L.dec.add(k); cancelAccept(L); continue; }
   if (L.st !== 'live') continue;
   if (QUICK(L.mode) && L.started) { if (connected(L).size) L.gone[0] = 0; else if (!L.gone[0]) L.gone[0] = now; else if (now - L.gone[0] > CFG.abandonSec * 1000) end(L, 'aborted', 'Alle haben das Match verlassen'); continue; } // Matchmaking: erst Schluss, wenn alle weg sind
   if (!L.started && now - L.t > CFG.joinSec * 1000) { end(L, 'aborted', 'Nicht alle Spieler sind beigetreten (' + L.keys.filter(k => !connected(L).has(k)).map(k => L.q[k].name).join(', ') + ')'); continue; }
   if (L.started) { const c = connected(L); for (const t of [0, 1]) { if (!L.tm[t].length) continue; if (L.tm[t].some(k => c.has(k))) L.gone[t] = 0; else if (!L.gone[t]) L.gone[t] = now; else if (now - L.gone[t] > CFG.abandonSec * 1000) { quit(L, t, 'Team ' + (t + 1) + ' hat das Match vollständig verlassen'); break; } } }
  }
 }
 function create(md, A, B, now) {
  const id = now.toString(36) + '-' + crypto.randomBytes(4).toString('hex'), keys = [...A, ...B].map(p => p.key), size = CFG.team[md], nb = [size - A.length, size - B.length];
  if (QUICK(md)) { nb[0] = nb[1] = 0; } const fill = md === 'qdm' || md === 'qgl' ? 1 : 0; // Matchmaking: Bot-Zahl regelt das Spiel selbst (DM füllt auf 5 je Seite, Gauntlet füllt Teams)
  const botR = nb[0] + nb[1] || fill ? Math.round(avg([...A, ...B].map(p => p.r))) : null, blv = botR === null ? 0 : rankOf(botR).i + 1;
  const rules = nb[0] + nb[1] || fill ? Object.assign({}, CFG.rules, { bots: 1, teamSize: CFG.team[md === 'qgl' ? 'comp' : md] || 5, blv }) : CFG.rules;
  const L = { id, mode: md, st: 'accept', tm: [A.map(p => p.key), B.map(p => p.key)], keys, nb, botR, rules, q: {}, qws: {}, acc: new Set(), dec: new Set(), votes: {}, bans: {}, t: now, maps: pool() };
  for (const p of [...A, ...B]) { Q.delete(p.key); BY.set(p.key, id); L.q[p.key] = p; L.qws[p.key] = p.ws; tx(p.ws, { type: 'rkfound', id, mode: md, maps: VOTE(md) ? L.maps : null, names: VOTE(md) ? Object.fromEntries(L.maps.filter(k => mapData(k)).map(k => [k, mapData(k).n])) : null, sec: CFG.acceptSec, n: keys.length, bots: nb[0] + nb[1], blv }); }
  LIVE.set(id, L);
 }
 function go(L) { // alle haben angenommen → Map: Punkte = Stimmen − Banns, höchste Punktzahl gewinnt, Gleichstand (auch ohne Stimmen) = Zufall
  let map = null;
  if (VOTE(L.mode)) { const sc = Object.fromEntries(L.maps.map(m => [m, 0])); for (const v of Object.values(L.votes)) sc[v]++; for (const b of Object.values(L.bans)) sc[b]--; const top = Math.max(...Object.values(sc)), best = L.maps.filter(m => sc[m] === top); map = best[crypto.randomInt(best.length)]; }
  const cd = map && mapData(map); // offizielle Community-Map: Kartendaten (Stand bei Matchbeginn) vom Server an alle, der Host muss genau diese spielen
  if (cd) { L.cmap = { k: map, n: cd.n, th: cd.th, col: cd.col, tod: cd.tod, em: cd.em, emc: cd.emc, g: cd.g }; L.cg = cd.g.join(); }
  Object.assign(L, { st: 'live', t: Date.now(), room: 'rk_' + L.id, map, started: false, sc: [0, 0], lastEv: 0, gone: [0, 0], gt: null, last: {}, dmg: {}, side: ['CT', 'T'], ks: Object.fromEntries(L.keys.map(k => [k, { k: 0, d: 0, a: 0, hs: 0, kast: 0, rd: 0 }])), rd: newRd(), bt: {}, kf: false });
  RK.mt[L.id] = { id: L.id, mode: L.mode, s: RK.season, st: 'live', t: L.t, map, tm: L.tm, r0: Object.fromEntries(L.keys.map(k => [k, L.q[k].r])), nb: L.nb, botR: L.botR, blv: L.rules.blv || 0 };
  const ids = Object.keys(RK.mt); if (ids.length > CFG.keepMatches) for (const id of ids.slice(0, ids.length - CFG.keepMatches)) delete RK.mt[id];
  persist();
  for (const k of L.keys) tx(L.qws[k], goMsg(L, k));
 }
 function goMsg(L, key) { return { type: 'rkgo', id: L.id, mode: L.mode, room: L.room, map: L.map, cmap: L.cmap, team: L.side[L.tm[0].includes(key) ? 0 : 1], n: L.keys.length, nb: L.nb, rules: L.rules, duo: L.mode === 'qgl' ? Object.values(L.keys.reduce((g, k) => { const pt = L.q[k].pt; if (pt) (g[pt] = g[pt] || []).push(L.q[k].name); return g; }, {})).filter(d => d.length === 2) : undefined }; } // Gauntlet: Gruppen als Duo in ein Team
 const newRd = () => ({ died: new Map(), kl: new Set(), as: new Set(), tr: new Set(), dg: new Map() }); // pro Runde: Tode (Opfer → { by, t }), Kills, Assists, Trades, wer wem Schaden gemacht hat
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
 const HOST_ONLY = new Set(['start', 'glstart', 'roster', 'round', 'end', 'over', 'snap', 'glphase', 'glduel', 'glend', 'glstand', 'glover', 'glsd', 'glsabx', 'dhstart', 'dhend', 'dhs', 'dhev', 'dhbh', 'dhdie', 'dhhit']);
 // Nachricht im Ranked-Raum: false = verwerfen, String = (umgeschriebene) Nachricht weiterleiten
 function msg(ws, r, m, raw) {
  const L = ws.rk; if (!L || L.st !== 'live' || typeof m.type !== 'string') return raw;
  if (QUICK(L.mode)) { // ohne Rang: keine Ergebnisprüfung, nur Host darf steuern; Ende = Match vorbei
   if (m.type === 'team' || m.type.startsWith('dh') || (HOST_ONLY.has(m.type) && ws.pid !== r.hostPid)) return false;
   if (m.type === 'start' || m.type === 'glstart') L.started = true; if ((m.type === 'over' || m.type === 'glover') && L.started) { L.sc = [0, 0]; end(L, 'done', null); } return raw;
  }
  const host = ws.pid === r.hostPid, now = Date.now();
  if (m.type === 'team' || m.type.startsWith('dh')) return false;
  if (HOST_ONLY.has(m.type) && !host) return false;
  if (m.type === 'hello' || m.type === 'hello2') { m.team = L.side[L.tm[0].includes(ws.acc) ? 0 : 1]; return JSON.stringify(m); }
  if (m.type === 'st') { L.last[ws.acc] = { al: !!m.al, h: +m.h || 0, k: m.k | 0, dd: m.d | 0 }; return raw; }
  if (m.type === 'dmg' && L.started) { const to = (r.clients.find(c => c.pid === m.to) || {}).acc; if (to && L.tm[0].includes(to) !== L.tm[0].includes(ws.acc)) { L.dmg[ws.acc] = (L.dmg[ws.acc] || 0) + Math.max(0, Math.min(CFG.hitCap, +m.d || 0)); if (!L.rd.dg.has(to)) L.rd.dg.set(to, new Set()); L.rd.dg.get(to).add(ws.acc); } return raw; } // nur Statistik (ADR, Assists)
  if (m.type === 'kf' && L.started) { kfStat(L, r, ws, m, host, now); return raw; } // Kill-Meldung: nur Statistik (K/D/A, HS, KAST) – fließt NICHT ins Rating
  const bad = why => { end(L, 'invalid', why); return raw; };
  if (TEAMMODE(L.mode)) {
   if (m.type === 'start') { const c = m.cfg || {}; if (m.dm || (L.cg ? !(m.cmap && Array.isArray(m.cmap.g) && m.cmap.g.join() === L.cg) : m.cmap) || m.map !== L.map || Object.keys(L.rules).some(k => c[k] !== L.rules[k])) return bad('Ungültige Match-Einstellungen'); if (!L.started) { if (connected(L).size < L.keys.length) return bad('Start vor Beitritt aller Spieler'); L.started = true; L.lastEv = now; } }
   if (m.type === 'roster') { const b = Array.isArray(m.bots) ? m.bots : []; if (L.side.some((sd, i) => b.filter(x => x && x.t === sd).length !== L.nb[i]) || b.length !== L.nb[0] + L.nb[1]) return bad('Falsche Anzahl Bots'); L.bt = Object.fromEntries(b.map(x => [String(x.n), L.side.indexOf(x.t)])); } // nur die vom Server vorgesehenen Auffüll-Bots
   if (m.type === 'end' && L.started) { const i = L.side.indexOf(m.w), W = Math.floor(CFG.rules.rounds / 2) + 1; if (i < 0 || now - L.lastEv < (L.sc[0] + L.sc[1] ? CFG.minRoundMs : CFG.minFirstMs) || Math.max(...L.sc) >= W || L.sc[0] + L.sc[1] >= CFG.rules.rounds) return bad('Unplausible Rundenfolge'); L.sc[i]++; L.lastEv = now; roundEnd(L); }
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
    L.wins[m.w]++; L.lastEv = now; L.rd = newRd();
   }
   if (m.type === 'glover' && L.started) { const wk = L.gt[m.w]; if (!wk || L.wins[m.w] < CFG.v1Wins) return bad('Endstand passt nicht zu den gezählten Duellen'); v1sc(L); end(L, 'rated', null, wk === L.tm[0][0] ? 1 : 0); }
  }
  return raw;
 }
 // Kill-Meldung (kommt vom Opfer selbst bzw. vom Host für seine Bots): pro Runde zählt jedes Opfer nur einmal, Teamkills geben keinen Kill
 function kfStat(L, r, ws, m, host, now) {
  const isBot = n => typeof n === 'string' && L.bt[n] !== undefined, side = k => k.startsWith('b:') ? L.bt[k.slice(2)] : L.tm[0].includes(k) ? 0 : L.tm[1].includes(k) ? 1 : -1;
  const vk = host && isBot(m.vn) ? 'b:' + m.vn : ws.acc, ap = m.ap && (r.clients.find(c => c.pid === m.ap) || {}).acc, ak = ap && L.keys.includes(ap) ? ap : !m.ap && host && isBot(m.an) ? 'b:' + m.an : null, R = L.rd;
  if (!vk || R.died.has(vk) || side(vk) < 0) return; L.kf = true; const vs = side(vk), as = ak ? side(ak) : -1;
  R.died.set(vk, { by: ak, t: now }); if (L.ks[vk]) L.ks[vk].d++;
  if (!ak || as < 0 || as === vs) return; // Bombe, Sturz, Teamkill
  R.kl.add(ak); if (L.ks[ak]) { L.ks[ak].k++; if (m.hs) L.ks[ak].hs++; }
  for (const a of R.dg.get(vk) || []) if (a !== ak && side(a) === as && L.ks[a]) { L.ks[a].a++; R.as.add(a); } // Assist: Schaden am Opfer, Kill durch jemand anderen
  for (const [v2, x] of R.died) if (x.by === vk && side(v2) === as && now - x.t <= CFG.party.tradeMs) R.tr.add(v2); // Trade: Mörder eines Mitspielers innerhalb von 5 s erledigt
 }
 function roundEnd(L) { // KAST: Runde zählt mit Kill, Assist, Überlebt (und verbunden) oder Trade
  if (L.kf) { const c = connected(L); for (const k of L.keys) { const s = L.ks[k]; s.rd++; if (L.rd.kl.has(k) || L.rd.as.has(k) || (!L.rd.died.has(k) && c.has(k)) || L.rd.tr.has(k)) s.kast++; } }
  L.rd = newRd();
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
  const ks = k => L.kf && L.ks && L.ks[k]; // server-gezählt (Kill-Meldungen) – sonst wie bisher der gemeldete Spielerstatus
  Object.assign(mt, { st, why: why || null, t1: Date.now(), sc: L.started ? L.sc : null, stats: Object.fromEntries(L.keys.map(k => [k, Object.assign({ left: !c.has(k), adr: Math.round(((L.dmg || {})[k] || 0) / rounds) }, ks(k) ? { k: ks(k).k, d: ks(k).d, a: ks(k).a, hs: ks(k).hs } : L.last[k] ? { k: L.last[k].k, d: L.last[k].dd } : {}, ks(k) && TEAMMODE(L.mode) && ks(k).rd ? { kast: ks(k).kast, rd: ks(k).rd } : {})])) });
  const UR = L.mode === 'ur';
  if (st === 'rated' && UR) { // Unranked: Sieg/Niederlage & versteckte Stärke (nur für Matchmaking/Bots) – kein Rang, keine Anzeige
   const P = k => { const U = urRec(k); return { key: k, r: U.r, n: U.n }; }, bot = () => ({ key: null, r: L.botR, n: 0 });
   const { out } = rateTeams([...L.tm[0].map(P), ...Array.from({ length: L.nb[0] }, bot)], [...L.tm[1].map(P), ...Array.from({ length: L.nb[1] }, bot)], S0); mt.res = S0;
   for (const o of out) { if (!o.key) continue; const U = urRec(o.key), S = L.tm[0].includes(o.key) ? S0 : 1 - S0; U.r = o.after; U.n++; if (S === 1) U.w++; else if (S === 0) U.l++; else U.d++; if (mt.stats[o.key].left) U.ab++; U.h.unshift(L.id); U.h.length = Math.min(U.h.length, CFG.hist); }
  } else if (st === 'rated') {
   const P = k => { const M = rec(k).m[L.mode]; return { key: k, r: M.r, n: M.n, placing: M.pl < M.pq }; }, bot = () => ({ key: null, r: L.botR, n: 0 });
   const { E0, out } = rateTeams([...L.tm[0].map(P), ...Array.from({ length: L.nb[0] }, bot)], [...L.tm[1].map(P), ...Array.from({ length: L.nb[1] }, bot)], S0); mt.res = S0; mt.E0 = Math.round(E0 * 1000) / 1000; mt.ch = {};
   for (const o of out) {
    if (!o.key) continue; // Bot
    const M = rec(o.key).m[L.mode], S = L.tm[0].includes(o.key) ? S0 : 1 - S0;
    M.r = o.after; M.n++; M.pl++; if (S === 1) M.w++; else if (S === 0) M.l++; else M.d++; if (mt.stats[o.key].left) M.ab++;
    if (M.pl >= M.pq) M.peak = Math.max(M.peak, M.r); M.h.unshift(L.id); M.h.length = Math.min(M.h.length, CFG.hist); mt.ch[o.key] = [o.before, o.after];
   }
  }
  if (st === 'rated') {
   for (const k of L.keys) { const s = ks(k); if (!s) continue; const p = rec(k), A = (p.agg = p.agg || {})[L.mode] = (p.agg || {})[L.mode] || { n: 0, rd: 0, k: 0, d: 0, a: 0, hs: 0, dmg: 0, kast: 0, krd: 0 }; // Summen fürs Profil (genau einmal, da end() nur einmal läuft)
    A.n++; A.rd += rounds; A.k += s.k; A.d += s.d; A.a += s.a; A.hs += s.hs; A.dmg += (L.dmg || {})[k] || 0; if (TEAMMODE(L.mode)) { A.kast += s.kast; A.krd += s.rd; } }
  } else if (L.started && !QUICK(L.mode)) for (const k of L.keys) { const M = UR ? urRec(k) : rec(k).m[L.mode]; if (mt.stats[k].left) M.ab++; M.h.unshift(L.id); M.h.length = Math.min(M.h.length, CFG.hist); } // Abbruch/ungültig: in der Historie sichtbar, Rating unverändert
  persist();
  const r = roomOf(L), sb = sbView(mt); for (const cl of (r ? r.clients : [])) if (cl.acc) tx(cl, Object.assign({ type: 'rkdone' }, matchView(mt, cl.acc), { me: RK.p[cl.acc] && MODES.includes(L.mode) ? view(RK.p[cl.acc].m[L.mode]) : null, prev: mt.ch && mt.ch[cl.acc] ? rankOf(mt.ch[cl.acc][0]).name : null, sb, side: mt.tm[0].includes(cl.acc) ? 0 : 1 }));
 }
 function sbView(mt) { // Endbildschirm: nur vom Server geprüfte Werte; fehlt etwas → null (Anzeige „–“)
  const st = mt.stats || {}, nv = v => v === undefined ? null : v;
  const row = (k, side) => { const S = st[k] || {}, P = RK.p[k], M = P && P.m[mt.mode], c = mt.ch && mt.ch[k]; return Object.assign({ n: P ? P.n : k, side, k: nv(S.k), d: nv(S.d), a: nv(S.a), hs: nv(S.hs), adr: nv(S.adr), kast: S.rd ? Math.round(S.kast / S.rd * 100) : null, ch: c ? c[1] - c[0] : null, r: c ? c[1] : null, rank: c && M ? (M.pl >= M.pq ? rankOf(c[1]).name : 'Placement ' + Math.min(M.pl, M.pq) + '/' + M.pq) : null, left: !!S.left }, info(k)); };
  return { mode: mt.mode, map: mt.map, st: mt.st, dur: mt.t1 && mt.t ? Math.round((mt.t1 - mt.t) / 1000) : null, sc: mt.sc || null, res: mt.res === undefined ? null : mt.res, nb: mt.nb || [0, 0], rows: [...mt.tm[0].map(k => row(k, 0)), ...mt.tm[1].map(k => row(k, 1))] };
 }
 function newSeason(s) { RK.season = s; persist(); } // Soft-Reset passiert pro Spieler beim nächsten Zugriff (rec)
 function board(mode, key) { // Bestenliste der aktuellen Saison: nur platzierte Spieler
  if (!MODES.includes(mode)) mode = 'comp';
  const all = Object.entries(RK.p).filter(([, p]) => p.s === RK.season && p.m[mode] && p.m[mode].n && p.m[mode].pl >= p.m[mode].pq).map(([k, p]) => ({ k, n: p.n, r: p.m[mode].r, w: p.m[mode].w, l: p.m[mode].l })).sort((a, b) => b.r - a.r || b.w - a.w);
  const pos = all.findIndex(x => x.k === key);
  return { mode, season: RK.season, total: all.length, top: all.slice(0, 50).map(x => ({ n: x.n, r: x.r, rank: rankOf(x.r).name, w: x.w, l: x.l })), me: pos < 0 ? null : { pos: pos + 1, r: all[pos].r } };
 }
 return { init, queueMsg, wsClose, tick, join, joined: ws => ws.rk && joined(ws.rk), msg, leave, profile, pub, pinv: invsFor, board, newSeason, _: { Q, LIVE, BY, BAN, PT, end } };
}

module.exports = { CFG, MODES, QMODES, QUICK, seasonNow, fillMatches, units, split, expected, kFactor, rankOf, rateTeams, balance, pickMatches, softReset, winOf, createRanked };
