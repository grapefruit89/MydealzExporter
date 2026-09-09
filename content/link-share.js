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
    const url = /^https?:\/\//i.test(href) ? href : new URL(href, location.origin).href;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ text: (a.textContent || '').trim().slice(0, 120) || null, url });
  }
  return out;
}
