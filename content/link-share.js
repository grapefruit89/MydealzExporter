'use strict';
/* =========================================================
   link-share.js  –  Gemeinsame Link-Extraktion (UC1 + UC2)
   Wird via manifest.json in beide Content-Scripts geladen.
   innerText-Plaintext verliert hrefs — hier werden sie sauber
   gesammelt: dedupliziert, absolut, javascript:/Anker raus.
   ========================================================= */

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

    /* mydealz-Cloaking aufheben: bei /visit/-Redirects steckt die echte
       Ziel-URL oft im title-Attribut (Muster: GreasyFork 532929,
       "Mydealz Direktlink statt Redirect"). Fällt auf href zurück. */
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
