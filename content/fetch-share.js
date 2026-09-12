'use strict';
/* =========================================================
   fetch-share.js  –  Geteilter Fetch mit Retry/Backoff (UC1 + UC2)
   Muster aus PepperDealsScraper (data_insights.md §4):
   nur transiente Fehler wiederholen (408/429/5xx, Netzwerk),
   403/404 sofort aufgeben. Exponentielles Backoff 800ms → 1600ms,
   Retry-After-Header schlägt Eigen-Backoff.
   expectJson: mydealz liefert bei Drosselung gelegentlich 200 + HTML
   statt JSON — wird als transienter Fehler behandelt und geretried.
   ========================================================= */

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_MAX_ATTEMPTS = 2;      // zusätzlich zum ersten Versuch
const RETRY_BASE_DELAY_MS = 800;

async function fetchWithRetry(url, options = {}, onProgress, expectJson = false) {
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

    if (RETRY_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS) {
      lastErr = new Error(`HTTP ${res.status}`);
      continue;
    }
    // 403/404 oder Versuche aufgebraucht → sofort werfen
    throw new Error(`HTTP ${res.status}`);
  }

  throw lastErr || new Error('Fetch fehlgeschlagen');
}
