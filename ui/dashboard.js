'use strict';
/*
 * MyDealz AI Exporter — Dashboard-Cockpit (MV3, Vanilla, kein Build).
 *
 * Das Dokument läuft in zwei Rollen:
 *   1. iframe im <dialog> der Deal-Seite (content/content.js) — Analyse-Cockpit.
 *   2. Popup (ui/popup.html) — nur der API-Key-Block (initPopupSettings()).
 *
 * Bewusst KEIN Kommentar-Browser mehr: gelesen wird auf mydealz.de, hier
 * stehen nur Deal-Scan, KI-Analyse und Export. Das hält die Datei tief
 * (Ousterhout) statt breit: ein Zweck, viel Verhalten hinter schmaler Fläche.
 */

let deal = null;

/* [anchor:ssot-principle] Das kanonische Columnar-JSON wird genau einmal in
   content/content.js (collectExport → serializeColumnar) erzeugt und mit dem
   Payload übertragen. Hier wird es nur noch gelesen — kein zweiter
   Serialisierer, keine driftende Kopie von LLM_GUIDE/COLUMNAR_COLUMNS. */
function exportJson() { return deal.jsonString || ''; }

/* Markdown-Kopf: macht den Export ohne Begleitprompt lesbar (HTML-Kommentar,
   damit die gerenderte Ansicht sauber bleibt). */
const MD_GUIDE = `<!--
🤖 LLM INSTRUCTION & SCHEMA GUIDE:
Konzept: [anchor:ssot-principle] & [anchor:separation-of-concerns]
Datensatz: Vollständiger Community- und Kommentar-Export von mydealz.de.
1. Deal-Kopf & 📊 Deal-Scan: Autoritative Fakten zu Angebot, Temperatur und Aktivität.
2. 📌 Autor*in: Verbindliche Status-Updates des Angebotserstellers (Gutscheine, Preisfehler, Verfügbarkeit).
3. Kommentare: Format '[Kommentar #ID] @Autor (Datum) [Score]':
   - '↳' kennzeichnet Antworten (hierarchische Ebenen 1–4).
   - 'auch:#ID' verweist auf weitere Kommentare desselben Nutzers.
Aufgabe: Untersuche Produktstärken/-schwächen, Händler-Seriosität, Fallstricke und erstelle präzise Kaufberatungen.
-->`;

/* Sechs Standardfragen. Kurz gehalten, damit sie in die 3x2-Kacheln passen;
   die Ausführlichkeit entsteht im Kontext (buildAIContext), nicht im Prompt. */
const PROMPTS = {
  summary: 'Fasse den Deal und die Kommentare zusammen (5-7 Saetze). Was ist das Angebot, was sagen die Nutzer?',
  sentiment: 'Stimmungsanalyse der Kommentare: positiv/negativ/gemischt. 3 konkrete Beispiele mit Kurzinhalten.',
  questions: 'Welche Fragen, Probleme oder Unsicherheiten wurden erwaehnt? Als Stichpunkte.',
  highlights: 'Die 5 wichtigsten Kommentare (Reaktionen/Replies/Inhalt). Erklaere kurz warum jeder wichtig ist.',
  problems: 'Berichte ueber Probleme, Fehler, Warnungen? Alles kritische zusammenfassen.',
  verdict: 'Lohnt sich der Deal? Pro/Contra-Liste und Fazit in 2 Saetzen.'
};

/* Score: noteworthy*4 + helpful*3 + replies*3 + like*2 + funny.
   Reihenfolge = Signalwert: „wertvoll“ und Diskussion schlagen reine Likes. */
function score(c) {
  const r = c.reactions || {};
  return (c.isNoteworthy ? 4 : 0) + (c.replyCount || 0) * 3 + (r.helpful || 0) * 3 + (r.like || 0) * 2 + (r.funny || 0);
}

function reactCount(c) {
  const r = c.reactions || {};
  return (r.like || 0) + (r.helpful || 0) + (r.funny || 0);
}

/* Alle Knoten (Roots + Replies) flach — Grundlage für Autor*in-Updates und
   Linkliste. Der Baum bleibt im Export erhalten, hier wird nur traversiert. */
function allNodes() {
  const out = [];
  const walk = c => {
    if (!c) return;
    out.push(c);
    (c.replies || []).forEach(walk);
  };
  (deal.comments || []).forEach(walk);
  return out;
}

function authorUpdates() {
  return allNodes().filter(c => c.isAuthor);
}

document.addEventListener('DOMContentLoaded', async () => {
  // In-Page-Overlay (iframe im <dialog> der Deal-Seite): Schließen-Button zeigen.
  // Im Tab-/Popup-Modus bleibt er verborgen (dort gibt es keinen Parent-Dialog).
  if (window.self !== window.top) {
    document.body.classList.add('mde-embedded');
    const close = () => window.parent.postMessage({ type: 'MDE_CLOSE' }, '*');
    document.getElementById('mde-close-btn')?.addEventListener('click', close);
    // Escape erreicht den Parent-Dialog nicht, wenn der Fokus im iframe liegt
    // (eigenes Dokument → eigener CloseWatcher) — deshalb hier explizit melden.
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  // Popup-Dokument? Dann NUR die Key-Einstellungen initialisieren.
  // (MV3 verbietet Inline-Scripts in extension_pages und erlaubt keine
  // CSP-Hashes — deshalb lebt der Popup-Code hier statt in popup.js.)
  if (document.getElementById('apiKey')) { initPopupSettings(); return; }

  const loadData = () => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_EXPORT_DATA' }, res => {
      if (res) return resolve(res);
      chrome.storage?.session?.get('pendingExport').then(s => resolve(s?.pendingExport || null)).catch(() => resolve(null));
    });
  });
  const data = await loadData();
  if (!data) { showError('Keine Daten. Bitte auf der Deal-Seite neu exportieren.'); return; }
  deal = data;
  renderMeta();
  renderStats();
  setupExport();
  setupAI();
});

/* ── Popup: Gemini-API-Key in chrome.storage.local ──
   Key nie loggen, nie exportieren, nur hier und in callAI() lesen. */
function initPopupSettings() {
  const keyInput = document.getElementById('apiKey');
  const savedMsg = document.getElementById('saved');
  chrome.storage.local.get(['geminiApiKey'], r => { if (r.geminiApiKey) keyInput.value = r.geminiApiKey; });
  document.getElementById('save').onclick = () => {
    const key = keyInput.value.trim();
    chrome.storage.local.set({ geminiApiKey: key }, () => {
      savedMsg.style.display = 'block';
      setTimeout(() => savedMsg.style.display = 'none', 2000);
    });
  };
}

/* ── Kopfzeile: Titel, Preis, Händler, Temperatur, Deal-Link ── */
function renderMeta() {
  const { meta } = deal;
  document.title = (meta.title || 'Deal') + ' – MDE';
  const facts = [
    meta.price ? `<span class="chip chip-price">${esc(meta.price)}</span>` : '',
    meta.merchant ? `<span class="chip">🏬 ${esc(meta.merchant)}</span>` : '',
    meta.temperature ? `<span class="chip chip-temp">🌡 ${esc(meta.temperature)}</span>` : ''
  ].filter(Boolean).join('');
  document.getElementById('meta-section').innerHTML =
    `<h1 class="meta-title">${esc(meta.title || '?')}</h1>`
    + `<div class="meta-facts">${facts}</div>`
    + `<a href="${esc(meta.url)}" target="_blank" rel="noopener noreferrer" class="deal-link">🔗 Deal öffnen</a>`;
}

/* ── Deal-Scan: sieben Kennzahlen, keine Filter mehr (Klick = nichts) ──
   Max-Level kommt aus content.js (tiefste Verschachtelung), autorCommentCount
   zählt alle Beiträge des Dealerstellers inkl. Replies. */
function renderStats() {
  const s = deal.stats || {};
  const r = s.reactions || {};
  const authorCount = s.authorCommentCount || 0;
  const hidden = s.totalHiddenReplies || 0;
  const card = (num, label, extra = '', title = '') =>
    `<div class="stat-card${extra}"${title ? ` title="${esc(title)}"` : ''}>`
    + `<div class="stat-num">${num}</div><div class="stat-lbl">${label}</div></div>`;

  const cards = [
    card(s.totalTopLevel ?? 0, 'Top-Level', '', 'Alle Top-Level-Kommentare'),
    card(s.totalRepliesVisible ?? 0, 'Replies', '', 'Sichtbare Antworten'),
    card(s.maxLevel || 0, 'Max-Level', '', 'Tiefste Verschachtelungsebene'),
    card(authorCount, '📌 Autor*in', authorCount ? ' author-card' : '', 'Beiträge des Dealerstellers'),
    card(r.like || 0, '👍 Likes', '', 'Kommentare mit 👍'),
    card(r.helpful || 0, '💡 Helpful', '', 'Kommentare mit 💡'),
    card(r.funny || 0, '😄 Funny', '', 'Kommentare mit 😄')
  ].join('');

  document.getElementById('stats-section').innerHTML = `<div class="stats-grid">${cards}</div>`
    + (hidden > 0 ? `<p class="warn-note">⚠ ${hidden} Replies nicht abrufbar (mydealz API-Limit)</p>` : '');
}

/* ── Linkliste pro Konversation (nur noch für den MD-Export) ── */
function collectLinks() {
  const out = [];
  const walk = c => {
    (c.links || []).forEach(l => out.push({ author: c.author, date: c.date, id: c.id, url: l.url, text: l.text }));
    (c.replies || []).forEach(walk);
  };
  (deal.comments || []).forEach(walk);
  return out;
}

function setupExport() {
  document.getElementById('btn-export-json').addEventListener('click', () => { download(exportJson(), 'mydealz-export.json', 'application/json'); flash('btn-export-json', '✅ Gestartet!'); });
  document.getElementById('btn-export-md').addEventListener('click', () => { download(buildMarkdown(), 'mydealz-export.md', 'text/markdown'); flash('btn-export-md', '✅ Gestartet!'); });
  document.getElementById('btn-copy-md').addEventListener('click', async () => { await navigator.clipboard.writeText(buildMarkdown()); flash('btn-copy-md', '✅ Kopiert!'); });
  document.getElementById('btn-copy').addEventListener('click', async () => { await navigator.clipboard.writeText(exportJson()); flash('btn-copy', '✅ Kopiert!'); });
  document.getElementById('ai-copy-btn').addEventListener('click', async () => { await navigator.clipboard.writeText(document.getElementById('ai-output').textContent); flash('ai-copy-btn', '✅'); });
}

/* Markdown: Link-Labels und Status-Updates dürfen die Struktur nicht sprengen
   (eckige Klammern beenden einen Link, Zeilenumbrüche eine Listenzeile). */
function mdInline(text) {
  return String(text ?? '').replace(/[\[\]]/g, '').replace(/\s*\n+\s*/g, ' ').trim();
}

/* Vollständiger Markdown-Export. Reihenfolge = Lesereihenfolge:
   Kopf → Beschreibung → Deal-Scan → Links → Autor*in-Updates → Thread-Baum. */
function buildMarkdown() {
  const { meta, comments, stats } = deal;
  const s = stats || {};
  const r = s.reactions || {};
  const lines = [
    MD_GUIDE,
    `# ${meta.title || 'Deal'}`,
    `**URL:** ${meta.url}`,
    `**Kommentare:** ${s.totalTopLevel ?? 0} Top-Level + ${s.totalRepliesVisible ?? 0} Replies`,
    meta.price ? `**Preis:** ${meta.price}` : '',
    meta.merchant ? `**Händler:** ${meta.merchant}` : '',
    meta.author ? `**Dealersteller:** @${meta.author} (${s.authorCommentCount || 0} Beiträge)` : '',
    s.totalHiddenReplies > 0 ? `⚠ ${s.totalHiddenReplies} Replies verborgen` : '',
    deal.incomplete ? `> ⚠️ **EXPORT UNVOLLSTÄNDIG** — Rate-Limit-Antwort. Gesichert: ${s.totalTopLevel ?? 0} Top-Level-Kommentare, ${s.totalRepliesVisible ?? 0} Replies.` : '',
    '',
    '---',
    ''
  ];
  if (meta.description) { lines.push(meta.description, '', '---', ''); }

  // Deal-Scan als eigener Block: der Leser sieht die Verteilung vor dem Text.
  lines.push('## 📊 Deal-Scan', '');
  lines.push(`- Top-Level: ${s.totalTopLevel ?? 0}`);
  lines.push(`- Replies: ${s.totalRepliesVisible ?? 0}`);
  lines.push(`- Max-Level: ${s.maxLevel || 0}`);
  lines.push(`- Autor*in-Beiträge: ${s.authorCommentCount || 0}`);
  lines.push(`- Reaktionen: 👍 ${r.like || 0} · 💡 ${r.helpful || 0} · 😄 ${r.funny || 0}`);
  lines.push('', '---', '');

  const links = collectLinks();
  if (links.length) {
    lines.push(`## 🔗 Links (${links.length})`, '');
    links.forEach(l => lines.push(`- @${l.author || '?'}: [${mdInline(l.text || l.url).slice(0, 100)}](${l.url})`));
    lines.push('', '---', '');
  }

  // Eigene Sektion: alle Beiträge des Dealerstellers gebündelt (auch Replies),
  // chronologisch — verbindliche Statusmeldungen zu Preis/Verfügbarkeit.
  const updates = authorUpdates();
  if (updates.length) {
    lines.push(`## 📌 Updates vom Dealersteller (${updates.length})`, '');
    updates.forEach(c => {
      const ctx = c.level > 0 ? ` · Antwort auf [Kommentar #${c.parentId || '?'}]` : '';
      lines.push(`- **[Kommentar #${c.id}]** (${c.date || '?'}${ctx}): ${mdInline(c.text || '(geloescht)')}`);
    });
    lines.push('', '---', '');
  }

  // Thread-Baum: Einrückung = Ebene, [Kommentar #ID] = stabile Referenz für LLMs.
  // Querverweise (authorRefs) machen Dialoge desselben Nutzers nachverfolgbar.
  const walk = (c, d) => {
    const p = '  '.repeat(d);
    const sc = score(c);
    const rel = (c.level > 0 || d > 0) ? `↳ Antwort auf [Kommentar #${c.parentId || '?'}] · ` : '';
    const refs = (c.authorRefs || []).length ? ` · auch von @${c.author}: ${c.authorRefs.map(id => `[Kommentar #${id}]`).join(' ')}` : '';
    lines.push(`${p}**[Kommentar #${c.id}]** **@${c.author}**${c.isAuthor ? ' 👑 Autor*in' : ''} (${c.date}) [${sc}]${sc >= 3 ? ' 🔥' : ''}: ${rel}${c.text || '(geloescht)'}${refs}`);
    if (c._hiddenReplies) lines.push(`${p}*(+${c._hiddenReplies} verborgen)*`);
    lines.push('');
    c.replies?.forEach(r2 => walk(r2, d + 1));
  };
  comments.forEach(c => walk(c, 0));
  return lines.filter(Boolean).join('\n');
}

function download(content, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

// ── Smart Context Builder ─────────────────────────────────────────────────
// Erkennt Query-Typ und baut minimalen Kontext:
// - Preis/Händler-Fragen → nur Deal-Header (kein Comment-Overhead)
// - Filter: !deleted && (reactions>=1 || replies>=1 || len>=50)
// - Kommentare sortiert nach Score, abgeschnitten bei ~20k Zeichen (Nano-Limit)
// - 300+ Kommentare → Map-Reduce (Batch-Zusammenfassungen)

const CONTEXT_LIMIT = 20000; // Zeichen (~5k Tokens, konservativ für Gemini Nano)
const PRICE_HINTS = ['preis', 'euro', 'kost', 'günstig', 'rabatt', 'prozent', 'discount', 'angebot', 'händler', 'merchant'];

function needsComments(prompt) {
  const p = String(prompt || '').toLowerCase();
  return !PRICE_HINTS.some(k => p.includes(k)) || p.includes('kommentar');
}

function dealHeader() {
  const { meta } = deal;
  return [
    `DEAL: ${meta.title}`,
    meta.price ? `PREIS: ${meta.price}` : '',
    meta.merchant ? `HAENDLER: ${meta.merchant}` : '',
    meta.temperature ? `TEMPERATUR: ${meta.temperature}` : ''
  ].filter(Boolean).join('\n');
}

function commentLine(c, depth) {
  const lvl = Number.isFinite(Number(c.level)) ? Number(c.level) : depth;
  const prefix = '  '.repeat(depth) + (lvl > 0 ? '↳ ' : '');
  const r = c.reactions || {};
  const rx = [r.like ? `like:${r.like}` : '', r.helpful ? `helpful:${r.helpful}` : '', r.funny ? `funny:${r.funny}` : ''].filter(Boolean).join(' ');
  const meta = [rx, c.replyCount > 0 ? `${c.replyCount}replies` : ''].filter(Boolean).join(' ');
  // [#id] + Autor*in-Marker + Querverweise: ein LLM kann Dialoge desselben
  // Nutzers ohne eigenen Index nachverfolgen (Cross-Linking).
  const refs = (c.authorRefs || []).length ? ` auch:#${c.authorRefs.join(' #')}` : '';
  return `${prefix}[#${c.id}]${c.isAuthor ? ' 📌Autor*in' : ''} @${c.author}${meta ? ` [${meta}]` : ''}${refs}: ${(c.text || '')}`;
}

function relevantComments() {
  // Autor*in-Beiträge sind immer relevant — auch kurze Status-Updates.
  return [...(deal.comments || [])]
    .sort((a, b) => score(b) - score(a))
    .filter(c => c.isAuthor || (!c.deleted && (reactCount(c) >= 1 || c.replyCount >= 1 || (c.text || '').length >= 50)));
}

function buildAIContext(prompt = '') {
  const header = dealHeader();
  if (!needsComments(prompt)) return header + '\n\n(Nur Deal-Metadaten benoetigt fuer diese Frage)';

  const filtered = relevantComments();
  const total = deal.comments?.length || 0;
  const lines = [header, '', '=== KOMMENTARE (Score: helpful*3 + replies*3 + likes*2 + funny) ==='];
  let chars = lines.join('\n').length;
  let included = 0;

  // Dealersteller-Updates zuerst und gebündelt: verbindliche Statusmeldungen
  // (Preis/Verfügbarkeit) haben Vorrang vor Community-Meinungen.
  const updates = authorUpdates();
  if (updates.length) {
    const block = ['', '=== 📌 UPDATES VOM DEALERSTELLER (verbindlich, chronologisch) ===', ...updates.map(c => commentLine(c, 0))].join('\n');
    if (chars + block.length <= CONTEXT_LIMIT) { lines.push(block); chars += block.length; }
  }

  for (const c of filtered) {
    const cLine = commentLine(c, 0);
    const rLines = (c.replies || [])
      .filter(r => !r.deleted && (reactCount(r) >= 1 || r.replyCount >= 1 || (r.text || '').length >= 50))
      .map(r => commentLine(r, r.level || 1));
    const block = [cLine, ...rLines].join('\n');
    if (chars + block.length > CONTEXT_LIMIT) break;
    lines.push('', block);
    chars += block.length + 2;
    included++;
  }
  const skipped = total - included;
  lines.push('', `--- ${included}/${total} Kommentare (${skipped > 0 ? skipped + ' Kurz-/Niedrig-Score-Kommentare uebersprungen' : 'alle relevant'}) ---`);
  return lines.join('\n');
}

// ── KI-Kette: On-Device → Gemini-Key → klarer Fehler ──────────────────────
async function callAI(prompt, ctx) {
  if (typeof ai !== 'undefined') {
    const model = ai.languageModel || ai.assistant;
    if (model?.create) {
      const session = await model.create({ systemPrompt: 'Du analysierst mydealz.de Deals und Kommentare. Antworte auf Deutsch, praezise.' });
      return await session.prompt(`${prompt}\n\n${ctx}`);
    }
  }
  // API-Key aus storage.local (geminiApiKey aus Popup) mit Fallback auf storage.sync
  const storageData = await new Promise(r => {
    chrome.storage.local.get(['geminiApiKey', 'apiKey'], localRes => {
      if (localRes?.geminiApiKey || localRes?.apiKey) return r(localRes);
      chrome.storage.sync.get(['apiKey', 'geminiApiKey'], syncRes => r(syncRes || {}));
    });
  });
  const apiKey = storageData?.geminiApiKey || storageData?.apiKey;
  if (!apiKey) throw new Error('Kein API-Key hinterlegt und Chrome-AI nicht verfügbar.');
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Du analysierst mydealz.de Deals. Antworte auf Deutsch.' }] },
        contents: [{ parts: [{ text: `${prompt}\n\n${ctx}` }] }]
      })
    });
  if (!resp.ok) {
    const errJson = await resp.json().catch(() => ({}));
    throw new Error(errJson.error?.message || `Gemini API HTTP ${resp.status}`);
  }
  const json = await resp.json();
  const txt = json.candidates?.[0]?.content?.parts?.[0]?.text || json.error?.message;
  if (!txt) throw new Error(JSON.stringify(json));
  return txt;
}

// ── Map-Reduce für 300+ Kommentar-Threads ──────────────────────────────────
async function runMapReduce(prompt, onStatus) {
  const BATCH = 40;
  const filtered = relevantComments();
  const summaries = [];
  for (let i = 0; i < filtered.length; i += BATCH) {
    const batch = filtered.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const total = Math.ceil(filtered.length / BATCH);
    if (onStatus) onStatus(`Batch ${batchNum}/${total} zusammenfassen...`);
    const batchLines = [dealHeader(), '', `=== KOMMENTAR-BATCH ${batchNum}/${total} (${batch.length} Kommentare) ===`];
    batch.forEach(c => {
      batchLines.push('', commentLine(c, 0));
      (c.replies || [])
        .filter(r => !r.deleted && (reactCount(r) >= 1 || r.replyCount >= 1 || (r.text || '').length >= 50))
        .forEach(r => batchLines.push(commentLine(r, r.level || 1)));
    });
    const summary = await callAI(`Fasse diese ${batch.length} Kommentare in 3-4 Saetzen zusammen. Wichtige Punkte, Probleme, Themen:`, batchLines.join('\n'));
    summaries.push(`Batch ${batchNum}: ${summary}`);
  }
  if (onStatus) onStatus('Finale Analyse...');
  const finalCtx = [dealHeader(), '', '=== BATCH-ZUSAMMENFASSUNGEN (alle Kommentare) ===', ...summaries].join('\n');
  return callAI(prompt, finalCtx);
}

function setupAI() {
  document.querySelectorAll('.ai-prompt-btn').forEach(btn => {
    btn.addEventListener('click', () => runAI(PROMPTS[btn.dataset.prompt] || btn.dataset.prompt));
  });
  const inp = document.getElementById('custom-prompt');
  document.getElementById('btn-custom-ai').addEventListener('click', () => { const q = inp.value.trim(); if (q) runAI(q); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const q = e.target.value.trim(); if (q) runAI(q); }
  });
}

async function runAI(prompt) {
  const out = document.getElementById('ai-output');
  out.textContent = '⏳ Analysiere...';
  document.querySelectorAll('.ai-prompt-btn').forEach(b => b.disabled = true);
  try {
    const total = deal.comments?.length || 0;
    const filtered = relevantComments();
    // Map-Reduce bei >250 relevanten Kommentaren
    if (filtered.length > 250 && needsComments(prompt)) {
      out.textContent = `⚙ Grosser Thread (${total} Kommentare) → Map-Reduce...`;
      const result = await runMapReduce(prompt, msg => { out.textContent = '⚙ ' + msg; });
      out.textContent = result;
    } else {
      const ctx = buildAIContext(prompt);
      out.textContent = await callAI(prompt, ctx);
    }
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    if (e.message.includes('API-Key')) { out.textContent += '\n\nBitte Key im Extension-Popup eintragen.'; }
  } finally {
    document.querySelectorAll('.ai-prompt-btn').forEach(b => b.disabled = false);
  }
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function flash(id, msg) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => btn.textContent = orig, 1500);
}

function showError(msg) {
  document.body.innerHTML = `<div style="padding:40px;color:#ef4444;font:16px/1.5 system-ui">${esc(msg)}</div>`;
}
