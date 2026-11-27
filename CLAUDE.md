---
status: active
type: instructions
tags: [multi-ai, pointer, routing]
summary: "Ein-Schritt-Zeiger für Claude / Claude Code auf AGENTS.md und map.md; enthält bewusst keine eigenen Regeln."
---

# CLAUDE.md — Einstieg für Claude / Claude Code

**MyDealzExporter** — Chrome-Extension (Manifest V3, Vanilla JS, kein Build) für mydealz.de.

## Verbindlicher Leitfaden (1-Schritt O(1)-Routing)

1. Vor jeder Aktion zuerst [`AGENTS.md`](AGENTS.md) (Invarianten, Gates, Testbefehle) und
   [`map.md`](map.md) (Task-to-File-Matrix) lesen.
2. Dann genau die dort genannte Datei öffnen — kein `grep -r`, kein Ratesuchen.

## Verifikation
`node tools/repo-map-check.mjs` — Cockpit-Budget-Gate (muss grün sein).
