#!/usr/bin/env node
// Kürzt eine echte Verlaufsdatei zu einer Test-Beispieldatei.
// Aufruf: node scripts/make-fixture.mjs <quelle.jsonl> <ziel.jsonl> [zeilenfilter.js-Ausdruck]
// - jede Zeichenkette > 300 Zeichen wird gekürzt
// - verschlüsselte Inhalte werden ersetzt
// - bricht ab, wenn etwas nach einem Geheimnis aussieht
import { readFileSync, writeFileSync } from "node:fs";

const [src, dst, filterExpr] = process.argv.slice(2);
if (!src || !dst) {
  console.error("Aufruf: make-fixture.mjs <quelle> <ziel> [filter]");
  process.exit(2);
}
const MAX = 300;
const filter = filterExpr ? new Function("o", "i", `return (${filterExpr});`) : () => true;
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|POSTGRES_PASSWORD=\S+|password["':= ]+[^\s"']{6,})/i;

function shrink(v, key) {
  if (typeof v === "string") {
    if (key === "encrypted_content" || key === "signature") return "[gekürzt]";
    return v.length > MAX ? v.slice(0, MAX) + "…" : v;
  }
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => shrink(x));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = shrink(x, k);
    return out;
  }
  return v;
}

const lines = readFileSync(src, "utf8").split("\n").filter(Boolean);
const out = [];
lines.forEach((l, i) => {
  const o = JSON.parse(l);
  if (!filter(o, i)) return;
  const s = JSON.stringify(shrink(o));
  const m = s.match(SECRET);
  if (m) {
    console.error(`Mögliches Geheimnis in Zeile ${i + 1}: ${m[0].slice(0, 12)}… — abgebrochen`);
    process.exit(1);
  }
  out.push(s);
});
writeFileSync(dst, out.join("\n") + "\n");
console.log(`${out.length} von ${lines.length} Zeilen → ${dst}`);
