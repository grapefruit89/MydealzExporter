# review_grok.md

**Stand:** 2026-09-04  
**Autor:** Grok (xAI)  
**Repo:** `grapefruit89/MydealzExporter` (privat)  
**Branch:** `master` (Default; kein `main`)  
**Scope:** Ist-Zustand der Extension + sinnvolle Übernahme von DIN-BriefNEO-Ideen  
**Nicht:** Code ändern, kein Refactor in diesem Commit

Referenzen:

- [chrome.sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (Extensions: Chrome 138, Sampling 148)
- [Summarizer API](https://developer.chrome.com/docs/ai/summarizer-api)
- Sample: [ai.gemini-on-device-summarization](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/ai.gemini-on-device-summarization)

---

## 1. Was das Repo wirklich ist

Keine Userscript-Variante von mydealz-Manager. Es ist eine **Chrome-MV3-Extension v16.2**:

```text
manifest.json          MV3, Popup + Content + Service Worker
content/content.js     Deal-Seite: GraphQL-Kommentar-Export + Button
content/listing.js     Listen/Suche: JSON-Export
background/            664 Byte RAM-Transfer zum Dashboard-Tab
popup/                 API-Key-UI
ui/dashboard.*         Analyse + KI + Download
data_insights.md       GraphQL-Eigenheiten (threadId, repliesPreview)
```

Zwei Produkte in einer Extension:

1. Listen-Export (JSON)
2. Deal-Kommentarbaum + Dashboard + KI-Zusammenfassung

Der wertvolle Kern ist der GraphQL-Walker in `content.js`
(`threadId` + `mainCommentId`, Preview vs. Nachladen, Batch-30).
Das darf nicht für AI-Spielerei umgebaut werden.

---

## 2. Ist-Zustand — hart

| Thema | Stand |
|---|---|
| Manifest V3 | ja |
| `sidePanel` | **fehlt** |
| On-Device Prompt API (`LanguageModel`) | **halb, alte API** |
| Summarizer API | fehlt |
| Cloud-Gemini | ja, `gemini-1.5-flash` + Host-Permission |
| Dashboard | neuer Tab, nicht Side Panel |
| Export-Payload | nur im Service-Worker-RAM, einmal lesbar |
| README | fehlt |

### KI-Pfad heute (`ui/dashboard.js` → `callAI`)

```text
1. window.ai.languageModel || window.ai.assistant   ← Legacy-Prompt-API
2. sonst chrome.storage.sync.apiKey
3. sonst fetch generativelanguage.googleapis.com
```

Popup speichert den Key unter **`chrome.storage.local.geminiApiKey`**.  
Dashboard liest **`chrome.storage.sync.apiKey`**.  
Das sind zwei verschiedene Speicher. Cloud-Fallback ist damit leicht tot,
selbst wenn der Key im Popup sitzt.

`window.ai.*` ist der alte Shape. Stabil in Extensions ist 2026:

```js
await LanguageModel.availability()
const session = await LanguageModel.create({ ... })
await session.prompt(text)
```

Zusätzlich gibt es `Summarizer.create()` extra für TL;DR.
Beides on-device, kein Key, kein `generativelanguage`-Host.

### UX-Bruch

Export öffnet einen **vollen Tab**. Deal-Seite verschwindet aus dem Blick.
Genau dafür existiert `chrome.sidePanel` seit Chrome 114.

Service Worker darf jederzeit einschlafen.
`pendingExport` im RAM ist dann weg — Dashboard zeigt
„Keine Daten. Bitte neu exportieren.“

---

## 3. Was von DIN-BriefNEO übertragbar ist

Nicht die DIN-Architektur. Nur das Prinzip:

```text
HTML/CSS zuerst
JS nur für Dynamik und Daten
On-Device AI = Addon, Default aus
Cloud-API = Fallback, nicht Quelle der Wahrheit
Eine Source of Truth pro Fakt
```

Konkret nützlich:

| DIN-BriefNEO | Hier |
|---|---|
| Opt-in KI-Toggle, on-device | gleicher Schalter im Panel |
| Kein CDN-Modell | Prompt/Summarizer statt Cloud-first |
| Klare Fallback-Kette | On-Device → Cloud-Key → Hinweis |
| Wenig persistente UI-Wahrheiten | ein Storage-Key, nicht zwei |

Nicht übernehmen: `din-*`-Tags, Law-Catalog, Foundation-Hierarchie.

---

## 4. Zielarchitektur — klein

```text
mydealz.de Tab
    │  content.js bleibt Scraper
    ▼
chrome.storage.session   (Export-Payload, überlebt SW-Schlaf)
    │
side panel (ui/panel.html)
    ├─ Export / Filter / Download   (ohne KI)
    ├─ Summarizer API               (On-Device TL;DR)
    ├─ Prompt API                   (Verdict, Fragen, Custom)
    └─ Cloud Gemini                 nur wenn availability !== available
```

Popup wird dünn: Status + Key + „Panel öffnen“.
Oder Action-Klick öffnet direkt das Panel.

---

## 5. Side Panel — konkreter Schnitt

Manifest:

```json
{
  "permissions": ["storage", "tabs", "sidePanel", "clipboardWrite", "downloads"],
  "side_panel": {
    "default_path": "ui/dashboard.html"
  }
}
```

Service Worker:

```js
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'OPEN_DASHBOARD') {
    chrome.storage.session.set({ pendingExport: msg.payload });
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id });
    }
  }
});
```

Dashboard liest `chrome.storage.session` statt einmaligem RAM-Ping.
Tab-Create für `ui/dashboard.html` kann als Fallback bleiben
(rechtsklick „in Tab öffnen“), darf aber nicht der Default sein.

`web_accessible_resources` für das Dashboard wird dann weitgehend überflüssig.

---

## 6. On-Device AI — welche API wofür

Nicht alles durch Prompt jagen. Chrome hat spezialisierte APIs.

| Aufgabe im Dashboard | API | Warum |
|---|---|---|
| 5–7 Sätze Deal+Kommentare | **Summarizer** `type: "tl;dr"` / `"teaser"` | dafür gebaut, kürzerer Pfad als Prompt |
| Stichpunkte Probleme | Summarizer `type: "key-points"` | dito |
| Stimmung / Verdict / Custom-Frage | **Prompt API** `LanguageModel` | braucht Instruktion |
| Witz-Threads entschärfen | heuristisch *vor* KI (`funny`-Score) | kein Modell nötig |

Verfügbarkeit immer zuerst:

```js
const status = await LanguageModel.availability();
// 'available' | 'downloadable' | 'downloading' | 'unavailable'
```

Gleiches Muster für `Summarizer.availability()`.

Wenn `unavailable`: Cloud-Gemini, **ein** Key-Name.
Wenn kein Key: UI sagt klar „On-Device fehlt, Key fehlt“ — kein stiller Fetch-Fehler.

Hardware-Grenze ehrlich anzeigen (Desktop, RAM/VRAM, Modell unter
`chrome://on-device-internals`). Auf Android/iOS nicht so tun,
als würde Nano laufen.

Map-Reduce bei >250 Kommentaren bleibt sinnvoll.
On-Device-Kontext ist knapp (~20k Zeichen habt ihr schon als Limit).
Batches weiter klein halten.

---

## 7. Was ihr *nicht* bauen sollt

- Kein zweites Framework (React/Vite) nur für das Panel.  
  `ui/dashboard.html` kann Side-Panel-Dokument werden.
- Kein Ollama-Zwang. On-Device in Chrome *ist* Nano. Ollama ist ein dritter Stack.
- Cloud-Host-Permission nicht löschen, solange Fallback lebt — aber nicht mehr Default.
- Content-Script bleibt Scraper. Kein `LanguageModel` im Page-Kontext von mydealz.de.
  Modell nur im Extension-Dokument (Panel).
- Keine neuen Atome, kein Law-Catalog, kein DIN-Copy-Paste.

---

## 8. Bugs, die vor Features weg müssen

1. **Storage-Key splitten sich.**  
   Popup: `local.geminiApiKey` · Dashboard: `sync.apiKey`.  
   Ein Key, ein Area (`local` reicht).

2. **Export nur im SW-RAM.**  
   Nach Idle ist das Dashboard leer. → `chrome.storage.session`.

3. **Legacy `window.ai` zuerst.**  
   Auf aktuellen Chrome 148+ läuft der On-Device-Pfad oft gar nicht,
   obwohl Nano da ist. Dann fällt alles auf den kaputten Cloud-Key.

Diese drei Punkte erklären „KI geht nicht“ besser als fehlendes Side Panel.

---

## 9. Mini-Reihenfolge

1. Storage-Key + Session-Payload (ohne UI-Umbau)
2. `LanguageModel` / `Summarizer` statt `window.ai`, mit Availability-UI
3. Manifest `sidePanel` + Action öffnet Panel statt nur Popup
4. Dashboard im Panel betreiben, Tab als Fallback
5. Cloud-Gemini zurückstufen auf Fallback

Schritt 1–2 machen die vorhandene KI überhaupt wahr.
Schritt 3–4 sind die eigentliche „ähnliche Funktion“ zum Chrome-Sample
und zu dem, was bei DIN-BriefNEO das Addon sein wollte: lokal, opt-in, ohne Tab-Bruch.

---

## 10. Urteil

Die Extension ist klein und der Scraper ist der eigentliche Moat.
Side Panel + On-Device AI passen *genau* dazu — aber erst nachdem
der Key und der RAM-Transfer nicht mehr die KI verschlucken.

Nicht DIN-BriefNEO nachbauen. Panel neben den Deal legen,
Zusammenfassung on-device, Cloud nur als Netz.
