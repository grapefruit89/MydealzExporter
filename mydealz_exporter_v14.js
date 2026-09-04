// ==UserScript==
// @name         MyDealz AI Exporter v16.1 (UI Perfect + Safety)
// @namespace    http://tampermonkey.net/
// @version      16.1
// @description  Exact UI Replica + GraphQL Engine + Overwrite Protection.
// @author       Antigravity
// @match        https://www.mydealz.de/deals/*
// @match        https://www.mydealz.de/gutscheine/*
// @match        https://www.mydealz.de/diskussion/*
// @icon         https://www.mydealz.de/favicon.svg
// @require      https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js
// @connect      generativelanguage.googleapis.com
// @connect      www.mydealz.de
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 0. GRAPHQL ENGINE (v6 Logic)
    // ==========================================
    const GQL = {
        QUERY: `
            query comments($filter: CommentFilter!, $limit: Int, $page: Int) {
              comments(filter: $filter, limit: $limit, page: $page) {
                items {
                  commentId
                  preparedHtmlContent  
                  createdAt            
                  user { username }
                  reactionCounts { type count }
                  repliesPreview {
                     commentId
                     preparedHtmlContent
                     createdAt
                     user { username }
                     reactionCounts { type count }
                  }
                }
                pagination { last }
              }
            }
        `,
        getXsrf() {
            const meta = document.querySelector('meta[name="csrf-token"]');
            if (meta) return meta.getAttribute('content');
            const match = document.cookie.match(/xsrf_t=([^;]+)/);
            return match ? decodeURIComponent(match[1]) : null;
        },
        cleanText(html) {
            if (!html) return "";
            return html.replace(/<br\s*\/?>/gi, "\\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
        },
        compressVotes(counts) {
            if (!counts || counts.length === 0) return undefined;
            const out = {};
            let hasSignal = false;
            counts.forEach(c => {
                if (c.count > 0) {
                    out[c.type.toLowerCase()] = c.count;
                    hasSignal = true;
                }
            });
            return hasSignal ? out : undefined;
        },
        transform(item) {
            if (!item) return null;
            const node = {
                id: item.commentId,
                user: item.user?.username || "Deleted",
                date: item.createdAt, 
                text: this.cleanText(item.preparedHtmlContent),
                votes: this.compressVotes(item.reactionCounts)
            };
            if (item.repliesPreview && item.repliesPreview.length > 0) {
                node.replies = item.repliesPreview.map(r => this.transform(r)).filter(Boolean);
            }
            return node;
        },
        async fetchAll(threadId, onProgress) {
            const token = this.getXsrf();
            if (!token) throw new Error("Kein Login Token!");
            const headers = { 'content-type': 'application/json', 'x-xsrf-token': token, 'x-request-type': 'application/vnd.pepper.v1+json' };
            const body = (p) => JSON.stringify({ query: this.QUERY, variables: { filter: { threadId: { eq: threadId }, order: { direction: "Ascending" } }, limit: 100, page: p } });

            let allItems = [];
            // Page 1
            if(onProgress) onProgress("Page 1...");
            const r1 = await fetch('/graphql', { method: 'POST', headers, body: body(1) });
            const d1 = (await r1.json()).data;
            
            if (d1?.comments?.items) {
                allItems.push(...d1.comments.items);
                const last = d1.comments.pagination.last;
                for (let p = 2; p <= last; p++) {
                    if(onProgress) onProgress(`Page ${p}/${last}...`);
                    await new Promise(r => setTimeout(r, 400));
                    const rp = await fetch('/graphql', { method: 'POST', headers, body: body(p) });
                    const dp = (await rp.json()).data;
                    if(dp?.comments?.items) allItems.push(...dp.comments.items);
                }
            }
            return allItems.map(item => this.transform(item));
        }
    };

    // ==========================================
    // 1. HELPERS
    // ==========================================
    function getThreadId() {
        const match = window.location.href.match(/(?:deals|gutscheine|diskussion)\/([a-zA-Z0-9-]+-\d+)/);
        return match ? match[1].split('-').pop() : null;
    }
    function extractMetadata() {
        return {
            Titel: document.querySelector('h1.thread-title')?.textContent?.trim() || document.title,
            Preis: document.querySelector('.thread-price')?.textContent?.trim() || "N/A",
            URL: window.location.href
        };
    }
    function gmFetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: options.headers || {},
                data: options.body,
                onload: (res) => resolve({ ok: res.status >= 200 && res.status < 300, json: () => Promise.resolve(JSON.parse(res.responseText)) }),
                onerror: reject
            });
        });
    }

    // ==========================================
    // 2. APPROVED UI (EXACT COPY OF ui_preview.html)
    // ==========================================
    const UI_HTML = `
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <title>MyDealz AI Exporter</title>
    <style>
        :root {
            --primary: #2563EB;
            --primary-hover: #1D4ED8;
            --bg-body: #F8FAFC;
            --bg-surface: #FFFFFF;
            --border: #E2E8F0;
            --text-main: #0F172A;
            --text-muted: #64748B;
            --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
            --shadow-card: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            --radius-card: 12px;
            --radius-elem: 8px;
            --input-height: 36px;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; background-color: var(--bg-body); color: var(--text-main); height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
        .app-card { background: var(--bg-surface); width: 800px; height: 650px; border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow-card); display: flex; flex-direction: column; overflow: hidden; }
        header { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-surface); }
        .brand { font-weight: 700; font-size: 14px; color: var(--text-main); display: flex; align-items: center; gap: 8px; }
        .control-matrix { padding: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px 32px; background: #FFFFFF; border-bottom: 1px solid var(--border); }
        .grid-item { display: flex; flex-direction: column; gap: 8px; }
        .group-label { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
        .segmented-control { display: inline-flex; background: #F1F5F9; padding: 3px; border-radius: var(--radius-elem); height: var(--input-height); border: 1px solid transparent; }
        .segment-btn { flex: 1; padding: 0 12px; border: none; border-radius: 6px; background: transparent; color: var(--text-muted); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s ease; }
        .segment-btn:hover { color: var(--text-main); }
        .segment-btn.active { background: white; color: var(--text-main); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
        .input-group { display: flex; height: var(--input-height); border: 1px solid var(--border); border-radius: var(--radius-elem); background: white; overflow: hidden; width: 100%; max-width: 280px; transition: border-color 0.2s, box-shadow 0.2s; }
        .input-group:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); }
        .input-field { flex: 1; border: none; padding: 0 12px; font-size: 13px; font-family: monospace; outline: none; color: var(--text-main); background: transparent; }
        .input-field::placeholder { color: #94A3B8; }
        .input-action { width: 36px; border: none; border-left: 1px solid var(--border); background: #FAFAFA; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; color: var(--text-muted); transition: background 0.1s; }
        .input-action:hover { background: #F1F5F9; color: var(--text-main); }
        .export-bar { display: flex; align-items: center; gap: 10px; }
        .btn { height: var(--input-height); padding: 0 16px; border: 1px solid var(--border); border-radius: var(--radius-elem); background: white; font-size: 13px; font-weight: 500; cursor: pointer; color: var(--text-main); display: flex; align-items: center; gap: 6px; transition: all 0.2s; box-shadow: var(--shadow-sm); }
        .btn:hover { background: #F8FAFC; border-color: #CBD5E1; transform: translateY(-1px); }
        .btn:active { transform: translateY(0); }
        .btn-primary { border-color: var(--primary); background: var(--primary); color: white; box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2); }
        .btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
        .ai-links { display: flex; gap: 10px; }
        .editor-area { flex: 1; display: flex; flex-direction: column; background: white; position: relative; }
        .editor-header { padding: 8px 24px; border-bottom: 1px solid var(--border); background: #FAFAFA; color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; display: flex; justify-content: space-between; }
        .code-block { flex: 1; padding: 24px; border: none; resize: none; outline: none; font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 13px; line-height: 1.6; color: var(--text-main); background: white; }
        textarea::-webkit-scrollbar { width: 8px; }
        textarea::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 4px; }
        .progress-bar { height: 3px; width: 100%; background: transparent; }
        .progress-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #22C55E, #EAB308, #EF4444); transition: width 0.3s; }
        .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(50px); background: #1e293b; color: white; padding: 8px 16px; border-radius: 20px; font-size: 12px; opacity: 0; transition: all 0.3s; z-index: 999; }
        .toast.v { transform: translateX(-50%) translateY(0); opacity: 1; }
    </style>
</head>
<body>
    <div class="app-card">
        <div class="progress-bar"><div class="progress-fill" id="pBar" style="width: 0%"></div></div>
        <header>
            <div class="brand">🧠 MyDealz AI Exporter <span style="font-weight:400; color:#94A3B8; margin-left:6px;">v16.1</span></div>
            <div id="statusLabel" style="font-size:12px; color:#64748B;">Ready</div>
        </header>

        <div class="control-matrix">
            <div class="grid-item">
                <div class="group-label">PROMPTS</div>
                <div class="segmented-control" id="promptContainer">
                    <button class="segment-btn active" data-type="RAW">Keine</button>
                    <button class="segment-btn" data-type="SHORT">Kurz</button>
                    <button class="segment-btn" data-type="STANDARD">Standard</button>
                </div>
            </div>
            <div class="grid-item">
                <div class="group-label">GEMINI AI</div>
                <div class="input-group">
                    <input type="password" id="apiKeyInput" class="input-field" placeholder="API Key...">
                    <select id="modelSelect" style="display:none; flex:1; border:none; outline:none; font-size:12px; padding:0 8px;"></select>
                    <button class="input-action" id="btnRunGemini">➔</button>
                </div>
            </div>
            <div class="grid-item" style="align-self: end;">
                <div class="group-label">EXPORT</div>
                <div class="export-bar">
                    <div class="segmented-control" id="formatToggle">
                        <button class="segment-btn active">JSON</button>
                        <button class="segment-btn">MD</button>
                    </div>
                    <button class="btn" id="btnCopy">📋 Copy</button>
                    <button class="btn btn-primary" id="btnSave">💾 Save</button>
                </div>
            </div>
            <div class="grid-item" style="align-self: end;">
                <div class="group-label">AI LINKS</div>
                <div class="ai-links">
                    <button class="btn" onclick="window.open('https://aistudio.google.com/')">Studio</button>
                    <button class="btn" onclick="window.open('https://chatgpt.com/')">GPT</button>
                </div>
            </div>
        </div>

        <div class="editor-area">
            <div class="editor-header">
                <span>Output Preview</span>
                <span id="tokenStatus">0 Tokens</span>
            </div>
            <textarea class="code-block" id="editor" spellcheck="false" placeholder="Waiting for data..."></textarea>
        </div>
        <div id="toast" class="toast"></div>
    </div>
</body>
</html>
    `;

    // ==========================================
    // 3. MAIN CONTROLLER
    // ==========================================
    async function runExport(startBtn) {
        const threadId = getThreadId();
        if(!threadId) return alert("No Thread ID!");
        
        startBtn.textContent = "⏳...";
        try {
            const comments = await GQL.fetchAll(threadId, (msg) => {
                startBtn.textContent = `⏳ ${msg.split(' ')[0]}`;
            });
            const meta = extractMetadata();
            startBtn.textContent = "🧠 AI Export";
            openUi(meta, comments);
        } catch(e) {
            alert("Error: " + e.message);
            startBtn.textContent = "❌ Retry";
        }
    }

    function openUi(meta, comments) {
        const w = window.open('', '_blank', 'width=820,height=680');
        w.document.write(UI_HTML);
        w.document.close();
        
        const d = w.document;
        const editor = d.getElementById('editor');
        const tokenDisplay = d.getElementById('tokenStatus');
        const showToast = (m) => { const t = d.getElementById('toast'); t.textContent=m; t.classList.add('v'); setTimeout(()=>t.classList.remove('v'),2000); };

        // STATE
        let mode = "RAW"; 
        let format = "JSON"; 
        let aiContent = null; // Stores AI Result

        const render = () => {
            let txt = "";
            
            // IF AI CONTENT EXISTS, IT OVERRIDES EVERYTHING
            // Wait, no. We want to be able to switch back.
            // But if we toggle, we overwrite AI.
            // Logic: Render triggers on toggle.
            
            if (aiContent && d.activeElement !== editor) {
                 // We are in AI View? 
                 // No, let's explicitely handle AI result storage.
            }

            if (mode === "RAW") {
                if (format === "JSON") txt = JSON.stringify(comments, null, 2);
                else txt = comments.map(c => `- ${c.user}: ${c.text}`).join("\n");
            } else {
                const instructions = mode === "SHORT" ? "Fasse kurz zusammen." : "Analysiere Sentiment, Pros & Cons.";
                txt = `# SYSTEM: ${instructions}\n\n# DATA\n${JSON.stringify(comments, null, 2)}`;
            }

            editor.value = txt;
            tokenDisplay.textContent = `~${Math.ceil(txt.length/4)} Tokens`;
            aiContent = null; // Reset AI content if user manually switches tabs (Confirmed Action)
        };

        // SAFETY WRAPPER
        const protectedSwitch = (action) => {
            if (aiContent && !confirm("⚠️ AI Ergebnis überschreiben?")) return;
            action();
        };

        d.querySelectorAll('#promptContainer .segment-btn').forEach(btn => {
            btn.onclick = (e) => protectedSwitch(() => {
                d.querySelectorAll('#promptContainer .segment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                mode = btn.getAttribute('data-type');
                render();
            });
        });

        d.querySelectorAll('#formatToggle .segment-btn').forEach(btn => {
            btn.onclick = (e) => protectedSwitch(() => {
                d.querySelectorAll('#formatToggle .segment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                format = btn.textContent;
                render();
            });
        });

        d.getElementById('btnCopy').onclick = () => { GM_setClipboard(editor.value); showToast("Copied!"); };
        d.getElementById('btnSave').onclick = () => {
            const blob = new Blob([editor.value], {type: "text/plain"});
            const a = d.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `mydealz_export.${format.toLowerCase()}`;
            a.click();
            showToast("Saved!");
        };

        // GEMINI
        const btnRun = d.getElementById('btnRunGemini');
        const keyInput = d.getElementById('apiKeyInput');
        
        btnRun.onclick = async () => {
            if(!keyInput.value) return alert("API Key?");
            btnRun.textContent = "⏳";
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${keyInput.value}`;
                const res = await gmFetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ contents:[{parts:[{text: editor.value}]}] }) });
                const json = await res.json();
                
                const result = json.candidates?.[0]?.content?.parts?.[0]?.text || "No AI Output";
                editor.value = result;
                tokenDisplay.textContent = "✨ AI Generated";
                aiContent = result; // MARK AS AI CONTENT
                showToast("AI Finished!");
            } catch(e) { alert(e.message); }
            btnRun.textContent = "➔";
        };

        render();
    }

    setTimeout(() => {
        const btn = document.createElement('button');
        btn.textContent = "🧠 AI Export";
        btn.style.cssText = "position:fixed; bottom:20px; right:20px; z-index:9999; padding:12px 20px; background:#2563EB; color:white; border:none; border-radius:30px; font-weight:bold; box-shadow:0 4px 12px rgba(0,0,0,0.2); cursor:pointer;";
        btn.onclick = () => runExport(btn);
        document.body.appendChild(btn);
    }, 1500);

})();
