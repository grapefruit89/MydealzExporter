---
status: active
type: reference
tags: [mydealz, graphql, schema, insights, drift]
summary: "GraphQL- und DOM-Eigenheiten der mydealz/Pepper-API: Thread-ID-Constraint, repliesPreview-Nesting, Drift-Signale und Filterregeln."
---

# MyDealz Data Structure & Signal Analysis

Based on the Deep-Dive Extraction, here are the specific peculiarities of the MyDealz/Pepper GraphQL API and how we will filter for "Product Focus".

## 1. API Peculiarities (The "Tricks")

*   **ThreadID Constraint (Critical):**
    *   Standard GraphQL allows fetching nested objects via `parentCommentId`.
    *   **MyDealz Exception:** The API silently fails unless you *also* provide the `threadId` in the filter, even when requesting a specific sub-comment tree. Using `mainCommentId` + `threadId` is the only robust composite key.
*   **Hybrid Nesting (`repliesPreview`):**
    *   The `comments` query is surprisingly rich. Root comments often contain a filled `repliesPreview` field.
    *   **Advantage:** For most discussions, we don't actually need separate recursive calls. The root query captures the entire conversation context in one go.
    *   **Strategy:** We parse the tree structure directly from the Root objects.

## 2. Signal vs. Noise (Cleaning Strategy)

To achieve the requested "Product Focus" and remove "Trash", we distinguish between these data types:

### 🚨 NOISE (Delete)
*   **User Badges/Levelling:** `bestBadge`, `level`, `maxTemperatureLevel`. (Social gamification stats irrelevant to product quality).
*   **Internal Flags:** `isDeletedOrPendingDeletion`, `canVote`, `reportable`. (System state).
*   **Redundant Content:** `preparedHtmlContent` (we use raw `content` or strip HTML for clean text).
*   **Avatar URLs:** `imageUrls` (Visual bloat).

### ✅ SIGNAL (Keep)
*   **Content:** The actual text body.
*   **Reactions (The "Vibe Check"):**
    *   `LIKE`: General agreement.
    *   `HELPFUL`: **High-value signal** for product insights/answers.
    *   `FUNNY`: **Warning signal** for Jokes/Memes (e.g., "URGEEN" comments).
    *   *Action:* We will summarize these into a simple `score` object to filter out meme-threads if needed.
*   **Context:** `createdAt` (Topicality) and `replyCount` (Controversy indicator).

## 3. Proposed "Clean Schema"

Instead of the raw GraphQL dump (100+ lines per comment), our new scanner will produce this compact format:

```json
{
  "id": "55812889",
  "user": "alvaro",
  "date": "9. Dez 2025",
  "text": "Ich könnte mir vorstellen, dass die 80° Weitwinkel nicht überall eine gute Idee sind...",
  "reactions": { "like": 4, "helpful": 1, "funny": 0 },
  "replies": [
    {
      "id": "55814572",
      "user": "NT48",
      "text": "Das Produkt richtet sich wohl an gewerbliche Damen",
      "reactions": { "like": 1, "helpful": 0, "funny": 14 } 
      // -> HIGH FUNNY COUNT detected -> Can be flagged as "Off-Topic" by AI later.
    }
  ]
}
```

This reduces token usage by ~70% and maximizes context density.

## 4. Externe Quellen: PepperDealsScraper (Referenz)

**Repo:** https://github.com/amintikk/PepperDealsScraper
Python-CLI-Scraper für 10 Pepper-Portale. Stand: live getestet am 2026-09-09 —
funktioniert. Technik: keine CSS-Selektoren, sondern **`data-vue3`-Vue-Payloads**
aus dem HTML (`props.thread`) und die Pepper-AJAX-Endpunkte.

### Was wir übernommen haben

| Technik | Details | Eingebaut in |
|---|---|---|
| **AJAX-Pagination** | `?page=N&ajax=true&layout=horizontal` → JSON-Wrapper `{ data: { content: "<html>" } }`; Thread-IDs aus `data-vue3`-Attributen (`props.thread.threadId`) | `listing.js` — „+2 Seiten"-Toggle, `collectAllIds()` / `fetchExtraPageIds()` |
| **Rate-Limit-Disziplin** | max. 2 Extraseiten hart gedeckelt, 700 ms Pause zwischen Fetches, Abbruch bei leerer Seite | `listing.js` (`MAX_EXTRA_PAGES`, `EXTRA_PAGE_PAUSE_MS`) |

### Verifiziert, aber nicht (yet) übernommen

*   **`/deals/_dummy-{threadId}`** — Detail-URL ohne Slug, antwortet mit 301 auf
    die kanonische Slug-URL. Nützlich, falls wir mal von einer reinen ID zur
    kanonischen URL müssen. Wir lesen IDs aus dem DOM, daher aktuell ungenutzt.
*   **`data-vue3` für First Paint** — das Initial-HTML enthält die Thread-Payloads
    bereits im DOM; Basisfelder (Titel, Preis, Temperatur) ohne Netzwerk-Call
    verfügbar. Unser GQL-Batch braucht nur 1–2 Requests, daher niedrige Prio.

### Übernommen (Batch 1–2, 2026-09-09)

*   **AJAX-Pagination** → `listing.js` „+2 Seiten"-Toggle
    (`collectAllIds()` / `fetchExtraPageIds()`), gedeckelt auf 2 Extraseiten
    mit 700 ms Pause (Rate-Limit-Disziplin aus dem Tool).
*   **Retry/Backoff** → `listing.js` `fetchWithRetry()`: nur transiente Fehler
    (408/429/5xx) mit exponentiellem Backoff (800 ms → 1600 ms, max. 2 Retries),
    403/404 werfen sofort. Gilt für GQL-Batch und AJAX-Pagination.
*   **Listen-Filter als URL-Params** — `priceFrom/priceTo`, `temperatureFrom/To`,
    `groups[]`, `retailers[]`, `time_frame`, `super_hot` (live verifiziert,
    HTTP 200). mydealz-eigene Filter-UI setzen genau diese Params; sie gelten
    automatisch auch für unsere AJAX-Extraseiten. Export protokolliert sie
    in `_meta.filters`.

### Aus der Sammlung (Thread 2035404, Kommentar 53175634)

*   **`mainGroup` / `groupsPath` sind die autoritative Kategorie.**
    Übersichtsseiten zeigen teils die *ursprüngliche* Kategorie; mydealz zählt
    intern die *aktuelle* `mainGroup`. Query-Shape (offizielle Variablen-Form):

    ```graphql
    query getThread($filter: IDFilter!) {
      thread(threadId: $filter) {
        title
        mainGroup { threadGroupId threadGroupName }
      }
    }
    ```

    Übernommen in `listing.js` `THREAD_FIELDS` (Alias-Batch): `group`,
    `groupId`, `groupUrlName`, `groupPath` (Breadcrumb-Kette) pro Deal.
    Wichtig: Kategorie-Angaben auf Listenseiten sind nur bedingt vertrauenswürdig
    (Um-Kategorisierungen). Anonym gegen `/graphql` geht das nicht — Session
    (CSRF + Cookie) nötig, Fehlerantwort ist `{message:"Whiiiiiiieeee"}`.
*   **ID-only-URL reicht:** `https://www.mydealz.de/<threadId>` vervollständigt
    der Server zur kanonischen Slug-URL (vgl. `_dummy`-Erkenntnis oben).
*   **Kommentar-Permalinks** (URL-Formate aus den „Starten statt warten"-Tools):
    Hauptkommentar `...#comment-<id>`, Antwort `...#reply-<id>`; das alte
    Format `/comments/permalink/<id>` funktioniert weiterhin. Übernommen:
    `permalink`-Feld pro Kommentar im UC2-Export + „↗"-Link im Dashboard.
*   **`?temperatureFrom=any`** — mydealz blendet auf Freebies/Gutscheinen per
    Default alles unter 100° aus („nur Freebies ab 100 Grad"). Mit dem Param
    sieht man alles; der Export kann nur zeigen, was die Seite anzeigt — also
    bei Freebie-Exports merken, dass der Default-Filter vorher schon Deals
    wegnimmt.
*   **Widget hide/show-Endpunkte** (`/widgets/<name>/hide|show`) — rein kosmetisch,
    kein Export-Nutzen. Nur dokumentiert.
*   **„Alle Antworten ausklappen"** (💬-Button) → bewusst als **DOM-Klick** auf
    `button[data-t="moreReplies"]` umgesetzt, NICHT als eigener GraphQL-Render:
    mydealz rendert die Replies selbst (native Klassen + Reply-/Reaktions-Handler);
    ein eigener GQL-Render müsste die Kommentar-DOM-Struktur replizieren und
    bricht bei jedem Redesign. `data-t`-Attribute sind die stabile Hook-Klasse
    (gleiches Muster wie `data-t="description"`/`data-t="merchantLink"`).
    Zähler-Vorschau summiert die "(N)"-Zahlen der Buttons; 150 ms Pause je Klick,
    700 ms je Runde, Obergrenze 50 Runden gegen Runaway.

### Aus dem eigenen Vorgänger-Script (Deep-State AI Exporter v11–12.3)

*   **`createdAtTs` bestätigt** — Kommentar-Zeitstempel ist ein Unix-Epoch-Integer
    (`createdAtTs * 1000`), nicht der formatierte String. Bleibt geparkt mit
    `wasEdited`/`isPinned` für die nächste COMMENT_FIELDS-Erweiterung.
*   **Inline-Links im Kommentartext** → übernommen (`cleanText` ersetzt
    `<a>` durch `[label](href)`-Textknoten; zusätzlich `links[]`-Array).
*   **OP-Markierung** → übernommen und ausgebaut (Dashboard: `👑 Autor*in`-Badge,
    `📌 Updates`-Tab, `stats.authorCommentCount`, `stats.authorCommentIds[]`;
    Quelle: `comment.user.userId === thread.user.userId`, Fallback Username,
    Fallback DOM-Badge `Autor*in` — siehe Drift-Abschnitt).
*   **Retry-After-Header** → übernommen (429: Server-Hinweis schlägt Eigen-Backoff).
*   **IndexedDB-Cache (1h TTL, pro Thread) + AbortController** → geparkt.
    Der Cache ist das Usercript-Derivat vom geplanten `chrome.storage.session`
    Payload; die zwei Zusatzideen für danach: „🔄 Force-Refresh"-Button wenn
    Payload aus Cache stammt + Abbruch-Support bei sehr langen Exports.
    Wichtig: In Content-Scripts gehört IndexedDB zur *Webseite* (mydealz-Origin),
    nicht zur Extension — deshalb für die Extension `chrome.storage.session`
    (SW-Pfad) statt IndexedDB.

### Verworfen

*   **`/share-deal/{threadId}`** als Kurz-URL — antwortet mit 302 über
    `app.adjust.com` (Tracking-Redirect). Für den MD-Export ungeeignet,
    wir bleiben bei den kanonischen Slug-URLs.

### Bewusst nicht übernommen

*   Cloudscraper/Proxy-Layer — wir laufen im eingeloggten Browser-Session-Kontext.
*   Multi-Country-Support, CSV-Export, Bild-Download — außerhalb der zwei
    eingefrorenen Use-Cases (siehe review_grok.md §11).
*   Kein Kommentar-Support im Tool — unser GraphQL-Walker (§1) bleibt der Moat.


### GQL- & DOM-Drifts (Stand 2026-11-27)

*   **`keywordNames` entfernt:** Im GraphQL-Schema existiert das Feld `keywordNames` auf `Thread` nicht mehr (warf `Cannot query field "keywordNames" on type "Thread"`). Wurde aus `THREAD_FIELDS` entfernt.
*   **`[data-t="noteworthy"]` (Wertvoller Kommentar):** Neues Redaktions-/Algorithmen-Feature von Pepper.com. Das Badge zeigt ein Glühbirnen-Icon (`#bulb`) und den Text `"Wertvoll"` für Kommentare mit substanziellen Produkterfahrungen. Existiert rein im DOM (nicht im GQL-Schema); wird clientseitig über `document.querySelectorAll('[data-t="noteworthy"]')` abgegriffen und im Dashboard als `💡 Wertvoll` gerendert (+4 im Score-Ranking).
*   **`Autor*in`-Badge (Ersteller-Kommentar, DOM-only, 2026-11-27):** mydealz markiert Beiträge des Dealerstellers clientseitig mit einem `textBadge` der Textklasse `size--all-xs` und dem Text `Autor*in` im Kommentar-Header (`<div class="user userInfo…">…<span class="textBadge …">Autor*in</span>`). Im Server-HTML 0 Treffer (gemessen an Thread 2883187) und im GraphQL-`Comment`-Typ **kein** entsprechendes Feld. Erkennung deshalb dreistufig: `comment.user.userId === thread.user.userId` → exakter Username-Vergleich (`meta.author`) → DOM-Badge über `closest('[data-id]')`. Client: `content.js` → `annotateAuthors()` setzt `isAuthor` sowie `stats.authorCommentCount` und `stats.authorCommentIds[]`. (Redundante Felder `userIndex` und `authorRefs` wurden zugunsten Token-Effizienz eliminiert).
*   **Bild-CDN-Muster:** Das alte `/fs/895x577/qt/65/{uid}`-Schema antwortet mit HTTP 404. Das aktuelle Muster lautet: `https://static.mydealz.de/${mainImage.path}/${uidClean}/re/1024x1024/qt/60/${uidClean}.jpg` (wobei `uidClean = uid.replace(/\.raw$/, '')`).
*   **`[data-t="merchantLink"]` ist doppelt belegt (2026-11-27):** Der Selektor matcht **auch das Gutschein-Navi** (50+ Shops, Klasse `navMenu-link`, in DOM-Reihenfolge **vor** dem Deal-Kopf). `document.querySelector('[data-t="merchantLink"]')` lieferte deshalb `OTTO` für einen Amazon-Deal. Korrekt: `a[data-t="merchantLink"]:not(.navMenu-link)` — dann genau ein Treffer im Deal-Kopf. Betraf `content.js` (`extractMetadata`) und `tools/health-check.mjs` (East-West-Abgleich), beide korrigiert.
*   **LIVE-Drift vs. Schema-Drift:** Temperatur und Kommentarzahl im DOM sind Momentaufnahmen beim Seitenaufbau. Weichen sie von der frischen GraphQL-Antwort ab (`631°` vs. `672,91°`, `22` vs. `23`), ist das **kein** Selektorfehler. `health-check` markiert diese zwei Felder als `LIVE` (gelb) und zählt sie nicht als Fehler; Titel/Preis/UVP/Händler bleiben harte `MATCH`/`DIVERGE`-Gates.
*   **Zeitstempel (DOM vs. GQL):** DOM zeigt dynamisch relative Texte (`vor 55 m`, `vor 4 Stunden`). GraphQL liefert mit `createdAtTs` den exakten Unix-Timestamp in Sekunden und mit `createdAt` den ISO-8601-String — GQL ist für chronologische Sortierung und Zeitvergleiche stets die bevorzugte Quelle.
    **KORREKTUR (2026-11-27, Thread 2883187):** Die Aussage „`createdAt` ist ISO-8601" ist **falsch**. `Comment.createdAt` und `Comment.updatedAt` liefern **relative deutsche Strings** (`"vor 36 m"`, `"vor 23 m"`); nur `createdAtTs` ist der exakte Unix-Wert. `Thread.createdAt`/`publishedAt`/`updatedAt`/`hotDate` sind dagegen **Unix-Ints**, ebenfalls kein ISO-String. Messung: `/tmp/mydealz-thread-2883187.json`.

### Keyword- & Tag-Inventur (Stand 2026-11-27, Thread 2883187)

**Es gibt kein `tags`-Feld.** Alle Kandidaten geprüft, alle abgelehnt:

| Kandidat | Ergebnis | Fehlermeldung |
|---|---|---|
| `Thread.tags` | existiert nicht | `Cannot query field "tags" on type "Thread".` |
| `Thread.badges` | existiert nicht | `Cannot query field "badges" on type "Thread". Did you mean "images"?` |
| `Thread.keywords` | existiert nicht | `Cannot query field "keywords" on type "Thread".` |
| `Thread.keywordNames` | **im Schema, Resolver defekt** | `errors[].path = ["thread","keywordNames"]` → `Internal server error` |
| `Thread.issueCount` | **im Schema, Resolver defekt** | `errors[].path = ["thread","issueCount"]` → `Internal server error` |
| `Comment.tags` | existiert nicht | `Cannot query field "tags" on type "Comment".` |

> ⚠️ **`keywordNames` ist eine Falle:** Das Feld validiert gegen das Schema (kein „Cannot query field"), die Antwort ist HTTP 200 mit `errors` und `data.thread = null`. Ein Export, der es mitschickt, verliert den **kompletten Thread**. Deshalb ist es aus `THREAD_FIELDS` entfernt — die frühere Diagnose „Feld existiert nicht mehr" war unpräzise: Es existiert, aber der Resolver antwortet nicht.

**Die vier belastbaren Keyword-Quellen:**

1. **`groups` (einzige echte Tag-Quelle):** flaches Array Root → Blatt, z. B.
   `Fashion & Accessoires → Kleidung → Hosen → Jeans → JACK & JONES`.
   `mainGroup` = tiefste Gruppe; `groupsPath` = gleiche Information, anderer Typ.
   Praxis: `groups.map(g => g.threadGroupUrlName)` → `["fashion-accessoires","kleidung","hosen","jeans","jack-jones"]`.
2. **`temperatureLevel`:** serverseitig berechnetes Qualitäts-Tag (`Hot3` bei 662,41°).
3. **`merchant` + `locations` + `linkHost`:** `Amazon` / `Bundesweit` / `www.amazon.de`. `selectedLocations` ist bei bundesweiten Deals `null`.
4. **Enums:** `type` (`Deal`), `threadTypeId` (`1`), `status` (`Activated`), `isHot`, `expirable`, `endDate.timestamp`, `voucherCode`.

**Badges sind kein Deal-Tag:** `Thread.badges` existiert nicht; Badges hängen nur am Autor
(`user.badges[].level.name`, 24 Stück bei `Robert_Chi`) und `Badge` hat genau ein Feld
(`level { name }`). Für Produktanalyse Rauschen, für Autoren-Vertrauen Signal.

**Rabatt selbst rechnen:** Bei 2883187 sind `priceDiscount` und `priceOff` `null` und
`percentage` `0`, obwohl `nextBestPrice = 39.99` und `price = 13.99` (~65 % Rabatt).
Formel: `1 - price / nextBestPrice`.

### Kommentar-Hierarchie: Top-Level vs. Antwort (Stand 2026-11-27)

| Quelle | Top-Level | Antwort |
|---|---|---|
| GraphQL `isReply` | `false` | `true` |
| GraphQL `parentCommentId` | `null` | ID des **direkten** Parents |
| GraphQL `mainCommentId` | `null` | ID des **Root**-Kommentars |
| GraphQL `level` | **existiert nicht** | **existiert nicht** |
| DOM `id` | `comment-<id>` | `reply-<id>` |
| DOM Container | `li.commentList-item` | `div.comment-replies-item` in `section.comment-replies` |
| DOM `data-parent-id` | — | **existiert nicht** (0 Treffer) |

*   **`level` wird clientseitig berechnet** (`content/content.js` → `assignLevels()`): Anzahl der
    `parentCommentId`-Sprünge bis `null`. `mainCommentId` ist dafür **unbrauchbar**, weil es
    immer der Root ist.
*   **Gemessene Tiefenverteilung Thread 2883187:** Level 0 = 9, Level 1 = 7, Level 2 = 4,
    Level 3 = 2, Level 4 = 1. Eine Annahme „jede Antwort ist Level 1" wäre falsch.
*   **DOM reicht nicht:** `section.comment-replies` ist ein flacher Container; die visuelle
    Einrückung entsteht per CSS, nicht per Verschachtelung. Nur GraphQL kennt den echten Parent.
*   **Permalinks:** Top-Level `#comment-<id>`, Antwort `#reply-<id>`; `Comment.url` liefert
    denselben Link bereits fertig.
*   **Zähler-Falle:** `thread.commentCount` = Top-Level **plus** Replies (23), während
    `comments.pagination.count` nur die Top-Level zählt (9).
