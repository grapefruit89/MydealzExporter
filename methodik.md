# Exporter-Methodik

Die bewährte Arbeitsweise des MyDealz-Scrapers — übertragbar auf andere Portale
(z. B. kleinanzeigen.de). Kein Code hier, nur die Funktionsweise.

---

## 1. Kernprinzipien

1. **Strukturierte Daten schlagen CSS-Selektoren.** Portale betten ihre Daten
   maschinenlesbar ein (SSR-JSON, Vue-/React-Payloads, interne GraphQL-Endpunkte).
   Wer diese Quelle liest, überlebt Redesigns; wer Klassen aufschneidet, bricht.
2. **Vier Quellen-Schichten, immer in dieser Priorität prüfen:**
   - Interne API (GraphQL/REST) — die fette Quelle, braucht Session
   - Eingebettete SSR-Payloads (z. B. `data-vue3`-Attribute, `__INITIAL_STATE__`,
     `data-t-d`-JSON) — gratis im Initial-HTML
   - Semantische Hooks (`data-t`-Attribute, Portal-IDs, `<meta>`-Tags) —
     stabiler als Styling-Klassen
   - DOM/Markup — letzte Option, nur wenn nichts anderes existiert
3. **Login-Session = Moat.** Eingeloggte Browser-Kontexte sehen Felder
   (Beschreibungen, Kontakt-Kontext), die anonyme Crawler nie bekommen.
4. **Zwei eingefrorene Use-Cases, kein All-in-One.**
   - UC1: Übersicht/Suchergebnisse → Sammel-Export (JSON + MD)
   - UC2: Einzelseite → Volltext-Erfassung (Beschreibung + alles was „diskutiert" wird)
5. **Fehler laut, Daten ehrlich.** Nutzerverständliche Fehlermeldungen im UI;
   Datenwahrheiten dokumentieren (was null heißt, was Community-Eintragung ist).

---

## 2. Discovery-Workflow (Schritt 1 jedes neuen Projekts)

1. Zielseite im Browser öffnen, DevTools → **Netzwerk**-Tab → Reload
2. Filtern: `graphql` / `api` / `json` — die Requests der Seite selbst sind die API
3. **Rechtsklick → Copy as fetch** → Konsole → Parameter variieren → Feldinventar bauen
4. SSR ansehen: Quelltext nach eingebetteten JSON-Layern greifen
   (`data-vue3=`, `data-t-d=`, `__INITIAL_STATE__=`, `application/ld+json`)
5. **Jede Feldannahme verifizieren** (Mini-Query in der Konsole), bevor sie in Code geht —
   ein abgelehntes Feld kann ganze Batch-Antworten leeren
6. Feld-Discovery-Werkzeug installieren (z. B. ein Payload-Inspector) —
   „Feld fehlt im Export?" → hoovern → Feldname lesen → gezielt nachbauen

---

## 3. UC-Muster: Übersicht / Suchergebnisse (UC1)

Ablauf pro Seite:

```text
1. IDs aus dem sichtbaren DOM lesen (semantische Anker, article[id]-Muster o. ä.)
2. Vollständige Datensätze per Batch-API holen (Chunking, z. B. 30er-Alias-Gruppen)
3. Optional: Folgeseiten über den AJAX-Endpunkt (?page=N&ajax=true&layout=horizontal
   bzw. Portal-Äquivalent) — IDs aus den eingebetteten Payloads der Antwort ziehen
4. Deduplizieren gegen die sichtbare Seite, merge
5. Export: JSON (Maschinen) + MD (lesbar/teilbar)
```

Regeln:

- **Seitenzahl hart deckeln** (2 Extraseiten) + feste Pause zwischen Fetches —
  Nutzer-Tempo ist ban-safe, Crawler-Tempo nicht
- **Pagination-Daten nie aus der DOM-Sichtbarkeit ableiten** — der AJAX-Endpunkt
  kennt alle Seiten, auch die nicht gerenderten
- **Filter als URL-Params** des Zielsystems nutzen, nicht nachbauen — der Export
  erbt sie automatisch und protokolliert sie in `_meta.filters`
- Kurzzeit-Cache für Format-Wechsel (JSON → MD ohne Re-Fetch)

---

## 4. UC-Muster: Einzelseite (UC2)

Zwei Varianten, gleiche Architektur:

**A. Mit Community-Diskussion (mydealz-Muster):**
- Metadaten aus SSR/Hooks (Titel, Preis, Händler, Autor, Kategorie)
- Kompletter Kommentarbaum über die API, inkl. Replies:
  Composite-Keys nutzen, die die API verlangt (mydealz: `mainCommentId` + `threadId`)
- Replies-Preview ausnutzen, fehlende in Batches nachladen
- Statistik über **alle** Kommentare inkl. Replies (nicht nur Top-Level)
- Permalinks pro Kommentar (Ziel-URL-Anker), Linkliste pro Konversation

**B. Ohne Diskussion (Kleinanzeigen-Muster) — „Das Inserat ist der Inhalt":**
- Wenn es keine Kommentare gibt, ist die Detailseite selbst das Analyse-Produkt
- **`.md`-Export, der das Inserat vollständig beschreibt:**
  Titel, Preis (+ Verhandlungsbasis/`VB`), Beschreibung (Markdown aus HTML),
  Attribute/Kategorien, Bild-URL-Liste, Verkäufer (Name, Registrierung, Bewertungen,
  Verifizierungen), Standort/Versandoptionen, Zeitstempel (online seit, zuletzt
  aktualisiert), Listing-URL
- **JSON** parallel als Maschinenformat mit denselben Feldern
- Kein Kommentar-Tree, kein Map-Reduce — UC2 schrumpft auf saubere Volltext-Erfassung.
  Spätere KI-Nutzung (z. B. Betrugs-Signale im Inseratstext) ist Add-on, kein Kern

---

## 5. Export-Formate & Datenqualität

- **JSON:** Struktur mir `_meta` (Zeitstempel, Quelle, Query, Filter, Seitenbereich,
  Counts) — jede Datei ist selbst beschreibend und reproduzierbar
- **Markdown:** Karten-Layout mit Metadaten-Chips, echte Markdown-Konvertierung der
  Beschreibung (HTML→MD, Links inline als `[label](href)`), aggregierte Linkliste
- **Link-Erhalt ist Pflicht:** Plaintext-Export (innerText) verliert hrefs —
  Links separat sammeln (dedupliziert, absolut, `/visit/`-Cloaking aufheben,
  wenn die Ziel-URL im `title`-Attribut steckt)
- **Datenwahrheiten dokumentieren:** Community-Eingaben (Preise) sind ungenau/absent
  auf einem Teil der Inhalte; Titel bleibt Quelle der Wahrheit — ins README,
  damit KI-Nutzer nicht blind das strukturierte Feld zitieren

---

## 6. Robustheit & Rate-Limit-Disziplin

- **Retry/Backoff:** nur transiente Fehler (408/429/5xx, Netzwerkfehler); 403/404
  sofort aufgeben; `Retry-After`-Header schlägt Eigen-Backoff
- **Höflichkeitspausen** zwischen Chunks/Seiten/Batches (300–700 ms, konfigurierbar)
- **Obergrenzen überall** (Seiten, Batches, Runden) — gegen Runaway
- HTTP-Status prüfen **und** Response-Typ prüfen (Portal liefert bei Drosselung
  gelegentlich 200 + HTML statt JSON — als erkannter Fehler, nicht als SyntaxError)
- Content-Script vs. Extension-Speicher: IndexedDB im Content-Script gehört der
  Webseite, nicht der Extension — Session-Payloads über `chrome.storage.session`

---

## 7. UI-Muster

- Floating-Widget mit **Größen-Vorschau** vor dem Export (Mini-API-Ping beim
  Seitenladen zeigt Counts/Seiten → Dauer abschätzbar)
- Ein Button pro klarer Aktion, Status im Label (Progress, Fehler, Erfolg), danach
  Reset auf die Vorschau-Anzeige
- Dashboard: Metakarte, Statistik-Kacheln als Klickfilter, Score-System, Volltextsuche,
  Export-Buttons — JS nur für Daten und API-Calls, HTML/CSS first

---

## 8. Transfer-Checkliste für ein neues Portal

```text
[ ] Discovery: interne API gefunden? Feldinventar + Verifikation in der Konsole
[ ] SSR-Payloads identifiziert (Attribute/State-Objekte) und inventarisiert
[ ] UC1: Such-/Übersichts-Struktur — IDs aus DOM, Batch-Quelle, AJAX-Pagination?
[ ] UC1: Export-Kappung + Pausen definiert (Ban-Schutz)
[ ] UC2: Gibt es eine Community-Diskussion? → A oder B wählen
[ ] UC2: Feldliste der Einzelseite komplett (Beschreibung, Attribute, Bilder, Akteur)
[ ] Export: _meta-Block, JSON + MD, Link-Strategie, Permalink-Formate
[ ] Robustheit: Retry/Backoff, Pausen, 200+HTML-Erkennung
[ ] Doku: Datenwahrheiten + Grenzen ehrlich ins README
```
