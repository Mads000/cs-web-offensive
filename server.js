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
const PUBLISH_CODE = process.env.PUBLISH_CODE || 'baumeister42'; // Code zum Veröffentlichen von Community-Karten, Shop-Preisen & Ranked-Map-Pool – am besten als Umgebungsvariable PUBLISH_CODE setzen
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'), USERS_FILE = path.join(DATA_DIR, 'users.json'), PUB_FILE = path.join(DATA_DIR, 'maps.json'), LB_FILE = path.join(DATA_DIR, 'leaderboard.json'), SKIN_FILE = path.join(DATA_DIR, 'skins.json'), PRICE_FILE = path.join(DATA_DIR, 'prices.json'), RANKED_FILE = path.join(DATA_DIR, 'ranked.json');
const SYNC_KEYS = ['agent', 'bonus20', 'btnlayout', 'cases', 'cs_binds', 'cs_opts', 'custommaps', 'equip', 'gamecfg', 'inv', 'map', 'pname', 'stick', 'customarenas', 'arenaoff', 'prog', 'duckhat', 'knifetype', 'lang', 'fit', 'fitown', 'botrk']; // muss zu SYNC_KEYS im Spiel passen (sonst gehen Outfit, gekaufte Kleidung & Sprache beim Abgleich verloren)
const GIST_ID = process.env.GIST_ID, GIST_TOKEN = process.env.GIST_TOKEN, GIST_FILE = 'users.json';
const GH = { Authorization: 'Bearer ' + GIST_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'cs-web-offensive' };
let CSK = {}, PRICES = {}; // PRICES: { r: {Seltenheit: Preis}, s: {SkinId: Preis} } – vom Shop-Preiseditor // Community-Skins: id → { id, w, n, c, c2, c3, p, r, by, sold, t }
const RK = {}; // Ranked: Ratings, Saison, Match-Historie (eigene Datei → eine atomare Speicherung pro Match)
let USERS = {}, PUB = {}, LB = { all: [], day: '', today: [] }, loaded = false, saveT = null, writing = false, again = false;
async function loadUsers() {
 if (!GIST_ID || !GIST_TOKEN) { try { USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { } try { PUB = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8')); } catch { } try { LB = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); } catch { } try { CSK = JSON.parse(fs.readFileSync(SKIN_FILE, 'utf8')); } catch { } try { PRICES = JSON.parse(fs.readFileSync(PRICE_FILE, 'utf8')); } catch { } try { Object.assign(RK, JSON.parse(fs.readFileSync(RANKED_FILE, 'utf8'))); } catch { } rk.init(); loaded = true; console.log('Accounts: lokale Datei (' + Object.keys(USERS).length + ')'); return; }
 try {
 const r = await fetch('https://api.github.com/gists/' + GIST_ID, { headers: GH }); if (!r.ok) throw new Error('HTTP ' + r.status);
 const files = (await r.json()).files, read = async f => !f ? '{}' : f.truncated ? await (await fetch(f.raw_url, { headers: GH })).text() : f.content;
 USERS = JSON.parse(await read(files[GIST_FILE]) || '{}'); PUB = JSON.parse(await read(files['maps.json']) || '{}'); LB = Object.assign({ all: [], day: '', today: [] }, JSON.parse(await read(files['leaderboard.json']) || '{}')); CSK = JSON.parse(await read(files['skins.json']) || '{}'); PRICES = JSON.parse(await read(files['prices.json']) || '{}'); Object.assign(RK, JSON.parse(await read(files['ranked.json']) || '{}')); rk.init(); loaded = true; console.log('Accounts: Gist geladen (' + Object.keys(USERS).length + ')');
 } catch (e) { console.error('Gist laden fehlgeschlagen (' + e.message + ') – neuer Versuch in 10 s'); setTimeout(loadUsers, 10000); } // nie mit leerem Stand überschreiben
}
async function writeUsers() {
 if (!loaded) return; if (writing) { again = true; return; } writing = true;
 try {
 if (GIST_ID && GIST_TOKEN) { const r = await fetch('https://api.github.com/gists/' + GIST_ID, { method: 'PATCH', headers: GH, body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(USERS) }, 'maps.json': { content: JSON.stringify(PUB) }, 'leaderboard.json': { content: JSON.stringify(LB) }, 'skins.json': { content: JSON.stringify(CSK) }, 'prices.json': { content: JSON.stringify(PRICES) }, 'ranked.json': { content: JSON.stringify(RK) } } }) }); if (!r.ok) throw new Error('HTTP ' + r.status); }
 else { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = USERS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(USERS)); fs.renameSync(tmp, USERS_FILE); fs.writeFileSync(PUB_FILE, JSON.stringify(PUB)); fs.writeFileSync(LB_FILE, JSON.stringify(LB)); fs.writeFileSync(SKIN_FILE, JSON.stringify(CSK)); fs.writeFileSync(PRICE_FILE, JSON.stringify(PRICES)); fs.writeFileSync(RANKED_FILE + '.tmp', JSON.stringify(RK)); fs.renameSync(RANKED_FILE + '.tmp', RANKED_FILE); }
 } catch (e) { console.error('Accounts speichern fehlgeschlagen: ' + e.message); again = true; }
 writing = false; if (again) { again = false; persist(); }
}
// ── Profilbild & Badges (nur Server-Felder, nie aus u.data → vom Client nicht setzbar) ──
// Profilbild: Auswahl aus AV_N festen Motiven (kein Upload, keine fremden Bild-URLs); ohne Auswahl = -1 → Initiale als Standard-Avatar
// Map-Creator (u.cr): vom Admin vergeben, sobald eine Community-Karte offiziell in den Ranked-Pool kommt. Regel: bleibt dauerhaft,
// auch wenn die Karte später aus dem Pool rotiert (wird als „ehemals“ geführt); entzogen nur ausdrücklich (revoke, z. B. Plagiat).
// Skin-Creator: Lebenszeit-Einnahmen (u.earnT) aus Verkäufen eigener Community-Skins ≥ SKIN_BADGE Coins – getrenntes Kriterium.
const AV_N = 16, SKIN_BADGE = +process.env.SKIN_BADGE_COINS || 5000;
const avOf = u => !u ? -1 : u.avImg ? 'u' + (u.avV || 1) : Number.isInteger(u.av) && u.av >= 0 && u.av < AV_N ? u.av : -1; // 'u3' = hochgeladenes Bild (Version 3)
// Hochgeladenes Profilbild: nur PNG/JPEG/WebP (Dateisignatur geprüft), max. AV_MAX Zeichen Base64 (~18 KB) – das Spiel verkleinert vorher auf 96×96.
// Gespeichert als Base64 im Account, ausgeliefert nur über GET /av/<Name> als Bild (nosniff, CSP ohne Skripte) → nichts davon kann ausgeführt werden.
const AV_MAX = 24000, AV_SIG = { 'image/png': b => b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a, 'image/jpeg': b => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'image/webp': b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' };
function avImg(s) { const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(s || '')); if (!m || m[2].length > AV_MAX) return null; const buf = Buffer.from(m[2], 'base64'); return AV_SIG[m[1]](buf) ? { mime: m[1], data: m[2] } : null; }
const isCreator = u => !!(u && u.cr && !u.cr.rv && Object.keys(u.cr.maps || {}).length);
const bdOf = u => (isCreator(u) ? 'm' : '') + (u && (u.earnT || 0) >= SKIN_BADGE ? 's' : '') + (u && u.pt ? 'p' : ''); // Kurzform für Listen: m = Map-Creator, s = Skin-Creator, p = Playtester
const rooms = new Map(), rk = require('./ranked').createRanked({ RK, persist: () => persist(), rooms, auth: tok => byTok(tok),
 user: n => USERS[String(n).toLowerCase()] || null, friends: (a, b) => !!USERS[a] && (USERS[a].fr || []).some(x => x.toLowerCase() === b),
 info: k => ({ av: avOf(USERS[k]), bd: bdOf(USERS[k]) }), maps: () => Object.keys(PUB).filter(k => /^pub_/.test(k) && PUB[k].off), mapData: k => PUB[k] && PUB[k].off ? PUB[k] : null });
function persist() { clearTimeout(saveT); saveT = setTimeout(writeUsers, GIST_ID ? 3000 : 500); } // Gist: Änderungen 3 s sammeln (schont das GitHub-Limit)
loadUsers();
// Render beendet den Server mit SIGTERM (Deploy/Ruhemodus) → offene Änderungen vorher noch speichern
process.on('SIGTERM', async () => { clearTimeout(saveT); await dcStatus(true).catch(() => { }); while (writing) await new Promise(r => setTimeout(r, 100)); await writeUsers(); process.exit(0); });
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const cleanData = d => { const o = {}; if (d && typeof d === 'object') for (const k of SYNC_KEYS) if (typeof d[k] === 'string') o[k] = d[k]; return o; };
const byTok = tok => typeof tok === 'string' && tok.length === 48 ? Object.values(USERS).find(u => u.toks.includes(tok)) : null;
const newTok = u => { const t = crypto.randomBytes(24).toString('hex'); u.toks = [t, ...u.toks].slice(0, 10); return t; };
// ── Discord (optional): Webhook-URLs als Umgebungsvariablen (bei Render), erstellt von discord/setup.js ──
const DC = { news: process.env.DISCORD_NEWS_WEBHOOK, status: process.env.DISCORD_STATUS_WEBHOOK, lfg: process.env.DISCORD_LFG_WEBHOOK, bug: process.env.DISCORD_BUG_WEBHOOK };
const SITE = process.env.SITE_URL || 'https://clutchtactic.de', LFG = new Map(), SPEC_MAX = 2; // Customs: max. Zuschauer pro Lobby
const DC_MOD = { comp: '🛠 Customs', dm: '💀 Deathmatch', gl: '⚔️ Gauntlet', v1: '🎯 1v1', duck: '🦆 Entenjagd' };
const dcEsc = s => String(s || '').replace(/[\\*_`~|>#\[\]()-]/g, '\\$&'); // Discord-Markdown entschärfen
const dcPost = (url, body, q = '') => !url ? Promise.resolve(null) : fetch(url + (q ? '?' + q : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed_mentions: { parse: [] }, ...body }) }).then(r => r.ok ? (q.includes('wait') ? r.json() : 1) : null).catch(() => null);
async function dcNews() { // neue Patchnotes nach jedem Deploy posten (Stand in LB.newsV)
 if (!DC.news) return; const { patchnotes, stuecke } = require('./patchnotes'); let list; try { list = patchnotes(); } catch { return; } if (!list.length) return;
 const neu = list[list.length - 1].v; if (LB.newsV === undefined) { LB.newsV = neu; persist(); return; } // erster Start: Altes hat das Setup-Skript schon gepostet
 for (const p of list) if (+p.v > +LB.newsV) for (const s of stuecke(p.titel + '\n' + p.body)) await dcPost(DC.news, { content: s }, 'wait=true');
 if (+neu > +LB.newsV) { LB.newsV = neu; persist(); }
}
async function dcStatus(off) { // eine Status-Nachricht, die alle 5 Min bearbeitet wird
 if (!DC.status) return; const s = Math.floor(Date.now() / 1000), list = [...rooms.entries()].filter(([, r]) => r.clients.length), n = list.reduce((a, [, r]) => a + r.clients.length, 0);
 const content = off ? `# 🔴 Server schläft\nBeim nächsten Aufruf von ${SITE} startet er neu (ca. 1 Minute).\n-# Stand: <t:${s}:R>`
 : `# 🟢 Server online\n🎮 **${n}** Spieler online in **${list.length}** ${list.length === 1 ? 'Raum' : 'Räumen'}\n` + list.slice(0, 10).map(([name, r]) => `> **${dcEsc(name)}** · ${name.startsWith('rk_') ? '🎯 Ranked/Unranked' : DC_MOD[r.mode] || DC_MOD.comp} · ${r.clients.length} Spieler · ${r.started ? '🎮 läuft' : '🛋 Lobby'}`).join('\n') + `${list.length ? '\n' : ''}▶ ${SITE}\n-# aktualisiert <t:${s}:R>`;
 if (LB.statusMsg) { const r = await fetch(DC.status + '/messages/' + LB.statusMsg, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) }).catch(() => null); if (r && r.ok) return; }
 const m = await dcPost(DC.status, { content }, 'wait=true'); if (m && m.id) { LB.statusMsg = m.id; persist(); }
}
{ const w = setInterval(() => { if (!loaded) return; clearInterval(w); dcNews(); dcStatus(); setInterval(dcStatus, 5 * 60 * 1000); }, 1000); }
const SEEN = new Map(), INVS = new Map(); // Freunde: zuletzt online (Name → Zeit) & offene Einladungen (Name → Liste) – nur im Speicher
const tries = new Map(); // einfache Bremse gegen Passwort-Raten: max. 10 Versuche pro Minute und IP
const DECO_IDS = ['kr', 'fa', 'sb', 'ab', 'za', 'pa', 're', 'ti', 'bk', 'pf', 'bm', 'ke', 'au', 'la', 'ne', 'pl', 'ba', 'sc'], patOK = (a, mx) => !Array.isArray(a) ? [] : a.slice(0, 1600).filter(e => Array.isArray(e) && e.length === mx.length && e.every((v, i) => Number.isInteger(v) && v >= 0 && v <= mx[i])), decoOK = a => !Array.isArray(a) ? [] : a.slice(0, 200).filter(e => Array.isArray(e) && (e.length === 7 || (e.length === 8 && typeof e[7] === 'string')) && DECO_IDS.includes(e[0]) && e.slice(1, 7).every(Number.isFinite)).map(e => { const q = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)) * 1000) / 1000, r = [e[0], q(e[1], -2, 30), q(e[2], -2, 30), q(e[3], 0, 12), e[4] & 7, q(e[5], 0.5, 2), (Number.isInteger(e[6]) && e[6] >= 0 && e[6] < 16777248 ? e[6] : 0)], t = String(e[7] || '').replace(/[<>"'&`]/g, '').slice(0, 18); if (t) r.push(t); return r; }); // 3D-Deko eigener Karten (wie im Spiel geprüft)
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
 const salt = crypto.randomBytes(16).toString('hex'), u = USERS[key] = { name, salt, hash: hashPw(pw, salt), toks: [], ver: 1, data: cleanData(b.data), ct: Date.now() }; // ct = Erstellungsdatum (ältere Accounts haben keins)
 const tok = newTok(u); persist(); return { ok: 1, u: name, tok, ver: u.ver, av: -1 };
 }
 const u = USERS[key]; if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) return { err: 'Name oder Passwort falsch.' };
 const tok = newTok(u); persist(); return { ok: 1, u: u.name, tok, ver: u.ver, data: u.data, av: avOf(u), pt: u.pt ? 1 : 0 };
 }
 // ── Weitere Codes (Code nur als Render-Umgebungsvariable, Inhalt als Render-Secret-File) ──
 if (p === '/api/code') {
 if (limited(ip)) return { err: 'Zu viele Versuche – bitte kurz warten.' };
 if (String(b.code || '').toLowerCase() === String(process.env.PLAYTEST_CODE || 'clutchplaytest').toLowerCase()) { // 🧪 Playtester-Code → Abzeichen dauerhaft am Account
 const u = byTok(b.tok); if (!u) return { err: 'Bitte zuerst einloggen – das Abzeichen hängt am Account.' };
 if (u.pt) return { ok: 1, pt: 1 }; u.pt = Date.now(); persist(); return { ok: 1, pt: 1, neu: 1 };
 }
 const want = Buffer.from(String(process.env.DEBUG_CODE || '')), c = Buffer.from(String(b.code || '').toLowerCase());
 if (!want.length || c.length !== want.length || !crypto.timingSafeEqual(c, want)) return { err: 1 };
 for (const f of ['/etc/secrets/cheats.js', path.join(__dirname, 'cheats.js')]) { try { return { ok: 1, js: fs.readFileSync(f, 'utf8') }; } catch { } }
 return { err: 1 };
 }
 // ── Community-Skins: Liste für alle ──
 // ── Ranked: Profil, Rang, Historie (Warteschlange läuft über WebSocket) ──
 if (p === '/api/ptrank') { const u = byTok(b.tok); if (!u) return { err: 'Bitte neu einloggen.', relog: 1 }; if (!u.pt) return { err: 'Nur für Playtester.' }; if (!rk.setRank(u, String(b.mode || ''), +b.r)) return { err: 'Ungültiger Modus oder Wert.' }; return Object.assign({ ok: 1 }, rk.profile(u)); } // 🧪 Playtester: Rang setzen
 if (p === '/api/ranked') { const u = byTok(b.tok); if (!u) return { err: 'Bitte neu einloggen.', relog: 1 }; return Object.assign({ ok: 1 }, rk.profile(u)); }
 if (p === '/api/rklb') { const u = byTok(b.tok); return Object.assign({ ok: 1 }, rk.board(String(b.mode || ''), u ? u.name.toLowerCase() : null)); } // Ranked-Bestenliste
 if (p === '/api/skins') return { ok: 1, skins: Object.values(CSK), prices: PRICES };
 // ── Spielerprofil (öffentlich): nur Name, Profilbild, Level, Badges & Ranked-Werte – keine Inventare, Freunde oder Kontodaten ──
 if (p === '/api/pprof') {
 const t = USERS[String(b.n || '').trim().toLowerCase()]; if (!t) return { err: 'Spieler nicht gefunden.' }; const key = t.name.toLowerCase();
 let xp = null; try { const v = Math.floor(+JSON.parse(t.data.prog || 'null').xp); if (v >= 0) xp = v; } catch { } // Level-XP kommt aus dem Spielstand (wie im eigenen Profil)
 const maps = Object.entries((t.cr && t.cr.maps) || {}).map(([k, x]) => ({ n: x.n, t: x.t, now: !!(PUB[k] && PUB[k].off && PUB[k].cr === key) }));
 return Object.assign({ ok: 1, n: t.name, av: avOf(t), xp, ct: t.ct || null, badges: { map: isCreator(t) ? { maps } : null, skin: (t.earnT || 0) >= SKIN_BADGE ? { coins: t.earnT, goal: SKIN_BADGE } : null, pt: t.pt ? { t: t.pt } : null } }, rk.pub(key));
 }
 // ── Hochgeladenes Profilbild eines Spielers entfernen (Moderation, nur mit Code) → zurück zum Standard-Avatar ──
 if (p === '/api/rmav') {
 if (limited(ip)) return { err: 'Zu viele Versuche – bitte kurz warten.' };
 const c = Buffer.from(String(b.code || '')), want = Buffer.from(PUBLISH_CODE);
 if (c.length !== want.length || !crypto.timingSafeEqual(c, want)) return { err: 'Falscher Code.' };
 const t = USERS[String(b.n || '').trim().toLowerCase()]; if (!t) return { err: 'Spieler nicht gefunden.' }; delete t.avImg; delete t.avM; persist(); return { ok: 1 };
 }
 // ── Ranked-Map-Pool: veröffentlichte Community-Karte offiziell aufnehmen/entfernen (nur mit Code) – vergibt das Map-Creator-Badge ──
 if (p === '/api/mappool') {
 if (limited(ip)) return { err: 'Zu viele Versuche – bitte kurz warten.' };
 const c = Buffer.from(String(b.code || '')), want = Buffer.from(PUBLISH_CODE);
 if (c.length !== want.length || !crypto.timingSafeEqual(c, want)) return { err: 'Falscher Code.' };
 const k = String(b.k || ''), M = PUB[k]; if (!/^pub_[a-z0-9_]{1,40}$/.test(k) || !M) return { err: 'Nur veröffentlichte Community-Karten können in den Pool.' };
 if (b.on) {
 const cu = USERS[String(b.creator || '').trim().toLowerCase()]; if (!cu) return { err: 'Creator-Account nicht gefunden.' }; const ck = cu.name.toLowerCase();
 if (M.off && M.cr && M.cr !== ck && USERS[M.cr] && USERS[M.cr].cr && USERS[M.cr].cr.maps[k]) USERS[M.cr].cr.maps[k].out = Date.now(); // Creator gewechselt
 M.off = 1; M.cr = ck; cu.cr = cu.cr || { maps: {} }; cu.cr.maps[k] = { n: M.n, t: (cu.cr.maps[k] || {}).t || Date.now() }; delete cu.cr.rv;
 persist(); return { ok: 1, msg: M.n + ' ist jetzt im Ranked-Pool · Creator: ' + cu.name };
 }
 const cu = M.cr && USERS[M.cr]; if (cu && cu.cr && cu.cr.maps[k]) { cu.cr.maps[k].out = Date.now(); if (b.revoke) cu.cr.rv = { t: Date.now(), k }; }
 delete M.off; delete M.cr; persist(); return { ok: 1, msg: M.n + ' ist nicht mehr im Ranked-Pool' + (b.revoke ? ' · Creator-Badge entzogen' : ' · Creator-Badge bleibt') };
 }
 // ── Shop-Preise: mit Code prüfen (check) oder für alle speichern ──
 if (p === '/api/setprices') {
 if (limited(ip)) return { err: 'Zu viele Versuche – bitte kurz warten.' };
 const c = Buffer.from(String(b.code || '')), want = Buffer.from(PUBLISH_CODE);
 if (c.length !== want.length || !crypto.timingSafeEqual(c, want)) return { err: 'Falscher Code.' };
 if (b.check) return { ok: 1 };
 const num = v => { v = Math.round(+v); return v >= 0 && v <= 1000000 ? v : null; }, P = { r: {}, s: {} }, src = b.prices || {};
 for (const r of ['1', '2', '3', '4']) { const v = num(src.r && src.r[r]); if (v !== null) P.r[r] = v; }
 for (const [id, v0] of Object.entries(src.s || {}).slice(0, 600)) { const v = num(v0); if (/^[a-z0-9_]{1,40}$/i.test(id) && v !== null) P.s[id] = v; }
 PRICES = P; persist(); return { ok: 1, prices: PRICES };
 }
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
 if (p === '/api/unpublish') { const cu = PUB[k] && PUB[k].off && USERS[PUB[k].cr]; if (cu && cu.cr && cu.cr.maps[k]) cu.cr.maps[k].out = Date.now(); delete PUB[k]; persist(); return { ok: 1 }; }
 const m = b.map || {}, HEX = /^#[0-9a-f]{6}$/i;
 if (!Array.isArray(m.g) || m.g.length !== (AR ? 18 : 28) || !m.g.every(r => typeof r === 'string' && (AR ? /^[#.cCh=1-6TKsbDW]{11}$/ : /^[#.cCh=1-6ABTKsbDWRO]{28}$/).test(r))) return { err: 'Ungültige Kartendaten.' };
 if (!PUB[k] && Object.keys(PUB).length >= 50) return { err: 'Maximal 50 Community-Karten.' };
 const col = {}; for (const f of ['sky', 'fog', 'floor', 'wall']) if (m.col && HEX.test(m.col[f])) col[f] = m.col[f];
 const was = PUB[k]; PUB[k] = { n: String(m.n || 'Karte').replace(/[<>"'&`]/g, '').slice(0, 20), th: /^de_[a-z]+$/.test(m.th) ? m.th : 'de_dusty', col, tod: [0, 1, 2].includes(+m.tod) ? +m.tod : 0, em: Array.from(String(m.em || '').replace(/[<>"'&`]/g, '')).slice(0, 2).join(''), emc: HEX.test(m.emc) ? m.emc : '', by: String(b.by || '').replace(/[<>"'&`]/g, '').slice(0, 16), g: m.g, dk: decoOK(m.dk), wm: patOK(m.wm, [27, 27, 3, 6, 16777247]), fm: patOK(m.fm, [27, 27, 6, 16777247]) };
 if (was && was.off) { PUB[k].off = 1; PUB[k].cr = was.cr; } // Neu-Veröffentlichen hält eine Karte im Ranked-Pool
 persist(); return { ok: 1 };
 }
 // ── Discord: Lobby in #mitspielersuche posten (mit Beitreten-Knopf) & Bug-Meldungen aus dem Spiel ──
 if (p === '/api/lfg') {
 if (!DC.lfg) return { err: 'Discord ist nicht eingerichtet.' }; const room = String(b.room || '').trim().slice(0, 30), r = rooms.get(room);
 if (!r || !r.clients.length) return { err: 'Raum nicht gefunden.' }; if (Date.now() - (LFG.get(room.toLowerCase()) || 0) < 120000) return { err: 'Dieser Raum wurde gerade erst gepostet – bitte 2 Minuten warten.' };
 LFG.set(room.toLowerCase(), Date.now()); const url = SITE + '/?join=' + encodeURIComponent(room) + '&mode=' + (DC_MOD[r.mode] ? r.mode : 'comp');
 dcPost(DC.lfg, { content: `🤝 **${dcEsc(String(b.name || 'Gast').slice(0, 16))}** sucht Mitspieler!\n🎮 Raum **${dcEsc(room)}** · ${DC_MOD[r.mode] || DC_MOD.comp} · ${r.clients.length} in der Lobby`, components: [{ type: 1, components: [{ type: 2, style: 5, label: '▶ Beitreten', url }] }] }, 'with_components=true');
 return { ok: 1 };
 }
 if (p === '/api/bug') {
 if (!DC.bug) return { err: 'Discord ist nicht eingerichtet.' }; if (limited(ip)) return { err: 'Zu viele Meldungen – bitte kurz warten.' };
 const t = String(b.text || '').trim().slice(0, 1500); if (t.length < 5) return { err: 'Bitte beschreibe den Fehler etwas genauer.' }; const by = byTok(b.tok);
 const who = by ? by.name : String(b.name || 'Gast').slice(0, 16), msg = { content: `🐞 **Bug-Meldung** von **${dcEsc(who)}**${by ? ' ☁️' : ''}\n> ${dcEsc(t).replace(/\n/g, '\n> ')}\n-# ${dcEsc(String(b.info || '').slice(0, 200))}` };
 dcPost(DC.bug, { ...msg, thread_name: ('🐞 ' + who + ': ' + t.split('\n')[0]).slice(0, 95) }, 'wait=true').then(r => r || dcPost(DC.bug, msg)); // Forum-Kanal: jede Meldung = eigener Beitrag (Ticket); alter Textkanal → normale Nachricht
 return { ok: 1 };
 }
 const u = byTok(b.tok); if (!u) return { err: 'Bitte neu einloggen.', relog: 1 };
 if (p === '/api/pull') return { ok: 1, ver: u.ver, data: u.data };
 // Community-Skins: erstellen (max. 10 je Spieler, 300 gesamt), löschen, kaufen, Verkaufs-Coins abholen
 if (p === '/api/mkskin') {
 const k = b.s || {}, W = ['knife', 'awp', 'scout', 'ak47', 'm4a1', 'pump', 'mp5', 'deagle', 'usp', 'glock', 'he', 'flash', 'smoke', 'molly', 'c4'], P = ['solid', 'fade', 'stripes', 'tiger', 'carbon', 'neon', 'camo', 'doppler', 'gold', 'dragon', 'asiimov', 'paint'], col = v => Math.max(0, Math.min(0xffffff, Math.floor(+v) || 0));
 if (!W.includes(k.w) || !P.includes(k.p) || ![1, 2, 3, 4].includes(+k.r)) return { err: 'Ungültiger Skin.' };
 const img = k.p === 'paint' ? String(k.img || '') : ''; if (k.p === 'paint' && (img.length > 16000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img))) return { err: 'Bild ungültig oder zu groß.' };
 const name = String(k.n || '').replace(/[<>"'&`|]/g, '').trim().slice(0, 20); if (name.length < 2) return { err: 'Name: mindestens 2 Zeichen.' };
 const all = Object.values(CSK); if (all.filter(x => x.by === u.name && !x.off).length >= 10) return { err: 'Maximal 10 eigene Skins.' }; if (all.length >= 300) return { err: 'Der Shop ist voll (300 Skins).' };
 const id = 'u_' + crypto.randomBytes(5).toString('hex'); CSK[id] = { id, w: k.w, km: k.w === 'knife' && ['butterfly', 'karambit'].includes(k.km) ? k.km : undefined, n: name, c: col(k.c), c2: col(k.c2), c3: col(k.c3), p: k.p, img: img || undefined, r: +k.r, by: u.name, sold: 0, t: Date.now() }; persist(); return { ok: 1, skin: CSK[id] };
 }
 if (p === '/api/rmskin') { const k = CSK[b.id]; if (!k || k.by !== u.name) return { err: 'Nicht Dein Skin.' }; k.off = 1; persist(); return { ok: 1 }; } // aus dem Shop nehmen: bleibt für Käufer erhalten
 if (p === '/api/buyskin') {
 const k = CSK[b.id]; if (!k || k.off) return { err: 'Skin gibt es nicht mehr im Shop.' }; k.sold++;
 const owner = USERS[k.by.toLowerCase()], share = Math.floor(((PRICES.s || {})[k.id] ?? (PRICES.r || {})[k.r] ?? ({ 1: 150, 2: 400, 3: 900, 4: 2500 })[k.r]) / 2); if (owner && owner !== u) owner.earn = (owner.earn || 0) + share;
 // Skin-Creator-Badge: zählt nur den ersten Kauf je Käufer & Skin (wiederholte/manipulierte Anfragen erhöhen die Einnahmen nicht), keine Eigenkäufe.
 // Hinweis: Coins sind eine reine Spielwährung im Spielstand – es gibt keine Zahlungsabwicklung, Rückerstattung oder Echtgeld-Auszahlung.
 u.bought = u.bought || []; if (owner && owner !== u && !u.bought.includes(k.id)) { u.bought.push(k.id); owner.earnT = (owner.earnT || 0) + share; }
 persist(); return { ok: 1 };
 }
 // ── Freunde: Anfragen (u.frq), Freundesliste (u.fr), Online-Status & Einladungen nur im Speicher ──
 if (p === '/api/friends' || p === '/api/fradd' || p === '/api/frdel' || p === '/api/frinv') {
 const me = u.name.toLowerCase(); u.fr = u.fr || []; u.frq = u.frq || []; SEEN.set(me, Date.now());
 const other = USERS[String(b.n || '').trim().toLowerCase()], has = (l, n) => l.some(x => x.toLowerCase() === n.toLowerCase()), drop = (l, n) => l.filter(x => x.toLowerCase() !== n.toLowerCase());
 if (p === '/api/fradd') {
 if (!other) return { err: 'Spieler nicht gefunden.' }; if (other === u) return { err: 'Das bist Du selbst.' }; other.fr = other.fr || []; other.frq = other.frq || [];
 if (has(u.fr, other.name)) return { ok: 1, msg: 'Ihr seid schon befreundet.' };
 if (has(u.frq, other.name)) { u.frq = drop(u.frq, other.name); u.fr.push(other.name); if (!has(other.fr, u.name)) other.fr.push(u.name); other.frq = drop(other.frq, u.name); persist(); return { ok: 1, msg: 'Anfrage angenommen.' }; }
 if (other.frq.length >= 50 || u.fr.length >= 100) return { err: 'Liste ist voll.' }; if (!has(other.frq, u.name)) other.frq.push(u.name); persist(); return { ok: 1, msg: 'Anfrage gesendet.' };
 }
 if (p === '/api/frdel') { const n = String(b.n || ''); u.fr = drop(u.fr, n); u.frq = drop(u.frq, n); if (other) { other.fr = drop(other.fr || [], u.name); other.frq = drop(other.frq || [], u.name); } persist(); return { ok: 1 }; }
 if (p === '/api/frinv') {
 if (!other || !has(u.fr, other.name)) return { err: 'Nur Freunde einladen.' }; const room = String(b.room || '').slice(0, 30), srv = String(b.srv || '').slice(0, 120);
 if (!room || !/^wss?:\/\/[^\s<>"']+$/.test(srv)) return { err: 'Kein Raum.' }; const k = other.name.toLowerCase(), l = (INVS.get(k) || []).filter(i => i.from !== u.name);
 l.push({ from: u.name, room, srv, mode: String(b.mode || '').slice(0, 8), t: Date.now() }); INVS.set(k, l.slice(-5)); return { ok: 1 };
 }
 const inRoom = {}; for (const c of wss.clients) if (c.acc && c.room && c.readyState === 1) { const r = rooms.get(c.room); inRoom[c.acc] = { room: c.room, mode: r && r.mode || null, st: r && r.started ? 1 : 0 }; }
 const inv = (INVS.get(me) || []).filter(i => Date.now() - i.t < 300000); INVS.delete(me);
 return { ok: 1, fr: u.fr.map(n => { const k = n.toLowerCase(), r = inRoom[k]; return { n, av: avOf(USERS[k]), bd: bdOf(USERS[k]), on: !!r || Date.now() - (SEEN.get(k) || 0) < 60000, room: r ? r.room : null, mode: r ? r.mode : null, st: r ? r.st : 0 }; }), rq: u.frq, inv, pinv: rk.pinv(me) };
 }
 if (p === '/api/setav') {
 if (b.img !== undefined) { // eigenes Bild hochladen (höchstens alle 10 s)
 if (Date.now() - (u.avUp || 0) < 10000) return { err: 'Bitte kurz warten und dann nochmal.' };
 const im = avImg(b.img); if (!im) return { err: 'Bild ungültig oder zu groß (nur PNG, JPEG oder WebP).' };
 u.avImg = im.data; u.avM = im.mime; u.avV = (u.avV || 0) + 1; u.avUp = Date.now(); persist(); return { ok: 1, av: avOf(u) };
 }
 const a = Math.floor(+b.av); if (!(a >= -1 && a < AV_N)) return { err: 'Ungültiges Profilbild.' }; delete u.avImg; delete u.avM; if (a < 0) delete u.av; else u.av = a; persist(); return { ok: 1, av: avOf(u) };
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
 let p; try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
 if (p.startsWith('/av/')) { // hochgeladenes Profilbild – nur als Bild, nie als Seite/Skript
 const t = USERS[p.slice(4).toLowerCase()];
 if (!t || !t.avImg || !AV_SIG[t.avM]) { res.writeHead(404, { 'Cache-Control': 'no-cache' }); res.end(); return; }
 res.writeHead(200, { 'Content-Type': t.avM, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline', 'Cache-Control': 'public, max-age=86400' }); // ?v=Version im Link → neues Bild sofort sichtbar
 res.end(Buffer.from(t.avImg, 'base64')); return;
 }
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
setInterval(() => rk.tick(), 1000).unref();
setInterval(() => { for (const c of wss.clients) { if (c.alive === false) { c.terminate(); continue; } c.alive = false; try { c.ping(); } catch { } } }, 20000).unref(); // 2× keine Antwort (≤ 40 s) → trennen → Host-Wechsel & Ranked-Regeln greifen
wss.on('connection', ws => {
 ws.alive = true; ws.on('pong', () => { ws.alive = true; });
 ws.on('message', raw => {
 let m; try { m = JSON.parse(raw) } catch { return } if (!m || typeof m !== 'object') return;
 if (typeof m.type === 'string' && m.type.startsWith('rk')) { rk.queueMsg(ws, m); return; } // Ranked-Warteschlange; rk*-Nachrichten nie weiterleiten
 if (m.type === 'rooms') {
 const list = [...rooms.entries()].filter(([name]) => !name.startsWith('rk_')).map(([name, r]) => ({ name, n: r.clients.length, st: r.started ? 1 : 0, mode: r.mode || null })).filter(r => r.n > 0);
 ws.send(JSON.stringify({ type: 'rooms', rooms: list }));
 return;
 }
 if (m.type === 'join') {
 ws.room = m.room; ws.pid = m.pid; const au = byTok(m.acc); if (au) ws.acc = au.name.toLowerCase(); // Account → Freunde sehen, in welchem Raum man ist
 if (!rk.join(ws, m.room)) { ws.room = null; return; } // Ranked-Raum: nur Spieler des Matches
 if (!rooms.has(m.room)) rooms.set(m.room, { clients: [], hostPid: null });
 const r = rooms.get(m.room);
 const isHost = r.clients.length === 0;
 if (isHost) r.hostPid = m.pid;
 ws.send(JSON.stringify({ type: 'joined', host: isHost }));
 r.clients.push(ws); rk.joined(ws);
  } else if (ws.room) {
 const r = rooms.get(ws.room);
 if (m.type === 'chat') { if (typeof m.t !== 'string' || !m.t.trim() || m.t.length > 160) return; const n = Date.now(); ws.chatT = (ws.chatT || []).filter(x => n - x < 5000); if (ws.chatT.length >= 5) return; ws.chatT.push(n); } // Chat: max. 160 Zeichen, 5 Nachrichten / 5 s
 if (r && (m.type === 'start' || m.type === 'glstart')) r.started = true;
 if (r && m.type === 'lmode') r.mode = m.mode;
 if (r && m.type === 'team') { // Zuschauer (Team „SPEC“): nur Customs, höchstens SPEC_MAX (auch der Host darf zuschauen – er rechnet das Spiel trotzdem weiter) – sonst ablehnen statt weiterleiten
 if (m.team === 'SPEC') { const why = ws.rk ? 'Im Ranked gibt es keine Zuschauer.' : r.mode && r.mode !== 'comp' ? 'Zuschauen geht nur in Customs.' : r.clients.filter(c => c !== ws && c.spec).length >= SPEC_MAX ? 'Alle ' + SPEC_MAX + ' Zuschauerplätze sind belegt.' : '';
 if (why) { ws.send(JSON.stringify({ type: 'specdeny', why })); return; } ws.spec = true; } else ws.spec = false;
 }
 let out = raw.toString(); if (m.type === 'hello' || m.type === 'hello2') { if (m.team === 'SPEC' && !ws.spec) m.team = 'CT'; const a = ws.acc && USERS[ws.acc]; m.acc = a ? a.name : null; m.av = a ? avOf(a) : -1; m.bd = a ? bdOf(a) : ''; out = JSON.stringify(m); } // Account, Profilbild & Badges vom Server (nicht fälschbar)
 if (ws.rk && r) { out = rk.msg(ws, r, m, out); if (out === false) return; } // Ranked: Server zählt mit & prüft
 for (const c of (r ? r.clients : []))
 if (c !== ws && c.readyState === 1) c.send(out);
 }
 });
 ws.on('close', () => {
 rk.wsClose(ws); if (!ws.room) return;
 const r = rooms.get(ws.room); if (!r) return;
 const i = r.clients.indexOf(ws); if (i >= 0) r.clients.splice(i, 1);
 for (const c of r.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'leave', pid: ws.pid }));
 rk.leave(ws);
 if (r.clients.length === 0) { rooms.delete(ws.room); return; }
 if (ws.pid === r.hostPid) {
 const next = r.clients.find(c => !c.spec) || r.clients[0]; // Zuschauer werden nur Host, wenn keine Spieler mehr da sind
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