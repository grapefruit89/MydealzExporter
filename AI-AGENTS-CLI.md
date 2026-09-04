# AI-AGENTS-CLI

Stand: 2026-09-04  
Vanilla-MV3-Extension. Kein Plasmo, kein Vite, kein neues Scaffold.

Quelle: [Chrome DevTools for agents](https://developer.chrome.com/docs/devtools/agents)

---

## 1. Extension laden

1. `chrome://extensions`
2. Entwicklermodus an
3. Entpackt laden → Repo-Wurzel (`manifest.json`)
4. Nach Code-Änderung: Karte reloaden, mydealz.de-Tab neu laden

Kein `npm run dev`.

Optional lint:

```bash
npm install -g web-ext
web-ext lint
web-ext run --target=chromium --source-dir .
```

---

## 2. Chrome DevTools MCP

```bash
gemini extensions install --auto-update https://github.com/ChromeDevTools/chrome-devtools-mcp
```

Oder:

```bash
gemini mcp add chrome-devtools npx chrome-devtools-mcp@latest
```

Live-Session (Chrome ≥144):

1. `chrome://inspect/#remote-debugging` → Allow
2. MCP mit `--autoConnect`
3. Prompt:

```text
Oeffne https://www.mydealz.de
Pruefe, ob der Floating-Export-Button existiert.
Klicke ihn nicht auf einem eingeloggten Konto ohne Rueckfrage.
```

**Sicherheit:** Der Agent sieht die Seite wie du.

---

## 3. Systemprompt

```text
Chrome-Extension, Manifest V3, Vanilla JS.
Kein Plasmo, kein React, kein Vite, kein Python in der Extension.
Service Worker, keine Background-Page.
chrome.storage.local, ein Key fuer den Cloud-Fallback.
Export-Payload in chrome.storage.session.
Content-Scripts scrapen nur. LanguageModel/Summarizer nur im Extension-Dokument.
Zwei Use-Cases: Listing-JSON inkl. Beschreibung; Deal-Seite Beschreibung+Kommentare.
```

Nicht tun: neu scaffolden, Framework anschleppen, Cloud-Gemini zum Default machen.

---

## 4. Reihenfolge (review_grok.md)

1. Storage-Key + Session-Payload
2. LanguageModel / Summarizer statt `window.ai`
3. Side Panel
4. UC2-Beschreibung + Filter + Summarizer
