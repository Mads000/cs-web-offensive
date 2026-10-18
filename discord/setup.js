// CLUTCH – Discord-Server einrichten (Aufbau wie „Die OG's“)
// Start:  TOKEN=... GUILD=... node setup.js            → richtet alles einmal ein und beendet sich
//         TOKEN=... GUILD=... node setup.js --bleiben  → bleibt online, damit „Join To Create“ funktioniert
// Mehrfach starten ist ok: Vorhandene Rollen/Kanäle (gleicher Name) werden übersprungen, nicht doppelt angelegt.
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits: P, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const TOKEN = process.env.TOKEN, GUILD = process.env.GUILD, BLEIBEN = process.argv.includes('--bleiben');
const SPIEL_URL = 'https://clutchtactic.de', ALTE_URL = 'https://cs-web-offensive.onrender.com'; // alte Adresse wird in bereits geposteten Bot-Nachrichten ersetzt
if (!TOKEN || !GUILD) { console.error('❌ TOKEN und GUILD fehlen – Beispiel: TOKEN=abc GUILD=123 node setup.js'); process.exit(1); }

// ── Rollen (oben = höchste) ──
const ROLLEN = [
    { name: '👑 Owner', color: 0xe8c98a, hoist: true, perms: [P.Administrator] },
    { name: '🛡️ Moderator', color: 0x5aa0ff, hoist: true, perms: [P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.MuteMembers, P.MoveMembers, P.DeafenMembers, P.ManageNicknames] },
    { name: '🤖 Bot', color: 0x8fa3b8, hoist: false, perms: [] },
    { name: '🎮 Spieler', color: 0x9fe08a, hoist: true, perms: [] }
];

// ── Kategorien & Kanäle (Stil wie bei „Die OG's“: -----Name----- und Emoji-Präfix) ──
// typ: t = Text, v = Sprache · nurLesen = nur Mods/Owner schreiben · privat = nur Mods sehen
const norm = n => String(n).toLowerCase().replace(/[^a-z0-9äöüß]/g, ''); // Kanalnamen ohne Emojis/Striche vergleichen
const T = ChannelType.GuildText, V = ChannelType.GuildVoice, F = ChannelType.GuildForum; // F = Forum: jeder Beitrag ein eigener Chat (Ticket)
const KATEGORIEN = [
    { name: '-----Moderation-----', privat: true, kanaele: [
        { name: '🔒-owner-notizen', typ: T, nurOwner: true, topic: 'Nur für den Owner: Wichtiges speichern (Links, Codes, Ideen, To-dos)' },
        { name: 'bot', typ: T, topic: 'Bot-Befehle & Logs' },
        { name: 'moderator-only', typ: T, topic: 'Absprachen im Mod-Team' },
        { name: '📦-itch-io', typ: T, topic: 'Alles für die itch.io-Seite: Anleitung, Texte zum Kopieren, Cover, Screenshots & Upload-Datei', itch: true },
        { name: 'Mod VC', typ: V }] },
    { name: '-----Server-----', kanaele: [
        { name: '👋-willkommen', typ: T, nurLesen: true, topic: 'Hier wird jeder neue Spieler begrüßt', text: 'willkommen', willkommen: true },
        { name: '📜-regelwerk', typ: T, nurLesen: true, topic: 'Die Regeln – bitte lesen!', text: 'regeln' },
        { name: '🆕-neuigkeiten', typ: T, nurLesen: true, topic: 'Patchnotes & Updates zu CLUTCH', text: 'news' },
        { name: '📡-server-status', typ: T, nurLesen: true, topic: 'Live: Ist der Spielserver online, wie viele spielen gerade? (aktualisiert sich automatisch)' },
        { name: '📈-vorschläge', typ: T, topic: 'Ideen für neue Modi, Maps, Skins … (Ein Vorschlag pro Nachricht, abstimmen mit 👍 / 👎)' },
        { name: '🐞-bug-tickets', typ: F, topic: 'Jeder Bug = ein eigenes Ticket. Meldungen aus dem Spiel landen automatisch hier. Selbst melden: „Neuer Beitrag“ → Was ist passiert? Modus/Karte? Handy oder PC? Screenshot hilft!', tags: ['🆕 Offen', '🔧 In Arbeit', '✅ Behoben', '❌ Kein Bug'] }] },
    { name: '-----Communitytalk-----', kanaele: [
        { name: '💬-allgemein', typ: T, topic: 'Quatschen über alles' },
        { name: '🎬-clips-und-highlights', typ: T, topic: 'Aces, Clutches, Headshots – zeig her!' },
        { name: '🤝-mitspielersuche', typ: T, topic: 'Mitspieler finden: im Spiel in der Lobby „📣 Discord“ drücken oder hier /lobby raum:… eingeben – mit Beitreten-Knopf' },
        { name: '🗺️-maps-und-arenen', typ: T, topic: 'Eigene Karten aus dem Map-Editor teilen: Rechtsklick → Code kopieren (CSWO:…) und hier posten' },
        { name: '🎨-skins', typ: T, topic: 'Eure Community-Skins aus der Skin-Werkstatt zeigen' },
        { name: '👀-wer-bin-ich', typ: T, topic: 'Stell Dich vor: Name im Spiel, Lieblingswaffe, Lieblingsmodus' }] },
    { name: '-----Sprachkanäle-----', kanaele: [
        { name: 'Join To Create', typ: V, jtc: true },
        { name: '💬| einfach reden', typ: V },
        { name: '🎮| gaming', typ: V },
        { name: '🔈-AFK', typ: V, afk: true }] }
];

const TEXTE = {
    regeln: `# 📜 Regelwerk – CLUTCH
**1. Respekt** – Kein Beleidigen, Mobben, Rassismus oder Hetze. Trashtalk ja, persönlich werden nein.
**2. Kein Spam** – Keine Werbung, keine Kettenbriefe, kein Massen-Pingen.
**3. Fair spielen** – Cheats, Exploits oder Bug-Ausnutzen sind verboten. Bugs bitte in <#BUGS> melden.
**4. Passende Kanäle** – Mitspieler in <#MITSPIELER>, Ideen in <#VORSCHLAEGE>, Karten in <#MAPS>.
**5. Keine NSFW-Inhalte** – Auch nicht in Namen, Profilbildern oder Skins.
**6. Mods haben das letzte Wort** – Bei Problemen einen 🛡️ Moderator anschreiben.

Verstöße: Verwarnung → Timeout → Kick → Bann.
🎮 Spiel im Browser: ${SPIEL_URL}`,
    news: `# 🆕 Willkommen bei CLUTCH!
Taktik-Shooter direkt im Browser – offline gegen Bots oder online mit Freunden. Auf PC und Handy.
🎮 **Jetzt spielen:** ${SPIEL_URL}
Hier erscheinen alle Patchnotes 👇`,
    willkommen: `# 👋 Willkommen bei CLUTCH!
Schön, dass Du da bist! Jeder neue Spieler wird hier begrüßt.
📜 Lies zuerst das <#REGELN> · 🆕 Updates in <#NEWS> · 🤝 Mitspieler in <#MITSPIELER>
🎮 **Jetzt spielen:** ${SPIEL_URL}`
};
// ── 📦 itch.io: Anleitung + Texte zum Kopieren + Dateien aus discord/itch/ (wird bei jedem Start neu gepostet) ──
const BT = '```', ITCH = [
`# 📦 itch.io – Schritt für Schritt
**1. Account:** https://itch.io/register → einloggen
**2. Neues Projekt:** oben rechts auf Deinen Namen → **Upload new project** (oder https://itch.io/game/new)
**3. Oben ausfüllen** (Texte zum Kopieren weiter unten 👇)
> **Title:** \`CLUTCH\` · **Project URL:** \`clutch\`
> **Short description or tagline:** siehe unten
> **Classification:** Games · **Kind of project:** HTML
> **Release status:** In development · **Pricing:** No payments (oder *$0 or donate* für Spenden)
**4. Uploads:** \`clutch-itch.zip\` (ganz unten angehängt) hochladen → Haken bei **This file will be played in the browser**
> Optional zusätzlich die PC-App \`CS-WO-Setup.exe\` (GitHub-Release) hochladen → Haken bei **Windows**
**5. Embed options:** *Embed in page* · Viewport **1280 × 720**
> ☑ **Mobile friendly** (Orientation: *Landscape*) · ☑ **Fullscreen button** · ☐ Automatically start on page load · ☐ Enable scrollbars
**6. Details:** Description (EN + DE unten) · **Genre:** Shooter · **Tags** (unten) · **AI disclosure:** ehrlich beantworten
**7. Bilder:** **Cover image** = \`cover-630x500.png\` · **Screenshots** = \`screenshot-1\` bis \`-6\` in dieser Reihenfolge · **Banner** = \`banner-960x240.png\` (über *Edit theme* → Banner)
**8. Links:** Discord & Website stehen schon in der Beschreibung
**9. Visibility:** erst **Draft** → **Save & view page** → alles testen → dann **Public** → Save`,
`## ⚠️ Gut zu wissen
• Die ZIP lädt das **Live-Spiel** von https://clutchtactic.de – jedes Update ist sofort auch auf itch.io, **nie neu hochladen** nötig.
• Spielstand: Auf itch.io hat der Browser einen **eigenen Speicher**. Gäste starten dort bei 0 – **mit Login** kommt alles mit (Cloud-Save).
• **Testen:** ins Spiel klicken (Maus wird gefangen), Vollbild-Knopf, Online-Lobby, Login, einmal am Handy.
• **Edit theme** (oben auf Deiner itch-Seite): Hintergrund \`#0c121a\` · Text \`#ece6df\` · Links/Buttons \`#8fa3b8\` – in den Farben des neuen Icons; Banner hochladen, Titel ausblenden.
• Danach den itch-Link in Discord #🆕-neuigkeiten posten 🎉`,
`## ✏️ Short description or tagline
${BT}
Free tactical 5v5 shooter in your browser – plant the bomb, win the clutch. Solo vs bots or online with friends.
${BT}
## 🏷️ Tags (einzeln eintippen, max. 10)
${BT}
fps, shooter, tactical, multiplayer, first-person, low-poly, browser, aim-trainer, level-editor, free
${BT}`,
`## 📝 Description (English) – oben in die Beschreibung
${BT}
CLUTCH is a fast tactical shooter that runs right in your browser – no download, no account needed. Play solo against bots or online with friends, on PC and mobile.

🏆 COMPETITIVE – 5v5, plant or defuse the bomb, buy weapons & armor every round
💀 DEATHMATCH – everyone vs everyone, instant respawn, 30 kills to win
⚔️ GAUNTLET – duo tournament with draft, perks & abilities
🎯 1v1 – aim duels with the same weapon, first to 5 wins
🦆 DUCK HUNT – relaxed 2-minute mode with specials & leaderboard
🎯 AIM LAB – Gridshot, Flick, Precision & Tracking

FEATURES
• Counter-strafing, spray patterns & tagging like the classics
• Skins, cases, knives (Butterfly & Karambit) & agents
• Skin workshop – paint your own skins and sell them in the shop
• Map & arena editor – build maps and share them as a code
• Friends list, invites, team chat & all chat
• Stats: K/D, accuracy, headshot rate, favorite weapon
• Accounts with cloud save – your progress on every device
• English & German

CONTROLS (PC)
WASD move · Mouse aim & shoot · R reload · B buy menu · Tab scoreboard
Shift walk · Ctrl crouch · Space jump · Q last weapon · G drop · F ability
Enter team chat · Shift+Enter all chat · all keys can be changed in the settings

💬 Discord: https://discord.gg/tEBHrXvVzn
🌐 Play directly: https://clutchtactic.de
${BT}`,
`## 📝 Beschreibung (Deutsch) – darunter einfügen
${BT}
🇩🇪 DEUTSCH
CLUTCH ist ein schneller Taktik-Shooter direkt im Browser – kein Download, kein Account nötig. Allein gegen Bots oder online mit Freunden, am PC und am Handy.

🏆 Wettkampf (5 gegen 5, Bombe legen & entschärfen) · 💀 Deathmatch · ⚔️ Gauntlet (Duo-Turnier mit Perks) · 🎯 1v1 · 🦆 Entenjagd · 🎯 Aim-Lab

Skins, Cases, Messer & Agenten · eigene Skins malen und verkaufen · Map- & Arena-Editor · Freunde, Einladungen, Team- & Allgemein-Chat · Statistik · Cloud-Save mit Account

💬 Discord: https://discord.gg/tEBHrXvVzn
🌐 Direkt spielen: https://clutchtactic.de
${BT}`
];
const ITCH_DATEIEN = [ // [Text, Dateien] – max. 10 MB pro Nachricht
    ['## 🖼️ Cover, Banner & Screenshots 1–3', ['cover-630x500.png', 'banner-960x240.png', 'screenshot-1-menu.png', 'screenshot-2-deathmatch.png', 'screenshot-3-kaufmenue.png']],
    ['## 🖼️ Screenshots 4–6', ['screenshot-4-aimlab.png', 'screenshot-5-entenjagd.png', 'screenshot-6-mapeditor.png']],
    ['## 📦 Upload-Datei für itch.io (bei *Uploads* hochladen)', ['clutch-itch.zip']]];
async function posteItch(ch) {
    const fs = require('fs'), path = require('path'), dir = path.join(__dirname, 'itch'), alt = await ch.messages.fetch({ limit: 100 }).catch(() => new Map());
    const mine = [...alt.values()].filter(m => m.author.id === client.user.id);
    if (mine.length && !process.argv.includes('--itch')) { console.log('  📦 itch.io-Paket ist schon da – übersprungen (neu posten: node setup.js --itch)'); return; }
    for (const m of mine) await m.delete().catch(() => { }); // nur mit --itch: alte Version ersetzen
    for (const t of ITCH) await ch.send(t);
    for (const [t, fl] of ITCH_DATEIEN) { const files = fl.map(f => path.join(dir, f)).filter(f => fs.existsSync(f)); if (files.length) await ch.send({ content: t, files }); }
    console.log('  📦 itch.io-Paket gepostet in ' + ch.name);
}
const GRUSS = [ // zufällige Begrüßung für neue Mitglieder ({u} = Erwähnung)
    '👋 Willkommen {u}! Schnapp Dir eine AK und ab in die Lobby.', '🎯 {u} ist gelandet – hoffentlich mit gutem Aim!',
    '💣 {u} ist da. Bombe gelegt, Server betreten.', '🦆 {u} ist beigetreten – die Enten zittern schon.', '🔥 {u} hat den Server betreten. Clutch-Zeit!'
];

// Patchnotes kommen aus ../patchnotes.js (dieselbe Funktion nutzt server.js für den Auto-Post nach jedem Deploy)
const { patchnotes, stuecke } = require('../patchnotes'), AB_VERSION = 1.7;
async function postePatches(ch) {
    const alt = await ch.messages.fetch({ limit: 100 }).catch(() => new Map()), schon = new Set();
    for (const msg of alt.values()) { const v = (msg.content.match(/^# 📢 Patch ([\d.]+)/) || [])[1]; if (v) schon.add(v); } // bereits gepostete Patches überspringen
    for (const p of patchnotes(AB_VERSION)) { if (schon.has(p.v)) continue; for (const s of stuecke(p.titel + '\n' + p.body)) await ch.send(s); console.log('  📢 Patch ' + p.v + ' gepostet'); }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(BLEIBEN ? [GatewayIntentBits.GuildMembers] : [])] }); // GuildMembers: Begrüßung (im Developer-Portal „Server Members Intent“ einschalten)
let K = {}, R = {};

client.once('ready', async () => {
    console.log('✅ Eingeloggt als ' + client.user.tag);
    const g = await client.guilds.fetch(GUILD).catch(() => null);
    if (!g) { console.error('❌ Server nicht gefunden – stimmt die GUILD-ID und ist der Bot eingeladen?'); process.exit(1); }
    await g.roles.fetch(); await g.channels.fetch();

    // Rollen
    for (const r of ROLLEN) {
        R[r.name] = g.roles.cache.find(x => x.name === r.name) || await g.roles.create({ name: r.name, color: r.color, hoist: r.hoist, permissions: r.perms, reason: 'CLUTCH-Setup' });
        console.log('  Rolle: ' + r.name);
    }
    const mod = R['🛡️ Moderator'], ev = g.roles.everyone;

    // Kategorien & Kanäle
    let afk = null, will = null;
    for (const k of KATEGORIEN) {
        const ow = k.privat ? [{ id: ev.id, deny: [P.ViewChannel] }, { id: mod.id, allow: [P.ViewChannel] }] : [];
        const cat = g.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === k.name) || await g.channels.create({ name: k.name, type: ChannelType.GuildCategory, permissionOverwrites: ow });
        console.log(k.name);
        for (const c of k.kanaele) {
            let ch = g.channels.cache.find(x => x.parentId === cat.id && x.name === c.name.toLowerCase().replace(/ /g, c.typ === T ? '-' : ' ') || x.parentId === cat.id && x.name === c.name)
                || g.channels.cache.find(x => x.type === c.typ && norm(x.name) === norm(c.name)); // auch verschobene/leicht umbenannte Kanäle wiedererkennen → nie doppelt anlegen
            if (!ch) {
                const o = c.nurOwner ? [{ id: ev.id, deny: [P.ViewChannel] }, { id: mod.id, deny: [P.ViewChannel] }, { id: R['👑 Owner'].id, allow: [P.ViewChannel] }] : [...ow]; if (c.nurLesen) o.push({ id: ev.id, deny: [P.SendMessages, P.CreatePublicThreads] }, { id: mod.id, allow: [P.SendMessages] });
                ch = await g.channels.create({ name: c.name, type: c.typ, parent: cat.id, topic: c.topic, permissionOverwrites: o, ...(c.tags ? { availableTags: c.tags.map(name => ({ name })) } : {}) });
                if (c.text) K['text:' + c.name] = { ch, key: c.text };
            }
            K[c.name] = ch; if (c.afk) afk = ch; if (c.willkommen) will = ch;
            console.log('  ' + (c.typ === V ? '🔊 ' : '# ') + ch.name);
        }
    }
    if (afk) await g.setAFKChannel(afk).catch(() => { });
    await g.setAFKTimeout(900).catch(() => { });
    // Discords eigene Beitritts-Nachricht landet im Willkommen-Kanal (klappt auch ohne laufenden Bot);
    // läuft der Bot (--bleiben), übernimmt er die Begrüßung selbst → Discords Meldung solange aus, beim Beenden wieder an
    const SUP = 1 << 0; // SystemChannelFlags.SuppressJoinNotifications
    if (will) { await g.setSystemChannel(will).catch(() => { }); await g.setSystemChannelFlags(BLEIBEN ? g.systemChannelFlags.add(SUP) : g.systemChannelFlags.remove(SUP)).catch(() => { }); }
    if (BLEIBEN) process.on('SIGINT', async () => { await g.setSystemChannelFlags(g.systemChannelFlags.remove(SUP)).catch(() => { }); client.destroy(); process.exit(0); });

    // Texte nur in neu erstellte Kanäle posten (Kanal-Links einsetzen)
    const link = n => K[n] ? '<#' + K[n].id + '>' : '#' + n;
    for (const k in K) if (k.startsWith('text:')) {
        const { ch, key } = K[k];
        const txt = TEXTE[key].replace('<#REGELN>', link('📜-regelwerk')).replace('<#NEWS>', link('🆕-neuigkeiten')).replace('<#BUGS>', link('🐞-bug-tickets')).replace('<#MITSPIELER>', link('🤝-mitspielersuche')).replace('<#VORSCHLAEGE>', link('📈-vorschläge')).replace('<#MAPS>', link('🗺️-maps-und-arenen'));
        await ch.send(txt); console.log('  ✉ Text gepostet in ' + ch.name);
    }
    for (const ch of Object.values(K)) if (ch.type === T) { // alte Spiel-Adresse in schon geposteten Bot-Nachrichten ersetzen
        const ms = await ch.messages.fetch({ limit: 50 }).catch(() => new Map());
        for (const m of ms.values()) if (m.author.id === client.user.id && m.content.includes(ALTE_URL)) { await m.edit(m.content.split(ALTE_URL).join(SPIEL_URL)).catch(() => { }); console.log('  🔗 Link aktualisiert in ' + ch.name); }
    }
    // Patchnotes postet der Spielserver selbst nach jedem Deploy (nur neue) – das Setup schickt keine alten mehr
    if (K['📦-itch-io']) await posteItch(K['📦-itch-io']); // Patchnotes ab 1.7 (fehlende werden nachgetragen)

    // Webhooks: darüber postet der Spielserver (Render) selbst – Patchnotes, Live-Status, Mitspielersuche, Bug-Meldungen
    const hook = async n => { const ch = K[n]; if (!ch) return ''; const ws = await ch.fetchWebhooks(); const w = ws.find(x => x.name === 'CLUTCH' && x.token) || await ch.createWebhook({ name: 'CLUTCH' }); return w.url; };
    const HOOKS = { DISCORD_NEWS_WEBHOOK: await hook('🆕-neuigkeiten'), DISCORD_STATUS_WEBHOOK: await hook('📡-server-status'), DISCORD_LFG_WEBHOOK: await hook('🤝-mitspielersuche'), DISCORD_BUG_WEBHOOK: await hook('🐞-bug-tickets') };

    console.log('\n🔗 Webhooks – bei Render unter Environment eintragen (Bot-Webhooks lassen sich in Discord nicht kopieren):\n' + Object.entries(HOOKS).map(([k, v]) => '   ' + k + '=' + v).join('\n') + '\n');
    // 🔒 Owner-Notizen: Links & Codes (eigene Nachricht wird bei jedem Start aktualisiert statt doppelt gepostet)
    const own = K['🔒-owner-notizen'];
    if (own) {
        let pub = '?'; try { pub = (require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8').match(/PUBLISH_CODE = '([^']*)'/) || [])[1] || '?'; } catch (e) { }
        const txt = `# 📌 Links & Codes
🎮 **Spiel:** ${SPIEL_URL}
🛠 **Render (Hosting):** https://dashboard.render.com
💾 **GitHub:** https://github.com/Mads000/cs-web-offensive
🤖 **Discord Developer Portal:** https://discord.com/developers/applications
☁️ **Accounts-Gist:** https://gist.github.com – die ID steht bei Render unter \`GIST_ID\`

🔑 **Veröffentlichungs-Code** (Community-Karten & Shop-Preise): ||${pub}||
🧪 **Debug-Code:** steht bei Render als \`DEBUG_CODE\` (nicht im Code)
🔐 **Bot-Token:** nur im Developer Portal → Bot → Reset Token (hier nicht speichern!)

## 🔗 Webhooks → bei Render unter *Environment* eintragen
\`\`\`
${Object.entries(HOOKS).map(([k, v]) => k + '=' + v).join('\n')}
\`\`\`
Danach postet der Spielserver selbst: neue Patchnotes nach jedem Deploy, Live-Status, Mitspielersuche & Bug-Meldungen aus dem Spiel.`;
        const alt = (await own.messages.fetch({ limit: 50 }).catch(() => new Map())), mine = [...alt.values()].find(m => m.author.id === client.user.id && m.content.startsWith('# 📌 Links & Codes'));
        if (mine) await mine.edit(txt); else await (await own.send(txt)).pin().catch(() => { });
        console.log('  📌 Links & Codes in 🔒-owner-notizen ' + (mine ? 'aktualisiert' : 'gepostet'));
    }

    // Slash-Befehl /lobby (nur solange der Bot läuft): Mitspieler suchen mit Beitreten-Knopf
    if (BLEIBEN) await g.commands.set([{ name: 'lobby', description: 'Mitspieler suchen – postet Deinen Raum mit Beitreten-Knopf', options: [
        { name: 'raum', description: 'Raumname im Spiel', type: 3, required: true, max_length: 30 },
        { name: 'modus', description: 'Spielmodus', type: 3, required: false, choices: [['🏆 Wettkampf', 'comp'], ['💀 Deathmatch', 'dm'], ['⚔️ Gauntlet', 'gl'], ['🎯 1v1', 'v1'], ['🦆 Entenjagd', 'duck']].map(([name, value]) => ({ name, value })) },
        { name: 'text', description: 'z. B. „brauchen noch 2“', type: 3, required: false, max_length: 100 }] }]).catch(e => console.error('Slash-Befehl:', e.message));

    console.log('\n🎉 Fertig! ' + (BLEIBEN ? 'Bot bleibt online für „Join To Create“ (Strg+C zum Beenden).' : 'Der Bot beendet sich jetzt.'));
    if (!BLEIBEN) { client.destroy(); process.exit(0); }
});

// /lobby → Nachricht mit „Beitreten“-Knopf (Link öffnet das Spiel direkt in diesem Raum)
const MODI = { comp: '🏆 Wettkampf', dm: '💀 Deathmatch', gl: '⚔️ Gauntlet', v1: '🎯 1v1', duck: '🦆 Entenjagd' };
client.on('interactionCreate', async i => {
    if (!i.isChatInputCommand() || i.commandName !== 'lobby') return;
    try {
        const raum = i.options.getString('raum').trim(), modus = i.options.getString('modus') || 'comp', txt = i.options.getString('text');
        const url = SPIEL_URL + '/?join=' + encodeURIComponent(raum) + '&mode=' + modus;
        await i.reply({ content: `🤝 **${i.member.displayName}** sucht Mitspieler!\n🎮 Raum **${raum}** · ${MODI[modus]}${txt ? '\n💬 ' + txt : ''}`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('▶ Beitreten').setURL(url))], allowedMentions: { parse: [] } });
    } catch (e) { console.error('/lobby:', e.message); }
});

// Neue Mitglieder: Rolle 🎮 Spieler geben und im Willkommen-Kanal begrüßen (nur mit --bleiben)
client.on('guildMemberAdd', async m => {
    try {
        if (m.user.bot) return; const r = R['🎮 Spieler']; if (r) await m.roles.add(r).catch(() => { });
        const ch = K['👋-willkommen'], lk = n => K[n] ? '<#' + K[n].id + '>' : '#' + n; if (!ch) return;
        await ch.send(GRUSS[Math.floor(Math.random() * GRUSS.length)].replace('{u}', '<@' + m.id + '>') + `\nDu bist Mitglied **#${m.guild.memberCount}** · 📜 ${lk('📜-regelwerk')} · 🤝 ${lk('🤝-mitspielersuche')} · 🎮 ${SPIEL_URL}`);
    } catch (e) { console.error('Begrüßung:', e.message); }
});

// „Join To Create“: Wer den Kanal betritt, bekommt einen eigenen Sprachkanal; leer → wird gelöscht
const EIGENE = new Set();
client.on('voiceStateUpdate', async (alt, neu) => {
    if (!BLEIBEN) return;
    try {
        if (neu.channel && neu.channel.name === 'Join To Create') {
            const ch = await neu.guild.channels.create({ name: '🔊| ' + (neu.member.displayName || 'Raum').slice(0, 20), type: V, parent: neu.channel.parentId, permissionOverwrites: [{ id: neu.member.id, allow: [P.ManageChannels, P.MoveMembers] }] });
            EIGENE.add(ch.id); await neu.member.voice.setChannel(ch);
        }
        if (alt.channel && EIGENE.has(alt.channel.id) && alt.channel.members.size === 0) { EIGENE.delete(alt.channel.id); await alt.channel.delete(); }
    } catch (e) { console.error('Join To Create:', e.message); }
});

client.login(TOKEN).catch(e => { console.error('❌ Login fehlgeschlagen: ' + e.message); process.exit(1); });
