'use strict';
/* =========================================================
   fetch-share.js  –  Geteilter Fetch mit Retry/Backoff (UC1 + UC2)
   Muster aus PepperDealsScraper (data_insights.md §4):
   nur transiente Fehler wiederholen (408/429/5xx, Netzwerk),
   403/404 sofort aufgeben.

   Zwei Modi:
   – Standard (UC1): 800→1600ms Backoff, 2 Extra-Versuche, dann fertig.
   – persistent (UC2-Thread-Export): adaptives Backoff 10s × 1,25^k
     (Userscript-Muster „MyDealz Comment Section Exporter" v3.8,
     handleRateLimitWithRetry), Retry-After schlägt Eigen-Backoff,
     Hard-Cap 5 Versuche, sichtbarer Sekunden-Countdown.

   Force-Retry: FETCH_WAIT.skip von der UI auf true setzen → die
   Warteschleife bricht ab und der Fetch feuert sofort. Der Status
   FETCH_WAIT.active signalisiert der UI, dass gerade gewartet wird.
   ========================================================= */

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_MAX_ATTEMPTS = 2;      // Standard: Extra-Versuche zusätzlich zum ersten
const RETRY_BASE_DELAY_MS = 800;
const PERSISTENT_ATTEMPTS = 5;     // Hard-Cap: persistenter Modus bricht nach 5 Gesamtvorsuchen ab
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
      // Server-Hinweis schlägt Eigen-Backoff (Muster aus dem alten Deep-State-Script)
      const retryAfter = parseInt(lastRes?.headers?.get('Retry-After') || '', 10);

      if (persistent) {
        // Adaptives Backoff mit sichtbarem Sekunden-Countdown (Userscript-Muster)
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
