#!/usr/bin/env node
// Schrift-Skala überall. Ersetzt feste Tailwind-Schriftgrößen in apps/web/src/**/*.{ts,tsx}
// durch die Stufen aus apps/web/src/app.css (docs/UI.md, „Schrift“).
//
// Wiederholbar und idempotent:
//   node scripts/lint/typography.mjs --check   → listet verbleibende feste Größen (Exit 1, wenn welche da sind)
//   node scripts/lint/typography.mjs --apply   → ersetzt, danach meldet --check 0
//   Optional: --all (auch die Dateien in PENDING), --exclude <glob> (mehrfach; relativ zu apps/web/src),
//             --root <ordner> (Standard: Repo-Wurzel), --quiet, oder eine Dateiliste (dann genau diese Dateien).
//
// Zuordnung (px → Stufe), mindestens 11 px für Text:
//   < 11,5 (8–11)       → text-label    11
//   11,5–12,5           → text-caption  12
//   13–14               → text-callout  13,5
//   14,5–16,5           → text-headline 15
//   17–23               → text-title2   20
//   ≥ 24                → text-title    28
//   Tailwind-Standard: xs → caption · sm → callout · base → headline · lg/xl → title2 · 2xl … 9xl → title
//
// Bewusste Ausnahmen (bleiben fest, Lint-Regel sieht sie genauso):
//   - Zeile (oder die Zeile davor) enthält einen Kommentar mit „typo-keep“ – für Zahlen/Glyphen in
//     winzigen Ringen oder Kästchen, die nicht mitwachsen können. Bitte mit Grund: `/* typo-keep: Zahl im 18-px-Ring */`.
//   - Große Kennzahl-Werte: ≥ 26 px in einer Zeile mit `tabular-nums` (KPI-Kacheln, Git-Zähler).
//   - Kommentarzeilen werden nie angefasst. Relative Größen (`text-[0.9em]`) und Farben (`text-[var(--…)]`) auch nicht.
//
// PENDING: Dateien, an denen gerade parallel gearbeitet wird. Sie laufen standardmäßig NICHT mit,
// und die Lint-Regel (eslint.config.js) spart sie aus. Nach dem Zusammenführen nachziehen:
//   node scripts/lint/typography.mjs --apply --all   → danach PENDING hier leeren (dann prüft auch die Lint-Regel alles).
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WEB_SRC = "apps/web/src";

/** Relativ zu apps/web/src. Nach dem Nachziehen leeren (leer = die Regel gilt überall). */
export const PENDING = [];

const STANDARD = {
  xs: "caption",
  sm: "callout",
  base: "headline",
  lg: "title2",
  xl: "title2",
};

/** px → Stufenname der Skala. */
export function scaleForPx(px) {
  if (px < 11.5) return "label";
  if (px < 13) return "caption";
  if (px < 14.5) return "callout";
  if (px < 17) return "headline";
  if (px < 24) return "title2";
  return "title";
}

/** Tailwind-Standardgröße (xs, sm, …, 9xl) → Stufenname. */
export function scaleForStandard(name) {
  if (STANDARD[name]) return STANDARD[name];
  if (/^[2-9]xl$/.test(name)) return "title";
  return null;
}

/** Größter Wert, der als „große Kennzahl“ fest bleiben darf (mit tabular-nums in derselben Zeile). */
export const KEY_FIGURE_MIN_PX = 26;

// Klasse `text-[12px]` / `text-[10.5px]` / `text-xs` (auch mit Varianten `sm:`, `@md:`, `!`, Suffix `/6`).
// Nicht: `text-[0.9em]`, `text-[var(--a-claude)]`, `text-xs-foo`, `max-text-sm`.
export const FIXED_SIZE_RE = /(?<![\w-])text-(?:\[(\d+(?:\.\d+)?)px\]|(xs|sm|base|lg|xl|[2-9]xl))(?![\w\-[\]])/g;

const KEEP_MARK = "typo-keep";

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

/** Bleibt diese Fundstelle bewusst fest? (Gleiche Logik in Codemod und Lint-Regel.) */
export function isKept({ px, line, prevLine }) {
  if (line.includes(KEEP_MARK)) return true;
  if (prevLine !== undefined && isCommentLine(prevLine) && prevLine.includes(KEEP_MARK)) return true;
  // JSX-Kommentar in eigener Zeile: {/* typo-keep: … */}
  if (prevLine !== undefined && /^\s*\{\s*\/\*.*typo-keep.*\*\/\s*\}\s*$/.test(prevLine)) return true;
  if (px !== null && px >= KEY_FIGURE_MIN_PX && /(?<![\w-])tabular-nums(?![\w-])/.test(line)) return true;
  return false;
}

/** Ersatz für einen Treffer von FIXED_SIZE_RE (ohne Ausnahmeprüfung). */
export function replacementFor(pxText, standard) {
  const scale = pxText !== undefined ? scaleForPx(Number(pxText)) : scaleForStandard(standard);
  return scale ? `text-${scale}` : null;
}

/**
 * Alle zu ersetzenden Fundstellen in einer Quelle.
 * @returns {{ line: number, col: number, from: string, to: string }[]} (line/col 1-basiert)
 */
export function findFixedSizes(source) {
  const lines = source.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const m of line.matchAll(FIXED_SIZE_RE)) {
      const px = m[1] !== undefined ? Number(m[1]) : null;
      if (isKept({ px, line, prevLine: i > 0 ? lines[i - 1] : undefined })) continue;
      const to = replacementFor(m[1], m[2]);
      if (to) out.push({ line: i + 1, col: (m.index ?? 0) + 1, from: m[0], to });
    }
  });
  return out;
}

/** Ersetzt alle Fundstellen. Idempotent: ein zweiter Lauf ändert nichts. */
export function transformSource(source) {
  const lines = source.split("\n");
  let count = 0;
  const next = lines.map((line, i) => {
    if (isCommentLine(line)) return line;
    const prevLine = i > 0 ? lines[i - 1] : undefined;
    return line.replace(FIXED_SIZE_RE, (whole, pxText, standard) => {
      const px = pxText !== undefined ? Number(pxText) : null;
      if (isKept({ px, line, prevLine })) return whole;
      const to = replacementFor(pxText, standard);
      if (!to) return whole;
      count++;
      return to;
    });
  });
  return { text: next.join("\n"), count };
}

// ── Dateien ───────────────────────────────────────────────────────────────────────────────────────

/** Einfache Glob-Auflösung: `**` = beliebig viele Ordner, `*` = innerhalb eines Namens. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const IS_SOURCE = (name) => /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name);

function walk(dir, accept = IS_SOURCE) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, accept));
    else if (accept(name)) out.push(p);
  }
  return out;
}

/** Alle .css unter apps/web/src (für die Prüfung „font-size unter 11 px“, P4a). */
export function listCssFiles({ root = REPO_ROOT } = {}) {
  const base = join(root, WEB_SRC);
  return walk(base, (name) => name.endsWith(".css"))
    .map((abs) => ({ abs, rel: relative(base, abs).split(sep).join("/") }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── Feste Zahl-Größen unter 11 px (R2 · P4a, L5 Punkt 8) ──────────────────────────────────────────
// Die Klassen-Regel oben sah `style={{ fontSize: 10.5 }}` (SVG-Achsen) und CSS-Dateien nicht.

/** Kleinste erlaubte feste Schriftgröße in px (= text-label). */
export const MIN_TEXT_PX = 11;

/** „10.5“, „10.5px“, 10.5 → 10.5; „0.9em“, „var(--text-label)“ → null (relativ bzw. Skala). */
export function pxOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(value);
  return m ? Number(m[1]) : null;
}

/**
 * CSS: `font-size: <n>px` unter 11 px ohne `typo-keep` (in der Zeile oder als Kommentar davor).
 * @returns {{ line: number, px: number }[]} (1-basiert)
 */
export function findSmallCssFontSizes(source) {
  const lines = source.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const m of line.matchAll(/(?<![\w-])font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) {
      const px = Number(m[1]);
      if (px >= MIN_TEXT_PX) continue;
      if (isKept({ px, line, prevLine: i > 0 ? lines[i - 1] : undefined })) continue;
      out.push({ line: i + 1, px });
    }
  });
  return out;
}

/** Dateien im Umfang: alle .ts/.tsx unter apps/web/src ohne `exclude` (Globs relativ zu apps/web/src). */
export function listFiles({ root = REPO_ROOT, exclude = [] } = {}) {
  const base = join(root, WEB_SRC);
  const res = exclude.map(globToRegExp);
  return walk(base)
    .map((abs) => ({ abs, rel: relative(base, abs).split(sep).join("/") }))
    .filter(({ rel }) => !res.some((re) => re.test(rel)))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Lauf über den Umfang. `files` (absolute Pfade) überschreibt die Auswahl.
 * @returns {{ mode: string, files: number, hits: { file: string, line: number, col: number, from: string, to: string }[], changed: number }}
 */
export function run({ mode = "check", root = REPO_ROOT, all = false, exclude = [], files = null } = {}) {
  const selected = files
    ? files.map((abs) => ({ abs, rel: relative(join(root, WEB_SRC), abs).split(sep).join("/") }))
    : listFiles({ root, exclude: [...(all ? [] : PENDING), ...exclude] });
  const hits = [];
  let changed = 0;
  for (const { abs, rel } of selected) {
    const src = readFileSync(abs, "utf8");
    const found = findFixedSizes(src);
    for (const h of found) hits.push({ file: rel, ...h });
    if (mode === "apply" && found.length > 0) {
      const { text, count } = transformSource(src);
      if (text !== src) writeFileSync(abs, text);
      changed += count;
    }
  }
  return { mode, files: selected.length, hits, changed };
}

// ── ESLint-Regel (eslint.config.js: Plugin „typo“, Regel „no-fixed-font-size“) ───────────────────────

const noFixedFontSize = {
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: { description: "Schrift nur aus der Skala (text-title … text-label), keine festen Größen" },
    messages: {
      fixed: "Feste Schriftgröße „{{from}}“ – bitte „{{to}}“ aus der Skala nutzen (docs/UI.md). Bewusste Ausnahme: Kommentar „typo-keep“.",
      smallNumber:
        "Schriftgröße {{px}} px liegt unter 11 px – bitte die Skala nutzen: Klasse „text-label“ oder fontSize: \"var(--text-label)\" (docs/UI.md). Bewusste Ausnahme: Kommentar „typo-keep“.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const lines = sourceCode.lines;
    function check(node, raw, startOffset) {
      for (const m of raw.matchAll(FIXED_SIZE_RE)) {
        const offset = startOffset + (m.index ?? 0);
        const loc = sourceCode.getLocFromIndex(offset);
        const line = lines[loc.line - 1] ?? "";
        const prevLine = loc.line > 1 ? lines[loc.line - 2] : undefined;
        const px = m[1] !== undefined ? Number(m[1]) : null;
        if (isKept({ px, line, prevLine })) continue;
        const to = replacementFor(m[1], m[2]);
        if (!to) continue;
        context.report({
          node,
          loc: { start: loc, end: sourceCode.getLocFromIndex(offset + m[0].length) },
          messageId: "fixed",
          data: { from: m[0], to },
          fix: (fixer) => fixer.replaceTextRange([offset, offset + m[0].length], to),
        });
      }
    }
    // P4a: `fontSize: 10.5` / `fontSize: "10px"` in Objekten (style, Stil-Konstanten) und `fontSize={9}` an SVG-Elementen.
    function checkSmall(node, valueNode) {
      let v = valueNode;
      if (v?.type === "JSXExpressionContainer") v = v.expression;
      if (v?.type !== "Literal") return; // Ausdrücke (Math.max(…), Variablen) prüft die Regel nicht
      const px = pxOf(v.value);
      if (px === null || px >= MIN_TEXT_PX) return;
      const loc = v.loc.start;
      const line = lines[loc.line - 1] ?? "";
      const prevLine = loc.line > 1 ? lines[loc.line - 2] : undefined;
      if (isKept({ px, line, prevLine })) return;
      context.report({ node, loc: v.loc, messageId: "smallNumber", data: { px: String(px).replace(".", ",") } });
    }
    const isFontSizeKey = (key) => (key?.type === "Identifier" && key.name === "fontSize") || (key?.type === "Literal" && (key.value === "fontSize" || key.value === "font-size"));
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        check(node, sourceCode.getText(node), node.range[0]);
      },
      TemplateElement(node) {
        check(node, sourceCode.getText(node), node.range[0]);
      },
      Property(node) {
        if (node.computed || !isFontSizeKey(node.key)) return;
        checkSmall(node, node.value);
      },
      JSXAttribute(node) {
        const name = node.name?.type === "JSXIdentifier" ? node.name.name : null;
        if (name !== "fontSize" && name !== "font-size") return;
        checkSmall(node, node.value);
      },
    };
  },
};

export const eslintPlugin = { meta: { name: "typo" }, rules: { "no-fixed-font-size": noFixedFontSize } };

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: "check", root: REPO_ROOT, all: false, exclude: [], files: [], quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.mode = "check";
    else if (a === "--apply") opts.mode = "apply";
    else if (a === "--all") opts.all = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--root") opts.root = resolve(argv[++i] ?? ".");
    else if (a === "--exclude") opts.exclude.push(argv[++i] ?? "");
    else if (a.startsWith("--")) throw new Error(`Unbekannte Option ${a}`);
    else opts.files.push(resolve(a));
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const res = run({ ...opts, files: opts.files.length > 0 ? opts.files : null });
  if (opts.mode === "apply") {
    console.log(`typography: ${res.changed} Stellen ersetzt in ${new Set(res.hits.map((h) => h.file)).size} Dateien (${res.files} geprüft).`);
    const after = run({ ...opts, mode: "check", files: opts.files.length > 0 ? opts.files : null });
    if (after.hits.length > 0) {
      console.error(`typography: nach --apply noch ${after.hits.length} Stellen offen.`);
      process.exit(1);
    }
    return;
  }
  if (!opts.quiet) for (const h of res.hits) console.log(`${WEB_SRC}/${h.file}:${h.line}:${h.col}  ${h.from} → ${h.to}`);
  console.log(`typography --check: ${res.hits.length} feste Schriftgrößen (${res.files} Dateien geprüft${opts.all ? "" : ", ohne PENDING"}).`);
  if (res.hits.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
