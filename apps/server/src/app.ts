import { createHash } from "node:crypto";
import type { AppMode } from "@nyxos/shared";
import { Updater } from "./app-info/updates.js";
import { BackgroundTasks } from "./background.js";
import { registerAppInfoRoutes } from "./routes/app-info.js";
import { createLocalLoginCode } from "./terminal/auth.js";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { ARCHIVE_HEADERS, ArchiveMetaSchema, codexSessionIdFromPath, EntrySourcesIngestSchema, IngestBatchSchema, SEARCH_ALL_MAX_QUERY_LENGTH, SEARCH_DEFAULT_LIMIT, NTFY_SH_URL, ToolSchema, type NightSettings, type NtfyTarget, type Tool, t } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ArchiveError, storeArchive } from "./archive.js";
import { BridgeBuildRunner } from "./builds/bridgeRunner.js";
import { notifyBuildDone } from "./builds/notify.js";
import { BuildQueue, type BuildDoneEvent } from "./builds/queue.js";
import { queueBuildsForStopSignals, stopSignalsFromBatch } from "./builds/watcher.js";
// Agenten & Skills, Nutzung — eigene Routen-Dateien, hier nur die Registrierung.
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerSkillsRoutes, type SkillsRouteOptions } from "./routes/skills.js";
import { registerSessionPanelsRoutes } from "./routes/session-panels.js";
import { DigestService } from "./session-digest.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { seedPrices } from "./usage/pricing.js";
import { sessionContext } from "./usage/query.js";
import { isArt, type Art } from "./categorize.js";
import type { Db } from "./db/client.js";
import { machines, sortRules } from "./db/schema.js";
import { checkHealth } from "./health.js";
import { getServerSnapshot } from "./server/store.js";
import { LiveHub } from "./live.js";
import { defaultNightSettings, registerNightRoutes } from "./routes/night.js";
import { registerBuildsRoutes } from "./routes/builds.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerVoiceRoutes, type VoiceRouteDeps } from "./routes/voice.js";
import { registerNyxVoiceRoutes } from "./routes/nyx-voice.js";
import { ELEVENLABS_SECRET } from "./nyx/elevenlabs.js";
import { ConfiguredVoiceBackend, loadVoiceSettings } from "./nyx/voice-settings.js";
import { nyxVoiceBackendFromEnv } from "./nyx/voice-backend.js";
import { registerApprovalsRoutes } from "./routes/approvals.js";
import { registerHaikuRoutes, remoteEngine, type HaikuRouteOptions } from "./routes/haiku.js";
import { registerModelsRoutes, type ModelsRouteDeps } from "./routes/models.js";
import { registerNyxTabRoutes } from "./routes/nyx-tab.js";
import { NyxUiBridge, registerNyxUiRoutes, registerNyxUiTools } from "./nyx/ui.js";
// Nyx bedient ganz NyxOS über die eigene API (Werkzeuge app_api / app_api_katalog).
import { AppApiService, registerAppApiTools } from "./nyx/appApi/service.js";
// Verbindungs-Prüfung (Logik in ./connections/).
import { registerConnectionsRoutes, type ConnectionsRouteOptions } from "./connections/route.js";
import { registerTemporaryRoutes } from "./routes/temporary.js";
import { applyTemporaryMarks, isProbeSocket, loadTemporaryHours, reviveArchived, runTemporaryTicker, sessionExpiresAt } from "./temporary.js";
import { registerIdeaLinkRoutes } from "./routes/idealink.js";
// Zugänge (Schlüssel/Tokens an einer Stelle, alles auf einmal einrichten).
import { AccessService } from "./access/service.js";
import { registerAccessRoutes } from "./routes/access.js";
import { HaikuScheduler } from "./haiku/scheduler.js";
import { registerTerminalRoutes } from "./routes/terminal.js";
import { HttpNtfySender, type NtfySender } from "./push/ntfy.js";
import { MultiChannelSender } from "./push/channels.js";
import { notify } from "./push/dispatcher.js";
import { loadOrInitSettings } from "./push/settings.js";
import { checkWaitingSessions } from "./push/waiting.js";
import { AwayService } from "./away/service.js";
import { registerAwayRoutes } from "./routes/away.js";
import { checkUsageWarnings } from "./usage/warnings.js";
import { createAuth, type AuthOptions } from "./terminal/auth.js";
import { BridgeHub } from "./terminal/bridgeHub.js";
import { BridgePresence } from "./bridge/presence.js";
import { registerBridgePresenceRoutes } from "./routes/bridge-presence.js";
// PG „Gehirn": Graph-API (eigene Datei).
import { GraphService } from "./graph/service.js";
import { dbEntriesProvider } from "./graph/sources/entries.js";
import { dbGitProvider } from "./graph/sources/git.js";
import { defaultGraphSources, registerGraphRoutes, type GraphProviders } from "./routes/graph.js";
import { isAllowedHost, isAllowedOrigin, originMatchesHost, parseAllowedHosts } from "./security.js";
// Aufgaben/Ideen/Audit — eigene Route-Datei, hier nur die Registrierungszeile.
import { entriesRoutes } from "./routes/entries.js";
import { EntriesImportService, IngestPathError } from "./entries/importService.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerFinderRoutes } from "./routes/finder.js";
import { registerAuditRoutes } from "./routes/audits.js";
import { flushDeliveries, deliverOrQueue, type DeliveryDeps } from "./delivery/queue.js";
import { registerDeliveryRoutes } from "./delivery/routes.js";
// Suche, eigener Block (siehe apps/server/src/search.ts).
import { indexChatDocs, search } from "./search.js";
import { searchAll } from "./search-all.js";
// Überblick, Git, Konflikte, Server, Lernbuch — je ein Einzeiler, Logik in den
// gleichnamigen Ordnern (apps/server/src/{overview,git,conflicts,server,lessons}/).
import { registerConflictRoutes } from "./routes/conflicts.js";
import { ConflictModelService } from "./conflicts/model.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerLessonRoutes } from "./routes/lessons.js";
// Nyx-Persönlichkeit + Nutzerprofil (Einstellungen → Nyx).
import { registerNyxProfileRoutes } from "./routes/nyx-profile.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerRecentRoutes } from "./routes/recent.js";
import { registerOverviewRoutes } from "./routes/overview.js";
import { registerServerRoutes } from "./routes/server.js";
import type { ServerSourcesOptions } from "./server/store.js";
// Kontext-Wächter — Einzeiler wie oben, Logik in ./context-guard/.
import { registerContextGuardRoutes } from "./routes/context-guard.js";
import { defaultContextPctSource, runContextGuardForSessions, runContextGuardTicker, type ContextPctSource } from "./context-guard/tick.js";
import {
  assignSession,
  closeSession,
  getRelatedSessions,
  getSessionDetail,
  getSessions,
  ingest,
  listArchive,
  listCategories,
  listSessions,
  previewAssign,
  recordArchive,
  reopenSession,
  resortAll,
  retickIdleStates,
  unassignSession,
  SkillsCache,
} from "./store.js";
import { NOT_FOUND, parseSerialId } from "./ids.js";
// Chat-Verlauf-Endpunkt, eigener Block (siehe apps/server/src/transcript.ts).
import { getSessionTranscript, loadPromptImage, TranscriptCache, TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT } from "./transcript.js";
import { registerSessionChatRoutes } from "./routes/session-chat.js";
import { registerPromptAssistRoutes } from "./routes/prompt-assist.js";
import { registerSessionAuditRoutes } from "./routes/session-audit.js";
// Telegram-Bot (Long-Polling, kein Port) + Einstellungen → Telegram.
import { registerTelegramRoutes } from "./routes/telegram.js";
import { startTerminalSession } from "./routes/terminal.js";
import { runtimeNyxChannel } from "./telegram/nyx.js";
import { readNyxFile } from "./nyx/files.js";
import { TelegramService, type TelegramServiceDeps } from "./telegram/service.js";
import { loadTelegramState, settingsOf } from "./telegram/store.js";
import { secretStoreTokenSource } from "./telegram/tokens.js";
import { SecretStore } from "./secrets/store.js";
import { adaptNyxVoiceBackend, nyxVoiceFromEnv } from "./telegram/voice.js";
import type { LocalVoicePack } from "./voice/local-pack.js";
import { StartRequestSchema } from "@nyxos/shared";
// Demo: read-only guard, Nyx in the demo, "Demo ansehen" from the onboarding (demo/*, routes/demo.ts).
import { homedir } from "node:os";
import { DEMO_DEFAULT_PORT, DemoLauncher } from "./demo/launcher.js";
import { DEMO_SYSTEM_NOTE, ScriptedDemoEngine, type DemoEngineKind } from "./demo/nyx.js";
import { DEMO_NYX_TOOLS, demoReadonlyGuard } from "./demo/readonly.js";
import { registerDemoRoutes } from "./routes/demo.js";

/**
 * Cache-Kopf für die ausgelieferte Web-App.
 * - `/assets/*` (von Vite mit Inhalts-Hash benannt) ändert sich nie → ein Jahr, unveränderlich.
 * - HTML (index.html, SPA-Rückfall) → immer neu prüfen, sonst lädt die Dock-App nach einem Deploy alte Skripte.
 * - alles andere aus `public/` (Symbole, Manifest – feste Namen) → einen Tag.
 */
export function staticCacheControl(path: string): string {
  if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (path === "/" || path.endsWith(".html")) return "no-cache";
  return "public, max-age=86400";
}

/** Wie `transcript.ts` (dort privat) erkennt, ob ein hochgeladener Archiv-Pfad die Hauptdatei der
 * Session ist (nicht ein Sub-Agent) — der Chat-Text wird nur für die Hauptdatei neu indiziert. */
function isMainArchivePath(tool: Tool, sessionId: string, path: string): boolean {
  return tool === "claude" ? path.split("/").pop() === `${sessionId}.jsonl` : codexSessionIdFromPath(path) === sessionId;
}

/** Formt eine Session-Zeile für die Web-App: `art`/`baustelle`/`reason` statt der rohen `category_*`-Spalten. */
function toSessionDTO<
  T extends {
    categoryArt: string | null;
    categoryBaustelleSlug: string | null;
    categoryBaustelleLabel: string | null;
    categoryReason: unknown;
    lastUsage: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
    lastUsageModel: string | null;
    modelContextWindow: number | null;
  },
>(row: T & { temporarySince: string | null; lastActivityAt: string | null }, temporaryHours: number) {
  const { categoryArt, categoryBaustelleSlug, categoryBaustelleLabel, categoryReason, ...rest } = row;
  // Kontext-Anteil der letzten Antwort ggü. dem Kontextfenster des Modells — `null` heißt
  // "unbekannt" (Modell ohne hinterlegtes Fenster), nie geschätzt (s. usage/query.ts).
  const { contextPct, contextWindow, contextWindowSource } = sessionContext(row);
  return {
    ...rest,
    art: categoryArt ?? "unsortiert",
    baustelle: categoryBaustelleSlug ? { slug: categoryBaustelleSlug, label: categoryBaustelleLabel ?? categoryBaustelleSlug } : null,
    reason: categoryReason ?? [],
    contextPct,
    contextWindow,
    contextWindowSource,
    // wann die temporäre Session archiviert wird (null = normale Session), Marke „⏳ 4 Std“ im Web.
    temporaryExpiresAt: sessionExpiresAt(row, temporaryHours),
  };
}

export interface AppDeps {
  db: Db;
  archiveDir: string;
  /** Version, run mode and update handling for `/api/app/*` (Info page, onboarding, language). */
  appInfo?: { version: string; mode: AppMode; demo: boolean; dataDir: string | null; updater: Updater };
  webDir?: string;
  hub?: LiveHub;
  /** Herzschlag auf `/live` (ms, 0 = aus). */
  livePingMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** LRU-Cache für geparste Verläufe (nur Hauptdatei/Suche), s. transcript.ts. Eigenes Feld,
   * damit Tests ihn beobachten/ersetzen können. */
  transcriptCache?: TranscriptCache;
  /** eigener, größerer LRU für Sub-Agent-Verläufe (Anzahl-Badge + expliziter
   * Abruf), damit Sub-Agent-Dateien nie den Hauptverlauf-Cache verdrängen. */
  subagentTranscriptCache?: TranscriptCache;
  /** zusätzliche erlaubte Hosts/Origins (Komma-Liste), s. security.ts. Default
   * liest `NYXOS_ALLOWED_HOSTS` aus der Umgebung — Tests können hier gezielt überschreiben. */
  allowedHosts?: string | null;
  /**: Skill-Namen-Zwischenspeicher über die Prozesslaufzeit, s. store.ts.
   * Eigenes Feld wie `transcriptCache`, damit Tests ihn beobachten/ersetzen können. */
  skillsCache?: SkillsCache;
  /** Push: Versand-Weg (echt: `HttpNtfySender`, Tests: ein Fake, das nur aufzeichnet). */
  pushSender?: NtfySender;
  /** Build-Wächter: eigene Warteschlange (Tests ersetzen den `runner`, s. `builds/queue.ts`). */
  buildQueue?: BuildQueue;
  /** wo `derived-data/<hash>` je Worktree liegt — NIE des Nutzers echter Xcode-Pfad. */
  buildsDir?: string;
  /** Nachtmodus: Startwerte für Fenster/Budget (Vorschläge, s. `routes/night.ts`). */
  nightSettings?: NightSettings;
  /** Tests ersetzen Umgebung (Schlüssel) und fetch der Anbieter/Konnektoren. */
  models?: Partial<Pick<ModelsRouteDeps, "env" | "fetchImpl" | "devicePollMs">>;
  /** Haiku: Motor/Uhr/Werkzeuge austauschbar (Tests setzen einen Fake-Motor). */
  haiku?: HaikuRouteOptions;
  /** Anmeldung (Passkey + Cookie + CSRF) für alles, was schreibt, s. terminal/auth.ts. */
  auth?: AuthOptions;
  /** Verbindung zur Brücke (Terminal-Kanäle, Starten/Fortsetzen). Tests können eine eigene übergeben. */
  bridgeHub?: BridgeHub;
  /** Uhr der Brücken-Anwesenheit (Tests stellen sie vor) und Ping-Takt des Brücken-Kanals. */
  bridgeNow?: () => number;
  bridgePingMs?: number;
  /** PG: Graph-Dienst (Tests können ihn ersetzen) und optionale Quellen anderer Phasen. */
  graph?: GraphService;
  graphProviders?: GraphProviders;
  /** Kontext-Anteil (0–100) einer Session, oder `null` = unbekannt. Standard:
   * `defaultContextPctSource()` – Test-Überschreibung (Probe) > echter P6-Wert (`computeContextPct`
   * aus `sessions.lastUsage`/`lastUsageModel`/`modelContextWindow`). Tests injizieren hier weiterhin
   * gezielt einen Wert, um Hinweis/Erzwingen ohne echte Nutzungsdaten zu prüfen. */
  getContextPct?: ContextPctSource;
  /** eigener DB-Handle nur für `/health` (Default: dieselbe `db`). Tests injizieren hier eine
   * Hülle, deren Abfragen wie ein echter Verbindungsverlust sofort fehlschlagen bzw. hängen
   * (Produktion, postgres-js) — ohne die für den Rest der App genutzte (echte Test-)DB zu schließen.
   * Ein geschlossener PGlite-Client hängt unter Last statt zu werfen und blockiert dabei die
   * Event-Loop, sodass selbst das Zeitlimit in `checkHealth` nicht mehr greift (s. `test/helpers.ts`). */
  healthDb?: Db;
  /** Zeitlimit je `/health`-Prüfung (Default: `DEFAULT_CHECK_TIMEOUT_MS` in health.ts, 3000 ms).
   * Tests verkürzen es, um eine Zeitüberschreitung schnell statt nach 3 s zu prüfen. */
  healthCheckTimeoutMs?: number;
  /** Verbindungs-Prüfung — Tests ersetzen Netz/Uhr bzw. die ganze Prüf-Liste. */
  connections?: ConnectionsRouteOptions;
  /** Quellen des Server-Tabs (Socket-Proxy, Revisionen) — Tests setzen Fakes. */
  server?: ServerSourcesOptions;
  /** Sprache (Tests setzen eigenes whisper/ffmpeg bzw. keins). `voice.nyx` = Stimmen-Dienst
   * (Tests: Fake bzw. `null`; ohne Angabe aus `NYXOS_NYX_VOICE_URL`). */
  /** `elevenFetch` ersetzt in Tests die Aufrufe an ElevenLabs. */
  voice?: VoiceRouteDeps & { elevenFetch?: typeof fetch };
  /** Telegram — Tests setzen Token-Quelle, Fake-Bot (`botFactory`), `polling: false`, Stimme, Nyx. */
  telegram?: Partial<Omit<TelegramServiceDeps, "db">>;
  /** Skill-Bibliothek: Tests setzen einen eigenen Vorschlags-Schreiber statt Haiku. */
  skills?: SkillsRouteOptions;
  /** Abwesenheit: Tests stellen die Uhr (Anwesenheit, Bündelung, Ruhezeit). */
  away?: { now?: () => number };
  /** Demo instance only (`appInfo.demo`): how Nyx answers and the way back to the real installation. */
  demo?: { engine: DemoEngineKind; homeUrl: string | null };
  /** Local mode: starts the demo instance for "Demo ansehen" (default: same program, NYXOS_HOME, NYXOS_DEMO_PORT). */
  demoLauncher?: DemoLauncher;
  /** Local mode (not the demo): the voice pack on this computer (`nyxos voice install`). Its `backend` is the
   * voice service; routes add the install button and sentences without Docker. */
  voicePack?: LocalVoicePack;
}

// Exportiert: die `register*Routes`-Helfer (routes/push|voice|builds|night|terminal.ts) tippen ihr
// `app`-Argument als `Hono<Env>` statt `Hono<any>` — `Hono` ohne Typ-Argument (BlankEnv) ist mit
// `Hono<Env>` wegen Handler-Kontravarianz nicht zuweisungskompatibel. `AppEnv` ist derselbe Typ unter
// dem Namen, den P3s `routes/terminal.ts` importiert.
export type Env = { Variables: { machineId: string } };
export type AppEnv = Env;

/** Schreibende Wege, deren Körper kein JSON ist (Audio, Dateien). Anmeldung + CSRF gelten trotzdem (`auth.gate`). */
// ElevenLabs-Stimmen-Klon nimmt die Hörprobe als multipart/form-data (wie /api/nyx/files).
const RAW_BODY_PATHS = new Set(["/api/voice/transcribe", "/api/nyx/voice/transcribe", "/api/nyx/files", "/api/nyx/voice/elevenlabs/clone"]);

/** Kennung im 404 für Pfade, die der Server nicht kennt (s. `app.notFound`). */
export const ROUTE_UNKNOWN = "route_unknown";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createApp(deps: AppDeps) {
  const { db, archiveDir } = deps;
  const hub = deps.hub ?? new LiveHub();
  if (deps.livePingMs !== 0 && hub instanceof LiveHub) hub.heartbeat(deps.livePingMs ?? 25_000);
  const log = deps.log ?? (() => {});
  // Everything started without `await` (ingest follow-ups, seeds at start) runs through here, so
  // `background.idle()` can wait for it before the database is closed (see background.ts).
  const background = new BackgroundTasks();
  const transcriptCache = deps.transcriptCache ?? new TranscriptCache();
  // eigener, größerer Cache nur für Sub-Agent-Verläufe (Anzahl-Badge + expliziter
  // Abruf) — verdrängt nie den 8er-Cache des Hauptverlaufs, s. transcript.ts.
  const subagentTranscriptCache = deps.subagentTranscriptCache ?? new TranscriptCache(128);
  // Digest je Archiv-Datei (Seitenpanels), eine Warteschlange für Upload + Anfrage.
  const digests = new DigestService(db, log);
  const allowedHosts = parseAllowedHosts(deps.allowedHosts ?? process.env.NYXOS_ALLOWED_HOSTS);
  const skillsCache = deps.skillsCache ?? new SkillsCache();
  // I5-Zusammenbau: echte P4-/P5-Quellen standardmäßig eingehängt (Tests können `graphProviders`
  // überschreiben, z. B. mit Fixtures oder `{}` für "keine Quellen").
  const graphProviders = deps.graphProviders ?? { entries: dbEntriesProvider(db), git: dbGitProvider(db) };
  const graph = deps.graph ?? new GraphService(defaultGraphSources(db, graphProviders), { onDelta: (d) => hub.broadcast(d), hasListeners: () => hub.size > 0, log });
  const app = new Hono<Env>();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  const bridgeHub = deps.bridgeHub ?? new BridgeHub((online) => hub.broadcast({ type: "bridge", online }), log);
  // alle Wege, die Text in eine Session tippen, gehen über diese Warteschlange (delivery/queue.ts).
  const deliveryDeps: DeliveryDeps = { db, bridge: bridgeHub, hub, log };
  // „Ist die Brücke da?" — Kanal + Ping/Pong, Server-Uhr, Verlauf (bridge/presence.ts).
  const bridgePresence = new BridgePresence({ db, now: deps.bridgeNow, log });
  // Local mode only (one computer, one user): sign-in links from the `nyxos` command. In server mode a machine
  // token (the Mac bridge) must never be enough to open a browser session.
  const localMode = (deps.appInfo?.mode ?? "local") === "local";
  // Demo instance: look-only (guard below), Nyx answers with the user's AI or prepared texts.
  const demoMode = deps.appInfo?.demo ? (deps.demo ?? { engine: "scripted" as const, homeUrl: null }) : null;
  let demoLastRequestAt = Date.now();
  // "Demo ansehen" (local instance only, never inside the demo): the child is created on first use.
  let demoLauncher: DemoLauncher | null = deps.demoLauncher ?? null;
  const launcher = (): DemoLauncher | null => {
    if (!localMode || demoMode) return null;
    demoLauncher ??= new DemoLauncher({ home: process.env.NYXOS_HOME ?? join(homedir(), ".nyxos"), port: Number(process.env.NYXOS_DEMO_PORT) || DEMO_DEFAULT_PORT, log });
    return demoLauncher;
  };
  const auth = createAuth(db, {
    log,
    localLogin: localMode,
    ...deps.auth,
    verifyMachineToken: async (token) => {
      const [m] = await db.select({ id: machines.id }).from(machines).where(eq(machines.tokenHash, hashToken(token))).limit(1);
      return !!m;
    },
  });

  // F3/F5/Nachtmodus: eigene Bereiche, Registrierung unten je eine Zeile.
  // `deps.pushSender` ist nur noch der ntfy-Transport; jede Mitteilung geht über den Mehr-Wege-Sender an
  // Mac (Brücke), Browser (Live) und iPhone (ntfy: eigener Dienst oder ntfy.sh — Token nie an ntfy.sh).
  const ownNtfy = deps.pushSender ?? new HttpNtfySender(process.env.NTFY_BASE_URL ?? "http://127.0.0.1:2586", process.env.NTFY_TOKEN ?? null);
  const publicNtfy = deps.pushSender ?? new HttpNtfySender(NTFY_SH_URL, null);
  const ntfyTransport = (target: NtfyTarget) => (target === "ntfy_sh" ? publicNtfy : ownNtfy);
  // Abwesenheit: Ereignisse gebündelt NUR über ntfy (roher Transport, nie Mac/Browser), Fragen über Telegram.
  // `telegram` entsteht weiter unten – die Aufrufe laufen erst im Takt, also nach dem Aufbau.
  const away = new AwayService({
    db,
    ntfy: ntfyTransport,
    telegram: { ready: () => telegram.canNotify(), sendQuestions: (qs) => telegram.sendQuestions(qs) },
    log,
    now: deps.away?.now,
  });
  background.run(away.settings().catch(() => {})); // Zwischenspeicher für `ntfyAllowed` füllen
  /** Schickt Telegram Freigaben selbst als Karte (gekoppelt + „Freigaben melden“)? Im Abwesenheits-Takt aufgefrischt. */
  let telegramCoversApprovals = false;
  const refreshTelegramCoverage = async () => {
    const st = await loadTelegramState(db);
    telegramCoversApprovals = !!st.chatId && settingsOf(st).notifyApprovals;
  };
  // Bewusst NICHT beim Start abfragen (erst im Minuten-Takt): eine Abfrage, die beim Beenden noch läuft, ließ die
  // Test-Datenbank (PGlite) endlos rechnen. Bis dahin gilt „nicht abgedeckt“ – eine Freigabe kommt eher doppelt als gar nicht.
  const pushSender: NtfySender = new MultiChannelSender({
    ntfy: ntfyTransport,
    bridge: bridgeHub,
    live: hub,
    // Ist der Nutzer weg (und „Wenn ich weg bin“ an), bekommt das iPhone nur die Sammel-Mitteilungen (Test + Dringendes weiterhin).
    // was die Sammel-Mitteilung NICHT abdeckt, geht weiter aufs iPhone – Nutzungswarnung, Absturz und
    // Freigaben, solange Telegram sie nicht selbst als Karte schickt (sonst erreichten sie der Nutzer unterwegs nie).
    ntfyAllowed: (msg) =>
      msg.kind === "test" ||
      msg.priority === "urgent" ||
      msg.kind === "usage_warning" ||
      msg.kind === "session_crashed" ||
      (msg.kind === "approval_needed" && !telegramCoversApprovals) ||
      !away.legacyNtfySuppressed(),
  });
  const buildsDir = deps.buildsDir ?? join(archiveDir, "..", "builds");
  const buildQueue =
    deps.buildQueue ??
    // geprüft wird auf dem Rechner (Brücke), nie im Server-Container; Push gebündelt je Fehler.
    new BuildQueue(db, new BridgeBuildRunner(bridgeHub), async (event: BuildDoneEvent) => {
      if (event.status !== "red") return;
      try {
        await notifyBuildDone(db, event, async (input) => notify(input, { db, sender: pushSender, settings: await loadOrInitSettings(db) }));
      } catch (e) {
        log("push-build-fehler", { error: String(e) });
      }
    });
  // beim Start hängengebliebene Läufe (Neustart mitten in der Prüfung) abschließen.
  if (!deps.buildQueue) background.run(buildQueue.recoverInterrupted().catch((e: unknown) => log("build-aufraeumen-fehlgeschlagen", { error: String(e) })));
  let nightSettingsState = deps.nightSettings ?? defaultNightSettings();
  // einmalig die eingebauten Preise anlegen, wenn `prices` noch leer ist (additive Migration
  // legt nur die Tabelle an, keine Daten). Nie blockierend für den Start.
  background.run(seedPrices(db).catch((e: unknown) => log("preise-saat-fehlgeschlagen", { error: String(e) })));
  // (verdrahtet mit P6 seit I8): Test-Überschreibung (Probe) > echter Kontext-Anteil aus den
  // Nutzungsdaten der Session.
  const getContextPct = deps.getContextPct ?? defaultContextPctSource();

  // Clickjacking: only NyxOS itself may frame its pages (the PDF preview frames /api/finder/raw). A cross-site
  // frame gets no cookie (SameSite=Strict), but a page on another localhost port is the same site and would.
  app.use("*", async (c, next) => {
    await next();
    try {
      const h = c.res.headers;
      if (!h.has("x-frame-options")) h.set("x-frame-options", "SAMEORIGIN");
      if (!h.has("content-security-policy")) h.set("content-security-policy", "frame-ancestors 'self'");
      if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
      if (!h.has("referrer-policy")) h.set("referrer-policy", "same-origin");
    } catch {
      // immutable headers (WebSocket upgrade) — nothing to frame there
    }
  });

  // (Sicherheit, vor P3 Pflicht): Host-Allowlist gegen DNS-Rebinding + Origin-Prüfung für
  // /live und alle nicht-GET-Anfragen + Content-Type-Pflicht für nicht-GET unter /api. Gilt für
  // alles außer /ingest/* (die Brücke hat ein Token) und /health. Kein CORS — die Web-App wird
  // immer vom selben Origin ausgeliefert (s. serveStatic unten), es gibt also nie einen legitimen
  // Cross-Origin-Browser-Zugriff.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/ingest/") || path === "/health") return next();
    // Token-Pfade ohne Browser (Leitplanken-Hook, MCP-Brücke von Haiku) prüfen ihr Token selbst;
    // die Ideen-Link-Mini-Seite `/i/*` hat eine EIGENE, strengere Prüfung (routes/idealink.ts).
    if (path.startsWith("/guard/") || path.startsWith("/haiku-mcp/") || path === "/haiku-worker" || path === "/i" || path.startsWith("/i/")) return next();

    // Ein echter HTTP-Client (Browser, curl, die Brücke) schickt IMMER einen Host-Header —
    // nur nicht-transportierte Aufrufe (In-Process-Tests über `app.request`, s. `apps/server/test/`)
    // haben keinen. Ein Angreifer-Browser kann den Host-Header nie weglassen (nicht skriptbar),
    // ein fehlender Host ist also kein DNS-Rebinding-Vektor — nur ein VORHANDENER, falscher.
    const host = c.req.header("host");
    if (host !== undefined && !isAllowedHost(host, allowedHosts)) return c.text("Unbekannter Host", 421);

    // `/live` trägt Session-Nachrichten für ALLE offenen Sessions — die grobe
    // Loopback-Erlaubnis oben (jeder Port auf 127.0.0.1/localhost) reicht hier NICHT: eine beliebige
    // Seite auf einem ANDEREN Port desselben Rechners könnte sonst mitlesen. Für `/live` deshalb
    // Origin == Host exakt verlangen (wie beim Terminal-Handschlag `/terminal/:id`, s.
    // routes/terminal.ts) statt nur „irgendein erlaubter Host". Fehlender Origin bleibt erlaubt
    // (kein Browser, z. B. `curl`/Tests ohne echten Transport).
    if (path === "/live") {
      const origin = c.req.header("origin");
      if (!originMatchesHost(origin, host)) return c.text("Unbekannter Origin", 403);
    } else if (c.req.method !== "GET") {
      const origin = c.req.header("origin");
      if (!isAllowedOrigin(origin, allowedHosts)) return c.text("Unbekannter Origin", 403);
    }

    // (Sprache) / N3 (Nyx-Stimme): das Diktat kommt als Audio (audio/webm, audio/ogg, audio/mp4) —
    // Dateien für Nyx (Reiter „Dateien & Links“) kommen roh (Bild, PDF, Text). Anmeldung + CSRF gelten trotzdem.
    if (path.startsWith("/api/") && c.req.method !== "GET" && !RAW_BODY_PATHS.has(path)) {
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        return c.text("Content-Type muss application/json sein", 415);
      }
    }

    return next();
  });

  // Demo: every write except browsing and Nyx is rejected before anything else sees it (demo/readonly.ts).
  if (demoMode) {
    app.use(
      "*",
      demoReadonlyGuard(() => {
        demoLastRequestAt = Date.now();
      }),
    );
  }

  // Schritt 6: Anmeldung für alle schreibenden Wege + Terminal-Kanal (zusätzlich zu Host/Origin oben).
  app.use("*", auth.gate);
  auth.register(app);

  const tokenAuth: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return c.json({ error: t("Token fehlt") }, 401);
    const [m] = await db.select({ id: machines.id }).from(machines).where(eq(machines.tokenHash, hashToken(token))).limit(1);
    if (!m) return c.json({ error: t("Token unbekannt") }, 401);
    c.set("machineId", m.id);
    await db.update(machines).set({ lastSeenAt: sql`now()` }).where(eq(machines.id, m.id));
    await next();
  };

  // Local mode: the `nyxos` command asks for a one-time sign-in link with the machine token (file 0600).
  if (localMode) app.post("/local/login-code", tokenAuth, (c) => c.json({ code: createLocalLoginCode() }));

  async function publish(keys: Set<string>) {
    if (keys.size > 0) graph.markDirty(["sessions", "vault-links"]); // PG: nur Session-Teile neu, Delta über /live
    if (keys.size === 0 || hub.size === 0) return;
    const rows = await getSessions(db, [...keys]);
    for (const session of rows) hub.broadcast({ type: "session", session });
  }

  app.get("/health", async (c) => {
    const result = await checkHealth(deps.healthDb ?? db, archiveDir, { timeoutMs: deps.healthCheckTimeoutMs });
    return c.json(result, result.ok ? 200 : 503);
  });

  app.post("/ingest/events", tokenAuth, bodyLimit({ maxSize: 16 * 1024 * 1024 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = IngestBatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiges Paket"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const outcome = await ingest(db, c.get("machineId"), parsed.data.items, skillsCache);
    log("ingest", { items: parsed.data.items.length, accepted: outcome.accepted, duplicates: outcome.duplicates });
    // Test-/Hilfsläufe sofort als temporär markieren (nicht erst im nächsten Ticker) – Fehler hier
    // dürfen den Ingest nie scheitern lassen.
    try {
      // neue Aktivität holt eine archivierte Session zurück (sonst liefe echte Arbeit unsichtbar).
      await reviveArchived(db, [...outcome.touched]);
      await applyTemporaryMarks(db, { probeSocket: isProbeSocket(bridgeHub.tmuxSocket()), keys: [...outcome.touched] });
    } catch (e) {
      log("temporaer-markieren-fehler", { error: String(e) });
    }
    await publish(outcome.touched);
    // Ist die in Telegram gewählte Session fertig geworden, kommt ihre Antwort aufs Handy (nie blockierend).
    background.run(telegram.onSessionsTouched([...outcome.touched]).catch((e: unknown) => log("telegram-rueckmeldung-fehler", { error: String(e) })));
    // Build-Wächter: "nach jeder Stop-Runde" — Fehler hier dürfen den
    // Ingest selbst nie scheitern lassen (die Brücke würde sonst denselben Batch wiederholen).
    try {
      const signals = stopSignalsFromBatch(parsed.data.items);
      if (signals.length > 0) await queueBuildsForStopSignals(buildQueue, buildsDir, signals);
    } catch (e) {
      log("build-wächter-fehler", { error: String(e) });
    }
    // Kontext-Wächter — nur für die vom Batch betroffenen Sessions ("bei
    // jedem Ingest bzw. Ticker"). läuft NACH dem Commit oben, aber OHNE await —
    // die Brücke wiederholt sonst denselben Batch, wenn der Wächter (Push/`send_text`) lange
    // braucht. Fehler dürfen den Ingest ohnehin nie scheitern lassen (wie beim Build-Wächter oben).
    // danach Wartendes zustellen (Session kann gerade auf „wartet“ gewechselt sein) — in
    // derselben Kette, damit Wächter und Warteschlange nie gleichzeitig in dieselbe Session tippen.
    const touched = [...outcome.touched];
    background.run(
      runContextGuardForSessions({ db, hub, bridgeHub, pushSender, getContextPct, log }, touched)
        .catch((e) => {
          log("kontext-waechter-ingest-fehler", { error: String(e) });
        })
        .then(() => flushDeliveries(deliveryDeps, touched))
        .catch((e) => log("zustellung-fehler", { error: String(e) })),
    );
    return c.json({ accepted: outcome.accepted, duplicates: outcome.duplicates });
  });

  app.post("/ingest/archive", tokenAuth, async (c) => {
    const meta = ArchiveMetaSchema.safeParse({
      tool: c.req.header(ARCHIVE_HEADERS.tool),
      sessionId: c.req.header(ARCHIVE_HEADERS.sessionId),
      path: c.req.header(ARCHIVE_HEADERS.path) ? decodeURIComponent(c.req.header(ARCHIVE_HEADERS.path) ?? "") : undefined,
      sha256: c.req.header(ARCHIVE_HEADERS.sha256),
      size: c.req.header(ARCHIVE_HEADERS.size),
    });
    if (!meta.success) return c.json({ error: t("Ungültige Archiv-Kopfzeilen"), issues: meta.error.issues.slice(0, 5) }, 400);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "Leerer Inhalt" }, 400);
    try {
      const stored = await storeArchive(archiveDir, meta.data, body as never);
      let recorded;
      try {
        recorded = await recordArchive(db, c.get("machineId"), { ...meta.data, ...stored });
      } catch (e) {
        await rm(stored.storedPath, { force: true }); // DB-Zeile zeigt weiter auf die alte, stimmige Fassung
        throw e;
      }
      const { key, previousPath } = recorded;
      // Alte Fassung erst löschen, wenn die DB schon auf die neue zeigt.
      if (previousPath) await rm(previousPath, { force: true });
      log("archive", { path: meta.data.path, size: meta.data.size, gz: stored.gzSize });
      // Chat-Text nur für die Hauptdatei neu indizieren (nicht bei Sub-Agent-Archiven).
      //: der Upload ist an dieser Stelle schon gespeichert (Datei + DB-
      // Zeile) — ein Fehler bei der Such-Indizierung darf die Antwort NICHT mehr auf 500 kippen (die
      // Brücke würde sonst endlos denselben, eigentlich schon erfolgreichen Upload wiederholen).
      // Loggen und beim nächsten Upload/`reindex-search` nachholen (die Transaktion in `indexChatDocs`
      // rollt bei einem Fehler vollständig zurück, der vorherige Indexstand bleibt also stimmig).
      if (isMainArchivePath(meta.data.tool, meta.data.sessionId, meta.data.path)) {
        try {
          await indexChatDocs(db, transcriptCache, key);
        } catch (e) {
          log("such-indizierung-fehlgeschlagen", { path: meta.data.path, error: String(e) });
        }
      }
      // Digest der neuen Fassung im Hintergrund — blockiert den Upload nie, Fehler nur
      // loggen (der nächste Panel-Abruf rechnet ihn sonst bei Bedarf nach).
      background.run(digests.refreshPath(meta.data.tool, meta.data.path).catch((e) => log("digest-fehlgeschlagen", { path: meta.data.path, error: String(e) })));
      await publish(new Set([key]));
      return c.json({ ok: true, sha256: meta.data.sha256, gzSize: stored.gzSize });
    } catch (e) {
      if (e instanceof ArchiveError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Lesende/steuernde Endpunkte der Web-App liegen unter /api/*, damit sie nicht mit den
  // echten URLs der Web-App kollidieren (z. B. /sessions/coding/nyxos/<id>). Siehe E7.
  app.get("/api/sessions", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 500) || 500, 1), 5000);
    const [rows, hours] = await Promise.all([listSessions(db, limit), loadTemporaryHours(db)]);
    return c.json({ sessions: rows.map((r) => toSessionDTO(r, hours)) });
  });

  app.get("/api/sessions/:id", async (c) => {
    const detail = await getSessionDetail(db, c.req.param("id"), 500);
    return detail ? c.json({ ...detail, session: toSessionDTO(detail.session, await loadTemporaryHours(db)) }) : c.json({ error: t("Nicht gefunden") }, 404);
  });

  // Bezüge (Reiter "Bezüge" in der Web-App) — Eltern-/Kind-Session plus Sessions, die
  // mindestens eine derselben Dateien geschrieben haben (s. store.ts `getRelatedSessions`).
  app.get("/api/sessions/:id/related", async (c) => {
    const related = await getRelatedSessions(db, c.req.param("id"));
    if (!related) return c.json({ error: t("Nicht gefunden") }, 404);
    const hours = await loadTemporaryHours(db);
    return c.json({
      parent: related.parent ? toSessionDTO(related.parent, hours) : null,
      children: related.children.filter((r) => r.archivedAt === null).map((r) => toSessionDTO(r, hours)),
      sameFiles: related.sameFiles.map(({ session, sharedFiles, sharedCount }) => ({
        sessionKey: session.id,
        sessionId: session.sessionId,
        title: session.title,
        tool: session.tool,
        state: session.state,
        art: session.categoryArt ?? "unsortiert",
        baustelle: session.categoryBaustelleSlug ? { slug: session.categoryBaustelleSlug, label: session.categoryBaustelleLabel ?? session.categoryBaustelleSlug } : null,
        sharedFiles,
        sharedCount,
      })),
    });
  });

  // `assign`/`assign/preview` korrigieren Art und/oder Baustelle GETRENNT:
  // nur ein Feld schicken ("art" ODER "baustelle") korrigiert auch nur diese eine Dimension, die
  // andere bleibt bei der normalen Ableitung. `baustelle: null` ist eine gültige, explizite
  // Zuordnung ("Ohne Baustelle"); `baustelle` ganz weglassen heißt "Baustelle nicht anfassen".
  type AssignTarget = { art?: Art; baustelle?: { slug: string; label: string } | null };
  function parseAssignTarget(body: unknown): { ok: true; target: AssignTarget } | { ok: false; error: string } {
    if (!body || typeof body !== "object") return { ok: false, error: t("Kein gültiger Körper") };
    const b = body as Record<string, unknown>;
    if (!("art" in b) && !("baustelle" in b)) return { ok: false, error: t("Feld 'art' oder 'baustelle' fehlt") };
    const target: AssignTarget = {};
    if ("art" in b) {
      if (!isArt(b.art)) return { ok: false, error: t("Ungültige Art") };
      target.art = b.art;
    }
    if ("baustelle" in b) {
      const baustelle = b.baustelle;
      if (baustelle === null || baustelle === undefined) {
        target.baustelle = null;
      } else if (typeof baustelle === "object" && typeof (baustelle as { slug?: unknown }).slug === "string" && typeof (baustelle as { label?: unknown }).label === "string") {
        target.baustelle = { slug: (baustelle as { slug: string }).slug, label: (baustelle as { label: string }).label };
      } else {
        return { ok: false, error: t("Ungültige Baustelle") };
      }
    }
    return { ok: true, target };
  }

  app.post("/api/sessions/:id/assign", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = parseAssignTarget(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const asRule = typeof (body as Record<string, unknown> | null)?.asRule === "boolean" ? ((body as Record<string, unknown>).asRule as boolean) : true;
    const result = await assignSession(db, c.req.param("id"), parsed.target, asRule, skillsCache);
    if (!result) return c.json({ error: t("Nicht gefunden") }, 404);
    await publish(new Set([...result.resorted, c.req.param("id")]));
    return c.json(result);
  });

  // Vorschau ohne zu schreiben: zeigt die Bedingung, die eine Regel bekäme, und wie viele andere
  // Sessions sich dadurch ändern würden ("die Bedingung wird nicht angezeigt").
  app.post("/api/sessions/:id/assign/preview", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = parseAssignTarget(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const result = await previewAssign(db, c.req.param("id"), parsed.target, skillsCache);
    if (!result) return c.json({ error: t("Nicht gefunden") }, 404);
    return c.json(result);
  });

  // Rückgängig für eine Korrektur (Toast-Knopf).
  app.post("/api/sessions/:id/unassign", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      // leerer Körper ist ok — dann werden einfach keine Regeln abgeschaltet/Dimensionen gelöst
    }
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const ruleIds = Array.isArray(b.ruleIds) ? b.ruleIds.filter((x): x is number => typeof x === "number") : [];
    const dims = Array.isArray(b.dims) ? b.dims.filter((x): x is "art" | "baustelle" => x === "art" || x === "baustelle") : [];
    const result = await unassignSession(db, c.req.param("id"), ruleIds, dims, skillsCache);
    if (!result) return c.json({ error: t("Nicht gefunden") }, 404);
    await publish(new Set([...result.resorted, c.req.param("id")]));
    return c.json({ ok: true, resorted: result.resorted });
  });

  app.get("/api/sort-rules", async (c) => {
    const rows = await db.select().from(sortRules).orderBy(sortRules.id);
    return c.json({ rules: rows });
  });

  app.patch("/api/sort-rules/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    if (!body || typeof body !== "object" || typeof (body as { active?: unknown }).active !== "boolean") {
      return c.json({ error: t("Feld 'active' fehlt") }, 400);
    }
    const [row] = await db.update(sortRules).set({ active: (body as { active: boolean }).active }).where(eq(sortRules.id, id)).returning({ id: sortRules.id });
    if (!row) return c.json({ error: t("Nicht gefunden") }, 404);
    const resorted = await resortAll(db, skillsCache);
    await publish(new Set(resorted));
    return c.json({ ok: true, resorted });
  });

  app.get("/api/categories", async (c) => {
    // `?tool=claude|codex` filtert die Zähler; alles andere (auch „alle“) zählt beide.
    const tool = ToolSchema.safeParse(c.req.query("tool"));
    return c.json({ categories: await listCategories(db, tool.success ? tool.data : null) });
  });

  // Vorschau eines Bilds, das der Nutzer mitgeschickt hat (nur eigene Eingaben dieser Session,
  // nur Rasterbilder, Anmeldung Pflicht über `needsAuth`). Privat zwischenspeichern: der Inhalt ändert sich nie.
  app.get("/api/sessions/:id/attachments/:itemId/:n", async (c) => {
    const img = await loadPromptImage(db, c.req.param("id"), c.req.param("itemId"), Number(c.req.param("n")));
    if (!img) return c.json({ error: t("Dieses Bild gibt es nicht mehr.") }, 404);
    return c.body(new Uint8Array(img.data), 200, {
      "content-type": img.mediaType,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });

  // Chat-Verlauf, seitenweise aus dem Archiv (eigener Block, s. transcript.ts).
  app.get("/api/sessions/:id/transcript", async (c) => {
    const directionRaw = c.req.query("direction") ?? "backward"; // ohne Angabe: Chat öffnet unten
    if (directionRaw !== "forward" && directionRaw !== "backward") return c.json({ error: t("Ungültige direction") }, 400);
    let limit = TRANSCRIPT_DEFAULT_LIMIT;
    const limitRaw = c.req.query("limit");
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return c.json({ error: t("Ungültiges limit") }, 400);
      limit = Math.min(n, TRANSCRIPT_MAX_LIMIT);
    }
    // Such-Sprung — `around=<position>` statt cursor/direction (s. transcript.ts).
    let around: number | null = null;
    const aroundRaw = c.req.query("around");
    if (aroundRaw !== undefined) {
      const n = Number(aroundRaw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return c.json({ error: t("Ungültiges around") }, 400);
      around = n;
    }
    const result = await getSessionTranscript(db, transcriptCache, subagentTranscriptCache, {
      idOrUuid: c.req.param("id"),
      cursor: c.req.query("cursor") ?? null,
      limit,
      direction: directionRaw,
      subagentId: c.req.query("subagent") ?? null,
      around,
    });
    if (result.kind === "not_found") return c.json({ error: t("Nicht gefunden") }, 404);
    if (result.kind === "bad_cursor") return c.json({ error: "Kaputter Cursor" }, 400);
    if (result.kind === "bad_position") return c.json({ error: t("Ungültiges around") }, 400);
    // Live-Absturz-Fund: Archiv wurde während des Lesens ersetzt, auch der Neuversuch mit der
    // aktuellen Fassung schlug fehl (s. transcript.ts). Kein Prozess-Absturz mehr, sondern ein
    // sauberer, wiederholbarer Fehler.
    if (result.kind === "conflict") return c.json({ error: t("Archiv wurde während des Lesens ersetzt, bitte erneut versuchen") }, 409);
    return c.json(result.body);
  });

  // Suche über Titel, erste Prompts, Dateipfade und Chat-Text (eigener Block, s. search.ts).
  app.get("/api/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const limitRaw = c.req.query("limit");
    const limit = limitRaw !== undefined ? Number(limitRaw) : SEARCH_DEFAULT_LIMIT;
    return c.json(await search(db, q, limit));
  });

  // ⌘K sucht alles (Sessions, Ideen, Aufträge, Audits, Skills, Nyx-Gedächtnis, Agenten), s. search-all.ts.
  // Immer nur mit Anmeldung (liefert Nyx-Gedächtnis), s. needsAuth in terminal/auth.ts.
  app.get("/api/search/all", async (c) => {
    const q = c.req.query("q") ?? "";
    if (q.length > SEARCH_ALL_MAX_QUERY_LENGTH) return c.json({ error: t("Die Suche ist zu lang – höchstens {n} Zeichen.", { n: SEARCH_ALL_MAX_QUERY_LENGTH }) }, 400);
    return c.json(await searchAll(db, q));
  });

  app.post("/api/sessions/:id/close", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      // leerer/kaputter Body → unten als Feldfehler behandelt
    }
    const by = body && typeof body === "object" && "by" in body && typeof (body as { by: unknown }).by === "string" ? (body as { by: string }).by.trim() : "";
    if (!by) return c.json({ error: t("Feld 'by' fehlt") }, 400);
    const closed = await closeSession(db, c.req.param("id"), by, Date.now());
    if (!closed) return c.json({ error: t("Nicht gefunden") }, 404);
    await publish(new Set([closed.id]));
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/reopen", async (c) => {
    const reopened = await reopenSession(db, c.req.param("id"), Date.now());
    if (!reopened) return c.json({ error: t("Nicht gefunden") }, 404);
    await publish(new Set([reopened.id]));
    return c.json({ ok: true });
  });

  app.get("/api/archive", async (c) => {
    const tool = ToolSchema.safeParse(c.req.query("tool"));
    return c.json({ files: await listArchive(db, tool.success ? tool.data : undefined) });
  });

  // Import läuft auf dem Server — Quelldateien liefert die Brücke (s. entries/importService.ts).
  // Start in main.ts bzw. dev.ts.
  const entriesImport = new EntriesImportService({
    db,
    onChanged: () => {
      hub.broadcast({ type: "entry", entryId: 0 });
      graph.markDirty(["entries"]);
    },
    log,
  });
  app.post("/ingest/entry-sources", tokenAuth, bodyLimit({ maxSize: 64 * 1024 * 1024 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = EntrySourcesIngestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültige Lieferung"), issues: parsed.error.issues.slice(0, 5) }, 400);
    try {
      const dateien = await entriesImport.ingest(parsed.data, c.get("machineId"));
      return c.json({ ok: true, dateien });
    } catch (e) {
      if (e instanceof IngestPathError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // Aufgaben/Ideen/Audit/Entscheidungen/Fragen (ganze Logik in ./entries/*, hier nur die Route).
  app.route("/api/entries", entriesRoutes({ db, hub, graph, bridgeHub, importer: entriesImport }));
  // „Dateien“ — alle Dateien, die Sessions angefasst haben (routes/files.ts).
  registerFilesRoutes(app, { db });
  registerSetupRoutes(app, { bridgeHub });
  registerAppInfoRoutes(app, {
    db,
    ...(deps.appInfo ?? { version: "0.0.0-dev", mode: "local" as AppMode, demo: false, dataDir: null, updater: new Updater({ version: "0.0.0-dev", cli: null }) }),
    demoHomeUrl: demoMode?.homeUrl ?? null,
    demoEngine: demoMode?.engine ?? null,
    canSeePrivate: async (c) => !auth.authReads || (await auth.signedIn(c)),
  });
  registerDemoRoutes(app, { launcher, log });
  // Dateien wie der Finder (über die Brücke), dazu Audit-Detail mit Originaltext.
  registerFinderRoutes(app, { bridgeHub });
  registerAuditRoutes(app, { db, bridgeHub });
  // Zustell-Warteschlange je Session sehen/zurückziehen.
  registerDeliveryRoutes(app, deliveryDeps);

  app.get("/api/machines", async (c) => {
    const rows = await db.select({ id: machines.id, name: machines.name, lastSeenAt: machines.lastSeenAt }).from(machines);
    return c.json(rows);
  });

  // Push, Sprache, Build-Wächter, Nachtmodus-Einstellungen — je eine Zeile.
  registerPushRoutes(app, { db, sender: pushSender, ntfyPublicUrl: process.env.NTFY_PUBLIC_URL?.trim() || null });
  // Stimmen-Dienst (Container nyx-voice) — Standard für jede Erkennung, Brücke als Rückfall.
  const nyxVoiceRaw = deps.voice?.nyx !== undefined ? deps.voice.nyx : (deps.voicePack?.backend ?? nyxVoiceBackendFromEnv());
  // alle Sprecher (Tab, Begleiter, Telegram) gehen über die Einstellungen (Aussprache-Wörterbuch, ElevenLabs).
  const voiceSecrets = new SecretStore(db);
  const voiceFetch = deps.voice?.elevenFetch ?? fetch;
  const nyxVoice = nyxVoiceRaw
    ? new ConfiguredVoiceBackend(nyxVoiceRaw, {
        settings: () => loadVoiceSettings(db),
        elevenLabsKey: () => voiceSecrets.getSecret(ELEVENLABS_SECRET),
        fetchImpl: voiceFetch,
        log,
      })
    : null;
  registerVoiceRoutes(app, { log, bridgeHub, ...deps.voice, nyx: nyxVoice });
  registerNyxVoiceRoutes(app, { backend: nyxVoice, bridgeHub, log, settings: { db, secrets: voiceSecrets, fetchImpl: voiceFetch }, ...(deps.voicePack ? { pack: deps.voicePack } : {}) });
  registerVoiceRoutes(app, { log, bridgeHub, ...deps.voice });
  // Nyx-Tab — Live-Stand, Meldungen, Bilder-/Datei-Ablage im Archiv-Volume.
  registerNyxTabRoutes(app, { db, hub, archiveDir });
  registerBuildsRoutes(app, { db, queue: buildQueue, buildsDir });
  // Haiku (Laufzeit, Chat, Briefing, Inbox), Leitplanken-Freigaben, Ideen-Link — je eine Zeile.
  const approvalsApi = registerApprovalsRoutes(app, {
    db,
    hub,
    machineAuth: tokenAuth,
    pushSender,
    log,
    // nie blind tippen — sofort nur, wenn Hook UND Bildschirm „wartet“ sagen, sonst zustellen, sobald sie wartet.
    tellSession: async (sessionKey, text) => {
      const r = await deliverOrQueue(deliveryDeps, { sessionKey, kind: "approval", text });
      log("freigabe-bescheid", { session: sessionKey, status: r.status });
      return r;
    },
    // Freigabe-Karte auch in Telegram (Knöpfe entscheiden über denselben Weg).
    onCreated: (approval) => telegram.onApprovalCreated(approval),
  });
  // Ein Konflikt-Modell für Tab und Haiku (gleiche Zahlen, ein Cache).
  const conflictModel = new ConflictModelService(db, () => bridgeHub.online);
  // Abwesenheit: Telegram-Knöpfe antworten über denselben Inbox-Weg wie das Web.
  let inboxAnswer: ((id: number, optionIndex: number) => Promise<{ ok: boolean; message: string }>) | null = null;
  // app_api: Anfragen laufen im Prozess (`app.fetch`), `telegram` entsteht weiter unten (erst beim Aufruf gelesen).
  const appApi = new AppApiService({ db, hub, log, fetch: (req) => app.fetch(req), routes: () => app.routes, telegram: () => telegram });
  const haiku = registerHaikuRoutes(app, {
    appApi: { onAnswered: (item, answer) => appApi.onInboxAnswered(item, answer), onDismissed: (id) => appApi.onInboxDismissed(id) },
    exposeInboxAnswer: (fn) => {
      inboxAnswer = fn;
    },
    db,
    hub,
    log,
    pushSender,
    upgradeWebSocket,
    bridgeHub,
    digests,
    conflictModel,
    graph,
    archiveDir,
    approveMany: approvalsApi.approveMany,
    assignArt: async (sessionKey, art) => {
      if (!isArt(art)) return;
      const r = await assignSession(db, sessionKey, { art }, false, skillsCache);
      if (r) await publish(new Set([...r.resorted, sessionKey]));
    },
    ...deps.haiku,
  });
  registerIdeaLinkRoutes(app, { db, log, haiku, allowedHosts });
  // Modelle, Konnektoren, Geheimnisse (Logik in ./models, ./mcp, ./secrets) – hängt sich in den Nyx-Motor ein.
  const modelsApi = registerModelsRoutes(app, { db, log, bridgeHub, runtime: haiku, remote: deps.haiku?.remoteEngine ?? remoteEngine, allowedHosts: deps.allowedHosts, ...deps.models });
  // Demo: Nyx only reads (tool allow-list, applies to tools registered below too) and knows it is a demo. Without
  // an AI on this computer the prepared answers take the place of the engine – for chat only, nothing runs in the
  // background (the replacement goes after `registerModelsRoutes`, which sets its own engine choice).
  if (demoMode) {
    haiku.tools.limitTo(DEMO_NYX_TOOLS);
    haiku.systemNote = DEMO_SYSTEM_NOTE;
    if (demoMode.engine === "scripted") {
      const scripted = new ScriptedDemoEngine(db);
      haiku.useModels({
        engineForRun: async (kind) => {
          if (kind !== "chat") throw new Error(t("In der Demo antwortet Nyx nur im Chat."));
          return scripted;
        },
      });
    }
  }
  // derselbe Minutentakt führt Nyx' geplante Aufgaben aus.
  const haikuScheduler = new HaikuScheduler({ runtime: haiku, notify: (what) => hub.broadcast({ type: "haiku", what }), log, extraTick: (now) => haiku.nyx?.tick(now) ?? Promise.resolve() });
  // Telegram. Gestartet wird der Bot in main.ts (nur mit Token); Tests füttern Updates direkt.
  const telegram = new TelegramService({
    db,
    log,
    hub,
    tokens: secretStoreTokenSource(new SecretStore(db)), // Token aus dem Geheimnis-Speicher (Rückfall: Env)
    // Telegram spricht mit dem Nyx-Kern (dieselbe Runde wie der Web-Chat), Bilder aus der Ablage.
    nyx: runtimeNyxChannel({ db, hub, archiveDir, core: () => haiku.nyx }),
    // Lokales Stimmen-Paket: Telegram-Sprachnachrichten über denselben Dienst (mit Aussprache-Wörterbuch).
    voice: deps.voicePack && nyxVoice ? adaptNyxVoiceBackend(nyxVoice) : nyxVoiceFromEnv(),
    bridge: bridgeHub,
    publish,
    miniAppUrl: process.env.NYXOS_TELEGRAM_MINIAPP_URL?.trim() || null,
    startSession: async (req) => {
      const input = StartRequestSchema.safeParse({ tool: req.tool, cwd: req.cwd });
      if (!input.success) return { ok: false, error: t("Dieser Ordner passt nicht.") };
      const r = await startTerminalSession({ db, bridgeHub, publish }, input.data, req.temporary);
      if (r.ok) return { ok: true, sessionKey: r.sessionKey, tmuxName: r.started.tmuxName };
      return { ok: false, error: r.code === "bridge_offline" ? t("Dein Mac ist gerade nicht verbunden.") : t("Das hat auf dem Rechner nicht geklappt. Bitte gleich noch einmal versuchen.") };
    },
    approvals: {
      decide: async (id, decision) => {
        const r = await approvalsApi.decide(id, decision, "telegram");
        return r.ok ? { ok: true, message: decision === "approve" ? "Freigegeben" : "Abgelehnt" } : { ok: false, message: r.message };
      },
    },
    inbox: { answer: (id, idx) => (inboxAnswer ? inboxAnswer(id, idx) : Promise.resolve({ ok: false, message: t("Die Inbox ist gerade nicht bereit – bitte in NyxOS antworten.") })) },
    ...deps.telegram,
  });
  registerTelegramRoutes(app, telegram);
  registerAwayRoutes(app, { db, away });
  registerAccessRoutes(app, new AccessService({ models: modelsApi.models, secrets: modelsApi.secrets, telegram, connectors: modelsApi.connectors, env: deps.models?.env, fetchImpl: deps.models?.fetchImpl }), log);
  // Nyx meldet sich von selbst auch über Telegram (Erinnerungen, geplante Aufgaben).
  haiku.nyx?.notifier.registerChannel("telegram", async (m) => {
    const lines = [m.title ? `*${m.title}*` : "", m.text, m.link ? `${m.link.title}: ${m.link.url}` : ""].filter(Boolean);
    // Meldungen mit Bild (Ablage `nyx_files`) gehen als Foto raus.
    const img = m.image ? await readNyxFile(db, archiveDir, m.image.fileId) : null;
    const r = await telegram.notifyUser({ text: lines.join("\n\n"), voice: Boolean(m.speak), ...(img ? { image: { data: new Uint8Array(img.bytes), name: img.row.name } } : {}) });
    if (!r.sent && r.reason !== "quiet_hours") throw new Error(r.reason);
  }, () => telegram.canNotify());
  // Nyx steuert NyxOS (Vertrag `nyx.ui`) – Werkzeuge im Haiku-Kasten + Antwort-Rückweg.
  const nyxUi = new NyxUiBridge({ hub, log });
  registerNyxUiTools(haiku.tools, nyxUi);
  registerAppApiTools(haiku.tools, appApi);
  registerNyxUiRoutes(app, { bridge: nyxUi });
  registerNightRoutes(app, {
    db,
    getSettings: () => nightSettingsState,
    setSettings: (next) => {
      nightSettingsState = next;
    },
  });

  // je ein Einzeiler — Registrierung/Logik s. routes/{overview,git,conflicts,server,lessons}.ts.
  // `/ingest/git` ist Maschinen-Token-Auth wie `/ingest/events` (P5s eigener `auth` aus
  // dem Vor-P3-Stand war genau dieses Konzept, nur anders benannt) — NICHT die Passkey-Sitzung, die
  // die Brücke nicht hält.
  registerOverviewRoutes(app, { db, onStatesChanged: publish });
  registerGitRoutes(app, { db, auth: tokenAuth, graph, presence: bridgePresence });
  registerConflictRoutes(app, { db, bridge: bridgeHub, model: conflictModel });
  const serverSources = registerServerRoutes(app, { db, archiveDir, sources: deps.server, local: deps.appInfo?.mode === "local" ? { dataDir: deps.appInfo.dataDir ?? archiveDir } : undefined });
  // Werkzeug `server_lage` – derselbe Stand wie der Server-Tab.
  haiku.nyx?.setServerSnapshot(async () => getServerSnapshot(db, { health: await checkHealth(db, archiveDir), sources: serverSources }));
  registerLessonRoutes(app, { db });
  registerNyxProfileRoutes(app, { db });
  // Onboarding (first start): AI access, interview → Nyx profile, finish (routes/onboarding.ts).
  registerOnboardingRoutes(app, { db, runtime: haiku, models: modelsApi.models, log, env: deps.models?.env, notify: (what) => hub.broadcast({ type: "haiku", what }) });
  registerRecentRoutes(app, { db });

  // Agenten & Skills, Nutzung (Registrierung hier, Inhalt in routes/{agents,usage}.ts).
  // Wie /ingest/git ( s. registerGitRoutes oben): `auth` hier ist das
  // Maschinen-Token, nicht die Passkey-Sitzung — main nennt dieselbe Middleware `tokenAuth`
  // (P6-F1-Cherry-Pick 1b902b4: dieser Fund/Fix ist in main schon enthalten).
  registerUsageRoutes(app, db, tokenAuth);
  registerAgentsRoutes(app, db, tokenAuth);
  // Skill-Bibliothek (Kacheln, Verlauf, Vorschläge von Nyx, Opus-Aufträge) – routes/skills.ts.
  const skillService = registerSkillsRoutes(app, { db, bridgeHub, runtime: haiku, log, notify: () => hub.broadcast({ type: "skills" }), ...deps.skills });
  registerSessionPanelsRoutes(app, { db, digests });

  // PG „Gehirn": Graph-API + `/ingest/vault`. Wie bei Git und Nutzung:
  // `/ingest/vault` braucht das Maschinen-Token (`tokenAuth`), nicht die Passkey-Sitzung — die
  // Brücke hält kein Browser-Cookie.
  registerGraphRoutes(app, { db, graph, auth: tokenAuth, log });

  // Kontext-Wächter — Einstellungen + Session-Zustand + "Jetzt komprimieren" (routes/context-guard.ts).
  registerContextGuardRoutes(app, { db, hub, bridgeHub, getContextPct });

  // Verbindungs-Prüfung (GET /api/connections), Logik in ./connections/.
  registerConnectionsRoutes(app, {
    db,
    archiveDir,
    bridgeHub,
    haiku,
    worker: deps.haiku?.remoteEngine ?? (deps.haiku?.runtime ? null : remoteEngine),
    selfFetch: (req) => app.fetch(req),
    telegram,
    ...(deps.voicePack ? { voice: { backend: deps.voicePack.backend, scope: "local" as const } } : {}),
    // Lokal gelten nur die Prüfungen dieses Rechners (ohne `appInfo`, z. B. in Tests: alle Server-Prüfungen).
    mode: deps.appInfo?.mode,
    ...deps.connections,
  });

  app.get(
    "/live",
    upgradeWebSocket(() => {
      const client = { send: (_: string) => {} };
      return {
        onOpen(_evt, ws) {
          client.send = (data) => ws.send(data);
          hub.add(client);
          ws.send(JSON.stringify({ type: "hello" }));
        },
        // Antworten auf `nyx.ui` kommen NICHT über `/live` (ohne Anmeldung lesbar, also fälschbar),
        // sondern nur über `POST /api/nyx/ui/reply` (Anmeldung + CSRF).
        onClose() {
          hub.remove(client);
        },
      };
    }),
  );

  // Terminal, Starten/Fortsetzen/Beenden, Brücken-Verbindung (routes/terminal.ts).
  registerTerminalRoutes(app, { db, hub, bridgeHub, bridgePresence, bridgePingMs: deps.bridgePingMs, upgradeWebSocket, hashToken, publish, log, graph });
  registerTemporaryRoutes(app, {
    db,
    publish,
    notifyChanged: () => {
      // Jede /live-Nachricht lässt das Web die Session-Liste neu laden; „haiku/threads“ die Fadenliste.
      hub.broadcast({ type: "temporary" });
      hub.broadcast({ type: "haiku", what: "threads" });
    },
  });
  registerBridgePresenceRoutes(app, { db, presence: bridgePresence });
  // aus dem Session-Chat schreiben (mit Anhang) + „Session zusammenfassen & prüfen“.
  registerSessionChatRoutes(app, { db, bridgeHub, hub, log });
  registerSessionAuditRoutes(app, { db, hub, runtime: haiku, cache: transcriptCache, log });
  // „Prompt verbessern“ (Sonnet 5 · Reasoning hoch) neben der Chat-Eingabe.
  registerPromptAssistRoutes(app, { db, runtime: haiku, cache: transcriptCache, digests, log });

  // Echte Web-App-Dateien zuerst (Assets); alles andere fällt unten durch.
  // Cache-Kopf je Dateiart (s. `staticCacheControl`), damit Dock-App/Home-Bildschirm nach einem
  // Deploy nie alte Skripte zeigen, die gehashten Assets aber nicht bei jedem Öffnen neu geladen werden.
  // (`onFound` von @hono/node-server läuft erst NACH dem Bau der Antwort – der Kopf käme dort nie an.)
  if (deps.webDir) {
    const statics = serveStatic({ root: deps.webDir });
    app.use("/*", async (c, next) => {
      const res = await statics(c, next);
      // Nur eine gefundene Datei ist eine eigene Antwort; sonst liefert `next()` den Kontext zurück (nicht anfassen).
      if (!(res instanceof Response)) return;
      res.headers.set("Cache-Control", staticCacheControl(c.req.path));
      return res;
    });
  }

  // Nichts der obigen Routen/Dateien hat gepasst: unbekannte /api/*-Pfade sind ein JSON-404,
  // jeder andere GET-Pfad ist eine echte URL der Web-App (z. B. /sessions/coding/nyxos/<id>)
  // und bekommt index.html (SPA-Rückfall).
  // FX: `code: "route_unknown"` unterscheidet „diese Route kennt der Server nicht“ vom 404 einer
  // vorhandenen Route (unbekannte ID) — scripts/check-connections.mjs meldet nur ersteres als „nicht deployt“.
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: t("Nicht gefunden"), code: ROUTE_UNKNOWN }, 404);
    if (deps.webDir) {
      try {
        c.header("Cache-Control", staticCacheControl("/index.html"));
        return c.html(readFileSync(join(deps.webDir, "index.html"), "utf8"));
      } catch {
        // webDir ohne gebaute Web-App (z. B. lokale Probe ohne `pnpm build`) → unten 404
      }
    }
    return c.json({ error: t("Nicht gefunden"), code: ROUTE_UNKNOWN }, 404);
  });

  app.onError((err, c) => {
    // Ideen-Link-Token nie ins Log (Pfad /i/<token>/…).
    log("error", { message: err.message, path: c.req.path.replace(/^\/i\/[^/]+/, "/i/***") });
    return c.json({ error: t("Interner Fehler") }, 500);
  });

  /** Server-Ticker: erkennt „ruht" nach 30 Min Stille, ohne dass ein neues Ereignis eintrifft.
   * derselbe 60-s-Takt prüft "wartet auf dich seit ≥ waitingAfterSeconds" mit (kein
   * eigenes Intervall nötig, s. `push/waiting.ts`). */
  async function tickStates(now = Date.now()): Promise<string[]> {
    const changed = await retickIdleStates(db, now);
    await publish(new Set(changed));
    try {
      const settings = await loadOrInitSettings(db);
      await checkWaitingSessions(db, pushSender, settings, new Date(now));
    } catch (e) {
      log("push-warte-fehler", { error: String(e) });
    }
    // Abwesenheit: neue Ereignisse/Fragen einsammeln; nur wenn der Nutzer weg ist, gebündelt nach ntfy bzw. Telegram.
    try {
      await refreshTelegramCoverage().catch(() => {});
      await away.tick();
    } catch (e) {
      log("abwesend-takt-fehler", { error: String(e) });
    }
    // Wegwerf-Chats – markieren, abgelaufene Sessions archivieren, abgelaufene Haiku-Fäden löschen.
    try {
      const temp = await runTemporaryTicker(db, { probeSocket: isProbeSocket(bridgeHub.tmuxSocket()), now: new Date(now) });
      await publish(new Set([...temp.marked, ...temp.archived]));
      if (temp.threadsDeleted > 0) hub.broadcast({ type: "haiku", what: "threads" });
      if (temp.archived.length > 0) log("temporaer-archiviert", { sessions: temp.archived.length });
    } catch (e) {
      log("temporaer-ticker-fehler", { error: String(e) });
    }
    // Warnschwellen der Nutzung (Tagesverbrauch, 5-Std-Fenster) im selben Takt.
    try {
      await checkUsageWarnings(db, pushSender, await loadOrInitSettings(db), new Date(now));
    } catch (e) {
      log("nutzung-warn-fehler", { error: String(e) });
    }
    // Kontext-Wächter läuft im selben 60-s-Takt mit (kein eigenes Intervall nötig).
    try {
      await runContextGuardTicker({ db, hub, bridgeHub, pushSender, getContextPct, log });
    } catch (e) {
      log("kontext-waechter-ticker-fehler", { error: String(e) });
    }
    // Warteschlange „zustellen, sobald wartet“ (Verfall nach N Stunden) im selben Takt.
    try {
      await flushDeliveries(deliveryDeps);
    } catch (e) {
      log("zustellung-fehler", { error: String(e) });
    }
    // Skill-Nutzung einlesen, Signale prüfen, Vorschläge von Nyx (zuletzt – Nyx darf dauern).
    try {
      await skillService.tick(now);
    } catch (e) {
      log("skills-takt-fehler", { error: String(e) });
    }
    return changed;
  }

  return {
    app,
    injectWebSocket,
    hub,
    tickStates,
    background,
    buildQueue,
    pushSender,
    bridgeHub,
    bridgePresence,
    graph,
    haiku,
    haikuScheduler,
    entriesImport,
    nyxVoice,
    modelsApi,
    telegram,
    away,
    appApi,
    /** Demo instance: time of the last request (idle shutdown in local.ts). */
    demoLastRequestAt: () => demoLastRequestAt,
    /** Local instance: ends a running demo child (server shutdown). */
    stopDemo: (): Promise<void> => demoLauncher?.stop() ?? Promise.resolve(),
    killDemoNow: (): void => demoLauncher?.killNow(),
  };
}
