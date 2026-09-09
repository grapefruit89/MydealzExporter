'use strict';
/* =========================================================
   content.js  –  Deal-Seiten-Exporter (Use Case 2)
   Läuft auf: /deals/*, /gutscheine/*, /diskussion/*

   Holt alle Kommentare via GraphQL inkl. ALLER Replies.
   Workaround für API-Limit: mainCommentId-Filter mit threadId
   gibt alle Replies eines Parent-Kommentars zurück.
   ========================================================= */

const COMMENT_FIELDS = `
  commentId mainCommentId threadId
  preparedHtmlContent createdAt
  deletedBy { username }
  replyCount
  user { username userId }
  reactionCounts { type count }
`.trim();

const log = {
  _style: 'background:#16a34a;color:#fff;font-weight:700;padding:2px 6px;border-radius:4px;',
  info(msg, ...args) {
    console.info(`%cMDE:Detail%c ${msg}`, this._style, '', ...args);
  },
  debug(msg, ...args) {
    console.debug(`%cMDE:Detail%c ${msg}`, this._style, '', ...args);
  },
  error(msg, err) {
    const detail = err?.stack || err?.message || String(err);
    console.error(`%cMDE:Detail%c ❌ ${msg}`, this._style, '', detail);
  }
};

const GQL = {

  QUERY_TOPLEVEL: `
    query($filter: CommentFilter!, $limit: Int, $page: Int) {
      comments(filter: $filter, limit: $limit, page: $page) {
        items { ${COMMENT_FIELDS} repliesPreview { ${COMMENT_FIELDS} } }
        pagination { last count current }
      }
    }
  `,

  getXsrf() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta?.content) return meta.content;
    const m = document.cookie.match(/xsrf_t=([^;]+)/);
    if (!m) return '';
    let val = decodeURIComponent(m[1]);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    return val;
  },

  get headers() {
    return {
      'Content-Type':     'application/json',
      'X-CSRF-TOKEN':     this.getXsrf(),
      'x-requested-with': 'XMLHttpRequest'
    };
  },

  cleanText(html) {
    if (!html) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.innerText.replace(/\n{3,}/g, '\n\n').trim();
  },

  /* extractLinks kommt aus link-share.js (geteilt mit listing.js) */

  parseReactions(counts) {
    const out = {};                       // immer Objekt: konsistentes Schema
    if (!counts?.length) return out;
    for (const { type, count } of counts) {
      if (count > 0) out[type.toLowerCase()] = count;
    }
    return out;
  },

  transform(item) {
    if (!item) return null;
    const author = item.user?.username || null;
    const deleted = item.deletedBy ? (item.deletedBy.username || '(gelöscht)') : null;
    // mydealz-interne Permalink-Formate (aus Sammlung 2035404):
    // Hauptkommentar → #comment-<id>, Antwort → #reply-<id>
    const base = location.origin + location.pathname;
    const permalink = item.mainCommentId
      ? `${base}#reply-${item.commentId}`
      : `${base}#comment-${item.commentId}`;
    return {
      id:          item.commentId,
      parentId:    item.mainCommentId || null,
      author,
      authorId:    item.user?.userId   || null,
      date:        item.createdAt      || null,
      text:        this.cleanText(item.preparedHtmlContent),
      deleted,                            // moderiert gelöscht (Moderator-Name)
      userDeleted: !deleted && /^GelöschterUser\d+$/.test(author || ''),
      reactions:   this.parseReactions(item.reactionCounts),
      links:       extractLinks(item.preparedHtmlContent),
      permalink,
      replyCount:  item.replyCount || 0
    };
  },

  /* Batched Reply-Fetch: bis zu 30 Parents per Request via Alias-Trick */
  async fetchRepliesBatch(threadId, parentIds) {
    if (!parentIds.length) return {};
    const REPLY_FIELDS = COMMENT_FIELDS;
    const aliases = parentIds.map(pid =>
      `r${pid}: comments(filter: { threadId: { eq: ${threadId} }, mainCommentId: ${pid} }, limit: 100) {
        items { ${REPLY_FIELDS} }
      }`
    ).join('\n');
    const res = await fetch('/graphql', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query: `query { ${aliases} }` })
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const data = (await res.json()).data || {};
    // Map parentId -> replies[]
    const result = {};
    for (const pid of parentIds) {
      result[pid] = (data[`r${pid}`]?.items || []).map(i => this.transform(i)).filter(Boolean);
    }
    return result;
  },

  /* Alle Top-Level-Kommentare paginiert holen */
  async fetchTopLevel(threadId, onProgress) {
    const makeBody = (page) => JSON.stringify({
      query: this.QUERY_TOPLEVEL,
      variables: {
        filter: { threadId: { eq: threadId }, order: { direction: 'Ascending' } },
        limit: 100,
        page
      }
    });

    if (onProgress) onProgress('Kommentare Seite 1...');
    const r1   = await fetch('/graphql', { method: 'POST', headers: this.headers, body: makeBody(1) });
    if (!r1.ok) throw new Error(`GraphQL HTTP ${r1.status}`);
    const d1   = (await r1.json()).data;
    const all  = [...(d1?.comments?.items || [])];
    const last = d1?.comments?.pagination?.last || 1;

    for (let p = 2; p <= last; p++) {
      if (onProgress) onProgress(`Seite ${p}/${last}...`);
      await new Promise(r => setTimeout(r, 350));
      const rp = await fetch('/graphql', { method: 'POST', headers: this.headers, body: makeBody(p) });
      if (!rp.ok) throw new Error(`GraphQL HTTP ${rp.status}`);
      all.push(...((await rp.json()).data?.comments?.items || []));
    }
    return all;
  },

  /* Haupt-Funktion: alles holen */
  async fetchAll(threadId, onProgress) {
    if (!this.getXsrf()) throw new Error('Kein XSRF-Token - bitte einloggen!');

    // 1. Top-Level-Kommentare
    const rawItems = await this.fetchTopLevel(threadId, onProgress);

    // 2. Identifiziere Parents die mehr Replies haben als im Preview
    const needMoreReplies = rawItems.filter(item => {
      const previewLen = item.repliesPreview?.length || 0;
      return (item.replyCount || 0) > previewLen;
    });

    // 3. Lade fehlende Replies in Batches von 30
    const BATCH = 30;
    const allReplies = {}; // parentId -> replies[]
    for (let i = 0; i < needMoreReplies.length; i += BATCH) {
      const batch = needMoreReplies.slice(i, i + BATCH);
      const parentIds = batch.map(c => c.commentId);
      if (onProgress) onProgress(`Replies Batch ${Math.floor(i/BATCH)+1}/${Math.ceil(needMoreReplies.length/BATCH)}...`);
      const batchResult = await this.fetchRepliesBatch(threadId, parentIds);
      Object.assign(allReplies, batchResult);
      if (i + BATCH < needMoreReplies.length) await new Promise(r => setTimeout(r, 400));
    }

    // 4. Transformieren und Replies einhängen
    const comments = rawItems.map(item => {
      const node = this.transform(item);
      const fetchedReplies = allReplies[item.commentId];
      if (fetchedReplies) {
        node.replies = fetchedReplies;
      } else if (item.repliesPreview?.length > 0) {
        node.replies = item.repliesPreview.map(r => this.transform(r)).filter(Boolean);
        if ((item.replyCount || 0) > node.replies.length) {
          node._hiddenReplies = item.replyCount - node.replies.length;
        }
      }
      return node;
    }).filter(Boolean);

    // 5. Statistik — Reaktionen über ALLE Kommentare inkl. Replies
    const totalReplies = comments.reduce((s,c) => s + (c.replies?.length || 0), 0);
    const hiddenReplies = comments.reduce((s,c) => s + (c._hiddenReplies || 0), 0);
    const sumReactions = (key) => comments.reduce((s, c) => {
      let n = c.reactions?.[key] || 0;
      for (const r of (c.replies || [])) n += r.reactions?.[key] || 0;
      return s + n;
    }, 0);
    const stats = {
      totalTopLevel: comments.length,
      totalRepliesVisible: totalReplies,
      totalHiddenReplies: hiddenReplies,
      deleted: comments.filter(c => c.deleted).length,
      userDeleted: comments.filter(c => c.userDeleted).length,
      reactions: {
        like:    sumReactions('like'),
        helpful: sumReactions('helpful'),
        funny:   sumReactions('funny')
      }
    };

    return { comments, stats };
  }
};

/* ── Thread-ID aus URL ── */
function getThreadId() {
  const m = window.location.href.match(/(?:deals|gutscheine|diskussion)\/[a-zA-Z0-9-]+-(\d+)/);
  return m ? m[1] : null;
}

/* ── Deal-Metadaten aus DOM ── */
function extractMetadata() {
  // Selektoren vom GreasyFork-Exporter übernommen (präziser als Klassen-Guess):
  // Portale sind layoutstabil, Kommentarblöcke können nicht reinspielen
  const descEl = document.querySelector('div[data-t="description"]')
    || document.querySelector('#threadDescriptionItemPortal .userHtml-content')
    || document.querySelector('main [class*="userHtml-content"]');
  return {
    threadId: getThreadId(),
    title:    document.querySelector('h1.thread-title')?.textContent?.trim()
              || document.title.split(' | ')[0].trim(),
    price:    document.querySelector('[class*="thread-price"]')?.textContent?.trim() || null,
    merchant: document.querySelector('[data-t="merchantLink"], [class*="cept-merchant-name"]')?.textContent?.trim() || null,
    temperature: document.querySelector('.vote-temp')?.textContent?.trim() || null,
    author:   document.querySelector('.threadItemCard-author .thread-user, .short-profile-target .thread-user')?.textContent?.trim() || null,
    description: descEl ? GQL.cleanText(descEl.innerHTML) : null,
    links:       descEl ? extractLinks(descEl.innerHTML) : [],
    url:      window.location.href
  };
}

/* ── Button ── */
function injectButton() {
  if (!getThreadId()) return;
  if (document.getElementById('mde-ai-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'mde-ai-btn';
  btn.innerHTML = '🧠 <span id="mde-ai-label">Export &amp; Analyse</span>';
  Object.assign(btn.style, {
    position:'fixed',bottom:'24px',right:'24px',zIndex:'2147483647',
    padding:'12px 20px',background:'#16A34A',color:'#fff',
    border:'none',borderRadius:'12px',fontSize:'14px',fontWeight:'700',
    fontFamily:'system-ui,sans-serif',boxShadow:'0 4px 20px rgba(22,163,74,.45)',
    cursor:'pointer',transition:'background .15s',whiteSpace:'nowrap'
  });
  const lbl = () => document.getElementById('mde-ai-label');
  btn.addEventListener('mouseenter', () => btn.style.background = '#15803D');
  btn.addEventListener('mouseleave', () => btn.style.background = '#16A34A');

  btn.addEventListener('click', async () => {
    const threadId = getThreadId();
    if (!threadId) { lbl().textContent = 'Kein Thread'; return; }
    btn.disabled = true; btn.style.opacity = '.7';
    try {
      const { comments, stats } = await GQL.fetchAll(threadId, msg => { lbl().textContent = msg; });
      const meta = extractMetadata();
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', payload: { meta, comments, stats } });
      lbl().textContent = `✅ ${stats.totalTopLevel}+${stats.totalRepliesVisible} Komm.`;
      btn.style.background = '#2563EB';
    } catch (err) {
      log.error('Kommentar-Export fehlgeschlagen', err);

      let uiMsg = 'Fehler aufgetreten';
      if (err.message?.includes('XSRF') || err.message?.includes('CSRF')) uiMsg = 'Kein XSRF-Token';
      else if (err.message?.includes('HTTP 429')) uiMsg = 'Rate-Limit (429)';
      else if (err.message?.includes('HTTP 403')) uiMsg = 'Kein Zugriff (403)';
      else if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) uiMsg = 'Netzwerkfehler';
      else if (err.message) uiMsg = err.message.slice(0, 20);

      lbl().textContent = `❌ ${uiMsg}`;
      btn.style.background = '#DC2626';
    } finally {
      btn.disabled = false; btn.style.opacity = '1';
      setTimeout(() => { lbl().textContent = 'Export & Analyse'; btn.style.background = '#16A34A'; }, 4000);
    }
  });
  document.body.appendChild(btn);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
else injectButton();

let _lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== _lastUrl) { _lastUrl = location.href; setTimeout(injectButton, 800); }
}).observe(document.documentElement, { childList: true, subtree: true });
