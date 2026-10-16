// Patchnotes aus den News im Spiel (public/index.html) lesen → Discord-Markdown.
// Genutzt von server.js (Auto-Post nach Deploy) und discord/setup.js (Nachtragen).
const fs = require('fs'), path = require('path');
function patchnotes(minV = 0) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'), out = [];
    const re = /<div class="cspanel newscard"><h3>([^<]*)<\/h3>([\s\S]*?)<\/div><\/div>/g; let m;
    while ((m = re.exec(html))) {
        const k = m[1].match(/PATCH\s*([\d.]+)\s*„?([^"“”]*)/i); if (!k || +k[1] < minV) continue;
        const body = m[2].replace(/\s*\n\s*/g, ' ').replace(/<p[^>]*>([\s\S]*?)<\/p>/g, '\n**$1**\n').replace(/<\/?b>/g, '**').replace(/<\/?i>/g, '*').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
            .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        out.push({ v: k[1], titel: `# 📢 Patch ${k[1]} „${k[2].trim()}“`, body });
    }
    return out.sort((a, b) => +a.v - +b.v); // älteste zuerst
}
// Discord erlaubt max. 2000 Zeichen pro Nachricht → zeilenweise aufteilen
function stuecke(text) { const t = []; let s = ''; for (const l of text.split('\n')) { if ((s + '\n' + l).length > 1900) { t.push(s); s = l; } else s = s ? s + '\n' + l : l; } if (s) t.push(s); return t; }
module.exports = { patchnotes, stuecke };
