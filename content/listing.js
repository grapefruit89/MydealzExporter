'use strict';
/* =========================================================
   listing.js  –  Deal-Karten-Exporter für Listing-Seiten
   Läuft auf: mydealz.de/, /search*, /gruppe/*, /gutscheine*
   ========================================================= */

const THREAD_FIELDS = `
  title
  temperature
  price
  priceDiscount
  shareableLink
  publishedAt
  commentCount
  merchant { merchantName }
  mainImage { uid path }
`;

/* ── CSRF ── */
function getCsrf() {
  return document.querySelector('meta[name="csrf-token"]')?.content || '';
}

/* ── GQL: alle IDs auf der Seite in EINER Batch-Anfrage ── */
async function fetchThreadsBatch(ids) {
  const aliases = ids.map(id =>
    `t${id}: thread(threadId: { eq: ${id} }) { ${THREAD_FIELDS} }`
  ).join('\n');

  const res = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': getCsrf(),
      'x-requested-with': 'XMLHttpRequest'
    },
    body: JSON.stringify({ query: `query { ${aliases} }` })
  });

  if (!res.ok) throw new Error(`GQL HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) console.warn('[MDE] GQL warnings:', data.errors);

  // Flatten alias map → array, enrich with DOM extras
  return ids.map(id => {
    const d = data.data?.[`t${id}`] || {};
    const artEl = document.getElementById(`thread_${id}`);

    // DOM-Fallbacks für Felder die GQL nicht liefert
    const oldPriceEl  = artEl?.querySelector('[class*="price--old"]');
    const discountEl  = artEl?.querySelector('[class*="badge--discount"]');
    const authorEl    = artEl?.querySelector('[class*="cept-post-user"]') 
                     || artEl?.querySelector('a[href*="/profile/"]');
    const timeEl      = artEl?.querySelector('time');

    const imageUrl = d.mainImage
      ? `https://static.mydealz.de/${d.mainImage.path}/${d.mainImage.uid}/fs/895x577/qt/65/${d.mainImage.uid}`
      : null;

    return {
      id,
      title:         d.title || artEl?.querySelector('[class*="thread-title"]')?.innerText?.trim() || '',
      url:           d.shareableLink?.replace('/share-deal/', '/deals/') 
                  || `https://www.mydealz.de/deals/${id}`,
      shareLink:     d.shareableLink || '',
      temperature:   d.temperature ?? null,
      price:         d.price ?? null,
      priceOld:      oldPriceEl?.innerText?.replace(/[^\d,\.]/g, '') || null,
      discount:      discountEl?.innerText?.trim() || null,
      merchant:      d.merchant?.merchantName || '',
      commentCount:  d.commentCount ?? null,
      publishedAt:   d.publishedAt ? new Date(d.publishedAt * 1000).toISOString() : null,
      imageUrl,
      author:        authorEl?.innerText?.trim() || null
    };
  });
}

/* ── IDs aus dem DOM extrahieren ── */
function getThreadIds() {
  return [...document.querySelectorAll('article[id^="thread_"]')]
    .map(el => el.id.replace('thread_', ''))
    .filter(id => /^\d+$/.test(id));
}

/* ── JSON-Download ── */
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Button injizieren ── */
function createButton() {
  const btn = document.createElement('button');
  btn.id = 'mde-listing-btn';
  btn.textContent = '📦 Export Deals (JSON)';
  Object.assign(btn.style, {
    position:    'fixed',
    bottom:      '24px',
    right:       '24px',
    zIndex:      '99999',
    padding:     '12px 20px',
    background:  '#2563EB',
    color:       '#fff',
    border:      'none',
    borderRadius:'12px',
    fontSize:    '14px',
    fontWeight:  '700',
    fontFamily:  'system-ui, sans-serif',
    cursor:      'pointer',
    boxShadow:   '0 4px 16px rgba(37,99,235,.4)',
    transition:  'all .2s',
    lineHeight:  '1.2'
  });

  btn.addEventListener('mouseenter', () => btn.style.background = '#1D4ED8');
  btn.addEventListener('mouseleave', () => btn.style.background = '#2563EB');

  btn.addEventListener('click', async () => {
    const ids = getThreadIds();
    if (ids.length === 0) {
      btn.textContent = '⚠ Keine Deals gefunden';
      setTimeout(() => btn.textContent = '📦 Export Deals (JSON)', 2000);
      return;
    }

    btn.textContent = `⏳ Lade ${ids.length} Deals…`;
    btn.disabled = true;

    try {
      const deals = await fetchThreadsBatch(ids);

      // Meta hinzufügen
      const searchParams = new URLSearchParams(window.location.search);
      const exportObj = {
        exportedAt: new Date().toISOString(),
        source:     window.location.href,
        query:      searchParams.get('q') || null,
        page:       searchParams.get('page') || '1',
        dealCount:  deals.length,
        deals
      };

      // Dateiname
      const q     = searchParams.get('q') || 'listing';
      const page  = searchParams.get('page') || '1';
      const fname = `mydealz_${q.replace(/\s+/g,'_')}_p${page}_${Date.now()}.json`;

      downloadJson(exportObj, fname);

      btn.textContent = `✅ ${deals.length} Deals exportiert!`;
      btn.style.background = '#16A34A';
    } catch (err) {
      btn.textContent = `❌ ${err.message}`;
    } finally {
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = '📦 Export Deals (JSON)';
        btn.style.background = '#2563EB';
      }, 3000);
    }
  });

  return btn;
}

/* ── Listing-Seite erkennen ── */
function isListingPage() {
  const path = window.location.pathname;
  return (
    path === '/' ||
    path.startsWith('/search') ||
    path.startsWith('/gruppe/') ||
    path.startsWith('/gutscheine') ||
    path.startsWith('/alle-deals') ||
    path.startsWith('/heiß')
  );
}

/* ── Init ── */
function init() {
  if (!isListingPage()) return;
  if (document.getElementById('mde-listing-btn')) return;

  const btn = createButton();
  document.body.appendChild(btn);

  // SPA: auf Navigation reagieren
  let lastPath = location.pathname + location.search;
  const observer = new MutationObserver(() => {
    const newPath = location.pathname + location.search;
    if (newPath !== lastPath) {
      lastPath = newPath;
      setTimeout(() => {
        document.getElementById('mde-listing-btn')?.remove();
        if (isListingPage()) document.body.appendChild(createButton());
      }, 800);
    }
  });
  observer.observe(document.body, { childList: true, subtree: false });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
