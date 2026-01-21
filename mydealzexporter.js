// ==UserScript==
// @name         MyDealz_01_Deep_State_AI_Exporter (Final v11.0) 🧠
// @namespace    violentmonkey
// @version      12.3
// @description  Beste UI (Controls Top), Progress Tracking & Nested Comments.
// @match        https://www.mydealz.de/diskussion/*
// @match        https://www.mydealz.de/deals/*
// @match        https://www.mydealz.de/gutscheine/*
// @icon         https://www.mydealz.de/favicon.svg
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. CONFIG & STYLES (Fixed Full-Window Layout)
    // ==========================================
    const THEME = {
        primary: '#0F172A',     // Slate 900
        secondary: '#334155',
        accent: '#2563EB',      // Blue 600
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

    const fmtMeta = (meta) => JSON.stringify(meta, null, 2);

    const formatComments = (comments, level = 0) => {
        return comments.map(c => {
            const indent = "  ".repeat(level);
            
            const r = c.reactions || {}; // Handle missing reactions
            const parts = [];
            // SVGs with Fallbacks as requested
            if (r.like > 0) parts.push(`![](https://www.mydealz.de/assets/img/reactions/like_948bf.svg) ${r.like}`);
            if (r.helpful > 0) parts.push(`![✅](https://www.mydealz.de/assets/img/reactions/helpful_4f8f6.svg) ${r.helpful}`);
            if (r.funny > 0) parts.push(`![](https://www.mydealz.de/assets/img/reactions/funny_611f8.svg) ${r.funny}`);

            const reactionStr = parts.length > 0 ? ` [${parts.join(' | ')}]` : '';
            const header = `${indent}👤 **${c.user}** [${c.date}]${reactionStr}`;
            
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
            gen: (meta, comments) => `# SYSTEM: Erstelle eine KURZE Zusammenfassung. Erfasse den Kern der Diskussion, sowie Pro & Contra Argumente und die physischen Produktdaten.\n\n# METADATA\n${fmtMeta(meta)}\n\n# COMMENTS\n${formatComments(comments)}`
        },
        MEDIUM: {
            label: '💡 Standard',
            gen: (meta, comments) => `# SYSTEM: Erstelle eine standardmäßige, längere Zusammenfassung. Gehe besonders auf ALTERNATIVEN ein, die in der Diskussion genannt werden.\n\n# METADATA\n${fmtMeta(meta)}\n\n# COMMENTS\n${formatComments(comments)}`
        },
        DETAILED: {
            label: '🧐 Ausführlich',
            gen: (meta, comments) => `# SYSTEM: Erstelle eine sehr ausführliche Zusammenfassung. Fülle Lücken (Gaps) und suche gezielt nach Informationen, die typischerweise übersehen werden.\n\n# METADATA\n${fmtMeta(meta)}\n\n# COMMENTS\n${formatComments(comments)}`
        }
    };

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
        abortController: null
    };

    // ==========================================
    // 3. CORE UTILS
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

    // ==========================================
    // 3.X GEMINI API HELPERS
    // ==========================================
    async function fetchModels(key) {
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
            if(!res.ok) throw new Error("API Check Failed (HTTP " + res.status + ")");
            const json = await res.json();
            if(!json.models) throw new Error("Keine Modelle gefunden");
            return json.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"));
        } catch(e) {
            console.error(e);
            throw e;
        }
    }

    async function generateWithGemini(key, model, text) {
        const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                contents: [{ parts: [{ text: text }] }]
            })
        });
        if(!res.ok) {
            const err = await res.json();
            throw new Error(err.error?.message || "Gen Failed");
        }
        const json = await res.json();
        return json.candidates?.[0]?.content?.parts?.[0]?.text || "Keine Antwort erhalten.";
    }

    function cleanText(html) {
        if (!html) return "";
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // Extract Links: Convert <a href="...">text</a> to [text](url)
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

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    
    // ==========================================
    // 3.1 CACHE MANAGER (IndexedDB)
    // ==========================================
    const CacheManager = {
        DB_NAME: 'MyDealzExportCache_v2', // Changed name to force fresh DB
        STORE_NAME: 'threads',
        
        async init() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.DB_NAME, 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                        const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'threadId' });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                };
            });
        },
        
        async get(threadId) {
            try {
                const db = await this.init();
                return new Promise((resolve, reject) => {
                    const tx = db.transaction(this.STORE_NAME, 'readonly');
                    const store = tx.objectStore(this.STORE_NAME);
                    const request = store.get(threadId);
                    
                    request.onsuccess = () => {
                        const data = request.result;
                        // Cache Valid for 1 Hour
                        if (data && Date.now() - data.timestamp < 60 * 60 * 1000) {
                            resolve(data);
                        } else {
                        resolve(null);
                        }
                    };
                    request.onerror = () => reject(request.error);
                });
            } catch (e) { console.error("Cache Error", e); return null; }
        },
        
        async set(threadId, meta, comments) {
            try {
                const db = await this.init();
                return new Promise((resolve, reject) => {
                    const tx = db.transaction(this.STORE_NAME, 'readwrite');
                    const store = tx.objectStore(this.STORE_NAME);
                    const data = { threadId, meta, comments, timestamp: Date.now() };
                    const request = store.put(data);
                    request.onsuccess = () => resolve(data);
                    request.onerror = () => reject(request.error);
                });
            } catch (e) { console.error("Cache Write Error", e); }
        },

        async delete(threadId) {
             const db = await this.init();
             const tx = db.transaction(this.STORE_NAME, 'readwrite');
             await tx.objectStore(this.STORE_NAME).delete(threadId);
        }
    };

    // ==========================================
    // 4. DATA EXTRACTION
    // ==========================================
    function getMetadata() {
        const store = unsafeWindow.__INITIAL_STATE__ || {};
        const details = store.threadDetail || store.data?.thread || {};
        
        // Title
        let title = details.title || document.querySelector('h1.thread-title')?.innerText || document.title;
        
        // Merchant - Strict "Verfügbar bei" check
        let merchant = details.merchant?.merchantName;
        if (!merchant) {
            // Find "Verfügbar bei" span
            const availNode = [...document.querySelectorAll('span')].find(s => s.textContent.includes('Verfügbar bei'));
            if (availNode) {
                const link = availNode.querySelector('a') || availNode.nextElementSibling?.querySelector('a');
                if (link) merchant = link.innerText.trim();
            }
            // Fallback: Check global merchant link, excluding ads
            if (!merchant || merchant === "OTTO") { 
                const merchEl = document.querySelector('a[data-t="merchantLink"]');
                if (merchEl && !merchEl.href.includes('/gutscheine/') && !merchEl.href.includes('subid')) {
                    merchant = merchEl.innerText.trim();
                }
            }
        }
        merchant = merchant || "N/A";

        // OP Name - Strict: First span only
        let op = details.user?.username;
        if (!op || op === "Unbekannt") {
            const opContainer = document.querySelector('.thread-user') || document.querySelector('.thread-user-name');
            if (opContainer) {
                // Try to get direct first span child
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

        // Date Logic
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

        // Clean Title
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
                // reactions omitted for deleted comments
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
        if (state.isScraping) {
            if (confirm('Export läuft bereits. Abbrechen?')) {
                state.abortController?.abort();
                state.isScraping = false;
                btn.textContent = "🧠 AI Export";
                btn.disabled = false;
            }
            return;
        }

        state.isScraping = true;
        state.abortController = new AbortController();
        state.threadId = getThreadId();
        state.xsrfToken = decodeURIComponent(getCookie('xsrf_t') || '');
        state.collectedRoots = [];

        if (!state.threadId) { alert("ID Error"); state.isScraping = false; return; }

        btn.disabled = true;

        try {
            const COMMENTS_QUERY = `query comments($filter: CommentFilter!, $limit: Int, $page: Int) {
              comments(filter: $filter, limit: $limit, page: $page) {
                items { ${COMMENT_FIELDS} }
                pagination { current last }
              }
            }`;

            const fetchCommentsPage = async (page) => {
                const data = await makeGqlRequest(COMMENTS_QUERY, {
                    filter: { threadId: { eq: state.threadId }, order: { direction: "Ascending" } },
                    page, limit: 100
                });
                return data ? data.comments : null;
            };

            const fetchAllReplies = async (mainCommentId) => {
                const replies = [];
                let page = 1;
                while (true) {
                    const data = await makeGqlRequest(COMMENTS_QUERY, {
                        filter: { mainCommentId, threadId: { eq: state.threadId }, order: { direction: "Ascending" } },
                        page, limit: 100
                    });
                    const items = data?.comments?.items || [];
                    replies.push(...items);
                    const last = data?.comments?.pagination?.last || 1;
                    if (page >= last) break;
                    page += 1;
                }
                return replies;
            };

            // 1. Check Cache (if not forced)
            if (!forceRefresh) {
                const cached = await CacheManager.get(state.threadId);
                if (cached) {
                    console.log('✅ Loaded from Cache');
                    state.metaData = cached.meta;
                    state.collectedRoots = cached.comments;
                    state.metaData._fromCache = true; // Flag for UI
                    state.metaData._cacheTime = cached.timestamp;
                    openUi();
                    return;
                }
            }

            // 2. Fresh Scrape
            btn.textContent = "⏳ Extracting Meta...";
            await sleep(500);

            state.metaData = getMetadata();

            if (state.metaData.DealInfo.Händler !== "N/A") {
                const pattern = new RegExp(`^\\[${state.metaData.DealInfo.Händler}\\]\\s*`, 'i');
                state.metaData.Titel = state.metaData.Titel.replace(pattern, '');
            }

            state.opUsername = state.metaData.OP;

            // Total Est
            let totalEst = state.metaData.MetaCount;
            if (totalEst === 0) totalEst = "?";

            // Loop Comments (GraphQL)
            const firstPage = await fetchCommentsPage(1);
            if (!firstPage) throw new Error("API Limit");
            const totalPages = firstPage.pagination.last;

            let count = 0;
            const processItems = async (items) => {
                const nodes = [];
                const CHUNK_SIZE = 25;

                for (let i = 0; i < items.length; i += CHUNK_SIZE) {
                    const chunk = items.slice(i, i + CHUNK_SIZE);

                    // Anti-Freeze: Yield to main thread
                    await new Promise(r => setTimeout(r, 0));

                    for (const item of chunk) {
                        const node = transformComment(item);
                        count++;
                        const progressStr = totalEst === "?" ? count : `${count}/${totalEst}`;
                        btn.textContent = `⏳ ${progressStr}...`;

                        if (item.replyCount > 0) {
                            const replies = await fetchAllReplies(item.commentId);
                            for (const r of replies) {
                                node.replies.push(transformComment(r));
                                count++;
                                const progressStrRep = totalEst === "?" ? count : `${count}/${totalEst}`;
                                btn.textContent = `⏳ ${progressStrRep}...`;
                            }
                        }
                        nodes.push(node);
                    }
                }
                return nodes;
            };

            state.collectedRoots.push(...await processItems(firstPage.items));

            for (let p = 2; p <= totalPages; p++) {
                await sleep(150);
                const data = await fetchCommentsPage(p);
                if (data) state.collectedRoots.push(...await processItems(data.items));
            }

            state.metaData.Statistik = { Total: count };

            // 3. Save to Cache
            await CacheManager.set(state.threadId, state.metaData, state.collectedRoots);

            // 4. Write formatted JSON file
            const safeTitle = state.metaData.Titel.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
            const dateStr = new Date().toISOString().split('T')[0];
            const baseName = `${dateStr}_${safeTitle}_mydealz`;
            const jsonPayload = JSON.stringify({ meta: state.metaData, comments: state.collectedRoots }, null, 2);
            downloadFile(`${baseName}.json`, jsonPayload, 'application/json');

            openUi();

        } catch (e) {
            if (e.name === 'AbortError') {
                console.log('Export abgebrochen');
                btn.textContent = "❌ Aborted";
            } else {
                console.error(e);
                alert("Error: " + e.message);
            }
        } finally {
            state.isScraping = false;
            state.abortController = null;
            if (btn.textContent !== "❌ Aborted") btn.textContent = "🧠 AI Export";
            btn.disabled = false;
        }
    }

    // ==========================================
    // 6. UI IMPLEMENTATION (Controls Top)
    // ==========================================
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
        const w = window.open('', '_blank', 'width=1000,height=800');
        if(!w) return alert("Popup Blocked!");

        // Inject logic back to main window for re-running
        w.UnsafeRunExport = () => runExport(document.querySelector('#mydealz-ai-btn'), true);

        w.document.title = "MyDealz AI Export";
        const d = w.document;

        const css = `
            :root { 
                --bg: ${THEME.bg}; --surface: ${THEME.surface};
                --border: ${THEME.border}; --primary: ${THEME.primary}; --text: ${THEME.text};
            }
            body { 
                margin: 0; padding: 0; font-family: 'Inter', system-ui, sans-serif; 
                background: var(--bg); height: 100vh; overflow: hidden;
                display: flex; flex-direction: column;
            }
            
            .header {
                flex: 0 0 auto;
                padding: 12px 20px; background: var(--surface); border-bottom: 1px solid var(--border);
                display: flex; justify-content: space-between; align-items: center;
            }
            .header h2 { margin: 0; font-size: 16px; color: var(--text); display: flex; align-items: center; gap: 10px; }
            .badge { background: #EEF2FF; color: #4F46E5; padding: 2px 8px; border-radius: 4px; font-size: 11px; }

            .meta-bar {
                flex: 0 0 auto;
                display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
                padding: 12px 20px; background: #F1F5F9; border-bottom: 1px solid var(--border);
                font-size: 12px; color: #64748B;
            }
            .meta-item b { color: #334155; font-weight: 600; margin-right: 4px; }
            .meta-item.cache-info { color: #059669; font-weight: 500; }

            /* Controls Area (Tabs + Actions) */
            .controls-area {
                flex: 0 0 auto;
                padding: 16px 20px;
                background: var(--surface);
                border-bottom: 1px solid var(--border);
                display: flex; flex-direction: column; gap: 16px;
                box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);
                z-index: 10;
            }

            .tabs { display: flex; gap: 8px; }
            .tab-btn {
                padding: 6px 12px; border-radius: 6px; border: 1px solid #CBD5E1; cursor: pointer;
                background: white; color: #64748B; font-weight: 500; font-size: 12px;
            }
            .tab-btn.active { background: #F1F5F9; border-color: var(--primary); color: var(--primary); font-weight: 600; }

            .action-row { display: flex; gap: 40px; }
            .group-label { font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 700; margin-bottom: 6px; }
            .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
            
            .btn {
                min-width: 90px; justify-content: center;
                padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border);
                background: white; color: #475569; font-size: 12px; cursor: pointer;
                display: flex; align-items: center; gap: 6px;
            }
            
            .toast {
                position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(20px);
                background: rgba(15, 23, 42, 0.9); color: white; padding: 10px 20px; 
                border-radius: 30px; font-size: 13px; font-weight: 500;
                opacity: 0; transition: all 0.3s ease; pointer-events: none;
                box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
                display: flex; align-items: center; gap: 8px; z-index: 1000;
            }
            .toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
            .btn:hover { background: #F8FAFC; border-color: #CBD5E1; }
            .btn-primary { background: var(--primary); color: white; border-color: var(--primary); }
            .btn-primary:hover { background: #334155; }

            /* Output */
            .main {
                flex: 1; 
                display: flex; flex-direction: column;
                padding: 0; 
                min-height: 0; 
            }
            textarea {
                flex: 1; width: 100%; resize: none; border: none;
                padding: 20px; font-family: 'JetBrains Mono', monospace; font-size: 12px;
                background: #FAFAFA; color: #334155; outline: none; box-sizing: border-box;
                overflow-y: auto;
            }
        `;

        d.head.innerHTML = `<style>${css}</style>`;
        d.body.innerHTML = `
            <div class="header">
                <h2>💎 MyDealz Analyzer <span class="badge">v11.0</span></h2>
            </div>
            
            <div class="meta-bar">
                <div class="meta-item"><b>Deal:</b> ${state.metaData.Titel.substring(0,30)}...</div>
                <div class="meta-item"><b>Status:</b> ${state.metaData.DealInfo.Status} (${state.metaData.DealInfo.Alter})</div>
                <div class="meta-item"><b>Preis:</b> ${state.metaData.DealInfo.Preis}</div>
                <div class="meta-item"><b>Count:</b> ${state.metaData.Statistik.Total}</div>
                ${state.metaData._fromCache ? 
                    `<div class="meta-item cache-info">⚡ Cached (${new Date(state.metaData._cacheTime).toLocaleTimeString()})</div>` 
                    : ''}
            </div>

            <div class="controls-area">
                
                <!-- API Section -->
                <div class="api-section" style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #E2E8F0;">
                     <div class="group-label" style="display:flex; justify-content:space-between;">
                        <span>🧠 Gemini API Setup</span>
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" style="text-decoration:none; color:#2563EB;">Get Key ↗</a>
                     </div>
                     <div style="display: flex; gap: 8px; margin-top: 8px;">
                         <input type="password" id="apiKeyInput" placeholder="API Key hier einfügen..." 
                                style="flex: 1; padding: 8px; border: 1px solid #CBD5E1; border-radius: 6px; font-family: monospace;">
                         <button class="btn" id="checkApiBtn">✅ Check</button>
                     </div>
                     <div style="display: flex; gap: 8px; margin-top: 8px;">
                         <select id="modelSelect" style="flex: 1; padding: 8px; border: 1px solid #CBD5E1; border-radius: 6px; background:white;" disabled>
                             <option value="">Warte auf Key...</option>
                         </select>
                         <button class="btn btn-primary" id="generateBtn" disabled style="min-width: 140px;">✨ ZUSAMMENFASSEN</button>
                     </div>
                </div>

                <div>
                     <div class="group-label">Prompts (Preview)</div>
                     <div class="tabs" id="tabContainer"></div>
                </div>
                
                <div class="action-row" style="margin-top: 15px;">
                     <div>
                        <div class="group-label">Exportieren</div>
                        <div class="btn-row">
                            <button class="btn" id="copyBtn">📋 Copy</button>
                            <button class="btn btn-primary" id="saveMd">💾 .MD</button>
                            <button class="btn" id="saveJson">💾 .JSON</button>
                            <button class="btn" id="refreshBtn" title="Cache löschen & Neu laden">🔄</button>
                        </div>
                    </div>
                    <div>
                        <div class="group-label">AI Direktlink</div>
                        <div class="btn-row">
                            ${AI_URLS.map(ai => 
                                `<button class="btn" onclick="window.open('${ai.url}')">${ai.name}</button>`
                            ).join('')}
                        </div>
                    </div>
                </div>
            </div>

            <div class="main">
                 <textarea id="output" readonly></textarea>
            </div>
            <div id="toast" class="toast"></div>
        `;

        const out = d.getElementById('output');
        const tabContainer = d.getElementById('tabContainer');

        Object.keys(PROMPT_LEVELS).forEach(key => {
            const b = d.createElement('button');
            b.className = `tab-btn ${key === 'MEDIUM' ? 'active' : ''}`;
            b.textContent = PROMPT_LEVELS[key].label;
            b.onclick = () => {
                d.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
                b.classList.add('active');
                state.currentPromptLevel = key;
                out.value = PROMPT_LEVELS[key].gen(state.metaData, state.collectedRoots);
            };
            tabContainer.appendChild(b);
        });

        const safeTitle = state.metaData.Titel.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const dateStr = new Date().toISOString().split('T')[0];
        const baseName = `${dateStr}_${safeTitle}_mydealz`;

        const toast = d.getElementById('toast');
        const showToast = (msg) => {
            toast.innerHTML = msg;
            toast.classList.add('visible');
            setTimeout(() => toast.classList.remove('visible'), 2000);
        };

        d.getElementById('copyBtn').onclick = async function(e) { 
            e.preventDefault(); // Prevent focus
            const btn = this;
            try {
                await navigator.clipboard.writeText(out.value);
                showToast("✅ Erfolgreich kopiert!");
            } catch(e) {
                // Fallback: Invisible Textarea
                const ta = d.createElement('textarea');
                ta.value = out.value;
                ta.style.position = 'fixed'; ta.style.left = '-9999px';
                d.body.appendChild(ta);
                ta.select();
                d.execCommand('copy');
                d.body.removeChild(ta);
                showToast("✅ Kopiert (Fallback)!");
            }
        };
        d.getElementById('saveMd').onclick = () => downloadFile(`${baseName}.md`, out.value, 'text/markdown');
        d.getElementById('saveJson').onclick = () => downloadFile(`${baseName}.json`, JSON.stringify({meta: state.metaData, comments: state.collectedRoots},null,2), 'application/json');
        
        d.getElementById('refreshBtn').onclick = async () => {
             if(confirm("Cache löschen und neu laden?")) {
                 await CacheManager.delete(state.metaData.OP ? state.threadId : getThreadId()); // Access State from closure
                 w.close();
                 if(w.UnsafeRunExport) w.UnsafeRunExport();
             }
        };

        // ============================
        // API LOGIC
        // ============================
        const keyInput = d.getElementById('apiKeyInput');
        const modelSelect = d.getElementById('modelSelect');
        const checkBtn = d.getElementById('checkApiBtn');
        const genBtn = d.getElementById('generateBtn');

        // Allow click on disabled generate to prompt user
        // (Not really needed if we control the flow)

        // Load Key
        const savedKey = localStorage.getItem('mydealz_gemini_key');
        if(savedKey) {
            keyInput.value = savedKey;
            // Auto-Check? Let's just restore it visually, user clicks check to be safe or we can auto-trigger
            // Auto-triggering might be nice
            setTimeout(() => checkBtn.click(), 100); 
        }

        checkBtn.onclick = async () => {
            const key = keyInput.value.trim();
            if(!key) return alert("❌ Bitte API Key eingeben!");
            
            checkBtn.textContent = "⏳...";
            checkBtn.disabled = true;
            keyInput.disabled = true;

            try {
                const models = await fetchModels(key);
                // Success
                localStorage.setItem('mydealz_gemini_key', key);
                
                // Populate Select
                modelSelect.innerHTML = models.map(m => {
                    // Try to pre-select gemini-1.5-flash or flash-latest
                    const isFlash = m.name.includes("flash");
                    return `<option value="${m.name}" ${isFlash ? 'selected' : ''}>${m.displayName || m.name}</option>`;
                }).join('');
                
                modelSelect.disabled = false;
                genBtn.disabled = false;
                checkBtn.textContent = "✅";
                keyInput.disabled = false;
                
            } catch(e) {
                alert("Fehler beim Prüfen des Keys: " + e.message);
                checkBtn.textContent = "❌ Retry";
                keyInput.disabled = false;
                checkBtn.disabled = false;
            }
        };

        genBtn.onclick = async () => {
            const key = keyInput.value.trim();
            const model = modelSelect.value;
            const prompt = out.value;

            if(!key || !model) return alert("Setup unvollständig!");

            genBtn.textContent = "🧠 Arbeite...";
            genBtn.disabled = true;
            out.disabled = true;

            try {
                const summary = await generateWithGemini(key, model, prompt);
                
                // Show Result
                const sep = "\n\n" + "=".repeat(40) + "\n\n";
                out.value = "🤖 GENERIERTE ZUSAMMENFASSUNG:\n" + sep + summary + sep + "ORIGINAL PROMPT:\n" + prompt;
                
                showToast("✅ Generierung abgeschlossen!");
            } catch(e) {
                alert("Fehler: " + e.message);
            } finally {
                genBtn.textContent = "✨ ZUSAMMENFASSEN";
                genBtn.disabled = false;
                out.disabled = false;
            }
        };

        out.value = PROMPT_LEVELS[state.currentPromptLevel].gen(state.metaData, state.collectedRoots);
    }

    function init() {
        const btn = document.createElement('button');
        btn.id = 'mydealz-ai-btn'; // ID for reference
        btn.textContent = "🧠 AI Export";
        Object.assign(btn.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: 99999,
            padding: '12px 20px', background: THEME.primary, color: 'white',
            border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
        });
        btn.onclick = () => runExport(btn);
        document.body.appendChild(btn);
    }
    
    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();
