---
status: active
type: specification
tags: [schema-map, east-west, dom-graphql]
summary: "Schema-Matrix DOM vs. GraphQL: Feldzuordnung, Hierarchie-Regeln und Drift-Checks für den MyDealz-Exporter."
---

# East-West Schema-Matrix (DOM vs. GraphQL)

> **Repository:** `Nobara-PC: /home/moritz/repos/MydealzExporter`  
> **Maschinenlesbare Quelle:** `Nobara-PC: /home/moritz/repos/MydealzExporter/tools/deal-schema-map.json`  
> **Automatisierte Verifikation:** `node tools/health-check.mjs <threadId>`  
> **Stand:** 2026-11-27 (v17.4 — Chromium 150+ Baseline; Kommentar-Hierarchie isReply/parentCommentId/level + Autor*in-Badge/Ersteller-Updates verifiziert)

---

## 1. Zweck & Funktionsweise

Mydealz (Pepper.com Plattform) liefert Deal-Informationen über zwei parallele Wege aus:
1. **West (DOM / HTML-Rendering):** Server- und Client-gerendertes HTML mit BEM-Utility-Klassen (z. B. `size--all-xl`, `color--text-TranslucentSecondary`), `data-t` Test-Attributen und CSS-Selektoren.
2. **East (GraphQL / JSON-API):** Typisierte API unter `/graphql` (`Thread`, `Merchant`, `User`, `CommentConnection`).

### Das Problem: Selektor- und Schema-Drift
- Ändert Mydealz CSS-Klassen oder HTML-Verschachtelungen, bricht die DOM-Extraktion.
- Entfernt oder benennt Mydealz GraphQL-Felder um (wie z. B. `keywordNames`), schlagen API-Queries fehl (`HTTP 400: Cannot query field on type Thread`).
- Manche Daten existieren **nur im DOM** (z. B. das redaktionelle/algorithmische `[data-t="noteworthy"]` Badge), andere **präziser in GraphQL** (z. B. `createdAtTs` als exakter Unix-Timestamp statt relativem "vor 55 m").

Diese Matrix dient Maintainern und KI-Agenten als **semantischer Anker** und **Ground Truth**, um bei künftigen Änderungen Felder ohne Rätselraten wiederzufinden.

---

## 2. Gesamtübersicht der 16 Kern-Datenpunkte

| # | Feld-ID | Bezeichnung | DOM Primär-Selektor | GraphQL-Pfad | Typ | Primäre Quelle |
|---|---|---|---|---|---|:---:|
| 1 | `title` | Produktname / Titel | `h1.thread-title` | `thread.title` | `String` | **GQL** |
| 2 | `price` | Angebotspreis | `span.threadItemCard-price.thread-price` | `thread.displayPrice` | `Float` | **GQL** |
| 3 | `nextBestPrice` | UVP / Vergleichspreis | `span.text--lineThrough` | `thread.nextBestPrice` | `Float` | **GQL** |
| 4 | `discount` | Ersparnis (Prozent) | `div.textBadge--green` | `thread.priceDiscount` | `Float` | **GQL** |
| 5 | `temperature` | Temperatur / Punkte | `.vote-temp` | `thread.temperature` | `Float` | **GQL** |
| 6 | `createdAt` | Erstellzeitpunkt | `span[title][class*="color--text-TranslucentSecondary"]` | `thread.createdAtTs` / `.createdAt` | `Int` / `ISO` | **GQL** |
| 7 | `merchant` | Händler / Onlineshop | `a[data-t="merchantLink"]:not(.navMenu-link)` | `thread.merchant.merchantName` | `String` | **GQL** |
| 8 | `author` | Dealersteller | `.thread-user a` | `thread.user.username` | `String` | **GQL** |
| 9 | `dealLink` | Link zum Angebot | `a[data-t="getDeal"]` | `thread.url` | `URL` | **GQL / DOM** |
| 10 | `description` | Informationstext | `div[data-t="description"]` | `thread.description` | `HTML/Text` | **GQL / DOM** |
| 11 | `commentCount` | Anzahl Kommentare | `a[data-t="commentsLink"]` | `thread.commentCount` | `Int` | **GQL** |
| 12 | `comments` | Diskussions-Baum | `li.commentList-item[data-id]` | `comments(threadId, limit, page)` | `Nodes` | **GQL + DOM** |
| 13 | `commentHierarchy` | Top-Level vs. Antwort + Tiefe | `li.commentList-item` / `div.comment-replies-item` | `comment.isReply` + `comment.parentCommentId` | `Boolean` / `ID` | **GQL** |
| 14 | `reactions` | Reaktionen (👍/😄/💡) | `button.comment-reactions` | `comment.reactions` | `Int[3]` | **DOM / GQL** |
| 15 | `noteworthy` | Wertvoller Kommentar | `div[data-t="noteworthy"]` | *(kein direktes GQL-Feld)* | `Boolean` | **Nur DOM** |
| 16 | `authorBadge` / `isAuthor` | Ersteller-Kommentar (Autor*in) | `span.textBadge` (Text `Autor*in`) | `comment.user.userId === thread.user.userId` | `Boolean` | **GQL + DOM** |

---

## 3. Detaillierte Feldspezifikationen & KI-Recovery-Heuristiken

### 1. `title` — Produktname / Titel
* **Semantische Absicht:** Der Haupttitel der Ware/Dienstleistung (Marke, Modell, Spezifikationen).
* **Visuelle Merkmale:** Größte Überschrift im Dokumentenkopf, font-weight 700/800, Größe xl/xxl.
* **DOM Primär:** `h1.thread-title`
* **DOM Fallbacks:** `span.size--all-xl.size--fromW3-xxl`, `h1[class*="thread-title"]`, `article.thread [data-t="threadTitle"]`
* **GraphQL:** `thread.title` (Typ: `String`)
* **Validierung:** `^.{3,250}$`
* **KI-Recovery:** Suche die größte Textüberschrift (`h1` oder prominentes `span`) im Hauptartikel vor der Beschreibung. Schließe Header und Seitennavigation aus.

### 2. `price` — Angebotspreis
* **Semantische Absicht:** Der aktuell reduzierte Kaufpreis in Euro oder "Kostenlos" / "Free".
* **Visuelle Merkmale:** Prominente Preisanzeige, oft fett hervorgehoben in rot/orange/schwarz, mit Währungssymbol `€`.
* **DOM Primär:** `span.threadItemCard-price.thread-price`
* **DOM Fallbacks:** `span.thread-price`, `[class*="thread-price"]`, `span[class*="price"]`
* **GraphQL:** `thread.displayPrice` (Typ: `Float`)
* **Validierung:** `^(?:\d+[,.]\d{2}\s*€?|kostenlos|free|0[,.]00\s*€?)$`
* **KI-Recovery:** Suche nach Textmustern mit Geldbeträgen (`\d+,\d{2}\s*€`) im Headerbereich des Deals, die nicht durchgestrichen sind.

### 3. `nextBestPrice` — Normalpreis (UVP / Vergleichspreis)
* **Semantische Absicht:** Der Referenz- oder Normalpreis vor dem Rabatt zur Berechnung der Ersparnis.
* **Visuelle Merkmale:** Durchgestrichener Preis (`line-through`), meist grau/sekundäre Textfarbe neben dem Angebotspreis.
* **DOM Primär:** `span.text--lineThrough`
* **DOM Fallbacks:** `span[class*="text--lineThrough"]`, `.threadItemCard-price--old`, `del`, `s`
* **GraphQL:** `thread.nextBestPrice` (Typ: `Float`)
* **Validierung:** `^\d+[,.]\d{2}\s*€?$`
* **KI-Recovery:** Suche nach Elementen mit CSS `text-decoration: line-through` oder HTML `<del>`/`<s>` in unmittelbarer Nachbarschaft des Angebotspreises.

### 4. `discount` — Ersparnis (Prozent / Rabatt)
* **Semantische Absicht:** Prozentualer Nachlass gegenüber dem Referenzpreis (z. B. `-65%`).
* **Visuelle Merkmale:** Grünes Badge/Pille mit Minuszeichen und Prozentangabe (z. B. `-65%`).
* **DOM Primär:** `div.textBadge--green`
* **DOM Fallbacks:** `div[class*="textBadge--green"]`, `[class*="discount"]`, `span.badge--saving`
* **GraphQL:** `thread.priceDiscount` (Typ: `Float`)
* **Validierung:** `^-\d{1,3}\s*%$`
* **KI-Recovery:** Suche nach einem Badge oder Text mit dem Regex `-\d+[%％]`. Liegt oft direkt neben dem durchgestrichenen Normalpreis.

### 5. `temperature` — Dealbewertung / Temperatur
* **Semantische Absicht:** Die Community-Bewertung in Grad (°). Kalt (<0° = blau), warm (>100° = rot/orange).
* **Visuelle Merkmale:** Grad-Symbol `°`, umgeben von Plus- und Minus-Voting-Buttons.
* **DOM Primär:** `.vote-temp`
* **DOM Fallbacks:** `span.overflow--wrap-off`, `[class*="vote-temp"]`, `span[class*="space--h-1"][class*="text--b"]`
* **GraphQL:** `thread.temperature` (Typ: `Float`)
* **Validierung:** `^[+-]?\d+°$`
* **KI-Recovery:** Suche nach dem Votebereich (`.vote-box` oder Elementen mit `vote` in der Klasse) und extrahiere den Textknoten mit dem Grad-Zeichen `°`.

### 6. `createdAt` — Datum / Erstellzeitpunkt
* **Semantische Absicht:** Exakter Veröffentlichungszeitpunkt des Deals.
* **Visuelle Merkmale:** Im DOM relativer Text ("Gepostet vor 4 Stunden"), enthält im `title`-Attribut oft den absoluten Datums-String.
* **DOM Primär:** `span[title][class*="color--text-TranslucentSecondary"]`
* **DOM Fallbacks:** `time[datetime]`, `span[title*="202"]`, `[class*="thread-date"]`
* **GraphQL:** `thread.createdAt` (ISO-8601) oder `thread.createdAtTs` (Unix-Timestamp in Sekunden)
* **Validierung:** ISO-8601 String oder Unix Timestamp `> 1500000000`
* **KI-Recovery:** GraphQL ist die überlegene Quelle (`createdAtTs`). Im DOM: Suche nach Elementen mit Attribut `title` im Format `DD.MM.YYYY, HH:MM:SS` oder Tags mit `<time>`.

### 7. `merchant` — Händler / Onlineshop
* **Semantische Absicht:** Name des Anbieters oder Onlineshops (z. B. Amazon, MediaMarkt, Otto).
* **Visuelle Merkmale:** Klickbarer Link oder Text mit Händlername, meist in Primär-/Brand-Farbe.
* **DOM Primär:** `a[data-t="merchantLink"]:not(.navMenu-link)`
* **DOM Fallbacks:** `a[href*="/search/deals?merchant-id="]`, `.thread-merchant a`, `a.merchant-name`
* **GraphQL:** `thread.merchant.merchantName` (Typ: `String`)
* **Validierung:** `^[A-Za-z0-9\s.&'-]{2,50}$`
* **KI-Recovery:** Suche nach Links mit `merchant-id` in der URL oder Attribut `data-t="merchantLink"`.
* **Falle (verifiziert 2026-11-27):** `data-t="merchantLink"` wird **auch im Gutschein-Navi** verwendet
  (50+ Shops, u. a. OTTO, MediaMarkt, H&M — alle mit Klasse `navMenu-link`). Ohne `:not(.navMenu-link)`
  liefert `document.querySelector` den ersten Navi-Treffer und damit den falschen Händler
  (`OTTO` statt `Amazon`). Im Deal-Kopf gibt es genau **einen** Treffer ohne `navMenu-link`.

### 8. `author` — Dealersteller (Autor)
* **Semantische Absicht:** Der Username des Benutzers, der den Deal auf Mydealz eingereicht hat.
* **Visuelle Merkmale:** Benutzername neben dem Avatar im Header-Bereich, klickbar zum Profil (`/profile/username`).
* **DOM Primär:** `.thread-user a`
* **DOM Fallbacks:** `a[href^="/profile/"]`, `[data-t="userProfileLink"]`, `.thread-author`
* **GraphQL:** `thread.user.username` (Typ: `String`)
* **Validierung:** `^[a-zA-Z0-9_\-]{3,35}$`
* **KI-Recovery:** Suche nach einem Hyperlink, dessen `href` mit `/profile/` beginnt, im oberen Meta-Bereich des Deals.

### 9. `dealLink` — Link zum Angebot (Affiliate / Händler-URL)
* **Semantische Absicht:** Der ausgehende Link zum eigentlichen Angebot beim Händler.
* **Visuelle Merkmale:** Großer, auffälliger Button ("Zum Deal" / "Gutschein anzeigen"), oft ganz rechts oder mobil ganz unten fixiert.
* **DOM Primär:** `a[data-t="getDeal"]`
* **DOM Fallbacks:** `a[data-t-click*="ocular,fb"]`, `a.button--mode-brand[target="_blank"]`, `a[href*="/visit/"]`
* **GraphQL:** `thread.url` (Typ: `String`)
* **Validierung:** `^https?://.+$`
* **KI-Recovery:** Suche nach Elementen mit `data-t="getDeal"` oder Links, die ein `target="_blank"` und Weiterleitungs-Token `/visit/thread/` enthalten.

### 10. `description` — Informationstext vom Dealersteller
* **Semantische Absicht:** Die vom Autor verfasste Beschreibung des Deals inkl. Gutscheincodes, Highlights und Bedingungen.
* **Visuelle Merkmale:** Freiform-Textblock unterhalb der Deal-Details, formatiertes HTML (Absätze, Listen, Links).
* **DOM Primär:** `div[data-t="description"]`
* **DOM Fallbacks:** `.userHtml.userHtml-content`, `div[class*="userHtml-content"]`, `article.thread-description`
* **GraphQL:** `thread.description` (Typ: `String` HTML/Markdown)
* **Validierung:** `^[\s\S]{10,}$`
* **KI-Recovery:** Suche nach Containern mit der Klasse `.userHtml` oder Attribut `data-t="description"` innerhalb des Hauptartikels.

### 11. `commentCount` — Anzahl Kommentare
* **Semantische Absicht:** Gesamtzahl der abgegebenen Kommentare zum Deal.
* **Visuelle Merkmale:** Zahl neben dem Kommentar-Icon oder Überschrift "X Kommentare" oberhalb des Kommentarbereichs.
* **DOM Primär:** `a[data-t="commentsLink"]`
* **DOM Fallbacks:** `span.size--all-l.size--fromW3-xl.text--b`, `[data-t="commentCount"]`, `a[href*="#comments"]`
* **GraphQL:** `thread.commentCount` (Typ: `Int`)
* **Validierung:** `^\d+$`
* **KI-Recovery:** Suche nach Texten mit dem Muster `\d+\s*Kommentar` oder Links mit Sprechblasen-Icon.

### 12. `comments` — Kommentare & Diskussions-Baum
* **Semantische Absicht:** Die vollständigen Nutzerkommentare inklusive Verschachtelung (Replies), Autor, Timestamp und Text.
* **Visuelle Merkmale:** Listen-Elemente mit Avatar, Benutzername, Zeitangabe, Kommentartext und Reaktionsleiste.
* **DOM Primär:** `li.commentList-item[data-id], div.comment-replies-item[data-id]`
* **DOM Fallbacks:** `[data-t="comment"]`, `article.comment`, `.commentList-item`
* **DOM-IDs:** Top-Level `#comment-<id>`, Antwort `#reply-<id>`; Antworten liegen unter `section.comment-replies`
* **GraphQL:** Query `comments(threadId: ID!, limit: Int, page: Int)`
* **Validierung:** Array von Objekten mit `id`, `text`, `user`, `createdAt`, `isReply`, `parentId`, `level`
* **KI-Recovery:** Suche nach Elementen mit `data-id` oder Attribut `data-t="comment"`. Antworten liegen in `.comment-replies` Containern; die Tiefe kommt aus GraphQL (§13).

### 13. `commentHierarchy` — Top-Level vs. Antwort + Tiefe
* **Semantische Absicht:** Trennt Hauptkommentare von Antworten und bestimmt die Verschachtelungstiefe (`0` = Top-Level, `1` = direkte Antwort, `2+` = Antwort auf eine Antwort).
* **DOM Primär (Top-Level):** `li.commentList-item[data-id]`, `id="comment-<id>"`
* **DOM Primär (Antwort):** `div.comment-replies-item[data-id]` in `section.comment-replies`, `id="reply-<id>"`
* **DOM-Grenze:** `data-parent-id` **existiert nicht** (0 Treffer, gemessen 2026-11-27). Der DOM kennt nur die Binärinformation „Top-Level oder Antwort", keine Tiefe.
* **GraphQL:** `comment.isReply` (`Boolean!`) + `comment.parentCommentId` (`ID`, direkter Elternknoten) + `comment.mainCommentId` (`ID`, Root des Teilbaums)
* **Ableitung:** `level` existiert **nicht** im Schema. `level` = Anzahl der `parentCommentId`-Sprünge bis `null` (clientseitig, `content/content.js` → `assignLevels()`).
* **Validierung:** `^\d+$`; gemessene Verteilung in Thread 2883187: Level 0 = 9, Level 1 = 7, Level 2 = 4, Level 3 = 2, Level 4 = 1.
* **KI-Recovery:** Nie die DOM-Position als Tiefe interpretieren. `isReply` + `parentCommentId`-Kette nutzen; `mainCommentId` ist nur der Root, **nicht** der direkte Parent.

### 14. `reactions` — Reaktionen (👍/😄/💡)
* **Semantische Absicht:** Die 3 Pepper-Reaktionen auf Kommentare: Gefällt mir (`like`), Lustig (`funny`), Hilfreich (`helpful`).
* **Visuelle Merkmale:** Button mit drei Icons (Daumen, Lachender Smiley, Glühbirne) und Zählerwerten.
* **DOM Primär:** `button.comment-reactions`
* **DOM Fallbacks:** `[class*="comment-reactions"]`, `.comment-like, .comment-funny, .comment-helpful`
* **GraphQL:** In `Comment.reactions` als Zählerobjekt
* **Validierung:** Objekt mit `{ like: Int, funny: Int, helpful: Int }`
* **KI-Recovery:** Suche nach `.comment-reactions` oder Bildern mit Pfad `/assets/img/reactions/`.

### 15. `noteworthy` — Wertvoller Kommentar (Editor-/Algorithmus-Badge)
* **Semantische Absicht:** Auszeichnung für besonders fundierte Nutzererfahrungen ("Wertvoller Kommentar" / "Erfahrungsbericht").
* **Visuelle Merkmale:** Graues Badge mit Glühbirnen-Icon (`#bulb`) und Text "Wertvoller Kommentar" oberhalb des Kommentartexts.
* **DOM Primär:** `div[data-t="noteworthy"]`
* **DOM Fallbacks:** `[data-t="noteworthy"]`, `span:has(svg use[href*="bulb"])`
* **GraphQL:** **Nicht als eigenständiges Feld im `Comment`-Typ exponiert!** Rein clientseitig im DOM gerendert.
* **Validierung:** `Boolean`
* **KI-Recovery:** Suche nach Attribut `data-t="noteworthy"` oder nach einem Element im Kommentarkopf mit Glühbirnen-SVG (`#bulb`), das den Text "Wertvoller Kommentar" enthält.

### 16. `authorBadge` / `isAuthor` — Ersteller-Kommentar (Autor*in)
* **Semantische Absicht:** Markiert Beiträge des Dealerstellers. Diese enthalten Status-Updates zum Angebot (Preis, Verfügbarkeit, Versand, Gutschein-Code) und sind für Analyse/LLM verbindlicher als Community-Meinungen.
* **Visuelle Merkmale:** Kleines graues Pill `Autor*in` direkt rechts neben dem Benutzernamen im Kommentar-Header.
* **DOM Primär:** `span.textBadge` (bzw. `[class*="textBadge"]`) mit normalisiertem Text `Autor*in`; Container `li.commentList-item[data-id]` / `div.comment-replies-item[data-id]`, ID aus `data-id`.
* **DOM-Grenze:** Das Badge wird **clientseitig** gerendert (im Server-HTML 0 Treffer, gemessen 2026-11-27) und existiert **nicht** im GraphQL-Schema.
* **GraphQL-Ableitung:** `isAuthor = comment.user.userId === thread.user.userId` (primär) ODER `comment.user.username === thread.user.username` (Fallback) ODER DOM-Badge am Kommentar.
* **Client-Felder:** `comment.isAuthor`, `authorSeq`/`authorTotal` (Position in den Beiträgen des Nutzers), `authorRefs[]` (IDs aller anderen Beiträge desselben Nutzers → Cross-Linking), `stats.authorCommentCount`, `stats.authorCommentIds[]`, `stats.userIndex[]`.
* **Validierung:** `^Autor(\*in)?$`; Gegenprobe: `authorCommentCount > 0` genau dann, wenn mindestens ein Kommentar das Badge trägt oder die userId matcht.
* **KI-Recovery:** Immer über die Nutzer-ID gehen, nicht über die DOM-Position. Nur wenn weder `thread.user.userId` noch `thread.user.username` verfügbar sind, das DOM-Badge per `closest('[data-id]')` auswerten.

---

## 4. Automatisierte Validierung via CLI

Zur automatischen Erkennung von Selektor- und GraphQL-Drift existiert das Prüftool:

```bash
# Aufruf mit beliebiger mydealz Deal-ID:
node tools/health-check.mjs 2883187
```

### Was das Tool prüft:
1. **Statische Code- & Manifest-Integrität:** Prüft Vanilla JS Syntax aller Dateien via `node --check` und `manifest.json`.
2. **GraphQL Endpoint & Schema:** Führt eine echte Query über CDP (Port 9222) mit Browser-Session aus und prüft, ob alle typisierten Felder noch existieren.
3. **HTML Popover Integration:** Verifiziert, dass `#mde-listing-btn` und `#mde-ai-wrap` als natives HTML `popover="manual"` registriert sind.
4. **East-West Abgleichstabelle:** Vergleicht die DOM-Extraktion der aktiven Seite direkt mit dem GraphQL-Ergebnis und markiert `MATCH`, `DIVERGENCE` oder `DRIFT`.
5. **Modul-/Cockpit-Gate:** `tools/repo-map-check.mjs` prüft Zeilenbudgets, die 15–40-KiB-Regel ([anchor:deep-modules](https://web.stanford.edu/~ouster/cgi-bin/book.php)) und die Byte-Identität des `shared-bootstrap`-Blocks in `content.js`/`listing.js`.
