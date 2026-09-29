#!/usr/bin/env node
// Die NyxOS-Karte – automatisch aus dem Code, nie von Hand gepflegt (sonst veraltet sie).
// Liest per TypeScript-Syntaxbaum: Leiste (`apps/web/src/nav.ts`), Routen (`App.tsx`), Seitenzweck (`pageInfo.ts`),
// Einstellungs-Register (`features/settings/sections.tsx` mit parent/spots/Panels), alle `data-nyx`-Kennungen je Seite
// (statischer Scan über den Import-Graphen), API-Zwecke (`apps/server/src/nyx/appApi/catalog.ts`) und alle DB-Tabellen
// mit Spalten (`apps/server/src/db/schema.ts`, JSDoc = Beschreibung). Ergebnis: `apps/server/src/nyx/map/nyxosMap.generated.ts`.
//
//   node scripts/nyxos-map.mjs          → Karte neu schreiben
//   node scripts/nyxos-map.mjs --check  → Exit 1, wenn die Karte veraltet ist oder einer Seite der Zweck fehlt
// Der Server-Build (`apps/server/build.mjs`) schreibt sie vor dem Bündeln neu; der Test `r5-nyx-karte` prüft beides.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MAP_OUT = "apps/server/src/nyx/map/nyxosMap.generated.ts";
const WEB = "apps/web/src";

const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const parse = (root, rel) => ts.createSourceFile(rel, read(root, rel), ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

/** Name einer Objekt-Eigenschaft (Bezeichner oder String). */
const propName = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);

/** Wert eines Ausdrucks als einfacher JS-Wert (Strings, Zahlen, Arrays, Objekte); Unbekanntes → undefined. */
function literal(node, consts = {}) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node) && node.text in consts) return consts[node.text];
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) {
      const v = literal(span.expression, consts);
      s += (typeof v === "string" ? v : "<…>") + span.literal.text;
    }
    return s;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => literal(e, consts)).filter((v) => v !== undefined);
  if (ts.isObjectLiteralExpression(node)) {
    const o = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const k = propName(p);
      if (!k) continue;
      const v = literal(p.initializer, consts);
      o[k] = v === undefined ? { __expr: p.initializer.getText() } : v;
    }
    return o;
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, consts);
  // Übersetzte Texte `t("…")` / `tc("…", "Zusammenhang")`: der deutsche Quelltext ist der Schlüssel.
  if (ts.isCallExpression(node) && /^(t|tc)$/.test(node.expression.getText()) && node.arguments[0]) return literal(node.arguments[0], consts);
  return undefined;
}

/** Englisches Wörterbuch (packages/shared/src/i18n/en/*.ts): deutscher Quelltext → Englisch. */
function readDictionary(root) {
  const dir = "packages/shared/src/i18n/en";
  const out = new Map();
  if (!existsSync(join(root, dir))) return out;
  for (const name of readdirSync(join(root, dir)).sort()) {
    if (!name.endsWith(".ts") || name === "index.ts") continue;
    const sf = parse(root, `${dir}/${name}`);
    walk(sf, (n) => {
      if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name) && ts.isStringLiteral(n.initializer) && !out.has(n.name.text)) out.set(n.name.text, n.initializer.text);
    });
  }
  return out;
}

/** Top-level `const X = "…"` einer Datei (für Pfad-Konstanten wie NYX_SETTINGS_PATH). */
function stringConsts(sf) {
  const out = {};
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteral(d.initializer)) out[d.name.text] = d.initializer.text;
  }
  return out;
}

/** Initialisierer einer top-level Variable. */
function topConst(sf, name) {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer;
  }
  return undefined;
}

/** Alte Namen in Code-Kommentaren (Oberfläche „Zentrale“, Assistent „Haiku“) – Nyx liest die Karte und nennt sich Nyx. */
const currentNames = (s) => s.replace(/\bHaikus\b/g, "Nyx'").replace(/\bHaiku\b(?![- ]?\d)/g, "Nyx").replace(/\bZentrale\b/g, "NyxOS").replace(/"zentrale"/g, "„NyxOS“");

/** JSDoc bzw. Zeilen-Kommentar direkt vor einem Knoten, als ein Satz. */
function leadingComment(sf, node) {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const text = ranges
    .map((r) => sf.text.slice(r.pos, r.end))
    .join("\n")
    .replace(/^\/\*\*?|\*\/$/gm, "")
    .replace(/^\s*(\*|\/\/)\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return currentNames(text) || null;
}

// ───────────── Web: Leiste, Routen, Seitenzweck ─────────────

function readNav(root) {
  const sf = parse(root, `${WEB}/nav.ts`);
  const out = [];
  walk(sf, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const o = literal(n);
    if (o && typeof o.id === "string" && typeof o.label === "string" && o.status === "active" && typeof o.path === "string") out.push({ id: o.id, label: o.label, path: o.path });
  });
  return out;
}

function readPageInfo(root) {
  const sf = parse(root, `${WEB}/pageInfo.ts`);
  const init = topConst(sf, "PAGE_INFO");
  return literal(init) ?? {};
}

/** `<Route path="…" element={<X …/>}>` aus App.tsx: Pfad → Komponenten-Name. */
function readAppRoutes(root) {
  const sf = parse(root, `${WEB}/App.tsx`);
  const routes = [];
  walk(sf, (n) => {
    if (!(ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) || n.tagName.getText() !== "Route") return;
    let path = null;
    let component = null;
    for (const a of n.attributes.properties) {
      if (!ts.isJsxAttribute(a) || !a.initializer) continue;
      const name = a.name.getText();
      if (name === "path" && ts.isStringLiteral(a.initializer)) path = a.initializer.text;
      if (name === "element") {
        // Erste Komponente im Element, die keine Hülle ist (LazyView/Navigate zählen nicht als Seite).
        walk(a.initializer, (e) => {
          if (component || !(ts.isJsxSelfClosingElement(e) || ts.isJsxOpeningElement(e))) return;
          const tag = e.tagName.getText();
          if (tag !== "LazyView") component = tag;
        });
      }
    }
    if (path && component !== "Navigate") routes.push({ path, component });
  });
  return { routes, imports: importMap(sf, `${WEB}/App.tsx`, root) };
}

// ───────────── Import-Graph + data-nyx-Scan ─────────────

function resolveImport(fromRel, spec, root) {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(fromRel), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    const abs = join(root, cand);
    if (existsSync(abs) && statSync(abs).isFile()) return relative(root, abs);
  }
  return null;
}

/** Bezeichner → Datei (statische Importe und `lazy(() => import("…"))`). */
function importMap(sf, rel, root) {
  const map = {};
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const file = resolveImport(rel, st.moduleSpecifier.text, root);
      if (!file) continue;
      const nb = st.importClause?.namedBindings;
      if (st.importClause?.name) map[st.importClause.name.text] = file;
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) map[e.name.text] = file;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        walk(d.initializer, (n) => {
          if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
            const file = resolveImport(rel, n.arguments[0].text, root);
            if (file) map[d.name.text] = file;
          }
        });
      }
    }
  }
  return map;
}

function listSources(root, dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = join(dir, name);
    const st = statSync(join(root, rel));
    if (st.isDirectory()) out.push(...listSources(root, rel));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

/** Je Datei: Kennungen (data-nyx, data-nyx-item als `item:<art>`) und relative Importe. */
function scanWeb(root) {
  const files = {};
  for (const rel of listSources(root, WEB)) {
    const sf = parse(root, rel);
    const ids = new Set();
    const deps = new Set();
    walk(sf, (n) => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const f = resolveImport(rel, n.moduleSpecifier.text, root);
        if (f) deps.add(f);
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        const f = resolveImport(rel, n.arguments[0].text, root);
        if (f) deps.add(f);
      }
      if (!ts.isJsxAttribute(n) || !n.initializer) return;
      const name = n.name.getText();
      if (name !== "data-nyx" && name !== "data-nyx-item") return;
      const values = [];
      if (ts.isStringLiteral(n.initializer)) values.push(n.initializer.text);
      else if (ts.isJsxExpression(n.initializer) && n.initializer.expression) {
        const e = n.initializer.expression;
        const v = literal(e);
        if (typeof v === "string") values.push(v);
        else walk(e, (x) => {
          if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateExpression(x)) {
            const s = literal(x);
            if (typeof s === "string" && s && !s.includes(" ")) values.push(s);
          }
        });
      }
      for (const v of values) {
        const id = name === "data-nyx-item" ? `item:${v}` : v;
        // Rein berechnete Kennungen (`{id}`) tragen keine Information – nur, was im Code als Text steht.
        if (id && id !== "<…>") ids.add(id);
      }
    });
    files[rel] = { ids: [...ids].sort(), deps: [...deps].sort() };
  }
  return files;
}

function reachable(files, start, stop = new Set()) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const f = queue.shift();
    if (!f || seen.has(f) || stop.has(f) || !files[f]) continue;
    seen.add(f);
    queue.push(...files[f].deps);
  }
  return seen;
}

/** Nur Dateien im Ordner der Start-Datei (Feature-Ordner der Seite). */
const featureOnly = (set, start) => (start ? new Set([...set].filter((f) => f.startsWith(`${dirname(start)}/`))) : new Set());

const idsOf = (files, set) => [...new Set([...set].flatMap((f) => files[f]?.ids ?? []))].sort();

/** Pfade der API, die eine Seite aufruft (String-Literale mit `/api/…` in ihren Dateien). Nur Dateien im eigenen
 * Feature-Ordner der Seite – geteilte Bausteine (lib/, components/) rufen fast alles und würden die Liste verwässern. */
function apiCallsOf(root, set) {
  const out = new Set();
  const own = [...set].filter((f) => f.startsWith(`${WEB}/features/`) || f.startsWith(`${WEB}/routes/`));
  for (const f of own) {
    const text = read(root, f);
    for (const m of text.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/.:]+)/g)) out.add(m[1].replace(/\/$/, ""));
  }
  return [...out].sort();
}

// ───────────── Einstellungen ─────────────

function readSettings(root) {
  const rel = `${WEB}/features/settings/sections.tsx`;
  const sf = parse(root, rel);
  const consts = stringConsts(sf);
  const imports = importMap(sf, rel, root);
  /** Hüllen wie `const UsageSettingsSection = () => <UsageSettingsSheet …/>` → Datei der inneren Komponente. */
  const wrapperFile = (name) => {
    if (imports[name]) return imports[name];
    const init = topConst(sf, name);
    let inner = null;
    if (init) walk(init, (n) => {
      if (!inner && (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n))) inner = n.tagName.getText();
    });
    return inner ? (imports[inner] ?? null) : null;
  };
  const sections = [];
  for (const [list, scope] of [
    ["GENERAL_SECTIONS", "general"],
    ["NYX_SECTIONS", "nyx"],
  ]) {
    const init = topConst(sf, list);
    const arr = init && (ts.isArrayLiteralExpression(init) ? init : ts.isAsExpression(init) ? init.expression : null);
    if (!arr || !ts.isArrayLiteralExpression(arr)) throw new Error(`${list} nicht gefunden in ${rel}`);
    for (const el of arr.elements) {
      const o = literal(el, consts);
      if (!o || typeof o.id !== "string") continue;
      const panels = (Array.isArray(o.panels) ? o.panels : []).map((p) => {
        const comp = p.Component?.__expr ?? null;
        return { id: p.id, title: p.title, keywords: Array.isArray(p.keywords) ? p.keywords : [], spots: Array.isArray(p.spots) ? p.spots : [], advanced: p.advanced === true, file: comp ? wrapperFile(comp) : null };
      });
      sections.push({ scope, id: o.id, path: o.path, href: typeof o.href === "string" ? o.href : null, parent: typeof o.parent === "string" ? o.parent : null, title: o.title, summary: typeof o.summary === "string" ? o.summary : "", lead: typeof o.lead === "string" ? o.lead : "", keywords: Array.isArray(o.keywords) ? o.keywords : [], panels });
    }
  }
  return { sections, settingsPath: consts.SETTINGS_PATH ?? "/settings", nyxSettingsPath: consts.NYX_SETTINGS_PATH ?? "/einstellungen/nyx" };
}

// ───────────── Server: API-Zwecke, Tabellen ─────────────

function readApi(root) {
  const sf = parse(root, "apps/server/src/nyx/appApi/catalog.ts");
  const o = literal(topConst(sf, "ROUTE_PURPOSES")) ?? {};
  return Object.entries(o)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => {
      const [method, path] = k.split(" ");
      return { method, path, purpose: v };
    });
}

function readTables(root) {
  const rel = "apps/server/src/db/schema.ts";
  const sf = parse(root, rel);
  const tables = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      const call = d.initializer;
      if (!call || !ts.isCallExpression(call) || call.expression.getText() !== "pgTable") continue;
      const [nameArg, colsArg] = call.arguments;
      if (!nameArg || !ts.isStringLiteral(nameArg) || !colsArg || !ts.isObjectLiteralExpression(colsArg)) continue;
      const columns = [];
      for (const p of colsArg.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        // Spaltenname in der DB = erstes String-Argument des innersten Aufrufs (`text("session_id").notNull()`).
        let dbName = null;
        walk(p.initializer, (n) => {
          if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && dbName === null && /^[a-z_0-9]+$/.test(n.arguments[0].text)) dbName = n.arguments[0].text;
        });
        const note = leadingComment(sf, p);
        columns.push({ name: dbName ?? propName(p), ...(note ? { note } : {}) });
      }
      tables.push({ name: nameArg.text, description: leadingComment(sf, st) ?? "", columns });
    }
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}

// ───────────── Zusammenbau ─────────────

const clip = (s, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Längster Leisten-Eintrag, dessen Pfad ein Präfix des Seiten-Pfads ist. */
function navFor(nav, path) {
  let best = null;
  for (const n of nav) if ((path === n.path || path.startsWith(`${n.path}/`)) && (!best || n.path.length > best.path.length)) best = n;
  return best;
}

export function buildNyxosMap(root = REPO_ROOT) {
  const nav = readNav(root);
  const info = readPageInfo(root);
  const { routes, imports } = readAppRoutes(root);
  const files = scanWeb(root);
  const settings = readSettings(root);
  const api = readApi(root);
  const tables = readTables(root);
  const dict = readDictionary(root);
  /** Englische Wörter einer Seite (Titel, Zweck, Stichwörter), damit die Karte auch auf Englisch findet. */
  const english = (...texts) => [...new Set(texts.flat().filter(Boolean).flatMap((x) => String(x).split(" › ")).map((x) => dict.get(x)).filter(Boolean))].join(" · ");
  const problems = [];

  // Kennungen der Rahmen-Bausteine (Leiste, Handy-Leiste, Kopfzeile) gelten auf jeder Seite; sie stehen dort nicht noch mal.
  const shellRoots = ["components/Sidebar.tsx", "components/MobileTabBar.tsx", "components/TopBar.tsx"].map((f) => `${WEB}/${f}`).filter((f) => files[f]);
  const globalIds = idsOf(files, new Set(shellRoots));
  const globalSet = new Set(globalIds);
  const pageFiles = (start) => reachable(files, start);
  const pageIds = (set) => idsOf(files, set).filter((id) => !globalSet.has(id));

  const pages = [];
  const navPaths = new Set(nav.map((n) => n.path));
  for (const r of routes) {
    const p = info[r.path];
    if (!p || typeof p.purpose !== "string" || !p.purpose.trim()) problems.push(`Route ${r.path} hat keinen Zweck in apps/web/src/pageInfo.ts`);
    const n = navFor(nav, r.path);
    const onNav = navPaths.has(r.path);
    const clickPath = onNav && n ? [`nav:${n.id}`] : Array.isArray(p?.via) ? p.via : n ? [`nav:${n.id}`] : [];
    if (!onNav && !Array.isArray(p?.via)) problems.push(`Route ${r.path} steht nicht in der Leiste und hat keinen Klickpfad (via) in pageInfo.ts`);
    const file = r.component ? imports[r.component] : null;
    const set = file ? pageFiles(file) : new Set();
    pages.push({
      path: r.path,
      title: n && onNav ? n.label : (p?.title ?? `${n?.label ?? ""} › ${r.path.split("/").filter(Boolean).slice(1).join(" › ")}`.trim()),
      purpose: p?.purpose ?? "",
      keywords: Array.isArray(p?.keywords) ? p.keywords : [],
      nav: n?.id ?? null,
      clickPath,
      ids: pageIds(set),
      api: apiCallsOf(root, featureOnly(set, file)),
    });
  }
  for (const n of nav) {
    if (!routes.some((r) => r.path === n.path) && n.path !== settings.settingsPath) problems.push(`Leisten-Eintrag ${n.id} (${n.path}) hat keine Route in App.tsx`);
    if (n.path !== settings.settingsPath && !info[n.path]) problems.push(`Leisten-Eintrag ${n.id} (${n.path}) hat keinen Zweck in pageInfo.ts`);
  }

  // Einstellungen: Übersichten + jede Unterseite mit Klickpfad (Leiste → Zeile → ggf. Eltern-Bereich → Unterseite).
  const settingsNav = nav.find((n) => n.path === settings.settingsPath);
  const base = settingsNav ? [`nav:${settingsNav.id}`] : [];
  const byId = Object.fromEntries(settings.sections.map((s) => [s.id, s]));
  const nyxRow = settings.sections.find((s) => s.href === settings.nyxSettingsPath);
  const overviewFile = `${WEB}/features/settings/SettingsOverview.tsx`;
  pages.push({ path: settings.settingsPath, title: "Einstellungen", purpose: "Übersicht aller Einstellungen in Gruppen (Du, Arbeiten, Nyx & Modelle, System) mit Suche.", keywords: ["Settings", "Einstellung", "Optionen"], nav: settingsNav?.id ?? null, clickPath: base, ids: pageIds(pageFiles(overviewFile)), api: [] });
  if (nyxRow) pages.push({ path: settings.nyxSettingsPath, title: "Einstellungen › Nyx", purpose: nyxRow.summary || "Einstellungen für Nyx.", keywords: nyxRow.keywords, nav: settingsNav?.id ?? null, clickPath: [...base, `settings:${nyxRow.id}`], ids: [], api: [] });
  for (const s of settings.sections) {
    if (s.href) continue;
    if (!s.summary.trim()) problems.push(`Einstellungs-Bereich ${s.id} hat keine summary in sections.tsx`);
    const trail = [...base];
    if (s.scope === "nyx" && nyxRow) trail.push(`settings:${nyxRow.id}`);
    if (s.parent) {
      if (!byId[s.parent]) problems.push(`Einstellungs-Bereich ${s.id}: Eltern-Bereich ${s.parent} fehlt`);
      trail.push(`settings:${s.parent}`, `settings-sub:${s.id}`);
    } else trail.push(`settings:${s.id}`);
    const set = new Set(s.panels.flatMap((p) => (p.file ? [...pageFiles(p.file)] : [])));
    const parentTitle = s.parent ? byId[s.parent]?.title : null;
    pages.push({
      path: s.path,
      title: ["Einstellungen", s.scope === "nyx" ? "Nyx" : null, parentTitle, s.title].filter(Boolean).join(" › "),
      purpose: clip(`${s.summary}. ${s.lead}`.replace(/\.\.\s/, ". ")),
      keywords: s.keywords,
      nav: settingsNav?.id ?? null,
      clickPath: trail,
      tabs: s.panels.map((p) => ({ anchor: p.id, title: p.title, ...(p.advanced ? { advanced: true } : {}), keywords: p.keywords })),
      spots: s.panels.flatMap((p) => p.spots.map((sp) => ({ anchor: sp.anchor, keywords: sp.keywords }))),
      ids: pageIds(set),
      api: apiCallsOf(root, new Set(s.panels.flatMap((p) => (p.file ? [...featureOnly(pageFiles(p.file), p.file)] : [])))),
    });
  }

  for (const pg of pages) {
    const en = english(pg.title, pg.purpose, pg.keywords, (pg.tabs ?? []).map((x) => x.title), settings.sections.filter((s) => s.path === pg.path).flatMap((s) => [s.title, s.summary, s.lead]), nav.filter((n) => n.path === pg.path).map((n) => n.label));
    if (en) pg.en = en;
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return {
    nav: nav.map((n) => ({ ...n, ...(dict.get(n.label) ? { en: dict.get(n.label) } : {}), purpose: n.path === settings.settingsPath ? "Alle Einstellungen." : (info[n.path]?.purpose ?? "") })),
    pages,
    globalIds,
    api,
    tables,
    problems,
  };
}

export function renderNyxosMap(map) {
  const { problems: _p, ...data } = map;
  return `// @generated von scripts/nyxos-map.mjs – NICHT von Hand ändern (\`node scripts/nyxos-map.mjs\` schreibt neu).
// Die NyxOS-Karte für Nyx (Werkzeug nyxos_karte, Übersicht im System-Prompt, Klickpfade für ui_navigate).
import type { NyxosMapData } from "./types.js";

export const NYXOS_MAP: NyxosMapData = ${JSON.stringify(data, null, 1)};
`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const map = buildNyxosMap(REPO_ROOT);
  const text = renderNyxosMap(map);
  const out = join(REPO_ROOT, MAP_OUT);
  if (map.problems.length) {
    console.error(`NyxOS-Karte: ${map.problems.length} Lücke(n):\n- ${map.problems.join("\n- ")}`);
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (cur !== text) {
      console.error("NyxOS-Karte ist veraltet – `node scripts/nyxos-map.mjs` ausführen.");
      process.exit(1);
    }
    console.log("NyxOS-Karte aktuell.");
  } else {
    writeFileSync(out, text);
    console.log(`NyxOS-Karte geschrieben → ${MAP_OUT} (${map.pages.length} Seiten, ${map.tables.length} Tabellen, ${map.api.length} API-Wege)`);
  }
}
