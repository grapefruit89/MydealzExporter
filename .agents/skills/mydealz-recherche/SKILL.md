---
name: mydealz-recherche
description: >-
  Use when the user asks to search mydealz for deals, products, or community feedback,
  to summarize comment sentiment, or to extract pricing and discussion insights via the
  isolated chrome-devtools MCP instance (e.g. "Such mal ein iPhone auf mydealz").
  Strictly protects user session by never touching the active user browser (Helium, port 9222).
---

# mydealz-Recherche (Test-Browser via chrome-devtools MCP)

Auf Anfrage mydealz durchsuchen und Threads/Kommentare auswerten.

## Grundregeln & Schutzbarrieren

- **Nur die eigene MCP-Test-Instanz benutzen:** Die MCP-Tools von `chrome-devtools` laufen mit `--isolated` in einem getrennten Chrome-Profil. NIEMALS den laufenden Benutzer-Browser (Helium, Port 9222) ansteuern — keine Tabs öffnen/schließen, keine fremde Navigation.
- **MCP-Server Konfiguration:** Registriert in `/home/moritz/.config/opencode/opencode.jsonc` bzw. im Antigravity MCP-Stack. Der Browser wird erst beim ersten Tool-Aufruf bedarfsgerecht gestartet.

## Recherche-Ablauf

### 1. Suchergebnisse erfassen
- Navigation via `navigate_page` zu `https://www.mydealz.de/search?q=<query>` (URL-encoded).
  - Deals-Only Filter: `https://www.mydealz.de/search/deals?q=<query>`.
- Thread-Links per `take_snapshot` extrahieren.
  - Pattern: `/<slug>-<threadId>` (die Zahl am Ende ist die `threadId`).

### 2. Thread öffnen
- Relevante Thread-URLs öffnen (in der Regel Top 3–5 Treffer).
- `threadId` aus der URL oder aus `__INITIAL_STATE__?.threadDetail?.threadId` ermitteln.

### 3. Kommentare via GraphQL abrufen
Auf der geöffneten Thread-Seite per `evaluate_script` ausführen:
```js
fetch('/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `query($filter: CommentFilter!, $limit: Int, $page: Int) {
      comments(filter: $filter, limit: $limit, page: $page) {
        items { commentId mainCommentId threadId preparedHtmlContent
                createdAt createdAtTs deletedBy { username } replyCount
                user { username userId } reactionCounts { type count }
                repliesPreview { commentId mainCommentId preparedHtmlContent
                                 createdAtTs user { username } reactionCounts { type count } } }
        pagination { last count current }
      }
    }`,
    variables: { filter: { threadId: '123456' }, limit: 100, page: 1 }
  })
}).then(r => r.json())
```
- Top-Level Kommentare sind in `items`, Antworten stecken in `repliesPreview`.
- Falls Pagination nötig: `page: 2, 3…` bis `pagination.last`.
- **Rate-Limit-Schutz:** Erscheint ein HTTP 200 mit HTML-Body statt JSON, ist ein Throttle aktiv — Anfragen drosseln und pausieren.

### 4. Auswertung & Präsentation
- **Sentiment & Konsens:** Häufige Vor- und Nachteile sowie Community-Meinung strukturiert zusammenfassen.
- **Reaktions-Gewichtung:** Reaktionen (`HELPFUL`, `LIKE`) berücksichtigen; hoher `HELPFUL`-Wert markiert fundierte Expertenkommentare.
- **Deal-Check:** Aktuellen Preis, Händler und eventuelle Gutscheincodes direkt aus den Metadaten zitieren.
