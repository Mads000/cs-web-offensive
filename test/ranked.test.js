// Ranked-Tests: node --test test/
const test = require('node:test'), assert = require('node:assert');
const R = require('../ranked');
const { CFG, expected, kFactor, rankOf, rateTeams, balance, pickMatches, softReset, createRanked } = R;

// ── Hilfen: Fake-WebSocket, Räume, Zeit ──
let T = 1e12; const realNow = Date.now; Date.now = () => T;
const fakeWs = (pid, acc) => ({ pid, acc, readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() { this.readyState = 3; }, last(t) { return [...this.sent].reverse().find(m => m.type === t); } });
function setup(n) {
 const RK = {}, rooms = new Map(), users = {}; let saves = 0;
 for (let i = 0; i < n; i++) users['t' + i] = { name: 'P' + i };
 const rk = createRanked({ RK, rooms, persist: () => saves++, auth: t => users[t] });
 return { RK, rooms, rk, saves: () => saves };
}
function queueAll(S, mode, n) {
 const qs = []; for (let i = 0; i < n; i++) { const q = fakeWs(null); S.rk.queueMsg(q, { type: 'rkq', tok: 't' + i, mode }); qs.push(q); }
 S.rk.tick(T); const f = qs[0].last('rkfound'); assert.ok(f, 'Match gefunden');
 qs.forEach(q => S.rk.queueMsg(q, { type: 'rkacc', id: f.id, ok: 1, map: 'de_frost' }));
 return { qs, go: qs.map(q => q.last('rkgo')) };
}
function enter(S, go, i) { // Spieler i betritt den Ranked-Raum (wie server.js)
 const ws = fakeWs('pid' + i, 'p' + i); assert.ok(S.rk.join(ws, go.room));
 if (!S.rooms.has(go.room)) S.rooms.set(go.room, { clients: [], hostPid: ws.pid });
 S.rooms.get(go.room).clients.push(ws); S.rk.joined(ws); return ws;
}
const send = (S, ws, m) => S.rk.msg(ws, S.rooms.get(ws.rk.room), m, JSON.stringify(m));

// ── Mathe & Ränge ──
test('Elo: Erwartung symmetrisch, 400 Punkte = 10:1', () => {
 assert.strictEqual(expected(1000, 1000), 0.5);
 assert.ok(Math.abs(expected(1400, 1000) + expected(1000, 1400) - 1) < 1e-12);
 assert.ok(Math.abs(expected(1400, 1000) - 10 / 11) < 1e-12);
});
test('K-Faktor: Stützpunkte 40/24/16, dazwischen linear, Placement = 40', () => {
 assert.strictEqual(kFactor(0), 40); assert.strictEqual(kFactor(10), 24); assert.strictEqual(kFactor(50), 16); assert.strictEqual(kFactor(500), 16);
 assert.strictEqual(kFactor(5), 32); assert.strictEqual(kFactor(30), 20); assert.strictEqual(kFactor(60, true), 40);
 CFG.kSmooth = false; assert.strictEqual(kFactor(9), 40); assert.strictEqual(kFactor(49), 24); CFG.kSmooth = true;
});
test('Ränge: 10 Stück, lückenlos, Start-Rating mitten in Challenger II', () => {
 assert.strictEqual(CFG.ranks.length, 10);
 for (let r = 0; r <= 2500; r++) { const k = rankOf(r); assert.ok(k.prog >= 0 && k.prog <= 1); if (k.hi !== null) assert.ok(r < k.hi); if (k.lo !== null) assert.ok(r >= k.lo); }
 assert.strictEqual(rankOf(649).name, 'Recruit'); assert.strictEqual(rankOf(650).name, 'Contender I'); assert.strictEqual(rankOf(1499).name, 'Master II'); assert.strictEqual(rankOf(1500).name, 'CLUTCH Elite');
 const s = rankOf(CFG.start); assert.strictEqual(s.name, 'Challenger II'); assert.strictEqual(s.prog, 0.5);
});
test('Team-Rating: beide Seiten spiegelbildlich, Favorit gewinnt weniger', () => {
 const p = (key, r) => ({ key, r, n: 60 });
 const a = rateTeams([p('a', 1200), p('b', 1200)], [p('c', 1000), p('d', 1000)], 1);
 const d = Object.fromEntries(a.out.map(o => [o.key, o.d])); assert.strictEqual(d.a, -d.c); assert.ok(d.a > 0 && d.a < 8);
 const u = rateTeams([p('a', 1200)], [p('c', 1000)], 0); assert.ok(u.out[0].d < -8); // Favorit verliert → großer Abzug
 const draw = rateTeams([p('a', 1000)], [p('c', 1000)], 0.5); assert.strictEqual(draw.out[0].d, 0);
});
test('Balancing & Matchmaking-Fenster', () => {
 const [A, B] = balance([1400, 1000, 1000, 600].map((r, i) => ({ key: 'k' + i, r })));
 assert.strictEqual(A.reduce((s, p) => s + p.r, 0), B.reduce((s, p) => s + p.r, 0));
 const q = [{ key: 'a', r: 1000, t: 0 }, { key: 'b', r: 1500, t: 0 }];
 assert.strictEqual(pickMatches(q, 1, 0).length, 0); assert.strictEqual(pickMatches(q, 1, 60000).length, 1); // nach ~50 s Fenster weit genug
 assert.strictEqual(softReset(1400), 1200); assert.strictEqual(softReset(800), 900);
});

// ── Abläufe ──
test('1v1: Warteschlange → Annehmen → Raum → 5 Duelle → einmalige Wertung', () => {
 const S = setup(2), { go } = queueAll(S, 'v1', 2);
 assert.ok(go[0] && go[1] && go[0].room === go[1].room && go[0].room.startsWith('rk_'));
 // Fremde & Gäste kommen nicht in den Raum
 const intr = fakeWs('x', 'fremd'); assert.strictEqual(S.rk.join(intr, go[0].room), false); assert.ok(intr.last('rkdeny'));
 const a = enter(S, go[0], 0), b = enter(S, go[1], 1); assert.strictEqual(a.last('rkst').n, 2);
 send(S, a, { type: 'glstart', v1: 1, bots: [], teams: [{ id: 0, members: [{ p: 'pid0' }] }, { id: 1, members: [{ p: 'pid1' }] }] });
 assert.strictEqual(send(S, b, { type: 'glend', w: 1, l: 0 }), false, 'Nicht-Host darf keine Ergebnisse senden');
 for (let i = 0; i < 5; i++) { T += 6000; send(S, b, { type: 'st', al: false, h: 0 }); send(S, a, { type: 'glend', w: 0, l: 1 }); }
 T += 1000; send(S, a, { type: 'glover', w: 0 });
 const mt = S.RK.mt[go[0].id]; assert.strictEqual(mt.st, 'rated'); assert.deepStrictEqual(mt.sc, [5, 0]);
 assert.strictEqual(S.RK.p.p0.m.v1.r, 1020); assert.strictEqual(S.RK.p.p1.m.v1.r, 980);
 assert.strictEqual(S.RK.p.p0.m.comp.r, 1000, '5v5-Rating bleibt unberührt');
 assert.strictEqual(a.last('rkdone').d, 20); assert.strictEqual(b.last('rkdone').d, -20);
 send(S, a, { type: 'glover', w: 0 }); S.rk._.end(a.rk, 'rated', null, 1); // doppelt melden
 assert.strictEqual(S.RK.p.p0.m.v1.r, 1020); assert.strictEqual(S.RK.p.p0.m.v1.n, 1);
 // Profil
 const pr = S.rk.profile({ name: 'P0' }); assert.strictEqual(pr.m.v1.placed, false); assert.strictEqual(pr.m.v1.hist[0].d, 20); assert.strictEqual(pr.m.v1.hist[0].res, 1);
});
test('1v1: Host meldet Sieg, obwohl der Gegner laut eigenem Status lebt → ungültig', () => {
 const S = setup(2), { go } = queueAll(S, 'v1', 2), a = enter(S, go[0], 0), b = enter(S, go[1], 1);
 send(S, a, { type: 'glstart', v1: 1, bots: [], teams: [{ id: 0, members: [{ p: 'pid0' }] }, { id: 1, members: [{ p: 'pid1' }] }] });
 T += 6000; send(S, a, { type: 'st', al: true, h: 20 }); send(S, b, { type: 'st', al: true, h: 100 }); send(S, a, { type: 'glend', w: 0, l: 1 });
 assert.strictEqual(S.RK.mt[go[0].id].st, 'invalid'); assert.strictEqual(S.RK.p.p0.m.v1.r, 1000);
});
test('5v5 (2v2 im Test): Regeln, Bots und Rundenzählung werden geprüft', () => {
 CFG.team.comp = 2;
 // falsche Regeln → ungültig
 let S = setup(4), r = queueAll(S, 'comp', 4); assert.strictEqual(r.go[0].map, 'de_frost', 'Mehrheit der Map-Stimmen');
 let ws = r.go.map((g, i) => enter(S, g, i)); send(S, ws[0], { type: 'start', map: 'de_frost', cfg: Object.assign({}, CFG.rules, { rounds: 3 }) });
 assert.strictEqual(S.RK.mt[r.go[0].id].st, 'invalid');
 // gültiges Match 8:3
 S = setup(4); r = queueAll(S, 'comp', 4); ws = r.go.map((g, i) => enter(S, g, i));
 const host = ws[0], hostTeam = r.go[0].team;
 send(S, host, { type: 'start', map: r.go[0].map, cfg: CFG.rules }); send(S, host, { type: 'roster', bots: [] });
 assert.strictEqual(send(S, ws[1], { type: 'team', team: 'T' }), false, 'Teamwechsel blockiert');
 assert.strictEqual(JSON.parse(send(S, ws[1], { type: 'hello', team: 'XX' })).team, r.go[1].team, 'Team vom Server');
 const other = hostTeam === 'CT' ? 'T' : 'CT';
 for (let i = 0; i < 11; i++) { T += 9000; send(S, host, { type: 'end', w: i < 3 ? other : hostTeam }); }
 T += 1000; send(S, host, { type: 'over', sc: { [hostTeam]: 8, [other]: 3 } });
 const mt = S.RK.mt[r.go[0].id]; assert.strictEqual(mt.st, 'rated');
 const win = mt.tm[hostTeam === 'CT' ? 0 : 1], lose = mt.tm[hostTeam === 'CT' ? 1 : 0];
 for (const k of win) assert.ok(mt.ch[k][1] > mt.ch[k][0]); for (const k of lose) assert.ok(mt.ch[k][1] < mt.ch[k][0]);
 // zu schnelle Runden → ungültig
 S = setup(4); r = queueAll(S, 'comp', 4); ws = r.go.map((g, i) => enter(S, g, i));
 send(S, ws[0], { type: 'start', map: r.go[0].map, cfg: CFG.rules }); T += 9000; send(S, ws[0], { type: 'end', w: 'CT' }); T += 500; send(S, ws[0], { type: 'end', w: 'CT' });
 assert.strictEqual(S.RK.mt[r.go[0].id].st, 'invalid');
 CFG.team.comp = 5;
});
test('Annehmen: Ablehnung → Annehmende suchen weiter, keine Doppel-Warteschlange', () => {
 const S = setup(3), a = fakeWs(), b = fakeWs(), a2 = fakeWs();
 S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'v1' }); S.rk.queueMsg(a2, { type: 'rkq', tok: 't0', mode: 'v1' });
 assert.match(a2.last('rkoff').why, /anderen Fenster/);
 S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'v1' }); S.rk.tick(T); const f = a.last('rkfound');
 S.rk.queueMsg(a, { type: 'rkacc', id: f.id, ok: 1 }); S.rk.queueMsg(b, { type: 'rkacc', id: f.id, ok: 0 });
 assert.ok(S.rk._.Q.has('p0') && !S.rk._.Q.has('p1')); assert.ok(a.last('rkback'));
 // Timeout beim Annehmen
 S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'v1' }); S.rk.tick(T); T += (CFG.acceptSec + 1) * 1000; S.rk.tick(T);
 assert.strictEqual(S.rk._.LIVE.size, 0); assert.ok(!S.rk._.Q.has('p0') && !S.rk._.Q.has('p1'));
});
test('Disconnect: ganzes Team weg → abgebrochen, keine Ratingänderung; Wiederverbinden ersetzt alte Verbindung', () => {
 const S = setup(2), { go } = queueAll(S, 'v1', 2), a = enter(S, go[0], 0), b = enter(S, go[1], 1), room = S.rooms.get(go[0].room);
 const b2 = enter(S, go[1], 1); assert.strictEqual(b.readyState, 3); assert.strictEqual(room.clients.filter(c => c.acc === 'p1').length, 1);
 assert.ok(S.rk.profile({ name: 'P1' }).live, 'Profil bietet Wiederverbinden an');
 send(S, a, { type: 'glstart', v1: 1, bots: [], teams: [{ id: 0, members: [{ p: 'pid0' }] }, { id: 1, members: [{ p: 'pid1' }] }] });
 b2.readyState = 3; room.clients.splice(room.clients.indexOf(b2), 1);
 S.rk.tick(T); T += (CFG.abandonSec + 1) * 1000; S.rk.tick(T);
 const mt = S.RK.mt[go[0].id]; assert.strictEqual(mt.st, 'aborted'); assert.ok(mt.stats.p1.left); assert.strictEqual(S.RK.p.p0.m.v1.r, 1000);
});
const v1Start = (S, a) => send(S, a, { type: 'glstart', v1: 1, bots: [], teams: [{ id: 0, members: [{ p: 'pid0' }] }, { id: 1, members: [{ p: 'pid1' }] }] });
const drop = (S, ws) => { const room = S.rooms.get(ws.rk.room); ws.readyState = 3; room.clients.splice(room.clients.indexOf(ws), 1); S.rk.leave(ws); };
test('1v1-Rage-Quit: vor dem ersten Duell → abgebrochen; danach → Niederlage für den Verlassenden', () => {
 let S = setup(2), r = queueAll(S, 'v1', 2), a = enter(S, r.go[0], 0), b = enter(S, r.go[1], 1);
 v1Start(S, a); drop(S, b);
 assert.strictEqual(S.RK.mt[r.go[0].id].st, 'aborted'); assert.strictEqual(S.RK.p.p1.m.v1.r, 1000); assert.strictEqual(S.RK.p.p1.m.v1.ab, 1); assert.strictEqual(S.RK.p.p0.m.v1.ab, 0);
 S = setup(2); r = queueAll(S, 'v1', 2); a = enter(S, r.go[0], 0); b = enter(S, r.go[1], 1);
 v1Start(S, a); T += 6000; send(S, a, { type: 'st', al: false, h: 0 }); send(S, a, { type: 'glend', w: 1, l: 0 }); // Duell 1 an B
 drop(S, b); // B führt 1:0 und geht trotzdem → B verliert
 const mt = S.RK.mt[r.go[0].id]; assert.strictEqual(mt.st, 'rated'); assert.match(mt.why, /Niederlage/);
 assert.strictEqual(S.RK.p.p1.m.v1.r, 980); assert.strictEqual(S.RK.p.p0.m.v1.r, 1020); assert.strictEqual(S.RK.p.p1.m.v1.ab, 1);
 assert.strictEqual(a.last('rkdone').d, 20);
});
test('Suchsperre: 1. Ablehnen frei, dann 1/2/5 Min, nie über 5 Min, Fenster 30 Min', () => {
 const S = setup(2), a = fakeWs(), b = fakeWs(), bans = [];
 for (let i = 0; i < 5; i++) {
  T = (S.rk._.BAN.get('p1') || T) + 1000; // nach Ablauf einer Sperre erneut suchen
  S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'v1' }); S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'v1' }); S.rk.tick(T);
  const f = b.last('rkfound'); S.rk.queueMsg(b, { type: 'rkacc', id: f.id, ok: 0 }); b.sent = [];
  bans.push(Math.round(((S.rk._.BAN.get('p1') || 0) - T) / 1000)); S.rk.queueMsg(a, { type: 'rkx' });
 }
 assert.deepStrictEqual(bans.map(x => Math.max(0, x)), [0, 60, 120, 300, 300]);
 S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'v1' }); assert.ok(b.last('rkoff').ban, 'gesperrt → keine Suche');
 assert.ok(!S.rk._.BAN.has('p0'), 'wer annimmt, wird nicht gesperrt');
 T += 31 * 60000; S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'v1' }); S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'v1' }); S.rk.tick(T);
 S.rk.queueMsg(b, { type: 'rkacc', id: b.last('rkfound').id, ok: 0 }); assert.ok(!(S.rk._.BAN.get('p1') > T), 'nach 30 Min wieder „frei“');
});
test('2v2: eigener Modus & Rating, Map-Bann, Team verlässt → Niederlage', () => {
 const S = setup(4), r = queueAll(S, 'duo', 4); // alle stimmen de_frost
 assert.strictEqual(r.go[0].map, 'de_frost'); assert.strictEqual(r.go[0].n, 4);
 const ws = r.go.map((g, i) => enter(S, g, i)), host = ws[0], ht = r.go[0].team;
 send(S, host, { type: 'start', map: r.go[0].map, cfg: CFG.rules });
 const mine = ws.filter((w, i) => r.go[i].team === ht), opp = ws.filter((w, i) => r.go[i].team !== ht);
 send(S, mine[1], { type: 'dmg', to: opp[0].pid, d: 999 }); // Treffer → ADR-Statistik (gedeckelt)
 T += 9000; send(S, host, { type: 'end', w: ht }); // 1:0
 opp.forEach(w => drop(S, w)); S.rk.tick(T); T += (CFG.abandonSec + 1) * 1000; S.rk.tick(T);
 const mt = S.RK.mt[r.go[0].id]; assert.strictEqual(mt.st, 'rated'); assert.strictEqual(mt.mode, 'duo');
 for (const k of mt.tm[ht === 'CT' ? 0 : 1]) assert.ok(S.RK.p[k].m.duo.r > 1000);
 assert.strictEqual(S.RK.p.p0.m.comp.r, 1000); assert.strictEqual(mt.stats[mine[1].acc].adr, CFG.hitCap);
 // Map-Bann: alle bannen de_frost und stimmen für nichts → nie de_frost
 for (let i = 0; i < 20; i++) { const S2 = setup(4), qs = [0, 1, 2, 3].map(j => { const q = fakeWs(); S2.rk.queueMsg(q, { type: 'rkq', tok: 't' + j, mode: 'duo' }); return q; }); S2.rk.tick(T); const id = qs[0].last('rkfound').id; qs.forEach(q => S2.rk.queueMsg(q, { type: 'rkacc', id, ok: 1, ban: 'de_frost' })); assert.notStrictEqual(qs[0].last('rkgo').map, 'de_frost'); }
});
test('Bot-Auffüllen: erst nach 30 s, Bot-Zahl wird geprüft, Bots zählen zur Teamstärke, bekommen kein Rating', () => {
 let S = setup(2); const a = fakeWs(), b = fakeWs();
 S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'duo' }); S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'duo' });
 S.rk.tick(T + 29000); assert.ok(!a.last('rkfound'), 'vor 30 s nur Menschen');
 S.rk.tick(T + 31000); const f = a.last('rkfound'); assert.ok(f); assert.strictEqual(f.bots, 2); assert.strictEqual(f.blv, 5, 'Rating 1000 → Stufe 5');
 [a, b].forEach(q => S.rk.queueMsg(q, { type: 'rkacc', id: f.id, ok: 1 })); const go = [a.last('rkgo'), b.last('rkgo')];
 assert.deepStrictEqual(go[0].nb, [1, 1], 'je Team 1 Mensch + 1 Bot'); assert.strictEqual(go[0].rules.bots, 1); assert.strictEqual(go[0].rules.teamSize, 2);
 assert.notStrictEqual(go[0].team, go[1].team);
 let ws = go.map((g, i) => enter(S, g, i)), host = ws[0];
 send(S, host, { type: 'start', map: go[0].map, cfg: go[0].rules });
 send(S, host, { type: 'roster', bots: [{ n: 'Bot1', t: 'CT' }, { n: 'Bot2', t: 'T' }] }); assert.strictEqual(S.RK.mt[go[0].id].st, 'live');
 const ht = go[0].team; for (let i = 0; i < 8; i++) { T += 9000; send(S, host, { type: 'end', w: ht }); } send(S, host, { type: 'over', sc: { [ht]: 8, [ht === 'CT' ? 'T' : 'CT']: 0 } });
 const mt = S.RK.mt[go[0].id]; assert.strictEqual(mt.st, 'rated'); assert.strictEqual(Object.keys(mt.ch).length, 2, 'nur Menschen haben Ratingänderungen');
 assert.strictEqual(S.RK.p.p0.m.duo.r, 1020); assert.strictEqual(S.RK.p.p1.m.duo.r, 980);
 assert.ok(S.rk.profile({ name: 'P0' }).m.duo.hist[0].opp.includes('Bot ×1'));
 // Host setzt zusätzliche Bots ein → ungültig
 S = setup(1); const c = fakeWs(); S.rk.queueMsg(c, { type: 'rkq', tok: 't0', mode: 'duo' }); T += 31000; S.rk.tick(T);
 S.rk.queueMsg(c, { type: 'rkacc', id: c.last('rkfound').id, ok: 1 }); const g = c.last('rkgo'); assert.deepStrictEqual(g.nb, [1, 2]);
 const h = enter(S, g, 0); send(S, h, { type: 'start', map: g.map, cfg: g.rules }); send(S, h, { type: 'roster', bots: [{ t: 'CT' }, { t: 'T' }] });
 assert.strictEqual(S.RK.mt[g.id].st, 'invalid');
 // 1v1 wird nicht aufgefüllt
 S = setup(1); const d = fakeWs(); S.rk.queueMsg(d, { type: 'rkq', tok: 't0', mode: 'v1' }); T += 120000; S.rk.tick(T); assert.ok(!d.last('rkfound'));
});
test('Bestenliste & automatische Saison', () => {
 const S = setup(2);
 for (let m = 0; m < 5; m++) { const r = queueAll(S, 'v1', 2), a = enter(S, r.go[0], 0), b = enter(S, r.go[1], 1); v1Start(S, a); for (let i = 0; i < 5; i++) { T += 6000; send(S, b, { type: 'st', al: false, h: 0 }); send(S, a, { type: 'glend', w: 0, l: 1 }); } send(S, a, { type: 'glover', w: 0 }); }
 const lb = S.rk.board('v1', 'p1'); assert.strictEqual(lb.total, 2); assert.strictEqual(lb.top[0].n, 'P0'); assert.ok(lb.top[0].r > lb.top[1].r); assert.strictEqual(lb.me.pos, 2);
 assert.strictEqual(S.rk.board('comp').total, 0, 'ohne Placement nicht gelistet');
 const old = CFG.seasonStart; CFG.seasonStart = '2026-01-01';
 assert.strictEqual(R.seasonNow(Date.UTC(2026, 0, 5)), 1); assert.strictEqual(R.seasonNow(Date.UTC(2026, 3, 1)), 2); assert.strictEqual(R.seasonNow(Date.UTC(2027, 0, 1)), 5);
 CFG.seasonStart = old;
});
test('Saison: Soft-Reset behält Historie, neue Placements', () => {
 const S = setup(2), { go } = queueAll(S, 'v1', 2), a = enter(S, go[0], 0), b = enter(S, go[1], 1);
 send(S, a, { type: 'glstart', v1: 1, bots: [], teams: [{ id: 0, members: [{ p: 'pid0' }] }, { id: 1, members: [{ p: 'pid1' }] }] });
 for (let i = 0; i < 5; i++) { T += 6000; send(S, b, { type: 'st', al: false, h: 0 }); send(S, a, { type: 'glend', w: 0, l: 1 }); } send(S, a, { type: 'glover', w: 0 });
 S.rk.newSeason(2); const p = S.rk.profile({ name: 'P0' });
 assert.strictEqual(p.season, 2); assert.strictEqual(p.m.v1.r, 1010); assert.strictEqual(p.m.v1.pq, CFG.placementsReturn); assert.strictEqual(p.past[0].r, 1020); assert.strictEqual(p.m.v1.hist.length, 1);
});

// ── Echter Server: Registrieren, Warteschlange per WebSocket, Raum-Zugang ──
test('Server-Integration (HTTP + WebSocket)', { timeout: 20000 }, async () => {
 Date.now = realNow;
 const { spawn } = require('child_process'), path = require('path'), os = require('os'), fs = require('fs'), WebSocket = require('ws');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-')), port = 18000 + Math.floor(Math.random() * 2000);
 const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: port, DATA_DIR: dir, GIST_ID: '', GIST_TOKEN: '' }), stdio: 'pipe' });
 try {
  await new Promise((ok, no) => { srv.stdout.on('data', d => /läuft/.test(d) && ok()); srv.on('exit', no); });
  const api = (p, b) => fetch(`http://localhost:${port}/api/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  const A = await api('register', { u: 'rkTestA', p: 'pass1' }), B = await api('register', { u: 'rkTestB', p: 'pass2' });
  const pr = await api('ranked', { tok: A.tok }); assert.strictEqual(pr.m.comp.r, 1000); assert.strictEqual(pr.m.v1.rank.name, 'Challenger II');
  const open = () => new Promise(ok => { const w = new WebSocket(`ws://localhost:${port}`); w.msgs = []; w.on('message', d => w.msgs.push(JSON.parse(d))); w.on('open', () => ok(w)); });
  const wait = (w, t) => new Promise((ok, no) => { const to = setTimeout(() => no(new Error('Timeout ' + t)), 8000), f = () => { const m = w.msgs.find(x => x.type === t); if (m) { clearTimeout(to); ok(m); } else setTimeout(f, 30); }; f(); });
  const qa = await open(), qb = await open();
  qa.send(JSON.stringify({ type: 'rkq', tok: A.tok, mode: 'v1' })); qb.send(JSON.stringify({ type: 'rkq', tok: B.tok, mode: 'v1' }));
  const f = await wait(qa, 'rkfound'); qa.send(JSON.stringify({ type: 'rkacc', id: f.id, ok: 1 })); qb.send(JSON.stringify({ type: 'rkacc', id: f.id, ok: 1 }));
  const g = await wait(qa, 'rkgo'); assert.match(g.room, /^rk_/);
  const ra = await open(); ra.send(JSON.stringify({ type: 'join', room: g.room, pid: 'aa', acc: A.tok })); await wait(ra, 'joined');
  const guest = await open(); guest.send(JSON.stringify({ type: 'join', room: g.room, pid: 'gg' })); await wait(guest, 'rkdeny');
  const lst = await open(); lst.send(JSON.stringify({ type: 'rooms' })); assert.ok(!(await wait(lst, 'rooms')).rooms.some(r => r.name.startsWith('rk_')), 'Ranked-Räume nicht öffentlich');
  [qa, qb, ra, guest, lst].forEach(w => w.close());
 } finally { srv.kill(); }
});
