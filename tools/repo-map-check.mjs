#!/usr/bin/env node
// tools/repo-map-check.mjs — Budget-Gate des Repository-Cockpits.
// Prüft drei Invarianten:
//   1. Zeilenbudgets: AGENTS.md <= 70, map.md <= 100.
//   2. Modulgröße [anchor:deep-modules]: content/*.js und ui/*.js liegen
//      zwischen 15 und 40 KiB. Kleinere Dateien sind Shallow Modules und
//      kosten Tool-Call-Zersplitterung; größere sprengen den Kontext-Hop.
//      Geprüft werden nur content/ und ui/ — service-worker.js liegt im
//      Wurzelverzeichnis (MV3 verlangt genau eine Datei) und ist bewusst
//      schlank; HTML-Dateien unterliegen dem Gate nicht.
//   3. Der `shared-bootstrap`-Block ist in content.js und listing.js
//      byte-identisch (Zero-Build erlaubt keine Imports).
// Inhaltliche Korrektheit ist Review-Aufgabe, nicht Aufgabe dieses Gates.
// Aufruf: node tools/repo-map-check.mjs   (Exit 1 bei Verstoß)

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGETS = [
  ['AGENTS.md', 70],
  ['map.md', 100],
];

// 15–40 KiB (1024er-Basis) — Dateigröße, nicht Zeilen, weil das die
// tatsächliche Kontext-/Tool-Call-Kosten bestimmt.
const MODULE_MIN = 15 * 1024;
const MODULE_MAX = 40 * 1024;
const MODULE_DIRS = ['content', 'ui'];

let failed = 0;

for (const [file, max] of BUDGETS) {
  const full = path.join(ROOT, file);
  if (!existsSync(full)) {
    console.error(`✗ FEHLT: ${file}`);
    failed++;
    continue;
  }
  const lines = readFileSync(full, 'utf8').replace(/\n$/, '').split('\n').length;
  if (lines > max) {
    console.error(`✗ BUDGET-OVERFLOW: ${file} hat ${lines} Zeilen (Limit: ${max}).`);
    failed++;
  } else {
    console.log(`✓ ${file}: ${lines}/${max} Zeilen`);
  }
}

for (const dir of MODULE_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs).filter(n => n.endsWith('.js')).sort()) {
    const rel = `${dir}/${name}`;
    const size = statSync(path.join(abs, name)).size;
    if (size < MODULE_MIN || size > MODULE_MAX) {
      console.error(`✗ MODULGRÖSSE: ${rel} hat ${(size / 1024).toFixed(1)} KiB ` +
        `(Soll 15–40 KiB, [anchor:deep-modules]).`);
      failed++;
    } else {
      console.log(`✓ ${rel}: ${(size / 1024).toFixed(1)} KiB (15–40)`);
    }
  }
}

const regionOf = (rel) => {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  const src = readFileSync(full, 'utf8');
  const startTag = '// #region shared-bootstrap';
  const endTag = '// #endregion shared-bootstrap';
  const start = src.indexOf(startTag);
  const end = src.indexOf(endTag);
  if (start < 0 || end < start) return null;
  return src.slice(start, end + endTag.length);
};

const sharedA = regionOf('content/content.js');
const sharedB = regionOf('content/listing.js');
if (!sharedA || !sharedB) {
  console.error('✗ SHARED-BOOTSTRAP: Region fehlt in content/content.js oder content/listing.js.');
  failed++;
} else if (sharedA !== sharedB) {
  console.error('✗ SHARED-BOOTSTRAP-DRIFT: Der gemeinsame Block ist nicht byte-identisch. ' +
    'Beide Dateien aus einer Quelle patchen.');
  failed++;
} else {
  console.log(`✓ shared-bootstrap: ${(sharedA.length / 1024).toFixed(1)} KiB identisch in content.js + listing.js`);
}

if (failed > 0) {
  console.error(`\n❌ Cockpit-/Modul-Gate: ${failed} Problem(e).`);
  process.exit(1);
}

console.log('\n✓ Cockpit-/Modul-Gate grün.');
