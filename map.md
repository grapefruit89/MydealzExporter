---
status: active
type: index
tags: [mydealzexporter, map, task-matrix, navigation]
summary: "Kanonische LLM-Map: Inventar, Task-to-File-Matrix und Live-Fakten für MyDealzExporter."
---

# MyDealzExporter — LLM-Map & Navigationsmatrix

> 🧭 **Für Agenten:** Zuerst [`AGENTS.md`](AGENTS.md) (Verhalten, Gates), dann hier die Zieldatei — ohne Suchbefehl.
> 📁 **Layout:** genau drei Ordner — `content/` (Scraper), `ui/` (Cockpit, Popup, Icons),
> `tools/` (Gates). Wurzel: `manifest.json`, `service-worker.js`, Doku.

## 1. Verzeichnis-Inventar

| Pfad | Zweck |
| :--- | :--- |
| [`manifest.json`](manifest.json) | MV3-Manifest: Permissions, Content-Script-Matches, SW, Popup, Icons |
| [`service-worker.js`](service-worker.js) | Einziger SW (Wurzel): Export-Payload (`STORE_EXPORT`) in `chrome.storage.session`; kein Tab-Open (25 Z.) |
| [`content/content.js`](content/content.js) | UC2: Kommentar-Walker (`isReply`/`parentId`/`level`), Autor*in-Updates, Widget; `shared-bootstrap` (Links, `fetchWithRetry`) |
| [`content/listing.js`](content/listing.js) | UC1: Listing-Widget, GQL-Chunking (30er), AJAX-+2-Seiten, Markdown; derselbe `shared-bootstrap`-Block |
| [`ui/popup.html`](ui/popup.html) | Popup: Gemini-API-Key setzen; Script `dashboard.js` (`initPopupSettings`), kein `popup.js` |
| [`ui/dashboard.html`](ui/dashboard.html) · [`ui/dashboard.js`](ui/dashboard.js) | Cockpit: Header, Deal-Scan, KI-Panel, 2×2-Export — einspaltig, max. 820 px, im In-Page-`<dialog>` (iframe) |
| [`ui/icon16.png`](ui/icon16.png) · [`icon48`](ui/icon48.png) · [`icon128`](ui/icon128.png) | Icon-Satz 16/48/128 px (Manifest, Action, Cockpit-Header) |
| [`data_insights.md`](data_insights.md) | GraphQL-Eigenheiten, Feld-Belege, Community-Techniken |
| [`review_grok.md`](review_grok.md) | Zielarchitektur, eingefrorene Use-Cases, externes Review |
| [`methodik.md`](methodik.md) | Übertragbare Scraping-Methodik |
| [`AI-AGENTS-CLI.md`](AI-AGENTS-CLI.md) | Entwickler-Workflow: Extension laden, DevTools-MCP, Systemprompt |
| [`README.md`](README.md) | Menscheneinstieg: Features, Architektur, Datenschutz, ToS |
| [`tools/repo-map-check.mjs`](tools/repo-map-check.mjs) | Budget-Gate Cockpit (AGENTS ≤ 70, map ≤ 100 Z., Module 15–40 KiB, Bootstrap) |
| [`tools/health-check.mjs`](tools/health-check.mjs) | Health-Check: Code-/Manifest-Gates, Script-Auflösung, GraphQL-/DOM-Drift (`--offline`) |
| [`tools/deal-schema-map.json`](tools/deal-schema-map.json) | Soll-Feldliste (16 Felder) für Drift-Checks |
| [`tools/EAST-WEST-MAP.md`](tools/EAST-WEST-MAP.md) | Schema-Matrix DOM vs. GraphQL (Feldzuordnung, Drift) |

## 2. Task-to-File-Matrix (1-Zeilen-Disziplin)

| Aufgabe / Symptom | Zuerst lesen | Nur falls nötig |
| :--- | :--- | :--- |
| **Listing-Export (Felder, JSON/MD, +2 Seiten)** | `content/listing.js` | `shared-bootstrap`-Block (identisch) |
| **Kommentar-Export, Pagination, Replies, hidden** | `content/content.js` | `data_insights.md` §1 |
| **429/Backoff/`Retry-After`/HTML statt JSON** | `shared-bootstrap` in `content/content.js` | `content/listing.js` (identischer Block) |
| **`/visit/`-Redirect, Link-Dedupe, `links[]`** | `shared-bootstrap` in `content/content.js` | — |
| **Autor*in-Badge, Ersteller-Updates, User-Index** | `content/content.js` (`annotateAuthors`) | `ui/dashboard.js` (`buildMarkdown`, `buildAIContext`) |
| **Cockpit-Rendering: Header, Deal-Scan, Export** | `ui/dashboard.js` (`renderMeta`, `renderStats`, `setupExport`) | `ui/dashboard.html` |
| **Cockpit-Layout, CSS-Variablen, einspaltiges Grid** | `ui/dashboard.html` | — |
| **KI-Prompts, Map-Reduce, On-Device/Cloud-Fallback** | `ui/dashboard.js` (`PROMPTS`, `setupAI`, `runMapReduce`) | `review_grok.md` §6 |
| **JSON/Markdown/Clipboard-Export** | `ui/dashboard.js` (`setupExport`, `buildMarkdown`) | — |
| **API-Key-Eingabe, Popup-UI** | `ui/popup.html` + `ui/dashboard.js` (`initPopupSettings`) | `ui/dashboard.js` (`callAI`-Key-Lookup) |
| **Payload-Übergabe Content → Cockpit** | `service-worker.js` | `manifest.json` (`web_accessible_resources`) |
| **Neue Seite/Route erlauben (Matches, Hosts)** | `manifest.json` | `AGENTS.md` §1.7 |
| **Widget-Position, In-Page-Modal (Dialog + iframe), Buttons** | `content/content.js` (`injectButton`, `openDashboardModal`) | `ui/dashboard.html` |
| **Antworten ausklappen (ausschließlich auf Klick)** | `content/content.js` (`expandAllReplies`, `#mde-expand-btn`) | — |
| **GraphQL-Schema-Frage, Feld fehlt** | `data_insights.md` | `review_grok.md` §1–2 |
| **Neues Feature bewerten / Scope-Grenze** | `review_grok.md` §7, §11 | `methodik.md` |
| **Extension laden, DevTools-MCP, Systemprompt** | `AI-AGENTS-CLI.md` | `README.md` §Installation |
| **Ordner-Layout, neue Datei einsortieren** | `AGENTS.md` §1.1 | `tools/repo-map-check.mjs` |
| **Cockpit-Budget verletzt** | `AGENTS.md`, `map.md` kürzen | `tools/repo-map-check.mjs` |

## 3. Live-Fakten & Invarianten (Single Source of Truth)

| Schlüssel | Wert |
| :--- | :--- |
| **Stack** | Manifest V3, Vanilla JS, kein Build, kein Framework (Chromium 150+) |
| **Version** | `17.7` in `manifest.json` — bei Verhaltensänderung erhöhen |
| **Permissions** | `storage`, `tabs`, `clipboardWrite`, `downloads` |
| **Hosts** | `https://www.mydealz.de/*`, `https://generativelanguage.googleapis.com/*` |
| **Ordner** | `content/` · `ui/` · `tools/` — sonst nichts (Wurzel nur Manifest, SW, Doku) |
| **Content-Script-Form** | Ein Bundle je Seitentyp (`content/content.js` Deal, `content/listing.js` Listing) inkl. `shared-bootstrap` |
| **Modulgröße** | 15–40 KiB je Content-/UI-JS, `[anchor:deep-modules]` (Ousterhout); Gate `repo-map-check` |
| **Autor*in-Quelle** | `isAuthor` = `userId`-Match → Username-Match → DOM-Badge `Autor*in` (kein GQL-Feld) |
| **Payload-Transport** | `STORE_EXPORT` → `chrome.storage.session.pendingExport` → iframe liest via `GET_EXPORT_DATA` |
| **KI-Kette** | On-Device (`LanguageModel`/`Summarizer`) → Gemini-Key → klarer Fehler |
| **Cockpit-Sektionen** | Header · Deal-Scan (7 Kennzahlen) · KI-Panel (6 Prompts + Freitext) · Export 2×2 |
| **Bewusst entfernt** | Kommentar-Browser: Tabs, Sortierung, Suche, Link-/Autor-Listen, 2-Spalten-Split |
| **Budget-Gate** | `node tools/repo-map-check.mjs` (AGENTS 70 / map 100 Z., 15–40 KiB, Bootstrap) |
| **Doku-Regel** | GraphQL-/Feld-Erkenntnisse nach `data_insights.md`, nie nur in den Chat |
| **Doku-Frontmatter** | Jede `*.md` trägt `status`, `type`, `tags`, `summary` (Blueprint 02, 4 Felder) |
