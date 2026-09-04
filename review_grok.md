# review_grok.md

**Stand:** 2026-09-04 (Review-Gegenpruefung)  
**Autor:** Grok (xAI)  
**Repo:** `grapefruit89/MydealzExporter` (privat)  
**Branch:** `master` (Default; kein `main`)  
**Scope:** Ist-Zustand + zwei Use-Cases + Gegenpruefung eines externen Reviews  
**Nicht:** Code aendern in diesem Commit

Referenzen:

- [chrome.sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (Extensions: Chrome 138, Sampling 148)
- [Summarizer API](https://developer.chrome.com/docs/ai/summarizer-api)
- [Scale client-side summarization](https://developer.chrome.com/docs/ai/scale-summarization)
- Sample: [ai.gemini-on-device-summarization](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/ai.gemini-on-device-summarization)

---

## 1. Was das Repo wirklich ist

Keine Userscript-Variante von mydealz-Manager. Es ist eine **Chrome-MV3-Extension v16.2**:

```text
manifest.json          MV3, Popup + Content + Service Worker
content/content.js     Deal-Seite: GraphQL-Kommentar-Export + Button
content/listing.js     Listen/Suche: JSON-Export
background/            RAM-Transfer zum Dashboard-Tab
popup/                 API-Key-UI
ui/dashboard.*         Analyse + KI + Download
data_insights.md       GraphQL-Eigenheiten (threadId, repliesPreview)
```

Zwei Produkte in einer Extension:

1. Listen-Export (JSON)
2. Deal-Kommentarbaum + Dashboard + KI-Zusammenfassung

Der wertvolle Kern ist der GraphQL-Walker in `content.js`
(`threadId` + `mainCommentId`, Preview vs. Nachladen, Batch-30).
Das darf nicht fuer AI-Spielerei umgebaut werden.

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

Zusaetzlich gibt es `Summarizer.create()` extra fuer TL;DR.
Beides on-device, kein Key, kein `generativelanguage`-Host.

### UX-Bruch

Export oeffnet einen **vollen Tab**. Deal-Seite verschwindet aus dem Blick.
Genau dafuer existiert `chrome.sidePanel` seit Chrome 114.

Service Worker darf jederzeit einschlafen.
`pendingExport` im RAM ist dann weg — Dashboard zeigt
„Keine Daten. Bitte neu exportieren.“

---

## 3. Was von DIN-BriefNEO uebertragbar ist

Nicht die DIN-Architektur. Nur das Prinzip:

```text
HTML/CSS zuerst
JS nur fuer Dynamik und Daten
On-Device AI = Addon, Default aus
Cloud-API = Fallback, nicht Quelle der Wahrheit
Eine Source of Truth pro Fakt
```

Konkret nuetzlich:

| DIN-BriefNEO | Hier |
|---|---|
| Opt-in KI-Toggle, on-device | gleicher Schalter im Panel |
| Kein CDN-Modell | Prompt/Summarizer statt Cloud-first |
| Klare Fallback-Kette | On-Device → Cloud-Key → Hinweis |
| Wenig persistente UI-Wahrheiten | ein Storage-Key, nicht zwei |

Nicht uebernehmen: `din-*`-Tags, Law-Catalog, Foundation-Hierarchie.

---

## 4. Zielarchitektur — klein

```text
mydealz.de Tab
    │  content.js bleibt Scraper
    ▼
chrome.storage.session   (Export-Payload, ueberlebt SW-Schlaf)
    │
side panel (ui/panel.html)
    ├─ Export / Filter / Download   (ohne KI)
    ├─ Summarizer API               (On-Device TL;DR)
    ├─ Prompt API                   (Verdict, Fragen, Custom)
    └─ Cloud Gemini                 nur wenn availability !== available
```

Popup wird duenn: Status + Key + „Panel oeffnen“.
Oder Action-Klick oeffnet direkt das Panel.

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
Tab-Create fuer `ui/dashboard.html` kann als Fallback bleiben
(rechtsklick „in Tab oeffnen“), darf aber nicht der Default sein.

`web_accessible_resources` fuer das Dashboard wird dann weitgehend ueberfluessig.

---

## 6. On-Device AI — welche API wofuer

Nicht alles durch Prompt jagen. Chrome hat spezialisierte APIs.

| Aufgabe im Dashboard | API | Warum |
|---|---|
| 5–7 Saetze Deal+Kommentare | **Summarizer** `type: "tl;dr"` / `"teaser"` | dafuer gebaut, kuerzerer Pfad als Prompt |
| Stichpunkte Probleme | Summarizer `type: "key-points"` | dito |
| Stimmung / Verdict / Custom-Frage | **Prompt API** `LanguageModel` | braucht Instruktion |
| Witz-Threads entschärfen | heuristisch *vor* KI (`funny`-Score) | kein Modell noetig |

Verfuegbarkeit immer zuerst:

```js
const status = await LanguageModel.availability();
// 'available' | 'downloadable' | 'downloading' | 'unavailable'
```

Gleiches Muster fuer `Summarizer.availability()`.

Wenn `unavailable`: Cloud-Gemini, **ein** Key-Name.
Wenn kein Key: UI sagt klar „On-Device fehlt, Key fehlt“ — kein stiller Fetch-Fehler.

Hardware-Grenze ehrlich anzeigen (Desktop, RAM/VRAM, Modell unter
`chrome://on-device-internals`). Auf Android/iOS nicht so tun,
als wuerde Nano laufen.

Lange Threads: **summary-of-summaries**
([Chrome-Doku](https://developer.chrome.com/docs/ai/scale-summarization)).
On-Device-Kontext ist knapp. Nicht den ganzen Rohbaum in einen Call stopfen.
Zuerst Filter, dann Batches, dann eine Meta-Zusammenfassung.

---

## 7. Was ihr *nicht* bauen sollt

- Kein zweites Framework (React/Vite) nur fuer das Panel.  
  `ui/dashboard.html` kann Side-Panel-Dokument werden.
- Kein Ollama-Zwang. On-Device in Chrome *ist* Nano. Ollama ist ein dritter Stack.
- Kein Python in der Extension (siehe §12).
- Cloud-Host-Permission nicht loeschen, solange Fallback lebt — aber nicht mehr Default.
- Content-Script bleibt Scraper. Kein `LanguageModel` im Page-Kontext von mydealz.de.
  Modell nur im Extension-Dokument (Panel).
- Keine neuen Atome, kein Law-Catalog, kein DIN-Copy-Paste.

---

## 8. Bugs, die vor Features weg muessen

1. **Storage-Key splitten sich.**  
   Popup: `local.geminiApiKey` · Dashboard: `sync.apiKey`.  
   Ein Key, ein Area (`local` reicht).

2. **Export nur im SW-RAM.**  
   Nach Idle ist das Dashboard leer. → `chrome.storage.session`.

3. **Legacy `window.ai` zuerst.**  
   Auf aktuellen Chrome 148+ laeuft der On-Device-Pfad oft gar nicht,
   obwohl Nano da ist. Dann faellt alles auf den kaputten Cloud-Key.

Diese drei Punkte erklaeren „KI geht nicht“ besser als fehlendes Side Panel.

---

## 9. Mini-Reihenfolge

1. Storage-Key + Session-Payload (ohne UI-Umbau)
2. `LanguageModel` / `Summarizer` statt `window.ai`, mit Availability-UI
3. Manifest `sidePanel` + Action oeffnet Panel statt nur Popup
4. Dashboard im Panel betreiben, Tab als Fallback
5. Cloud-Gemini zurueckstufen auf Fallback
6. UC2: volle Deal-Beschreibung in denselben Payload wie die Kommentare
7. Deterministischer Kommentar-Filter vor jedem Modell-Call
8. MD-Export neben JSON

Schritt 1–2 machen die vorhandene KI ueberhaupt wahr.
Schritt 3–4 sind die eigentliche „aehnliche Funktion“ zum Chrome-Sample.

---

## 10. Urteil

Die Extension ist klein und der Scraper ist der eigentliche Moat.
Side Panel + On-Device AI passen *genau* dazu — aber erst nachdem
der Key und der RAM-Transfer nicht mehr die KI verschlucken.

Nicht DIN-BriefNEO nachbauen. Panel neben den Deal legen,
Zusammenfassung on-device, Cloud nur als Netz.

---

## 11. Eingefrorene Use-Cases

Genau zwei. Kein dritter.

```text
Seite
  ├─ Uebersicht  →  Use-Case 1  →  JSON (optional MD)
  └─ Deal       →  Use-Case 2  →  Filter  →  JSON | MD  →  On-Device KI
```

### Use-Case 1 — Uebersichtsseite

**Soll:** alle sichtbaren Deals einschliesslich der ausfuehrlichen Beschreibung.

**Ist:** `content/listing.js` macht das bereits. Ein GraphQL-Batch ueber Aliase,
Felder inkl. `description` (HTML + Plaintext), Preis, Haendler, Temperatur,
Bild, Share-Link. Download als JSON.

Luecke: kein Markdown auf der Liste. Wenn MD gewuenscht ist, nachziehen —
nicht die GraphQL-Seite anfassen.

KI gehoert hier nicht zwingend drauf. Eine Liste von Deal-Texten ist ein
Export, kein Kommentarproblem.

### Use-Case 2 — Deal-Seite

**Soll:** Beschreibung mit allem Drum und Dran **plus** alle Kommentare.

**Ist:** `content/content.js` holt den Kommentarbaum sauber
(`threadId` + Replies).  
**Luecke:** `extractMetadata()` hat nur Titel, Preis, Haendler, URL.
Die volle Deal-Beschreibung fehlt auf der Deal-Seite — genau das Feld,
das UC1 schon kann. Dieselbe Thread-Query hierher legen.

Danach die Kette:

1. **Muell raus** — deterministisch, vor jedem Modell.  
   Weg: geloescht, sehr kurz, 0 Reaktionen + 0 Replies, hoher `funny`
   bei wenig `helpful`.  
   Behalten: Text, `helpful`, Replies, Laenge.  
   Das steht in `data_insights.md` schon richtig. Kein Gemini dafuer.
2. **Export** — JSON (Maschinen) und MD (lesen/teilen).
3. **Lokale Modelle** — Chrome built-in, kein AI-Studio-Key als Default.

| Job | API | Nicht |
|---|---|
| 5–7 Saetze / Stichpunkte | **Summarizer** (`tl;dr`, `key-points`, `teaser`) | nicht Prompt |
| Lohnt sich’s / Custom-Frage | **Prompt API** (`LanguageModel`) | nicht Summarizer |
| Witz-Threads | Heuristik | kein Modell |

Cloud-Gemini nur wenn `availability !== available`.

Side Panel ist nur die Huelle fuer UC2 (Deal bleibt sichtbar).
Der Scraper bleibt der Kern.

---

## 12. Stack-Grenze: HTML/CSS first, kein Python

### Python in der Extension?

**Nein.** Eine Chrome-Extension ist HTML + CSS + JavaScript
(MV3: Service Worker, Content Script, Side Panel).
Der Browser fuehrt kein Python aus.

Python ginge nur als Extra-Prozess daneben (Native Messaging oder
lokaler Server). Dann zweite Runtime, Installationshuerde, kein
On-Device-Gemini-Nano im Panel, mehr Angriffsflaeche.

Fuer mydealz + Summarizer ist das der falsche Stack. Python bleibt dort,
wo schon Pipelines existieren — nicht hier.

### Wenig JS, natives HTML/CSS

Ja, **aber nur in der UI**. Der Scraper bleibt JS.
GraphQL, CSRF, Pagination, Batch-Replies kann CSS nicht.

| Teil | Stack |
|---|---|
| `listing.js` / `content.js` | JS, unvermeidbar |
| Side Panel / Dashboard | HTML + CSS first |
| Sichtbarkeit, Tabs, Filter-Chips | `:has()`, Radios, `<dialog>`, `popover` |
| Download JSON/MD | ein paar Zeilen JS |
| Summarizer / Prompt | wenig JS, nur API-Aufruf |

Inline-`style` an den Floating-Buttons kann spaeter in eine injizierte
CSS-Datei. Kosmetik.

---

## 13. Die Chrome-Links — Zuordnung

Was verlinkt wurde, ist Use-Case 2, Schritt 3:

1. **`chrome.sidePanel`** — Panel neben dem Deal, kein neuer Tab.
2. **Summarizer API (on-device, Gemini Nano)** — Client-side Summarization.
   Text bleibt auf dem Geraet, kein Key, kein `generativelanguage`.
   Das *ist* das gewuenschte „Client side summarize“.
3. **Prompt API** — nur fuer Verdict / freie Frage, nicht fuers Standard-TL;DR.

Das Google-Sample *On-device Summarization with Gemini Nano* macht genau
das Muster: Side Panel + lokalen Summarizer. Hier kommt vorher noch der
Kommentar-Filter, dann geht der **gefilterte** Text in `Summarizer.create()`,
nicht der Roh-Muell.

```text
Deal-Seite
  → JS: Beschreibung + Kommentare holen
  → JS: Muell weg (funny / geloescht / leer)
  → HTML-Panel: JSON | MD Export
  → Summarizer API: 5–7 Saetze / key-points
  → Prompt API: nur wenn gefragt wird „lohnt sich’s?“
```

Was nicht gebraucht wird:

- dritter Use-Case
- KI auf der Uebersichtsseite
- Foundation / DIN-Copy
- React nur fuers Panel
- Python-Runtime in der Extension

---

## 14. Gegenpruefung: externes Review (v16.2)

Quelle: angehaengtes Review „MyDealz AI Exporter (Chrome Extension v16.2)“.
Kurz: **Architektur-Lob stimmt. Prioritaeten und Fakten stimmen teilweise nicht.**
Das Review beschreibt eine brauchbare Extension — es verfehlt aber die
drei Bugs, die die KI heute still sterben lassen, und den Zielpfad
Side Panel + Summarizer.

### Was das Review richtig sieht

| Punkt | Urteil |
|---|---|
| Trennung content / background / ui / popup | korrekt |
| GraphQL-Alias-Batch auf Listing-Seiten | korrekt, das ist der clevere Kern von UC1 |
| Reply-Batches + Pause gegen Rate-Limit | korrekt |
| CSRF aus Meta/Cookie | korrekt |
| SPA via MutationObserver | korrekt |
| Score-Formel nachvollziehbar | korrekt |
| Host-Permissions eng | korrekt |
| kein `eval()` | korrekt |
| Permissions im Wesentlichen minimal | korrekt |

Das darf stehen bleiben.

### Was das Review falsch oder zu laut sagt

**Zeilenzahlen.**  
„`content.js` ~120 Zeilen, `listing.js` ~104 Zeilen“ ist falsch.
`listing.js` allein liegt deutlich darueber (kompletter Batch-Exporter).
Das Review hat die Dateien nicht vollstaendig gemessen.

**TypeScript als Baustelle.**  
Nein. Fuer diese Groesse ist Vanilla JS die richtige Entscheidung.
Typen nachruesten waere Kosmetik, kein Sicherheits- oder Produktgewinn.
Nicht in die Bau-Reihenfolge aufnehmen.

**Automatische Tests als Luecke.**  
Wuenschenswert fuer `score()` / Filter spaeter. Nicht blocker.
Eine Extension gegen fremdes DOM + GraphQL ist ohne Fixture-Corpus
teuer zu testen. Erst Filter-Funktion isolieren, dann testen.

**z-index 2147483647.**  
Stimmt, ist laut. Aendert nichts an Funktion oder Sicherheit.
Prio: niedrig. CSS-Datei statt Inline-Style ist der saubere Fix.

**Retry/Backoff bei 403/429.**  
Sinnvoll als Haertung, nicht als erstes. Erst Payload und Storage,
dann Resilienz. Der Nutzer sieht den Fehler schon — er verliert ihn
nicht still.

**„Vor Produktivsetzung innerHTML ersetzen.“**  
Richtig als Hygiene, falsch als Hauptrisiko.
`innerHTML` im *Extension-Dashboard* mit mydealz-HTML ist ein
echtes XSS-Thema (Kommentare koennen Markup enthalten).
Fix: `textContent` fuer Titel/Plaintext, fuer HTML einen Sanitizer
oder gar kein HTML rendern (MD/Plain reicht fuer den Use-Case).
DOMPurify als neue Dependency nur wenn HTML-Vorschau wirklich noetig ist.
Nicht das erste Ticket.

**CSP / `web_accessible_resources`.**  
MV3 hat bereits eine strikte Default-CSP. Der Satz „`web_accessible_resources`
auf `""` ist potenziell unsicher“ ist zu pauschal. Relevant wird das,
wenn das Dashboard noch als Tab aus dem Content-Script geoeffnet wird.
Mit Side Panel faellt ein Grossteil dieser Flaeche weg.
Nachziehen, nicht als Verfassungsbruch behandeln.

**Gemini-URL hardcoded.**  
Unkritisch. Host-Permission muss konkret sein. Der fehlende Hinweis
steht im Popup — das Review hat das selbst notiert.

### Was das Review komplett auslaesst (das sind die echten Bloecke)

1. Storage-Key-Mismatch `local.geminiApiKey` vs. `sync.apiKey`
2. Export nur im Service-Worker-RAM (`pendingExport`)
3. Legacy `window.ai` statt `LanguageModel` / `Summarizer`
4. Dashboard als neuer Tab statt `chrome.sidePanel`
5. UC2 ohne volle Deal-Beschreibung (`extractMetadata`)
6. Kein deterministischer Kommentar-Filter vor der KI
7. Kein MD-Export neben JSON
8. Cloud-Gemini als Default statt On-Device-Fallback

Ohne 1–3 bleibt „KI integriert“ eine Behauptung.
Ohne 4–5 bleibt der zweite Use-Case unvollstaendig.
Ohne 6 frisst das Modell Witz-Threads.

### Einschaetzung in einem Satz

Das externe Review ist ein solides **Code-Quality-Review einer fertigen v16.2**.
Es ist kein **Produkt- und Zielarchitektur-Review** fuer die zwei Use-Cases.
Deshalb nicht als Bau-Backlog uebernehmen. Die Reihenfolge bleibt §9.

| Review-Empfehlung | Uebernehmen? |
|---|---|
| innerHTML → textContent / Sanitizer | spaeter ja, nicht zuerst |
| Retry/Backoff GraphQL | spaeter ja |
| z-index senken / CSS statt inline | ja, nebenbei |
| TypeScript | nein |
| Test-Harness fuer score/filter | ja, sobald Filter isoliert ist |
| WAR/CSP nachschaerfen | ja, mit Side-Panel-Schnitt |
| Side Panel + Summarizer + Session-Storage | **ja, das fehlte** |

---

## 15. Verbindlicher Satz

```text
Zwei Use-Cases.
UC1 = Listen-JSON inkl. Beschreibung (ist weitgehend da).
UC2 = Deal-Beschreibung + Kommentare → Filter → JSON|MD → Summarizer.
JS nur fuer Daten und Modell-Call.
Kein Python in der Extension.
Kein neues Atom, kein Framework.
Storage und Session-Payload vor jeder neuen KI-Flaeche.
```
