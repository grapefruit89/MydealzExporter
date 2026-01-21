# 🧠 MyDealz Exporter - PROJEKT BLUEPRINT

Dieses Dokument dient als "Gehirn" des Projekts. Es enthält die Architektur, unveränderliche Regeln und den aktuellen Status.

## 🏗️ Architektur & Workflow

Das Projekt ist **modular** aufgebaut, um die Übersichtlichkeit zu behalten. Der Browser benötigt jedoch eine **einzelne Datei**.

### Struktur
- **`MydealzExporter/logic.js`**: Die gesamte Programmlogik.
- **`MydealzExporter/meta.js`**: Der Userscript-Header (Version, Berechtigungen).
- **`MydealzExporter/styles.css`**: Das Design (CSS).
- **`MydealzExporter/template.html`**: Das UI-Gerüst (HTML).

### ⚙️ Build Prozess (ZWINGEND)
Da MyDealz externe Skripte blockiert, **muss** immer gebaut werden:
1.  **Doppelklick** auf `build.bat` (führt `build_userscript.py` aus).
2.  Die Module werden in `mydealz_exporter_v13.js` zusammengefügt.
3.  **Inhalt kopieren** und in OrangeMonkey/Violentmonkey einfügen.

---

## 🚫 WICHTIGE REGELN & EINSCHRÄNKUNGEN (NICHT ÄNDERN!)

### 1. Content Security Policy (CSP) - "Blob Error" / "Unsafe Eval"
Die Webseite blockiert strikt unsicheren Code.
*   ❌ **VERBOTEN**: `eval()`, `new Function()`, `innerHTML` mit `<script>` oder `onclick="..."`.
*   ❌ **VERBOTEN**: Laden von lokalen Dateien via `file:///` oder `blob:` URLs (daher geht der "Live-Dev-Loader" nicht).
*   ✅ **LÖSUNG**: 
    *   HTML ist "dumm" (nur IDs, keine Variablen wie `${...}`).
    *   Daten werden in `logic.js` über `populateUi()` und `document.getElementById(...).textContent = ...` eingefügt.
    *   Styles und HTML werden als Strings direkt in das Skript "gebacken".

### 2. Prompting Regeln
*   ❌ **VERBOTEN**: System-Prompts oder Rollenzuweisungen (`# Role: ...`).
*   ✅ **ERLAUBT**: Nur nackte Daten (Metadaten, Kommentare) an die AI senden. Der User entscheidet, was er fragt.

### 4. UI / UX Regeln (STRENG!)
*   ❌ **VERBOTEN**: Native Browser-Modals (`alert()`, `confirm()`, `prompt()`). Die unterbrechen den Workflow.
*   ✅ **GEBOTEN**:
    *   Fehler/Infos als **Toast** anzeigen.
    *   **Jeder Toast** muss auch in den **Logger/Konsole** geschrieben werden (`console.log` / `Logger.add`).
    *   Für Bestätigungen (z.B. Reset) Buttons nutzen, die ihren Text ändern ("Sicher?" beim zweiten Klick).

---

## ✅ Status Quo (Was funktioniert)

*   **Export**: Extrahiert Thread-Titel, Preis, Händler, OP, und alle Kommentare (rekursiv).
*   **Caching**: Speichert Ergebnisse lokal (`localStorage`), um API-Limits zu schonen.
*   **UI**: Schickes Overlay mit Tabs, Copy-Button und Download (.md/.json).
*   **AI-Integration**: Sendet Kontext an Gemini und zeigt Antwort sauber formatiert (Markdown) an.

## 🛠️ Wartung & Erweiterung

Wenn Änderungen gemacht werden:
1.  Immer in den **Modulen** (`MydealzExporter/`) arbeiten. niemals im Build-Output.
2.  In `template.html` **nur** IDs vergeben, keine Logik einbauen.
3.  In `logic.js` die Funktion `populateUi()` erweitern, um neue Daten anzuzeigen.
4.  Immer `build.bat` ausführen zum Testen.

---
*Letztes Update: 2026-01-20*
