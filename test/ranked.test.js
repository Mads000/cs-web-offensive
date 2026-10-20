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
 // gültiges Match 5:3 (zuerst 5 Siege)
 S = setup(4); r = queueAll(S, 'comp', 4); ws = r.go.map((g, i) => enter(S, g, i));
 const host = ws[0], hostTeam = r.go[0].team;
 send(S, host, { type: 'start', map: r.go[0].map, cfg: r.go[0].rules }); send(S, host, { type: 'roster', bots: [] });
 assert.strictEqual(send(S, ws[1], { type: 'team', team: 'T' }), false, 'Teamwechsel blockiert');
 assert.strictEqual(JSON.parse(send(S, ws[1], { type: 'hello', team: 'XX' })).team, r.go[1].team, 'Team vom Server');
 const other = hostTeam === 'CT' ? 'T' : 'CT';
 for (let i = 0; i < 8; i++) { T += 9000; send(S, host, { type: 'end', w: i < 3 ? other : hostTeam }); }
 T += 1000; send(S, host, { type: 'over', sc: { [hostTeam]: 5, [other]: 3 } });
 const mt = S.RK.mt[r.go[0].id]; assert.strictEqual(mt.st, 'rated');
 const win = mt.tm[hostTeam === 'CT' ? 0 : 1], lose = mt.tm[hostTeam === 'CT' ? 1 : 0];
 for (const k of win) assert.ok(mt.ch[k][1] > mt.ch[k][0]); for (const k of lose) assert.ok(mt.ch[k][1] < mt.ch[k][0]);
 // zu schnelle Runden → ungültig
 S = setup(4); r = queueAll(S, 'comp', 4); ws = r.go.map((g, i) => enter(S, g, i));
 send(S, ws[0], { type: 'start', map: r.go[0].map, cfg: r.go[0].rules }); T += 9000; send(S, ws[0], { type: 'end', w: 'CT' }); T += 500; send(S, ws[0], { type: 'end', w: 'CT' });
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
 send(S, host, { type: 'start', map: r.go[0].map, cfg: r.go[0].rules });
 const mine = ws.filter((w, i) => r.go[i].team === ht), opp = ws.filter((w, i) => r.go[i].team !== ht);
 send(S, mine[1], { type: 'dmg', to: opp[0].pid, d: 999 }); // Treffer → ADR-Statistik (gedeckelt)
 send(S, host, { type: 'hdmg', d: 60 }); send(S, opp[0], { type: 'botdmg', id: 3, from: opp[1].pid, d: 50 }); // Schaden an Bots zählt (fremde pid nicht)
 T += 9000; send(S, host, { type: 'end', w: ht }); // 1:0
 opp.forEach(w => drop(S, w)); S.rk.tick(T); T += (CFG.abandonSec + 1) * 1000; S.rk.tick(T);
 const mt = S.RK.mt[r.go[0].id]; assert.strictEqual(mt.st, 'rated'); assert.strictEqual(mt.mode, 'duo');
 for (const k of mt.tm[ht === 'CT' ? 0 : 1]) assert.ok(S.RK.p[k].m.duo.r > 1000);
 assert.strictEqual(S.RK.p.p0.m.comp.r, 1000); assert.strictEqual(mt.stats[mine[1].acc].adr, CFG.hitCap); assert.strictEqual(mt.stats[host.acc].adr, 60); assert.strictEqual(mt.stats[opp[0].acc].adr, 0);
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

// ── Gruppen, Statistik, Map-Pool ──
function setupP(n, o = {}) { // wie setup, aber mit Freunden & Accountsuche
 const RK = {}, rooms = new Map(), users = {}; for (let i = 0; i < n; i++) users['t' + i] = { name: 'P' + i };
 const rk = createRanked(Object.assign({ RK, rooms, persist: () => { }, auth: t => users[t], user: nm => Object.values(users).find(u => u.name.toLowerCase() === nm.toLowerCase()) || null, friends: () => true }, o));
 return { RK, rooms, rk };
}
test('Gruppe: Einladung, Beitritt, nur Leiter sucht, Gruppe landet im selben Team', () => {
 const S = setupP(4), w = [0, 1, 2, 3].map(() => fakeWs()); w.forEach((x, i) => S.rk.queueMsg(x, { type: 'rkhi', tok: 't' + i }));
 S.rk.queueMsg(w[0], { type: 'rkpinv', n: 'p1' }); const inv = w[1].last('rkpinv').inv[0]; assert.strictEqual(inv.from, 'P0');
 S.rk.queueMsg(w[1], { type: 'rkpjoin', id: inv.id }); assert.strictEqual(w[0].last('rkpst').pt.mem.length, 2); assert.strictEqual(w[1].last('rkpst').pt.lead, 'P0');
 S.rk.queueMsg(w[1], { type: 'rkq', tok: 't1', mode: 'duo' }); assert.match(w[1].last('rkoff').why, /Gruppenleiter/);
 S.rk.queueMsg(w[0], { type: 'rkq', tok: 't0', mode: 'v1' }); assert.match(w[0].last('rkoff').why, /zu groß/);
 S.rk.queueMsg(w[0], { type: 'rkq', tok: 't0', mode: 'duo' }); assert.ok(S.rk._.Q.has('p0') && S.rk._.Q.has('p1'), 'ganze Gruppe sucht');
 S.rk.queueMsg(w[0], { type: 'rkpinv', n: 'p2' }); assert.match(w[0].last('rkperr').why, /Suche/, 'keine Einladung während der Suche');
 S.rk.queueMsg(w[2], { type: 'rkq', tok: 't2', mode: 'duo' }); S.rk.queueMsg(w[3], { type: 'rkq', tok: 't3', mode: 'duo' }); S.rk.tick(T);
 const f = w[0].last('rkfound'); assert.ok(f && w[1].last('rkfound') && w[1].last('rkfound').id === f.id); const L = S.rk._.LIVE.get(f.id);
 assert.ok(L.tm.some(t => t.includes('p0') && t.includes('p1')), 'Gruppe zusammen in einem Team');
 // Gruppenmitglied lehnt ab → ganze Gruppe raus, die anderen suchen weiter
 [0, 2, 3].forEach(i => S.rk.queueMsg(w[i], { type: 'rkacc', id: f.id, ok: 1 })); S.rk.queueMsg(w[1], { type: 'rkacc', id: f.id, ok: 0 });
 assert.ok(!S.rk._.Q.has('p0') && !S.rk._.Q.has('p1') && S.rk._.Q.has('p2') && S.rk._.Q.has('p3')); assert.match(w[0].last('rkoff').why, /Gruppenmitglied/);
 // Abbrechen durch Mitglied beendet die Suche für alle; Verbindung weg → nach 120 s raus aus der Gruppe
 S.rk.queueMsg(w[0], { type: 'rkq', tok: 't0', mode: 'duo' }); S.rk.queueMsg(w[1], { type: 'rkx' }); assert.ok(!S.rk._.Q.has('p0') && !S.rk._.Q.has('p1'));
 S.rk.queueMsg(w[2], { type: 'rkx' }); S.rk.queueMsg(w[3], { type: 'rkx' });
 w[1].readyState = 3; S.rk.wsClose(w[1]); S.rk.tick(T); assert.strictEqual(S.rk._.PT.size, 1); T += (CFG.party.offSec + 1) * 1000; S.rk.tick(T);
 assert.strictEqual(S.rk._.PT.size, 0, 'nur noch Leiter → Gruppe aufgelöst'); assert.strictEqual(w[0].last('rkpst').pt, null);
 // Kick & Verlassen
 S.rk.queueMsg(w[2], { type: 'rkpinv', n: 'P3' }); S.rk.queueMsg(w[3], { type: 'rkpjoin', id: w[3].last('rkpinv').inv[0].id });
 S.rk.queueMsg(w[3], { type: 'rkpkick', n: 'p2' }); assert.match(w[3].last('rkperr').why, /Gruppenleiter/);
 S.rk.queueMsg(w[2], { type: 'rkpkick', n: 'p3' }); assert.strictEqual(S.rk._.PT.size, 0); assert.match(w[3].last('rkpst').why, /entfernt/);
});
test('Matchmaking: Gruppen werden nie getrennt', () => {
 const q = (key, pt, pn, r = 1000) => ({ key, r, t: 0, pt, pn });
 const out = pickMatches([q('a', 'X', 2), q('b', 'X', 2), q('c', 'Y', 2), q('d', 'Y', 2)], 2, 0); assert.strictEqual(out.length, 1);
 assert.deepStrictEqual(out[0].map(t => t.map(p => p.key).sort()), [['a', 'b'], ['c', 'd']]);
 assert.strictEqual(pickMatches([q('a', 'X', 2), q('c', 'Y', 2), q('d', 'Y', 2)], 2, 0).length, 0, 'unvollständige Gruppe wartet');
 assert.strictEqual(pickMatches([q('a', 'X', 3), q('b', 'X', 3), q('c', 'X', 3), q('d'), q('e'), q('f')], 2, 0).length, 0, 'Gruppe größer als Team');
});
test('Statistik: Kills, Assists, HS, KAST & Trades werden vom Server gezählt und ins Profil übernommen', () => {
 CFG.team.comp = 2; const S = setup(4), r = queueAll(S, 'comp', 4), ws = r.go.map((g, i) => enter(S, g, i)), host = ws[0], hT = r.go[0].team, oT = hT === 'CT' ? 'T' : 'CT';
 const A = ws.filter((_, i) => r.go[i].team === hT), B = ws.filter((_, i) => r.go[i].team !== hT);
 send(S, host, { type: 'start', map: r.go[0].map, cfg: r.go[0].rules }); send(S, host, { type: 'roster', bots: [] });
 T += 9000; send(S, A[0], { type: 'dmg', to: B[0].pid, d: 40 });
 send(S, B[0], { type: 'kf', ap: A[1].pid, hs: true }); send(S, B[0], { type: 'kf', ap: A[1].pid, hs: true }); // doppelt → zählt einmal
 T += 6000; send(S, A[1], { type: 'kf', ap: B[1].pid }); T += 2000; send(S, B[1], { type: 'kf', ap: A[0].pid }); // A1 wird von A0 getradet, B0 nicht (> 5 s)
 send(S, host, { type: 'end', w: hT }); for (let i = 0; i < 4; i++) { T += 9000; send(S, host, { type: 'end', w: hT }); }
 T += 1000; send(S, host, { type: 'over', sc: { [hT]: 5, [oT]: 0 } });
 const mt = S.RK.mt[r.go[0].id], st = k => mt.stats[k.acc]; assert.strictEqual(mt.st, 'rated');
 assert.deepStrictEqual([st(A[1]).k, st(A[1]).d, st(A[1]).hs, st(A[1]).kast], [1, 1, 1, 5]); assert.deepStrictEqual([st(A[0]).k, st(A[0]).a, st(A[0]).d], [1, 1, 0]);
 assert.deepStrictEqual([st(B[0]).k, st(B[0]).d, st(B[0]).kast, st(B[0]).rd], [0, 1, 4, 5]);
 const sb = host.last('rkdone').sb; assert.strictEqual(sb.rows.length, 4); assert.ok(sb.rows.every(x => typeof x.ch === 'number')); assert.strictEqual(sb.rows.find(x => x.n.toLowerCase() === B[0].acc).kast, 80);
 const pr = S.rk.pub(A[1].acc).m.comp.st; assert.deepStrictEqual([pr.n, pr.kd, pr.hs, pr.kast], [1, 1, 100, 100]); assert.strictEqual(S.rk.pub('niemand').m.comp, undefined);
 CFG.team.comp = 5;
});
test('Map-Pool: offizielle Community-Map, Kartendaten vom Server, Host muss genau diese spielen', () => {
 CFG.team.comp = 2; const g = Array(28).fill('#'.repeat(28)), mk = () => setupP(4, { maps: () => ['pub_x'], mapData: k => k === 'pub_x' ? { n: 'X-Map', g } : null });
 let S = mk(), ws = [0, 1, 2, 3].map(() => fakeWs()); ws.forEach((x, i) => S.rk.queueMsg(x, { type: 'rkq', tok: 't' + i, mode: 'comp' })); S.rk.tick(T);
 let f = ws[0].last('rkfound'); assert.ok(f.maps.includes('pub_x')); assert.strictEqual(f.names.pub_x, 'X-Map');
 ws.forEach(x => S.rk.queueMsg(x, { type: 'rkacc', id: f.id, ok: 1, map: 'pub_x' })); let go = ws.map(x => x.last('rkgo')); assert.strictEqual(go[0].map, 'pub_x'); assert.strictEqual(go[0].cmap.g.length, 28);
 let c = go.map((x, i) => enter(S, x, i)); send(S, c[0], { type: 'start', map: 'pub_x', cfg: go[0].rules }); assert.strictEqual(S.RK.mt[go[0].id].st, 'invalid', 'ohne Kartendaten');
 S = mk(); ws = [0, 1, 2, 3].map(() => fakeWs()); ws.forEach((x, i) => S.rk.queueMsg(x, { type: 'rkq', tok: 't' + i, mode: 'comp' })); S.rk.tick(T); f = ws[0].last('rkfound');
 ws.forEach(x => S.rk.queueMsg(x, { type: 'rkacc', id: f.id, ok: 1, map: 'pub_x' })); go = ws.map(x => x.last('rkgo')); c = go.map((x, i) => enter(S, x, i));
 send(S, c[0], { type: 'start', map: 'pub_x', cmap: go[0].cmap, cfg: go[0].rules }); assert.strictEqual(S.RK.mt[go[0].id].st, 'live');
 CFG.team.comp = 5;
});

test('Unranked: eigene Schlange, Bots nach 15 s nach Spielerstärke, Ranked-Rating unberührt, keine Suchsperre', () => {
 CFG.team.ur = 2; const S = setup(2), a = fakeWs(), b = fakeWs();
 // Ablehnen ohne Suchsperre
 S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'ur' }); S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'ur' }); T += 16000; S.rk.tick(T);
 for (let i = 0; i < 3; i++) { const f = a.last('rkfound'); S.rk.queueMsg(a, { type: 'rkacc', id: f.id, ok: 0 }); S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'ur' }); S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'ur' }); T += 16000; S.rk.tick(T); }
 assert.ok(!S.rk._.BAN.get('p0'), 'keine Suchsperre im Unranked');
 const f = a.last('rkfound'); assert.strictEqual(f.mode, 'ur'); assert.strictEqual(f.bots, 2, '2 Menschen + 2 Bots'); assert.ok(f.blv >= 1);
 S.rk.queueMsg(a, { type: 'rkacc', id: f.id, ok: 1 }); S.rk.queueMsg(b, { type: 'rkacc', id: f.id, ok: 1 }); const go = [a.last('rkgo'), b.last('rkgo')];
 const ws = go.map((g, i) => enter(S, g, i)), host = ws[0], L = host.rk, hT = go[0].team, oT = hT === 'CT' ? 'T' : 'CT';
 send(S, host, { type: 'start', map: go[0].map, cfg: L.rules }); send(S, host, { type: 'roster', bots: L.side.flatMap((sd, i) => Array.from({ length: L.nb[i] }, (_, j) => ({ n: 'Bot' + i + j, t: sd }))) });
 for (let i = 0; i < 5; i++) { T += 9000; send(S, host, { type: 'end', w: hT }); } T += 1000; send(S, host, { type: 'over', sc: { [hT]: 5, [oT]: 0 } });
 const mt = S.RK.mt[go[0].id]; assert.strictEqual(mt.st, 'rated'); assert.ok(!mt.ch, 'keine sichtbare Ratingänderung');
 for (const k of ['p0', 'p1']) { assert.strictEqual(S.RK.p[k].m.comp.r, 1000); assert.strictEqual(S.RK.p[k].m.comp.n, 0); assert.strictEqual(S.RK.p[k].u.n, 1); }
 const pr = S.rk.profile({ name: 'P0' }); assert.strictEqual(pr.ur.n, 1); assert.strictEqual(pr.ur.r, undefined, 'Stärke bleibt versteckt'); assert.strictEqual(host.last('rkdone').me, null);
 assert.strictEqual(S.rk.board('comp').total, 0); CFG.team.ur = 5;
});

test('Matchmaking DM/Gauntlet/1v1: ohne Rang, Bots nach 10 s, 1v1 nur Menschen, Gauntlet nur Duo-Gruppen', () => {
 const S = setupP(3), a = fakeWs(), b = fakeWs(), c = fakeWs(); [a, b, c].forEach((w, i) => S.rk.queueMsg(w, { type: 'rkhi', tok: 't' + i }));
 S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'qdm' }); S.rk.tick(T); assert.ok(!a.last('rkfound'), 'erst nach 10 s');
 T += 11000; S.rk.tick(T); const f = a.last('rkfound'); assert.strictEqual(f.mode, 'qdm'); assert.ok(f.maps.length, 'Map-Voting'); S.rk.queueMsg(a, { type: 'rkacc', id: f.id, ok: 1 });
 const go = a.last('rkgo'); assert.strictEqual(go.rules.bots, 1); const w = enter(S, go, 0);
 send(S, w, { type: 'start', dm: 1 }); T += 5000; send(S, w, { type: 'over', sc: {} });
 assert.strictEqual(S.RK.mt[go.id].st, 'done'); assert.strictEqual(S.RK.p.p0.m.comp.r, 1000); assert.ok(!S.rk._.BY.has('p0'));
 S.rk.queueMsg(b, { type: 'rkq', tok: 't1', mode: 'qv1' }); T += 60000; S.rk.tick(T); assert.ok(!b.last('rkfound'), '1v1 ohne Bots');
 S.rk.queueMsg(c, { type: 'rkq', tok: 't2', mode: 'qv1' }); S.rk.tick(T); assert.strictEqual(b.last('rkfound').mode, 'qv1');
 S.rk.queueMsg(b, { type: 'rkacc', id: b.last('rkfound').id, ok: 0 }); assert.ok(!S.rk._.BAN.get('p1'), 'keine Suchsperre');
 S.rk.queueMsg(c, { type: 'rkx' }); S.rk.queueMsg(a, { type: 'rkpinv', n: 'P1' }); S.rk.queueMsg(b, { type: 'rkpjoin', id: b.last('rkpinv').inv[0].id }); S.rk.queueMsg(a, { type: 'rkpinv', n: 'P2' }); S.rk.queueMsg(c, { type: 'rkpjoin', id: c.last('rkpinv').inv[0].id });
 S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'qgl' }); assert.match(a.last('rkoff').why, /max\. 2/);
 S.rk.queueMsg(a, { type: 'rkpkick', n: 'p2' }); S.rk.queueMsg(a, { type: 'rkq', tok: 't0', mode: 'qgl' }); T += 11000; S.rk.tick(T);
 const fg = a.last('rkfound'); [a, b].forEach(x => S.rk.queueMsg(x, { type: 'rkacc', id: fg.id, ok: 1 })); assert.deepStrictEqual(a.last('rkgo').duo, [['P0', 'P1']]);
});

// ── Echter Server: Registrieren, Warteschlange per WebSocket, Raum-Zugang ──
test('Server-Integration (HTTP + WebSocket)', { timeout: 20000 }, async () => {
 Date.now = realNow;
 const { spawn } = require('child_process'), path = require('path'), os = require('os'), fs = require('fs'), WebSocket = require('ws');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-')), port = 18000 + Math.floor(Math.random() * 2000);
 const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: port, DATA_DIR: dir, GIST_ID: '', GIST_TOKEN: '', SKIN_BADGE_COINS: '1300' }), stdio: 'pipe' });
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
  // Profilbild nur aus fester Auswahl, Profil öffentlich, Account & Bild im Raum vom Server
  assert.ok((await api('setav', { tok: A.tok, av: 99 })).err); assert.strictEqual((await api('setav', { tok: A.tok, av: 3 })).av, 3);
  const pp = await api('pprof', { n: 'rktesta' }); assert.strictEqual(pp.n, 'rkTestA'); assert.strictEqual(pp.av, 3); assert.strictEqual(pp.badges.map, null); assert.ok(!('data' in pp) && !('fr' in pp));
  // Profilbild hochladen: nur echte PNG/JPEG/WebP, Auslieferung als Bild mit Schutz-Headern, Preset setzt zurück
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.ok((await api('setav', { tok: B.tok, img: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).err, 'SVG abgelehnt');
  assert.ok((await api('setav', { tok: B.tok, img: 'data:image/png;base64,PGh0bWw+PHNjcmlwdD48L3NjcmlwdD4=' })).err, 'falsche Signatur abgelehnt');
  assert.ok((await api('setav', { tok: B.tok, img: 'data:image/png;base64,' + 'A'.repeat(30000) })).err, 'zu groß');
  assert.strictEqual((await api('setav', { tok: B.tok, img: png })).av, 'u1'); assert.ok((await api('setav', { tok: B.tok, img: png })).err, 'Upload-Bremse');
  const im = await fetch(`http://localhost:${port}/av/rktestb?v=1`); assert.strictEqual(im.headers.get('content-type'), 'image/png'); assert.strictEqual(im.headers.get('x-content-type-options'), 'nosniff'); assert.strictEqual(Buffer.from(await im.arrayBuffer()).readUInt32BE(0), 0x89504e47);
  assert.strictEqual((await fetch(`http://localhost:${port}/av/rkTestA`)).status, 404); assert.strictEqual((await api('pprof', { n: 'rkTestB' })).av, 'u1');
  assert.strictEqual((await api('setav', { tok: B.tok, av: 2 })).av, 2); assert.strictEqual((await fetch(`http://localhost:${port}/av/rktestb`)).status, 404, 'Preset ersetzt Upload');
  const h1 = await open(), h2 = await open(); h1.send(JSON.stringify({ type: 'join', room: 'custom1', pid: 'h1', acc: A.tok })); await wait(h1, 'joined'); h2.send(JSON.stringify({ type: 'join', room: 'custom1', pid: 'h2' })); await wait(h2, 'joined');
  h1.send(JSON.stringify({ type: 'hello', pid: 'h1', name: 'x', av: 15, acc: 'rkTestB' })); const hh = await wait(h2, 'hello'); assert.strictEqual(hh.acc, 'rkTestA'); assert.strictEqual(hh.av, 3);
  assert.ok((await api('mappool', { code: 'falsch', k: 'pub_x', on: 1 })).err);
  // Map-Pool: veröffentlichte Karte offiziell aufnehmen → Creator-Badge; Entfernen lässt das Badge (Regel), revoke entzieht es
  const mg = ['#'.repeat(28), ...Array(26).fill('#' + '.'.repeat(26) + '#'), '#'.repeat(28)];
  assert.ok((await api('publish', { code: 'baumeister42', k: 'pub_testmap', map: { n: 'Testmap', g: mg }, by: 'rkTestA' })).ok);
  assert.ok((await api('mappool', { code: 'baumeister42', k: 'pub_testmap', on: 1, creator: 'rktesta' })).ok);
  let pa = await api('pprof', { n: 'rkTestA' }); assert.deepStrictEqual(pa.badges.map.maps.map(x => [x.n, x.now]), [['Testmap', true]]);
  assert.ok((await api('ranked', { tok: A.tok })).maps.includes('pub_testmap'), 'Karte im Ranked-Pool');
  assert.ok((await api('publish', { code: 'baumeister42', k: 'pub_testmap', map: { n: 'Testmap', g: mg }, by: 'rkTestA' })).ok); assert.ok((await api('maps', {})).maps.pub_testmap.off, 'Neu-Veröffentlichen hält die Karte im Pool');
  await api('mappool', { code: 'baumeister42', k: 'pub_testmap', on: 0 }); pa = await api('pprof', { n: 'rkTestA' }); assert.strictEqual(pa.badges.map.maps[0].now, false, 'Badge bleibt, Karte als ehemals');
  await api('mappool', { code: 'baumeister42', k: 'pub_testmap', on: 1, creator: 'rkTestA' }); await api('mappool', { code: 'baumeister42', k: 'pub_testmap', on: 0, revoke: 1 }); assert.strictEqual((await api('pprof', { n: 'rkTestA' })).badges.map, null, 'revoke entzieht');
  // Skin-Einnahmen: nur erster Kauf je Käufer zählt (Ziel im Test 1300, Anteil je Kauf 1250)
  const C = await api('register', { u: 'rkTestC', p: 'pass3' }), sk = await api('mkskin', { tok: A.tok, s: { w: 'ak47', p: 'solid', r: 4, n: 'Testskin' } }); assert.ok(sk.ok);
  await api('buyskin', { tok: B.tok, id: sk.skin.id }); await api('buyskin', { tok: B.tok, id: sk.skin.id }); await api('buyskin', { tok: A.tok, id: sk.skin.id });
  assert.strictEqual((await api('pprof', { n: 'rkTestA' })).badges.skin, null, 'Doppelkauf & Eigenkauf zählen nicht');
  await api('buyskin', { tok: C.tok, id: sk.skin.id }); assert.strictEqual((await api('pprof', { n: 'rkTestA' })).badges.skin.coins, 2500);
  // Customs-Zuschauer: max. 2 (auch der Host), Host-Wechsel überspringt Zuschauer
  const sw = []; for (const id of ['s0', 's1', 's2', 's3']) { const w = await open(); w.send(JSON.stringify({ type: 'join', room: 'spec1', pid: id })); await wait(w, 'joined'); sw.push(w); }
  sw[0].send(JSON.stringify({ type: 'lmode', mode: 'comp' }));   sw[1].send(JSON.stringify({ type: 'team', pid: 's1', team: 'SPEC' })); sw[2].send(JSON.stringify({ type: 'team', pid: 's2', team: 'SPEC' })); sw[3].send(JSON.stringify({ type: 'team', pid: 's3', team: 'SPEC' }));
  assert.match((await wait(sw[3], 'specdeny')).why, /belegt/); await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(sw[0].msgs.filter(x => x.type === 'team' && x.team === 'SPEC').length, 2, 'nur 2 Zuschauer weitergeleitet');
  sw[1].send(JSON.stringify({ type: 'team', pid: 's1', team: 'CT' })); sw[0].send(JSON.stringify({ type: 'team', pid: 's0', team: 'SPEC' })); await new Promise(r => setTimeout(r, 150));
  assert.ok(!sw[0].msgs.some(x => x.type === 'specdeny'), 'Host darf zuschauen'); assert.strictEqual(sw[3].msgs.filter(x => x.type === 'team' && x.team === 'SPEC' && x.pid === 's0').length, 1);
  sw[0].close(); assert.ok(await wait(sw[1], 'promote'), 'Spieler statt Zuschauer wird Host');
  [qa, qb, ra, guest, lst, h1, h2, ...sw].forEach(w => w.close());
 } finally { srv.kill(); }
});
