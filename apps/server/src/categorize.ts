/**
 * Einsortierung „Regeln vor KI". Eine reine, getestete Funktion `categorize`:
 * Eingabe sind Merkmale, die aus schon vorhandenen DB-Daten gebaut werden (kein Werkzeug-Aufruf,
 * keine Haiku-KI — die kommt erst in P7 als Rückfall für "Unsortiert").
 *
 * Reihenfolge: (1) meistgeänderter Ordner aus `session_files` (geschrieben vor gelesen), (2) `cwd`,
 * (3) genutzter Skill, (4) Schlagwörter in Titel/erstem Prompt.
 * Art und Baustelle dürfen aus verschiedenen Stufen kommen — deshalb sind das zwei getrennte
 * Berechnungen, die sich am Ende zu einem gemeinsamen `reason` zusammenfügen:
 *
 * - **Baustelle** entsteht (fast) immer aus Projekt und Ordner, abgeleitet aus dem Arbeitsordner
 *   (`cwd`) der Session: ein Worktree (`<repo>/.worktrees/<slug>`, auch `.claude/worktrees/<slug>`) ist
 *   eine eigene Baustelle; sonst das Thema (Unterordner mit klarer Mehrheit, Schwelle 40 %) oder das
 *   Projekt selbst — siehe `computeDominantFolder`. Ganz ohne Datei-Evidenz greift zuletzt ein
 *   Titel-Wort gegen die bereits bekannten Baustellen (`baustelleFromKnownTitle`). Ohne jeden Treffer:
 *   `null` ("Ohne Baustelle").
 * - **Art** läuft die vier Stufen durch (plus einen Rückfall auf "coding" bei Datei-Änderungen ohne
 *   anderen Treffer) und endet bei "unsortiert", wenn nichts passt.
 *
 * Regeln vom Nutzer (`sort_rules`, Herkunft "manuell"/"korrektur") haben **Vorrang** vor dieser
 * ganzen Standard-Pipeline — aber **nur in ihrer eigenen Dimension**:
 * eine Regel setzt entweder nur die Art oder nur die Baustelle, nie beides. Trifft eine aktive
 * Art-Regel zu, gilt ihre Ziel-Art unmittelbar (die Baustelle läuft weiter durch ihre eigene
 * Standard-Ableitung), und umgekehrt für eine Baustelle-Regel.
 */

// Art-Schlüssel/Labels/Reihenfolge: eine Quelle der Wahrheit in packages/shared, hier nur
// re-exportiert, damit bestehende Importe aus categorize.ts (store.ts, app.ts) unverändert bleiben.
import { ARTS, ART_LABELS, isArt, WORKTREE_DIR, type Art, t } from "@nyxos/shared";
export { ARTS, ART_LABELS, isArt };
export type { Art };

export interface Baustelle {
  slug: string;
  label: string;
}

/** Aus DB-Daten gebaute Merkmale einer Session — die einzige Eingabe für `categorize` neben den Regeln. */
export interface CategorizeFeatures {
  /** Meistgeänderter Ordner-Bucket aus `session_files` (geschrieben vor gelesen), z. B. "demo",
   * "demo/services/billing", "demo/.worktrees/checkout" (s. `computeDominantFolder`). */
  dominantFolder: string | null;
  /** `sessions.cwd`, absoluter Pfad. */
  cwd: string | null;
  /** Namen der in der Session genutzten Skills (aus `tool_call`-Events mit `name = "Skill"`, Feld `target`). */
  skills: string[];
  title: string | null;
  firstPrompt: string | null;
  /** Anzahl `session_files`-Zeilen mit `mode = "write"` — unterscheidet reines Gespräch von echter Coding-Arbeit. */
  writeFileCount: number;
}

/** Bedingung einer Regel (Standard oder aus `sort_rules`). Trifft auf genau eine Merkmals-Stufe zu. */
export type RuleCondition =
  | { stage: "folder"; value: string }
  | { stage: "cwd"; value: string }
  | { stage: "skill"; value: string }
  | { stage: "keyword"; anyOf: string[] };

export type RuleOrigin = "standard" | "manuell" | "korrektur";

/**
 * Welche Dimension eine Regel setzt ("getrennte Dimensionen" — Ziehen auf
 * einen BAUSTELLEN-Tab korrigiert nur die Baustelle, Ziehen auf einen ART-Tab nur die Art). Eine
 * Regel trägt nie beides gleichzeitig; die jeweils andere Dimension bleibt bei der normalen Ableitung.
 */
export type RuleDimension = "art" | "baustelle";

export interface SortRule {
  /** `null` bei Standard-Regeln (leben im Code, nicht in `sort_rules`). */
  id: number | null;
  condition: RuleCondition;
  dimension: RuleDimension;
  /** Nur gesetzt (nicht `null`), wenn `dimension === "art"`. */
  targetArt: Art | null;
  /** Nur relevant, wenn `dimension === "baustelle"` (dort `null` = "Ohne Baustelle" als Zuordnung). */
  targetBaustelleSlug: string | null;
  targetBaustelleLabel: string | null;
  origin: RuleOrigin;
  active: boolean;
}

export interface CategorizeReason {
  stage: "korrektur" | "manuell" | "folder" | "cwd" | "baustelle-titel" | "skill" | "keyword" | "fallback" | "unsortiert";
  detail: string;
  ruleId: number | null;
  /** Welche Dimension dieser Eintrag erklärt — nötig, weil eine Regel jetzt nur eine Dimension setzt. */
  dim: RuleDimension;
}

/**
 * Vorzustand einer Dimension VOR einer `assignSession`-Korrektur —
 * gespeichert in `sessions.category_undo` (Migration `0005_category_undo`), damit `unassignSession` genau
 * diesen Zustand wiederherstellen kann (auch eine VORHERIGE manuelle Zuordnung + ihren Grund), statt
 * immer auf den Automatik-Wert zurückzufallen. `createdRuleId`: die `sort_rules`-Zeile, die GENAU
 * diese Korrektur angelegt hat (`null` bei `manualOnly`) — nur diese darf `unassignSession` abschalten.
 */
export interface CategoryUndoEntry {
  createdRuleId: number | null;
  manual: boolean;
  art?: Art | null;
  baustelleSlug?: string | null;
  baustelleLabel?: string | null;
  reason: CategorizeReason[];
}
export type CategoryUndo = Partial<Record<RuleDimension, CategoryUndoEntry>>;

export interface CategorizeResult {
  art: Art;
  baustelle: Baustelle | null;
  reason: CategorizeReason[];
  /** Nicht-null nur, wenn eine DB-Regel (manuell/korrektur) mindestens eine Dimension bestimmt hat. */
  ruleId: number | null;
}

/** Worktree-Ordner innerhalb eines Repos: der eigene (`.worktrees/<slug>`) und der von Claude Code. */
const WORKTREE_PATH_RE = new RegExp(`^(.*?)/(?:${WORKTREE_DIR.replace(/\./g, "\\.")}|\\.claude/worktrees)/([^/]+)(?:/|$)`);
/** Ordner, die für die Art „Audit“ stehen (Name eines Ordner-Teils im Bucket). */
const AUDIT_FOLDER_RE = /(?:^|\/)(?:audits?|reviews?)(?:[-_][^/]*)?(?:\/|$)/i;
/** Anteil, den das häufigste Thema mindestens haben muss (sonst: nächsthöherer Ordner). */
const THEME_SHARE_THRESHOLD = 0.4;
/** Doku-Ordner wie `billing-audit-2026-09` sind dasselbe Thema wie ein Code-Ordner `billing` —
 * Datumssuffix und Rollen-Wort werden vor dem Zusammenfassen abgeschnitten, damit Code und Doku
 * desselben Themas zu einer Baustelle zusammenfallen. */
const THEME_DATE_SUFFIX_RE = /-\d{4}-\d{2}$/;
const THEME_ROLE_SUFFIX_RE = /-(?:service|audit|neubau|review|plan)$/;
/** Sammel-Ordner, deren Unterordner die eigentlichen Themen sind (`services/billing`, `packages/ui`). */
const CONTAINER_DIRS = new Set(["apps", "packages", "services", "modules", "features", "libs", "crates", "cmd", "internal", "docs", "src"]);

const SERVER_WORDS = ["server", "backup", "postgres", "migr", "credential", "tunnel", "usage-limit", "deploy", "upgrade"];
const AUDIT_WORDS = ["audit", "überprüf", "nachweis", "review"];
const RECHERCHE_WORDS = ["recherche", "research"];
const PLANUNG_WORDS = ["planung", "besprechung"];

/** Skills, deren Name die Art unmittelbar bestimmt (Stufe 3). */
const SKILL_ART: Record<string, Art> = {
  review: "audit",
  "code-review": "audit",
  "security-review": "audit",
};

const STOPWORDS = new Set([
  "und", "der", "die", "das", "des", "dem", "den", "ein", "eine", "einer", "eines", "zu", "im", "am", "für", "mit",
  "auf", "von", "bei", "ist", "sind", "um", "als", "wie", "the", "a", "an", "to", "of", "in", "on", "is", "are",
]);

function slugify(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || segment.toLowerCase();
}

function capitalizeWord(w: string): string {
  if (w.length <= 4 && w === w.toUpperCase()) return w; // kurze Kürzel wie "DJ" bleiben stehen
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function humanizeLabel(segment: string): string {
  const stripped = segment.replace(/^[a-z]\d+-/i, ""); // Auftrags-Präfix wie "a02-" weg (nur im Label, nicht im Slug)
  const words = stripped.split(/[-_]+/).filter(Boolean);
  return (words.length > 0 ? words : [segment]).map(capitalizeWord).join(" ");
}

/** Projekt einer Session: Wurzel (ohne Worktree-Teil), Name und ggf. Worktree-Slug. */
export interface ProjectRef {
  root: string;
  name: string;
  worktree: string | null;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Projekt aus dem Arbeitsordner: liegt `cwd` in `<repo>/.worktrees/<slug>`, ist `<repo>` das Projekt
 * und `<slug>` der Worktree. Sonst ist `cwd` selbst die Projekt-Wurzel. */
export function projectOf(cwd: string | null): ProjectRef | null {
  if (!cwd || !cwd.startsWith("/")) return null;
  const clean = cwd.replace(/\/+$/, "");
  if (!clean) return null;
  const wt = WORKTREE_PATH_RE.exec(clean);
  if (wt?.[1] && wt[2]) return { root: wt[1], name: basename(wt[1]), worktree: wt[2] };
  return { root: clean, name: basename(clean), worktree: null };
}

/** Bucket des Arbeitsordners selbst (dieselbe Form wie `computeDominantFolder`), für den Rückfall ohne
 * Datei-Evidenz und für Regeln mit Arbeitsordner-Bedingung. */
function relFromCwd(cwd: string | null): string | null {
  const p = projectOf(cwd);
  if (!p || !p.name) return null;
  return p.worktree ? `${p.name}/${WORKTREE_DIR}/${p.worktree}` : p.name;
}

/**
 * Baustelle aus einem Ordner-Bucket (wie ihn `computeDominantFolder` liefert, oder `relFromCwd(cwd)`):
 * `<projekt>/.worktrees/<slug>` → der Worktree; `<projekt>/<thema>` bzw. `<projekt>/<sammel>/<thema>`
 * → das Thema; `<projekt>` → das Projekt selbst. Ohne Treffer `null`.
 */
export function baustelleFromFolder(folder: string | null): Baustelle | null {
  if (!folder) return null;
  const parts = folder.split("/").filter(Boolean);
  const project = parts[0];
  if (!project) return null;
  const theme = parts[1] === WORKTREE_DIR ? parts[2] : (parts[2] ?? parts[1]);
  if (theme) return { slug: slugify(theme), label: humanizeLabel(theme) };
  return { slug: slugify(project), label: project };
}

/** Datumssuffix (`-2026-09`) und Rollen-Wort (`-service`/`-audit`/…) wiederholt abschneiden, damit
 * z. B. `messenger-service` und `messenger`, oder `billing-audit-2026-09` und `billing-plan-2026-09`
 * auf dasselbe Thema `billing` zusammenfallen. */
function normalizeTheme(raw: string): string {
  let s = raw.toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    if (THEME_DATE_SUFFIX_RE.test(s)) {
      s = s.replace(THEME_DATE_SUFFIX_RE, "");
      changed = true;
    }
    if (THEME_ROLE_SUFFIX_RE.test(s)) {
      s = s.replace(THEME_ROLE_SUFFIX_RE, "");
      changed = true;
    }
  }
  return s || raw.toLowerCase();
}

function bestOf(m: Map<string, number>): [string, number] | null {
  let bestKey: string | null = null;
  let bestN = 0;
  for (const [k, n] of m) {
    if (n > bestN) {
      bestKey = k;
      bestN = n;
    }
  }
  return bestKey === null ? null : [bestKey, bestN];
}

/** Thema einer Datei relativ zur Projekt-Wurzel: der Unterordner unter einem Sammel-Ordner
 * (`services/billing/…` → `services/billing`), sonst der oberste Ordner (`billing/…` → `billing`).
 * Dateien direkt in der Wurzel oder direkt in einem Sammel-Ordner haben kein Thema. */
function themeOf(rel: string): string | null {
  const parts = rel.split("/");
  if (parts.length < 2 || !parts[0]) return null; // Datei direkt in der Wurzel: kein Thema
  const top = parts[0];
  if (CONTAINER_DIRS.has(top.toLowerCase()) && parts.length >= 3 && parts[1]) return `${top}/${normalizeTheme(parts[1])}`;
  if (CONTAINER_DIRS.has(top.toLowerCase())) return null;
  return normalizeTheme(top);
}

/**
 * Meistgeänderter Ordner-Bucket aus `session_files`, relativ zum Projekt des Arbeitsordners (`cwd`).
 * Schreiben zählt vor Lesen: erst wenn kein Bucket Schreib-Treffer hat, entscheidet die Lese-Verteilung.
 * - Dateien in einem Worktree (`<repo>/.worktrees/<slug>/…`) → `<repo>/.worktrees/<slug>` (Worktree-Vorrang).
 * - Dateien im Projekt → `<projekt>`, verfeinert zu `<projekt>/<thema>` bzw. `<projekt>/<sammel>/<thema>`, wenn ein Thema
 *   mindestens 2 Dateien und 40 % Anteil hat (sonst ist das Projekt ehrlicher als ein geratenes Thema).
 * - Dateien außerhalb des Projekts zählen nicht (ohne `cwd` zählen nur Worktree-Dateien).
 */
export function computeDominantFolder(files: { path: string; mode: string }[], cwd: string | null = null): string | null {
  const project = projectOf(cwd);
  const rootPrefix = project ? `${project.root}/` : null;
  const counts = { write: new Map<string, number>(), read: new Map<string, number>() };
  const themes = { write: new Map<string, number>(), read: new Map<string, number>() };
  const projectTotal = { write: 0, read: 0 };
  for (const f of files) {
    const pool = f.mode === "write" ? "write" : "read";
    const wt = WORKTREE_PATH_RE.exec(f.path);
    if (wt?.[1] && wt[2]) {
      const bucket = `${basename(wt[1])}/${WORKTREE_DIR}/${wt[2]}`;
      counts[pool].set(bucket, (counts[pool].get(bucket) ?? 0) + 1);
      continue;
    }
    if (!project || !rootPrefix || !f.path.startsWith(rootPrefix)) continue;
    counts[pool].set(project.name, (counts[pool].get(project.name) ?? 0) + 1);
    projectTotal[pool]++;
    const theme = themeOf(f.path.slice(rootPrefix.length));
    if (theme) themes[pool].set(theme, (themes[pool].get(theme) ?? 0) + 1);
  }
  const pool: "write" | "read" = counts.write.size > 0 ? "write" : "read";
  const winner = bestOf(counts[pool])?.[0] ?? null;
  if (!winner || !project || winner !== project.name) return winner;
  // Mindestens 2 Dateien fürs Thema — sonst wäre eine einzelne zufällig mitgeänderte Datei schon
  // (bei sehr kleinem Pool) über der 40-%-Schwelle eine "Ein-Datei-Baustelle".
  const theme = bestOf(themes[pool]);
  const total = projectTotal[pool];
  if (theme && theme[1] >= 2 && total > 0 && theme[1] / total >= THEME_SHARE_THRESHOLD) return `${project.name}/${theme[0]}`;
  return project.name;
}

/** Wortliste aus einem Text: Stoppwörter und Wörter unter 4 Zeichen raus, Wörter auch an Bindestrichen
 * getrennt (ein Titel-Schlagwort ist ein echtes Wort, kein zusammengesetzter Slug — P2-F2). Exportiert
 * für `store.ts loadCorrectionStats` (dieselbe Wortdefinition für Kandidat und Häufigkeits-Messung). */
export function extractWords(text: string | null): string[] {
  if (!text) return [];
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()));
}

/** Längstes bedeutungstragende Wort im Titel (Stoppwörter und sehr kurze Wörter raus). */
export function extractKeyword(title: string | null): string | null {
  const words = extractWords(title);
  if (words.length === 0) return null;
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}

export function describeCondition(c: RuleCondition): string {
  switch (c.stage) {
    case "folder":
      return t("Ordner {folder}", { folder: c.value });
    case "cwd":
      return t("Arbeitsordner {folder}", { folder: c.value });
    case "skill":
      return t("Skill {name}", { name: c.value });
    case "keyword":
      return t("Titel-Wort „{word}\"", { word: c.anyOf.join(", ") });
  }
}

/** Lesbarer Text für Vorschau/Regel-Liste: Dimension + Bedingung zusammen ("Baustelle über Ordner …"). */
export function describeRuleCondition(dimension: RuleDimension, c: RuleCondition): string {
  return dimension === "art" ? t("Art über {condition}", { condition: describeCondition(c) }) : t("Baustelle über {condition}", { condition: describeCondition(c) });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ganzes Wort (Wortgrenzen auf beiden Seiten) im Text — für Korrektur-Regeln der Art: ein
 * Teilwort-Treffer wie "Pay" in "Payments" reicht nicht. Case-insensitive. */
function wordBoundaryMatches(text: string, word: string): boolean {
  if (!word) return false;
  const pattern = escapeRegExp(word);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${pattern}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * Trifft eine "folder"-Bedingung? Mit Datei-Aktivität bleibt der dominante Ordner maßgeblich (exakter
 * Treffer). Ganz OHNE `session_files` (z. B. eine frisch gestartete Session ohne Datei-Änderung)
 * greift ersatzweise `cwd`: liegt der Arbeitsordner IN oder UNTER dem Regel-Ordner, zählt das auch als
 * Treffer (eine neue Session ohne Datei-Aktivität wurde sonst nie von einer
 * ordnerbasierten Baustelle-Regel erfasst, obwohl ihr `cwd` eindeutig im Regel-Ordner liegt).
 */
function matchesFolderCondition(f: CategorizeFeatures, value: string): boolean {
  if (f.dominantFolder !== null) return f.dominantFolder === value;
  const cwdRel = relFromCwd(f.cwd);
  if (cwdRel === null) return false;
  return cwdRel === value || cwdRel.startsWith(`${value}/`);
}

function matchesCondition(f: CategorizeFeatures, c: RuleCondition): boolean {
  switch (c.stage) {
    case "folder":
      return matchesFolderCondition(f, c.value);
    case "cwd":
      return relFromCwd(f.cwd) === c.value || f.cwd === c.value;
    case "skill":
      return f.skills.some((s) => s.toLowerCase() === c.value.toLowerCase());
    case "keyword": {
      const text = `${f.title ?? ""} ${f.firstPrompt ?? ""}`;
      return c.anyOf.some((w) => wordBoundaryMatches(text, w));
    }
  }
}

/**
 * Häufigkeiten aus dem echten Bestand (alle Haupt-Sessions), damit eine Korrektur-Bedingung nie
 * zu breit wird. `folderShare`: Anteil der Haupt-Sessions, für die ein
 * Ordner der dominante Ordner ist. `titleWordShare`: Anteil der Titel, die ein Wort als ganzes Wort
 * enthalten (case-insensitiv). Beide 0..1. Wird aus der DB gebaut (s. `store.ts loadCorrectionStats`).
 */
export interface CorrectionStats {
  folderShare: (folder: string) => number;
  titleWordShare: (word: string) => number;
}

/** Über dieser Schwelle ist ein Ordner "ein Oberbereich" (z. B. das ganze Projekt mit
 * vielen verschiedenartigen Sessions) — als Baustelle-Bedingung zu breit, keine Regel. */
export const BAUSTELLE_FOLDER_SHARE_MAX = 0.25;
/** Über dieser Schwelle ist ein Titel-Wort ein Projekt-/Füllwort (z. B. der Projektname) — als
 * Art-Bedingung zu breit. Das IST die "Stoppliste aus Daten" aus der Auftragsbeschreibung: kein
 * fester Wortkatalog, sondern die gemessene Häufigkeit selbst. */
export const ART_KEYWORD_SHARE_MAX = 0.15;

function pickArtKeyword(text: string | null, stats: CorrectionStats): string | null {
  const candidates = extractWords(text).filter((w) => stats.titleWordShare(w) <= ART_KEYWORD_SHARE_MAX);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Baut die Bedingung einer Korrektur-Regel für GENAU EINE Dimension (eine
 * Regel setzt nur, was korrigiert wurde — Ordner-Bedingungen nie für Art-Korrekturen, weil derselbe
 * Ordner ganz unterschiedliche Arten enthalten kann, z. B. Audit UND Coding im selben Projekt).
 *
 * - **Baustelle**: der dominante Ordner der Session — aber nur, wenn er NICHT gleichzeitig der
 *   dominante Ordner von mehr als 25 % aller Haupt-Sessions ist (sonst nie "App" oder ein
 *   Oberbereich). Kein Ordner oder zu breit → `null` (keine Regel möglich, nur diese Session).
 * - **Art**: nie ein Ordner. Erst ein genutzter Skill, sonst ein Titel-Schlagwort — als GANZES Wort,
 *   ≥ 4 Zeichen, das in höchstens 15 % aller Titel vorkommt (sonst ein Projekt-/Füllwort wie
 *   der Projektname). Ohne Treffer → `null`.
 */
export function buildCorrectionCondition(f: CategorizeFeatures, dimension: RuleDimension, stats: CorrectionStats): RuleCondition | null {
  if (dimension === "baustelle") {
    if (f.dominantFolder && stats.folderShare(f.dominantFolder) <= BAUSTELLE_FOLDER_SHARE_MAX) {
      return { stage: "folder", value: f.dominantFolder };
    }
    return null;
  }
  const skill = f.skills[0];
  if (skill) return { stage: "skill", value: skill };
  const keyword = pickArtKeyword(f.title, stats) ?? pickArtKeyword(f.firstPrompt, stats);
  return keyword ? { stage: "keyword", anyOf: [keyword] } : null;
}

function keywordStage(f: CategorizeFeatures): { art: Art; detail: string } | null {
  const text = `${f.title ?? ""} ${f.firstPrompt ?? ""}`.toLowerCase();
  const hit = (words: string[]) => words.find((w) => text.includes(w));
  let w = hit(SERVER_WORDS);
  if (w) return { art: "server", detail: t("Titel-Wort „{word}\"", { word: w }) };
  w = hit(AUDIT_WORDS);
  if (w) return { art: "audit", detail: t("Titel-Wort „{word}\"", { word: w }) };
  w = hit(RECHERCHE_WORDS);
  if (w) return { art: "recherche", detail: t("Titel-Wort „{word}\"", { word: w }) };
  if (f.writeFileCount === 0) {
    w = hit(PLANUNG_WORDS);
    if (w) return { art: "planung", detail: t("Titel-Wort „{word}\" (keine Datei-Änderungen)", { word: w }) };
  }
  return null;
}

const ART_STAGES: { name: CategorizeReason["stage"]; match: (f: CategorizeFeatures) => { art: Art; detail: string } | null }[] = [
  { name: "folder", match: (f) => (f.dominantFolder?.includes("/") && AUDIT_FOLDER_RE.test(f.dominantFolder.slice(f.dominantFolder.indexOf("/"))) ? { art: "audit", detail: t("Ordner {folder}", { folder: f.dominantFolder }) } : null) },
  { name: "cwd", match: (f) => (f.cwd && AUDIT_FOLDER_RE.test(basename(f.cwd.replace(/\/+$/, ""))) ? { art: "audit", detail: t("Arbeitsordner {folder}", { folder: f.cwd }) } : null) },
  {
    name: "skill",
    match: (f) => {
      for (const s of f.skills) {
        const art = SKILL_ART[s.toLowerCase()];
        if (art) return { art, detail: t("Skill {name}", { name: s }) };
      }
      return null;
    },
  },
  { name: "keyword", match: keywordStage },
  { name: "fallback", match: (f) => (f.writeFileCount > 0 ? { art: "coding", detail: t("Datei-Änderungen ohne anderen Treffer") } : null) },
];

/**
 * Ganzer Slug (alle Bindestrich-Teile zusammen, nicht einzeln) am Wortanfang im Text — Bindestrich im
 * Slug darf im Text auch ein Leerzeichen sein ("dj-live" ⇔ "DJ live"). Ein einzelnes generisches
 * Teil-Wort (z. B. nur "app" aus "shop-app") reicht bewusst NICHT: das erzeugte in der Messung
 * Zufallstreffer bei fast jedem Titel mit dem Projektnamen. Kein Wortende-Zwang (deutsche/englische
 * Beugung wie "Notification" ⊂ "Notifications" soll noch treffen).
 */
function slugMatchesAsWhole(text: string, slug: string): boolean {
  if (slug.length < 4) return false;
  const pattern = slug.split("-").map(escapeRegExp).join("[-\\s]+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${pattern}`, "iu").test(text);
}

/**
 * Letzter Rückfall, wenn weder Ordner noch `cwd` eine Baustelle liefern (keine Datei-Evidenz):
 * ein Titel-/Prompt-Schlagwort gegen die **bereits bekannten** Baustellen prüfen — live aus anderen
 * Sessions ermittelt (`knownBaustellen`, siehe `loadKnownBaustellen` in `store.ts`), keine feste
 * Themenliste im Code. Erst wenn auch das nichts trifft, bleibt die Baustelle `null`.
 * Verglichen wird der **ganze** Slug bzw. das ganze Label als ein Wort/eine Wortfolge (kein
 * Zufallstreffer über ein einzelnes, generisches Teil-Wort — siehe `slugMatchesAsWhole`).
 */
function baustelleFromKnownTitle(f: CategorizeFeatures, known: Baustelle[]): { baustelle: Baustelle; detail: string } | null {
  const text = `${f.title ?? ""} ${f.firstPrompt ?? ""}`.toLowerCase().trim();
  if (!text) return null;
  for (const b of known) {
    if (slugMatchesAsWhole(text, b.slug.toLowerCase())) {
      return { baustelle: b, detail: t("Titel-Wort „{word}\" (bekannte Baustelle)", { word: b.label }) };
    }
  }
  return null;
}

export function categorize(features: CategorizeFeatures, dbRules: SortRule[], knownBaustellen: Baustelle[] = []): CategorizeResult {
  const reason: CategorizeReason[] = [];

  // ---- Baustelle: eigene Dimension, eigene Regel-Suche (nie durch eine Art-Regel berührt). ----
  const baustelleRule = dbRules.find((r) => r.active && r.dimension === "baustelle" && matchesCondition(features, r.condition));
  let baustelle: Baustelle | null;
  let baustelleRuleId: number | null = null;
  if (baustelleRule) {
    baustelle = baustelleRule.targetBaustelleSlug
      ? { slug: baustelleRule.targetBaustelleSlug, label: baustelleRule.targetBaustelleLabel ?? baustelleRule.targetBaustelleSlug }
      : null;
    reason.push({
      stage: baustelleRule.origin === "korrektur" ? "korrektur" : "manuell",
      detail: describeCondition(baustelleRule.condition),
      ruleId: baustelleRule.id,
      dim: "baustelle",
    });
    baustelleRuleId = baustelleRule.id;
  } else {
    baustelle = baustelleFromFolder(features.dominantFolder);
    if (baustelle) {
      reason.push({ stage: "folder", detail: t("Ordner {folder}", { folder: features.dominantFolder }), ruleId: null, dim: "baustelle" });
    } else {
      baustelle = baustelleFromFolder(relFromCwd(features.cwd));
      if (baustelle) {
        reason.push({ stage: "cwd", detail: t("Arbeitsordner {folder}", { folder: features.cwd }), ruleId: null, dim: "baustelle" });
      } else {
        const known = baustelleFromKnownTitle(features, knownBaustellen);
        if (known) {
          baustelle = known.baustelle;
          reason.push({ stage: "baustelle-titel", detail: known.detail, ruleId: null, dim: "baustelle" });
        }
      }
    }
  }

  // ---- Art: eigene Dimension, eigene Regel-Suche (nie durch eine Baustelle-Regel berührt). ----
  const artRule = dbRules.find((r) => r.active && r.dimension === "art" && matchesCondition(features, r.condition));
  let art: Art;
  let artRuleId: number | null = null;
  if (artRule?.targetArt) {
    art = artRule.targetArt;
    reason.push({
      stage: artRule.origin === "korrektur" ? "korrektur" : "manuell",
      detail: describeCondition(artRule.condition),
      ruleId: artRule.id,
      dim: "art",
    });
    artRuleId = artRule.id;
  } else {
    let hit: { art: Art; detail: string } | null = null;
    let stageName: CategorizeReason["stage"] = "unsortiert";
    for (const stage of ART_STAGES) {
      hit = stage.match(features);
      if (hit) {
        stageName = stage.name;
        break;
      }
    }
    if (hit) {
      art = hit.art;
      reason.push({ stage: stageName, detail: hit.detail, ruleId: null, dim: "art" });
    } else {
      art = "unsortiert";
      reason.push({ stage: "unsortiert", detail: t("kein Treffer"), ruleId: null, dim: "art" });
    }
  }

  return { art, baustelle, reason, ruleId: baustelleRuleId ?? artRuleId };
}
