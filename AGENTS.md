---
status: active
type: instructions
tags: [mydealzexporter, chrome-extension, mv3, agents]
summary: "Verhaltensvertrag: MV3-Vanilla-Invarianten, Zero-Polyfill-Chromium-Baseline, Service-Worker-Regeln, Test- und Sicherheitsgates."
---

# MyDealz AI Exporter — Agenten-Vertrag

> 🚨 **Vor jeder Aufgabe:** diese Datei und [`map.md`](map.md) lesen, dann über die
> Task-to-File-Matrix die Zieldatei direkt ansteuern. Kein `grep -r`, kein Ratesuchen.

## 1. Harte Invarianten (nicht verhandelbar)

1. **Vanilla MV3, Zero-Build:** Nur `manifest.json` + handgeschriebenes HTML/CSS/JS.
   **Verboten:** Vite, Plasmo, Webpack, Babel, TypeScript, React/Vue/Svelte, `npm`-Pakete im
   Extension-Bundle, jedes neue Scaffold. Bestehender Code wird nicht „modernisiert".
   **Layout:** drei Ordner — `content/` (Scraper), `ui/` (Cockpit, Popup, Icons), `tools/` (Gates); `manifest.json` + `service-worker.js` in der Wurzel.
2. **Baseline Chromium 150+, Zero-Polyfill:** Native APIs genügen (`structuredClone`,
   `Promise.withResolvers`, `chrome.storage.session`, `Array.prototype.at`, `Set`-Methoden).
   Kein Transpiler, kein Polyfill, kein Legacy-Fallback.
3. **Service Worker, keine Background-Page:** `service-worker.js` (Wurzel) ist flüchtig.
   Zustand nur via `chrome.storage.session` (Payload) / `chrome.storage.local` (API-Key).
   Kein Verlass auf Modul-Globals über Events hinweg.
4. **Rollen strikt getrennt:** Content-Scripts scrapen und fetchen (`content/`). UI und alle
   KI-Aufrufe leben im Extension-Dokument (`ui/dashboard.js`, `ui/popup.html`), nie im Content-Script.
   Das In-Page-Dashboard ist ein `<dialog>` mit `iframe` auf `ui/dashboard.html`; der
   Content-Script-Teil besitzt nur Rahmen, Backdrop und Schließen-Logik.
5. **Eine Fetch-Route:** Jeder mydealz-Request läuft über `fetchWithRetry` im
   `shared-bootstrap`-Block (`content/content.js` + `content/listing.js`, byte-identisch).
   Kein zweiter Retry-/Backoff-Mechanismus daneben.
6. **Datenquellen statt CSS-Klassen:** GraphQL `/graphql`, `data-vue3`-Payloads, `data-t`-Hooks.
   Styling-Klassen sind kein Vertrag und taugen nicht als Selektor.
7. **Keine neuen Hosts oder Permissions** ohne ausdrückliches Go; `manifest.json` ist die Liste.
8. **Zwei Use-Cases, eingefroren:** Listing-Export (UC1) und Deal-/Kommentar-Export (UC2).
   Neue Produktflächen nur nach Auftrag, siehe `review_grok.md` §11.
9. **Tiefe Module, 15–40 KiB [anchor:deep-modules]:** Jede Content-/UI-JS-Datei liegt zwischen
   15 und 40 KiB (≈300–800 Zeilen). Kleinere Shallow Modules kosten Tool-Call-Zersplitterung,
   größere den Kontext-Hop. Zero-Build erlaubt keine Imports — gemeinsame Helfer stehen als
   byte-identischer `shared-bootstrap`-Block in `content.js` und `listing.js`, nie in einer
   Mini-Datei. Gate: `tools/repo-map-check.mjs`. Vorbild: John Ousterhout, *A Philosophy of
   Software Design*: tiefe Module, schmale Schnittstelle, viel Verhalten dahinter.

## 2. Sicherheits- und Rate-Limit-Gates

1. **Niemals eigenmächtig exportieren:** Kein Export, kein Button-Klick und keine GraphQL-Serie
   auf einem **eingeloggten** Konto ohne vorherige Rückfrage beim Nutzer. Auch nicht „nur zum Test".
2. **ToS-Disziplin:** 300–700 ms Pausen, max. 2 AJAX-Extraseiten, keine Cron-Loops,
   Export ausschließlich auf Nutzerklick. Keine Massen-Export-Features.
3. **Secrets:** Gemini-Key nur `chrome.storage.local`; nie in Logs, Dumps, Commits oder Chat.
4. **Keine Aktion auf fremden Sessions/Tabs** des Nutzers (kein Tab schließen/öffnen zum Testen).

## 3. Test, Lint, Verifikation

```bash
for f in content/*.js service-worker.js ui/*.js; do node --check "$f" || exit 1; done
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
node tools/repo-map-check.mjs          # Budget + 15–40 KiB + shared-bootstrap
npx --yes web-ext lint --source-dir .  # nur wenn web-ext verfügbar/gewollt
```

Manuell: `chrome://extensions` → Karte „Neu laden" → mydealz.de-Tab neu laden → Konsole fehlerfrei.
Kein `npm run dev`, kein Testframework — es gibt keins und es wird keins eingeführt.

## 4. Definition of Done

1. `node --check` grün, `manifest.json` valides JSON, Modul-Gate grün.
2. Bei Verhaltensänderung: `version` in `manifest.json` erhöhen (aktuell `17.5`).
3. Nur die von der Aufgabe genannten Dateien geändert; Doku-Aufträge fassen **keinen** Quellcode an.
4. Doku-Fakten (GraphQL-Eigenheiten) gehören nach `data_insights.md`, nicht in den Chat.
