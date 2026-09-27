// Build-Wächter. Vertrag zwischen Server (`apps/server/src/builds`) und Web
// (`apps/web/src/features/builds` — Session-Panel + Einzeiler für den Überblick, den P5 baut).
//
// Die Prüfung läuft auf dem Rechner (Brücke, RPC `run_build`), nie im Server-Container — dort gibt
// es weder die Arbeitsordner noch Xcode. Fehlt ein Werkzeug oder Ordner, ist der Lauf nicht „rot“,
// sondern „nicht eingerichtet“ (`unavailable`) mit einem Satz, was fehlt. Gleiche Fehler werden beim
// Lesen gebündelt (`groupBuildRuns`) — für „Braucht dich“, Briefing, „Letzte Builds“ und Push.
import { z } from "zod";
import { dateTimeFormat } from "./format.js";
import { t, type Lang } from "./i18n/index.js";
import { lazyRecord } from "./lazy-text.js";

/** Welche Prüfung zu einer Session/einem Worktree passt. */
export const BuildKindSchema = z.enum(["ios", "backend", "nyxos"]);
export type BuildKind = z.infer<typeof BuildKindSchema>;

/** `unavailable` = Build-Prüfung nicht eingerichtet (Werkzeug/Ordner fehlt, Brücke nicht da) — kein Rot. */
export const BuildStatusSchema = z.enum(["queued", "running", "green", "red", "unavailable"]);
export type BuildStatus = z.infer<typeof BuildStatusSchema>;

export const BuildTriggerSchema = z.enum(["stop_hook", "manual"]);
export type BuildTrigger = z.infer<typeof BuildTriggerSchema>;

export interface BuildRunRow {
  id: number;
  sessionKey: string | null;
  kind: BuildKind;
  command: string;
  status: BuildStatus;
  exitCode: number | null;
  logExcerpt: string | null;
  derivedDataPath: string | null;
  trigger: BuildTrigger;
  startedAt: string;
  endedAt: string | null;
  /** BC: Arbeitsordner des Laufs (Worktree/Projekt) — ein grüner Lauf im selben Ordner behebt
   * frühere rote. `null` bei Läufen von vor dieser Spalte. */
  folder?: string | null;
}

/** Höchstens ein iOS-Build gleichzeitig ("Warteschlange"); Backend/NyxOS dürfen
 * parallel laufen (verschiedene Dienste/Worktrees kollidieren nicht wie Xcodes globaler Cache). */
export const BUILD_MAX_CONCURRENT: Record<BuildKind, number> = { ios: 1, backend: 3, nyxos: 3 };

/** Wie viele Log-Zeilen im Einzeiler/an der Session gezeigt werden (Rest bleibt im Volltext). */
export const BUILD_LOG_EXCERPT_LINES = 40;

export const BUILD_KIND_LABEL: Record<BuildKind, string> = lazyRecord({ ios: "iOS-App", backend: "Swift-Paket", nyxos: "NyxOS" });

// ───────────────────────────── Brücke: RPC `run_build` ─────────────────────────────

/** Fähigkeit, die die Brücke im `hello` meldet — ältere Brücken kennen `run_build` noch nicht. */
export const BRIDGE_CAP_RUN_BUILD = "run_build";

/** Nur diese Programme darf die Brücke als Build-Prüfung starten (Befehle kommen vom Server). */
export const BUILD_ALLOWED_TOOLS = ["pnpm", "xcodebuild", "swift"] as const;

/** Längste Laufzeit einer Prüfung auf dem Rechner; danach bricht die Brücke ab (Server wartet etwas länger). */
export const BUILD_TIMEOUT_MS = 15 * 60_000;

/** Kein `env`: Umgebungsvariablen vom Server (z. B. `NODE_OPTIONS`, `DYLD_*`) übernimmt die Brücke nie
 * — ein altes Feld `env` wird beim Einlesen verworfen. */
export const RunBuildRequestSchema = z.object({
  command: z.array(z.string().min(1).max(1000)).min(1).max(40),
  cwd: z.string().min(1).max(2048),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});
export type RunBuildRequest = z.infer<typeof RunBuildRequestSchema>;

export const BuildUnavailableReasonSchema = z.enum(["tool_missing", "folder_missing", "deps_missing", "no_project", "not_allowed", "bridge_offline", "bridge_outdated"]);
export type BuildUnavailableReason = z.infer<typeof BuildUnavailableReasonSchema>;

export type RunBuildResult =
  | { outcome: "done"; exitCode: number; log: string }
  | { outcome: "unavailable"; reason: BuildUnavailableReason; tool?: string; log: string };

/** Ein Satz in einfacher Sprache: was fehlt, damit geprüft werden kann. */
export function unavailableSentence(reason: BuildUnavailableReason, tool?: string, lang?: Lang): string {
  switch (reason) {
    case "tool_missing":
      return t(TOOL_MISSING_SENTENCE, { tool: tool ?? "?" }, lang);
    case "folder_missing":
      return t("Den Arbeitsordner gibt es auf dem Rechner nicht mehr (zum Beispiel schon aufgeräumt).", undefined, lang);
    case "deps_missing":
      return t("Im Arbeitsordner sind die Pakete noch nicht installiert (einmal „pnpm install“).", undefined, lang);
    case "no_project":
      return t("In diesem Ordner liegt kein Projekt, das sich bauen lässt – geprüft wird, sobald eine Session im Projektordner arbeitet.", undefined, lang);
    case "not_allowed":
      return t("Diese Prüfung ist auf dem Rechner nicht freigegeben.", undefined, lang);
    case "bridge_offline":
      return t("Die Brücke war gerade nicht verbunden – geprüft wird beim nächsten Mal.", undefined, lang);
    case "bridge_outdated":
      return t("Die Brücke ist noch auf altem Stand und kann noch nicht prüfen – nach ihrem Update geht es.", undefined, lang);
  }
}

const TOOL_MISSING_SENTENCE = "Auf dem Rechner fehlt das Werkzeug „{tool}“ – die Brücke findet es nicht.";
const TOOL_MISSING_RE = /^Auf dem Rechner fehlt das Werkzeug „(.*)“ – die Brücke findet es nicht\.$/;

/** Stored sentences (first log line) are written in the language of that moment; German ones are translated for display. */
function localizeStoredSentence(sentence: string): string {
  const tool = TOOL_MISSING_RE.exec(sentence)?.[1];
  return tool !== undefined ? t(TOOL_MISSING_SENTENCE, { tool }) : t(sentence);
}

/** Alte Läufe (vor R1) starteten im Server-Container — dort gibt es weder `pnpm` noch die Mac-Ordner. */
// Nur wenn die GANZE Meldung das ist (so schrieb der alte Server-Runner) — ein echter roter Lauf, dessen
// Log irgendwo eine solche Zeile enthält (z. B. ein Test, dem ein Programm fehlt), bleibt rot.
const LEGACY_SPAWN_ENOENT = /^Fehler beim Starten: spawn (\S+) ENOENT$/;
const LEGACY_SENTENCE_DE = "Die Prüfung lief früher im Server-Container, dort gibt es deine Arbeitsordner nicht. Jetzt prüft der Rechner.";

// ───────────────────────────── Einordnung + Bündelung ─────────────────────────────

export interface BuildView {
  state: BuildStatus;
  /** Kurz, z. B. „Build rot: NyxOS“. */
  headline: string;
  /** Ein Satz in einfacher Sprache — nie eine Technik-Meldung. */
  sentence: string;
  /** Rohmeldung/Log für „Details“ (aufklappbar), sonst null. */
  details: string | null;
  /** Gleiches Projekt + gleiche Fehlersignatur = gleiche Signatur (Grundlage der Bündelung). */
  signature: string;
}

type RunLike = Pick<BuildRunRow, "kind" | "status" | "command" | "logExcerpt">;

const trimLines = (s: string | null | undefined) => (s ?? "").replace(/^\s+|\s+$/g, "");

/** Whole sentences per kind (German source, one key per sentence). */
const TYPECHECK_RED: Record<BuildKind, string> = { ios: "Der Typen-Check der iOS-App meldet Fehler.", backend: "Der Typen-Check des Swift-Pakets meldet Fehler.", nyxos: "Der Typen-Check von NyxOS meldet Fehler." };
const TESTS_RED: Record<BuildKind, string> = { ios: "Tests der iOS-App sind fehlgeschlagen.", backend: "Tests im Swift-Paket sind fehlgeschlagen.", nyxos: "Tests von NyxOS sind fehlgeschlagen." };
const CHECK_RED: Record<BuildKind, string> = { ios: "Die Prüfung der iOS-App ist fehlgeschlagen.", backend: "Die Prüfung des Swift-Pakets ist fehlgeschlagen.", nyxos: "Die Prüfung von NyxOS ist fehlgeschlagen." };

function redSentence(kind: BuildKind, command: string): string {
  if (/\btypecheck\b/.test(command)) return t(TYPECHECK_RED[kind]);
  if (command.startsWith("xcodebuild")) return t("Die iOS-App lässt sich nicht bauen.");
  if (/\btest\b/.test(command)) return t(TESTS_RED[kind]);
  return t(CHECK_RED[kind]);
}

/** Pfade (auch mit Leerzeichen wie „My App“ bis zum nächsten Schalter) durch „…“ ersetzen. */
const stripPaths = (command: string) => command.replace(/\/[^\s-][\s\S]*?(?=\s-|$)/g, "…");

/** Fehlerzeile ohne das, was sich von Lauf zu Lauf ändert (Pfade, Zahlen, Leerraum). */
function normalizeErrorLine(log: string): string {
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /\berror\b|fehler/i.test(l)) ?? lines.at(-1) ?? "";
  return line
    .replace(/(?:[A-Za-z]:)?(?:\/[^\s/:'"()]+)+\/?/g, "…")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, 200);
}

export function describeBuildRun(run: RunLike): BuildView {
  const label = BUILD_KIND_LABEL[run.kind] ?? run.kind;
  const log = trimLines(run.logExcerpt);
  const legacy = run.status === "red" ? LEGACY_SPAWN_ENOENT.exec(log) : null;
  if (run.status === "unavailable" || legacy) {
    const [first = "", ...rest] = log.split("\n");
    // The signature uses the stored (untranslated) sentence, so grouping does not depend on the app language.
    const raw = legacy ? LEGACY_SENTENCE_DE : first.trim() || unavailableSentence("bridge_offline", undefined, "de");
    const sentence = localizeStoredSentence(raw);
    const details = legacy ? log : trimLines(rest.join("\n")) || null;
    return { state: "unavailable", headline: t("Build-Prüfung nicht eingerichtet: {label}", { label }), sentence, details, signature: `${run.kind}|unavailable|${raw}` };
  }
  switch (run.status) {
    case "green":
      return { state: "green", headline: t("Build grün: {label}", { label }), sentence: t("Alles in Ordnung."), details: log || null, signature: `${run.kind}|green` };
    case "red":
      // Pfade im Befehl (Worktree, DerivedData) zählen nicht: gleicher Fehler in zwei Worktrees = ein Eintrag.
      return { state: "red", headline: t("Build rot: {label}", { label }), sentence: redSentence(run.kind, run.command), details: log || null, signature: `${run.kind}|red|${stripPaths(run.command)}|${normalizeErrorLine(log)}` };
    case "running":
      return { state: "running", headline: t("Prüfung läuft: {label}", { label }), sentence: t("Die Prüfung läuft gerade."), details: null, signature: "" };
    default:
      return { state: "queued", headline: t("Prüfung wartet: {label}", { label }), sentence: t("Die Prüfung wartet auf einen freien Platz."), details: null, signature: "" };
  }
}

export interface BuildGroup extends BuildView {
  /** Stabiler Schlüssel (Signatur bzw. Einzel-ID bei laufenden Prüfungen). */
  key: string;
  kind: BuildKind;
  count: number;
  firstAt: string;
  lastAt: string;
  /** Jüngster Lauf dieser Gruppe (Details/Verweise zeigen auf ihn). */
  lastId: number;
  firstId: number;
  ids: number[];
  sessionKeys: string[];
}

/** ISO- und Postgres-Zeitstempel („2026-09-25 09:20:06.41+00“) gleichermaßen. */
function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.parse(iso.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")) : ms;
}

/** Bündelt Läufe mit gleicher Signatur (gleiches Projekt, gleicher Zustand, gleiche Fehlerzeile).
 * Laufende/wartende Prüfungen bleiben einzeln. Ergebnis: jüngste Gruppe zuerst. */
export function groupBuildRuns(rows: readonly BuildRunRow[]): BuildGroup[] {
  const groups = new Map<string, BuildGroup>();
  for (const run of rows) {
    const view = describeBuildRun(run);
    const key = view.signature ? view.signature : `single:${run.id}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...view, key, kind: run.kind, count: 1, firstAt: run.startedAt, lastAt: run.startedAt, lastId: run.id, firstId: run.id, ids: [run.id], sessionKeys: run.sessionKey ? [run.sessionKey] : [] });
      continue;
    }
    g.count += 1;
    g.ids.push(run.id);
    if (run.sessionKey && !g.sessionKeys.includes(run.sessionKey)) g.sessionKeys.push(run.sessionKey);
    if (timeOf(run.startedAt) < timeOf(g.firstAt)) {
      g.firstAt = run.startedAt;
      g.firstId = run.id;
    }
    if (timeOf(run.startedAt) > timeOf(g.lastAt)) {
      // Der jüngste Lauf bestimmt, was unter „Details“ steht.
      Object.assign(g, { ...view, key, lastAt: run.startedAt, lastId: run.id });
    }
  }
  return [...groups.values()].sort((a, b) => timeOf(b.lastAt) - timeOf(a.lastAt));
}

/** BC: Lässt rote Läufe weg, nach denen ein grüner Lauf derselben Art im selben Ordner kam
 * (behoben). Grundlage für „Braucht dich“, Briefing, Rundgang und Push („nach einer Reparatur meldet
 * ein neuer Fehler wieder“). Alle anderen Läufe bleiben unverändert. */
export function withoutRepaired<T extends Pick<BuildRunRow, "kind" | "status" | "startedAt"> & { folder?: string | null }>(rows: readonly T[]): T[] {
  const lastGreen = new Map<string, number>();
  const keyOf = (r: T) => `${r.kind}|${r.folder ?? ""}`;
  for (const r of rows) {
    if (r.status !== "green") continue;
    const ms = timeOf(r.startedAt);
    if (ms > (lastGreen.get(keyOf(r)) ?? -Infinity)) lastGreen.set(keyOf(r), ms);
  }
  return rows.filter((r) => r.status !== "red" || !(timeOf(r.startedAt) < (lastGreen.get(keyOf(r)) ?? -Infinity)));
}

const clock = (iso: string) => dateTimeFormat({ hour: "2-digit", minute: "2-digit" }).format(new Date(timeOf(iso)));

/** „4× seit 09:12“ (Zeitzone des Nutzers) bzw. „um 09:12“ bei einem einzelnen Lauf. */
export function formatBuildCount(g: Pick<BuildGroup, "count" | "firstAt" | "lastAt">): string {
  return g.count > 1 ? t("{n}× seit {time}", { n: g.count, time: clock(g.firstAt) }) : t("um {time}", { time: clock(g.lastAt) });
}
