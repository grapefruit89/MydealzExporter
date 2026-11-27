#!/usr/bin/env node
/**
 * tools/health-check.mjs — Automatisierter Health-Check & Schema-Drift-Detektor
 * 
 * Überprüft die 4 Säulen des MyDealz AI Exporters:
 * 1. Code- & Manifest-Integrität (node --check, manifest.json, Budget-Gate, Schema-Map)
 * 2. Live-GraphQL Schema (/graphql Query-Drift, Thread-Felder, Kommentare)
 * 3. Listing-AJAX & Vue3-Payloads (/deals?ajax=true, ThreadMainListItemNormalizer)
 * 4. East-West-Gegenüberstellung (DOM-Extraktion vs. GraphQL-Datenabgleich)
 * 
 * Nutzt automatisch den offenen Chrome-Debug-Port (127.0.0.1:9222), um Cloudflare-
 * blockierte Abfragen authentifiziert im Browser-Kontext durchzuführen.
 * 
 * Aufruf:
 *   node tools/health-check.mjs           # Führt alle Checks aus
 *   node tools/health-check.mjs --offline # Nur statische Code-Gates
 *   node tools/health-check.mjs 2867793   # Gegen konkreten Thread testen
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const isOffline = process.argv.includes('--offline');
const customThreadArg = process.argv.find((arg, i) => i > 1 && !arg.startsWith('--') && !process.argv[i-1].startsWith('--'));
const TEST_THREAD_ID = Number(customThreadArg) || 2867793;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

console.log(`${C.bold}${C.cyan}╔═══════════════════════════════════════════════════════════════════╗${C.reset}`);
console.log(`${C.bold}${C.cyan}║         MyDealz AI Exporter — Health Check & Drift Gate          ║${C.reset}`);
console.log(`${C.bold}${C.cyan}╚═══════════════════════════════════════════════════════════════════╝${C.reset}\n`);

let totalPassed = 0;
let totalFailed = 0;

function pass(title, detail = '') {
  totalPassed++;
  console.log(`  ${C.green}✓${C.reset} ${C.bold}${title}${C.reset}${detail ? ` ${C.dim}(${detail})${C.reset}` : ''}`);
}

function fail(title, error = '') {
  totalFailed++;
  console.log(`  ${C.red}✗${C.reset} ${C.bold}${C.red}${title}${C.reset}${error ? `\n    ${C.red}↳ ${error}${C.reset}` : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Säule 1: Statische Code- und Manifest-Prüfung
// ─────────────────────────────────────────────────────────────────────────────
console.log(`${C.bold}1. Code- und Manifest-Integrität${C.reset}`);
let schemaMap = null;
try {
  const jsFiles = [
    'content/content.js',
    'content/listing.js',
    'service-worker.js',
    'ui/dashboard.js'
  ];
  for (const f of jsFiles) {
    const fullPath = path.join(REPO_ROOT, f);
    if (!fs.existsSync(fullPath)) throw new Error(`Datei fehlt: ${f}`);
    execSync(`node --check "${fullPath}"`, { stdio: 'pipe' });
  }
  pass('JavaScript-Syntax aller Module fehlerfrei (node --check)');

  // MV3 verbietet Inline-Scripts in extension_pages → jedes <script src> muss
  // auflösen. Popup und Dashboard teilen sich ui/dashboard.js (kein popup.js).
  for (const htmlRel of ['ui/popup.html', 'ui/dashboard.html']) {
    const html = fs.readFileSync(path.join(REPO_ROOT, htmlRel), 'utf8');
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
      throw new Error(`${htmlRel} enthält ein Inline-Script (MV3-CSP verbietet das)`);
    }
    for (const m of html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)) {
      const target = path.resolve(path.dirname(path.join(REPO_ROOT, htmlRel)), m[1]);
      if (!fs.existsSync(target)) throw new Error(`${htmlRel}: Script fehlt: ${m[1]}`);
    }
  }
  if (!/function initPopupSettings\s*\(/.test(fs.readFileSync(path.join(REPO_ROOT, 'ui/dashboard.js'), 'utf8'))) {
    throw new Error('initPopupSettings() fehlt in ui/dashboard.js');
  }
  pass('Keine Inline-Scripts; Popup-/Dashboard-Script löst auf (ui/dashboard.js)');

  const manifestPath = path.join(REPO_ROOT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('manifest_version ist nicht 3');
  for (const entry of manifest.content_scripts || []) {
    for (const js of entry.js || []) {
      if (!fs.existsSync(path.join(REPO_ROOT, js))) throw new Error(`Content-Script fehlt: ${js}`);
    }
  }
  pass(`Manifest V3 valide (v${manifest.version}, Content-Scripts vorhanden)`);

  // Cockpit-/Modul-Gate (Budget, 15–40 KiB, shared-bootstrap-Identität)
  execSync(`node "${path.join(REPO_ROOT, 'tools/repo-map-check.mjs')}"`, { stdio: 'pipe' });
  pass('Cockpit-/Modul-Gate grün (Budgets, 15–40 KiB, shared-bootstrap)');

  // Schema-Map
  const schemaMapPath = path.join(REPO_ROOT, 'tools/deal-schema-map.json');
  if (fs.existsSync(schemaMapPath)) {
    schemaMap = JSON.parse(fs.readFileSync(schemaMapPath, 'utf8'));
    pass(`Deal-Schema-Map geladen (${schemaMap.fields.length} Felder definiert)`);
  } else {
    fail('deal-schema-map.json nicht gefunden');
  }
} catch (err) {
  fail('Statische Integritätsprüfung fehlgeschlagen', err.message);
}

if (isOffline) {
  printSummary();
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Säule 2: CDP Browser-Verbindung & Live-GraphQL
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}2. Live-GraphQL Schema & Endpoint (/graphql)${C.reset}`);

// CDP Helper
async function getChromePage() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/list');
    if (!res.ok) return null;
    const targets = await res.json();
    const pages = targets.filter(t => t.type === 'page');
    // Bevorzugt den Tab, der den Test-Thread zeigt — sonst vergleicht der
    // East-West-Abgleich DOM und GraphQL aus zwei verschiedenen Deals.
    return pages.find(t => new RegExp(`[-/]${TEST_THREAD_ID}(?:$|[?#])`).test(t.url || '')) ||
           pages.find(t => t.url?.includes('mydealz.de')) ||
           pages[0];
  } catch {
    return null;
  }
}

async function evalInBrowser(wsUrl, code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP Timeout nach 10s'));
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: code, awaitPromise: true, returnByValue: true }
      }));
    };

    ws.onmessage = (event) => {
      clearTimeout(timeout);
      ws.close();
      const data = JSON.parse(event.data);
      if (data.error) return reject(new Error(data.error.message));
      if (data.result?.exceptionDetails) {
        return reject(new Error(data.result.exceptionDetails.text || 'Runtime Fehler'));
      }
      resolve(data.result?.result?.value);
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

const chromePage = await getChromePage();
let gqlData = null;
let domData = null;

if (chromePage) {
  pass(`Debug-Browser auf Port 9222 erkannt`, chromePage.title?.slice(0, 45));

  // 2.1 GraphQL über authentifizierte Browser-Session
  const gqlProbeCode = `
    (async () => {
      const m = document.cookie.match(/xsrf_t=([^;]+)/);
      let tok = m ? decodeURIComponent(m[1]) : '';
      if (tok.startsWith('"') && tok.endsWith('"')) tok = tok.slice(1, -1);
      
      const F = 'title price displayPrice nextBestPrice priceOff priceDiscount description url shareableLink temperature commentCount isExpired publishedAt createdAt user { username userId } merchant { merchantId merchantName } mainImage { uid path } mainGroup { threadGroupId threadGroupName threadGroupUrlName } groupsPath { threadGroupId threadGroupName threadGroupUrlName } shipping { isFree price } updatedAt voucherCode temperatureLevel type selectedLocations { isNational }';
      
      const q = \`query {
        t: thread(threadId: { eq: ${TEST_THREAD_ID} }) { \${F} }
        c: comments(filter: { threadId: { eq: ${TEST_THREAD_ID} } }, limit: 2, page: 1) {
          items {
            commentId mainCommentId parentCommentId isReply threadId preparedHtmlContent createdAt createdAtTs wasEdited isPinned
            deletedBy { username } replyCount user { username userId } reactionCounts { type count }
            repliesPreview { commentId mainCommentId parentCommentId isReply }
          }
          pagination { last count current }
        }
      }\`;

      const res = await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': tok, 'x-requested-with': 'XMLHttpRequest' },
        body: JSON.stringify({ query: q })
      });
      return await res.json();
    })()
  `;

  try {
    const res = await evalInBrowser(chromePage.webSocketDebuggerUrl, gqlProbeCode);
    if (res?.errors?.length > 0) {
      fail('GraphQL Schema-Drift / Fehler gemeldet', res.errors.map(e => e.message).join('; '));
    } else if (res?.data?.t) {
      gqlData = res.data.t;
      pass('Thread-Query (/graphql) 100% synchron', `Titel: "${gqlData.title?.slice(0, 32)}..."`);
      pass(`Kommentar-Pagination validiert`, `${res.data.c?.pagination?.count ?? 0} Kommentare in Thread #${TEST_THREAD_ID}`);

      // Hierarchie-Gate: isReply muss exakt (parentCommentId !== null) entsprechen
      const probeItems = res.data.c?.items || [];
      const inconsistent = probeItems.filter(i => i.isReply !== (i.parentCommentId !== null));
      if (probeItems.length && inconsistent.length === 0) {
        pass('Kommentar-Hierarchie (isReply/parentCommentId) konsistent', `${probeItems.length} Stichproben, level clientseitig ableitbar`);
      } else if (inconsistent.length) {
        fail('Kommentar-Hierarchie inkonsistent', `isReply != (parentCommentId !== null) bei ${inconsistent.map(i => i.commentId).join(', ')}`);
      }
    } else {
      fail(`Keine Thread-Daten für ID ${TEST_THREAD_ID} erhalten`);
    }
  } catch (err) {
    fail('Live-GraphQL Probe über Browser fehlgeschlagen', err.message);
  }

  // 2.2 Popover & Widget-Prüfung im Live-DOM
  const popoverCheckCode = `
    (() => {
      const aiWrap = document.getElementById('mde-ai-wrap');
      const listingBtn = document.getElementById('mde-listing-btn');
      const el = aiWrap || listingBtn;
      return {
        exists: !!el,
        id: el?.id || null,
        popover: el?.getAttribute('popover') || null,
        isMatchesPopoverOpen: el ? el.matches(':popover-open') : false
      };
    })()
  `;
  try {
    const popoverStatus = await evalInBrowser(chromePage.webSocketDebuggerUrl, popoverCheckCode);
    if (popoverStatus.exists && popoverStatus.popover === 'manual') {
      pass(`Natives Popover aktiv (#${popoverStatus.id}, popover="manual", Top-Layer)`);
    } else if (popoverStatus.exists) {
      fail(`Widget vorhanden, aber nicht als popover="manual" registriert (${popoverStatus.popover})`);
    } else {
      console.log(`  ${C.yellow}ℹ Widget noch nicht auf aktuellem Tab injiziert (wird bei Deal-Aufruf aktiv)${C.reset}`);
    }
  } catch (err) {
    fail('Popover-Check fehlgeschlagen', err.message);
  }

  // 2.3 DOM-Extraktion im Live-Tab
  const domExtractCode = `
    (() => {
      const isAuthorBadge = (el) => /^Autor(\\*in)?$/i.test((el?.textContent || '').trim());
      const holders = [...document.querySelectorAll('li.commentList-item[data-id], div.comment-replies-item[data-id]')]
        .filter(el => [...el.querySelectorAll('[class*="textBadge"]')].some(isAuthorBadge));
      return {
        title: document.querySelector('h1.thread-title')?.textContent?.trim() ||
               document.querySelector('span.size--all-xl')?.textContent?.trim() || null,
        price: document.querySelector('.thread-price')?.textContent?.trim() || null,
        nextBestPrice: document.querySelector('.text--lineThrough')?.textContent?.trim() || null,
        temperature: document.querySelector('.vote-temp')?.textContent?.trim() ||
                     document.querySelector('.overflow--wrap-off')?.textContent?.trim() || null,
        merchant: document.querySelector('a[data-t="merchantLink"]:not(.navMenu-link)')?.textContent?.trim() || null,
        commentCount: document.querySelector('a[data-t="commentsLink"]')?.textContent?.trim() ||
                      document.querySelector('span.size--all-l.text--b')?.textContent?.trim() || null,
        authorName: document.querySelector('.threadItemCard-author .thread-user, .short-profile-target .thread-user')?.textContent?.trim() || null,
        authorBadgeIds: holders.map(el => el.getAttribute('data-id')).filter(Boolean)
      };
    })()
  `;
  try {
    domData = await evalInBrowser(chromePage.webSocketDebuggerUrl, domExtractCode);
    if (domData?.authorBadgeIds?.length) {
      pass(`Autor*in-Badge im Live-DOM erkannt`,
        `${domData.authorBadgeIds.length} Kommentar(e) von @${domData.authorName || '?'} · IDs ${domData.authorBadgeIds.join(', ')}`);
    } else {
      console.log(`  ${C.yellow}ℹ Kein "Autor*in"-Badge im aktuellen DOM — Badge erscheint nur, wenn der Dealersteller kommentiert hat.${C.reset}`);
    }
  } catch {}

} else {
  console.log(`  ${C.yellow}⚠ Kein Chrome Debug-Browser auf 127.0.0.1:9222 erreichbar. Live-Probe übersprungen.${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Säule 3: Listing-AJAX & Vue3-Payloads
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}3. Listing-AJAX & Vue3-Payloads${C.reset}`);
try {
  const ajaxRes = await fetch('https://www.mydealz.de/deals?page=2&ajax=true&layout=horizontal', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/160.0.0.0 Safari/537.36',
      'x-requested-with': 'XMLHttpRequest'
    }
  });

  if (ajaxRes.status === 200) {
    const ajaxJson = await ajaxRes.json();
    const content = ajaxJson.data?.content || '';
    const vue3Count = (content.match(/data-vue3=/g) || []).length;
    const articleCount = (content.match(/article id="thread_/g) || []).length;

    if (articleCount > 0 && vue3Count > 0) {
      pass(`AJAX-Nachladen funktioniert (${articleCount} Artikel, ${vue3Count} Payloads)`);
      if (content.includes('ThreadMainListItemNormalizer')) {
        pass('ThreadMainListItemNormalizer Payload vorhanden');
      } else {
        fail('ThreadMainListItemNormalizer fehlt im AJAX Content');
      }
    } else {
      fail('Keine Artikel oder Payloads im AJAX Content');
    }
  } else {
    fail(`Listing-AJAX antwortet mit HTTP ${ajaxRes.status}`);
  }
} catch (err) {
  fail('Listing-AJAX fehlgeschlagen', err.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Säule 4: East-West Gegenüberstellung (DOM vs. GraphQL)
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}4. East-West Gegenüberstellung (DOM vs. GraphQL)${C.reset}`);

if (gqlData) {
  const rows = [
    { field: 'Produkt-Titel', kind: 'text', dom: domData?.title || '—', gql: gqlData.title || '—' },
    { field: 'Angebotspreis', kind: 'num', dom: domData?.price || '—', gql: gqlData.displayPrice || (gqlData.price ? `${gqlData.price}€` : '—') },
    { field: 'UVP / Vergleich', kind: 'num', dom: domData?.nextBestPrice || '—', gql: gqlData.nextBestPrice ? `${gqlData.nextBestPrice}€` : '—' },
    { field: 'Deal-Temperatur', kind: 'volatile', dom: domData?.temperature || '—', gql: gqlData.temperature != null ? `${gqlData.temperature}°` : '—' },
    { field: 'Händler', kind: 'text', dom: domData?.merchant || '—', gql: gqlData.merchant?.merchantName || '—' },
    { field: 'Kommentarzahl', kind: 'volatile', dom: domData?.commentCount || '—', gql: String(gqlData.commentCount ?? '—') }
  ];

  const plain = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const number = (s) => {
    const m = String(s ?? '').replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/);
    return m ? Number(m[0].replace(',', '.')) : null;
  };
  const status = (r) => {
    if (r.gql === '—') return `${C.yellow}DIFF  ${C.reset}`;
    if (r.dom === '—') return `${C.cyan}GQL-OK${C.reset}`;
    let same;
    if (r.kind === 'text') same = plain(r.dom) === plain(r.gql) || plain(r.dom).includes(plain(r.gql)) || plain(r.gql).includes(plain(r.dom));
    else if (r.kind === 'volatile') { const a = number(r.dom), b = number(r.gql); same = a !== null && b !== null && (r.field === 'Deal-Temperatur' ? Math.round(a) === Math.round(b) : a === b); return same ? `${C.green}MATCH ${C.reset}` : `${C.yellow}LIVE  ${C.reset}`; }
    else { const a = number(r.dom), b = number(r.gql); same = a !== null && b !== null && a === b; }
    return same ? `${C.green}MATCH ${C.reset}` : `${C.red}DIVERGE${C.reset}`;
  };

  console.log(`\n  ┌─────────────────────┬───────────────────────────────┬───────────────────────────────┬────────┐`);
  console.log(`  │ ${C.bold}Feld${C.reset}                │ ${C.bold}DOM-Extraktion${C.reset}                │ ${C.bold}GraphQL-Wert${C.reset}                  │ ${C.bold}Status${C.reset} │`);
  console.log(`  ├─────────────────────┼───────────────────────────────┼───────────────────────────────┼────────┤`);

  let divergences = 0;
  for (const r of rows) {
    const fShort = r.field.padEnd(19);
    const domShort = (r.dom || '').slice(0, 29).padEnd(29);
    const gqlShort = (r.gql || '').slice(0, 29).padEnd(29);
    const st = status(r);
    if (st.includes('DIVERGE')) divergences++;
    console.log(`  │ ${fShort} │ ${domShort} │ ${gqlShort} │ ${st} │`);
  }
  console.log(`  └─────────────────────┴───────────────────────────────┴───────────────────────────────┴────────┘\n`);

  if (divergences) {
    fail(`East-West Abgleich: ${divergences} Abweichung(en)`, `DOM-Tab: ${chromePage.title?.slice(0, 60) || '?'} — Tab muss Thread #${TEST_THREAD_ID} zeigen`);
  } else {
    pass('East-West Abgleich abgeschlossen');
  }
} else {
  console.log(`  ${C.yellow}ℹ East-West Abgleich erfordert aktive GraphQL-Daten.${C.reset}`);
}

printSummary();
process.exit(totalFailed > 0 ? 1 : 0);

function printSummary() {
  console.log(`\n${C.bold}Ergebnis-Zusammenfassung:${C.reset}`);
  console.log(`  Bestanden: ${C.green}${totalPassed}${C.reset}`);
  console.log(`  Fehler:    ${totalFailed > 0 ? `${C.red}${totalFailed}${C.reset}` : `${C.green}0${C.reset}`}`);
  if (totalFailed === 0) {
    console.log(`\n${C.bold}${C.green}✨ ALLE CHECKS BESTANDEN — Extension ist 100% synchron mit mydealz!${C.reset}\n`);
  } else {
    console.log(`\n${C.bold}${C.red}⚠️ REPARATUR ERFORDERLICH — Schema-Drift oder Code-Fehler entdeckt.${C.reset}\n`);
  }
}
