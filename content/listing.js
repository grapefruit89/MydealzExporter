'use strict';
/* =========================================================
   listing.js  –  Deal-Karten-Exporter (Use Case 1)
   Listing-Seiten: /search*, /gruppe/*, /group/* (siehe isListingPage)

   Für jede Seite:
   1. Thread-IDs aus DOM-Artikeln lesen
   2. Optional +2 weitere Seiten via AJAX-Endpoint
      (?page=N&ajax=true&layout=horizontal → data-vue3-Payloads)
   3. Threads in 10er-Batches per GraphQL-Aliase holen (Chunking;
     30 Aliase sprengen Mydealz' Komplexitätslimit von 500 — 10 bleiben darunter)
   4. Wahlweise als JSON oder kompaktes Markdown exportieren

   GQL-Felder (alle live verifiziert):
     title, price, displayPrice, nextBestPrice, priceOff,
     priceDiscount, description (volles HTML), url, shareableLink,
     temperature, commentCount, isExpired, publishedAt, createdAt,
     user { username userId }, merchant { merchantId merchantName },
     mainImage { uid path }

   [anchor:fail-closed] Kein Download bei fehlerhaftem Abruf: Fehler brechen
   sichtbar ab, fehlende Threads werden als `error: 'nicht gefunden'` markiert
   statt stillschweigend weggelassen — Teilexporte sind als solche erkennbar.
   ========================================================= */

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
   Links, Blockquotes, Code). Bilder werden bewusst komplett verworfen.
   Kein DOMPurify — wir RENDEREN nicht, wir serialisieren nur in reinen
   Text (kein XSS-Risiko im MD-File). */
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
    if (tag === 'IMG') return '';   // Bilder komplett strippen (kein ![](…)-Markdown)

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
  const uidClean = String(mainImage.uid).replace(/\.raw$/, '');
  // Format: https://static.mydealz.de/{path}/{uidClean}/re/1024x1024/qt/60/{uidClean}.jpg
  return `https://static.mydealz.de/${mainImage.path}/${uidClean}/re/1024x1024/qt/60/${uidClean}.jpg`;
}

/* ── GQL Batch-Anfrage mit Chunking (10er-Batches per Alias) ── */
async function fetchThreadsBatch(ids, onProgress) {
  const CHUNK_SIZE = 10;
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
    }, onProgress, true);
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
        imageUrl:       buildImageUrl(d.mainImage),

        // Listing-Export enthält bewusst KEINE Kommentare (nur den Zähler oben)
        comments:       []
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
  }, onProgress, true);

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

/* ── Kompaktes Markdown generieren ──
   Reines Metadaten-Template, ein Block je Deal: Titel als H2, feste
   Feldreihenfolge, jede Zeile nur wenn der Wert existiert, dann die
   bilderfreie Beschreibung und ein Trenner. */
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
      lines.push(`## ${idx + 1}. Deal #${d.id} – Nicht gefunden`, '', '---', '');
      return;
    }

    lines.push(`## ${idx + 1}. ${d.title || `Deal #${d.id}`}`);

    if (d.id != null) lines.push(`- **Deal-ID:** ${d.id}`);

    // Preis: "549,00 €" oder "549,00 € (UVP: ~~899,00 €~~ · -39%)"
    const eur = n => `${Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
    const basePrice = d.displayPrice || (d.price != null ? eur(d.price) : null);
    if (basePrice) {
      const uvp = d.originalPrice != null
        ? ` (UVP: ~~${eur(d.originalPrice)}~~${d.discountPct != null ? ` · -${d.discountPct}%` : ''})`
        : '';
      lines.push(`- **Preis:** ${basePrice}${uvp}`);
    }

    if (d.merchant) lines.push(`- **Händler:** ${d.merchant}`);
    if (d.voucherCode) lines.push(`- **Gutscheincode:** ${d.voucherCode}`);

    if (d.shippingFree) lines.push('- **Versand:** Kostenlos');
    else if (d.shipping != null) lines.push(`- **Versand:** ${d.shipping} €`);

    if (d.temperature != null) {
      const level = d.temperatureLevel ? ` (${d.temperatureLevel})` : '';
      lines.push(`- **Temperatur:** 🔥 ${Math.round(d.temperature)}°${level}`);
    }

    if (d.group) lines.push(`- **Gruppe:** ${d.group}`);
    if (d.author) lines.push(`- **Ersteller:** @${d.author}`);
    lines.push(d.isExpired ? '- **Status:** ❌ Abgelaufen' : '- **Status:** ✅ Aktiv');
    lines.push(`- **Deal-Link:** ${d.url || `https://www.mydealz.de/deals/${d.id}`}`);

    const merchantLink = d.outboundLink || d.shareLink;
    if (merchantLink) lines.push(`- **Händler-Link:** ${merchantLink}`);

    lines.push('', '### Beschreibung:');
    const body = (htmlToMarkdown(d.descriptionHtml) || d.description || '').trim();
    if (body) lines.push('', body);
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

/* ── Floating-Widget (JSON + Markdown) via nativem Popover ──
   Optik, Typografie und Popover-Mechanik 1:1 aus content/content.js:
   Capsule-Buttons, Averta CY, 700er Gewicht, Top-Layer via Popover.
   `inset` + `top/left/bottom/right` sind Pflicht — sonst setzt die
   Popover-UA-Regel inset:0 und das Widget landet oben links. */
function createWidget() {
  const wrap = document.createElement('div');
  wrap.id = 'mde-listing-wrap';
  wrap.popover = 'manual';   // Top-Layer, damit z-index-Kriege der Seite wirkungslos sind
  Object.assign(wrap.style, {
    // 84px = 6px Luft über mydealz' "nach oben"-Button (#btn--moveToTop, 42+36px).
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

  const lbl = () => document.getElementById('mde-listing-label');

  const btnJson = makeBtn('#1d1f20', '#c5c7ca');
  btnJson.id = 'mde-list-json-btn';
  btnJson.title = 'Deals als JSON herunterladen';
  btnJson.innerHTML = '💾 <span id="mde-list-json-label">JSON</span>';
  btnJson.addEventListener('mouseenter', () => { if (!btnJson.disabled) btnJson.style.background = '#2a2d2f'; });
  btnJson.addEventListener('mouseleave', () => { if (!btnJson.disabled) btnJson.style.background = '#1d1f20'; });

  const btnMd = makeBtn('#1d1f20', '#c5c7ca');
  btnMd.id = 'mde-list-md-btn';
  btnMd.title = 'Deals als Markdown herunterladen';
  btnMd.innerHTML = '📄 <span id="mde-list-md-label">MD</span>';
  btnMd.addEventListener('mouseenter', () => { if (!btnMd.disabled) btnMd.style.background = '#2a2d2f'; });
  btnMd.addEventListener('mouseleave', () => { if (!btnMd.disabled) btnMd.style.background = '#1d1f20'; });

  const btnPages = makeBtn('#1d1f20', '#c5c7ca');
  btnPages.id = 'mde-list-pages-btn';
  btnPages.title = '2 weitere Seiten dazuladen (max. 2, vorsichtiger Modus)';
  btnPages.innerHTML = '➕ <span id="mde-list-pages-label">+2 Seiten</span>';
  let multiPage = false;
  btnPages.addEventListener('mouseenter', () => { if (!btnPages.disabled) btnPages.style.background = multiPage ? '#15803D' : '#2a2d2f'; });
  btnPages.addEventListener('mouseleave', () => { if (!btnPages.disabled) btnPages.style.background = multiPage ? '#16A34A' : '#1d1f20'; });
  btnPages.addEventListener('click', () => {
    multiPage = !multiPage;
    btnPages.style.background = multiPage ? '#16A34A' : '#1d1f20';
  });

  const btn = makeBtn('#16A34A', '#fff');
  btn.id = 'mde-listing-btn';
  btn.style.height = '48px';
  btn.style.padding = '0 22px';
  btn.style.fontSize = '14px';
  btn.style.boxShadow = '0 6px 22px rgba(22,163,74,.4)';
  btn.innerHTML = '📋 <span id="mde-listing-label">Deals exportieren</span>';
  btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = '#15803D'; });
  btn.addEventListener('mouseleave', () => { if (!btn.disabled) btn.style.background = '#16A34A'; });

  const setBusy = (busy) => {
    for (const b of [btn, btnJson, btnMd, btnPages]) {
      b.disabled = busy;
      b.style.opacity = busy ? '.6' : '1';
      b.style.cursor = busy ? 'progress' : 'pointer';
    }
  };

  const handleExport = async (format) => {
    setBusy(true);
    lbl().textContent = '📦 Deals…';

    try {
      let ids, pageFrom, pageTo;

      if (multiPage) {
        ({ ids, pageFrom, pageTo } = await collectAllIds(msg => { lbl().textContent = msg; }));
        if (!ids.length) {
          lbl().textContent = '⚠ Keine Deals';
          return;
        }
      } else {
        ids = getThreadIds();
        if (!ids.length) {
          lbl().textContent = '⚠ Keine Deals';
          return;
        }
        const p = new URLSearchParams(window.location.search).get('page');
        pageFrom = pageTo = parseInt(p || '1', 10) || 1;
      }

      const deals = await getDealsWithCache(ids, msg => { lbl().textContent = msg; });

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
          dealCount:  deals.length,
          commentsExported: 0          // Listing-Export: Deal-Metadaten + Beschreibung, keine Kommentare
        },
        deals
      };

      /* Dateiname: <datum>_mydealz-<thema>[_p<von>-p<bis>]. Thema = Suchbegriff →
         Gruppe → Fallback "deals". clean() = lowercase kebab-case, Umlaute
         ausgeschrieben, auf 35 Zeichen gekappt — lesbar und dateisystemtauglich. */
      const today = new Date().toISOString().slice(0, 10);
      const clean = s => String(s || '').toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 35);
      const groupMatch = location.pathname.match(/\/(?:gruppe|group)\/([^/]+)/);
      const topic = query ? clean(query)
        : groupMatch ? clean(decodeURIComponent(groupMatch[1]))
        : 'deals';
      const pageSuffix = pageFrom === pageTo ? '' : `_p${pageFrom}-p${pageTo}`;
      const baseName = `${today}_mydealz-${topic}${pageSuffix}`;

      if (format === 'json') {
        downloadFile(JSON.stringify(exportObj, null, 2), `${baseName}.json`, 'application/json;charset=utf-8');
      } else if (format === 'md') {
        const md = buildListMarkdown(exportObj);
        downloadFile(md, `${baseName}.md`, 'text/markdown;charset=utf-8');
      }

      lbl().textContent = `✅ ${deals.length} exportiert`;
    } catch (err) {
      log.error('Export fehlgeschlagen', err);

      // Sauber getrennte, benutzerfreundliche Fehlermeldungen für das UI
      let uiMsg = 'Fehler aufgetreten';
      if (err.message?.includes('HTTP 429')) uiMsg = 'Rate-Limit (429)';
      else if (err.message?.includes('HTTP 403')) uiMsg = 'Kein Zugriff (403)';
      else if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) uiMsg = 'Netzwerk-Timeout';
      else if (err.message?.includes('XSRF') || err.message?.includes('CSRF')) uiMsg = 'CSRF-Fehler';
      else if (err.message) uiMsg = err.message.slice(0, 22);

      lbl().textContent = `❌ ${uiMsg}`;
    } finally {
      setBusy(false);
      setTimeout(() => {
        lbl().textContent = 'Deals exportieren';
      }, 3500);
    }
  };

  btnJson.addEventListener('click', () => handleExport('json'));
  btnMd.addEventListener('click',   () => handleExport('md'));
  btn.addEventListener('click',     () => handleExport('json'));   // Haupt-CTA: JSON als Default

  // Reihenfolge: Sekundäres oben, Haupt-CTA unten — direkt über mydealz' "nach oben".
  wrap.appendChild(btnJson);
  wrap.appendChild(btnMd);
  wrap.appendChild(btnPages);
  wrap.appendChild(btn);

  return wrap;
}

/* ── Ist das eine Listing-Seite? ──
   Option 2: nur Suche und Gruppen. Startseite, /deals*, /neu*, /beliebt*,
   /highlights*, /gutscheine* und alle Detailseiten bleiben ohne Widget. */
function isListingPage() {
  const p = window.location.pathname;
  return (
    p.startsWith('/search') ||
    p.startsWith('/gruppe/') ||
    p.startsWith('/group/')
  );
}

/* ── Initialisierung (mit SPA-Support) ── */
function mount() {
  if (!isListingPage()) { unmount(); return; }
  if (document.getElementById('mde-listing-wrap')) return;
  const widget = createWidget();
  document.body.appendChild(widget);
  try { widget.showPopover(); } catch (_) {}
}

function unmount() {
  document.getElementById('mde-listing-wrap')?.remove();
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
