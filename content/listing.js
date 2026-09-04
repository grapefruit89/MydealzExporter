'use strict';
/* =========================================================
   listing.js  –  Deal-Karten-Exporter (Use Case 1)
   Listing-Seiten: /, /search*, /gruppe/*, /gutscheine*, etc.

   Für jede Seite:
   1. Thread-IDs aus DOM-Artikeln lesen
   2. ALLE Threads in EINER GQL-Batch-Anfrage (Alias-Trick) holen
   3. Vollständige JSON-Datei herunterladen

   GQL-Felder (alle live verifiziert):
     title, price, displayPrice, nextBestPrice, priceOff,
     priceDiscount, description (volles HTML), url, shareableLink,
     temperature, commentCount, isExpired, publishedAt, createdAt,
     user { username userId }, merchant { merchantId merchantName },
     mainImage { uid path }
   ========================================================= */

/* ── GQL-Felder (vollständig, live getestet am 2025-09) ── */
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

/* ── CSRF ── */
function getCsrf() {
  return document.querySelector('meta[name="csrf-token"]')?.content || '';
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

/* ── GQL Batch-Anfrage: alle IDs in EINER Anfrage per Alias ── */
async function fetchThreadsBatch(ids) {
  const aliases = ids
    .map(id => `t${id}: thread(threadId: { eq: ${id} }) { ${THREAD_FIELDS} }`)
    .join('\n');

  const res = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': getCsrf(),
      'x-requested-with': 'XMLHttpRequest'
    },
    body: JSON.stringify({ query: `query { ${aliases} }` })
  });

  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) console.warn('[MDE Listing] GQL-Hinweise:', json.errors);

  return ids.map(id => {
    const d = json.data?.[`t${id}`];
    if (!d) return { id, error: 'nicht gefunden' };

    // Discount % berechnen (falls GQL null liefert)
    let discountPct = d.priceDiscount;
    if (discountPct == null && d.nextBestPrice && d.price != null && d.nextBestPrice > d.price) {
      discountPct = Math.round((d.nextBestPrice - d.price) / d.nextBestPrice * 100);
    }

    return {
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
    };
  });
}

/* ── Thread-IDs aus DOM-Artikeln ── */
function getThreadIds() {
  return [...document.querySelectorAll('article[id^="thread_"]')]
    .map(el => el.id.replace('thread_', ''))
    .filter(id => /^\d+$/.test(id));
}

/* ── JSON herunterladen ── */
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Floating-Button ── */
function createButton() {
  const btn = document.createElement('button');
  btn.id = 'mde-listing-btn';
  btn.innerHTML = '📦 <span id="mde-label">Export Deals</span>';
  Object.assign(btn.style, {
    position:     'fixed',
    bottom:       '24px',
    right:        '24px',
    zIndex:       '2147483647',
    padding:      '12px 20px',
    background:   '#2563EB',
    color:        '#fff',
    border:       'none',
    borderRadius: '12px',
    fontSize:     '14px',
    fontWeight:   '700',
    fontFamily:   'system-ui, -apple-system, sans-serif',
    cursor:       'pointer',
    boxShadow:    '0 4px 20px rgba(37,99,235,.45)',
    transition:   'background .15s, transform .1s',
    lineHeight:   '1.3',
    whiteSpace:   'nowrap'
  });

  const label = () => btn.querySelector('#mde-label');
  btn.addEventListener('mouseenter', () => btn.style.background = '#1D4ED8');
  btn.addEventListener('mouseleave', () => btn.style.background = '#2563EB');
  btn.addEventListener('mousedown',  () => btn.style.transform = 'scale(.97)');
  btn.addEventListener('mouseup',    () => btn.style.transform = '');

  btn.addEventListener('click', async () => {
    const ids = getThreadIds();
    if (!ids.length) {
      label().textContent = '⚠ Keine Deals';
      setTimeout(() => label().textContent = 'Export Deals', 2000);
      return;
    }

    label().textContent = `⏳ ${ids.length} Deals laden…`;
    btn.disabled = true;
    btn.style.opacity = '.7';

    try {
      const deals = await fetchThreadsBatch(ids);

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
      downloadJson(exportObj, `mydealz_${safeName}_p${page}.json`);

      label().textContent = `✅ ${deals.length} exportiert`;
      btn.style.background = '#16A34A';
    } catch (err) {
      console.error('[MDE Listing]', err);
      label().textContent = `❌ ${err.message.slice(0, 30)}`;
    } finally {
      btn.disabled = false;
      btn.style.opacity = '1';
      setTimeout(() => {
        label().textContent = 'Export Deals';
        btn.style.background = '#2563EB';
      }, 3500);
    }
  });

  return btn;
}

/* ── Ist das eine Listing-Seite? ── */
function isListingPage() {
  const p = window.location.pathname;
  return (
    p === '/' ||
    p.startsWith('/search') ||
    p.startsWith('/gruppe/') ||
    p.startsWith('/group/') ||
    p.startsWith('/gutschein') ||
    p.startsWith('/alle-deals') ||
    p.startsWith('/hei')    // /heiß (URL-encoded)
  );
}

/* ── Initialisierung (mit SPA-Support) ── */
function mount() {
  if (!isListingPage()) return;
  if (document.getElementById('mde-listing-btn')) return;
  document.body.appendChild(createButton());
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
