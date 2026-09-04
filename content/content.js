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
    if (meta) return meta.getAttribute('content');
    const m = document.cookie.match(/xsrf_t=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
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

  parseReactions(counts) {
    if (!counts?.length) return undefined;
    const out = {};
    let total = 0;
    for (const { type, count } of counts) {
      if (count > 0) { out[type.toLowerCase()] = count; total += count; }
    }
    return total > 0 ? out : undefined;
  },

  transform(item) {
    if (!item) return null;
    return {
      id:          item.commentId,
      parentId:    item.mainCommentId || null,
      author:      item.user?.username || null,
      authorId:    item.user?.userId   || null,
      date:        item.createdAt      || null,
      text:        this.cleanText(item.preparedHtmlContent),
      deleted:     item.deletedBy ? (item.deletedBy.username || '(gelöscht)') : null,
      reactions:   this.parseReactions(item.reactionCounts),
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
    const d1   = (await r1.json()).data;
    const all  = [...(d1?.comments?.items || [])];
    const last = d1?.comments?.pagination?.last || 1;

    for (let p = 2; p <= last; p++) {
      if (onProgress) onProgress(`Seite ${p}/${last}...`);
      await new Promise(r => setTimeout(r, 350));
      const rp = await fetch('/graphql', { method: 'POST', headers: this.headers, body: makeBody(p) });
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

    // 5. Statistik
    const totalReplies = comments.reduce((s,c) => s + (c.replies?.length || 0), 0);
    const hiddenReplies = comments.reduce((s,c) => s + (c._hiddenReplies || 0), 0);
    const stats = {
      totalTopLevel: comments.length,
      totalRepliesVisible: totalReplies,
      totalHiddenReplies: hiddenReplies,
      deleted: comments.filter(c => c.deleted).length,
      reactions: {
        like:    comments.reduce((s,c)=>s+(c.reactions?.like||0),0),
        helpful: comments.reduce((s,c)=>s+(c.reactions?.helpful||0),0),
        funny:   comments.reduce((s,c)=>s+(c.reactions?.funny||0),0)
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
  return {
    threadId: getThreadId(),
    title:    document.querySelector('h1.thread-title, [class*="thread-title"]')?.textContent?.trim()
              || document.title.split(' | ')[0].trim(),
    price:    document.querySelector('[class*="thread-price"]')?.textContent?.trim() || null,
    merchant: document.querySelector('[class*="cept-merchant-name"]')?.textContent?.trim() || null,
    url:      window.location.href
  };
}

/* ── Button ── */
function injectButton() {
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
      console.error('[MDE]', err);
      lbl().textContent = 'Fehler: ' + err.message.slice(0, 20);
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
