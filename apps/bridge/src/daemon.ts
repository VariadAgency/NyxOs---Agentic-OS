import { existsSync, mkdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { BridgeStatusReport } from "@nyxos/shared";
import { scanCatalog } from "./catalog-scan.js";
import { claudeDirInProjects, paths, terminalDefaults, type BridgeConfig, type BridgePaths } from "./config.js";
import { EntrySourcesSync, type EntrySourcesOptions } from "./entry-sources.js";
import { FinderFs, screenshotsLocation } from "./finder/fs.js";
import { GitScheduler } from "./git/scheduler.js";
import { CODEX_ACTIVE_MS, claudePidMap, claudeRecordedStart, codexOpenSessions, codexPidsFor, codexProcessRunning, runningClaude, stateChanges } from "./liveness.js";
import { LoopLagMonitor } from "./loop-lag.js";
import { SetupError, SetupService } from "./setup.js";
import { BridgeLink, type LinkOptions } from "./terminal/link.js";
import { RpcError, TerminalManager } from "./terminal/manager.js";
import { Tmux } from "./terminal/tmux.js";
import { Outbox } from "./outbox.js";
import { Archiver } from "./archiver.js";
import { Sender } from "./sender.js";
import { SkillLibrary } from "./skills.js";
import { openDb } from "./sqlite.js";
import { drainSpool } from "./spool.js";
import { Tracker, type Log } from "./tracker.js";
import { TranscriptWatch } from "./transcript-watch.js";
import { Tunnel, type TunnelOptions } from "./tunnel.js";
import { UsageScanner } from "./usage-scan.js";
import { CodexBarReader } from "./codexbar.js";
import { VaultSync, type VaultSyncOptions } from "./vault/sync.js";

export interface DaemonOptions {
  spoolDir?: string;
  dbPath?: string;
  log?: Log;
  fetchImpl?: typeof fetch;
  livenessMs?: number;
  archiveQuietMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Für Tests: Terminal-Dienst (Verbindung zum Server, tmux) nicht starten. */
  noTerminal?: boolean;
  terminalTickMs?: number;
  /** Nur Tests: Verzögerung bis zum Vorwärmen der großen Finder-Favoriten (ms). */
  finderPrewarmMs?: number;
  /** Pfad der Brücken-Konfiguration (Leitplanken-Hook der Auftrags-Sessions, Einrichtung). */
  configPath?: string;
  /** Die Einrichtung hat Projektordner/Vault geändert: Brücke mit neuer Konfiguration neu aufbauen. */
  onConfigChanged?: () => void;
  /** Pfade der Einrichtung (Hook-Skript, Spool, Shell-Dateien); Standard: die der installierten Brücke. */
  setupPaths?: BridgePaths;
  /** Für Tests: Lebenszeichen-Quellen ersetzen. */
  liveness?: () => Promise<{ claudeRunning: Set<string>; codexProcess: boolean }>;
  /**
   * Git-Erfassung (Scan + Probe-Merges + Nachziehen, s. git/scheduler.ts). `run-options.ts` setzt das für
   * JEDE Brücke. Ohne Angabe (Tests) läuft kein Git-Scan.
   */
  git?: { intervalMs?: number; probeIntervalMs?: number; watchDebounceMs?: number; minGapMs?: number; fetchImpl?: typeof fetch; applyCatchups?: boolean };
  /** `false` = Obsidian-Vault nie einlesen (Tests). Sonst Optionen für den Vault-Abgleich. */
  vault?: false | VaultSyncOptions;
  /** Ablage für Chat-Anhänge. Standard `~/.nyxos/bridge/uploads`, Probe: im Datenordner. */
  uploadsDir?: string;
  /** Sicherungen von Skill-Ordnern. Standard `~/.nyxos/bridge/skill-backups`, Probe: im Datenordner. */
  skillBackupsDir?: string;
  /** `false` = GOAL.md/Maßnahmenplan nicht an den Server liefern (Tests). */
  entrySources?: false | EntrySourcesOptions;
  /** Für Tests: Ersatz-ssh und kürzere Wächter-Takte. */
  tunnel?: TunnelOptions;
  link?: Pick<LinkOptions, "silentMs" | "checkMs" | "connectTimeoutMs">;
  /**
   * Echte Claude-Limits aus CodexBar (macOS-App, `history/claude.json`, nur lesen) über den Brücken-Kanal melden.
   * `run-options.ts` setzt das nur für die installierte Brücke auf macOS; ohne Angabe wird nichts gelesen.
   */
  codexbar?: { path?: string; pollMs?: number };
  /** Höchstens so lange auf den Kanal warten, bevor der Rückstand anläuft (Standard `CHANNEL_WAIT_MS`). */
  channelWaitMs?: number;
}

/** Wie diese Brücke sich selbst als Leitplanken-Hook aufruft: derselbe node-Aufruf samt Optionen/Lader
 * (Entwicklung mit tsx) und Skript. Shell-sicher in einfachen Anführungszeichen. */
export function guardCommandForThisProcess(): string {
  const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const script = process.argv[1] ?? "";
  if (/\.(ts|mjs|js)$/.test(script) && existsSync(script)) return [process.execPath, ...process.execArgv, script].map(sq).join(" ");
  return sq(process.execPath);
}

/** node + bridge.js dieses Prozesses (für ein fehlendes Hook-Skript), nur wenn es ein .js-Programm ist. */
function selfCommand(): { node: string; entry: string } | undefined {
  const script = process.argv[1] ?? "";
  if (!/\.(mjs|js)$/.test(script) || !existsSync(script)) return undefined;
  try {
    return { node: process.execPath, entry: realpathSync(script) };
  } catch {
    return undefined;
  }
}

/** Fassung der Status-Antwort — der Server erkennt daran, dass diese Brücke `status` kann. */
export const BRIDGE_STATUS_VERSION = "r1";

export const defaultLog: Log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

/** So lange wartet der Start höchstens auf Tunnel + Kanal, bevor der Rückstand trotzdem anläuft
 * (Server gerade weg: dann puffert die Brücke wie gewohnt, der Kanal verbindet im Hintergrund neu). */
export const CHANNEL_WAIT_MS = 15_000;
/** So lange nach dem Start wird ~/Downloads einmal vorgewärmt (nach Kanal und Nachimport). */
export const FINDER_PREWARM_DELAY_MS = 20_000;
/** Solange der Server länger als das schweigt, stellt das Archiv seine Uploads zurück (Pings haben Vorrang). */
const HOLD_UPLOADS_AFTER_SILENT_MS = 20_000;

/**
 * Startet die Brücke.
 *
 * Reihenfolge: Tunnel und Kanal kommen VOR Spool, Datei-Wächter und Nachimport — sonst stünde nach einem
 * Neustart mit großem Rückstand minutenlang keine Verbindung.
 * 1. Puffer öffnen · 2. Tunnel + Brücken-Kanal · 3. warten, bis der Kanal steht (höchstens
 * `CHANNEL_WAIT_MS`) · 4. im Hintergrund: Spool, Datei-Wächter, Nachimport, Senden, Archiv, Scans.
 * Jede Phase steht mit ihrer Zeit im Log (`start-phase`). `ready` erfüllt sich nach Schritt 4.
 */
export async function startDaemon(cfg: BridgeConfig, opts: DaemonOptions = {}) {
  const t0 = performance.now();
  const p = paths();
  const log = opts.log ?? defaultLog;
  const phase = (name: string, extra: Record<string, unknown> = {}) => log("start-phase", { phase: name, ms: Math.round(performance.now() - t0), ...extra });
  const spoolDir = opts.spoolDir ?? p.spool;
  mkdirSync(spoolDir, { recursive: true });
  const dbPath = opts.dbPath ?? p.db;
  mkdirSync(join(dbPath, ".."), { recursive: true });

  const db = await openDb(dbPath);
  const outbox = new Outbox(db);
  phase("puffer-offen", { puffer: outbox.size() });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sender = new Sender({
    outbox,
    serverUrl: cfg.serverUrl,
    token: cfg.token,
    log,
    fetchImpl,
    ...(opts.minBackoffMs ? { minBackoffMs: opts.minBackoffMs } : {}),
    ...(opts.maxBackoffMs ? { maxBackoffMs: opts.maxBackoffMs } : {}),
  });
  const tracker: Tracker = new Tracker(cfg, outbox, log, {
    onFileChanged: (path, tool, sessionId) => archiver.schedule(path, tool, sessionId),
    onEnqueued: () => sender.nudge(),
  });
  // Kanal zum Server (weiter unten gestartet). Das Archiv stellt Uploads zurück, solange er auf ein
  // Lebenszeichen wartet — dann sollen Pings/Pongs durch den Tunnel, nicht Megabytes an Verlauf.
  let link: BridgeLink | null = null;
  const archiver = new Archiver(cfg, outbox, (t, s) => tracker.isAllowed(t, s), log, fetchImpl, opts.archiveQuietMs, {
    // Nur, wenn diese Laufzeit Pings überhaupt meldet — sonst hieße jede ruhige Minute „Stille".
    holdWhile: () => link !== null && link.pingSeen && (link.beatAgeMs() ?? 0) > HOLD_UPLOADS_AFTER_SILENT_MS,
  });
  const lag = new LoopLagMonitor(log);
  lag.start();

  // Vault-Abgleich (weiter unten gestartet, hier deklariert für Status-Meta und stop()).
  let vault: VaultSync | null = null;
  const timers: NodeJS.Timeout[] = [];
  let closed = false;
  /** Erst nach Schritt 3 darf gesendet werden (vorher nur Tunnel und Kanal). */
  let released = false;
  let spoolRun: Promise<void> = Promise.resolve();
  const closers: (() => unknown)[] = [];
  const every = (fn: () => void, ms: number) => {
    if (!closed) timers.push(setInterval(fn, ms));
  };
  // Zeitpunkte der letzten Scan-Läufe für den Befehl `status` (Verbindungs-Prüfung).
  const scans: { usage: number | null; git: number | null; catalog: number | null } = { usage: null, git: null, catalog: null };
  const bridgeStatus = (): Omit<BridgeStatusReport, "tmux"> => ({
    at: Date.now(),
    version: BRIDGE_STATUS_VERSION,
    queued: outbox.size(),
    dead: outbox.deadCount(),
    lastOkAt: sender.lastOkAt,
    lastError: sender.lastError,
    archiveError: archiver.lastError,
    watchedFiles: tracker.known().length,
    scans: { ...scans, vault: vault?.status.lastOkAt ?? null },
    vaultError: vault?.status.lastError ?? null,
  });

  // Quelle des Aufgaben-/Audit-Imports (GOAL.md + Maßnahmenplan, nur lesen), eigenes Modul.
  const entrySources =
    opts.entrySources === false ? null : new EntrySourcesSync({ projectRoots: cfg.projectRoots, serverUrl: cfg.serverUrl, token: cfg.token }, log, fetchImpl, opts.entrySources ?? {});

  // Einrichtung über das Onboarding (Projektordner, Vault, Hooks, Shell).
  const setup = new SetupService({
    cfg,
    configPath: opts.configPath ?? p.config,
    paths: opts.setupPaths ?? p,
    log,
    self: selfCommand(),
    ...(opts.onConfigChanged ? { onChanged: opts.onConfigChanged } : {}),
  });
  const setupCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SetupError) throw new RpcError(e.message, `setup_${e.code}`);
      throw e;
    }
  };
  const setupRpc = {
    state: () => setup.state(),
    apply: (params: unknown) => setupCall(() => setup.apply(params)),
    browse: (params: unknown) => setupCall(() => setup.browse(params)),
  };

  // ── Schritt 2: Tunnel und Kanal zuerst ─────────────────────────────────────────────────────────────
  let tunnel: Tunnel | null = null;
  if (cfg.tunnel) {
    tunnel = new Tunnel(
      cfg.tunnel,
      log,
      () => {
        link?.nudge();
        if (!released) return;
        sender.nudge(0);
        void archiver.sweep();
        void entrySources?.syncNow();
      },
      opts.tunnel ?? {},
    );
    tunnel.start();
    phase("tunnel-gestartet");
  }

  let terminal: TerminalManager | null = null;
  let mappingTick: (() => Promise<void>) | null = null;
  if (cfg.terminal !== null && !opts.noTerminal) {
    const tc = { ...terminalDefaults(), ...(cfg.terminal ?? {}) };
    const tmux = new Tmux({ bin: tc.tmuxBin, socket: tc.socket, conf: tc.conf });
    // Dateien wie der Finder. Sicherungskopien liegen neben den Anhängen (nie im Repo).
    const uploadsDir = opts.uploadsDir ?? p.uploads;
    const finder = new FinderFs({ projectRoots: cfg.projectRoots, vaultDir: cfg.vaultDir ?? null, home: homedir(), screenshotsDir: null, backupsDir: join(dirname(uploadsDir), "finder-backups"), log });
    void screenshotsLocation(homedir()).then((dir) => finder.setScreenshotsDir(dir));
    // Große Favoriten nach dem Start einmal vorwärmen (nicht während des Nachimports) und die
    // Dauer loggen — ein kalter erster Zugriff ist so im Brücken-Log belegt statt beim Klick zu warten.
    const warm = setTimeout(() => {
      const t0 = performance.now();
      void finder.prewarm().then((eintraege) => log("finder-vorgewaermt", { ms: Math.round(performance.now() - t0), eintraege }));
    }, opts.finderPrewarmMs ?? FINDER_PREWARM_DELAY_MS);
    warm.unref?.();
    closers.push(() => clearTimeout(warm));
    const manager = new TerminalManager({
      finder,
      tmux,
      projectRoots: cfg.projectRoots,
      path: tc.path ?? process.env.PATH ?? "/usr/bin:/bin",
      log,
      claudePids: () => claudePidMap(cfg.claudeDir, cfg.projectRoots),
      status: bridgeStatus,
      localModelPorts: cfg.localModelPorts ?? null,
      uploadsDir,
      vaultDir: cfg.vaultDir ?? null,
      // Skill-Bibliothek (nur lesen; Sicherung + Zurücksetzen nur in eigenen Skills).
      skills: new SkillLibrary({ claudeDir: cfg.claudeDir, projectRoots: cfg.projectRoots, backupsDir: opts.skillBackupsDir ?? p.skillBackups }),
      guard: { command: guardCommandForThisProcess(), configPath: opts.configPath ?? p.config },
      setup: setupRpc,
      // „Prozess beenden" ohne tmux nur mit passender Startzeit aus dem Claude-Register.
      sessionStart: async (tool, sessionId, pid) => (tool === "claude" ? claudeRecordedStart(cfg.claudeDir, pid, sessionId) : null),
      // Welche Programme hängen an der Session (für „In NyxOS übernehmen“)?
      sessionPids: async (tool, sessionId) => {
        if (tool === "claude") return [...(await claudePidMap(cfg.claudeDir, cfg.projectRoots))].filter(([, sid]) => sid === sessionId).map(([pid]) => pid);
        const known = tracker.known().find((k) => k.tool === "codex" && k.sessionId === sessionId && k.path);
        return known?.path ? codexPidsFor(known.path) : [];
      },
      processAttached: async (tool, sessionId) => {
        if (tool === "claude") return [...(await claudePidMap(cfg.claudeDir, cfg.projectRoots)).values()].includes(sessionId);
        const known = tracker.known().find((k) => k.tool === "codex" && k.sessionId === sessionId && k.path);
        if (!known?.path) return false;
        return (await codexOpenSessions([{ sessionId, path: known.path }])).has(sessionId);
      },
    });
    terminal = manager;
    link = new BridgeLink({
      serverUrl: cfg.serverUrl,
      token: cfg.token,
      manager,
      tmuxSocket: tc.socket,
      log,
      // Kanal tot → gleich den Tunnel mitprüfen, statt auf den nächsten Takt zu warten.
      onStale: () => void tunnel?.checkNow(),
      ...opts.link,
    });
    link.start();
    let mapping = false;
    mappingTick = async () => {
      if (closed || mapping || !released) return;
      mapping = true;
      try {
        const items = await manager.mappingTick();
        if (items.length > 0 && !closed) {
          outbox.enqueue(items);
          sender.nudge(0);
        }
      } catch (e) {
        log("terminal-zuordnung-fehler", { error: String(e) });
      } finally {
        mapping = false;
      }
    };
  }

  // Lebenszeichen: welche Sessions laufen gerade?
  // Eigenes Busy-Flag wie beim Spool-Takt — der Datei-Wächter auf
  // `~/.claude/sessions` UND der 5-Sekunden-Timer können sonst gleichzeitig feuern und zwei
  // `pgrep`/`lsof`-Läufe überlappen lassen, ohne dass ein Takt auf den anderen wartet.
  let livenessBusy = false;
  const livenessTick = async () => {
    if (closed || livenessBusy) return;
    livenessBusy = true;
    try {
      await livenessTickCore();
    } finally {
      livenessBusy = false;
    }
  };
  const livenessTickCore = async () => {
    if (closed) return;
    const src = opts.liveness
      ? await opts.liveness()
      : { claudeRunning: await runningClaude(cfg.claudeDir, cfg.projectRoots), codexProcess: await codexProcessRunning() };
    if (closed) return;
    const now = Date.now();
    const known = tracker.known();
    // `lsof` nur für Codex-Sessions, die die billige Schreibzeit-Prüfung schon als „still"
    // einstuft (≥ 10 Min ohne neues Schreiben) — bei allen anderen entfällt der teurere Aufruf.
    const staleCodex = src.codexProcess ? known.filter((k) => k.tool === "codex" && k.path && now - k.lastMtimeMs >= CODEX_ACTIVE_MS) : [];
    const openSessions =
      staleCodex.length > 0 ? await codexOpenSessions(staleCodex.map((k) => ({ sessionId: k.sessionId, path: k.path as string }))) : new Set<string>();
    if (closed) return;
    const items = outbox.db.transaction(() => {
      const changes = stateChanges(outbox, { known, ...src, codexOpenSessions: openSessions, now });
      if (changes.length > 0) outbox.enqueue(changes);
      return changes;
    });
    if (items.length > 0) sender.nudge();
  };

  // Hooks: Spool-Ordner leeren, sobald etwas ankommt.
  let spoolBusy = false;
  let spoolAgain = false;
  const spoolTick = async () => {
    if (closed || !released) return;
    if (spoolBusy) {
      spoolAgain = true;
      return;
    }
    spoolBusy = true;
    let done!: () => void;
    spoolRun = new Promise<void>((r) => (done = r));
    try {
      do {
        spoolAgain = false;
        const r = await drainSpool(spoolDir, outbox, cfg.projectRoots, log);
        if (r.events.length > 0) {
          sender.nudge(0);
          for (const e of r.events) {
            const tp = e.data.transcriptPath;
            if (typeof tp === "string") void tracker.handle(tp);
          }
        }
      } while (spoolAgain && !closed);
    } finally {
      spoolBusy = false;
      done();
    }
  };

  // Nutzung/Agenten & Skills: eigener, einfacherer Sende-Pfad ohne den SQLite-Puffer — die Zeilen sind
  // inhaltsleer (nur Zahlen/Zeit/Modell bzw. Name/Pfad) und aus den Dateien selbst jederzeit neu ableitbar;
  // ein verlorener Tick holt der nächste nach (kein Datenverlust-Risiko wie bei Events/Archiv).
  const usageScanner = new UsageScanner(cfg, join(spoolDir, "..", "usage-scan-state.json"), log);
  async function postJson(path: string, items: unknown[]): Promise<void> {
    if (items.length === 0) return;
    for (let i = 0; i < items.length; i += 500) {
      const chunk = items.slice(i, i + 500);
      try {
        const res = await fetchImpl(`${cfg.serverUrl}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
          body: JSON.stringify({ items: chunk }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) log("p6-senden-fehlgeschlagen", { path, status: res.status });
      } catch (e) {
        log("p6-senden-fehler", { path, error: String(e) });
      }
    }
  }
  const usageTick = async () => {
    if (closed) return;
    try {
      await postJson("/ingest/usage", await usageScanner.scanOnce());
      scans.usage = Date.now();
    } catch (e) {
      log("nutzung-scan-fehler", { error: String(e) });
    }
  };
  const catalogTick = async () => {
    if (closed) return;
    try {
      const { bySource } = await scanCatalog(homedir(), cfg.projectRoots);
      for (const [, items] of bySource) await postJson("/ingest/catalog", items);
      scans.catalog = Date.now();
    } catch (e) {
      log("bestand-scan-fehler", { error: String(e) });
    }
  };

  // Git-Erfassung (Datei-Wächter auf die `.git`-Ordner + Takt, s. git/scheduler.ts). Nur lesende Git-Befehle,
  // höchstens 4 zugleich. Gestartet erst, wenn Tunnel und Kanal stehen (Schritt 4, noch VOR dem langen
  // Nachimport) — vorher ist der Server nicht erreichbar und der Lauf scannte ins Leere.
  const git: GitScheduler | null = opts.git
    ? new GitScheduler({
        projectRoots: cfg.projectRoots,
        serverUrl: cfg.serverUrl,
        token: cfg.token,
        log,
        fetchImpl: opts.git.fetchImpl ?? fetchImpl,
        applyCatchups: opts.git.applyCatchups ?? false,
        ...(opts.git.intervalMs !== undefined ? { intervalMs: opts.git.intervalMs } : {}),
        ...(opts.git.probeIntervalMs !== undefined ? { probeIntervalMs: opts.git.probeIntervalMs } : {}),
        ...(opts.git.watchDebounceMs !== undefined ? { watchDebounceMs: opts.git.watchDebounceMs } : {}),
        ...(opts.git.minGapMs !== undefined ? { minGapMs: opts.git.minGapMs } : {}),
        onScanned: () => {
          scans.git = Date.now();
        },
      })
    : null;
  const gitTick = async (): Promise<void> => {
    await git?.trigger("takt");
  };

  // ── Schritt 3: warten, bis der Kanal steht (ohne Kanal: bis der Tunnel steht) ─────────────────────────
  const channelReady = async (): Promise<boolean | null> => {
    const ready = () => (link ? link.connected : (tunnel?.up ?? true));
    if (!link && !tunnel) return null;
    const end = Date.now() + (opts.channelWaitMs ?? CHANNEL_WAIT_MS);
    while (!closed && !ready() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return ready();
  };

  // ── Schritt 4: Rückstand im Hintergrund ─────────────────────────────────────────────────────────────
  const backlog = async (): Promise<void> => {
    const offen = await channelReady();
    if (closed) return;
    released = true;
    phase("kanal-bereit", { offen, puffer: outbox.size() });
    git?.start();
    void entrySources?.start().catch((e: unknown) => log("aufgaben-quelle-fehler", { error: String(e) }));

    const spoolWatcher: FSWatcher = watch(spoolDir, () => void spoolTick());
    closers.push(() => spoolWatcher.close());
    every(() => void spoolTick(), 2000);
    await spoolTick();
    if (closed) return;
    if (mappingTick) {
      const tick = mappingTick;
      every(() => void tick(), opts.terminalTickMs ?? 3000);
      void tick();
    }

    // Verlaufsdateien: Nachimport, dann laufend beobachten.
    const projects = join(cfg.claudeDir, "projects");
    const ignored = (path: string) => {
      if (!path.startsWith(projects + sep)) return false;
      return !claudeDirInProjects(relative(projects, path).split(sep)[0] ?? "", cfg.projectRoots);
    };
    // Quellen, die es noch nicht gibt (Claude Code/Codex erst NACH NyxOS installiert), werden beobachtet, bis sie
    // entstehen — dann hängt sich der Wächter an und liest einmal nach (s. transcript-watch.ts).
    const transcripts = new TranscriptWatch({
      targets: [projects, join(cfg.codexDir, "sessions"), join(cfg.codexDir, "session_index.jsonl")],
      chokidar: { ignoreInitial: true, ignored, depth: 6 },
      onPath: (path) => {
        const t = pendingPaths.get(path);
        if (t) clearTimeout(t);
        pendingPaths.set(
          path,
          setTimeout(() => {
            pendingPaths.delete(path);
            void tracker.handle(path);
          }, 30),
        );
      },
      onAppeared: async (target) => {
        const dateien = await tracker.scanTree(target);
        log("nachimport", { quelle: target, dateien, puffer: outbox.size() });
        sender.nudge(0);
        void livenessTick();
      },
      log,
    });
    closers.push(() => transcripts.close());
    await transcripts.start();
    if (closed) return;

    const importStart = performance.now();
    const scanned = await tracker.scanAll();
    if (closed) return;
    log("nachimport", { dateien: scanned, puffer: outbox.size(), dauerMs: Math.round(performance.now() - importStart) });
    await livenessTick();
    if (closed) return;
    sender.nudge(0);
    void archiver.sweep();

    const claudeSessions = join(cfg.claudeDir, "sessions");
    try {
      const w = watch(claudeSessions, () => void livenessTick());
      closers.push(() => w.close());
    } catch {
      // Ordner gibt es (noch) nicht – dann reicht der Takt.
    }
    every(() => void livenessTick().catch((e: unknown) => log("lebenszeichen-fehler", { error: String(e) })), opts.livenessMs ?? 5000);
    every(() => void archiver.sweep(), 60_000);
    every(() => sender.nudge(0), 10_000);
    every(() => {
      if (closed) return;
      outbox.setMeta(
        "status",
        JSON.stringify({
          at: Date.now(),
          queued: outbox.size(),
          dead: outbox.deadCount(),
          lastOkAt: sender.lastOkAt,
          lastError: sender.lastError,
          archiveError: archiver.lastError,
          uploads: archiver.uploads,
          vault: vault ? { ...vault.status } : null,
          kanal: link ? { offen: link.connected, stilleMs: link.beatAgeMs(), pings: link.pingSeen } : null,
          tunnel: tunnel ? { offen: tunnel.up } : null,
          schleifeMaxMs: lag.takeMax(),
        }),
      );
    }, 5000);

    // Echte Limits aus CodexBar — nur mit offenem Kanal (sonst bleibt der Bericht liegen), Fehler still.
    if (opts.codexbar && link) {
      const l = link;
      const reader = new CodexBarReader({ ...(opts.codexbar.path ? { path: opts.codexbar.path } : {}), send: (m) => l.send(m), log });
      closers.push(reader.start(opts.codexbar.pollMs));
    }

    // Schwere Scans erst nach dem Nachimport (nicht alle gleichzeitig beim Start unter Last).
    every(() => void usageTick(), 30_000);
    every(() => void catalogTick(), 5 * 60_000);
    void usageTick();
    void catalogTick();

    // „Gehirn": Obsidian-Vault nur lesend einlesen (Metadaten + Links), eigener Takt, nie blockierend.
    if (cfg.vaultDir && opts.vault !== false && existsSync(cfg.vaultDir)) {
      vault = new VaultSync({ vaultDir: cfg.vaultDir, serverUrl: cfg.serverUrl, token: cfg.token }, log, fetchImpl, opts.vault ?? {});
      void vault.start().catch((e: unknown) => log("vault-fehler", { error: String(e) }));
    }

    phase("nachimport-fertig", { dateien: scanned, puffer: outbox.size() });
  };
  const pendingPaths = new Map<string, NodeJS.Timeout>();
  const ready = backlog().catch((e: unknown) => log("start-fehler", { error: String(e) }));

  return {
    outbox,
    tracker,
    sender,
    archiver,
    get vault() {
      return vault;
    },
    spoolTick,
    livenessTick,
    terminal,
    link,
    tunnel,
    gitTick,
    usageTick,
    catalogTick,
    /** Erfüllt, sobald der Rückstand (Spool, Nachimport, erster Versand angestoßen) abgearbeitet ist. */
    ready,
    async stop() {
      closed = true;
      for (const t of timers) clearInterval(t);
      for (const t of pendingPaths.values()) clearTimeout(t);
      lag.stop();
      tunnel?.stop();
      link?.stop();
      // Erst Tracker/Archiv/Sender anhalten (der Nachimport läuft dann ins Leere), dann auf den Start warten.
      await Promise.all([tracker.stop(), archiver.stop(), sender.stop()]);
      await ready;
      for (const t of timers) clearInterval(t);
      await git?.stop();
      for (const c of closers) await c();
      await vault?.stop();
      await entrySources?.stop();
      await Promise.all([sender.stop(), spoolRun]);
      db.close();
    },
  };
}
