#!/usr/bin/env node
// Checks that every text wrapped in t("…") has an English translation in packages/shared/src/i18n/en/*.ts,
// and that no German key has two different English translations in two dictionary files (use tc() for that).
// Only literal first arguments are checked (t(variable) cannot be checked statically).
//   node scripts/check-i18n.mjs          report and exit 1 if something is missing or conflicting
//   node scripts/check-i18n.mjs --list   also list the missing texts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["apps/web/src", "apps/server/src", "apps/bridge/src", "packages/shared/src"];
const DICT_DIR = join(root, "packages/shared/src/i18n/en");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "i18n") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Reads a JS string literal starting at `i` (quote char at s[i]); returns [value, endIndex]. */
function readString(s, i) {
  const q = s[i];
  let out = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      const n = s[j + 1];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
      j++;
    } else if (c === q) return [out, j];
    else if (q === "`" && c === "$" && s[j + 1] === "{") return [null, j];
    else out += c;
  }
  return [null, s.length];
}

/** Key → English value of one dictionary file (value null when it is not a plain string literal). */
function entriesOfDict(file) {
  const s = readFileSync(file, "utf8");
  const entries = new Map();
  const re = /^\s*(["'`])/gm;
  let m;
  while ((m = re.exec(s))) {
    const [key, end] = readString(s, m.index + m[0].length - 1);
    if (key === null) continue;
    const colon = /^\s*:\s*(["'`])/.exec(s.slice(end + 1));
    if (!colon) {
      if (/^\s*:/.test(s.slice(end + 1, end + 4))) entries.set(key, null);
      continue;
    }
    const [value] = readString(s, end + 1 + colon[0].length - 1);
    entries.set(key, value);
  }
  return entries;
}

// All dictionaries are merged into one object, so the same German key with two different English values in two
// files means one area silently gets the other area's English. Such conflicts must be resolved with tc().
const dict = new Set();
const seen = new Map(); // key → [{ file, value }]
for (const f of readdirSync(DICT_DIR).sort()) {
  if (!f.endsWith(".ts") || f === "index.ts") continue;
  for (const [k, v] of entriesOfDict(join(DICT_DIR, f))) {
    dict.add(k);
    const list = seen.get(k) ?? [];
    list.push({ file: f, value: v });
    seen.set(k, list);
  }
}
const conflicts = [...seen].filter(([, list]) => new Set(list.map((e) => e.value)).size > 1);

const missing = new Map();
let used = 0;
for (const base of SOURCES) {
  for (const file of walk(join(root, base))) {
    const s = readFileSync(file, "utf8");
    const re = /\bt\(\s*(["'`])/g;
    let m;
    while ((m = re.exec(s))) {
      const [key] = readString(s, m.index + m[0].length - 1);
      if (key === null) continue;
      used++;
      if (!dict.has(key)) missing.set(key, relative(root, file));
    }
    // tc("context", "Text"): the context entry or the plain entry must exist.
    const rc = /\btc\(\s*(["'`])/g;
    while ((m = rc.exec(s))) {
      const [ctx, end] = readString(s, m.index + m[0].length - 1);
      const rest = s.slice(end + 1);
      const q = /^\s*,\s*(["'`])/.exec(rest);
      if (ctx === null || !q) continue;
      const [key] = readString(rest, q[0].length - 1);
      if (key === null) continue;
      used++;
      if (!dict.has(`${ctx}::${key}`) && !dict.has(key)) missing.set(`${ctx}::${key}`, relative(root, file));
    }
  }
}
console.log(
  `i18n: ${used} t() calls, ${dict.size} English entries, ${missing.size} texts without English, ${conflicts.length} conflicting translations`,
);
if (process.argv.includes("--list")) for (const [k, f] of missing) console.log(`  ${f}: ${JSON.stringify(k)}`);
// Conflicts are always listed: they are rarely many and each one needs a decision.
for (const [k, list] of conflicts) {
  console.log(`  conflict ${JSON.stringify(k)}: ${list.map((e) => `${e.file.replace(/\.ts$/, "")}=${JSON.stringify(e.value)}`).join(", ")}`);
}
process.exit(missing.size > 0 || conflicts.length > 0 ? 1 : 0);
