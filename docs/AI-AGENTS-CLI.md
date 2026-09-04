# Icons, AI-Agents und CLI — Anleitung fuer MydealzExporter

Stand: 2026-09-04  
Repo: Vanilla-MV3-Extension. Kein Plasmo, kein Vite-Plugin, kein neues Scaffold.

Quellen:

- [Configure extension icons](https://developer.chrome.com/docs/extensions/develop/ui/configure-icons)
- [Manifest icons](https://developer.chrome.com/docs/extensions/reference/manifest/icons)
- [Chrome DevTools for agents](https://developer.chrome.com/docs/devtools/agents)
- [Get started](https://developer.chrome.com/docs/devtools/agents/get-started)
- [Extension Booster Artikel](https://extensionbooster.net/blog/build-chrome-extensions-faster-ai-agents-cli-tools/)

---

## 1. Kann ich SVG als Extension-Icon nehmen?

**Nein. Nicht im Manifest.**

Chrome akzeptiert fuer `icons` und `action.default_icon` nur Raster:
PNG (empfohlen), sonst BMP, GIF, ICO, JPEG.
SVG und WebP sind dort ungueltig. Chrome skaliert sonst den 128er runter — unscharf bei 16 px.

```json
"icons": {
  "16":  "icons/icon16.png",
  "32":  "icons/icon32.png",
  "48":  "icons/icon48.png",
  "128": "icons/icon128.png"
},
"action": {
  "default_icon": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png"
  }
}
```

| Groesse | Wo |
|---|---|
| 16 | Toolbar, Favicon der Extension-Seiten |
| 32 | Windows / HiDPI Toolbar |
| 48 | `chrome://extensions` |
| 128 | Install-Dialog, Web Store |

Web Store: 128×128 PNG, Motiv lieber ~96×96 mit transparentem Rand, hell *und* dunkel lesbar, kein Rahmen den Chrome nochmal drumsetzt.

### Was du mit SVG *darfst*

SVG ist die **Quelle**, nicht das Manifest-Asset.

```text
icon.svg          ← arbeiten, versionieren
     ↓ export
icon16.png … icon128.png   ← das steht im Manifest
```

SVG *darf* in Popup, Side Panel, Dashboard als Inline-Grafik stehen.
Nur nicht unter `"icons"`.

Export z. B.:

```bash
# Inkscape oder rsvg-convert, Beispiel 128
rsvg-convert -w 128 -h 128 icons/icon.svg > icons/icon128.png
```

Oder ein Generator, der aus einem Quadrat 16/32/48/128 PNG macht.
Danach die vier Dateien committen. Nicht zur Laufzeit aus SVG rechnen.

---

## 2. Was der Extension-Booster-Artikel wirklich ist

Der Text auf extensionbooster.net ist **kein Produkt, das du installierst**.
Es ist ein Blogbeitrag + Linkhub:

- listet fremde CLIs (`create-chrome-ext`, Plasmo, `web-ext`, Playwright, Store-Upload)
- verkauft nebenbei Store-Reviews
- hat kostenlose Kleinstwerkzeuge (Icon-Generator, MV3-Converter)

Fuer *dieses* Repo gilt:

| Tool aus dem Artikel | Urteil |
|---|---|
| `npx create-chrome-ext` | **nicht**. Extension existiert schon. |
| Plasmo | **nicht**. Zweites Framework, Build, gegen Vanilla-Linie. |
| `vite-plugin-web-extension` | **nicht**. Kein Vite. |
| `web-ext lint` / `web-ext run` | optional nuetzlich |
| Playwright + `--load-extension` | spaeter, wenn Filter/Score isoliert testbar sind |
| `chrome-webstore-upload-cli` | erst wenn der Store das Ziel ist |
| Icon-Generator auf der Seite | ok als PNG-Export, wenn du kein Inkscape willst |
| Bezahlte Store-Reviews | weglassen |

Den Artikel also nicht als Architektur lesen. Die sinnvolle Schnittmenge:
**MV3-Systemprompt fuer den Agenten + `web-ext lint` + Chrome DevTools MCP.**

---

## 3. So benutzt du das — passend zu diesem Repo

### 3.1 Extension geladen lassen

1. `chrome://extensions`
2. Entwicklermodus an
3. Entpackt laden → Repo-Wurzel (dort liegt `manifest.json`)
4. Nach Code-Aenderung: Reload der Karte, dann mydealz.de-Tab neu laden

Kein `npm run dev`. Kein Hot-Reload-Framework noetig.

### 3.2 `web-ext` (optional, Firefox/Chrome lint)

```bash
npm install -g web-ext
cd /pfad/zu/MydealzExporter
web-ext lint
web-ext run --target=chromium --source-dir .
```

Lint faengt kaputte Manifest-Felder und offensichtliche MV3-Fehler.
Nicht als Ersatz fuer den GraphQL-Walker-Test auf einer echten Deal-Seite.

### 3.3 Chrome DevTools for Agents (der eigentliche Mehrwert)

Das ist der Weg aus [developer.chrome.com/docs/devtools/agents](https://developer.chrome.com/docs/devtools/agents):
Dein Coding-Agent steuert einen echten Chrome, sieht DOM, Netz, Overflow.

Gemini CLI:

```bash
gemini extensions install --auto-update https://github.com/ChromeDevTools/chrome-devtools-mcp
```

Oder nur MCP:

```bash
gemini mcp add chrome-devtools npx chrome-devtools-mcp@latest
```

Live-Session (Chrome ≥144):

1. `chrome://inspect/#remote-debugging` → Allow
2. MCP mit `--autoConnect` starten
3. Prompt z. B.:

```text
Oeffne https://www.mydealz.de
Pruefe, ob der Floating-Export-Button existiert.
Klicke ihn nicht auf einem eingeloggten Konto ohne Rueckfrage.
```

Fuer DIN-BriefNEO analog die GitHub-Pages-URL nehmen.

**Sicherheit:** Der Agent sieht die Seite wie du. Kein dauerhaft offenes mydealz-Login
an einen unbeaufsichtigten Agent haengen.

### 3.4 Systemprompt fuer Agenten (ohne Plasmo)

In `.cursorrules` / `CLAUDE.md` / Agent-Instructions, nicht als zweites Gesetzbuch:

```text
Chrome-Extension, Manifest V3, Vanilla JS.
Kein Plasmo, kein React, kein Vite, kein Python in der Extension.
Service Worker, keine Background-Page.
chrome.storage.local, ein Key fuer den Gemini-Cloud-Fallback.
Export-Payload in chrome.storage.session, nicht nur SW-RAM.
Content-Scripts scrapen nur. LanguageModel/Summarizer nur im Extension-Dokument.
Kein eval, kein remote code, keine neuen Host-Permissions ohne Bedarf.
Zwei Use-Cases: Listing-JSON inkl. Beschreibung; Deal-Seite Beschreibung+Kommentare.
```

### 3.5 Was du den Agenten *nicht* machen laesst

- Projekt neu scaffolden
- `customElements.define` oder Framework „zum Aufraeumen“
- Cloud-Gemini zum Default machen
- SVG in `manifest.icons` schreiben

---

## 4. Mini-Checkliste Icon

- [ ] Quelle als SVG im Repo (optional, aber sinnvoll)
- [ ] vier PNGs 16 / 32 / 48 / 128, quadratisch, Transparenz
- [ ] dieselben Dateien in `icons` und `action.default_icon`
- [ ] auf hellem und dunklem Chrome-Theme pruefen
- [ ] 16-px-Version muss als Fleck erkennbar sein, keine Schrift

---

## 5. Reihenfolge bleibt die aus review_grok.md

1. Storage-Key + Session-Payload
2. LanguageModel / Summarizer statt `window.ai`
3. Side Panel
4. UC2-Beschreibung + Filter + Summarizer

Diese Anleitung ersetzt das nicht. Sie sagt nur, womit du das *debuggen* und *nicht* neu aufsetzen sollst.
