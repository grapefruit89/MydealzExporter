'use strict';
/* =========================================================
   listing.js  –  Deal-Karten-Exporter (Use Case 1)
   Listing-Seiten: /, /search*, /gruppe/*, /deals*, /neu*, etc.

   Für jede Seite:
   1. Thread-IDs aus DOM-Artikeln lesen
   2. Optional +2 weitere Seiten via AJAX-Endpoint
      (?page=N&ajax=true&layout=horizontal → data-vue3-Payloads)
   3. Threads in 30er-Batches per GraphQL-Aliase holen (Chunking)
   4. Wahlweise als JSON oder kompaktes Markdown exportieren

   GQL-Felder (alle live verifiziert):
     title, price, displayPrice, nextBestPrice, priceOff,
     priceDiscount, description (volles HTML), url, shareableLink,
     temperature, commentCount, isExpired, publishedAt, createdAt,
     user { username userId }, merchant { merchantId merchantName },
     mainImage { uid path }
   ========================================================= */

/* ── GQL-Felder (vollständig, live getestet) ── */
const THREAD_FIELDS = `
  title
  price
  displayPrice
  nextBestPrice
  priceOff
  priceDiscount
  description
  url
  shareableLink
  temperature
  commentCount
  isExpired
  publishedAt
  createdAt
  user { username userId }
  merchant { merchantId merchantName }
  mainImage { uid path }
  mainGroup { threadGroupId threadGroupName threadGroupUrlName }
  groupsPath { threadGroupId threadGroupName threadGroupUrlName }
  shipping { isFree price }
  updatedAt
  voucherCode
  temperatureLevel
  type
  keywordNames
  selectedLocations { isNational }
`.trim();

/* ── Strukturierter Logger (MDE:Listing) ──
   Trennt Extension-Logs optisch vom Webseiten-Rauschen.
   Verhindert Falsch-Positiv-Fehler in chrome://extensions durch sauberes
   Formatting und getrennte Kanäle (GQL-Hinweise als debug statt rohem console.warn). */
const log = {
  _style: 'background:#2563eb;color:#fff;font-weight:700;padding:2px 6px;border-radius:4px;',
  info(msg, ...args) {
    console.info(`%cMDE:Listing%c ${msg}`, this._style, '', ...args);
  },
  debug(msg, ...args) {
    console.debug(`%cMDE:Listing%c ${msg}`, this._style, '', ...args);
  },
  gqlHints(errors) {
    if (!errors?.length) return;
    const details = errors.map(e => e.message || (typeof e === 'object' ? JSON.stringify(e) : String(e))).join(' | ');
    // Als debug loggen, damit Chromium Extension Manager keinen falschen RUNTIME ERROR in chrome://extensions auslöst
    console.debug(`%cMDE:Listing%c ℹ️ GQL-Hinweise (${errors.length}): ${details}`, this._style, '');
  },
  error(msg, err) {
    const detail = err?.stack || err?.message || String(err);
    console.error(`%cMDE:Listing%c ❌ ${msg}`, this._style, '', detail);
  }
};

/* ── CSRF-Token (Meta-Tag mit Cookie-Fallback & Unquoting) ── */
function getCsrf() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta?.content) return meta.content;
  const m = document.cookie.match(/xsrf_t=([^;]+)/);
  if (!m) return '';
  let val = decodeURIComponent(m[1]);
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  return val;
}

/* ── HTML → Plaintext (für descriptionText) ── */
function htmlToText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return tmp.innerText.replace(/\n{3,}/g, '\n\n').trim();
}

/* ── HTML → Markdown (für descriptionMarkdown im MD-Export) ──
   Kleiner Vanilla-Konverter für mydealz-Beschreibungen (Listen, Fett,
   Links, Bilder, Blockquotes, Code). Kein DOMPurify — wir RENDEREN nicht,
   wir serialisieren nur in reinen Text (kein XSS-Risiko im MD-File). */
function htmlToMarkdown(html) {
  if (!html) return '';

  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'FIGURE', 'FIGCAPTION', 'DD', 'DT']);

  function hasBlockChild(el) {
    return [...el.children].some(c =>
      BLOCK_TAGS.has(c.tagName) || /^H[1-6]$/.test(c.tagName) ||
      ['UL', 'OL', 'TABLE', 'BLOCKQUOTE', 'PRE'].includes(c.tagName));
  }

  function inlineNodeMd(child) {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent.replace(/\s+/g, ' ');
    if (child.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = child.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return '';
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') {
      const src = child.getAttribute('src') || '';
      return src ? `![${child.getAttribute('alt') || 'Bild'}](${src})` : '';
    }

    let inner = '';
    for (const c of child.childNodes) inner += inlineNodeMd(c);
    inner = inner.replace(/[^\S\n]+/g, ' ').trim();
    if (!inner) return '';

    if (tag === 'STRONG' || tag === 'B')      return `**${inner}**`;
    if (tag === 'EM' || tag === 'I')          return `*${inner}*`;
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') return `~~${inner}~~`;
    if (tag === 'CODE')                       return `\`${inner}\``;
    if (tag === 'A') {
      const href = child.getAttribute('href') || '';
      return href && !href.startsWith('javascript:') ? `[${inner}](${href})` : inner;
    }
    return inner;   // SPAN, U, SMALL, …: nur Inhalt
  }

  function inlineText(node) {
    let out = '';
    for (const child of node.childNodes) out += inlineNodeMd(child);
    return out;
  }

  function listMd(list, depth) {
    const pad = '  '.repeat(depth);
    let out = '';
    let idx = 1;
    for (const li of list.children) {
      if (li.tagName !== 'LI') continue;
      const marker = list.tagName === 'OL' ? `${idx++}. ` : '- ';
      const clone = li.cloneNode(true);
      clone.querySelectorAll('ul, ol').forEach(n => n.remove());
      out += pad + marker + inlineText(clone).trim() + '\n';
      for (const sub of li.children) {
        if (sub.tagName === 'UL' || sub.tagName === 'OL') out += listMd(sub, depth + 1);
      }
    }
    return out;
  }

  function blockText(node, depth = 0) {
    let out = '';
    const pad = '  '.repeat(depth);

    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent.trim()) out += pad + child.textContent.replace(/\s+/g, ' ').trim() + '\n\n';
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;

      if (/^H[1-6]$/.test(tag)) {
        out += `${'#'.repeat(+tag[1])} ${inlineText(child).trim()}\n\n`;
      } else if (tag === 'UL' || tag === 'OL') {
        out += listMd(child, depth) + '\n';
      } else if (tag === 'BLOCKQUOTE') {
        const inner = blockText(child, 0).trim();
        out += inner.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n') + '\n\n';
      } else if (tag === 'PRE') {
        out += '```\n' + child.textContent.replace(/\n$/, '') + '\n```\n\n';
      } else if (tag === 'TABLE') {
        for (const tr of child.querySelectorAll('tr')) {
          const cells = [...tr.children].map(td => inlineText(td).trim().replace(/\|/g, '\\|'));
          if (cells.length) out += '| ' + cells.join(' | ') + ' |\n';
        }
        out += '\n';
      } else if (tag === 'HR') {
        out += '---\n\n';
      } else if (hasBlockChild(child)) {
        out += blockText(child, depth);
      } else {
        // Inline-Container (P, SPAN, A mit Bild, …) als ein Absatz
        const t = inlineNodeMd(child).replace(/[^\S\n]+/g, ' ').trim();
        if (t) out += pad + t + '\n\n';
      }
    }
    return out;
  }

  return blockText(tpl.content).replace(/\n{3,}/g, '\n\n').trim();
}

/* ── Bild-URL aufbauen ── */
function buildImageUrl(mainImage) {
  if (!mainImage?.uid || !mainImage?.path) return null;
  // Format: https://static.mydealz.de/{path}/{uid}/fs/895x577/qt/65/{uid}
  return `https://static.mydealz.de/${mainImage.path}/${mainImage.uid}/fs/895x577/qt/65/${mainImage.uid}`;
}

/* ── Fetch mit Retry/Backoff ──
   Muster aus PepperDealsScraper (data_insights.md §4):
   nur transiente Fehler wiederholen (408/429/5xx), 403/404 sofort aufgeben.
   Exponentielles Backoff: 800ms → 1600ms. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_MAX_ATTEMPTS = 2;      // zusätzlich zum ersten Versuch
const RETRY_BASE_DELAY_MS = 800;

async function fetchWithRetry(url, options = {}, onProgress) {
  let lastErr = null;
  let lastRes = null;

  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      let delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      // Server-Hinweis schlägt Eigen-Backoff (Muster aus dem alten Deep-State-Script)
      const retryAfter = parseInt(lastRes?.headers?.get('Retry-After') || '', 10);
      if (retryAfter > 0) delay = Math.max(delay, retryAfter * 1000);
      onProgress?.(`⏳ Retry in ${Math.round(delay / 1000)}s…`);
      await new Promise(r => setTimeout(r, delay));
      log.debug(`Retry ${attempt}/${RETRY_MAX_ATTEMPTS} für ${new URL(url, location.origin).pathname}`);
    }

    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      lastErr = err;                       // Netzwerkfehler → Retry
      continue;
    }
    lastRes = res;

    if (res.ok) return res;

    if (RETRY_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS) {
      lastErr = new Error(`HTTP ${res.status}`);
      continue;
    }
    // 403/404 oder Versuche aufgebraucht → sofort werfen
    throw new Error(`HTTP ${res.status}`);
  }

  throw lastErr || new Error('Fetch fehlgeschlagen');
}

/* ── GQL Batch-Anfrage mit Chunking (30er-Batches per Alias) ── */
async function fetchThreadsBatch(ids, onProgress) {
  const CHUNK_SIZE = 30;
  const allDeals = [];
  const token = getCsrf();

  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(ids.length / CHUNK_SIZE);

    if (onProgress && totalChunks > 1) {
      onProgress(`⏳ Batch ${chunkNum}/${totalChunks}…`);
    }

    const aliases = chunk
      .map(id => `t${id}: thread(threadId: { eq: ${id} }) { ${THREAD_FIELDS} }`)
      .join('\n');

    const res = await fetchWithRetry('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': token,
        'x-requested-with': 'XMLHttpRequest'
      },
      body: JSON.stringify({ query: `query { ${aliases} }` })
    }, onProgress);
    const json = await res.json();
    if (json.errors) log.gqlHints(json.errors);

    for (const id of chunk) {
      const d = json.data?.[`t${id}`];
      if (!d) {
        allDeals.push({ id, error: 'nicht gefunden' });
        continue;
      }

      // Discount % berechnen (falls GQL null liefert)
      let discountPct = d.priceDiscount;
      if (discountPct == null && d.nextBestPrice && d.price != null && d.nextBestPrice > d.price) {
        discountPct = Math.round((d.nextBestPrice - d.price) / d.nextBestPrice * 100);
      }

      allDeals.push({
        id,

        // Identifikation
        url:            d.url || `https://www.mydealz.de/deals/${id}`,
        shareLink:      d.shareableLink || '',

        // Inhalt
        title:          d.title || '',
        description:    htmlToText(d.description),   // Plaintext
        descriptionHtml: d.description || '',         // Original-HTML
        links:          extractLinks(d.description), // Links in der Beschreibung

        // Preise
        price:          d.price ?? null,
        displayPrice:   d.displayPrice || null,       // "35,90€"
        originalPrice:  d.nextBestPrice ?? null,      // durchgestrichener Preis
        priceOff:       d.priceOff ?? null,           // Rabattbetrag (€)
        discountPct,                                  // Rabatt %

        // Meta
        temperature:    d.temperature ?? null,
        commentCount:   d.commentCount ?? null,
        isExpired:      d.isExpired ?? false,
        publishedAt:    d.publishedAt  ? new Date(d.publishedAt  * 1000).toISOString() : null,
        createdAt:      d.createdAt    ? new Date(d.createdAt    * 1000).toISOString() : null,

        // Akteure
        author:         d.user?.username   || null,
        authorId:       d.user?.userId     || null,
        merchant:       d.merchant?.merchantName || null,
        merchantId:     d.merchant?.merchantId  || null,

        // Kategorie (autoritativ — Übersichtsseite zeigt teils veraltete Kategorie)
        group:          d.mainGroup?.threadGroupName || null,
        groupId:        d.mainGroup?.threadGroupId   || null,
        groupUrlName:   d.mainGroup?.threadGroupUrlName || null,
        groupPath:      (d.groupsPath || []).map(g => g.threadGroupName).filter(Boolean),

        // Versand & Bearbeitung
        shipping:       d.shipping?.price ?? null,        // null = unbekannt, 0 = frei
        shippingFree:   d.shipping?.isFree === true,
        updatedAt:      d.updatedAt ? new Date(d.updatedAt * 1000).toISOString() : null,

        // Gutschein & Temperatur-Klassifizierung (Feldnamen via studio-amba-Schema bestätigt)
        voucherCode:    d.voucherCode || null,
        temperatureLevel: d.temperatureLevel || null,     // "Hot2", "SuperHot", …

        // Klassifizierung (Raw-Payload-Shape via saswave-Actor offen)
        type:           d.type || null,                   // "Deal" | "Voucher" | …
        isNational:     d.selectedLocations?.isNational ?? null,  // lokal vs. bundesweit
        keywords:       d.keywordNames || null,

        // Bild
        imageUrl:       buildImageUrl(d.mainImage)
      });
    }

    // Höflichkeits-Pause zwischen Chunks gegen Rate Limits
    if (i + CHUNK_SIZE < ids.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return allDeals;
}

/* ── Kurzzeit-Cache für wiederholten Export (JSON -> MD ohne Re-Fetch) ── */
let _cachedDeals = null;
let _cachedIdsKey = '';

async function getDealsWithCache(ids, onProgress) {
  const key = ids.join(',');
  if (_cachedDeals && _cachedIdsKey === key) {
    return _cachedDeals;
  }
  const deals = await fetchThreadsBatch(ids, onProgress);
  _cachedDeals = deals;
  _cachedIdsKey = key;
  return deals;
}

/* ── Thread-IDs aus DOM-Artikeln ── */
function getThreadIds() {
  return [...document.querySelectorAll('article[id^="thread_"]')]
    .map(el => el.id.replace('thread_', ''))
    .filter(id => /^\d+$/.test(id));
}

/* ── Multi-Page: zusätzliche Seiten via AJAX-Endpoint ──
   Pepper-Listings liefern bei ?page=N&ajax=true&layout=horizontal ein
   JSON-Objekt { data: { content: "<html>" } }. Die Thread-Daten stecken
   dort in data-vue3-Attributen (props.thread) — genau wie im Initial-HTML.
   Bewusst knapp gedeckelt (2 Extraseiten + Pause), um Rate-Limits/Bans
   zu vermeiden. Die Deals selbst kommen weiterhin aus dem GQL-Batch
   (volles Feldset inkl. description) — hier werden nur IDs gesammelt. */
const MAX_EXTRA_PAGES = 2;
const EXTRA_PAGE_PAUSE_MS = 700;

/* ── Vue3-Thread-Payloads aus HTML parsen (IDs + outbound deal-Link) ──
   mydealz bettet die Thread-Daten in data-vue3-Attributen ein — dort steckt
   auch `link`/`linkHost` (der echte Händler-Link, serverseitig gecloakt). */
function parseVue3Threads(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  for (const el of doc.querySelectorAll('[data-vue3]')) {
    try {
      const data = JSON.parse(el.getAttribute('data-vue3'));
      const t = data?.props?.thread;
      if (t?.threadId && /^\d+$/.test(String(t.threadId))) {
        const id = String(t.threadId);
        const link = /^https?:\/\//.test(t.link || '')
          ? t.link
          : `${location.origin}/visit/threadmain/${id}`;   // kanonischer outbound-Pfad
        out.push({ id, link, linkHost: t.linkHost || null });
      }
    } catch { /* defektes Payload überspringen */ }
  }
  return out;
}

/* Outbound-Links sammeln: initiale Seite (DOM) + alle AJAX-Extraseiten */
const _outboundIndex = new Map();   // threadId -> { link, linkHost }

function indexOutboundFromDom() {
  for (const t of parseVue3Threads(document.documentElement.outerHTML)) {
    _outboundIndex.set(t.id, { link: t.link, linkHost: t.linkHost });
  }
}

function parseThreadIdsFromHtml(html) {
  return parseVue3Threads(html).map(t => t.id);
}

async function fetchExtraPageIds(pageNum, onProgress) {
  const sp = new URLSearchParams(window.location.search);
  sp.delete('ajax');
  sp.delete('layout');
  sp.set('page', String(pageNum));
  sp.set('ajax', 'true');
  sp.set('layout', 'horizontal');

  const res = await fetchWithRetry(window.location.pathname + '?' + sp.toString(), {
    headers: { 'x-requested-with': 'XMLHttpRequest' }
  }, onProgress);

  const text = await res.text();
  let html = text;
  if (text.trimStart().startsWith('{')) {
    try { html = JSON.parse(text)?.data?.content ?? ''; } catch { /* HTML-Fallback */ }
  }
  const threads = parseVue3Threads(html);
  for (const t of threads) {
    if (t.link) _outboundIndex.set(t.id, { link: t.link, linkHost: t.linkHost });
  }
  return threads.map(t => t.id);
}

/* Sichtbare Seite + max. MAX_EXTRA_PAGES Folgeseiten, dedupliziert. */
async function collectAllIds(onProgress) {
  const visible = getThreadIds();
  const all   = [...new Set(visible)];
  const sp    = new URLSearchParams(window.location.search);
  const pageFrom = parseInt(sp.get('page') || '1', 10) || 1;
  let pageTo = pageFrom;

  for (let i = 1; i <= MAX_EXTRA_PAGES; i++) {
    onProgress?.(`⏳ Seite ${pageFrom + i}…`);
    const ids = await fetchExtraPageIds(pageFrom + i, onProgress);
    if (!ids.length) break;                      // Ende der Liste
    const before = all.length;
    for (const id of ids) if (!all.includes(id)) all.push(id);
    log.debug(`Extra-Seite ${pageFrom + i}: ${ids.length} IDs (${all.length - before} neu)`);
    pageTo = pageFrom + i;
    if (i < MAX_EXTRA_PAGES) await new Promise(r => setTimeout(r, EXTRA_PAGE_PAUSE_MS));
  }

  return { ids: all, pageFrom, pageTo };
}

/* ── Kompaktes Markdown generieren ── */
function buildListMarkdown(exportObj) {
  const { _meta, deals } = exportObj;
  const lines = [
    `# MyDealz Export: ${_meta.query ? `Suche "${_meta.query}"` : 'Deals'}`,
    `- **Datum:** ${_meta.exportedAt}`,
    `- **Quelle:** ${_meta.source}`,
    `- **Gefundene Deals:** ${_meta.dealCount}`,
    '',
    '---',
    ''
  ];

  deals.forEach((d, idx) => {
    if (d.error) {
      lines.push(`### ${idx + 1}. [Deal #${d.id}](${d.url}) – Nicht gefunden`, '', '---', '');
      return;
    }

    const priceParts = [];
    if (d.displayPrice || d.price != null) priceParts.push(`**${d.displayPrice || (d.price + '€')}**`);
    if (d.originalPrice != null) priceParts.push(`~~${d.originalPrice}€~~`);
    if (d.discountPct != null) priceParts.push(`(-${d.discountPct}%)`);
    const priceInfo = priceParts.join(' ');

    const metaParts = [
      d.group ? `🏷 ${d.group}` : null,
      d.merchant ? `🏪 ${d.merchant}` : null,
      d.temperature != null ? `🔥 ${d.temperature}°` : null,
      d.voucherCode ? `🎟 ${d.voucherCode}` : null,
      d.shippingFree ? `📦 Versand frei` : (d.shipping != null ? `📦 Versand ${d.shipping}€` : null),
      d.commentCount != null ? `💬 ${d.commentCount}` : null,
      d.isExpired ? '❌ Abgelaufen' : '✅ Aktiv',
      d.author ? `👤 @${d.author}` : null
    ].filter(Boolean);

    lines.push(`### ${idx + 1}. [${d.title || `Deal #${d.id}`}](${d.url})`);
    if (priceInfo) lines.push(`- **Preis:** ${priceInfo}`);
    if (metaParts.length) lines.push(`- **Details:** ${metaParts.join(' · ')}`);
    if (d.descriptionHtml || d.description) {
      lines.push('', htmlToMarkdown(d.descriptionHtml) || d.description);
    }
    lines.push('', '---', '');
  });

  return lines.join('\n');
}

/* ── Datei herunterladen (Blob) ── */
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Floating-Widget (JSON + Markdown) ── */
function createWidget() {
  const container = document.createElement('div');
  container.id = 'mde-listing-btn';
  Object.assign(container.style, {
    position:     'fixed',
    bottom:       '24px',
    right:        '24px',
    zIndex:       '2147483647',
    display:      'inline-flex',
    alignItems:   'center',
    background:   '#1e293b',
    color:        '#fff',
    borderRadius: '12px',
    padding:      '4px 6px',
    boxShadow:    '0 4px 20px rgba(0,0,0,.35)',
    fontFamily:   'system-ui, -apple-system, sans-serif',
    fontSize:     '13px',
    gap:          '4px',
    userSelect:   'none'
  });

  const label = document.createElement('span');
  label.id = 'mde-label';
  label.textContent = '📦 Deals';
  Object.assign(label.style, {
    padding:     '0 8px',
    fontWeight:  '700',
    fontSize:    '13px',
    whiteSpace:  'nowrap',
    color:       '#e2e8f0'
  });

  const makeBtn = (text, title) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    Object.assign(b.style, {
      background:   '#2563eb',
      color:        '#fff',
      border:       'none',
      borderRadius: '8px',
      padding:      '8px 12px',
      fontSize:     '12px',
      fontWeight:   '700',
      cursor:       'pointer',
      transition:   'background .15s, transform .1s',
      whiteSpace:   'nowrap'
    });
    b.addEventListener('mouseenter', () => { if (!b.disabled) b.style.background = '#1d4ed8'; });
    b.addEventListener('mouseleave', () => { if (!b.disabled) b.style.background = '#2563eb'; });
    b.addEventListener('mousedown',  () => { if (!b.disabled) b.style.transform = 'scale(.96)'; });
    b.addEventListener('mouseup',    () => { if (!b.disabled) b.style.transform = ''; });
    return b;
  };

  const btnJson = makeBtn('JSON', 'Deals als JSON herunterladen');
  const btnMd   = makeBtn('MD', 'Deals als Markdown herunterladen');

  const btnPages = makeBtn('+2 Seiten', '2 weitere Seiten dazuladen (max. 2, vorsichtiger Modus)');
  btnPages.style.background = '#475569';
  let multiPage = false;
  btnPages.addEventListener('click', () => {
    multiPage = !multiPage;
    btnPages.style.background = multiPage ? '#16a34a' : '#475569';
  });

  container.appendChild(label);
  container.appendChild(btnJson);
  container.appendChild(btnMd);
  container.appendChild(btnPages);

  const setBusy = (busy) => {
    btnJson.disabled = busy;
    btnMd.disabled   = busy;
    btnPages.disabled = busy;
    btnJson.style.opacity = busy ? '.6' : '1';
    btnMd.style.opacity   = busy ? '.6' : '1';
    btnPages.style.opacity = busy ? '.6' : '1';
  };

  const handleExport = async (format) => {
    setBusy(true);
    label.textContent = '📦 Deals…';

    try {
      let ids, pageFrom, pageTo;

      if (multiPage) {
        ({ ids, pageFrom, pageTo } = await collectAllIds(msg => { label.textContent = msg; }));
        if (!ids.length) {
          label.textContent = '⚠ Keine Deals';
          return;
        }
      } else {
        ids = getThreadIds();
        if (!ids.length) {
          label.textContent = '⚠ Keine Deals';
          return;
        }
        const p = new URLSearchParams(window.location.search).get('page');
        pageFrom = pageTo = parseInt(p || '1', 10) || 1;
      }

      const deals = await getDealsWithCache(ids, msg => { label.textContent = msg; });

      // Outbound-Links (echter Händler-Link) aus den Vue-Payloads einhängen
      indexOutboundFromDom();
      for (const deal of deals) {
        const ob = _outboundIndex.get(String(deal.id));
        if (ob) { deal.outboundLink = ob.link; deal.outboundHost = ob.linkHost; }
      }

      const sp = new URLSearchParams(window.location.search);
      const query = sp.get('q') || null;

      // mydealz-eigene Filter (Preis, Temperatur, Gruppe …) mitprotokollieren —
      // gelten automatisch auch für die AJAX-Extraseiten
      const filters = {};
      for (const [k, v] of sp) {
        if (!['ajax', 'layout', 'page'].includes(k)) filters[k] = v;
      }

      const exportObj = {
        _meta: {
          exportedAt: new Date().toISOString(),
          source:     window.location.href,
          query,
          filters:    Object.keys(filters).length ? filters : null,
          pageFrom,
          pageTo,
          dealCount:  deals.length
        },
        deals
      };

      const safeName = (query || 'listing').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 40);
      const pageSuffix = pageFrom === pageTo ? `p${pageFrom}` : `p${pageFrom}-p${pageTo}`;

      if (format === 'json') {
        downloadFile(JSON.stringify(exportObj, null, 2), `mydealz_${safeName}_${pageSuffix}.json`, 'application/json;charset=utf-8');
      } else if (format === 'md') {
        const md = buildListMarkdown(exportObj);
        downloadFile(md, `mydealz_${safeName}_${pageSuffix}.md`, 'text/markdown;charset=utf-8');
      }

      label.textContent = `✅ ${deals.length} exportiert`;
    } catch (err) {
      log.error('Export fehlgeschlagen', err);

      // Sauber getrennte, benutzerfreundliche Fehlermeldungen für das UI
      let uiMsg = 'Fehler aufgetreten';
      if (err.message?.includes('HTTP 429')) uiMsg = 'Rate-Limit (429)';
      else if (err.message?.includes('HTTP 403')) uiMsg = 'Kein Zugriff (403)';
      else if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) uiMsg = 'Netzwerk-Timeout';
      else if (err.message?.includes('XSRF') || err.message?.includes('CSRF')) uiMsg = 'CSRF-Fehler';
      else if (err.message) uiMsg = err.message.slice(0, 22);

      label.textContent = `❌ ${uiMsg}`;
    } finally {
      setBusy(false);
      setTimeout(() => {
        label.textContent = '📦 Deals';
      }, 3500);
    }
  };

  btnJson.addEventListener('click', () => handleExport('json'));
  btnMd.addEventListener('click',   () => handleExport('md'));

  return container;
}

/* ── Ist das eine Listing-Seite? ── */
function isListingPage() {
  const p = window.location.pathname;

  // Detailseiten mit ID am Ende explizit ausschließen (Deals, Gutscheine, Diskussionen)
  if (/\/(?:deals|gutscheine|diskussion)\/[^/]+-\d+$/.test(p)) return false;

  return (
    p === '/' ||
    p === '/deals' ||
    p.startsWith('/deals-') ||
    p.startsWith('/search') ||
    p.startsWith('/gruppe/') ||
    p.startsWith('/group/') ||
    p.startsWith('/gutschein') ||
    p.startsWith('/alle-deals') ||
    p.startsWith('/neu') ||
    p.startsWith('/beliebt') ||
    p.startsWith('/highlights') ||
    p.startsWith('/zeitgeist') ||
    p.startsWith('/hei')    // /heiß oder /heiss
  );
}

/* ── Initialisierung (mit SPA-Support) ── */
function mount() {
  if (!isListingPage()) return;
  if (document.getElementById('mde-listing-btn')) return;
  document.body.appendChild(createWidget());
}

function unmount() {
  document.getElementById('mde-listing-btn')?.remove();
}

// Erster Mount
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}

// SPA-Navigation beobachten (History API)
let _lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== _lastUrl) {
    _lastUrl = location.href;
    unmount();
    setTimeout(mount, 600); // kurz warten bis DOM aufgebaut
  }
}).observe(document.documentElement, { childList: true, subtree: true });
