// MyDealz AI Exporter – Content Script
// Läuft auf mydealz.de/deals/*, /gutscheine/*, /diskussion/*

'use strict';

// =============================================
// GRAPHQL ENGINE (identisch mit Userscript v16)
// =============================================
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
        if (!html) return '';
        return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
                   .replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    },
    compressVotes(counts) {
        if (!counts || counts.length === 0) return undefined;
        const out = {};
        let hasSignal = false;
        counts.forEach(c => { if (c.count > 0) { out[c.type.toLowerCase()] = c.count; hasSignal = true; } });
        return hasSignal ? out : undefined;
    },
    transform(item) {
        if (!item) return null;
        const node = {
            id: item.commentId,
            user: item.user?.username || 'Deleted',
            date: item.createdAt,
            text: this.cleanText(item.preparedHtmlContent),
            votes: this.compressVotes(item.reactionCounts)
        };
        if (item.repliesPreview?.length > 0) {
            node.replies = item.repliesPreview.map(r => this.transform(r)).filter(Boolean);
        }
        return node;
    },
    async fetchAll(threadId, onProgress) {
        const token = this.getXsrf();
        if (!token) throw new Error('Kein XSRF Token – bitte einloggen!');
        const headers = {
            'content-type': 'application/json',
            'x-xsrf-token': token,
            'x-request-type': 'application/vnd.pepper.v1+json'
        };
        const makeBody = (p) => JSON.stringify({
            query: this.QUERY,
            variables: { filter: { threadId: { eq: threadId }, order: { direction: 'Ascending' } }, limit: 100, page: p }
        });

        let allItems = [];
        if (onProgress) onProgress('Lade Seite 1...');
        const r1 = await fetch('/graphql', { method: 'POST', headers, body: makeBody(1) });
        const d1 = (await r1.json()).data;

        if (d1?.comments?.items) {
            allItems.push(...d1.comments.items);
            const last = d1.comments.pagination.last;
            for (let p = 2; p <= last; p++) {
                if (onProgress) onProgress(`Seite ${p}/${last}...`);
                await new Promise(r => setTimeout(r, 400));
                const rp = await fetch('/graphql', { method: 'POST', headers, body: makeBody(p) });
                const dp = (await rp.json()).data;
                if (dp?.comments?.items) allItems.push(...dp.comments.items);
            }
        }
        return allItems.map(item => this.transform(item)).filter(Boolean);
    }
};

// =============================================
// HELPERS
// =============================================
function getThreadId() {
    const match = window.location.href.match(/(?:deals|gutscheine|diskussion)\/[a-zA-Z0-9-]+-(\d+)/);
    return match ? match[1] : null;
}

function extractMetadata() {
    return {
        titel: document.querySelector('h1.thread-title')?.textContent?.trim() || document.title,
        preis: document.querySelector('.thread-price')?.textContent?.trim() || 'N/A',
        url: window.location.href
    };
}

// =============================================
// BUTTON
// =============================================
function injectButton() {
    if (document.getElementById('mde-ai-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'mde-ai-btn';
    btn.textContent = '🧠 AI Export';
    btn.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: 9999;
        padding: 12px 20px; background: #2563EB; color: white;
        border: none; border-radius: 30px; font-weight: 700;
        font-size: 14px; font-family: -apple-system, sans-serif;
        box-shadow: 0 4px 12px rgba(37,99,235,0.4);
        cursor: pointer; transition: all 0.2s;
    `;
    btn.onmouseenter = () => btn.style.transform = 'translateY(-2px)';
    btn.onmouseleave = () => btn.style.transform = 'translateY(0)';

    btn.onclick = async () => {
        const threadId = getThreadId();
        if (!threadId) { btn.textContent = '❌ Kein Thread'; return; }

        btn.style.background = '#1D4ED8';
        btn.textContent = '⏳ Lade...';
        btn.disabled = true;

        try {
            const comments = await GQL.fetchAll(threadId, (msg) => { btn.textContent = `⏳ ${msg}`; });
            const meta = extractMetadata();

            // Daten an Background senden → Dashboard öffnen
            chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', payload: { meta, comments } });
            btn.textContent = '✅ Geöffnet!';
            setTimeout(() => { btn.textContent = '🧠 AI Export'; btn.style.background = '#2563EB'; btn.disabled = false; }, 2000);
        } catch (e) {
            btn.textContent = '❌ ' + e.message.substring(0, 20);
            btn.style.background = '#DC2626';
            btn.disabled = false;
            setTimeout(() => { btn.textContent = '🧠 AI Export'; btn.style.background = '#2563EB'; }, 3000);
        }
    };

    document.body.appendChild(btn);
}

// Warte bis DOM ready, injiziere Button
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    injectButton();
} else {
    document.addEventListener('DOMContentLoaded', injectButton);
}

// SPA Watchdog (mydealz nutzt Client-Side Navigation)
let lastUrl = location.href;
new MutationObserver(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(injectButton, 1000);
    }
}).observe(document, { subtree: true, childList: true });
