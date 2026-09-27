// Verbindungs-Prüfung: jede Verbindung der NyxOS einmal ECHT prüfen (serverseitig).
// Jede Prüfung liefert Zustand + was gesehen wurde + (bei Problemen) Ursache und Lösung in einem
// einfachen Satz. Externe Wege (Brücke, ntfy, Socket-Proxy, Dateisystem) laufen über den
// Kontext, damit Tests sie gezielt ersetzen können.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { BRIDGE_CAP_RUN_BUILD, NTFY_SH_URL, NYX_VOICE_FIX_START, type AppMode, type BridgeRpcMethod, type BridgeStatusReport, type HaikuStatus, type NyxVoiceScope, type SetupState, type TelegramStatus, dateTimeFormat, t } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authSessions } from "../db/schema.js";
import type { checkHealth } from "../health.js";
import { HttpNyxVoiceBackend, type NyxVoiceBackend } from "../nyx/voice-backend.js";
import { readNyxVoiceStatus } from "../routes/nyx-voice.js";
import { createAuthSession, CSRF_HEADER, SESSION_COOKIE, SESSION_TTL_MS } from "../terminal/auth.js";
import type { RpcOutcome } from "../terminal/bridgeHub.js";
import type { CheckDef, CheckOutcome } from "./runner.js";

export type HealthResult = Awaited<ReturnType<typeof checkHealth>>;

export interface ConnectionsContext {
  db: Db;
  archiveDir: string;
  env: NodeJS.ProcessEnv;
  bridge: {
    status(): { online: boolean; machineId: string | null; since: string | null; tmuxSocket?: string | null };
    rpc(method: BridgeRpcMethod, params: unknown, timeoutMs?: number): Promise<RpcOutcome>;
    /** Fähigkeiten aus dem `hello` der Brücke (z. B. `run_build`); fehlt bei alten Test-Fakes. */
    supports?: (cap: string) => boolean;
  };
  /** Haiku-Laufzeit (`null` = nicht eingebaut). */
  haiku: { status(): Promise<HaikuStatus> } | null;
  /** Arbeiter im Agent-Container (nur bei `NYXOS_HAIKU_REMOTE=1`, sonst `null`). */
  worker: { connectedAt: string | null } | null;
  /** Anfrage an die eigene App (ohne Netz) — für die CSRF-Probe. */
  selfRequest: (path: string, init: RequestInit) => Promise<Response>;
  /** Host der prüfenden Anfrage (für RP-ID/Origin der Passkeys). */
  requestHost: string | null;
  requestProto: "http" | "https";
  fetch: typeof fetch;
  now: () => number;
  findBin: (name: string) => string | null;
  /** Je Prüflauf einmal berechnet (DB/Schema/Archiv teilen sich dieselbe `/health`-Prüfung). */
  health: () => Promise<HealthResult>;
  /** Je Prüflauf einmal gefragt: Stand der Brücke (`status`-Befehl). */
  bridgeStatus: () => Promise<RpcOutcome>;
  /** Telegram-Bot (`null` = nicht eingebaut, z. B. alte Test-Fakes). */
  telegram?: { status(): Promise<TelegramStatus> } | null;
  /** Lokaler Modus: das Stimmen-Paket auf diesem Computer (statt `NYXOS_NYX_VOICE_URL`). */
  voice?: { backend: NyxVoiceBackend; scope: NyxVoiceScope } | null;
  /** Betriebsart: `local` = alles auf diesem Rechner (install.sh), `server` = Docker-Compose-Betrieb. */
  mode: AppMode;
  /** Je Prüflauf einmal gefragt: Einrichtung der Brücke (Vault, Hooks, Programme); `null` = nicht abfragbar. */
  bridgeSetup: () => Promise<SetupState | null>;
}

// ───────────────────────────── Helfer ─────────────────────────────

const MIN = 60_000;
/** Zustand eines Build-Laufs in einfachen Worten (build_runs.status). */
const BUILD_STATUS_WORD: Record<string, string> = { green: "grün", red: "rot", unavailable: "nicht eingerichtet", interrupted: "unterbrochen" };
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Lebensdauer der Probe-Anmeldung der Schutz-Prüfung (Sicherheitsnetz, falls das Löschen scheitert). */
const CSRF_PROBE_TTL_MS = 2 * MIN;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

async function firstRow(db: Db, query: ReturnType<typeof sql>): Promise<Record<string, unknown>> {
  return rowsOf(await db.execute(query))[0] ?? {};
}

function toMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** „vor 3 Min“, „vor 2 Std“, „vor 4 Tagen“ — einfache Zeitangabe für den Nutzer. */
export function ago(ms: number | null, now: number): string {
  if (ms === null) return t("nie");
  const d = Math.max(0, now - ms);
  if (d < MIN) return t("gerade eben");
  if (d < HOUR) return t("vor {n} Min", { n: Math.round(d / MIN) });
  if (d < 2 * DAY) return t("vor {n} Std", { n: Math.round(d / HOUR) });
  return t("vor {n} Tagen", { n: Math.round(d / DAY) });
}

function clock(ms: number): string {
  return dateTimeFormat({ hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }).format(new Date(ms));
}

/** Programm im PATH suchen (wie `which`), ohne einen Prozess zu starten. */
export function findBinInPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (name.includes("/")) return existsSync(name) ? name : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // weiter suchen
    }
  }
  return null;
}

async function fetchWithTimeout(f: typeof fetch, url: string, ms: number): Promise<Response> {
  return f(url, { signal: AbortSignal.timeout(ms) });
}

function fetchError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return t("keine Antwort (Zeitlimit)");
  const code = err?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return t("Dienst-Name ist im Netz nicht bekannt (Dienst läuft nicht)");
  if (code === "ECONNREFUSED") return t("Verbindung abgelehnt (Dienst läuft nicht)");
  return err?.cause?.message ?? err?.message ?? String(e);
}

/** Stand der Brücke auslesen; `null` = Brücke kennt den Befehl noch nicht (ältere Fassung). */
async function bridgeReport(ctx: ConnectionsContext): Promise<{ report: BridgeStatusReport | null; offline: boolean; error: string | null }> {
  if (!ctx.bridge.status().online) return { report: null, offline: true, error: null };
  const r = await ctx.bridgeStatus();
  if (r.ok) return { report: r.result as BridgeStatusReport, offline: false, error: null };
  if (r.code === "bridge_offline") return { report: null, offline: true, error: null };
  return { report: null, offline: false, error: r.error ?? t("unbekannt") };
}

const OLD_BRIDGE = "Die installierte Brücke ist eine ältere Fassung und meldet diesen Wert noch nicht.";
const OLD_BRIDGE_FIX = "NyxOS aktualisieren — die neue Brücke bringt den Befehl „status“ mit.";
const UPDATE_CMD = "nyxos update";
const RESTART_CMD = "nyxos restart";
const LOGS_HINT = "Protokoll ansehen (`nyxos logs`).";
const BRIDGE_RESTART = RESTART_CMD;
const HAIKU_TOKEN_CMD = "claude setup-token";
/** Motor, CLI und Arbeiter hängen nur am fehlenden Token → der Nutzer-Punkt statt Rot, ohne Container-Technik. */
const waitsForToken = (ctx: ConnectionsContext): boolean => ctx.worker !== null && !ctx.worker.connectedAt;
/** Lokal: so lange nach dem Verbinden der Brücke gilt „noch nichts angekommen“ als Einlesen, nicht als Fehler. */
const FIRST_DATA_GRACE_MS = 15 * MIN;
/** Installation des Claude-Programms (derselbe Befehl wie im Onboarding). */
const CLAUDE_INSTALL_CMD = "curl -fsSL https://claude.ai/install.sh | bash";
const FIRST_SESSION = "Kommt, sobald du eine Claude-Session startest.";
/** Freiwillige Teile, die niemand eingerichtet hat: grün mit Hinweis (wie die Reserve-API), nicht gelb. */
const OPTIONAL_OFF: CheckOutcome = { state: "ok", result: "optional, nicht eingerichtet" };
const isLocal = (ctx: ConnectionsContext): boolean => ctx.mode === "local";

/** Ist die Brücke erst seit Kurzem verbunden (liest dann noch ein)? */
function justConnected(ctx: ConnectionsContext): boolean {
  const s = ctx.bridge.status();
  const since = s.online ? toMs(s.since) : null;
  return since !== null && ctx.now() - since < FIRST_DATA_GRACE_MS;
}

/**
 * Lokal, frische Installation: Brücke verbunden, aber noch nichts angekommen, weil auf diesem Rechner noch keine
 * Session lief (der Datei-Wächter kennt keinen Verlauf) oder die Brücke gerade erst liest. Das ist kein Fehler.
 * `null` = kein Warten (Server-Modus, Brücke weg, oder sie liest schon lange und es kommt trotzdem nichts).
 */
async function waitingForFirstData(ctx: ConnectionsContext): Promise<CheckOutcome | null> {
  if (!isLocal(ctx) || !ctx.bridge.status().online) return null;
  const { report } = await bridgeReport(ctx);
  if (report && report.watchedFiles === 0) return { state: "idle", result: "noch keine Session", cause: FIRST_SESSION };
  if (justConnected(ctx)) return { state: "idle", result: "liest ein …", cause: "Die Brücke ist gerade gestartet und liest die vorhandenen Verläufe ein — das dauert ein paar Minuten." };
  return null;
}

/** Lokal: Ist ein Obsidian-Vault eingerichtet? `unknown` = Brücke gerade nicht abfragbar. */
async function localVault(ctx: ConnectionsContext): Promise<"set" | "none" | "unknown"> {
  const setup = await ctx.bridgeSetup();
  if (!setup) return "unknown";
  return setup.vaultDir ? "set" : "none";
}

/** Lokal, noch nie ein Session-Ereignis: fehlen die Hooks, liefen schon Sessions ohne Ereignis, oder kommt es erst noch? */
async function ingestWaiting(ctx: ConnectionsContext): Promise<CheckOutcome | null> {
  if (!isLocal(ctx) || !ctx.bridge.status().online) return null;
  const setup = await ctx.bridgeSetup();
  if (setup && !setup.hooks.claude) {
    return {
      state: "user",
      result: "Hooks nicht eingetragen",
      cause: "Die Hooks für Claude sind noch nicht eingetragen — ohne sie sieht NyxOS nicht live, was deine Sessions gerade tun.",
      fix: "Einstellungen → Info & Hilfe → „Onboarding erneut starten“ und dort die Hooks eintragen.",
    };
  }
  // Liefen seit der Einrichtung schon Claude-Sessions (der Datei-Wächter sieht sie), hätten Ereignisse kommen müssen.
  const row = await firstRow(ctx.db, sql`select count(*)::int as n from sessions where tool = 'claude' and last_activity_at > (select min(created_at) from machines) + interval '10 minutes'`);
  if (num(row.n) > 0) {
    return {
      state: "warn",
      cause: "Seit der Einrichtung liefen Claude-Sessions, aber es kam kein Ereignis an. Die Hooks greifen erst in neu gestarteten Sessions.",
      fix: "Eine neue Claude-Session starten; bleibt es leer: `nyxos doctor`.",
    };
  }
  return { state: "idle", result: "noch keine Session", cause: FIRST_SESSION };
}

/** Lokal, noch kein Git-Stand: der Scan lief schon (nur kein Repo gefunden) oder läuft gleich — kein Fehler. */
async function localGitWaiting(ctx: ConnectionsContext): Promise<CheckOutcome> {
  const { report, offline } = await bridgeReport(ctx);
  if (offline) return { state: "fail", cause: "Kanal zur Brücke ist zu — der Git-Scan läuft nicht.", fix: "Erst den Kanal wieder verbinden (Punkt „Kanal zur Brücke“)." };
  const setup = await ctx.bridgeSetup();
  if (setup && !setup.tools.git) return { state: "ok", result: "Git ist hier nicht installiert (optional)" };
  if (report?.scans.git) return { state: "idle", result: "noch kein Repo", cause: "Der Git-Scan läuft, hat aber noch kein Git-Repo gefunden. Repos erscheinen, sobald du in einem Projekt mit Git arbeitest oder Projekt-Ordner einträgst." };
  if (justConnected(ctx)) return { state: "idle", cause: "Der erste Git-Scan läuft gleich." };
  return { state: "fail", cause: "Der Git-Scan ist seit dem Start der Brücke nicht gelaufen.", fix: LOGS_HINT, command: BRIDGE_RESTART };
}

const HAIKU_WAITS: CheckOutcome = {
  state: "user",
  cause: "Wartet auf deinen Nyx-Token. Sobald er gesetzt ist, startet Nyx von selbst.",
  fix: "Einmal im eigenen Terminal ausführen (Browser-Login), den Token als CLAUDE_CODE_OAUTH_TOKEN in die .env des Servers eintragen und NyxOS neu starten.",
  command: HAIKU_TOKEN_CMD,
};

// ───────────────────────────── Prüfungen ─────────────────────────────

type Def = CheckDef<ConnectionsContext>;

const serverChecks: Def[] = [
  {
    id: "db",
    group: "server",
    label: "Datenbank „nyxos“",
    expected: "antwortet, Sessions lesbar",
    fix: "Datenbank prüfen (`nyxos doctor`) — NyxOS verbindet sich danach von selbst neu.",
    run: async (ctx) => {
      const c = (await ctx.health()).checks.database;
      if (!c.ok) return { state: "fail", cause: t("Datenbank antwortet nicht: {error}", { error: c.error ?? t("unbekannt") }), fix: "Datenbank prüfen (`nyxos doctor`) — NyxOS verbindet sich danach von selbst neu." };
      return { state: "ok", result: t("{n} Sessions", { n: num(c.detail?.sessions) }) };
    },
  },
  {
    id: "schema",
    group: "server",
    label: "Datenbank-Schema",
    expected: "alle Migrationen eingespielt",
    run: async (ctx) => {
      const c = (await ctx.health()).checks.schema;
      if (!c.ok) return { state: "fail", cause: c.error ?? "Schema unvollständig", fix: "NyxOS neu starten — der Start spielt fehlende Migrationen ein.", command: RESTART_CMD };
      return { state: "ok", result: "vollständig" };
    },
  },
  {
    id: "archive",
    group: "server",
    label: "Archiv-Volume",
    expected: "schreib- und lesbar, mindestens 1 GB frei",
    local: { label: "Archiv-Ordner" },
    run: async (ctx) => {
      const c = (await ctx.health()).checks.archive;
      if (!c.ok) return { state: "fail", cause: t("Archiv nicht nutzbar: {error}", { error: c.error ?? t("unbekannt") }), fix: isLocal(ctx) ? "Platz auf der Festplatte und Rechte des Datenordners prüfen (`nyxos doctor`)." : "Volume nyxos-archive auf dem Server prüfen (Platz, Rechte)." };
      const free = num(c.detail?.freeBytes);
      return { state: "ok", result: t("{n} GB frei", { n: (free / 1e9).toFixed(0) }) };
    },
  },
];

const bridgeChecks: Def[] = [
  {
    id: "bridge-channel",
    group: "bruecke",
    label: "Kanal zur Brücke",
    expected: "verbunden",
    local: { label: "Kanal zur Brücke" },
    run: async (ctx) => {
      const s = ctx.bridge.status();
      if (!s.online && isLocal(ctx)) {
        return { state: "fail", cause: "Die Brücke auf diesem Rechner ist gerade nicht verbunden (gestoppt oder noch beim Starten).", fix: "Brücke neu starten — sie verbindet sich danach in wenigen Sekunden von selbst.", command: BRIDGE_RESTART };
      }
      if (!s.online) {
        return {
          state: "fail",
          cause: "Die Brücke hat gerade keine Verbindung zum Server (Mac aus, Tunnel zu oder Brücke gestoppt).",
          fix: "Brücke neu starten — sie verbindet sich danach in wenigen Sekunden von selbst.",
          command: BRIDGE_RESTART,
        };
      }
      const since = toMs(s.since);
      return { state: "ok", result: since ? t("verbunden seit {time}", { time: clock(since) }) : t("verbunden") };
    },
  },
  {
    id: "bridge-rpc",
    group: "bruecke",
    label: "Brücke antwortet auf Befehle",
    expected: "Antwort in unter 3 s",
    timeoutMs: 4000,
    run: async (ctx) => {
      if (!ctx.bridge.status().online) return { state: "fail", cause: "Kanal zur Brücke ist zu — Befehle kommen nicht an.", fix: isLocal(ctx) ? "Erst den Kanal wieder verbinden (Punkt „Kanal zur Brücke“)." : "Erst den Kanal wieder verbinden (Punkt „Kanal zur Brücke“)." };
      const r = await ctx.bridge.rpc("list_folders", {}, 3000);
      if (!r.ok) return { state: "fail", cause: t("Brücke antwortet nicht: {error}", { error: r.error ?? t("unbekannt") }), fix: "Brücke neu starten.", command: BRIDGE_RESTART };
      const folders = (r.result as { folders?: unknown[] } | undefined)?.folders?.length ?? 0;
      // Gezählt werden die Ordner, die „Neue Session“ anbietet (Projekt-Ordner samt Unterordnern, ohne
      // eingetragene Projekt-Ordner das Home-Verzeichnis) — nicht die eingetragenen Projekt-Ordner.
      if (isLocal(ctx)) return { state: "ok", result: t("{n} Ordner für „Neue Session“", { n: folders }) };
      return { state: "ok", result: t("{n} Projekt-Ordner gemeldet", { n: folders }) };
    },
  },
  {
    id: "bridge-heartbeat",
    group: "bruecke",
    label: "Letztes Lebenszeichen der Brücke",
    expected: "jünger als 2 Min",
    run: async (ctx) => {
      const row = await firstRow(ctx.db, sql`select name, last_seen_at from machines order by last_seen_at desc nulls last limit 1`);
      const last = toMs(row.last_seen_at);
      const now = ctx.now();
      const name = typeof row.name === "string" ? row.name : "Mac";
      if (last === null) return { state: "fail", cause: "Die Brücke hat sich noch nie gemeldet.", fix: isLocal(ctx) ? "Brücke neu starten." : "Brücke installieren bzw. neu starten.", command: BRIDGE_RESTART };
      const age = now - last;
      // Lokal gibt es nur diesen einen Rechner — sein interner Name („local“) sagt nichts.
      const result = isLocal(ctx) ? ago(last, now) : `${name}: ${ago(last, now)}`;
      if (age < 2 * MIN) return { state: "ok", result };
      // Kanal offen, aber lange nichts gesendet: kein Ausfall, nur Stille.
      if (ctx.bridge.status().online || age < 30 * MIN) return { state: "warn", result, cause: "Die Brücke ist verbunden, hat aber länger nichts geliefert — das Lebenszeichen zählt nur, wenn Daten fließen.", fix: "Nichts zu tun, solange der Kanal verbunden ist. Sonst Brücke neu starten." };
      return { state: "fail", result, cause: "Seit über 30 Minuten kein Lebenszeichen der Brücke.", fix: "Brücke neu starten.", command: BRIDGE_RESTART };
    },
  },
  {
    id: "bridge-ingest",
    group: "bruecke",
    label: "Ingest (Session-Ereignisse)",
    expected: "Ereignisse kommen an",
    run: async (ctx) => {
      const row = await firstRow(ctx.db, sql`select max(received_at) as last, count(*)::int as n from session_events where received_at > now() - interval '24 hours'`);
      const last = toMs(row.last);
      const now = ctx.now();
      if (last === null) {
        const any = await firstRow(ctx.db, sql`select max(received_at) as last from session_events`);
        const lastAny = toMs(any.last);
        if (lastAny === null) {
          const waiting = await ingestWaiting(ctx);
          if (waiting) return waiting;
          return { state: "fail", cause: "Es ist noch nie ein Session-Ereignis angekommen.", fix: isLocal(ctx) ? "Brücke und ihre Hooks prüfen (`nyxos status`, sonst `nyxos restart`)." : "Brücke und ihre Hooks prüfen (`nyxos status`, sonst `nyxos restart`)." };
        }
        return { state: "warn", result: t("zuletzt {ago}", { ago: ago(lastAny, now) }), cause: "In den letzten 24 Stunden kam kein Ereignis an — entweder keine Session gelaufen oder der Ingest hängt.", fix: "Wenn Sessions liefen: Puffer der Brücke prüfen (Punkt „Puffer der Brücke“)." };
      }
      return { state: "ok", result: t("zuletzt {ago} · {n} in 24 Std", { ago: ago(last, now), n: num(row.n) }) };
    },
  },
  {
    id: "bridge-buffer",
    group: "bruecke",
    label: "Puffer der Brücke",
    expected: "leer oder klein, nichts abgelehnt",
    timeoutMs: 4000,
    run: async (ctx) => {
      const { report, offline, error } = await bridgeReport(ctx);
      if (offline) return { state: "fail", cause: "Kanal zur Brücke ist zu — Puffer nicht abfragbar.", fix: "Erst den Kanal wieder verbinden." };
      if (!report) return { state: "warn", cause: `${t(OLD_BRIDGE)}${error ? ` (${error})` : ""}`, fix: OLD_BRIDGE_FIX };
      const result = [t("{queued} wartend · {dead} abgelehnt", { queued: report.queued, dead: report.dead }), ...(report.lastOkAt ? [t("zuletzt gesendet {ago}", { ago: ago(report.lastOkAt, ctx.now()) })] : [])].join(" · ");
      if (report.dead > 0) return { state: "warn", result, cause: t("{n} Pakete hat der Server abgelehnt{detail}.", { n: report.dead, detail: report.lastError ? ` (${report.lastError})` : "" }), fix: "Brückenlog prüfen (`nyxos logs`) — abgelehnte Pakete gehen nicht verloren, sie liegen im Puffer." };
      if (report.queued > 1000) return { state: "warn", result, cause: "Der Puffer ist groß — der Server nimmt gerade nicht alles an.", fix: "Tunnel und Server prüfen; der Puffer leert sich danach von selbst." };
      return { state: "ok", result };
    },
  },
  {
    id: "bridge-tmux",
    group: "bruecke",
    label: "Terminal-Sitzungen auf dem Rechner",
    expected: "Sitzungs-Dienst auf dem Rechner antwortet",
    local: { label: "Terminal-Sitzungen", expected: "Sitzungs-Dienst (tmux) antwortet" },
    timeoutMs: 4000,
    run: async (ctx) => {
      const { report, offline } = await bridgeReport(ctx);
      if (offline) return { state: "fail", cause: "Kanal zur Brücke ist zu — die Terminal-Sitzungen sind nicht abfragbar.", fix: "Erst den Kanal wieder verbinden." };
      if (report) {
        if (!report.tmux.ok && isLocal(ctx)) return { state: "fail", cause: t("Der Sitzungs-Dienst (tmux) antwortet nicht ({error}).", { error: report.tmux.error ?? t("unbekannt") }), fix: "Brücke neu starten; hilft das nicht, tmux installieren (`nyxos doctor` nennt den Befehl).", command: BRIDGE_RESTART };
        if (!report.tmux.ok) return { state: "fail", cause: t("Der Sitzungs-Dienst auf dem Rechner antwortet nicht ({error}).", { error: report.tmux.error ?? t("unbekannt") }), fix: "Brücke neu starten; hilft das nicht, tmux neu installieren (brew install tmux).", command: BRIDGE_RESTART };
        return { state: "ok", result: t("{n} Terminal-Sitzungen", { n: report.tmux.sessions }) };
      }
      const socket = ctx.bridge.status().tmuxSocket ?? null;
      if (socket) return { state: "ok", result: "Brücke meldet den Sitzungs-Dienst" };
      return { state: "warn", cause: OLD_BRIDGE, fix: OLD_BRIDGE_FIX };
    },
  },
  {
    id: "bridge-watcher",
    group: "bruecke",
    label: "Datei-Wächter (Verläufe)",
    expected: "Verläufe werden archiviert",
    timeoutMs: 4000,
    run: async (ctx) => {
      const row = await firstRow(ctx.db, sql`select max(updated_at) as last, count(*)::int as n from archive`);
      const last = toMs(row.last);
      const now = ctx.now();
      const { report } = await bridgeReport(ctx);
      const result = [t("{n} Verläufe archiviert · zuletzt {ago}", { n: num(row.n), ago: ago(last, now) }), ...(report ? [t("{n} Dateien im Blick", { n: report.watchedFiles })] : [])].join(" · ");
      if (report?.archiveError) return { state: "warn", result, cause: t("Letztes Hochladen schlug fehl: {error}", { error: report.archiveError }), fix: "Wird automatisch wiederholt. Bleibt es, Archiv-Volume prüfen." };
      if (last === null) return (await waitingForFirstData(ctx)) ?? { state: "fail", result, cause: "Noch kein Verlauf im Archiv.", fix: isLocal(ctx) ? "Brücke prüfen (`nyxos status`, sonst `nyxos restart`)." : "Brücke prüfen (`nyxos status`, sonst `nyxos restart`)." };
      if (now - last > 2 * DAY) return { state: "warn", result, cause: "Seit über 2 Tagen wurde kein Verlauf archiviert.", fix: "Wenn Sessions liefen: Brückenlog prüfen." };
      return { state: "ok", result };
    },
  },
  {
    id: "bridge-git",
    group: "bruecke",
    label: "Git-Scan",
    expected: "alle 10 Min, jünger als 30 Min",
    timeoutMs: 4000,
    run: async (ctx) => {
      const row = await firstRow(ctx.db, sql`select max(scanned_at) as last, count(*)::int as n from git_repos`);
      const last = toMs(row.last);
      const now = ctx.now();
      if (last === null && isLocal(ctx)) return localGitWaiting(ctx);
      if (last === null) return { state: "fail", cause: "Es ist noch kein Git-Stand angekommen — die installierte Brücke scannt Git nicht.", fix: "NyxOS aktualisieren — die neue Brücke scannt Git.", command: UPDATE_CMD };
      const result = t("{n} Repos · zuletzt {ago}", { n: num(row.n), ago: ago(last, now) });
      if (now - last > 30 * MIN) return { state: "fail", result, cause: "Der letzte Git-Stand ist älter als 30 Minuten — der Scan läuft nicht mehr.", fix: "Git-Scan in der installierten Brücke einschalten bzw. Brücke neu starten.", command: BRIDGE_RESTART };
      return { state: "ok", result };
    },
  },
  {
    id: "bridge-vault",
    group: "bruecke",
    label: "Vault-Scan (Obsidian)",
    expected: "letzter Abgleich jünger als 1 Tag",
    timeoutMs: 4000,
    run: async (ctx) => {
      // Lokal ohne eingerichteten Vault gibt es nichts zu scannen — der Punkt „Obsidian-Vault“ sagt das einmal.
      if (isLocal(ctx) && (await localVault(ctx)) !== "set") return { state: "ok", hidden: true };
      const { report } = await bridgeReport(ctx);
      const now = ctx.now();
      if (report) {
        if (report.vaultError) return { state: "fail", result: t("zuletzt {ago}", { ago: ago(report.scans.vault, now) }), cause: t("Vault-Abgleich schlug fehl: {error}", { error: report.vaultError }), fix: LOGS_HINT };
        if (report.scans.vault !== null) return { state: now - report.scans.vault > DAY ? "warn" : "ok", result: t("zuletzt {ago}", { ago: ago(report.scans.vault, now) }), cause: "Letzter Abgleich ist älter als 1 Tag.", fix: "Brücke neu starten.", command: BRIDGE_RESTART };
      }
      const row = await firstRow(ctx.db, sql`select max(updated_at) as last from vault_notes`);
      const last = toMs(row.last);
      if (last === null && isLocal(ctx) && justConnected(ctx)) return { state: "idle", cause: "Der erste Abgleich des Vaults läuft gleich." };
      if (last === null) return { state: "fail", cause: "Noch keine Obsidian-Notiz angekommen.", fix: "Vault-Pfad in der Brücke prüfen (config.json → vaultDir)." };
      return { state: "ok", result: t("letzte Notiz-Änderung {ago}", { ago: ago(last, now) }) };
    },
  },
  {
    id: "bridge-usage",
    group: "bruecke",
    label: "Nutzungs-Scan (Tokens)",
    expected: "läuft alle 30 s",
    timeoutMs: 4000,
    run: async (ctx) => {
      const { report } = await bridgeReport(ctx);
      const now = ctx.now();
      const row = await firstRow(ctx.db, sql`select max(created_at) as last, count(*)::int as n from usage_events`);
      const last = toMs(row.last);
      const result = [t("{n} Einträge · zuletzt neu {ago}", { n: num(row.n), ago: ago(last, now) }), ...(report?.scans.usage ? [t("Scan {ago}", { ago: ago(report.scans.usage, now) })] : [])].join(" · ");
      if (report?.scans.usage && now - report.scans.usage > 5 * MIN) return { state: "warn", result, cause: "Der Nutzungs-Scan ist seit über 5 Minuten nicht gelaufen.", fix: "Brücke neu starten.", command: BRIDGE_RESTART };
      if (last === null) return (await waitingForFirstData(ctx)) ?? { state: "fail", result, cause: "Noch keine Nutzungsdaten angekommen.", fix: isLocal(ctx) ? "Brücke prüfen (`nyxos status`, sonst `nyxos restart`)." : "Brücke prüfen (`nyxos status`, sonst `nyxos restart`)." };
      return { state: "ok", result };
    },
  },
];

const haikuChecks: Def[] = [
  {
    id: "haiku-engine",
    group: "haiku",
    label: "Nyx-Motor",
    expected: "eingeschaltet und bereit",
    run: async (ctx) => {
      if (!ctx.haiku) return { state: "fail", cause: "Nyx ist in diesem Server nicht eingebaut.", fix: "NyxOS aktualisieren.", command: UPDATE_CMD };
      const s = await ctx.haiku.status();
      if (s.engine.kind === "off") return { state: "warn", result: "ausgeschaltet", cause: "Nyx ist ausgeschaltet.", fix: "Einstellungen → Nyx: Motor „Claude-CLI (Max-Plan)“ wählen." };
      if (!s.engine.available && waitsForToken(ctx)) return { ...HAIKU_WAITS, result: s.engine.kind };
      // Lokal gibt es nur diesen einen Punkt für Nyx (kein Token, kein Arbeiter): fehlt das Claude-Programm,
      // steht hier einmal der Befehl zum Installieren — derselbe wie im Onboarding.
      if (!s.engine.available && isLocal(ctx) && s.engine.kind === "claude-cli") {
        if (s.engine.state === "waiting_token") {
          return {
            state: "user",
            result: "Claude-CLI",
            cause: "Das Claude-Programm ist auf diesem Rechner nicht installiert — ohne es kann Nyx nicht antworten.",
            fix: "Claude-Programm installieren (Befehl unten), danach einmal „claude“ im Terminal starten und anmelden. Nyx ist dann von selbst bereit.",
            command: CLAUDE_INSTALL_CMD,
          };
        }
        return { state: "fail", result: "Claude-CLI", cause: s.engine.reason ?? "Motor nicht bereit.", fix: "Claude-Programm neu installieren (Befehl unten) und einmal „claude“ im Terminal starten.", command: CLAUDE_INSTALL_CMD };
      }
      if (!s.engine.available && isLocal(ctx)) return { state: "fail", result: s.engine.kind, cause: s.engine.reason ?? "Motor nicht bereit.", fix: "Einstellungen → Nyx prüfen; „Motor testen“ zeigt den genauen Grund." };
      if (!s.engine.available) return { state: "fail", result: s.engine.kind, cause: s.engine.reason ?? "Motor nicht bereit.", fix: "Siehe „claude-CLI“, „Nyx-Token“ und „Nyx-Arbeiter“ darunter." };
      return { state: "ok", result: t("{engine} · Modell {model}", { engine: s.engine.kind === "api" ? t("Reserve-API") : "Claude-CLI", model: s.engine.model ?? "?" }) };
    },
  },
  {
    id: "haiku-cli",
    group: "haiku",
    label: "claude-CLI",
    expected: "auffindbar",
    // Lokal meldet der Nyx-Motor selbst, ob das Claude-Programm da ist (ein Punkt statt zwei für dieselbe Sache).
    modes: ["server"],
    run: async (ctx) => {
      if (ctx.worker) {
        if (ctx.worker.connectedAt) return { state: "ok", result: "bereit (Arbeiter verbunden)" };
        return HAIKU_WAITS;
      }
      const bin = ctx.findBin(ctx.env.CLAUDE_BIN ?? "claude");
      if (!bin) return { state: "fail", cause: "claude-CLI ist auf diesem Server nicht installiert.", fix: "Claude Code installieren (claude-CLI) oder CLAUDE_BIN auf das Programm zeigen lassen." };
      return { state: "ok", result: bin };
    },
  },
  {
    id: "haiku-token",
    group: "haiku",
    label: "Nyx-Token (Max-Plan)",
    expected: "gesetzt",
    // Lokal nutzt das Claude-Programm die Anmeldung dieses Rechners — ein Token auf dem Server gibt es nicht.
    modes: ["server"],
    run: async (ctx) => {
      const token = ctx.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
      if (token.startsWith("sk-ant-") && token.length > 20) return { state: "ok", result: "gesetzt" };
      if (ctx.worker?.connectedAt) return { state: "ok", result: "gesetzt (Arbeiter verbunden)" };
      // Lokales CLI ohne Agent-Container (Probe/Entwicklung): nutzt die eigene Anmeldung des Rechners.
      if (!ctx.worker && ctx.findBin(ctx.env.CLAUDE_BIN ?? "claude")) {
        return { state: "warn", result: "kein Token, lokales CLI", cause: "Kein Token gesetzt — das lokale CLI nutzt die Anmeldung dieses Rechners; ob sie gilt, zeigt erst der erste Nyx-Lauf.", fix: "Für den Server-Betrieb den Token setzen.", command: HAIKU_TOKEN_CMD };
      }
      return {
        state: "user",
        cause: "Der Token aus deinem Claude-Login fehlt auf dem Server — ohne ihn kann Nyx nicht antworten.",
        fix: "Einmal im eigenen Terminal ausführen (Browser-Login), den Token als CLAUDE_CODE_OAUTH_TOKEN in die .env des Servers eintragen und NyxOS neu starten.",
        command: HAIKU_TOKEN_CMD,
      };
    },
  },
  {
    id: "haiku-worker",
    group: "haiku",
    label: "Nyx-Arbeiter",
    expected: "verbunden",
    modes: ["server"],
    run: async (ctx) => {
      if (!ctx.worker) return { state: "ok", result: "läuft direkt im Server-Prozess (kein eigener Arbeiter)" };
      if (ctx.worker.connectedAt) return { state: "ok", result: t("verbunden seit {time}", { time: clock(Date.parse(ctx.worker.connectedAt)) }) };
      return HAIKU_WAITS;
    },
  },
  {
    id: "haiku-reserve",
    group: "haiku",
    label: "Reserve-API",
    expected: "eingerichtet (optional)",
    run: async (ctx) => {
      if (!ctx.haiku) return { state: "warn", result: "unbekannt", cause: "Nyx ist nicht eingebaut.", fix: "NyxOS aktualisieren.", command: UPDATE_CMD };
      const s = await ctx.haiku.status();
      if (s.reserve.configured) return { state: "ok", result: t("{model} über {url}", { model: s.reserve.model ?? t("Modell ?"), url: s.reserve.baseUrl ?? t("Standard-Adresse") }) };
      // Die Reserve ist freiwillig — ohne sie ist nichts kaputt, also grün mit Hinweis statt Warnung.
      return { state: "ok", result: "optional, nicht eingerichtet" };
    },
  },
];

const sourceChecks: Def[] = [
  {
    id: "import-source",
    group: "quellen",
    label: "Aufgaben-/Audit-Quelle",
    // Die Brücke liefert GOAL.md und Maßnahmenplan (`POST /ingest/entry-sources`), der
    // Server importiert daraus — kein Spiegel/Checkout auf dem Server nötig.
    expected: "Brücke liefert GOAL.md- und Audit-Dateien",
    local: { expected: "Brücke liefert GOAL.md- und Audit-Dateien (optional)" },
    run: async (ctx) => {
      const counts = await firstRow(
        ctx.db,
        sql`select count(*) filter (where source_type = 'goal')::int as goals, count(*) filter (where source_type = 'audit')::int as audits from entries`,
      );
      const imported = t("{goals} Aufgaben · {audits} Audits importiert", { goals: num(counts.goals), audits: num(counts.audits) });
      const st = await firstRow(ctx.db, sql`select state, last_delivery_at from import_status where source = 'dateien'`);
      const delivered = toMs(st.last_delivery_at);
      if (delivered === null && isLocal(ctx)) {
        // Lokal ist der Import freiwillig: ohne eingetragene Projekt-Ordner liefert die Brücke nichts — das ist kein Fehler.
        const setup = await ctx.bridgeSetup();
        if (setup && setup.projectRoots.length === 0) return { state: "ok", result: t("optional · liest GOAL.md aus Projekt-Ordnern, sobald welche eingetragen sind") };
        if (!ctx.bridge.status().online) return { state: "fail", result: imported, cause: "Kanal zur Brücke ist zu — die Aufgaben-Dateien kommen nicht an.", fix: "Erst den Kanal wieder verbinden (Punkt „Kanal zur Brücke“)." };
        if (justConnected(ctx) || !setup) return { state: "idle", result: imported, cause: "Die Brücke liefert die Aufgaben-Dateien gleich." };
        return { state: "fail", result: imported, cause: "Die Brücke hat die Aufgaben-Dateien (GOAL.md, Maßnahmenplan) noch nicht geschickt.", fix: "Brücke neu starten — sie liefert die Dateien danach von selbst.", command: BRIDGE_RESTART };
      }
      if (delivered === null) {
        return {
          state: "fail",
          result: imported,
          cause: "Die Brücke hat die Aufgaben-Dateien (GOAL.md, Maßnahmenplan) noch nicht geschickt.",
          fix: "Brücke mit dem aktuellen Stand neu starten — sie liefert die Dateien danach von selbst.",
          command: BRIDGE_RESTART,
        };
      }
      if (st.state === "leer" && isLocal(ctx)) return { state: "ok", result: t("optional · keine GOAL.md und kein Maßnahmenplan in den Projekt-Ordnern") };
      if (st.state === "leer") return { state: "warn", result: imported, cause: "Die Brücke hat geliefert, aber keine GOAL.md und keinen Maßnahmenplan gefunden.", fix: "Projekt-Ordner der Brücke prüfen (`nyxos doctor`)." };
      if (st.state === "fehler") return { state: "fail", result: imported, cause: "Der letzte Import der gelieferten Dateien ist schiefgegangen.", fix: "Aufgaben → „Jetzt importieren“; bleibt es rot, Server-Log ansehen." };
      return { state: "ok", result: `${imported} · ${t("zuletzt geliefert {ago}", { ago: ago(delivered, ctx.now()) })}` };
    },
  },
  {
    id: "vault",
    group: "quellen",
    label: "Obsidian-Vault in NyxOS",
    expected: "Notizen vorhanden",
    run: async (ctx) => {
      const row = await firstRow(ctx.db, sql`select count(*)::int as n, max(updated_at) as last from vault_notes`);
      const n = num(row.n);
      if (n === 0 && isLocal(ctx)) {
        const vault = await localVault(ctx);
        if (vault === "none") return { state: "ok", result: "optional, kein Vault eingerichtet" };
        if (vault === "unknown") return { state: "idle", result: "0 Notizen", cause: "Wird geprüft, sobald die Brücke verbunden ist." };
        const { report } = await bridgeReport(ctx);
        if (justConnected(ctx) || !report?.scans.vault) return { state: "idle", result: "0 Notizen", cause: "Die Notizen kommen mit dem ersten Abgleich des Vaults." };
      }
      if (n === 0) return { state: "fail", result: "0 Notizen", cause: "Es sind noch keine Obsidian-Notizen in NyxOS.", fix: "Vault-Scan der Brücke prüfen (Punkt „Vault-Scan“)." };
      return { state: "ok", result: t("{n} Notizen · letzter Abgleich {ago}", { n, ago: ago(toMs(row.last), ctx.now()) }) };
    },
  },
];

/** Lokal: Push aufs Handy ist freiwillig. Geprüft wird nur, was eingerichtet ist (ntfy.sh oder ein eigener Dienst). */
async function localNtfy(ctx: ConnectionsContext): Promise<CheckOutcome> {
  const row = await firstRow(ctx.db, sql`select ntfy_target from push_settings where id = 1`);
  const own = ctx.env.NTFY_BASE_URL?.trim();
  const base = row.ntfy_target === "ntfy_sh" ? NTFY_SH_URL : own ? own.replace(/\/$/, "") : null;
  if (!base) return OPTIONAL_OFF;
  try {
    const res = await fetchWithTimeout(ctx.fetch, `${base}/v1/health`, 3000);
    const body = (await res.json().catch(() => null)) as { healthy?: boolean } | null;
    if (res.ok && body?.healthy === true) return { state: "ok", result: base };
    return { state: "warn", result: base, cause: t("ntfy antwortet, meldet sich aber nicht gesund ({status}).", { status: res.status }), fix: "Später noch einmal prüfen; Mitteilungen an Rechner und Browser kommen trotzdem an." };
  } catch (e) {
    return { state: "warn", result: base, cause: t("ntfy nicht erreichbar: {error}.", { error: fetchError(e) }), fix: "Internet-Verbindung bzw. den ntfy-Dienst prüfen; Mitteilungen an Rechner und Browser kommen trotzdem an." };
  }
}

const opsChecks: Def[] = [
  {
    // Telegram-Bot (Long-Polling). Ohne Token kann nur der Nutzer es lösen (@BotFather).
    id: "telegram",
    group: "betrieb",
    label: "Telegram-Bot (Nyx)",
    expected: "verbunden und mit deinem Handy gekoppelt",
    local: { expected: "optional: verbunden und mit deinem Handy gekoppelt" },
    run: async (ctx) => {
      if (!ctx.telegram) return { state: "warn", result: "nicht eingebaut", cause: "Diese Server-Fassung hat den Telegram-Bot noch nicht.", fix: "NyxOS aktualisieren.", command: UPDATE_CMD };
      const st = await ctx.telegram.status();
      // Lokal ist Telegram freiwillig: ohne Token ist nichts kaputt.
      if (st.state === "no_token" && isLocal(ctx)) return OPTIONAL_OFF;
      if (st.state === "no_token") return { state: "user", result: "wartet auf Bot-Token", cause: "Wartet auf ein Bot-Token (@BotFather → /newbot).", fix: "Einstellungen → Telegram → Token eintragen." };
      if (st.state === "error") return { state: "fail", result: st.sentence, cause: st.sentence, fix: st.fix ?? "Einstellungen → Telegram prüfen." };
      if (st.state === "starting") return { state: "warn", result: "verbindet …", cause: "Der Bot verbindet sich gerade mit Telegram.", fix: "Kurz warten und neu prüfen." };
      const bot = st.bot ? `@${st.bot.username}` : t("verbunden");
      if (!st.paired) return { state: "user", result: t("{bot} · nicht gekoppelt", { bot }), cause: "Der Bot läuft, ist aber noch nicht mit deinem Handy gekoppelt.", fix: "Einstellungen → Telegram → „Kopplungs-Code erzeugen“ und dem Bot /start <code> schicken." };
      return { state: "ok", result: st.voice.ready ? t("{bot} · gekoppelt · Sprache bereit", { bot }) : t("{bot} · gekoppelt", { bot }) };
    },
  },
  {
    id: "socket-proxy",
    group: "betrieb",
    label: "Docker-Socket-Proxy (nur lesen)",
    expected: "liefert die Container-Liste",
    modes: ["server"],
    run: async (ctx) => {
      const base = (ctx.env.NYXOS_DOCKER_PROXY_URL ?? "http://socket-proxy:2375").replace(/\/$/, "");
      try {
        const ping = await fetchWithTimeout(ctx.fetch, `${base}/_ping`, 3000);
        const body = (await ping.text()).trim();
        if (!ping.ok || body !== "OK") return { state: "fail", result: base, cause: t("Socket-Proxy antwortet unerwartet ({status}).", { status: ping.status }), fix: "Socket-Proxy-Konfiguration prüfen (nur lesende Rechte, _ping erlaubt)." };
        // Erst die Container-Liste beweist, dass der Proxy das freigibt, wofür die NyxOS ihn braucht.
        const res = await fetchWithTimeout(ctx.fetch, `${base}/containers/json`, 3000);
        const list = res.ok ? ((await res.json().catch(() => null)) as unknown) : null;
        if (!Array.isArray(list)) return { state: "fail", result: base, cause: t("Socket-Proxy läuft, gibt die Container-Liste aber nicht heraus ({status}).", { status: res.status }), fix: "Im Socket-Proxy CONTAINERS=1 erlauben (weiter nur lesend) und den Dienst neu starten." };
        return { state: "ok", result: t("{base} · {n} Container", { base, n: list.length }) };
      } catch (e) {
        return { state: "fail", result: base, cause: t("Socket-Proxy nicht erreichbar: {error}.", { error: fetchError(e) }), fix: "Socket-Proxy (nur lesen) im Compose-Projekt „nyxos“ starten (Server-Modus, s. infra/docker-compose.yml)." };
      }
    },
  },
  {
    id: "dozzle",
    group: "betrieb",
    label: "Dozzle (Container-Logs)",
    expected: "läuft, Link gesetzt",
    modes: ["server"],
    run: async (ctx) => {
      const base = ctx.env.NYXOS_DOZZLE_INTERNAL_URL ?? "http://dozzle:8080";
      const link = ctx.env.NYXOS_DOZZLE_URL ?? null;
      try {
        const res = await fetchWithTimeout(ctx.fetch, `${base.replace(/\/$/, "")}/healthcheck`, 3000);
        // Nur ein gesunder Healthcheck zählt — ein 404 hieße: unter der Adresse läuft etwas anderes.
        if (!res.ok) return { state: "fail", result: base, cause: t("Dozzle meldet sich nicht gesund ({status}).", { status: res.status }), fix: "Dozzle-Container und seine Adresse prüfen." };
        if (!link) return { state: "warn", result: base, cause: "Dozzle läuft, aber die Web-App kennt keinen Link dorthin.", fix: "NYXOS_DOZZLE_URL in der .env des Servers setzen." };
        return { state: "ok", result: link };
      } catch (e) {
        return { state: "fail", result: base, cause: t("Dozzle nicht erreichbar: {error}.", { error: fetchError(e) }), fix: "Dozzle im Compose-Projekt „nyxos“ starten (Server-Modus, s. infra/docker-compose.yml)." };
      }
    },
  },
  {
    // Builds laufen auf dem MAC über die Brücke (RPC `run_build`), nie im Server-Container —
    // `pnpm` im Server-Abbild ist deshalb kein Kriterium (früher falsches Rot). Geprüft wird: Kanal da,
    // Brücke meldet die Fähigkeit `run_build`, und wie der letzte Lauf ausging.
    id: "build-guard",
    group: "betrieb",
    label: "Build-Wächter (Brücke)",
    expected: "Brücke kann Builds prüfen (run_build)",
    local: { label: "Build-Wächter", expected: "Brücke kann Builds prüfen (run_build)" },
    run: async (ctx) => {
      const last = await firstRow(ctx.db, sql`select status, log_excerpt, started_at from build_runs where status not in ('queued', 'running') order by started_at desc, id desc limit 1`);
      const lastStatus = typeof last.status === "string" ? last.status : null;
      const lastAgo = ago(toMs(last.started_at), ctx.now());
      const lastText = ` · ${lastStatus ? t("letzter Build {status} {ago}", { status: BUILD_STATUS_WORD[lastStatus] ? t(BUILD_STATUS_WORD[lastStatus]) : lastStatus, ago: lastAgo }) : t("noch kein Build gelaufen")}`;
      if (!ctx.bridge.status().online && isLocal(ctx)) {
        return { state: "fail", result: `${t("Brücke getrennt")}${lastText}`, cause: "Builds laufen über die Brücke — sie ist gerade nicht verbunden, neue Prüfungen warten.", fix: "Brücke neu starten — sie verbindet sich danach von selbst.", command: BRIDGE_RESTART };
      }
      if (!ctx.bridge.status().online) {
        return {
          state: "fail",
          result: `${t("Brücke getrennt")}${lastText}`,
          cause: "Builds laufen auf dem Rechner – die Brücke ist gerade nicht verbunden, neue Prüfungen warten.",
          fix: "Brücke neu starten — sie verbindet sich danach von selbst.",
          command: BRIDGE_RESTART,
        };
      }
      const supports = ctx.bridge.supports?.(BRIDGE_CAP_RUN_BUILD) ?? false;
      if (!supports) {
        return { state: "fail", result: `${t("Brücke ohne run_build")}${lastText}`, cause: "Die Brücke ist noch auf altem Stand und kann keine Builds prüfen.", fix: "NyxOS aktualisieren — die neue Brücke kann Builds prüfen.", command: UPDATE_CMD };
      }
      if (lastStatus === "unavailable") {
        const sentence = typeof last.log_excerpt === "string" ? (last.log_excerpt.split("\n")[0] ?? "").trim() : "";
        return { state: "warn", result: `${t("Brücke bereit")}${lastText}`, cause: sentence || "Der letzte Build war nicht eingerichtet.", fix: "Siehe Server-Tab → Letzte Builds." };
      }
      return { state: "ok", result: `${t("Brücke bereit")}${lastText}` };
    },
  },
  {
    id: "deploy-log",
    group: "betrieb",
    label: "Deploy-Protokoll",
    expected: "letzter Deploy eingetragen",
    modes: ["server"],
    run: async (ctx) => {
      const row = await firstRow(ctx.db, sql`select git_rev, created_at from deploys where project = 'nyxos' order by created_at desc, id desc limit 1`);
      const at = toMs(row.created_at);
      if (at === null) return { state: "ok", result: "noch kein Deploy protokolliert" };
      return { state: "ok", result: `${typeof row.git_rev === "string" ? row.git_rev.slice(0, 7) : "?"} · ${ago(at, ctx.now())}` };
    },
  },
  {
    id: "ntfy",
    group: "betrieb",
    label: "Push (ntfy)",
    expected: "Dienst gesund",
    local: { expected: "optional: Dienst gesund, wenn eingerichtet" },
    run: async (ctx) => {
      if (isLocal(ctx)) return localNtfy(ctx);
      const base = (ctx.env.NTFY_BASE_URL ?? "http://127.0.0.1:2586").replace(/\/$/, "");
      try {
        const res = await fetchWithTimeout(ctx.fetch, `${base}/v1/health`, 3000);
        const body = (await res.json().catch(() => null)) as { healthy?: boolean } | null;
        if (res.ok && body?.healthy === true) return { state: "ok", result: base };
        return { state: "fail", result: base, cause: t("ntfy antwortet, meldet sich aber nicht gesund ({status}).", { status: res.status }), fix: "ntfy-Container neu starten." };
      } catch (e) {
        const loopback = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(`${base}/`);
        if (loopback) {
          return {
            state: "fail",
            result: base,
            cause: t("ntfy nicht erreichbar: {error}. Im Container zeigt 127.0.0.1 auf den Server selbst, nicht auf ntfy.", { error: fetchError(e) }),
            fix: "NTFY_BASE_URL in der .env des Servers auf http://ntfy:80 setzen und NyxOS neu starten.",
          };
        }
        // Push ist freiwillig — der Dienst läuft nur im Compose-Profil „push“.
        return { state: "fail", result: base, cause: t("Der Push-Dienst läuft nicht: {error}.", { error: fetchError(e) }), fix: "Push-Dienst starten (Server-Modus, Compose-Profil „push“).", command: "docker compose --profile push up -d" };
      }
    },
  },
  // Stimmen-Dienst (Container nyx-voice). Laden (erster Start, Modell-Download) ist gelb, nicht rot.
  {
    id: "nyx-voice",
    group: "betrieb",
    label: "Stimme von Nyx (Erkennung + Sprachausgabe)",
    expected: "Erkennung und Stimme bereit",
    local: { expected: "optional: Erkennung und Stimme bereit" },
    run: async (ctx) => {
      const url = ctx.env.NYXOS_NYX_VOICE_URL?.trim();
      const st = ctx.voice ? await readNyxVoiceStatus(ctx.voice.backend, ctx.voice.scope) : await readNyxVoiceStatus(url ? new HttpNyxVoiceBackend(url, ctx.fetch) : null);
      const names = `${st.stt.model ?? "?"} · ${st.tts.voice ?? "?"}`;
      if (st.stt.ready && st.tts.ready) return { state: "ok", result: names };
      const worst = st.stt.ready ? st.tts : st.stt;
      if (isLocal(ctx)) {
        // Lokal ist die Stimme freiwillig, und die Container-Befehle des Server-Modus gelten hier nicht.
        if (worst.state === "not_configured") return OPTIONAL_OFF;
        const localFix = st.fix ?? "Stimme in den Einstellungen prüfen (optional).";
        if (worst.state === "offline" || worst.state === "error") return { state: "fail", result: worst.state === "offline" ? "läuft nicht" : names, cause: st.sentence, fix: localFix };
        return { state: "warn", result: names, cause: st.sentence, fix: localFix };
      }
      const fix = st.fix ?? t(NYX_VOICE_FIX_START);
      switch (worst.state) {
        case "not_configured":
          return { state: "warn", result: "nicht eingerichtet", cause: st.sentence, fix };
        case "offline":
          return { state: "fail", result: "läuft nicht", cause: st.sentence, fix, command: "docker compose --profile voice up -d" };
        case "error":
          return { state: "fail", result: names, cause: st.sentence, fix, command: "docker logs --tail 50 nyxos-nyx-voice" };
        default:
          return { state: "warn", result: names, cause: st.sentence, fix };
      }
    },
  },
];

const accessChecks: Def[] = [
  {
    id: "codex",
    group: "zugang",
    label: "Codex-Erkennung",
    expected: "Codex-Sessions werden erkannt",
    run: async (ctx) => {
      const row = await firstRow(ctx.db, sql`select count(*)::int as n, max(last_activity_at) as last from sessions where tool = 'codex'`);
      const n = num(row.n);
      if (n === 0 && isLocal(ctx)) {
        // Codex ist freiwillig: ohne Codex-Programm auf diesem Rechner gibt es nichts zu erkennen.
        const setup = await ctx.bridgeSetup();
        const installed = setup ? setup.tools.codex : ctx.findBin(ctx.env.CODEX_BIN ?? "codex") !== null;
        if (!installed) return { state: "ok", hidden: true };
        return { state: "idle", result: "0 Codex-Sessions", cause: "Kommt, sobald du Codex startest." };
      }
      if (n === 0) return { state: "warn", result: "0 Codex-Sessions", cause: "Bisher wurde keine Codex-Session erkannt.", fix: "Einmal Codex im Projektordner starten — erscheint sie nicht, Brückenlog prüfen." };
      return { state: "ok", result: t("{n} Codex-Sessions · zuletzt aktiv {ago}", { n, ago: ago(toMs(row.last), ctx.now()) }) };
    },
  },
  {
    id: "webauthn",
    group: "zugang",
    label: "Passkey-Anmeldung",
    expected: "über einen Namen geöffnet, Passkey eingerichtet",
    // Lokal meldet man sich mit einem Einmal-Link des `nyxos`-Befehls an; Passkeys über einen Namen sind Server-Technik.
    modes: ["server"],
    run: async (ctx) => {
      const host = ctx.requestHost ?? "";
      const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
      const row = await firstRow(ctx.db, sql`select count(*)::int as n from auth_credentials`);
      const passkeys = num(row.n);
      const sessions = num((await firstRow(ctx.db, sql`select count(*)::int as n from auth_sessions where expires_at > now()`)).n);
      const allowed = ctx.env.NYXOS_ALLOWED_HOSTS?.trim() ? ` · ${t("weitere Hosts: {hosts}", { hosts: ctx.env.NYXOS_ALLOWED_HOSTS })}` : "";
      const rp = hostname ? t("geöffnet über {url}", { url: `${ctx.requestProto}://${host}` }) : t("Adresse aus dem Aufruf");
      const result = `${rp} · ${t("{passkeys} Passkey(s) · {sessions} aktive Anmeldung(en)", { passkeys, sessions })}${allowed}`;
      if (hostname && (/^[\d.]+$/.test(hostname) || hostname.includes(":"))) return { state: "warn", result, cause: "Über eine IP-Adresse geöffnet — Passkeys brauchen einen Namen.", fix: "NyxOS über http://localhost:47801 öffnen." };
      if (passkeys === 0) return { state: "user", result, cause: "Es ist noch kein Passkey eingerichtet — ohne ihn gehen keine Aktionen.", fix: "Einstellungen → Anmeldung → „Passkey einrichten“ (den Einrichtungs-Code liefert dieser Befehl).", command: "docker exec nyxos-api node dist/cli.js passkey-setup" };
      return { state: "ok", result };
    },
  },
  {
    id: "csrf",
    group: "zugang",
    label: "Schutz vor fremden Aufrufen",
    expected: "ohne Anmeldung gesperrt, falscher Schlüssel gesperrt, richtiger durchgelassen",
    run: async (ctx) => {
      // Probe gegen einen Pfad ohne Route: die Anmelde-Schranke greift VOR der Route — kommt die
      // Anfrage durch, antwortet die App mit 404, geschrieben wird nie etwas.
      const path = "/api/connections/csrf-probe";
      const headers = { "content-type": "application/json" };
      const anon = await ctx.selfRequest(path, { method: "POST", headers, body: "{}" });
      if (anon.status !== 401) return { state: "fail", result: t("ohne Anmeldung {status}", { status: anon.status }), cause: "Eine Änderung ohne Anmeldung wird nicht gesperrt.", fix: "Anmelde-Schranke (terminal/auth.ts) prüfen — Sicherheitsfehler, sofort beheben." };
      // Kurzlebige Probe-Anmeldung: rückdatiert, so dass sie nach 2 Min von selbst ungültig ist, auch
      // wenn das Löschen unten scheitert. Echte Uhr (nicht `ctx.now`), weil die Anmelde-Schranke sie
      // ebenfalls nimmt. Das Token verlässt diese Funktion nie.
      const login = await createAuthSession(ctx.db, null, Date.now() - SESSION_TTL_MS + CSRF_PROBE_TTL_MS);
      try {
        const cookie = `${SESSION_COOKIE}=${login.token}`;
        const wrong = await ctx.selfRequest(path, { method: "POST", headers: { ...headers, cookie, [CSRF_HEADER]: "falsch" }, body: "{}" });
        if (wrong.status !== 403) return { state: "fail", result: t("falscher Schlüssel {status}", { status: wrong.status }), cause: "Eine Änderung mit falschem Schlüssel wird nicht gesperrt.", fix: "CSRF-Prüfung (terminal/auth.ts) prüfen — Sicherheitsfehler, sofort beheben." };
        const right = await ctx.selfRequest(path, { method: "POST", headers: { ...headers, cookie, [CSRF_HEADER]: login.csrf }, body: "{}" });
        if (right.status === 401 || right.status === 403) return { state: "fail", result: t("richtiger Schlüssel {status}", { status: right.status }), cause: "Mit gültiger Anmeldung wird trotzdem gesperrt — genau das zeigt sich als „CSRF-Token fehlt oder falsch“ beim Klicken.", fix: "Sitzungs-Speicher/CSRF-Abgleich prüfen." };
        return { state: "ok", result: "gesperrt · gesperrt · durchgelassen" };
      } finally {
        await ctx.db.delete(authSessions).where(eq(authSessions.tokenHash, createHash("sha256").update(login.token).digest("hex")));
      }
    },
  },
];

/** Alle Prüfungen in Anzeige-Reihenfolge (Gruppen wie `CONNECTION_GROUPS`). */
export function defaultConnectionChecks(): Def[] {
  return [...serverChecks, ...bridgeChecks, ...haikuChecks, ...sourceChecks, ...opsChecks, ...accessChecks];
}
