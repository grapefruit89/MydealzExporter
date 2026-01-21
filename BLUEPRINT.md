# 🧠 MyDealz AI Exporter - PROJECT BLUEPRINT (v14)

Architecture: Monolithic Userscript (Single File)
Target: Violentmonkey / Tampermonkey
Language: JavaScript (ES6+)

## 🏗️ Core Architecture
Das Script ist ein "Hybrid": Es nutzt die robuste Technik von v13 und das visuelle Dashboard von v12.

1. **Network Layer (CORS Bypass)**
   - ZWINGEND `GM_xmlhttpRequest` nutzen (wrapped als `gmFetch`).
   - Header: `// @connect generativelanguage.googleapis.com`.
   - Grund: Umgeht die Browser-Sicherheitsrichtlinien für API-Calls zu Google.

2. **Data & Storage**
   - **Cache**: `localStorage` (Key: `mydealz_cache_v14_...`). Kein IndexedDB (Overkill).
   - **Scraper**: Rekursives Auslesen des `unsafeWindow.__INITIAL_STATE__`.
   - **Sanitizer**: `DOMPurify` (via `@require`) für HTML-Cleaning.

3. **AI Logic (Smart Filter)**
   - API: Google Gemini (`generativelanguage.googleapis.com`).
   - **Modell-Selektor**: 
     - Filtert sinnlose Modelle (TTS, Vision, Nano) raus.
     - Sortiert intelligent: **Flash** Modelle immer zuerst (Speed!), danach **Pro**, sortiert nach Version (neueste oben).

4. **UI / UX Guidelines**
   - **Visuals**: Dashboard-Design oben fixiert.
   - **Tacho (Speedometer)**: Visuelle Anzeige der Token-Last (Grün -> Rot).
   - **Input**: `<textarea>` statt `contenteditable` (Performance-Fix für große Threads!).
   - **Notifications**: ❌ KEINE `alert()` oder `confirm()` (Native Modals). ✅ NUR Custom Toasts (Non-blocking).
   - **Watchdog**: Ein `setInterval` muss prüfen, ob der Button durch SPA-Navigation gelöscht wurde, und ihn neu zeichnen.
