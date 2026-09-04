'use strict';

/* ── PROMPTS ── */
const PROMPTS = [
    `Du bist ein erfahrener Deal-Analyst. Fasse die wichtigsten Kommentare zu diesem Deal sachlich zusammen: Was sind die Hauptthemen, welche Fragen werden gestellt, gibt es Warnungen oder Empfehlungen?`,
    `Analysiere die Kommentare und extrahiere: Alle konkreten Deals, Alternativen oder Preisvergleiche, die von Nutzern genannt werden. Liste sie kompakt auf.`,
    `Lies die Kommentare kritisch durch. Markiere alle negativen Punkte, Probleme, Betrugs-Warnungen oder Qualitätsmängel die Nutzer erwähnen.`,
    `Extrahiere alle Fragen und Antworten aus den Kommentaren in einem klaren Q&A-Format. Strukturiere sie nach Themen.`,
    `Erstelle eine vollständige, strukturierte Analyse aller Kommentare: Zusammenfassung, Hauptthemen, positive Aspekte, Kritik, offene Fragen und Gesamtbewertung der Community-Stimmung.`
];

/* ── STATE ── */
let exportData = null;
let outputFormat = 'md';

/* ── ELEMENTS ── */
const elTitle    = document.getElementById('deal-title');
const elCount    = document.getElementById('comment-count');
const elKey      = document.getElementById('api-key');
const elModel    = document.getElementById('model-select');
const elRun      = document.getElementById('btn-run');
const elOutput   = document.getElementById('output');
const elStatus   = document.getElementById('status-msg');
const elSpinner  = document.getElementById('spinner');
const elTokens   = document.getElementById('token-count');
const elLinkDeal = document.getElementById('link-deal');
const elFmtMd    = document.getElementById('fmt-md');
const elFmtJson  = document.getElementById('fmt-json');
const btnCopy    = document.getElementById('btn-copy');
const btnSave    = document.getElementById('btn-save');

/* ── HELPERS ── */
function setStatus(msg, spin = false) {
    elStatus.textContent = msg;
    elSpinner.classList.toggle('active', spin);
}

function countTokens(text) {
    // rough estimate: 1 token ≈ 4 chars
    return Math.ceil(text.length / 4);
}

function updateTokenCount() {
    elTokens.textContent = `${countTokens(elOutput.value).toLocaleString('de')} Tokens`;
}

function commentsToMarkdown(meta, comments) {
    const lines = [];
    lines.push(`# ${meta.title || 'Deal'}`);
    if (meta.url) lines.push(`> ${meta.url}`);
    lines.push(`> ${comments.length} Kommentare\n`);
    for (const c of comments) {
        const ts = c.created ? new Date(c.created * 1000).toLocaleString('de') : '';
        lines.push(`---\n**${c.author || 'Anonym'}** · ${ts}`);
        lines.push(c.text || '');
    }
    return lines.join('\n');
}

function commentsToJSON(meta, comments) {
    return JSON.stringify({ meta, comments }, null, 2);
}

/* ── INIT: load data from background ── */
async function init() {
    // Load saved API key
    chrome.storage.local.get(['geminiApiKey', 'geminiModel'], (r) => {
        if (r.geminiApiKey) elKey.value = r.geminiApiKey;
        if (r.geminiModel)  elModel.value = r.geminiModel;
    });

    // Fetch export data
    setStatus('Lade Export-Daten…', true);
    chrome.runtime.sendMessage({ type: 'GET_EXPORT_DATA' }, (response) => {
        if (chrome.runtime.lastError || !response) {
            setStatus('⚠ Keine Daten. Bitte Deal-Seite neu laden und Button klicken.');
            return;
        }
        exportData = response;
        const { meta, comments } = exportData;

        elTitle.textContent = meta.title || 'Unbekannter Deal';
        elCount.textContent = `${comments.length} Kommentare`;
        elCount.className = 'badge badge-ok';

        if (meta.url) {
            elLinkDeal.href = meta.url;
        }

        renderComments();
        setStatus(`✅ ${comments.length} Kommentare geladen`);
    });
}

function renderComments() {
    if (!exportData) return;
    const { meta, comments } = exportData;
    elOutput.value = outputFormat === 'md'
        ? commentsToMarkdown(meta, comments)
        : commentsToJSON(meta, comments);
    updateTokenCount();
}

/* ── FORMAT TOGGLE ── */
elFmtMd.addEventListener('click', () => {
    outputFormat = 'md';
    elFmtMd.classList.add('active');
    elFmtJson.classList.remove('active');
    renderComments();
});
elFmtJson.addEventListener('click', () => {
    outputFormat = 'json';
    elFmtJson.classList.add('active');
    elFmtMd.classList.remove('active');
    renderComments();
});

/* ── PROMPT SEGMENTED CONTROL ── */
let activePromptIdx = 0;
document.querySelectorAll('#prompt-seg button').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#prompt-seg button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activePromptIdx = parseInt(btn.dataset.idx, 10);
    });
});

/* ── GEMINI RUN ── */
elRun.addEventListener('click', async () => {
    const apiKey = elKey.value.trim();
    const model  = elModel.value;

    if (!apiKey) {
        setStatus('⚠ Bitte Gemini API Key eingeben!');
        elKey.focus();
        return;
    }
    if (!exportData) {
        setStatus('⚠ Keine Daten geladen.');
        return;
    }

    // Save key + model
    chrome.storage.local.set({ geminiApiKey: apiKey, geminiModel: model });

    const { meta, comments } = exportData;
    const commentsText = comments.map(c => {
        const ts = c.created ? new Date(c.created * 1000).toLocaleString('de') : '';
        return `[${c.author || 'Anonym'} · ${ts}]: ${c.text || ''}`;
    }).join('\n\n');

    const systemPrompt = PROMPTS[activePromptIdx];
    const userContent = `Deal: "${meta.title || ''}"\nURL: ${meta.url || ''}\n\n${commentsText}`;

    setStatus('⏳ Gemini denkt…', true);
    elRun.disabled = true;

    try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = {
            contents: [{
                parts: [{ text: systemPrompt + '\n\n' + userContent }]
            }],
            generationConfig: {
                temperature: 0.4,
                maxOutputTokens: 4096
            }
        };

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.error?.message || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '(keine Antwort)';

        elOutput.value = text;
        updateTokenCount();
        setStatus(`✅ Gemini fertig · Modell: ${model}`);

    } catch (err) {
        setStatus(`❌ Fehler: ${err.message}`);
    } finally {
        elRun.disabled = false;
        elSpinner.classList.remove('active');
    }
});

/* ── COPY ── */
btnCopy.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(elOutput.value);
        btnCopy.textContent = '✅ Kopiert!';
        setTimeout(() => btnCopy.textContent = '📋 Kopieren', 2000);
    } catch {
        setStatus('❌ Kopieren fehlgeschlagen');
    }
});

/* ── SAVE ── */
btnSave.addEventListener('click', () => {
    const ext  = outputFormat === 'json' ? 'json' : 'md';
    const name = (exportData?.meta?.title || 'export')
        .replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 60);
    const blob = new Blob([elOutput.value], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${name}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
});

/* ── LIVE TOKEN COUNT ── */
elOutput.addEventListener('input', updateTokenCount);

/* ── START ── */
init();
