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

### Aus dem eigenen Vorgänger-Script (Deep-State AI Exporter v11–12.3)

*   **`createdAtTs` bestätigt** — Kommentar-Zeitstempel ist ein Unix-Epoch-Integer
    (`createdAtTs * 1000`), nicht der formatierte String. Bleibt geparkt mit
    `wasEdited`/`isPinned` für die nächste COMMENT_FIELDS-Erweiterung.
*   **Inline-Links im Kommentartext** → übernommen (`cleanText` ersetzt
    `<a>` durch `[label](href)`-Textknoten; zusätzlich `links[]`-Array).
*   **OP-Markierung** → übernommen (Dashboard: `👑 OP`-Badge bei Kommentaren
    des Deal-/Diskussionsautors; Quelle: `meta.author`).
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
