'use strict';
/* =========================================================
   listing.js  –  Deal-Karten-Exporter (Use Case 1)
   Listing-Seiten: /, /search*, /gruppe/*, /deals*, /neu*, etc.

   Für jede Seite:
   1. Thread-IDs aus DOM-Artikeln lesen
   2. Threads in 30er-Batches per GraphQL-Aliase holen (Chunking)
   3. Wahlweise als JSON oder kompaktes Markdown exportieren

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

/* ── Bild-URL aufbauen ── */
function buildImageUrl(mainImage) {
  if (!mainImage?.uid || !mainImage?.path) return null;
  // Format: https://static.mydealz.de/{path}/{uid}/fs/895x577/qt/65/{uid}
  return `https://static.mydealz.de/${mainImage.path}/${mainImage.uid}/fs/895x577/qt/65/${mainImage.uid}`;
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

    const res = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': token,
        'x-requested-with': 'XMLHttpRequest'
      },
      body: JSON.stringify({ query: `query { ${aliases} }` })
    });

    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
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
      d.merchant ? `🏪 ${d.merchant}` : null,
      d.temperature != null ? `🔥 ${d.temperature}°` : null,
      d.commentCount != null ? `💬 ${d.commentCount}` : null,
      d.isExpired ? '❌ Abgelaufen' : '✅ Aktiv',
      d.author ? `👤 @${d.author}` : null
    ].filter(Boolean);

    lines.push(`### ${idx + 1}. [${d.title || `Deal #${d.id}`}](${d.url})`);
    if (priceInfo) lines.push(`- **Preis:** ${priceInfo}`);
    if (metaParts.length) lines.push(`- **Details:** ${metaParts.join(' · ')}`);
    if (d.description) {
      lines.push('', d.description.split('\n').map(l => `> ${l}`).join('\n'));
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

  container.appendChild(label);
  container.appendChild(btnJson);
  container.appendChild(btnMd);

  const setBusy = (busy) => {
    btnJson.disabled = busy;
    btnMd.disabled   = busy;
    btnJson.style.opacity = busy ? '.6' : '1';
    btnMd.style.opacity   = busy ? '.6' : '1';
  };

  const handleExport = async (format) => {
    const ids = getThreadIds();
    if (!ids.length) {
      label.textContent = '⚠ Keine Deals';
      setTimeout(() => { label.textContent = '📦 Deals'; }, 2000);
      return;
    }

    setBusy(true);

    try {
      const deals = await getDealsWithCache(ids, msg => { label.textContent = msg; });

      const sp    = new URLSearchParams(window.location.search);
      const query = sp.get('q') || null;
      const page  = sp.get('page') || '1';

      const exportObj = {
        _meta: {
          exportedAt: new Date().toISOString(),
          source:     window.location.href,
          query,
          page,
          dealCount:  deals.length
        },
        deals
      };

      const safeName = (query || 'listing').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 40);

      if (format === 'json') {
        downloadFile(JSON.stringify(exportObj, null, 2), `mydealz_${safeName}_p${page}.json`, 'application/json;charset=utf-8');
      } else if (format === 'md') {
        const md = buildListMarkdown(exportObj);
        downloadFile(md, `mydealz_${safeName}_p${page}.md`, 'text/markdown;charset=utf-8');
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
