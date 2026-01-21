// ==UserScript==
// @name         MyDealz AI Exporter v14.2 (Final Clean)
// @namespace    http://tampermonkey.net/
// @version      14.2
// @description  Hybrid Architecture: Dashboard UI + Smart Model Filter (No Lite/Image) + Deep Research Support
// @author       Antigravity
// @match        https://www.mydealz.de/deals/*
// @match        https://www.mydealz.de/gutscheine/*
// @match        https://www.mydealz.de/diskussion/*
// @icon         https://www.mydealz.de/favicon.svg
// @require      https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js
// @connect      generativelanguage.googleapis.com
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. CONFIG & THEME
    // ==========================================
    const THEME = {
        primary: '#03a9f4',
        bg: '#f8f9fa',
        surface: '#ffffff',
        border: '#e2e8f0',
        text: '#334155'
    };

    const PROMPT_LEVELS = {
        SHORT: {
            label: '⚡ Kurz',
            gen: (meta, comments) => `# SYSTEM: Erstelle eine KURZE Zusammenfassung. Fokus auf Deal-Qualität & Fakten.\n\n# METADATA\n${fmtMeta(meta)}\n\n# COMMENTS\n${formatComments(comments)}`
        },
        MEDIUM: {
            label: '💡 Standard',
            gen: (meta, comments) => `# SYSTEM: Standard Analyse. Gehe auf Stimmung, Alternativen und versteckte Infos ein.\n\n# METADATA\n${fmtMeta(meta)}\n\n# COMMENTS\n${formatComments(comments)}`
        },
        DETAILED: {
            label: '🧐 Deep Dive',
            gen: (meta, comments) => `# SYSTEM: Ausführliche Recherche-Analyse. Extrahiere jede relevante User-Erfahrung.\n\n# METADATA\n${fmtMeta(meta)}\n\n# COMMENTS\n${formatComments(comments)}`
        }
    };

    // ==========================================
    // 2. NETWORK & STORAGE
    // ==========================================
    function gmFetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: options.headers || {},
                data: options.body,
                onload: (res) => resolve({
                    ok: res.status >= 200 && res.status < 300,
                    status: res.status,
                    json: () => Promise.resolve(JSON.parse(res.responseText)),
                    text: () => Promise.resolve(res.responseText)
                }),
                onerror: reject,
                ontimeout: reject
            });
        });
    }

    const CacheManager = {
        getKey(threadId) { return `mydealz_cache_v14_${threadId}`; },
        get(threadId) {
            try {
                const raw = localStorage.getItem(this.getKey(threadId));
                if (!raw) return null;
                const data = JSON.parse(raw);
                if (Date.now() - data.timestamp < 3600000) return data; // 1h TTL
                return null;
            } catch (e) { return null; }
        },
        set(threadId, meta, comments) {
            try {
                localStorage.setItem(this.getKey(threadId), JSON.stringify({ threadId, meta, comments, timestamp: Date.now() }));
            } catch (e) { console.warn("Cache Full"); }
        }
    };

    // ==========================================
    // 3. SMART MODEL FILTER (v14.2 LOGIC)
    // ==========================================
    async function fetchModels(key) {
        try {
            const res = await gmFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
            if(!res.ok) throw new Error("API Fehler: " + res.status);
            const json = await res.json();
            
            // FINAL BLACKLIST (Includes lite & image)
            const blacklist = ['tts', 'speech', 'embedding', 'vision', 'aqa', 'nano', 'banana', 'robotics', 'computer-use', 'gemma', 'lite', 'image'];

            return json.models
                .filter(m => {
                    const id = m.name.toLowerCase();
                    
                    // 1. Check Capabilities
                    if(!m.supportedGenerationMethods?.includes("generateContent")) return false;
                    
                    // 2. Blacklist Check
                    if(blacklist.some(bad => id.includes(bad))) return false;

                    // 3. Family Check (Gemini OR Deep Research)
                    const isGemini = id.includes('gemini');
                    const isDeepRes = id.includes('deep-research');
                    if (!isGemini && !isDeepRes) return false;

                    // 4. Context Limit (>60k required)
                    if (m.inputTokenLimit && m.inputTokenLimit < 60000) return false;

                    return true;
                })
                .sort((a, b) => {
                    const nameA = a.name.toLowerCase();
                    const nameB = b.name.toLowerCase();
                    const getVer = (n) => { const m = n.match(/(\d+\.\d+|\d+)/); return m ? parseFloat(m[0]) : 0; };
                    
                    // Priority: Flash > Version > Stable
                    const isFlashA = nameA.includes('flash');
                    const isFlashB = nameB.includes('flash');
                    
                    if (isFlashA && !isFlashB) return -1;
                    if (!isFlashA && isFlashB) return 1;

                    const verA = getVer(nameA);
                    const verB = getVer(nameB);
                    if (verA > verB) return -1;
                    if (verA < verB) return 1;

                    const isExpA = nameA.includes('exp') || nameA.includes('preview');
                    const isExpB = nameB.includes('exp') || nameB.includes('preview');
                    if (isExpA && !isExpB) return 1; 
                    if (!isExpA && isExpB) return -1;

                    return 0;
                });
        } catch(e) { console.error(e); throw e; }
    }

    async function generateWithGemini(key, model, text) {
        const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${key}`;
        const res = await gmFetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ contents: [{ parts: [{ text: text }] }] })
        });
        if(!res.ok) {
            const err = await res.json();
            throw new Error(err.error?.message || "Gen Error");
        }
        const json = await res.json();
        return json.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
    }

    // ==========================================
    // 4. EXTRACTION & FALLBACK
    // ==========================================
    function cleanText(html) {
        if (!html) return "";
        // @ts-ignore
        const clean = DOMPurify.sanitize(html); 
        const doc = new DOMParser().parseFromString(clean, 'text/html');
        doc.querySelectorAll('a').forEach(a => a.textContent = `${a.textContent} (${a.href})`);
        return doc.body.textContent.replace(/\s+/g, ' ').trim();
    }

    function getThreadId() {
        const match = window.location.href.match(/(?:deals|gutscheine|diskussion)\/([a-zA-Z0-9-]+-\d+)/);
        return match ? match[1].split('-').pop() : null;
    }

    function extractMetadata(initialState) {
        const threadId = getThreadId();
        const threads = initialState?.threads?.threads || {};
        const thread = threads[threadId];
        if (!thread) return { Title: document.title, URL: window.location.href };

        return {
            Titel: thread.title,
            Preis: thread.price || "N/A",
            Temperatur: thread.temperature,
            Autor: thread.userName,
            Shop: thread.merchantName || "N/A",
            Erstellt: new Date(thread.createdAt * 1000).toLocaleString(),
            URL: window.location.href
        };
    }

    function extractComments(initialState) {
        const threadId = getThreadId();
        const commentsMap = initialState?.comments?.comments || {};
        const allComments = Object.values(commentsMap).filter(c => c.threadId == threadId);
        
        const lookup = {};
        allComments.forEach(c => lookup[c.commentId] = { ...c, children: [] });
        const roots = [];
        allComments.forEach(c => {
            if (c.parentId && lookup[c.parentId]) lookup[c.parentId].children.push(lookup[c.commentId]);
            else roots.push(lookup[c.commentId]);
        });

        const processNode = (node, depth = 0) => {
            const indent = "  ".repeat(depth);
            let txt = `${indent}- [${node.userName}]: ${cleanText(node.content)}\n`;
            if(node.children) node.children.forEach(c => txt += processNode(c, depth+1));
            return txt;
        };
        return roots.map(c => processNode(c)).join("\n");
    }

    // DOM Fallback Functions (v14.1 Feature)
    function extractMetadataFromDOM() {
        const title = document.querySelector('h1.thread-title')?.textContent?.trim() || document.title;
        const price = document.querySelector('.thread-price')?.textContent?.trim() || "N/A";
        const temp = document.querySelector('.vote-temp')?.textContent?.trim() || "N/A";
        return { Titel: title, Preis: price, Temperatur: temp, Autor: "Scraped", Shop: "N/A", Erstellt: new Date().toLocaleString() + " (DOM)", URL: window.location.href };
    }

    function extractCommentsFromDOM() {
        const comments = [];
        document.querySelectorAll('.comment').forEach(el => {
            const u = el.querySelector('.comment-header .username')?.textContent?.trim() || "User";
            const t = el.querySelector('.comment-body .userHtml')?.textContent?.trim();
            if(t) comments.push(`- [${u}]: ${t}`);
        });
        return comments.length ? comments.join("\n") : "No comments found in DOM.";
    }

    const fmtMeta = (m) => Object.entries(m).map(([k,v]) => `${k}: ${v}`).join('\n');
    const formatComments = (c) => c; 

    // ==========================================
    // 5. UI (DASHBOARD)
    // ==========================================
    function runExport(btn) {
        const threadId = getThreadId();
        if(!threadId) return alert("Thread ID nicht gefunden!");

        const cached = CacheManager.get(threadId);
        if (cached) return openUi(cached.meta, cached.comments, true);

        btn.textContent = "⏳...";
        
        // Robust Extraction (State > DOM)
        let meta, comments;
        const rawState = unsafeWindow.__INITIAL_STATE__;
        
        if(rawState) {
            try {
                meta = extractMetadata(rawState);
                comments = extractComments(rawState);
            } catch(e) { console.warn("State fail", e); }
        }

        if(!meta || !comments) {
            meta = extractMetadataFromDOM();
            comments = extractCommentsFromDOM();
        }

        if(!meta || !comments) {
             btn.textContent = "❌ Error";
             return alert("Daten konnten nicht geladen werden.");
        }
        
        CacheManager.set(threadId, meta, comments);
        btn.textContent = "🧠 AI Export";
        openUi(meta, comments, false);
    }

    function openUi(meta, comments, isCached) {
        const w = window.open('', '_blank', 'width=1100,height=900');
        if(!w) return alert("Popup Blocked!");
        
        const d = w.document;
        w.document.title = "🧠 MyDealz AI Exporter v14.0 Hybrid";

        const css = `
            :root { --bg: ${THEME.bg}; --surface: ${THEME.surface}; --primary: ${THEME.primary}; --border: ${THEME.border}; }
            body { margin: 0; font-family: 'Inter', sans-serif; background: var(--bg); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
            .header { padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
            .controls { padding: 15px 20px; background: #fff; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 15px; position: relative; z-index: 10; }
            
            /* Tacho */
            .speedo-wrap { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); width: 280px; height: 10px; background: #e2e8f0; border-radius: 0 0 6px 6px; overflow: hidden; }
            .speedo-bar { width: 100%; height: 100%; background: linear-gradient(90deg, #4ade80, #facc15, #f87171); }
            .needle { position: absolute; top: 0; bottom: 0; width: 2px; background: #000; transition: left 0.3s; }
            .t-val { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); font-size: 9px; font-weight: bold; color: #64748B; background: rgba(255,255,255,0.8); padding: 0 4px; border-radius: 4px; }

            .row { display: flex; gap: 15px; flex-wrap: wrap; }
            .btn { padding: 6px 12px; border: 1px solid var(--border); background: #fff; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; }
            .btn:hover { background: #f8fafc; }
            .btn-primary { background: var(--primary); color: white; border: none; }
            .btn-primary:hover { opacity: 0.9; }
            .tab-btn.active { background: var(--primary); color: white; border-color: var(--primary); }
            
            .editor { flex: 1; resize: none; border: none; padding: 20px; font-family: 'JetBrains Mono', monospace; font-size: 13px; background: #fafafa; outline: none; }
            .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(50px); background: #1e293b; color: white; padding: 8px 16px; border-radius: 20px; font-size: 12px; opacity: 0; transition: all 0.3s; }
            .toast.v { transform: translateX(-50%) translateY(0); opacity: 1; }
        `;
        d.head.innerHTML = `<style>${css}</style>`;
        
        d.body.innerHTML = `
            <div class="header">
                <b>🧠 MyDealz AI <span style="color:#94a3b8; font-weight:400;">v14.2 Clean</span></b>
                ${isCached ? '<span style="background:#dcfce7; color:#166534; padding:2px 6px; font-size:10px; border-radius:4px;">⚡ CACHED</span>' : ''}
            </div>
            <div class="controls">
                <div class="speedo-wrap"><div class="speedo-bar"></div><div class="needle" id="ndl"></div></div>
                <div class="t-val" id="tv">0k</div>

                <div class="row">
                    <div id="tabs" style="display:flex; gap:5px;"></div>
                    <div style="flex:1"></div>
                    <div style="display:flex; gap:5px;">
                        <input type="password" id="key" placeholder="API Key..." style="width:100px; padding:5px; border:1px solid #e2e8f0; border-radius:4px;">
                        <select id="model" style="width:140px; border:1px solid #e2e8f0; border-radius:4px;"></select>
                        <button class="btn btn-primary" id="go">✨ RUN</button>
                    </div>
                </div>
                <div class="row">
                    <button class="btn" id="cp">📋 Copy</button>
                    <button class="btn" id="dl">💾 Save .MD</button>
                    <button class="btn" onclick="window.open('https://aistudio.google.com/app/apikey')">🔑 Get Key</button>
                </div>
            </div>
            <textarea id="out" class="editor" spellcheck="false"></textarea>
            <div id="toast" class="toast"></div>
        `;

        const out = d.getElementById('out');
        const showToast = (m) => { const t=d.getElementById('toast'); t.textContent=m; t.classList.add('v'); setTimeout(()=>t.classList.remove('v'),2000); };
        
        const updateMeter = (txt) => {
            const t = Math.ceil(txt.length/4);
            let p = t < 10000 ? (t/10000)*33 : (t < 40000 ? 33+((t-10000)/30000)*33 : 66+((t-40000)/60000)*34);
            d.getElementById('ndl').style.left = Math.min(p, 98) + '%';
            d.getElementById('tv').textContent = (t/1000).toFixed(1) + 'k Tokens';
        };

        let curLvl = 'MEDIUM';
        Object.keys(PROMPT_LEVELS).forEach(k => {
            const b = d.createElement('button');
            b.className = `btn tab-btn ${k==='MEDIUM'?'active':''}`;
            b.textContent = PROMPT_LEVELS[k].label;
            b.onclick = () => {
                d.querySelectorAll('.tab-btn').forEach(e=>e.classList.remove('active'));
                b.classList.add('active');
                curLvl = k;
                out.value = PROMPT_LEVELS[k].gen(meta, comments);
                updateMeter(out.value);
            };
            d.getElementById('tabs').appendChild(b);
        });

        out.value = PROMPT_LEVELS.MEDIUM.gen(meta, comments);
        updateMeter(out.value);
        out.addEventListener('input', ()=>updateMeter(out.value));

        d.getElementById('cp').onclick = () => { GM_setClipboard(out.value,'text'); showToast("Copied!"); };
        d.getElementById('dl').onclick = () => {
            const blob = new Blob([out.value], {type:'text/markdown'});
            const a = d.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`${meta.Titel.substring(0,20)}.md`; a.click();
        };

        const keyIn = d.getElementById('key');
        const modSel = d.getElementById('model');
        const savedKey = localStorage.getItem('mdz_gemini_key');
        
        const loadModels = async (k) => {
            try {
                const models = await fetchModels(k);
                modSel.innerHTML = models.map(m => `<option value="${m.name}">${m.displayName.replace('Gemini ','')}</option>`).join('');
                showToast("Connected!");
            } catch(e) { alert(e.message); }
        };

        if(savedKey) { keyIn.value = savedKey; loadModels(savedKey); }
        keyIn.onchange = () => { localStorage.setItem('mdz_gemini_key', keyIn.value); loadModels(keyIn.value); };

        d.getElementById('go').onclick = async () => {
            if(!keyIn.value) return alert("API Key fehlt!");
            const btn = d.getElementById('go'); btn.textContent="⏳"; btn.disabled=true;
            try {
                const res = await generateWithGemini(keyIn.value, modSel.value, out.value);
                out.value = "🤖 SUMMARY:\n\n" + res + "\n\n" + "-".repeat(30) + "\n\n" + out.value;
                showToast("Done!");
            } catch(e) { alert(e.message); }
            finally { btn.textContent="✨ RUN"; btn.disabled=false; }
        };
    }

    // ==========================================
    // 6. WATCHDOG
    // ==========================================
    setInterval(() => {
        if(document.getElementById('mydealz-ai-btn')) return;
        if(!location.href.match(/(?:deals|gutscheine|diskussion)/)) return;
        const b = document.createElement('button');
        b.id = 'mydealz-ai-btn'; b.textContent = "🧠 AI";
        Object.assign(b.style, { position:'fixed', bottom:'20px', right:'20px', zIndex:99999, padding:'10px 16px', background:THEME.primary, color:'white', border:'none', borderRadius:'30px', cursor:'pointer', fontWeight:'bold', boxShadow:'0 4px 10px rgba(0,0,0,0.2)' });
        b.onclick = () => runExport(b);
        document.body.appendChild(b);
    }, 1000);

})();
