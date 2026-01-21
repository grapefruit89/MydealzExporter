(function() {
    'use strict';
    
    // 🛡️ GLOBAL ERROR TRAP (Zwingt alle Fehler in die Konsole)
    window.onerror = function(msg, url, line, col, error) {
        console.group("🔥 CRITICAL SCRIPT ERROR");
        console.error(`Msg: ${msg}`);
        console.error(`Loc: ${url}:${line}:${col}`);
        if(error) console.error("Stack:", error);
        console.groupEnd();
        return true; // Suppress Default Browser Error Handling
    };

    window.onunhandledrejection = function(e) {
        console.group("🔥 UNHANDLED PROMISE");
        console.error(e.reason || e);
        console.groupEnd();
    };

    console.log("🚀 Logic JS starting initialization...");
    try {

    // ==========================================
    // 1. CONFIG & STYLES (INJECTED)
    // ==========================================
    const THEME = {
        primary: '#0F172A',
        secondary: '#334155',
        accent: '#2563EB',
        bg: '#F8FAFC',
        surface: '#FFFFFF',
        border: '#E2E8F0',
        text: '#1E293B'
    };

    const AI_URLS = [
        { name: 'ChatGPT', url: 'https://chatgpt.com/' },
        { name: 'Claude', url: 'https://claude.ai/' },
        { name: 'Gemini', url: 'https://gemini.google.com/' },
        { name: 'Perplexity', url: 'https://www.perplexity.ai/' },
        { name: 'NotebookLM', url: 'https://notebooklm.google.com/' }
    ];

    // ------------------------------------------------------
    // DYNAMIC RESOURCE LOADING (Dev vs Build)
    // ------------------------------------------------------
    
    function getUiCss() {
        let css = `%%CSS%%`;
        if (css.startsWith("%%") && typeof GM_getResourceText === 'function') {
            const res = GM_getResourceText("MY_CSS");
            if (res) return res;
        }
        return css.startsWith("%%") ? "/* CSS missing */" : css;
    }

    function getUiHtml() {
        let tpl = `%%HTML%%`;
        if (tpl.startsWith("%%") && typeof GM_getResourceText === 'function') {
             const res = GM_getResourceText("MY_HTML");
             if (res) return res;
             return "<h1>⚠️ DevMode: Template not found (Check @resource)</h1>";
        }
        return tpl;
    }

    const Logger = {
        logs: [],
        init() { 
            console.group("💎 MyDealz AI Exporter"); // Start Group
            this.add("Logger Initialized"); 
        },
        add(msg, type = 'INFO') {
            const ts = new Date().toLocaleTimeString();
            const entry = `[${ts}] [${type}] ${msg}`;
            this.logs.push(entry);
            // Log directly to the group
            console.log(`%c[${type}] ${msg}`, type === 'ERROR' ? 'color:red' : 'color:#2563EB');
        },
        error(msg, e) {
            this.add(`${msg} -> ${e?.message || e}`, 'ERROR');
            if(e?.stack) this.logs.push(e.stack);
            console.error(e);
        },
        getReport() {
            return `=== MYDEALZ AI LOGGER v13.0 ===\n${this.logs.join('\n')}\n=============================`;
        }
    };
    Logger.init();

    function logToConsole(msg, level = 'log', targetWindow = null) {
        try { console[level] ? console[level](msg) : console.log(msg); } catch (_) {}
        try {
            const w = targetWindow || window;
            if (w && w.console) {
                w.console[level] ? w.console[level](msg) : w.console.log(msg);
            }
        } catch (_) {}
    }

    const Clipboard = {
        async write(text, contextDoc = document) {
            if (!text) return { ok: false, method: 'none', error: 'empty text' };

            try {
                if (typeof GM_setClipboard === 'function') {
                    GM_setClipboard(text);
                    return { ok: true, method: 'GM_setClipboard' };
                }
            } catch (e) {
                logToConsole(`GM_setClipboard failed: ${e?.message || e}`, 'warn');
            }

            try {
                const nav = contextDoc?.defaultView?.navigator;
                if (nav?.clipboard?.writeText) {
                    await nav.clipboard.writeText(text);
                    return { ok: true, method: 'navigator.clipboard' };
                }
            } catch (e) {
                logToConsole(`navigator.clipboard failed: ${e?.message || e}`, 'warn');
            }

            try {
                const doc = contextDoc || document;
                const ta = doc.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                doc.body.appendChild(ta);
                ta.select();
                const ok = doc.execCommand('copy');
                doc.body.removeChild(ta);
                if (ok) return { ok: true, method: 'execCommand' };
                return { ok: false, method: 'execCommand', error: 'execCommand returned false' };
            } catch (e) {
                return { ok: false, method: 'execCommand', error: e?.message || String(e) };
            }
        }
    };

    function estimateTokensFromText(text) {
        const chars = (text || '').length;
        const tokens = Math.max(1, Math.ceil(chars / 4));
        return { chars, tokens };
    }

    function suggestModelByTokens(tokens, models = []) {
        if (!models || models.length === 0) return { model: null, reason: 'no models' };
        const has = (name) => models.includes(name);

        let preferred = [];
        if (tokens <= 8000) {
            preferred = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'];
        } else if (tokens <= 32000) {
            preferred = ['gemini-1.5-pro', 'gemini-2.0-pro', 'gemini-1.5-flash'];
        } else {
            preferred = ['gemini-1.5-pro', 'gemini-2.0-pro'];
        }

        const match = preferred.find(has) || models[0];
        return { model: match, reason: `tokens≈${tokens}` };
    }

    const fmtMeta = (meta) => JSON.stringify(meta, null, 2);

    const formatComments = (comments, level = 0) => {
        return comments.map(c => {
            const indent = "  ".repeat(level);
            
            const r = c.reactions || {};
            const parts = [];
            if (r.like > 0) parts.push(`![👍](https://www.mydealz.de/assets/img/reactions/like_948bf.svg) ${r.like}`);
            if (r.helpful > 0) parts.push(`![✅](https://www.mydealz.de/assets/img/reactions/helpful_4f8f6.svg) ${r.helpful}`);
            if (r.funny > 0) parts.push(`![😄](https://www.mydealz.de/assets/img/reactions/funny_611f8.svg) ${r.funny}`);

            const reactionStr = parts.length > 0 ? ` [${parts.join(' | ')}]` : '';
            const header = `${indent}💤 **${c.user}** [${c.date}]${reactionStr}`;
            
            let body = `${indent}${c.text.replace(/\n/g, `\n${indent}`)}`;
            
            let output = `${header}\n${body}`;
            
            if (c.replies && c.replies.length > 0) {
                output += `\n${indent}-- Antworten --\n${formatComments(c.replies, level + 1)}`;
            }
            return output;
        }).join('\n\n' + "  ".repeat(level));
    };

    const PROMPT_LEVELS = {
        RAW: {
            label: '🧱 Rohdaten',
            gen: (meta, comments) => JSON.stringify({ meta, comments }, null, 2)
        },
        SHORT: {
            label: '⚡ Kurz',
            gen: (meta, comments) => `# Context\n${fmtMeta(meta)}\n\n# Comments\n${formatComments(comments)}`
        },
        MEDIUM: {
            label: '💡 Standard',
            gen: (meta, comments) => `# Metadata\n${fmtMeta(meta)}\n\n# Thread Structure (Nested)\n${formatComments(comments)}`
        },
        DETAILED: {
            label: '🔬 Ausführlich',
            gen: (meta, comments) => `# Metadata\n${fmtMeta(meta)}\n\n# Deep Dive Thread\n${formatComments(comments)}`
        }
    };

    const PROMPT_INSTRUCTIONS = {
        RAW: "Gib keine Zusammenfassung. Ausgabe ausschließlich als Rohdaten.",
        SHORT: "Fasse das Thema sehr kurz und bündig zusammen: Worum geht es? Was ist das Fazit? Maximal wenige Sätze.",
        MEDIUM: "Erstelle eine detaillierte und ausführliche Zusammenfassung mit klaren Abschnitten: Thema, Stimmung, Top 3 Pro/Contra, Fazit.",
        DETAILED: "Erstelle eine sehr ausführliche Zusammenfassung. Schließe Lücken, nenne offene Fragen/Gaps und mögliche unbeantwortete Punkte aus der Diskussion."
    };

    function buildPrompt(levelKey, meta, comments) {
        const level = PROMPT_LEVELS[levelKey] || PROMPT_LEVELS.MEDIUM;
        const instruction = PROMPT_INSTRUCTIONS[levelKey] || PROMPT_INSTRUCTIONS.MEDIUM;
        const payload = level.gen(meta, comments);
        return `# Instruction\n${instruction}\n\n${payload}`;
    }

    // ==========================================
    // 2. STATE
    // ==========================================
    let state = {
        isScraping: false,
        threadId: null,
        xsrfToken: null,
        collectedRoots: [],
        opUsername: null,
        metaData: {},
        currentPromptLevel: 'MEDIUM',
        abortController: null,
        // New: Model Selection
        availableModels: [],
        selectedModel: localStorage.getItem('MYDEALZ_GEMINI_MODEL') || 'gemini-2.0-flash'
    };

    // ==========================================
    // 3. GEMINI API INTEGRATION
    // ==========================================
    const GeminiAPI = {
        KEY_STORAGE: 'MYDEALZ_GEMINI_KEY',
        // Dynamic Model Getter
        get MODEL() { return state.selectedModel; },
        
        async getKey() {
            let key = localStorage.getItem(this.KEY_STORAGE);
            return key;
        },
        
        async analyze(prompt, options = {}) {
            const key = await this.getKey();
            if (!key) throw new Error("Kein API Key vorhanden");
            
            const maxTokens = options.maxTokens || 1000;
            const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 2;

            return new Promise((resolve, reject) => {
                const attempt = (tryIndex, delayMs) => {
                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: `https://generativelanguage.googleapis.com/v1beta/models/${this.MODEL}:generateContent?key=${key}`,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({
                            contents: [{
                                parts: [{ text: prompt }]
                            }],
                            generationConfig: {
                                maxOutputTokens: maxTokens,
                                temperature: 0.7
                            }
                        }),
                        timeout: 30000,
                        onload: (response) => {
                            // Self-Healing: Invalid Key Detection
                            if (response.status === 400 || response.status === 403) {
                                // Do not auto-delete immediately on 4xx, user might have just pasted wrong
                                // But for automation 400 Usually means Bad Request (key invalid)
                                // response.status === 403 (Permission Denied)
                                // We can remove it to force re-entry or just fail
                                localStorage.removeItem(this.KEY_STORAGE);
                                reject(new Error("❌ Ungültiger API Key (wurde gelöscht). Bitte neu eingeben."));
                                return;
                            }
                            
                            if (response.status === 429) {
                                if (tryIndex < maxRetries) {
                                    const nextDelay = Math.min(8000, delayMs * 2);
                                    Logger.add(`⏳ Rate Limit. Retry ${tryIndex + 1}/${maxRetries} in ${nextDelay / 1000}s`, 'WARN');
                                    setTimeout(() => attempt(tryIndex + 1, nextDelay), nextDelay);
                                    return;
                                }
                                reject(new Error("⏳ Rate Limit erreicht. Bitte später erneut versuchen."));
                                return;
                            }
                            
                            if (response.status !== 200) {
                                reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
                                return;
                            }
                            
                            try {
                                const data = JSON.parse(response.responseText);
                                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                                if (!text) {
                                    reject(new Error("Keine Antwort von Gemini erhalten"));
                                    return;
                                }
                                resolve(text);
                            } catch (e) {
                                reject(new Error("JSON Parse Error: " + e.message));
                            }
                        },
                        onerror: () => reject(new Error("🌐 Netzwerkfehler")),
                        ontimeout: () => reject(new Error("⏱️ Timeout nach 30s"))
                    });
                };

                attempt(0, 1000);
            });
        },
        
        async listModels(key, forceRefresh = false) {
             const CACHE_KEY = 'MYDEALZ_GEMINI_MODELS_CACHE';
             let fallbackModels = []; 

             try {
                 // 1. Check Cache (only if not forced)
                 const cachedRaw = localStorage.getItem(CACHE_KEY);
                 if (cachedRaw) {
                     const cached = JSON.parse(cachedRaw);
                     fallbackModels = cached.models;
                     if (!forceRefresh) {
                        const age = Date.now() - cached.timestamp;
                        if (age < 24 * 60 * 60 * 1000) {
                            Logger.add(`Using cached models`, 'INFO');
                            return cached.models;
                        }
                     }
                 }
             } catch(e) { /* ignore */ }

             // 2. Fetch Fresh
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
                    onload: (res) => {
                        if (res.status === 200) {
                            try {
                                const data = JSON.parse(res.responseText);
                                const models = data.models
                                    .filter(m => m.supportedGenerationMethods.includes("generateContent"))
                                    .map(m => m.name.replace('models/', ''));
                                
                                Logger.add(`Fetched ${models.length} models from API`, 'INFO');
                                
                                localStorage.setItem(CACHE_KEY, JSON.stringify({
                                    timestamp: Date.now(),
                                    models: models
                                }));
                                
                                resolve(models);
                            } catch(e) { 
                                Logger.error("Model parse error", e);
                                resolve(fallbackModels);
                            }
                        } else {
                            Logger.add(`Model List Fetch Failed: ${res.status}`, 'WARN');
                            resolve(fallbackModels);
                        }
                    },
                    onerror: () => resolve(fallbackModels)
                });
            });
        },

        async checkKey(key) {
            // SIMPLE VALIDATION STRATEGY:
            // Just try to list models. If we get a list, the Key is Valid.
            Logger.add("🔑 Validating Key via Model List...", 'INFO');
            
            const models = await this.listModels(key, true); // Force Refresh
            
            if (models && models.length > 0) {
                Logger.add("✅ API Key verified!", 'INFO');
                
                // Update State
                state.availableModels = models;
                
                // Ensure selected model is valid
                if(!state.availableModels.includes(state.selectedModel)) {
                    // Prefer efficient flash models
                    const preferred = models.find(m => m.includes('1.5-flash')) || models[0];
                    state.selectedModel = preferred;
                    localStorage.setItem('MYDEALZ_GEMINI_MODEL', state.selectedModel);
                    Logger.add(`Model auto-switched to: ${state.selectedModel}`, 'INFO');
                }
                
                return { ok: true, models };
            } else {
                return { ok: false, error: "Could not fetch models. Key invalid?" };
            }
        },

        resetKey() {
            localStorage.removeItem(this.KEY_STORAGE);
        }
    };

    // ... (CacheManager) ...

    // ... (rest of code) ...

        // ... (inside renderGeminiUI)



    // ==========================================
    // 4. CACHE MANAGER (LocalStorage)
    // ==========================================
    const CacheManager = {
        PREFIX: 'mdz_cache_',
        MAX_SIZE: 4.5 * 1024 * 1024, // 4.5MB Safety Margin
        
        async get(threadId) {
            try {
                const key = this.PREFIX + threadId;
                const raw = localStorage.getItem(key);
                if (!raw) return null;
                
                const data = JSON.parse(raw);
                // 1h Cache TTL
                if (Date.now() - data.timestamp < 60 * 60 * 1000) {
                    return data;
                }
                localStorage.removeItem(key);
                return null;
            } catch (e) {
                console.error("Cache read error:", e);
                return null;
            }
        },
        
        async set(threadId, meta, comments) {
            try {
                const key = this.PREFIX + threadId;
                const data = JSON.stringify({
                    threadId, meta, comments, 
                    timestamp: Date.now()
                });
                
                // Size Check
                if (data.length > this.MAX_SIZE) {
                    console.warn("⚠️ Data too large for cache (>4.5MB)");
                    return null;
                }
                
                localStorage.setItem(key, data);
                return { threadId, meta, comments, timestamp: Date.now() };
            } catch (e) {
                if (e.name === 'QuotaExceededError') {
                    // Auto-cleanup oldest entries
                    this._evictOldest();
                    try {
                        localStorage.setItem(key, data);
                    } catch {
                        Logger.add("LocalStorage Full!", 'ERROR');
                        console.warn("⚠️ LocalStorage voll. Bitte Browser-Cache leeren.");
                        // NO ALERT!
                        return null;
                    }
                }
                console.error("Cache write error:", e);
                return null;
            }
        },

        async delete(threadId) {
            localStorage.removeItem(this.PREFIX + threadId);
        },
        
        _evictOldest() {
            const entries = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key.startsWith(this.PREFIX)) {
                    try {
                        const data = JSON.parse(localStorage.getItem(key));
                        entries.push({ key, timestamp: data.timestamp });
                    } catch {}
                }
            }
            entries.sort((a, b) => a.timestamp - b.timestamp);
            if (entries.length > 0) {
                localStorage.removeItem(entries[0].key);
                console.log("🗑️ Evicted oldest cache entry:", entries[0].key);
            }
        }
    };

    // ==========================================
    // 5. CORE UTILS
    // ==========================================
    function getThreadId() {
        const store = unsafeWindow.__INITIAL_STATE__;
        if (store && store.threadDetail) {
            return store.threadDetail.threadId;
        }
        const match = window.location.pathname.match(/-(\d+)(?:\?|$)/);
        return match ? match[1] : null;
    }

    function getCookie(name) {
        const v = `; ${document.cookie}`;
        const p = v.split(`; ${name}=`);
        if (p.length === 2) return p.pop().split(';').shift();
    }

    function cleanText(html) {
        if (!html) return "";
        
        // DOMPurify für XSS-Schutz
        const clean = DOMPurify.sanitize(html, { 
            ALLOWED_TAGS: ['a', 'br'],
            KEEP_CONTENT: true 
        });
        
        const parser = new DOMParser();
        const doc = parser.parseFromString(clean, 'text/html');
        
        // Convert Links: <a href="...">text</a> → [text](url)
        doc.querySelectorAll('a').forEach(a => {
            const url = a.getAttribute('href'); 
            const label = a.textContent.trim() || "Link";
            if (url && !url.startsWith('javascript:') && !url.startsWith('data:')) {
                a.replaceWith(document.createTextNode(` [${label}](${url}) `));
            } else {
                a.replaceWith(document.createTextNode(` [${label}] `));
            }
        });

        doc.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode(' ')));
        return doc.body.textContent.replace(/\s+/g, ' ').trim();
    }

    function sleep(ms) { return new Promise(r => window.setTimeout(r, ms)); }
    
    // Performance: Yield to UI Thread
    async function yieldToUI() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    // ==========================================
    // 6. DATA EXTRACTION
    // ==========================================
    function getMetadata() {
        // [FIX] Illegal Invocation: Access unsafeWindow safely
        let store = {};
        try {
            // Clone simple data only to avoid context issues with getters
            const raw = unsafeWindow.__INITIAL_STATE__;
            if (raw) {
                store = JSON.parse(JSON.stringify(raw)); 
            }
        } catch(e) {
            Logger.error("UnsafeWindow Access Failed (Fallback active)", e);
        }

        const details = store.threadDetail || store.data?.thread || {};
        
        let title = details.title || document.querySelector('h1.thread-title')?.innerText || document.title;
        
        let merchant = details.merchant?.merchantName;
        if (!merchant) {
            const availNode = [...document.querySelectorAll('span')].find(s => s.textContent.includes('Verfügbar bei'));
            if (availNode) {
                const link = availNode.querySelector('a') || availNode.nextElementSibling?.querySelector('a');
                if (link) merchant = link.innerText.trim();
            }
            if (!merchant || merchant === "OTTO") { 
                const merchEl = document.querySelector('a[data-t="merchantLink"]');
                if (merchEl && !merchEl.href.includes('/gutscheine/') && !merchEl.href.includes('subid')) {
                    merchant = merchEl.innerText.trim();
                }
            }
        }
        merchant = merchant || "N/A";

        let op = details.user?.username;
        if (!op || op === "Unbekannt") {
            const opContainer = document.querySelector('.thread-user') || document.querySelector('.thread-user-name');
            if (opContainer) {
                const nameSpan = opContainer.querySelector('span:first-child');
                if (nameSpan) {
                     op = nameSpan.innerText.trim();
                } else {
                     op = opContainer.innerText.trim().split('\n')[0];
                }
            }
        }
        op = op || "Unbekannt";

        const price = details.price || document.querySelector('.thread-price')?.innerText || "N/A";
        const temp = details.temperature || document.querySelector('.vote-temp')?.innerText || "N/A";
        let commentCount = details.commentCount;
        if (!commentCount) {
             const countEl = document.querySelector('.comments-header-renderer');
             if (countEl) commentCount = parseInt(countEl.innerText.replace(/\D/g, '')) || 0;
        }
        commentCount = commentCount || 0;

        let createdAtTs = details.createdAt;
        if (!createdAtTs) {
            const dateSpan = document.querySelector('.space--mv-3 span[title]');
            if (dateSpan) {
                const titleStr = dateSpan.getAttribute('title');
                const parts = titleStr.match(/(\d{2})\.(\d{2})\.(\d{4}), (\d{2}):(\d{2}):(\d{2})/);
                if (parts) {
                    createdAtTs = new Date(`${parts[3]}-${parts[2]}-${parts[1]}T${parts[4]}:${parts[5]}:${parts[6]}`).getTime() / 1000;
                }
            }
        }
        
        const createdDate = createdAtTs ? new Date(createdAtTs * 1000) : new Date();
        const now = new Date();
        const diffTime = Math.abs(now - createdDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

        const isExpired = details.isExpired || document.querySelector('.thread--expired') !== null;
        const status = isExpired ? "Abgelaufen ❌" : "Aktiv ✅";

        if (merchant && merchant !== "N/A") {
            const pattern = new RegExp(`^\\[${merchant}\\]\\s*`, 'i');
            title = title.replace(pattern, '');
        }

        return {
            Titel: title.trim(),
            URL: window.location.href,
            OP: op,
            DealInfo: {
                Preis: price,
                Händler: merchant,
                Temperatur: temp.toString().replace(/°/g, '') + "°",
                Status: status,
                Erstellt: createdDate.toLocaleDateString(),
                Alter: `${diffDays} Tage`
            },
            MetaCount: commentCount,
            ExportDatum: now.toLocaleString()
        };
    }

    async function makeGqlRequest(query, variables, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch("https://www.mydealz.de/graphql", {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-pepper-txn': 'threads.show.deal',
                        'x-request-type': 'application/vnd.pepper.v1+json',
                        'x-xsrf-token': state.xsrfToken
                    },
                    signal: state.abortController?.signal,
                    body: JSON.stringify({ query, variables })
                });

                if (response.status === 429) {
                    const retryAfter = parseInt(response.headers.get('Retry-After')) || (attempt * 2);
                    console.warn(`⏳ Rate Limit. Warte ${retryAfter}s...`);
                    await sleep(retryAfter * 1000);
                    continue;
                }

                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const json = await response.json();
                if (json.errors) throw new Error(json.errors[0].message);
                
                return json.data;
            } catch (e) {
                if (attempt === retries) throw e;
                await sleep(1000 * attempt);
            }
        }
    }

    const USER_FIELDS = `user { username bestBadge { level { name } } }`;
    const COMMENT_FIELDS = `
        commentId
        ${USER_FIELDS}
        preparedHtmlContent
        reactionCounts { type count }
        createdAtTs
        replyCount
    `;

    async function fetchRootComments(page) {
        const query = `query comments($filter: CommentFilter!, $limit: Int, $page: Int) {
          comments(filter: $filter, limit: $limit, page: $page) {
            items { ${COMMENT_FIELDS} }
            pagination { current last }
          }
        }`;
        const data = await makeGqlRequest(query, {
            filter: { threadId: { eq: state.threadId }, order: { direction: "Ascending" } },
            page, limit: 100
        });
        return data ? data.comments : null;
    }

    async function fetchNestedReplies(mainCommentId) {
        const query = `query comments($filter: CommentFilter!, $limit: Int, $page: Int) {
          comments(filter: $filter, limit: $limit, page: $page) {
            items { ${COMMENT_FIELDS} }
          }
        }`;
        const data = await makeGqlRequest(query, {
            filter: { mainCommentId, threadId: { eq: state.threadId }, order: { direction: "Ascending" } },
            page: 1, limit: 100
        });
        return data ? data.comments.items : [];
    }

    function transformComment(item) {
        if (!item || !item.user) {
            return {
                id: item?.commentId || 'unknown',
                user: '[Gelöscht]',
                rawUser: null,
                text: '[Dieser Kommentar wurde entfernt]',
                date: 'N/A',
                replies: []
            };
        }

        let like = 0, helpful = 0, funny = 0;
        if (item.reactionCounts) {
            item.reactionCounts.forEach(r => {
                const t = r.type;
                if (t === 'LIKE') like = r.count;
                if (t === 'HELPFUL') helpful = r.count;
                if (t === 'FUNNY') funny = r.count;
            });
        }

        let userLabel = item.user.username || 'Unbekannt';
        if (state.opUsername && userLabel === state.opUsername) userLabel += ' [OP]';
        
        const node = {
            id: item.commentId,
            user: userLabel,
            rawUser: item.user.username,
            text: cleanText(item.preparedHtmlContent),
            date: new Date(item.createdAtTs * 1000).toISOString().split('T')[0],
            replies: [] 
        };

        if (like > 0 || helpful > 0 || funny > 0) {
            node.reactions = { like, helpful, funny };
        }

        return node;
    }

    async function runExport(btn, forceRefresh = false) {
        // Safe Toast Helper for Main Page
        const showGlobalToast = (msg, isError = false) => {
            const t = document.createElement('div');
            Object.assign(t.style, {
                position: 'fixed', bottom: '70px', right: '20px', zIndex: 100000,
                background: isError ? '#EF4444' : '#10B981', color:'white', padding:'8px 16px', borderRadius:'20px',
                fontSize:'12px', fontWeight:'bold', boxShadow:'0 4px 12px rgba(0,0,0,0.2)', pointerEvents: 'none', transition: 'opacity 0.3s'
            });
            t.textContent = msg;
            document.body.appendChild(t);
            setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
        };

        if (state.isScraping) {
            Logger.add("Export declined: Already running. Reload to abort.", 'WARN');
            return; 
        }

        state.isScraping = true;
        Logger.add("Starting Export...");
        state.abortController = new AbortController();
        
        try {
            state.threadId = getThreadId();
            state.xsrfToken = decodeURIComponent(getCookie('xsrf_t'));
        } catch(e) {
            Logger.error("Init Failed", e);
            GM_setClipboard(Logger.getReport());
            showGlobalToast("❌ Init Fehler: " + e.message, true);
            state.isScraping = false; 
            return;
        }

        state.collectedRoots = [];

        if (!state.threadId) { 
            Logger.add("No Thread ID found", 'ERROR');
            GM_setClipboard(Logger.getReport());
            showGlobalToast("❌ Fehler: Thread ID fehlt (Logs kopiert)", true);
            state.isScraping = false; 
            return; 
        }

        btn.disabled = true;

        try {
            // 1. Check Cache
            if (!forceRefresh) {
                const cached = await CacheManager.get(state.threadId);
                if (cached) {
                    Logger.add("Cache Hit");
                    state.metaData = cached.meta;
                    state.collectedRoots = cached.comments;
                    state.metaData._fromCache = true;
                    state.metaData._cacheTime = cached.timestamp;
                    openUi();
                    return;
                }
            }

            // 2. Fresh Scrape
            btn.textContent = "⏳ Extracting Meta...";
            await sleep(500);

            Logger.add("Fetching Metadata...");
            state.metaData = getMetadata();
            
            if (state.metaData.DealInfo.Händler !== "N/A") {
                const pattern = new RegExp(`^\\[${state.metaData.DealInfo.Händler}\\]\\s*`, 'i');
                state.metaData.Titel = state.metaData.Titel.replace(pattern, '');
            }

            state.opUsername = state.metaData.OP;
            
            let totalEst = state.metaData.MetaCount;
            if (totalEst === 0) totalEst = "?";

            Logger.add(`Starting Comment Fetch. Est: ${totalEst}`);
            const firstPage = await fetchRootComments(1);
            if (!firstPage) throw new Error("API Limit erreicht");
            const totalPages = firstPage.pagination.last;
            
            let count = 0;
            const processItems = async (items) => {
                const nodes = [];
                const CHUNK_SIZE = 25;

                for (let i = 0; i < items.length; i += CHUNK_SIZE) {
                    const chunk = items.slice(i, i + CHUNK_SIZE);
                    
                    // Yield to UI Thread
                    await yieldToUI();

                    for (const item of chunk) {
                        try {
                            const node = transformComment(item);
                            count++;
                            const progressStr = totalEst === "?" ? count : `${count}/${totalEst}`;
                            btn.textContent = `⏳ ${progressStr}...`;
                            
                            if (item.replyCount > 0) {
                                const replies = await fetchNestedReplies(item.commentId);
                                for (const r of replies) {
                                    node.replies.push(transformComment(r));
                                    count++;
                                    const progressStrRep = totalEst === "?" ? count : `${count}/${totalEst}`;
                                    btn.textContent = `⏳ ${progressStrRep}...`;
                                }
                            }
                            nodes.push(node);
                        } catch(err) {
                            Logger.error("Item Transform Error", err);
                        }
                    }
                }
                return nodes;
            };
            
            state.collectedRoots.push(...await processItems(firstPage.items));

            for (let p = 2; p <= totalPages; p++) {
                await sleep(150);
                const data = await fetchRootComments(p);
                if (data) state.collectedRoots.push(...await processItems(data.items));
            }

            state.metaData.Statistik = { Total: count };
            Logger.add(`Export Done. Total: ${count}`);
            
            // 3. Save to Cache
            await CacheManager.set(state.threadId, state.metaData, state.collectedRoots);
            
            openUi();

        } catch (e) {
            if (e.name === 'AbortError') {
                Logger.add("Export Aborted");
                btn.textContent = "❌ Aborted";
            } else {
                Logger.error("Fatal Export Error", e);
                GM_setClipboard(Logger.getReport());
                // Create a temporary toast if UI is not open yet (unlikely here as openUi is called at end, but error happens before)
                // We reuse the showToast logic from OpenUI if possible? No, OpenUI scope is different.
                // We need a global toast or simple fallback.
                // Since this error happens BEFORE runExport finishes, UI might not be open.
                // But runExport is async. The UI opens only on success/cache hit.
                // So we need a fallback alert or simple DOM element if toast is not available.
                const msg = "❌ Export Error! Logs copied to clipboard.";
                
                // Simple DOM Toast injection for main page
                const t = document.createElement('div');
                Object.assign(t.style, {
                    position: 'fixed', bottom: '70px', right: '20px', zIndex: 100000,
                    background: '#EF4444', color:'white', padding:'8px 16px', borderRadius:'20px',
                    fontSize:'12px', fontWeight:'bold', boxShadow:'0 4px 12px rgba(0,0,0,0.2)'
                });
                t.textContent = msg;
                document.body.appendChild(t);
                setTimeout(() => t.remove(), 4000);
            }
        } finally {
            state.isScraping = false;
            state.abortController = null;
            if (btn.textContent !== "❌ Aborted") btn.textContent = "🧠 AI Export";
            btn.disabled = false;
        }
    }

    // ==========================================
    // 7. UI IMPLEMENTATION (DOM POPULATION)
    // ==========================================
    function populateUi(d, state) {
        // Meta Data
        const m = state.metaData;
        d.getElementById('meta-title').textContent = m.Titel.substring(0,30) + (m.Titel.length>30?'...':'');
        d.getElementById('meta-status').textContent = m.DealInfo.Status;
        d.getElementById('meta-age').textContent = m.DealInfo.Alter;
        d.getElementById('meta-price').textContent = m.DealInfo.Preis;
        d.getElementById('meta-count').textContent = m.Statistik.Total;

        if (m._fromCache) {
             const ci = d.getElementById('meta-cache');
             ci.style.display = 'block';
             const date = new Date(m._cacheTime).toLocaleTimeString();
             d.getElementById('meta-cache-time').textContent = `(${date})`;
        }

        // External Tools
        const toolsContainer = d.getElementById('external-tools');
        toolsContainer.innerHTML = AI_URLS.map(ai => 
            `<button class="btn" onclick="window.open('${ai.url}')">${ai.name}</button>`
        ).join('');
    }

    function downloadFile(filename, content, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function openUi() {
        const w = window.open('', '_blank', 'width=1200,height=900');
        if(!w) {
             Logger.add("Popup blocked by Browser!", 'ERROR');
             console.error("Popup Blocked - Check Browser Settings");
             return;
        }

        w.UnsafeRunExport = () => runExport(document.querySelector('#mydealz-ai-btn'), true);

        w.document.title = "MyDealz AI Export v13.0";
        const d = w.document;

        d.head.innerHTML = `<style>${getUiCss()}</style>`;
        d.body.innerHTML = getUiHtml(); 
        
        // Populate Dynamic Data safely via DOM
        populateUi(d, state);

        const out = d.getElementById('output');
        const aiOut = d.getElementById('aiOutput');
        const tabContainer = d.getElementById('tabContainer');
        const toast = d.getElementById('toast');
        const geminiContainer = d.getElementById('geminiContainer');

        const showToast = (msg) => {
            toast.innerHTML = msg;
            toast.classList.add('visible');
            setTimeout(() => toast.classList.remove('visible'), 2000);
        };

        const appendLog = (msg) => {
            const next = `${out.value}\n${msg}`.trim();
            out.value = next;
        };

        // Tabs Logic
        Object.keys(PROMPT_LEVELS).forEach(key => {
            const b = d.createElement('button');
            b.className = `tab-btn ${key === 'MEDIUM' ? 'active' : ''}`;
            b.textContent = PROMPT_LEVELS[key].label;
            b.onclick = () => {
                d.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
                b.classList.add('active');
                state.currentPromptLevel = key;
                // Switch back to text view if we were in AI view
                aiOut.style.display = 'none';
                out.style.display = 'block';
                out.value = buildPrompt(key, state.metaData, state.collectedRoots);
            };
            tabContainer.appendChild(b);
        });

        // Initial Render
        out.value = buildPrompt(state.currentPromptLevel, state.metaData, state.collectedRoots);

        // Buttons
        d.getElementById('settingsBtn').onclick = () => {
             // If key exists, confirm delete. If not, just show toast.
             if(localStorage.getItem(GeminiAPI.KEY_STORAGE)) {
                // Deleted feature to avoid confirm()
                showToast("Nutze Refresh-Button für Reset!");
             } else {
                 showToast("ℹ️ Kein API Key gespeichert");
             }
        };

        d.getElementById('copyBtn').onclick = async () => {
            const out = d.getElementById('output');
            if(!out.value) return;
            const res = await Clipboard.write(out.value, d);
            if (res.ok) {
                Logger.add(`Clipboard OK (${res.method})`, 'INFO');
                showToast("✅ Kopiert!");
            } else {
                Logger.add(`Clipboard FAIL (${res.method}): ${res.error}`, 'ERROR');
                showToast("❌ Clipboard nicht verfügbar");
                appendLog(`\n❌ Clipboard FAIL (${res.method}): ${res.error}`);
                logToConsole(`Clipboard FAIL (${res.method}): ${res.error}`, 'warn', w);
            }
        };

        const safeTitle = state.metaData.Titel.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const dateStr = new Date().toISOString().split('T')[0];
        const baseName = `${dateStr}_${safeTitle}_mydealz`;

        d.getElementById('saveMd').onclick = () => downloadFile(`${baseName}.md`, d.getElementById('output').value, 'text/markdown');
        d.getElementById('saveJson').onclick = () => downloadFile(`${baseName}.json`, JSON.stringify({meta: state.metaData, comments: state.collectedRoots},null,2), 'application/json');
        
        // 2-Step Reset Logic
        const refreshBtn = d.getElementById('refreshBtn');
        let resetConfirm = false;
        refreshBtn.onclick = async () => {
             if(!resetConfirm) {
                 resetConfirm = true;
                 refreshBtn.textContent = "🗑️ Sicher? (Klick nochmal)";
                 refreshBtn.style.color = "red";
                 setTimeout(() => {
                     resetConfirm = false;
                     refreshBtn.textContent = "🔄 Neu laden";
                     refreshBtn.style.color = "";
                 }, 3000);
                 return;
             }
             
             // Confirmed
             await CacheManager.delete(state.metaData.OP ? state.threadId : getThreadId());
             localStorage.removeItem(GeminiAPI.KEY_STORAGE);
             try {
                 const keys = [];
                 for(let i=0; i<localStorage.length; i++) {
                     const k = localStorage.key(i);
                     if(k && (k.startsWith('mdz_') || k.includes('MYDEALZ'))) keys.push(k);
                 }
                 keys.forEach(k => localStorage.removeItem(k));
                 Logger.add("Factory Reset executed", 'INFO');
             } catch(e) { console.error(e); }

             if(w.UnsafeRunExport) w.UnsafeRunExport(); 
             w.close(); 
        };

        // --- GEMINI UI LOGIC ---
        async function renderGeminiUI() {
            const hasKey = localStorage.getItem(GeminiAPI.KEY_STORAGE);
            
            if (hasKey) {
                if (!state.availableModels || state.availableModels.length === 0) {
                    try {
                        const key = await GeminiAPI.getKey();
                        state.availableModels = await GeminiAPI.listModels(key, false);
                    } catch (e) {
                        Logger.error("Model preload failed", e);
                    }
                }

                const promptText = out.value || buildPrompt(state.currentPromptLevel, state.metaData, state.collectedRoots);
                const { chars, tokens } = estimateTokensFromText(promptText);
                const suggestion = suggestModelByTokens(tokens, state.availableModels);
                const suggestionText = suggestion.model
                    ? `Empfohlen: ${suggestion.model} (${suggestion.reason}, chars=${chars})`
                    : `Empfehlung: keine (chars=${chars}, tokens≈${tokens})`;

                const modelOptions = (state.availableModels && state.availableModels.length > 0)
                    ? state.availableModels.map(m => `<option value="${m}">${m}</option>`).join('')
                    : '<option value="">(keine Modelle geladen)</option>';

                const selectDisabled = state.availableModels && state.availableModels.length > 0 ? '' : 'disabled';

                geminiContainer.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:6px;">
                        <div style="display:flex; gap:8px; align-items:center;">
                            <select id="geminiModelSelect" style="padding: 6px; border:1px solid #CBD5E1; border-radius:6px; font-size:12px; outline:none; max-width: 260px;" ${selectDisabled}>
                                ${modelOptions}
                            </select>
                            <button class="btn btn-ai" id="geminiBtn">✨ Gemini Analyze</button>
                        </div>
                        <div id="geminiHint" style="font-size:11px; color:#64748b;">${suggestionText}</div>
                    </div>
                `;
                
                const modelSelect = d.getElementById('geminiModelSelect');
                if (modelSelect && state.selectedModel) {
                    modelSelect.value = state.selectedModel;
                }

                if (modelSelect) {
                    modelSelect.onchange = () => {
                        const selected = modelSelect.value;
                        if (selected) {
                            state.selectedModel = selected;
                            localStorage.setItem('MYDEALZ_GEMINI_MODEL', selected);
                            Logger.add(`Model selected: ${selected}`, 'INFO');
                            showToast(`✅ Modell: ${selected}`);
                        }
                    };
                }

                if (suggestion.model && modelSelect && modelSelect.value !== suggestion.model) {
                    modelSelect.value = suggestion.model;
                    state.selectedModel = suggestion.model;
                    localStorage.setItem('MYDEALZ_GEMINI_MODEL', suggestion.model);
                    Logger.add(`Model auto-suggested: ${suggestion.model}`, 'INFO');
                }

                const btn = d.getElementById('geminiBtn');
                btn.onclick = async () => {
                    if (btn.classList.contains('loading')) return;
                    
                    // Build Prompt based on selected level
                    const userPrompt = out.value || buildPrompt(state.currentPromptLevel, state.metaData, state.collectedRoots);

                    try {
                        btn.classList.add('loading');
                        btn.textContent = "✨ Analyzing...";
                        
                        const result = await GeminiAPI.analyze(userPrompt, { maxRetries: 2 });
                        
                        // Show Result
                        out.style.display = 'none';
                        aiOut.style.display = 'block';
                        let html = (typeof window.marked !== 'undefined' && window.marked.parse) ? window.marked.parse(result) : result.replace(/\n/g, '<br>');
                        aiOut.innerHTML = `<div class="ai-result">${html}</div>`;

                        showToast("✅ Analyse fertig!");
                        
                    } catch (e) {
                        Logger.error("AI Error", e);
                        const report = Logger.getReport();
                        const clip = await Clipboard.write(report, d);
                        if (clip.ok) {
                            showToast(`❌ Error (Logs copied: ${clip.method})`);
                        } else {
                            showToast("❌ Error (Clipboard not available)");
                            appendLog(`\n❌ Clipboard FAIL (${clip.method}): ${clip.error}`);
                            logToConsole(`Clipboard FAIL (${clip.method}): ${clip.error}`, 'warn', w);
                        }
                    } finally {
                        btn.classList.remove('loading');
                        btn.textContent = "✨ Gemini Analyze";
                    }
                };
            } else {
                // Show Input + Link
                geminiContainer.innerHTML = `
                    <div style="display:flex; gap:6px; align-items:center;">
                        <input type="password" id="apiKeyInput" placeholder="API Key einfügen..." style="padding: 6px; border:1px solid #CBD5E1; border-radius:6px; font-size:12px; width: 160px; outline:none;">
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" class="btn" style="text-decoration:none; padding: 6px 10px;" title="Get API Key from Google">🔑</a>
                        <span id="keyStatus" style="font-size:12px; font-weight:bold; width: 24px;"></span>
                    </div>
                `;
                
                const input = d.getElementById('apiKeyInput');
                const status = d.getElementById('keyStatus');
                
                let debounceTimer;
                const validate = async (key) => {
                    if (!key || key.length < 10) return;
                    status.textContent = "⏳";
                    input.disabled = true; 
                    
                    try {
                        const result = await GeminiAPI.checkKey(key);
                        if (result.ok) {
                            localStorage.setItem(GeminiAPI.KEY_STORAGE, key);
                            status.textContent = "✅";
                            showToast("✅ API Key registriert!");
                            setTimeout(renderGeminiUI, 500); 
                        } else {
                            status.textContent = "❌";
                            // Show full error in the main text box so user can copy it
                            const out = document.getElementById('output');
                            out.style.display = 'block';
                            out.value = `❌ API ERROR DETAILS:\n\n${result.error}\n\n(Bitte diesen Text kopieren und prüfen!)`;
                            
                            showToast("❌ Fehler! Siehe Textfeld unten 👇");
                            Logger.add(`API Validation Failed: ${result.error}`, 'ERROR');
                            input.disabled = false;
                            input.focus();
                        }
                    } catch(e) {
                        status.textContent = "❌";
                        input.disabled = false;
                        console.error(e);
                    }
                };

                input.oninput = () => {
                    status.textContent = "";
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => validate(input.value.trim()), 800);
                };
            }
        }
        
        renderGeminiUI();
    }

    function init() {
        if (document.getElementById('mydealz-ai-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'mydealz-ai-btn'; 
        btn.textContent = "🧠 AI Export";
        Object.assign(btn.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: 99999,
            padding: '12px 20px', background: THEME.primary, color: 'white',
            border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            transition: 'transform 0.2s',
            userSelect: 'none'
        });
        
        btn.onmouseover = () => btn.style.transform = 'scale(1.05)';
        btn.onmouseout = () => btn.style.transform = 'scale(1)';
        
        // --- LONG PRESS DEBUGGING ---
        let pressTimer = null;
        let countdownInterval = null;
        let isLongPress = false;
        let seconds = 3;

        const reset = () => {
            clearTimeout(pressTimer);
            clearInterval(countdownInterval);
            pressTimer = null;
            countdownInterval = null;
            seconds = 3;
            if(!state.isScraping) btn.textContent = "🧠 AI Export";
            // Do not reset isLongPress here immediately if it was used to block click
        };

        const startCountdown = () => {
             btn.textContent = `🐞 Debug: ${seconds}...`;
             countdownInterval = setInterval(() => {
                 seconds--;
                 if(seconds > 0) {
                     btn.textContent = `🐞 Debug: ${seconds}...`;
                 } else {
                     // 3 Seconds over
                     clearInterval(countdownInterval);
                     GM_setClipboard(Logger.getReport());
                     btn.textContent = "✅ Logs copied!";
                     
                     // Create Toast
                     const t = document.createElement('div');
                     Object.assign(t.style, {
                         position: 'fixed', bottom: '70px', right: '20px', zIndex: 100000,
                         background: '#10B981', color:'white', padding:'8px 16px', borderRadius:'20px',
                         fontSize:'12px', fontWeight:'bold', boxShadow:'0 4px 12px rgba(0,0,0,0.2)'
                     });
                     t.textContent = "📋 Error Logs copied to clipboard!";
                     document.body.appendChild(t);
                     setTimeout(() => t.remove(), 3000);
                 }
             }, 1000);
        };

        btn.addEventListener('mousedown', (e) => {
            if(e.button !== 0) return; // Only Left Click
            isLongPress = false; 
            reset();
            // Wait 500ms before starting debug mode
            pressTimer = setTimeout(() => {
                isLongPress = true; // Flag to prevent normal click
                startCountdown();
            }, 500);
        });

        btn.addEventListener('mouseup', (e) => {
            if (isLongPress) {
                // If it was a long press, we stop everything but DON'T run export
                reset();
                // isLongPress remains true for the click handler to see? 
                // Using stopImmediatePropagation might be better but mixing native/custom events is tricky.
                // We use the variable check in onclick.
            } else {
                // Short press: Cancel timer
                reset();
            }
        });

        btn.addEventListener('mouseleave', reset);

        btn.onclick = (e) => {
            if(isLongPress) {
                e.preventDefault();
                e.stopPropagation();
                isLongPress = false; 
                return;
            }
            runExport(btn);
        };

        document.body.appendChild(btn);
    }
    
    // Auto-Run
    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

    } catch (e) {
        console.error("🔥 Logic JS Initialization Failed:", e);
    }
})();
