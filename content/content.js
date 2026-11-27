'use strict';
/* content.js – Deal-Seiten-Exporter (UC2): /deals/*, /gutscheine/*, /diskussion/*
   Alle Kommentare via GraphQL inkl. Replies; mainCommentId+threadId umgeht das API-Limit. */

// #region shared-bootstrap
/* ── Shared Bootstrap — identisch in content/content.js und content/listing.js ──
   Zero-Build: Content-Scripts können keine ES-Module importieren. Statt einer
   Mini-Datei (<5 KB, Shallow Module) liegt dieser Block wortgleich in beiden
   Bundles. tools/repo-map-check.mjs vergleicht die Region byte-genau und
   schlägt bei Drift fehl. [anchor:deep-modules] */

/* Link-Extraktion (UC1 + UC2): innerText verliert hrefs — hier werden sie
   gesammelt: dedupliziert, absolut, javascript:/Anker raus. mydealz-Cloaking
   aufheben: bei /visit/-Redirects steckt die echte Ziel-URL oft im title. */
function extractLinks(html) {
  if (!html) return [];
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const out = [];
  const seen = new Set();
  for (const a of tmp.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) continue;
    let url = /^https?:\/\//i.test(href) ? href : new URL(href, location.origin).href;

    if (url.includes('/visit/')) {
      const t = (a.getAttribute('title') || '').trim();
      const target = /^https?:\/\//i.test(t) ? t
        : (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(t) ? 'https://' + t : null);
      if (target) url = target;
    }

    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ text: (a.textContent || '').trim().slice(0, 120) || null, url });
  }
  return out;
}

/* Fetch mit Retry/Backoff (UC1 + UC2) — die EINZIGE Fetch-Route.
   Standard: 800→1600 ms, 2 Extra-Versuche. Persistent (UC2-Thread-Export):
   adaptiv 10 s × 1,25^k, Retry-After schlägt Eigen-Backoff, Hard-Cap 5,
   sichtbarer Sekunden-Countdown. Force-Retry: FETCH_WAIT.skip = true. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_MAX_ATTEMPTS = 2;      // Standard: Extra-Versuche zusätzlich zum ersten
const RETRY_BASE_DELAY_MS = 800;
const PERSISTENT_ATTEMPTS = 5;     // Hard-Cap im persistenten Modus
const PERSISTENT_DELAY_SEC = 10;   // Startverzögerung im persistenten Modus
const PERSISTENT_FACTOR = 1.25;    // Wachstumsfaktor bei Folge-Limits

const FETCH_WAIT = { active: false, skip: false };

async function fetchWithRetry(url, options = {}, onProgress, expectJson = false, persistent = false) {
  const maxAttempts = persistent ? PERSISTENT_ATTEMPTS : 1 + RETRY_MAX_ATTEMPTS;
  const pathname = () => { try { return new URL(url, location.origin).pathname; } catch { return url; } };
  let lastErr = null;
  let lastRes = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Server-Hinweis schlägt Eigen-Backoff
      const retryAfter = parseInt(lastRes?.headers?.get('Retry-After') || '', 10);

      if (persistent) {
        // Adaptives Backoff mit sichtbarem Sekunden-Countdown
        let remaining = Math.max(retryAfter || 0, Math.round(PERSISTENT_DELAY_SEC * Math.pow(PERSISTENT_FACTOR, attempt - 1)));
        onProgress?.(`⚠️ Rate-Limit — Retry ${attempt}/${maxAttempts - 1}`);
        FETCH_WAIT.active = true;
        FETCH_WAIT.skip = false;
        try {
          while (remaining > 0 && !FETCH_WAIT.skip) {
            onProgress?.(`⏳ Retry in ${remaining}s (Klick = sofort)`);
            log.debug(`Retry ${attempt}/${maxAttempts} für ${pathname()}: noch ${remaining}s`);
            await new Promise(r => setTimeout(r, 1000));
            remaining--;
          }
        } finally {
          FETCH_WAIT.active = false;
        }
      } else {
        let delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        if (retryAfter > 0) delay = Math.max(delay, retryAfter * 1000);
        onProgress?.(`⏳ Retry in ${Math.round(delay / 1000)}s…`);
        log.debug(`Retry ${attempt}/${maxAttempts} für ${pathname()}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      lastErr = err;                       // Netzwerkfehler → Retry
      continue;
    }
    lastRes = res;

    if (res.ok) {
      if (expectJson) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('json')) {
          // 200 + HTML = Throttle/Block — als transientes Problem behandeln
          lastErr = new Error('HTML statt JSON (Rate-Limit oder Block)');
          continue;
        }
      }
      return res;
    }

    if (RETRY_STATUS.has(res.status)) {
      lastErr = new Error(`HTTP ${res.status}`);
      continue;                            // weitere Versuche? for-Schleife entscheidet
    }
    // 403/404 → sofort werfen
    throw new Error(`HTTP ${res.status}`);
  }

  throw lastErr || new Error('Fetch fehlgeschlagen');
}
// #endregion shared-bootstrap

/* ── Columnar-Tuple-Matrix: einziger Serialisierer ([anchor:ssot-principle]).
   ui/dashboard.js liest nur payload.jsonString. */
const COLUMNAR_COLUMNS = ['id', 'parentId', 'level', 'author', 'isAuthor', 'date', 'score', 'text', 'authorRefs'];

const LLM_GUIDE = {
  target: 'E-Commerce Deal & Community Thread Analysis',
  format: 'columnar-matrix [anchor:deep-modules]',
  anchors: ['[anchor:ssot-principle]', '[anchor:separation-of-concerns]', '[anchor:deep-modules]'],
  description: 'Hocheffizienter Token-optimierter Columnar-Export für LLMs. Kommentare liegen als flache Tuple-Matrix ohne redundante Keys vor.',
  columns: COLUMNAR_COLUMNS,
  column_guide: {
    id: 'Eindeutige Kommentar-ID',
    parentId: 'Eltern-ID (null bei Top-Level)',
    level: 'Hierarchie-Tiefe (0 = Wurzel, 1..4 = Antwort-Ebene)',
    author: 'Verfasser',
    isAuthor: 'true = Dealersteller (verbindliche Status-Meldungen zu Preis/Gutschein)',
    date: 'Zeitstempel',
    score: 'Gewichteter Community-Score (helpful*3 + replies*3 + like*2 + funny)',
    text: 'Kommentartext',
    authorRefs: 'Weitere Kommentar-IDs desselben Nutzers für sofortige Dialogverfolgung'
  }
};

/* Kommentarbaum → flache Zeilen, pre-order (Eltern vor Kindern). */
function flattenToColumnar(comments) {
  const rows = [];
  const walk = c => {
    const rx = c.reactions || {};
    const sc = (rx.helpful || 0) * 3 + (c.replyCount || 0) * 3 + (rx.like || 0) * 2 + (rx.funny || 0);
    rows.push([
      c.id,
      c.parentId || null,
      c.level || 0,
      c.author,
      Boolean(c.isAuthor),
      c.date || '',
      sc,
      c.text || '',
      c.authorRefs || []
    ]);
    (c.replies || []).forEach(walk);
  };
  (comments || []).forEach(walk);
  return rows;
}

/* Kopf lesbar, Matrix eine Zeile pro Tupel — JSON-valide und token-sparsam
   (stringify mit Einrückung würde jedes Tupel-Feld auf eigene Zeilen sprengen). */
function serializeColumnar(meta, stats, comments) {
  const rows = flattenToColumnar(comments).map(r => JSON.stringify(r));
  const head = JSON.stringify({ _llm: LLM_GUIDE, meta: pruneEmpty(meta), stats: pruneEmpty(stats) }, null, 2);
  return `${head.slice(0, -2)},\n  "comments": [\n    ${rows.join(',\n    ')}\n  ]\n}`;
}

function pruneEmpty(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map(pruneEmpty).filter(v => v !== undefined && !(Array.isArray(v) && !v.length));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = pruneEmpty(v);
      if (p === undefined || (Array.isArray(p) && !p.length)) continue;
      out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

const COMMENT_FIELDS = `
  commentId mainCommentId parentCommentId isReply threadId
  preparedHtmlContent createdAt createdAtTs wasEdited isPinned
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
    // Links inline als [label](href) erhalten (Muster aus dem alten Deep-State-Script) —
    // sonst fallen sie beim innerText-Plaintext komplett weg
    for (const a of tmp.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      const label = (a.textContent || '').trim() || 'Link';
      const inline = href && !/^(javascript:|data:)/i.test(href) ? ` [${label}](${href}) ` : ` [${label}] `;
      a.replaceWith(document.createTextNode(inline));
    }
    return tmp.innerText.replace(/\n{3,}/g, '\n\n').trim();
  },

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
    // Permalinks: Hauptkommentar → #comment-<id>, Antwort → #reply-<id>
    const base = location.origin + location.pathname;
    // Hierarchie: isReply/parentCommentId = autoritative GQL-Quelle; mainCommentId = Root.
    const isReply = item.isReply ?? !!(item.parentCommentId || item.mainCommentId);
    const permalink = isReply
      ? `${base}#reply-${item.commentId}`
      : `${base}#comment-${item.commentId}`;
    return {
      id:          item.commentId,
      isReply:     isReply,
      parentId:    item.parentCommentId || null,   // direkter Eltern-Kommentar
      rootId:      item.mainCommentId || null,     // Root des Teilbaums
      level:       0,                              // wird in assignLevels() gesetzt
      author,
      authorId:    item.user?.userId   || null,
      date:        item.createdAt      || null,
      createdAtTs: item.createdAtTs    || null,
      wasEdited:   !!item.wasEdited,
      isPinned:    !!item.isPinned,
      text:        this.cleanText(item.preparedHtmlContent),
      deleted,                            // moderiert gelöscht (Moderator-Name)
      userDeleted: !deleted && /^GelöschterUser\d+$/.test(author || ''),
      reactions:   this.parseReactions(item.reactionCounts),
      links:       extractLinks(item.preparedHtmlContent),
      permalink,
      replyCount:  item.replyCount || 0
    };
  },

  /* level = Tiefe aus der parentCommentId-Kette (GQL hat kein depth-Feld). */
  assignLevels(comments) {
    const byId = new Map();
    const all = [];
    for (const root of comments) {
      byId.set(String(root.id), root);
      all.push(root);
      for (const r of (root.replies || [])) {
        byId.set(String(r.id), r);
        all.push(r);
      }
    }
    for (const node of all) {
      let lvl = 0;
      const seen = new Set([String(node.id)]);
      let cur = node;
      while (cur?.parentId && lvl < 32) {
        const parent = byId.get(String(cur.parentId));
        if (!parent || seen.has(String(parent.id))) break;   // fehlender Parent / Zyklus
        seen.add(String(parent.id));
        lvl++;
        cur = parent;
      }
      node.level = lvl;
      node.isReply = lvl > 0;
    }
    return all;
  },

  /* Batched Reply-Fetch: bis zu 30 Parents per Request via Alias-Trick */
  async fetchRepliesBatch(threadId, parentIds, onProgress) {
    if (!parentIds.length) return {};
    const REPLY_FIELDS = COMMENT_FIELDS;
    const aliases = parentIds.map(pid =>
      `r${pid}: comments(filter: { threadId: { eq: ${threadId} }, mainCommentId: ${pid} }, limit: 100) {
        items { ${REPLY_FIELDS} }
      }`
    ).join('\n');
    const res = await fetchWithRetry('/graphql', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query: `query { ${aliases} }` })
    }, null, true);
    const data = (await res.json()).data || {};
    // Map parentId -> replies[]
    const result = {};
    for (const pid of parentIds) {
      result[pid] = (data[`r${pid}`]?.items || []).map(i => this.transform(i)).filter(Boolean);
    }
    return result;
  },

  /* Button-Vorschau: thread.commentCount zählt Roots+Replies, Pagination nur Roots. */
  async fetchCommentMeta(threadId) {
    const res = await fetchWithRetry('/graphql', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        query: `query($threadId: IDFilter!, $commentFilter: CommentFilter!) {
                  thread(threadId: $threadId) { commentCount }
                  comments(filter: $commentFilter, limit: 20, page: 1) {
                    pagination { count last }
                  }
                }`,
        variables: { threadId: { eq: threadId }, commentFilter: { threadId: { eq: threadId } } }
      })
    }, null, true, true);
    const d = (await res.json())?.data;
    const p = d?.comments?.pagination;
    if (!p) throw new Error('Keine Pagination-Antwort');
    return {
      totalCount:    typeof d?.thread?.commentCount === 'number' ? d.thread.commentCount : (p?.count || 0),
      topLevelCount: p?.count || 0,
      last:          p?.last || 1
    };
  },

  /* Top-Level paginiert; Seitenausfall nach Hard-Cap ⇒ Partial-Export statt Throw. */
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
    const r1   = await fetchWithRetry('/graphql', { method: 'POST', headers: this.headers, body: makeBody(1) }, onProgress, true, true);
    if (!r1.ok) throw new Error(`GraphQL HTTP ${r1.status}`);
    const d1   = (await r1.json()).data;
    const all  = [...(d1?.comments?.items || [])];
    const last = d1?.comments?.pagination?.last || 1;
    const count = d1?.comments?.pagination?.count || 0;
    let incomplete = false;

    for (let p = 2; p <= last; p++) {
      // Prozent-Fortschritt: bereits geholte Roots gegen Gesamtzahl (Phase 1)
      const pct = count ? Math.round(Math.min(all.length, count) / count * 100) : 0;
      if (onProgress) onProgress(`Seite ${p}/${last} · ${pct} %`);
      await new Promise(r => setTimeout(r, 350));
      try {
        const rp = await fetchWithRetry('/graphql', { method: 'POST', headers: this.headers, body: makeBody(p) }, onProgress, true, true);
        if (!rp.ok) throw new Error(`GraphQL HTTP ${rp.status}`);
        all.push(...((await rp.json()).data?.comments?.items || []));
      } catch (err) {
        log.error(`Top-Level Seite ${p} nicht erreichbar — Teil-Export`, err);
        incomplete = true;
        break;
      }
    }
    return { items: all, incomplete, count };
  },

  /* Alles holen; Teilausfall ⇒ incomplete statt komplettem Verwerfen. */
  async fetchAll(threadId, onProgress) {
    if (!this.getXsrf()) throw new Error('Kein XSRF-Token - bitte einloggen!');

    // 1. Top-Level-Kommentare (wirft nur bei komplettem Fehlschlag — Seite 1)
    const topLevel = await this.fetchTopLevel(threadId, onProgress);
    const rawItems = topLevel.items;
    let incomplete = topLevel.incomplete;
    const rawItemsCount = rawItems.length;

    // Exakter Root-Nenner: pagination.count aus der ersten Top-Level-Seitenantwort (gratis geliefert)
    const count = topLevel.count || rawItemsCount;

    // 2. Identifiziere Parents die mehr Replies haben als im Preview
    const needMoreReplies = rawItems.filter(item => {
      const previewLen = item.repliesPreview?.length || 0;
      return (item.replyCount || 0) > previewLen;
    });

    // 3. Lade fehlende Replies in Batches von 30 — resilient:
    //    scheitert ein Batch trotz Retry-Hard-Cap, wird der Rest gesichert (Partial-Export)
    const BATCH = 30;
    const allReplies = {}; // parentId -> replies[]
    const totalBatches = Math.ceil(needMoreReplies.length / BATCH);
    const totalCount = count; // Gesamtzahl Roots aus der Pagination
    let i = 0;
    try {
      for (i = 0; i < needMoreReplies.length; i += BATCH) {
        const batch = needMoreReplies.slice(i, i + BATCH);
        const parentIds = batch.map(c => c.commentId);
        const batchNo = Math.floor(i / BATCH) + 1;
        const pct = totalCount ? Math.round(rawItemsCount / totalCount * 100) : 100;
        if (onProgress) onProgress(`Replies Batch ${batchNo}/${totalBatches} · Roots ${pct} %`);
        const batchResult = await this.fetchRepliesBatch(threadId, parentIds, onProgress);
        Object.assign(allReplies, batchResult);
        if (i + BATCH < needMoreReplies.length) await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) {
      log.error('Reply-Batches unvollständig — Teil-Export', err);
      incomplete = true;
    }

    // 4. Transformieren und Replies einhängen (inkl. DOM-Hinweis [data-t="noteworthy"])
    const noteworthyIds = new Set(
      Array.from(document.querySelectorAll('[data-t="noteworthy"]'))
        .map(el => el.closest('[data-id]')?.getAttribute('data-id'))
        .filter(Boolean)
    );

    const comments = rawItems.map(item => {
      const node = this.transform(item);
      if (node && noteworthyIds.has(String(node.id))) {
        node.isNoteworthy = true;
      }
      const fetchedReplies = allReplies[item.commentId];
      if (fetchedReplies) {
        node.replies = fetchedReplies;
      } else if (item.repliesPreview?.length > 0) {
        node.replies = item.repliesPreview.map(r => {
          const rNode = this.transform(r);
          if (rNode && noteworthyIds.has(String(rNode.id))) rNode.isNoteworthy = true;
          return rNode;
        }).filter(Boolean);
        if ((item.replyCount || 0) > node.replies.length) {
          node._hiddenReplies = item.replyCount - node.replies.length;
        }
      }
      return node;
    }).filter(Boolean);

    // 4b. Baumtiefe setzen (0 = Top-Level, 1+ = Antwort) — Quelle: parentCommentId
    this.assignLevels(comments);

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
      maxLevel: Math.max(0, ...comments.map(c => c.level || 0), ...comments.flatMap(c => (c.replies || []).map(r => r.level || 0))),
      deleted: comments.filter(c => c.deleted).length,
      userDeleted: comments.filter(c => c.userDeleted).length,
      reactions: {
        like:    sumReactions('like'),
        helpful: sumReactions('helpful'),
        funny:   sumReactions('funny')
      }
    };
    if (incomplete) stats.incomplete = true;

    return { comments, stats, incomplete };
  }
};

/* ── Autor*in-Erkennung: Updates vom Dealersteller ──
   Drei Quellen, in dieser Priorität:
   1. authorId === thread.authorId   (GQL user.userId, autoritativ)
   2. author   === thread.author     (Username-Fallback)
   3. DOM-Badge 'Autor*in' am Kommentar — mydealz rendert es clientseitig,
      im GQL-Schema existiert es NICHT (data_insights.md, Drift-Abschnitt). */
const AUTHOR_BADGE_RE = /^autor(\*?in)?$/i;

function collectDomAuthorIds() {
  const ids = new Set();
  for (const badge of document.querySelectorAll('span.textBadge, [class*="textBadge"]')) {
    if (!AUTHOR_BADGE_RE.test((badge.textContent || '').trim())) continue;
    const holder = badge.closest('[data-id]');
    const raw = holder?.getAttribute('data-id')
      || holder?.id?.replace(/^(?:comment|reply)-/, '')
      || '';
    if (/^\d+$/.test(raw)) ids.add(String(raw));
  }
  return ids;
}

/* Kommentarbaum flach ausrollen (Roots + verschachtelte Replies) */
function flattenComments(comments) {
  const out = [];
  const walk = (c) => { if (!c) return; out.push(c); (c.replies || []).forEach(walk); };
  (comments || []).forEach(walk);
  return out;
}

/* Setzt isAuthor/authorSeq/authorRefs und die Autor-Statistik (Cross-Linking). */
function annotateAuthors(comments, meta) {
  const nodes = flattenComments(comments);
  const nodeById = new Map(nodes.map(n => [String(n.id), n]));
  const domIds = collectDomAuthorIds();
  const authorName = meta?.author || null;

  /* GQL liefert userId nicht in jedem Pfad ⇒ fehlende IDs namensgleich auffüllen. */
  const idByName = new Map();
  for (const n of nodes) {
    if (n.authorId != null && n.authorId !== '') n.authorId = String(n.authorId); // GQL-ID einheitlich
    if (n.author && n.authorId && !idByName.has(n.author)) idByName.set(n.author, n.authorId);
  }
  for (const n of nodes) {
    if (n.author && !n.authorId && idByName.has(n.author)) n.authorId = idByName.get(n.author);
  }

  let authorId = meta?.authorId ? String(meta.authorId) : null;
  if (!authorId && authorName && idByName.has(authorName)) authorId = idByName.get(authorName);
  if (meta) meta.authorId = authorId;

  const byUser = new Map();
  for (const n of nodes) {
    if (!n.author) continue;
    const key = n.authorId ? `id:${n.authorId}` : `name:${n.author}`;
    if (!byUser.has(key)) byUser.set(key, { author: n.author, authorId: n.authorId || null, ids: [] });
    byUser.get(key).ids.push(String(n.id));
  }

  for (const n of nodes) {
    const key = n.author ? (n.authorId ? `id:${n.authorId}` : `name:${n.author}`) : null;
    const ids = (key && byUser.get(key)?.ids) || [];
    const pos = ids.indexOf(String(n.id));
    n.isAuthor = Boolean(
      (authorId && n.authorId && String(n.authorId) === String(authorId)) ||
      (authorName && n.author === authorName) ||
      domIds.has(String(n.id))
    );
    n.authorSeq = pos >= 0 ? pos + 1 : null;
    n.authorTotal = ids.length || null;
    n.authorRefs = ids.filter(id => id !== String(n.id));
  }

  const userIndex = [...byUser.values()].map(b => ({
    author: b.author,
    authorId: b.authorId,
    isAuthor: b.ids.some(id => nodeById.get(id)?.isAuthor === true),
    commentCount: b.ids.length,
    commentIds: b.ids
  })).sort((a, b) => b.commentCount - a.commentCount);

  return {
    authorName,
    authorId,
    authorCommentCount: nodes.filter(n => n.isAuthor).length,
    authorCommentIds: nodes.filter(n => n.isAuthor).map(n => String(n.id)),
    userIndex
  };
}

/* Ausklappen rein manuell: kein Observer/Timer/Auto-Klick (AGENTS.md §2.2). */

/* ── Thread-ID aus URL ── */
function getThreadId() {
  // 1. Robuste Quelle: #main[data-t-d] (JSON) — überlebt Tracking-Params/Share-Links.
  const main = document.getElementById('main');
  if (main?.dataset?.tD) {
    try {
      const id = JSON.parse(main.dataset.tD.replace(/&quot;/g, '"')).threadId;
      if (id) return String(id);
    } catch { /* Fallback auf URL */ }
  }
  // 2. URL-Regex
  const m = window.location.href.match(/(?:deals|gutscheine|diskussion)\/[a-zA-Z0-9-]+-(\d+)/);
  return m ? m[1] : null;
}

/* ── Deal-Metadaten aus DOM ── */
function extractMetadata() {
  // Selektoren aus dem GreasyFork-Exporter — Portal-Layout statt Klassen-Guess.
  const descEl = document.querySelector('div[data-t="description"]')
    || document.querySelector('#threadDescriptionItemPortal .userHtml-content')
    || document.querySelector('main [class*="userHtml-content"]');
  const authorEl = document.querySelector('.threadItemCard-author .thread-user, .short-profile-target .thread-user');
  return {
    threadId: getThreadId(),
    title:    document.querySelector('h1.thread-title')?.textContent?.trim()
              || document.title.split(' | ')[0].trim(),
    price:    document.querySelector('[class*="thread-price"]')?.textContent?.trim() || null,
    // data-t="merchantLink" matcht auch das Gutschein-Navi → :not(.navMenu-link) (2026-11-27).
    merchant: document.querySelector('a[data-t="merchantLink"]:not(.navMenu-link), [class*="cept-merchant-name"]')?.textContent?.trim() || null,
    temperature: document.querySelector('.vote-temp')?.textContent?.trim() || null,
    author:   authorEl?.textContent?.trim() || null,
    // Nutzer-ID nur, wenn am Element vorhanden; annotateAuthors() füllt sie sonst nach.
    authorId: authorEl?.getAttribute('data-user-id')
              || authorEl?.querySelector?.('[data-user-id]')?.getAttribute('data-user-id')
              || authorEl?.closest('[data-user-id]')?.getAttribute('data-user-id')
              || null,
    description: descEl ? GQL.cleanText(descEl.innerHTML) : null,
    links:       descEl ? extractLinks(descEl.innerHTML) : [],
    url:      window.location.href
  };
}

/* ── Button-Vorschau: Kommentaranzahl schon beim Laden anzeigen ── */
let _commentMeta = null;

/* Einheitliches Label für alle Zustände des Buttons — kein „1 Seiten" */
function formatCommentButtonLabel(meta) {
  if (!meta) return 'Export & Analyse';
  const count = meta.totalCount ?? meta.count ?? 0;
  return meta.last > 1 ? `${count} Komm. · ${meta.last} Seiten` : `${count} Komm.`;
}

async function refreshCommentMeta() {
  const threadId = getThreadId();
  if (!threadId) return;
  const lbl = () => document.getElementById('mde-ai-label');
  try {
    const meta = await GQL.fetchCommentMeta(threadId);
    _commentMeta = meta;
    if (meta && lbl()) lbl().textContent = formatCommentButtonLabel(meta);
  } catch (err) {
    log.debug('Kommentar-Meta nicht verfügbar — Button bleibt im Default', err);
  }
}

/* ── Antworten ausklappen: DOM-Klick auf die echten Buttons ──
   Kein eigener GraphQL-Render; nur data-t="moreReplies"-Hooks bedienen und zählen. */
let _expanding = false;

async function expandAllReplies(onProgress) {
  if (_expanding) return 0;
  _expanding = true;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let clicked = 0;

  try {
    for (let round = 0; round < 50; round++) {           // Obergrenze gegen Runaway
      const buttons = [...document.querySelectorAll('button[data-t="moreReplies"]:not([data-mde-clicked])')];
      if (!buttons.length) break;

      for (const b of buttons) {
        b.setAttribute('data-mde-clicked', '1');
        b.click();
        clicked++;
        onProgress?.(`💬 ${clicked}× Antworten geladen…`);
        await sleep(150);                                 // Pausen gegen Request-Burst
      }
      await sleep(700);                                   // Warten bis neue Buttons erscheinen
    }
  } finally {
    _expanding = false;
  }
  return clicked;
}

/* Versteckte Replies zählen: "(9)" aus den Button-Labels summieren */
function countHiddenReplies() {
  let hidden = 0, buttons = 0;
  for (const b of document.querySelectorAll('button[data-t="moreReplies"]')) {
    buttons++;
    const m = b.textContent.match(/\((\d+)\)/);
    if (m) hidden += parseInt(m[1], 10);
  }
  return { hidden, buttons };
}

/* Sammelt den Export-Satz (Meta + Kommentare + Stats) für Dashboard + Download */
async function collectExport(threadId, onProgress) {
  if (!threadId) throw new Error('Kein Thread');
  const { comments, stats, incomplete } = await GQL.fetchAll(threadId, onProgress);
  const meta = extractMetadata();
  // Autor*in-Flags + Cross-Linking kommen NACH dem Walk (Identität aus DOM + Kommentaren).
  Object.assign(stats, annotateAuthors(comments, meta));
  // Ein Serialisierer, ein Ergebnis: hier entsteht das kanonische JSON einmal.
  const jsonString = serializeColumnar(meta, stats, comments);
  return { meta, comments, stats, incomplete, jsonString };
}

/* Fehler → kurz, nutzerlesbar */
function uiError(err) {
  let uiMsg = 'Fehler aufgetreten';
  if (err.message?.includes('XSRF') || err.message?.includes('CSRF')) uiMsg = 'Kein XSRF-Token';
  else if (err.message?.includes('429') || err.message?.includes('HTML statt JSON')) uiMsg = 'Rate-Limit';
  else if (err.message?.includes('HTTP 403')) uiMsg = 'Kein Zugriff (403)';
  else if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) uiMsg = 'Netzwerkfehler';
  else if (err.message) uiMsg = err.message.slice(0, 24);
  return uiMsg;
}

let _collectBusy = false;

function clickGate() {
  if (_collectBusy) {
    if (FETCH_WAIT.active) {
      FETCH_WAIT.skip = true;
      log.info('Force-Retry: Countdown abgebrochen');
    }
    return false;
  }
  _collectBusy = true;
  return true;
}

const MODAL_ID = 'mde-dashboard-modal';
let _modalPrevOverflow = null;

function closeDashboardModal() {
  const d = document.getElementById(MODAL_ID);
  if (!d) return;
  if (d.open) d.close();
  d.remove();
  if (_modalPrevOverflow !== null) {
    document.documentElement.style.overflow = _modalPrevOverflow;
    _modalPrevOverflow = null;
  }
}

/* ::backdrop geht nicht per style-Attribut → winziger Style-Block (CSP erlaubt inline). */
function ensureModalStyle() {
  const id = `${MODAL_ID}-style`;
  if (document.getElementById(id)) return;
  const st = document.createElement('style');
  st.id = id;
  st.textContent = `
    dialog#${MODAL_ID}::backdrop{background:rgba(2,6,23,.5);
      backdrop-filter:blur(8px) saturate(1.15);-webkit-backdrop-filter:blur(8px) saturate(1.15)}
    dialog#${MODAL_ID}{animation:mde-modal-in .16s ease-out}
    dialog#${MODAL_ID} iframe{color-scheme:dark}
    @keyframes mde-modal-in{from{opacity:0;transform:translateY(10px) scale(.995)}to{opacity:1;transform:none}}`;
  (document.head || document.documentElement).appendChild(st);
}

function openDashboardModal() {
  if (document.getElementById(MODAL_ID)) return;
  ensureModalStyle();

  const d = document.createElement('dialog');
  d.id = MODAL_ID;
  d.className = 'glass-dialog';
  d.setAttribute('aria-label', 'MyDealz AI Exporter — Kommentar-Analyse');
  Object.assign(d.style, {
    margin:'auto',padding:'0',border:'1px solid rgba(148,163,184,.28)',
    borderRadius:'20px',overflow:'hidden',background:'#0f172a',color:'#e2e8f0',
    width:'min(1220px,94vw)',height:'min(88dvh,940px)',maxWidth:'94vw',maxHeight:'92dvh',
    boxShadow:'0 32px 90px rgba(2,6,23,.6)'
  });

  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('ui/dashboard.html');
  frame.title = 'MyDealz AI Exporter';
  frame.setAttribute('allow', 'clipboard-write');
  Object.assign(frame.style, { display:'block',width:'100%',height:'100%',border:'0',background:'#0f172a' });
  d.appendChild(frame);

  // Klick ins Freie (iframe-Klicks erreichen dieses Dokument nie) + Escape.
  d.addEventListener('click', e => { if (e.target === d) closeDashboardModal(); });
  d.addEventListener('cancel', e => { e.preventDefault(); closeDashboardModal(); });
  d.addEventListener('close', () => {
    d.remove();
    if (_modalPrevOverflow !== null) {
      document.documentElement.style.overflow = _modalPrevOverflow;
      _modalPrevOverflow = null;
    }
  });

  document.body.appendChild(d);
  _modalPrevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';   // Seite darunter nicht mitscrollen
  d.showModal();
}

/* Schließen-Button lebt im Dashboard-iframe und meldet sich hier zurück */
window.addEventListener('message', e => {
  if (e.data?.type !== 'MDE_CLOSE') return;
  if (e.origin !== `chrome-extension://${chrome.runtime.id}`) return;
  closeDashboardModal();
});

/* ── Button ── */
function injectButton() {
  if (!getThreadId()) return;
  if (document.getElementById('mde-ai-btn')) return;

  const wrap = document.createElement('div');
  wrap.id = 'mde-ai-wrap';
  wrap.popover = 'manual';   // Top-Layer, damit z-index-Kriege der Seite wirkungslos sind
  Object.assign(wrap.style, {
    // 84px = 6px Luft über mydealz' "nach oben"-Button (#btn--moveToTop, 42+36px).
    // `inset` ist Pflicht: sonst setzt die Popover-UA-Regel inset:0 (Widget oben links).
    position:'fixed',inset:'auto 24px 84px auto',bottom:'84px',right:'24px',
    top:'auto',left:'auto',zIndex:'2147483647',
    margin:'0',border:'none',padding:'0',background:'transparent',
    display:'flex',flexDirection:'column',alignItems:'flex-end',gap:'8px'
  });

  /* Mydealz-Button-Sprache: runde Kapseln, Averta-Typografie, 700er Gewicht. */
  const makeBtn = (bg, textColor) => {
    const b = document.createElement('button');
    Object.assign(b.style, {
      height:'36px',padding:'0 14px',background:bg,color:textColor,
      border:'none',borderRadius:'999px',fontSize:'12px',fontWeight:'700',
      fontFamily:'"Averta CY","Helvetica Neue",Helvetica,system-ui,sans-serif',
      letterSpacing:'.1px',boxShadow:'0 4px 16px rgba(15,23,42,.18)',
      cursor:'pointer',transition:'background .15s, transform .1s',
      whiteSpace:'nowrap',maxWidth:'min(340px,74vw)',overflow:'hidden',textOverflow:'ellipsis'
    });
    b.addEventListener('mousedown', () => { if (!b.disabled) b.style.transform = 'scale(.97)'; });
    b.addEventListener('mouseup',   () => { b.style.transform = ''; });
    return b;
  };

  // Hover-Farbe je Button (ein Aufruf statt zwei Listener-Paare pro Button).
  const hover = (b, on, off) => {
    b.addEventListener('mouseenter', () => b.style.background = on);
    b.addEventListener('mouseleave', () => b.style.background = off);
  };

  const btn = makeBtn('#16A34A', '#fff');
  btn.id = 'mde-ai-btn';
  btn.style.height = '48px';
  btn.style.padding = '0 22px';
  btn.style.fontSize = '14px';
  btn.style.boxShadow = '0 6px 22px rgba(22,163,74,.4)';
  const lbl = () => document.getElementById('mde-ai-label');
  btn.innerHTML = '🧠 <span id="mde-ai-label">Export &amp; Analyse</span>';
  hover(btn, '#15803D', '#16A34A');
  btn.addEventListener('click', async () => {
    const threadId = getThreadId();
    if (!threadId) { lbl().textContent = 'Kein Thread'; return; }
    if (!clickGate()) return;
    btn.style.opacity = '.7';
    btn.style.cursor = 'progress';   // Fetch läuft (Klick = Force-Retry nur im Countdown)
    try {
      const payload = await collectExport(threadId, msg => { lbl().textContent = msg; });
      await chrome.runtime.sendMessage({ type: 'STORE_EXPORT', payload });
      openDashboardModal();          // In-Page-Overlay statt neuem Tab
      if (payload.incomplete) {
        lbl().textContent = `⚠️ Teil-Export: ${payload.stats.totalTopLevel} Komm.`;
        btn.style.background = '#D97706';
      } else {
        lbl().textContent = `✅ ${payload.stats.totalTopLevel}+${payload.stats.totalRepliesVisible} Komm.`;
        btn.style.background = '#2563EB';
      }
    } catch (err) {
      log.error('Kommentar-Export fehlgeschlagen', err);
      lbl().textContent = `❌ ${uiError(err)}`;
      btn.style.background = '#DC2626';
    } finally {
      _collectBusy = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      const reset = formatCommentButtonLabel(_commentMeta);
      setTimeout(() => { lbl().textContent = reset; btn.style.background = '#16A34A'; }, 4000);
    }
  });

  const expandBtn = makeBtn('#1d1f20', '#c5c7ca');
  expandBtn.id = 'mde-expand-btn';
  expandBtn.title = 'Nur auf Klick: versteckte Antworten ausklappen (für Strg+F). Neue Seiten: erneut klicken.';
  const expLbl = () => document.getElementById('mde-expand-label');
  expandBtn.innerHTML = '💬 <span id="mde-expand-label">Antworten ausklappen</span>';
  hover(expandBtn, '#2a2d2f', '#1d1f20');
  expandBtn.addEventListener('click', async () => {
    expandBtn.disabled = true; expandBtn.style.opacity = '.7';
    try {
      const n = await expandAllReplies(msg => { expLbl().textContent = msg; });
      expLbl().textContent = n ? `✅ ${n}× ausgeklappt` : '✅ Alles sichtbar';
    } catch (err) {
      log.error('Ausklappen fehlgeschlagen', err);
      expLbl().textContent = '❌ Fehler';
    } finally {
      expandBtn.disabled = false; expandBtn.style.opacity = '1';
      setTimeout(refreshExpandLabel, 4000);
    }
  });

  function refreshExpandLabel() {
    const { hidden, buttons } = countHiddenReplies();
    if (!buttons) { expLbl().textContent = '💬 Alles sichtbar'; return; }
    expLbl().textContent = `💬 ${hidden || buttons} versteckt ausklappen`;
  }

  const dlBtn = makeBtn('#1d1f20', '#c5c7ca');
  dlBtn.id = 'mde-json-btn';
  dlBtn.title = 'Alle Kommentare (inkl. Replies, Links, Permalinks) direkt als JSON herunterladen';
  dlBtn.innerHTML = '💾 <span id="mde-json-label">JSON</span>';
  hover(dlBtn, '#2a2d2f', '#1d1f20');
  dlBtn.addEventListener('click', async () => {
    const threadId = getThreadId();
    if (!threadId) { document.getElementById('mde-json-label').textContent = 'Kein Thread'; return; }
    if (!clickGate()) return;
    dlBtn.style.opacity = '.7';
    dlBtn.style.cursor = 'progress';
    const dlLbl = () => document.getElementById('mde-json-label');
    try {
      const payload = await collectExport(threadId, msg => { dlLbl().textContent = msg; });

      const today = new Date().toISOString().slice(0, 10);
      const slug = String(payload.meta?.title || 'deal').toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 35) || 'deal';
      const filename = `${today}_mydealz-${slug}.json`;

      const blob = new Blob([payload.jsonString], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (payload.incomplete) {
        dlLbl().textContent = `⚠️ Teil: ${payload.stats.totalTopLevel}`;
      } else {
        dlLbl().textContent = `✅ ${payload.stats.totalTopLevel}+${payload.stats.totalRepliesVisible}`;
      }
    } catch (err) {
      log.error('JSON-Download fehlgeschlagen', err);
      dlLbl().textContent = `❌ ${uiError(err)}`;
    } finally {
      _collectBusy = false;
      dlBtn.style.opacity = '1';
      dlBtn.style.cursor = 'pointer';
      setTimeout(() => { dlLbl().textContent = 'JSON'; }, 4000);
    }
  });

  // Reihenfolge: Sekundäres oben, Haupt-CTA unten — direkt über mydealz' "nach oben".
  wrap.appendChild(expandBtn);
  wrap.appendChild(dlBtn);
  wrap.appendChild(btn);
  document.body.appendChild(wrap);
  try { wrap.showPopover(); } catch (_) {}
  refreshCommentMeta();
  setTimeout(() => { try { refreshExpandLabel(); } catch {} }, 1200);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
else injectButton();

let _lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== _lastUrl) {
    _lastUrl = location.href;
    closeDashboardModal();            // altes Overlay gehört zum alten Deal
    setTimeout(injectButton, 800);
    setTimeout(refreshCommentMeta, 900);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
