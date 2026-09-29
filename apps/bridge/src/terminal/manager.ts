// Terminal-Dienst der Brücke: Kanäle (Browser-Terminals) + Befehle vom Server (Starten,
// Fortsetzen, Beenden, Text senden) + Zuordnung tmux ↔ Session für den Ingest.
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  CHAT_MAX_FILE_BYTES,
  GitCompareRequestSchema,
  InterruptRequestSchema,
  KillRequestSchema,
  ResumeRequestSchema,
  SaveUploadRequestSchema,
  SendMessageRequestSchema,
  RunBuildRequestSchema,
  SendTextRequestSchema,
  SERVER_SSH_MAX,
  ServerToBridgeSchema,
  SSH_TMUX_NAME_RE,
  SshEmptyRequestSchema,
  SshStartRpcSchema,
  SkillBackupRequestSchema,
  SkillReadRequestSchema,
  SkillRestoreRequestSchema,
  StartRequestSchema,
  TakeoverInfoRequestSchema,
  TakeoverRequestSchema,
  TERM_ERR,
  VaultNoteRequestSchema,
  VoiceBridgeRequestSchema,
  WORKTREE_DIR,
  WorktreeAddRequestSchema,
  base64Bytes,
  chatFileAllowed,
  codexSessionIdFromPath,
  safeUploadName,
  sanitizePasteText,
  type BridgeStatusReport,
  type BridgeToServer,
  type IngestItem,
  type SaveUploadRequest,
  type SaveUploadResult,
  type SendMessageRequest,
  type SendMessageResult,
  type SshStartRpc,
  type SshStartResult,
  type SshStatusResult,
  type SshStopResult,
  type StartResult,
  type TakeoverInfo,
  type TakeoverInfoRequest,
  type TakeoverRequest,
  type TerminalInfo,
  type Tool,
  type WorktreeAddRequest,
  type WorktreeAddResult,
  t,
} from "@nyxos/shared";
import { runBuild } from "../build/runBuild.js";
import { allowedPorts, httpProxyLocal, LocalProxyError } from "../localProxy.js";
import { probeVoice, transcribe } from "../voice/transcribe.js";
import { writeVaultNote } from "../vault/note.js";
import { simulatorScreenshot } from "../simulator/screenshot.js";
import { showNotification } from "../notify/macNotify.js";
import { accessRoots, underRoot } from "../config.js";
import { findBin, IS_LINUX } from "../platform.js";
import { sameStart, type RecordedStart } from "../liveness.js";
import { gitCompare, GitCompareError } from "../git/compare.js";
import { SkillLibraryError, type SkillLibrary } from "../skills.js";
import { FinderError, type FinderFs } from "../finder/fs.js";
import { ControlClient } from "./control.js";
import { screenWaiting } from "./detect.js";
import { notIdleReason, promptState } from "./prompt.js";
import { Tmux, TmuxError } from "./tmux.js";

const run = promisify(execFile);

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface TerminalManagerOptions {
  tmux: Tmux;
  /** Projektordner; nur darin (ohne eingetragene Ordner: im Home-Verzeichnis) startet die Brücke Sessions. */
  projectRoots: readonly string[];
  /** Pfad-Suche für claude/codex und Umgebung neuer Sessions (launchd hat einen kargen PATH). */
  path: string;
  lang?: string;
  /** Start-Helfer (Exit-Code-Datei) — nur für Shell-Starts nötig, hier nicht verwendet. */
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Hängt noch ein Prozess an dieser Session? (Claude: ~/.claude/sessions, Codex: lsof, tmux-Zuordnung) */
  processAttached: (tool: Tool, sessionId: string) => Promise<boolean>;
  /** Claude-Register: pid → Session-ID (aus ~/.claude/sessions/<pid>.json, s. liveness.ts). */
  claudePids: () => Promise<Map<number, string>>;
  /** Für „Prozess beenden" ohne tmux: pid einer Claude-Session. */
  now?: () => number;
  /** Wie der Leitplanken-Hook aufgerufen wird (voller Befehl ohne „guard“) + Brücken-Konfiguration. */
  guard?: { command: string; configPath: string | null };
  /** Stand der Brücke für den Befehl `status` (Puffer, Scans), s. daemon.ts. */
  status?: () => Omit<BridgeStatusReport, "tmux">;
  /** Ordner für Chat-Anhänge (`~/.nyxos/bridge/uploads`, Probe: im Datenordner). */
  uploadsDir?: string;
  /** PIDs der Programme, die gerade an dieser Session arbeiten (Claude: ~/.claude/sessions,
   * Codex: wer die Rollout-Datei offen hält). Ohne Angabe: keine bekannt. */
  sessionPids?: (tool: Tool, sessionId: string) => Promise<number[]>;
  /** So lange warten, bis sich das alte Programm nach SIGTERM beendet hat (Standard 8 s). */
  endWaitMs?: number;
  /** Prozess-Tabelle (PID → Eltern, Programm, Startzeit). Nur für Tests austauschbar. */
  processTable?: () => Promise<ProcTable>;
  /** Startzeit eines Prozesses dieser Session laut Register (Claude: `~/.claude/sessions/<pid>.json`).
   * „Prozess beenden" ohne tmux trifft nur, was dazu passt. Ohne Angabe: nie per Signal beenden. */
  sessionStart?: (tool: Tool, sessionId: string, pid: number) => Promise<RecordedStart | null>;
  /** Obsidian-Vault für „In Obsidian ablegen“ (`vault_note`); `null`/fehlt = nicht eingerichtet. */
  vaultDir?: string | null;
  /** Zusätzliche lokale Ports für `http_proxy_local` (Ollama 11434 und LM Studio 1234 sind immer erlaubt). */
  localModelPorts?: number[] | null;
  /** Tests: fetch für `http_proxy_local`. */
  localFetch?: typeof fetch;
  /** Skill-Bibliothek (Lesen, Sicherung, Zurücksetzen, `--add-dir`-Prüfung). Ohne: Skill-Befehle abgelehnt. */
  skills?: SkillLibrary;
  /** Finder-Dienst (Ordner/Dateien unter den Favoriten-Wurzeln). Ohne Angabe: aus. */
  finder?: FinderFs;
  /** Server-SSH: ssh-Programm (Standard: `ssh` aus dem PATH, Tests: Attrappe). Der Rest des Befehls ist fest. */
  sshBin?: string;
  /** Einrichtung (Onboarding): Stand lesen und Änderungen übernehmen. Ohne Angabe: abgelehnt. */
  setup?: { state: () => Promise<unknown>; apply: (params: unknown) => Promise<unknown>; browse: (params: unknown) => Promise<unknown> };
}

interface Mapped {
  tool: Tool;
  sessionId: string;
  tmuxName: string | null;
  attachable: boolean;
  screenWaiting: boolean | null;
}

/** Pause nach eingefügten Bildpfaden, bevor Text/Enter folgen (Claude wandelt den Pfad in „[Image #n]“). */
const IMAGE_SETTLE_MS = 300;

/**
 * Welches Werkzeug läuft in dieser tmux-Session? Nur `zc-claude-*`/`zc-codex-*` sind Werkzeug-Sessions —
 * alles andere (Server-SSH `zc-ssh-*`) ist KEINE Claude-/Codex-Session: nie zuordnen, zählen oder archivieren.
 * Früher galt jeder Name ohne „codex“ als Claude.
 */
export function toolOfTmuxName(name: string): Tool | null {
  if (name.startsWith("zc-claude-")) return "claude";
  if (name.startsWith("zc-codex-")) return "codex";
  return null;
}

/** Für Befehle, die nur Werkzeug-Sessions betreffen (Chat, Senden, Esc) — alles andere ablehnen. */
const toolOf = (name: string): Tool => {
  const tool = toolOfTmuxName(name);
  if (!tool) throw new RpcError(t("Das ist keine Claude-/Codex-Session"), TERM_ERR.notFound);
  return tool;
};

/** Server-SSH: der EINZIGE Befehl dieser Terminal-Art. `-t` erzwingt ein Terminal auf dem Server. Das Ziel ist
 * per Schema geprüft (nie ein Schalter) und kommt aus der Server-Einstellung; `--` trennt es zusätzlich ab. */
export function serverSshCommand(sshBin: string, host: string): string[] {
  return [sshBin, "-t", "--", host];
}
const defaultSshBin = () => findBin("ssh") ?? "ssh";
const shortId = () =>
  randomBytes(8)
    .toString("base64")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .padEnd(8, "0")
    .slice(0, 8);

export class TerminalManager {
  private readonly channels = new Map<number, ControlClient>();
  /** tmux-Name → Session-ID, die wir beim Start selbst vergeben haben (Claude `--session-id`). */
  private readonly startedIds = new Map<string, { tool: Tool; sessionId: string }>();
  /** Laufende „Fortsetzen"-Aufträge (`tool:sessionId`) — Sperre gegen Doppelklick/zwei Tabs. */
  private readonly resuming = new Set<string>();
  private readonly takingOver = new Set<string>();
  /** Was der Übernehmen-Dialog zuletzt gezeigt hat (Session → PID → Startzeit). Beendet wird nur,
   * was dort mit GENAU dieser Startzeit stand — eine inzwischen neu vergebene PID ist ein anderer Prozess. */
  private readonly previews = new Map<string, { at: number; procs: Map<number, number> }>();
  /** Zuletzt gemeldete Zuordnung je `tool:sessionId`. */
  private readonly reported = new Map<string, Mapped>();
  /** Server-SSH: laufender Start — zwei Klicks/Tabs gleichzeitig bekommen dieselbe Sitzung. */
  private sshStarting: Promise<SshStartResult> | null = null;

  constructor(private readonly o: TerminalManagerOptions) {}

  // ── Kanäle ────────────────────────────────────────────────────────────────────────────────

  /** Eine Nachricht vom Server verarbeiten; Antworten gehen über `send`. */
  async handle(raw: string, send: (m: BridgeToServer) => void): Promise<void> {
    let parsed;
    try {
      parsed = ServerToBridgeSchema.safeParse(JSON.parse(raw));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.op) {
      case "open": {
        this.channels.get(msg.ch)?.close();
        const client = new ControlClient(this.o.tmux, msg.tmuxName, {
          snapshot: (s) => send({ op: "snapshot", ch: msg.ch, ...s }),
          output: (d) => send({ op: "out", ch: msg.ch, d }),
          size: (cols, rows) => send({ op: "size", ch: msg.ch, cols, rows }),
          exit: (reason) => {
            this.channels.delete(msg.ch);
            send({ op: "exit", ch: msg.ch, reason });
          },
        });
        this.channels.set(msg.ch, client);
        client.start({ cols: msg.cols, rows: msg.rows, readOnly: msg.readOnly });
        return;
      }
      case "in":
        this.channels.get(msg.ch)?.input(msg.d);
        return;
      case "resize":
        this.channels.get(msg.ch)?.resize(msg.cols, msg.rows);
        return;
      case "pause":
        this.channels.get(msg.ch)?.pause();
        return;
      case "resume":
        this.channels.get(msg.ch)?.resume();
        return;
      case "close":
        this.channels.get(msg.ch)?.close();
        this.channels.delete(msg.ch);
        return;
      case "rpc": {
        // Rechenzeit mitschicken — der Server trennt damit „Mac langsam“ von „Weg langsam“.
        const t0 = performance.now();
        const ms = () => Math.round((performance.now() - t0) * 10) / 10;
        try {
          const result = await this.rpc(msg.method, msg.params);
          send({ op: "rpc_result", id: msg.id, ok: true, result, ms: ms() });
        } catch (e) {
          const code = e instanceof RpcError ? e.code : e instanceof TmuxError ? (e.code === "tmux_missing" ? TERM_ERR.tmuxMissing : e.code) : "failed";
          send({ op: "rpc_result", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e), code, ms: ms() });
        }
        return;
      }
    }
  }

  /** Verbindung zum Server weg: alle Steuer-Clients lösen (tmux-Sessions laufen weiter). */
  closeAll(): void {
    for (const c of this.channels.values()) c.close();
    this.channels.clear();
  }

  get channelCount(): number {
    return this.channels.size;
  }

  // ── Befehle ───────────────────────────────────────────────────────────────────────────────

  async rpc(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "start":
        return this.start(StartRequestSchema.parse(params));
      case "resume":
        return this.resume(ResumeRequestSchema.parse(params));
      case "kill":
        return this.kill(KillRequestSchema.parse(params));
      case "send_text":
        return this.sendText(SendTextRequestSchema.parse(params));
      case "list_folders":
        return { folders: this.listFolders() };
      case "worktree_add":
        return this.worktreeAdd(WorktreeAddRequestSchema.parse(params));
      // Build-Prüfung auf diesem Rechner (lang laufend — `handle` wartet nicht seriell darauf).
      case "run_build":
        return runBuild(RunBuildRequestSchema.parse(params), { path: this.o.path, projectRoots: this.o.projectRoots });
      case "status":
        return this.statusReport();
      // Session-Chat der NyxOS.
      case "save_upload":
        return this.saveUpload(SaveUploadRequestSchema.parse(params));
      case "send_message":
        return this.sendMessage(SendMessageRequestSchema.parse(params));
      case "interrupt":
        return this.interrupt(InterruptRequestSchema.parse(params).tmuxName);
      case "git_compare":
        try {
          return await gitCompare(accessRoots(this.o.projectRoots), GitCompareRequestSchema.parse(params));
        } catch (e) {
          if (e instanceof GitCompareError) throw new RpcError(e.message, e.code);
          throw e;
        }
      // Spracherkennung auf diesem Rechner (whisper.cpp + ffmpeg, Modell unter ~/.nyxos/models/whisper).
      case "voice_probe":
        return probeVoice({ path: this.o.path });
      case "transcribe":
        return transcribe(VoiceBridgeRequestSchema.parse(params), { path: this.o.path });
      case "takeover_info":
        return this.takeoverInfo(TakeoverInfoRequestSchema.parse(params));
      case "takeover":
        return this.takeover(TakeoverRequestSchema.parse(params));
      // Nyx-Faden als Notiz in den Vault (Ordner + Name rechnet die Brücke selbst).
      case "vault_note":
        return writeVaultNote(this.o.vaultDir, VaultNoteRequestSchema.parse(params));
      // Lokale Modelle (Ollama/LM Studio) nur über 127.0.0.1 und freigegebene Ports.
      case "http_proxy_local":
        try {
          return await httpProxyLocal(params, { ports: allowedPorts(this.o.localModelPorts), fetchImpl: this.o.localFetch });
        } catch (e) {
          if (e instanceof LocalProxyError) throw new RpcError(e.message, e.code);
          throw e;
        }
      // Nyx-Werkzeug `screenshot_simulator` (keine Parameter vom Server).
      case "simulator_screenshot":
        return simulatorScreenshot({ path: this.o.path });
      // Skill-Bibliothek.
      case "skills_list":
        return this.skillLib().list();
      case "skill_read":
        return this.skillLib().read(SkillReadRequestSchema.parse(params).paths);
      case "skill_backup": {
        const req = SkillBackupRequestSchema.parse(params);
        return this.skillCall(() => this.skillLib().backup(req.dir, req.label));
      }
      case "skill_restore": {
        const req = SkillRestoreRequestSchema.parse(params);
        return this.skillCall(() => this.skillLib().restore(req.skillPath, req.content, req.expectSha256));
      }
      // Dateien wie der Finder (Unter-Befehl in `params.op`, s. finder/fs.ts).
      case "finder":
        if (!this.o.finder) throw new RpcError(t("Dateien sind auf dieser Brücke aus"), "failed");
        try {
          return await this.o.finder.handle(params);
        } catch (e) {
          if (e instanceof FinderError) throw new RpcError(e.message, e.code);
          throw e;
        }
      // Desktop-Mitteilung (Push-Weg „Rechner“); Titel/Text nur als Programm-Argumente, s. notify/macNotify.ts.
      case "notify":
        return showNotification(params);
      // Server-SSH: nur Start/Status/Beenden mit festem Befehl, Parameter streng (unbekannte → Fehler).
      case "ssh_start":
        return this.sshStart(SshStartRpcSchema.parse(params ?? {}));
      case "ssh_status":
        SshEmptyRequestSchema.parse(params ?? {});
        return this.sshStatus();
      case "ssh_stop":
        SshEmptyRequestSchema.parse(params ?? {});
        return this.sshStop();
      // Einrichtung (Onboarding): Projektordner, Vault, Hooks, Shell-Anbindung.
      case "setup.state":
        if (!this.o.setup) throw new RpcError(t("Einrichtung ist auf dieser Brücke aus"), "failed");
        return this.o.setup.state();
      case "setup.apply":
        if (!this.o.setup) throw new RpcError(t("Einrichtung ist auf dieser Brücke aus"), "failed");
        return this.o.setup.apply(params);
      // Ordner-Auswahl im Onboarding: nur Unterordner auflisten.
      case "setup.browse":
        if (!this.o.setup) throw new RpcError(t("Einrichtung ist auf dieser Brücke aus"), "failed");
        return this.o.setup.browse(params);
      default:
        throw new RpcError(t("Unbekannter Befehl {method}", { method }), "failed");
    }
  }

  private skillLib(): SkillLibrary {
    if (!this.o.skills) throw new RpcError(t("Die Skill-Bibliothek ist auf dieser Brücke nicht eingerichtet"), "failed");
    return this.o.skills;
  }

  private async skillCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SkillLibraryError) throw new RpcError(e.message, `skill_${e.code}`);
      throw e;
    }
  }

  /** Nur lesender Stand für die Verbindungs-Prüfung des Servers (Puffer, Scans, tmux). */
  async statusReport(): Promise<BridgeStatusReport> {
    let tmux: BridgeStatusReport["tmux"];
    try {
      const panes = await this.o.tmux.listPanes();
      tmux = { ok: true, sessions: new Set(panes.map((p) => p.name)).size, error: null };
    } catch (e) {
      tmux = { ok: false, sessions: 0, error: e instanceof Error ? e.message : String(e) };
    }
    const base = this.o.status?.() ?? {
      at: Date.now(),
      version: null,
      queued: 0,
      dead: 0,
      lastOkAt: null,
      lastError: null,
      archiveError: null,
      watchedFiles: 0,
      scans: { usage: null, git: null, vault: null, catalog: null },
      vaultError: null,
    };
    return { ...base, tmux };
  }

  /** Programm im PATH suchen (absoluter Pfad, damit tmux es ohne Shell startet). */
  resolveBin(tool: Tool): string {
    for (const dir of this.o.path.split(delimiter)) {
      if (!dir) continue;
      const p = join(dir, tool);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // weiter suchen
      }
    }
    throw new RpcError(t("{tool} nicht gefunden", { tool }), "failed");
  }

  /** Erlaubte Wurzeln nach Auflösen von Links (Projektordner, ohne eingetragene Ordner das Home-Verzeichnis). */
  private realRoots(): string[] {
    return accessRoots(this.o.projectRoots).flatMap((r) => {
      try {
        return [realpathSync(r)];
      } catch {
        return [];
      }
    });
  }

  /** Ordner muss existieren und (nach Auflösen von Links) in einem Projektordner liegen. */
  checkFolder(cwd: string): string {
    let real: string;
    try {
      real = realpathSync(cwd);
      if (!statSync(real).isDirectory()) throw new Error();
    } catch {
      throw new RpcError(t("Ordner gibt es nicht"), TERM_ERR.badFolder);
    }
    if (!this.realRoots().some((r) => underRoot(real, r))) throw new RpcError(t("Ordner liegt nicht in einem Projektordner"), TERM_ERR.badFolder);
    return real;
  }

  /**
   * Worktree für einen Auftrag anlegen: immer `<repo>/.worktrees/<slug>`. `anchor` ist ein Pfad relativ zu einem
   * Projektordner (GOAL.md des Auftrags, ein Ordner, `""` = der Projektordner). Die Brücke sucht das Git-Repo,
   * in dem der Anker liegt, und berechnet den Pfad SELBST (nie einen vom Server gelieferten Zielpfad
   * übernehmen; `slug` ist streng `[a-z0-9-]{1,60}` schon per Schema geprüft). `git worktree add` läuft per
   * `execFile` mit einer Argument-Liste (kein `sh -c`, keine Injektion über `branch`/`slug` möglich).
   */
  async worktreeAdd(req: WorktreeAddRequest): Promise<WorktreeAddResult> {
    // Anker in den Projektordnern suchen (der erste Projektordner, in dem es ihn gibt, gewinnt).
    let anchorReal: string | null = null;
    for (const root of this.realRoots()) {
      const candidate = req.anchor ? join(root, ...req.anchor.split("/")) : root;
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (!underRoot(real, root)) continue; // Link nach draußen
      if (req.anchor === "" && !existsSync(join(real, ".git"))) continue; // ohne Anker: der Projektordner, der ein Repo ist
      anchorReal = real;
      break;
    }
    if (!anchorReal) throw new RpcError(req.anchor ? t("Anker gibt es in keinem Projektordner: {anchor}", { anchor: req.anchor }) : t("Kein Projektordner ist ein Git-Repo"), TERM_ERR.badFolder);
    const anchorDir = statSync(anchorReal).isDirectory() ? anchorReal : join(anchorReal, "..");

    // Arbeitskopie, in der der Anker liegt, und das Haupt-Repo dazu (auch wenn der Anker in einem Worktree liegt).
    let top: string;
    let realRepoRoot: string;
    try {
      top = realpathSync((await run("git", ["rev-parse", "--show-toplevel"], { cwd: anchorDir })).stdout.trim());
      const common = (await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: anchorDir })).stdout.trim();
      realRepoRoot = basename(common) === ".git" ? realpathSync(join(common, "..")) : top;
    } catch {
      throw new RpcError(t("Der Anker liegt in keinem Git-Repo: {anchor}", { anchor: req.anchor || "." }), TERM_ERR.badFolder);
    }
    if (!this.realRoots().some((r) => underRoot(realRepoRoot, r))) throw new RpcError(t("Repo liegt nicht in einem Projektordner"), TERM_ERR.badFolder);
    const rel = anchorReal === top ? "" : anchorReal.slice(top.length + 1);
    const anchorInRepo = rel ? rel.split(/[\\/]/).join("/") : null;

    const parentDir = join(realRepoRoot, WORKTREE_DIR);
    // Der Ordner darf beim allerersten Auftrag noch fehlen.
    try {
      mkdirSync(parentDir, { recursive: true });
    } catch {
      throw new RpcError(t("Übergeordneter Worktree-Ordner lässt sich nicht anlegen"), TERM_ERR.badFolder);
    }
    const realParent = realpathSync(parentDir);
    if (!underRoot(realParent, realRepoRoot)) throw new RpcError(t("Worktree-Ordner liegt nicht im Repo"), TERM_ERR.badFolder);
    await excludeWorktreeDir(realRepoRoot);

    const worktreePath = join(realParent, req.slug);
    // Ein unterbrochener Start (Worktree angelegt, aber der Start-RPC danach fehlgeschlagen) ruft hier ein
    // zweites Mal mit demselben Slug an: steht dort derselbe Zweig, wird der Worktree weiterverwendet.
    if (existsSync(worktreePath)) {
      let branch = "";
      try {
        branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })).stdout.trim();
      } catch {
        // kein Checkout
      }
      if (branch !== req.branch) throw new RpcError(t("Es gibt schon einen Worktree mit diesem Namen"), TERM_ERR.worktreeExists);
      const real = realpathSync(worktreePath);
      if (!underRoot(real, realParent)) throw new RpcError(t("Worktree liegt nach dem Anlegen nicht unter der erlaubten Wurzel"), TERM_ERR.badFolder);
      return { repoRoot: realRepoRoot, worktreePath: real, branch: req.branch, anchorInRepo, reused: true };
    }

    const base = await mainBranchOf(realRepoRoot);
    try {
      await run("git", ["worktree", "add", worktreePath, "-b", req.branch, base], { cwd: realRepoRoot });
    } catch (e) {
      throw new RpcError(t("git worktree add fehlgeschlagen: {error}", { error: e instanceof Error ? e.message : String(e) }), "failed");
    }
    // Realpath-Prüfung NACH dem Anlegen wiederholen (derselbe Grundsatz wie `checkFolder`): erst
    // JETZT existiert der Pfad wirklich, ein Symlink-Trick in der Eltern-Kette fiele hier auf.
    const realWorktreePath = realpathSync(worktreePath);
    if (!underRoot(realWorktreePath, realParent)) throw new RpcError(t("Worktree liegt nach dem Anlegen nicht unter der erlaubten Wurzel"), TERM_ERR.badFolder);
    this.o.log("worktree-angelegt", { worktreePath: realWorktreePath, branch: req.branch });
    return { repoRoot: realRepoRoot, worktreePath: realWorktreePath, branch: req.branch, anchorInRepo, reused: false };
  }

  private env(name: string, extra?: Record<string, string> | null): Record<string, string> {
    // `extra` (z. B. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) kommt vom Server, der die Schwellen
    // auflöst — die Brücke kennt sie nicht und rechnet nichts nach, sie reicht sie nur durch.
    // Trotzdem nie blind — nur die Positivliste unten darf ankommen.
    return { NYXOS_TMUX_NAME: name, PATH: this.o.path, LANG: this.o.lang ?? "en_US.UTF-8", COLORTERM: "truecolor", ...sanitizeAutoCompactEnv(extra) };
  }

  // P7 (`extraEnv`, z. B. NYXOS_AUFTRAG/NYXOS_WORKTREE der Leitplanken) + W-1 (`autoCompactEnv`,
  // Positivliste in `env()`) laufen unabhängig nebeneinander: `extraEnv` NICHT durch die
  // Autocompact-Positivliste filtern, sonst gingen die Guard-Variablen verloren.
  private async launch(
    tool: Tool,
    cwd: string,
    args: string[],
    cols: number,
    rows: number,
    sessionId: string | null,
    autoCompactEnv?: Record<string, string> | null,
    extraEnv: Record<string, string> = {},
  ): Promise<StartResult> {
    const t0 = Date.now();
    const name = `zc-${tool}-${shortId()}`;
    const bin = this.resolveBin(tool);
    const opts = { name, cwd, cols, rows, env: { ...this.env(name, autoCompactEnv), ...extraEnv }, command: [bin, ...args] };
    await this.o.tmux.newSession(opts);
    if (sessionId) this.startedIds.set(name, { tool, sessionId });
    this.o.log("terminal-start", { name, tool, cwd, autoCompact: !!autoCompactEnv });
    return { tmuxName: name, tool, sessionId, startedMs: Date.now() - t0 };
  }

  /** Argumente + Umgebung einer Auftrags-Session: Leitplanken-Hook per `--settings` (nur diese Session),
   * autonomer Modus, Auftrag + Worktree in der Umgebung (der Hook prüft beides). */
  private auftragLaunch(a: { id: string; worktree: string }): { args: string[]; env: Record<string, string> } {
    if (!this.o.guard) throw new RpcError(t("Leitplanken-Hook nicht eingerichtet – Auftrag wird nicht gestartet"), TERM_ERR.badFolder);
    const worktree = this.checkFolder(a.worktree);
    const settings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${this.o.guard.command} guard`, timeout: 5 }] }] } });
    const env: Record<string, string> = { NYXOS_AUFTRAG: a.id, NYXOS_WORKTREE: worktree };
    if (this.o.guard.configPath) env.NYXOS_BRIDGE_CONFIG = this.o.guard.configPath;
    return { args: ["--settings", settings, "--permission-mode", "auto"], env };
  }

  async start(req: ReturnType<typeof StartRequestSchema.parse>): Promise<StartResult> {
    const cwd = this.checkFolder(req.cwd);
    // `autoCompactArgs` (Codex: `-c model_auto_compact_token_limit=<n>`) muss VOR `-m`/Prompt
    // stehen — Codex liest globale `-c`-Overrides nur vor dem eigentlichen Prompt-Argument.
    if (req.tool === "claude") {
      const sessionId = randomUUID();
      // P7 Start-Kette: Auftrags-Sessions laufen autonom, aber NUR mit Leitplanke (D6) – ohne Hook kein Start.
      const auftrag = req.auftrag ? this.auftragLaunch(req.auftrag) : null;
      // Zusätzliche Ordner (`--add-dir`) nur aus der Erlaubnisliste der Skill-Bibliothek.
      const addDirs = (req.addDirs ?? []).flatMap((d) => {
        try {
          return ["--add-dir", this.skillLib().checkAddDir(d)];
        } catch (e) {
          throw new RpcError(e instanceof Error ? e.message : t("Ordner nicht freigegeben"), TERM_ERR.badFolder);
        }
      });
      const args = ["--session-id", sessionId, ...(req.model ? ["--model", req.model] : []), ...addDirs, ...(auftrag?.args ?? []), ...(req.prompt ? ["--", req.prompt] : [])];
      return this.launch("claude", cwd, args, req.cols, req.rows, sessionId, req.autoCompactEnv, auftrag?.env ?? {});
    }
    const args = [...sanitizeAutoCompactArgs(req.autoCompactArgs), ...(req.model ? ["-m", req.model] : []), ...(req.prompt ? ["--", req.prompt] : [])];
    return this.launch("codex", cwd, args, req.cols, req.rows, null, req.autoCompactEnv);
  }

  /** „In NyxOS fortsetzen" / „Neu starten": nur, wenn KEIN Prozess mehr an der Session hängt —
   * zwei Prozesse auf demselben Verlauf zerstören ihn. */
  async resume(req: ReturnType<typeof ResumeRequestSchema.parse>): Promise<StartResult> {
    // Zwei fast gleichzeitige Anfragen (zwei Tabs, zweiter Klick nach Zeitüberschreitung)
    // dürfen nicht beide starten — die Prüfungen unten sehen einen gerade startenden Prozess noch nicht.
    const key = `${req.tool}:${req.sessionId}`;
    if (this.resuming.has(key)) throw new RpcError(t("Diese Session wird gerade schon fortgesetzt"), TERM_ERR.processRunning);
    this.resuming.add(key);
    try {
      if (await this.o.processAttached(req.tool, req.sessionId)) {
        throw new RpcError(t("An dieser Session hängt noch ein laufender Prozess — erst beenden, dann fortsetzen"), TERM_ERR.processRunning);
      }
      const inTmux = [
        ...[...this.reported.values()].filter((m) => m.tool === req.tool && m.sessionId === req.sessionId && m.attachable && m.tmuxName).map((m) => m.tmuxName as string),
        ...[...this.startedIds].filter(([, v]) => v.tool === req.tool && v.sessionId === req.sessionId).map(([name]) => name),
      ];
      for (const name of inTmux) {
        if (await this.o.tmux.hasSession(name)) throw new RpcError(t("Die Session läuft schon in tmux"), TERM_ERR.processRunning);
      }
      // Im Arbeitsordner der Session fortsetzen. Claude findet einen Verlauf nur im Ordner, in dem er
      // entstand — früher wich die Brücke bei einem ungültigen Ordner still auf den Projektordner aus, dann
      // startete ein leeres Claude („No conversation found“). Jetzt lieber ehrlich ablehnen.
      const cwd = this.checkFolder(req.cwd ?? this.o.projectRoots[0] ?? homedir());
      const args = [...(req.tool === "codex" ? sanitizeAutoCompactArgs(req.autoCompactArgs) : []), ...(req.tool === "claude" ? ["--resume", req.sessionId] : ["resume", req.sessionId])];
      return await this.launch(req.tool, cwd, args, req.cols, req.rows, req.sessionId, req.autoCompactEnv);
    } finally {
      this.resuming.delete(key);
    }
  }

  // ── Server-SSH ────────────────────────────────────────────────────────────────────────────

  private async sshSessions(): Promise<string[]> {
    return this.o.tmux.listSessionNames(SSH_TMUX_NAME_RE);
  }

  async sshStatus(): Promise<SshStatusResult> {
    const [name] = await this.sshSessions();
    return { running: !!name, tmuxName: name ?? null };
  }

  /** Terminal zum Server: läuft schon eine → die zurückgeben, sonst eine neue mit dem festen Befehl. */
  sshStart(req: SshStartRpc): Promise<SshStartResult> {
    this.sshStarting ??= (async () => {
      try {
        const running = await this.sshSessions();
        if (running.length >= SERVER_SSH_MAX && running[0]) return { tmuxName: running[0], reused: true };
        const name = `zc-ssh-${shortId()}`;
        // Keine NYXOS_TMUX_NAME: die Sitzung soll nirgends als Werkzeug-Session auftauchen.
        const env = { PATH: this.o.path, LANG: this.o.lang ?? "en_US.UTF-8", COLORTERM: "truecolor" };
        await this.o.tmux.newSession({ name, cwd: homedir(), cols: req.cols, rows: req.rows, env, command: serverSshCommand(this.o.sshBin ?? defaultSshBin(), req.host) });
        this.o.log("server-ssh-start", { name });
        return { tmuxName: name, reused: false };
      } finally {
        this.sshStarting = null;
      }
    })();
    return this.sshStarting;
  }

  /** „Trennen“: alle Server-SSH-Sitzungen schließen (ssh endet damit, auf dem Server bleibt nichts hängen). */
  async sshStop(): Promise<SshStopResult> {
    let stopped = 0;
    for (const name of await this.sshSessions()) if (await this.o.tmux.killSession(name)) stopped++;
    this.o.log("server-ssh-stop", { stopped });
    return { stopped };
  }

  // ── Übernehmen (D2) ──────────────────────────────────────────────────────────────────

  /** Programme an der Session, getrennt nach „in unserer tmux“ (→ `inNyxOS`) und „woanders“. Der Dialog
   * bekommt genau diese Liste; die Brücke merkt sich dazu die Startzeiten (s. `takeover`). */
  async takeoverInfo(req: TakeoverInfoRequest): Promise<TakeoverInfo> {
    const { info, starts } = await this.inspectSession(req);
    for (const [key, v] of this.previews) if (Date.now() - v.at > PREVIEW_TTL_MS) this.previews.delete(key);
    this.previews.set(`${req.tool}:${req.sessionId}`, { at: Date.now(), procs: starts });
    return info;
  }

  /**
   * Die PID-Quellen (`~/.claude/sessions/<pid>.json`, `lsof`) können veraltet sein — eine liegen
   * gebliebene Datei eines abgestürzten Claude zeigt auf eine PID, die macOS längst neu vergeben hat. Darum zählt
   * außerhalb der NyxOS nur, was (1) eine echte PID > 1 und nicht die Brücke selbst ist, (2) gerade läuft und
   * (3) laut `ps` wirklich dieses Werkzeug ist (Claude bzw. Codex). Alles andere wird weder gezeigt noch beendet.
   */
  private async inspectSession(req: TakeoverInfoRequest): Promise<{ info: TakeoverInfo; starts: Map<number, number> }> {
    const raw = await (this.o.sessionPids?.(req.tool, req.sessionId) ?? Promise.resolve([]));
    const pids = [...new Set(raw)].filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid);
    let inNyxOS: string | null = null;
    const outside: number[] = [];
    const starts = new Map<number, number>();
    if (pids.length === 0) return { info: { processes: [], inNyxOS }, starts };
    const panes = await this.o.tmux.listPanes().catch(() => []);
    const table = await (this.o.processTable ?? processTable)();
    for (const pid of pids) {
      const pane = panes.find((p) => isDescendant(table, pid, p.panePid));
      if (pane) {
        inNyxOS ??= pane.name;
        continue;
      }
      const row = table.get(pid);
      if (!row || row.startMs === null) continue; // schon weg (oder nicht lesbar) → nichts zu beenden
      if (!(await isToolProcess(req.tool, pid, row.comm))) {
        this.o.log("terminal-uebernahme-fremde-pid", { tool: req.tool, sessionId: req.sessionId, pid, comm: row.comm });
        continue;
      }
      outside.push(pid);
      starts.set(pid, row.startMs);
    }
    return { info: { processes: outside.map((pid) => ({ pid, app: appOf(table, pid) })), inNyxOS }, starts };
  }

  /**
   * „In der NyxOS übernehmen“: läuft die Session schon in unserer tmux → die zurückgeben. Hängen Programme
   * außerhalb daran → nur beenden, wenn GENAU diese PIDs im Dialog freigegeben wurden (`endPids`), sauber per
   * SIGTERM, dann warten, bis sie weg sind. Nie hart (SIGKILL), nie eine andere PID. Danach `--resume` in tmux.
   */
  async takeover(req: TakeoverRequest): Promise<StartResult> {
    // Zwei Klicks (zwei Tabs) gleichzeitig: nur einer beendet und startet.
    const key = `${req.tool}:${req.sessionId}`;
    if (this.takingOver.has(key)) throw new RpcError(t("Diese Session wird gerade schon übernommen"), TERM_ERR.processRunning);
    this.takingOver.add(key);
    try {
      const { info, starts } = await this.inspectSession(req);
      if (info.inNyxOS) return { tmuxName: info.inNyxOS, tool: req.tool, sessionId: req.sessionId, startedMs: 0 };
      const current = info.processes.map((p) => p.pid);
      if (current.length > 0) {
        const confirmed = new Set(req.endPids);
        if (confirmed.size === 0) throw new RpcError(t("An dieser Session arbeitet noch ein anderes Fenster"), TERM_ERR.processRunning);
        // Freigegeben ist nur, was der Dialog gezeigt hat: dieselbe PID UND dieselbe Startzeit (sonst ist es ein
        // anderer Prozess, der die Nummer geerbt hat — oder es gab gar keine Vorschau dieser Brücke).
        const shown = this.previews.get(key);
        const fresh = shown !== undefined && Date.now() - shown.at <= PREVIEW_TTL_MS;
        const same = (pid: number) => fresh && confirmed.has(pid) && shown?.procs.get(pid) === starts.get(pid);
        if (!current.every(same)) throw new RpcError(t("Am alten Fenster hat sich etwas geändert"), TERM_ERR.processChanged);
        this.previews.delete(key);
        for (const pid of current) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // schon weg
          }
        }
        this.o.log("terminal-uebernahme-beende", { tool: req.tool, sessionId: req.sessionId, pids: current });
        const gone = await waitUntil(() => current.every((pid) => !pidAlive(pid)), this.o.endWaitMs ?? 8000);
        if (!gone) throw new RpcError(t("Das alte Fenster hat sich nicht beendet"), TERM_ERR.processStuck);
      }
      const started = await this.resume(req);
      this.o.log("terminal-uebernommen", { tool: req.tool, sessionId: req.sessionId, tmuxName: started.tmuxName, beendet: current.length });
      return started;
    } finally {
      this.takingOver.delete(key);
    }
  }

  /**
   * „Prozess beenden". In unserer tmux: die tmux-Session schließen. Sonst (nur Claude) per SIGTERM — aber
   * Nur, was `inspectSession` als echtes Claude erkennt (ps-Programm, PID > 1, nicht die Brücke)
   * UND dessen Startzeit zum Register passt (sonst ist es ein anderer Prozess mit geerbter PID). Direkt vor dem
   * Signal wird die Startzeit noch einmal gelesen. Nie SIGKILL, nie eine andere PID.
   */
  async kill(req: ReturnType<typeof KillRequestSchema.parse>): Promise<{ killed: boolean; via: "tmux" | "signal" }> {
    if (req.tmuxName && (await this.o.tmux.hasSession(req.tmuxName))) {
      await this.o.tmux.killSession(req.tmuxName);
      return { killed: true, via: "tmux" };
    }
    if (req.tool === "claude") {
      const { info, starts } = await this.inspectSession(req);
      if (info.inNyxOS) {
        await this.o.tmux.killSession(info.inNyxOS);
        return { killed: true, via: "tmux" };
      }
      for (const { pid } of info.processes) {
        const psStart = starts.get(pid);
        const rec = (await this.o.sessionStart?.(req.tool, req.sessionId, pid)) ?? null;
        if (psStart === undefined || !sameStart(psStart, rec)) {
          this.o.log("terminal-beenden-verweigert", { tool: req.tool, sessionId: req.sessionId, pid, grund: rec ? "andere Startzeit" : "keine Startzeit im Register" });
          continue;
        }
        const now = (await (this.o.processTable ?? processTable)()).get(pid);
        if (now?.startMs !== psStart) continue; // gerade beendet oder PID neu vergeben
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          continue; // schon weg
        }
        this.o.log("terminal-beende", { tool: req.tool, sessionId: req.sessionId, pid });
        return { killed: true, via: "signal" };
      }
    }
    throw new RpcError(t("Kein laufender Prozess gefunden"), TERM_ERR.notFound);
  }

  /**
   * Text in eine Session senden. Zwei Quellen (FX2a): der Hook-Zustand vom Server (Runde offen =
   * Arbeitet, auch ohne Spinner) UND der Bildschirm. Der Bildschirm wird IMMER geprüft —
   * auch ein älterer Server mit `onlyWhenWaiting: false` tippt nie in eine offene Freigabe-Frage, in
   * angefangenen Text des Nutzers oder ein Menü; `false` erlaubt nur noch „arbeitet“ (Claudes eigene Schlange).
   */
  async sendText(req: ReturnType<typeof SendTextRequestSchema.parse>): Promise<{ sent: boolean; reason?: string }> {
    if (!(await this.o.tmux.hasSession(req.tmuxName))) throw new RpcError(t("tmux-Session gibt es nicht"), TERM_ERR.notFound);
    if (req.onlyWhenWaiting && req.hookWaiting === false) return { sent: false, reason: notIdleReason("working") };
    const state = promptState(toolOf(req.tmuxName), await this.o.tmux.capture(req.tmuxName, 0, true));
    if (state !== "idle" && !(state === "working" && !req.onlyWhenWaiting)) {
      this.o.log("senden-verweigert", { tmux: req.tmuxName, state });
      return { sent: false, reason: notIdleReason(state) };
    }
    await this.o.tmux.sendText(req.tmuxName, req.text, req.submit);
    return { sent: true };
  }

  /**
   * Chat-Anhänge ablegen. Ordner je Session (`<tool>-<id>`, nur für den Nutzer lesbar), Name
   * harmlos gemacht und mit Zeitstempel versehen (nie überschreiben). Art und Größe prüft schon der
   * Server — hier noch einmal, die Brücke vertraut keinem Pfad und keiner Größe von außen.
   */
  saveUpload(req: SaveUploadRequest): SaveUploadResult {
    if (!this.o.uploadsDir) throw new RpcError(t("Ablage für Anhänge ist nicht eingerichtet"), "failed");
    const dir = join(this.o.uploadsDir, req.sessionKey.replace(":", "-"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const stamp = new Date(this.o.now?.() ?? Date.now()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
    return {
      files: req.files.map((f, i) => {
        if (!chatFileAllowed(f.name)) throw new RpcError(t("Dateiart nicht erlaubt: {name}", { name: f.name }), "failed");
        if (base64Bytes(f.dataBase64) > CHAT_MAX_FILE_BYTES) throw new RpcError(t("Datei zu groß: {name}", { name: f.name }), "failed");
        const name = safeUploadName(f.name);
        let path = join(dir, `${stamp}-${i}-${name}`);
        for (let n = 2; existsSync(path); n++) path = join(dir, `${stamp}-${i}-${n}-${name}`);
        const data = Buffer.from(f.dataBase64, "base64");
        writeFileSync(path, data, { mode: 0o600, flag: "wx" });
        return { name, path, bytes: data.length };
      }),
    };
  }

  /**
   * Nachricht aus dem Session-Chat einfügen — so, wie der Nutzer es im Terminal täte: jeder
   * Bildpfad als eigenes Einfügen (Claude Code macht daraus „[Image #n]“), der Text als EIN Einfügen
   * (mehrzeilig bleibt ein Prompt), dann Enter. Nie bei offener Freigabe-Frage: Text oder Enter
   * könnten dort eine Auswahl treffen. Arbeitet die Session, nimmt Claude die Nachricht in seine
   * Warteschlange (`busy: true`).
   */
  async sendMessage(req: SendMessageRequest): Promise<SendMessageResult> {
    if (!(await this.o.tmux.hasSession(req.tmuxName))) throw new RpcError(t("tmux-Session gibt es nicht"), TERM_ERR.notFound);
    const tool = toolOf(req.tmuxName);
    const state = promptState(tool, await this.o.tmux.capture(req.tmuxName, 0, true));
    if (state === "dialog") {
      return { sent: false, busy: false, reason: t("Die Session wartet gerade auf eine Freigabe. Beantworte sie zuerst im Terminal, dann schick die Nachricht noch einmal.") };
    }
    // Nie an angefangenen Text des Nutzers anhängen, nie Text + Enter in ein Menü schicken.
    if (state === "typed" || state === "unknown") return { sent: false, busy: false, reason: notIdleReason(state) };
    // „sofort“ nur, wenn Bildschirm UND Hook-Zustand (falls vom Server mitgeschickt) „wartet“ sagen.
    const busy = state === "working" || req.hookWaiting === false;
    // Server mit Zustell-Warteschlange — nicht in Claudes Schlange einfügen, sondern „busy“ melden.
    if (busy && req.onlyWhenIdle) return { sent: false, busy: true, reason: notIdleReason("working") };
    for (const image of req.images) await this.o.tmux.paste(req.tmuxName, sanitizePasteText(image));
    // Claude liest das Bild beim Einfügen ein — kurz Luft lassen, bevor Enter kommt.
    if (req.images.length > 0) await new Promise((r) => setTimeout(r, IMAGE_SETTLE_MS));
    const text = sanitizePasteText(req.text);
    if (text) await this.o.tmux.paste(req.tmuxName, req.images.length > 0 ? ` ${text}` : text);
    await this.o.tmux.enter(req.tmuxName);
    this.o.log("chat-nachricht", { tmux: req.tmuxName, images: req.images.length, chars: text.length, busy });
    return { sent: true, busy };
  }

  /**
   * „Pausieren“: ein Esc — Claude/Codex brechen die laufende Runde ab und warten dann.
   * Esc ist die Ausnahme der Senden-Regel — es soll ja gerade eine ARBEITENDE Session
   * treffen. Aber nie bei offener Freigabe-Frage (Esc lehnt dort ab, ohne dass der Nutzer entschieden
   * hat), nie bei angefangenem Text (Esc/Doppel-Esc leert ihn bzw. öffnet das Zurückspulen), nie ohne
   * erkennbare Eingabe (Menü). Wartet sie schon, gibt es nichts zu pausieren.
   */
  async interrupt(tmuxName: string): Promise<{ interrupted: boolean; reason?: string }> {
    if (!(await this.o.tmux.hasSession(tmuxName))) throw new RpcError(t("tmux-Session gibt es nicht"), TERM_ERR.notFound);
    const state = promptState(toolOf(tmuxName), await this.o.tmux.capture(tmuxName, 0, true));
    if (state === "idle") return { interrupted: false, reason: t("Die Session wartet schon auf dich – da gibt es nichts zu pausieren.") };
    if (state !== "working") return { interrupted: false, reason: notIdleReason(state) };
    await this.o.tmux.sendKey(tmuxName, "Escape");
    return { interrupted: true };
  }

  /** Ordner für „Neue Session“: jeder Projektordner, seine Unterordner und die Worktrees seiner Repos. */
  listFolders(): { label: string; path: string }[] {
    const out: { label: string; path: string }[] = [];
    const seen = new Set<string>();
    const add = (label: string, path: string) => {
      if (out.length >= LIST_FOLDERS_MAX || seen.has(path)) return;
      try {
        if (!statSync(path).isDirectory()) return;
      } catch {
        return; // fehlt
      }
      seen.add(path);
      out.push({ label, path });
    };
    const subdirs = (dir: string) => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && e.name !== "node_modules")
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
      } catch {
        return [];
      }
    };
    const roots = this.o.projectRoots.length > 0 ? this.o.projectRoots : [homedir()];
    for (const root of roots) {
      const rootLabel = root === homedir() ? "~" : basename(root);
      add(rootLabel, root);
      for (const name of subdirs(root)) {
        const dir = join(root, name);
        add(`${rootLabel}/${name}`, dir);
        for (const wt of subdirs(join(dir, WORKTREE_DIR))) add(t("Worktree {name}", { name: `${name}/${wt}` }), join(dir, WORKTREE_DIR, wt));
      }
      for (const wt of subdirs(join(root, WORKTREE_DIR))) add(t("Worktree {name}", { name: wt }), join(root, WORKTREE_DIR, wt));
    }
    return out;
  }

  // ── Zuordnung tmux ↔ Session ──────────────────────────────────────────────────────────────

  /** Einmal je Takt: welche Session läuft in welcher tmux-Session, wartet der Bildschirm? Liefert nur Änderungen. */
  async mappingTick(): Promise<IngestItem[]> {
    const panes = await this.o.tmux.listPanes();
    const now = new Date(this.o.now?.() ?? Date.now()).toISOString();
    const current = new Map<string, Mapped>();
    if (panes.length > 0) {
      const tree = await processTree();
      const claudePids = await this.o.claudePids();
      for (const p of panes) {
        const tool = toolOfTmuxName(p.name);
        if (!tool) continue; // Server-SSH o. Ä.: keine Werkzeug-Session
        let sessionId: string | null = null;
        const pids = descendants(tree, p.panePid);
        if (tool === "claude") {
          for (const pid of pids) {
            const sid = claudePids.get(pid);
            if (sid) {
              sessionId = sid;
              break;
            }
          }
          sessionId ??= this.startedIds.get(p.name)?.sessionId ?? null;
        } else {
          sessionId = (await codexSessionOf(pids)) ?? this.startedIds.get(p.name)?.sessionId ?? null;
        }
        if (!sessionId) continue;
        const waiting = await this.o.tmux
          .capture(p.name)
          .then((screen) => screenWaiting(tool, screen).waiting)
          .catch(() => null);
        current.set(`${tool}:${sessionId}`, { tool, sessionId, tmuxName: p.name, attachable: true, screenWaiting: waiting });
      }
    }
    for (const name of this.startedIds.keys()) if (!panes.some((p) => p.name === name)) this.startedIds.delete(name);
    const items: IngestItem[] = [];
    const emit = (m: Mapped) => {
      const info: TerminalInfo = { tool: m.tool, sessionId: m.sessionId, tmuxName: m.tmuxName, attachable: m.attachable, screenWaiting: m.screenWaiting, observedAt: now };
      items.push({ type: "terminal", terminal: info });
    };
    for (const [key, m] of current) {
      const prev = this.reported.get(key);
      if (!prev || prev.tmuxName !== m.tmuxName || prev.attachable !== m.attachable || prev.screenWaiting !== m.screenWaiting) emit(m);
      this.reported.set(key, m);
    }
    for (const [key, prev] of this.reported) {
      if (current.has(key)) continue;
      if (prev.attachable) emit({ ...prev, attachable: false, screenWaiting: null });
      this.reported.delete(key);
    }
    return items;
  }
}

/** Die Brücke vertraut dem Server-RPC nicht blind — nur diese Werte
 * dürfen in Umgebung/Argumente eines neu gestarteten Prozesses einfließen. Ein unbekannter
 * Schlüssel oder ein Wert außerhalb des erlaubten Musters lässt den Eintrag STILL verworfen
 * werden (nie geraten/geklemmt) statt den ganzen Start abzulehnen — sonst reicht ein einzelner
 * falscher Wert, um die Session komplett lahmzulegen. */
const AUTOCOMPACT_ENV_KEY = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
const AUTOCOMPACT_ENV_VALUE_RE = /^(?:[5-9][0-9]|100)$/; // 50–100, keine führende 0/Vorzeichen
const AUTOCOMPACT_ARG_RE = /^model_auto_compact_token_limit=\d+$/;

function sanitizeAutoCompactEnv(env?: Record<string, string> | null): Record<string, string> | undefined {
  if (!env) return undefined;
  const value = env[AUTOCOMPACT_ENV_KEY];
  if (typeof value === "string" && AUTOCOMPACT_ENV_VALUE_RE.test(value)) return { [AUTOCOMPACT_ENV_KEY]: value };
  return undefined;
}

/** Codex `-c model_auto_compact_token_limit=<n>` — nur exakt dieses eine Paar, sonst leer. */
function sanitizeAutoCompactArgs(args?: string[] | null): string[] {
  if (args && args.length === 2 && args[0] === "-c" && AUTOCOMPACT_ARG_RE.test(args[1] ?? "")) return args;
  return [];
}

/**
 * Eingabe-Aufforderung ohne laufende Arbeit (für „nur senden, wenn sie wartet").
 * Menüzeilen („❯ 1. Yes"), Rechte-Abfragen und halb getippter Text zählen
 * nie als wartend — sonst bestätigt `/compact` + Enter versehentlich ein Freigabe-Menü.
 * Nicht mehr nur die letzte Zeile — der Eingabe-Block unten zählt (Trennlinie + Statuszeilen
 * darunter, grauer Vorschlag in der Eingabe). Details: `prompt.ts`.
 */
export function isIdlePrompt(tool: Tool, screen: string): boolean {
  return promptState(tool, screen) === "idle";
}

type Tree = Map<number, number[]>;
type ProcTable = Map<number, { ppid: number; comm: string; startMs: number | null }>;

/** Wie lange eine Dialog-Vorschau als Freigabe-Grundlage gilt (danach: noch einmal nachsehen). */
const PREVIEW_TTL_MS = 10 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(fn: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

/** Alle Prozesse mit Eltern-PID, Startzeit und Programm (für „wo läuft das alte Fenster?“, „in unserer tmux?“
 * und „ist das noch derselbe Prozess?“). `lstart` ist fest 24 Zeichen lang („Fri Sep  5 13:37:12 2026“). */
async function processTable(): Promise<ProcTable> {
  try {
    // `-A` = alle Prozesse, gleich in macOS-ps und procps (Linux); `lstart` ist dort ebenfalls 24 Zeichen lang.
    const { stdout } = await run(psBin(), ["-Ao", "pid=,ppid=,lstart=,comm="], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    return parseProcessTable(stdout);
  } catch {
    return new Map(); // ps fehlt → leer (dann wird auch nichts beendet)
  }
}

export function parseProcessTable(stdout: string): ProcTable {
  const table: ProcTable = new Map();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const start = Date.parse(m[3] ?? "");
    table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[4] ?? "", startMs: Number.isNaN(start) ? null : start });
  }
  return table;
}

/**
 * Ist dieser Prozess wirklich Claude bzw. Codex? `comm` (bei macOS-`ps` das aufgerufene Programm)
 * heißt `claude`/`codex`; läuft das Werkzeug unter `node`/`bun`, zählt die Befehlszeile. Alles andere (Editor,
 * `tail`, ein Programm mit geerbter PID) ist es nicht.
 */
export function looksLikeTool(tool: Tool, comm: string, args: string | null): boolean {
  const base = comm.split("/").pop() ?? "";
  if (base === tool) return true;
  if ((base !== "node" && base !== "bun") || !args) return false;
  return tool === "claude" ? /@anthropic-ai\/claude-code\/|\/claude(\.m?js|\.cjs)?(\s|$)/.test(args) : /@openai\/codex\/|\/codex(\.m?js|\.cjs)?(\s|$)/.test(args);
}

async function isToolProcess(tool: Tool, pid: number, comm: string): Promise<boolean> {
  if (looksLikeTool(tool, comm, null)) return true;
  const base = comm.split("/").pop() ?? "";
  if (base !== "node" && base !== "bun") return false;
  try {
    const { stdout } = await run(psBin(), ["-o", "args=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } });
    return looksLikeTool(tool, comm, stdout.trim());
  } catch {
    return false;
  }
}

function isDescendant(table: ProcTable, pid: number, ancestor: number): boolean {
  let cur: number | undefined = pid;
  for (let i = 0; cur && i < 64; i++) {
    if (cur === ancestor) return true;
    cur = table.get(cur)?.ppid;
  }
  return false;
}

/** Programme, in denen der Nutzer Claude/Codex startet — erkannt am Pfad eines Vorfahren-Prozesses (macOS). */
const APPS: [RegExp, string][] = [
  [/\/Terminal\.app\//, "Terminal"],
  [/\/iTerm2?\.app\//, "iTerm"],
  [/\/Visual Studio Code[^/]*\.app\//, "VS Code"],
  [/\/Cursor\.app\//, "Cursor"],
  [/\/Ghostty\.app\//i, "Ghostty"],
  [/\/Warp\.app\//, "Warp"],
  [/\/Claude\.app\//, "Claude-App"],
];

/** In welchem Programm läuft dieser Prozess? (erster passender Vorfahre, sonst null) */
export function appOf(table: ReadonlyMap<number, { ppid: number; comm: string }>, pid: number): string | null {
  let cur: number | undefined = pid;
  for (let i = 0; cur && i < 64; i++) {
    const row = table.get(cur);
    if (!row) return null;
    for (const [re, label] of APPS) if (re.test(row.comm)) return label;
    cur = row.ppid;
  }
  return null;
}

async function processTree(): Promise<Tree> {
  const tree: Tree = new Map();
  try {
    const { stdout } = await run(psBin(), ["-Ao", "pid=,ppid="]);
    for (const line of stdout.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid || ppid === undefined) continue;
      const list = tree.get(ppid) ?? [];
      list.push(pid);
      tree.set(ppid, list);
    }
  } catch {
    // ps fehlt → leerer Baum
  }
  return tree;
}

export function descendants(tree: Tree, root: number): number[] {
  const out = [root];
  for (let i = 0; i < out.length && out.length < 200; i++) out.push(...(tree.get(out[i] as number) ?? []));
  return out;
}

/** Codex führt kein pid-Register: die offene Rollout-Datei eines Prozesses verrät die Session. */
async function codexSessionOf(pids: number[]): Promise<string | null> {
  if (pids.length === 0) return null;
  const lsof = findBin("lsof");
  if (!lsof && IS_LINUX) {
    // Linux ohne lsof: offene Dateien direkt aus /proc/<pid>/fd.
    for (const pid of pids) {
      let fds: string[];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        let target: string;
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        if (!target.includes("/.codex/sessions/")) continue;
        const id = codexSessionIdFromPath(target);
        if (id) return id;
      }
    }
    return null;
  }
  try {
    const { stdout } = await run(lsof ?? "/usr/sbin/lsof", ["-Fn", "-p", pids.join(",")]);
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("n") || !line.includes("/.codex/sessions/")) continue;
      const id = codexSessionIdFromPath(line.slice(1));
      if (id) return id;
    }
  } catch {
    // lsof: Exit 1 = nichts offen
  }
  return null;
}

/** Höchstens so viele Einträge in der Ordner-Auswahl. */
const LIST_FOLDERS_MAX = 300;

/** `ps` aus dem PATH (macOS: /bin/ps, Linux: procps). */
function psBin(): string {
  return findBin("ps") ?? "ps";
}

/** Hauptzweig eines Repos (`main`, sonst `master`, sonst der aktuelle Stand). */
async function mainBranchOf(repo: string): Promise<string> {
  for (const b of ["main", "master"]) {
    try {
      await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { cwd: repo });
      return b;
    } catch {
      // nächster Kandidat
    }
  }
  return "HEAD";
}

/**
 * `.worktrees/` in `.git/info/exclude` eintragen (lokal, ändert keine versionierte Datei) — sonst erschiene der
 * Ordner mit allen Arbeitskopien im Hauptrepo als „ungesichert“.
 */
async function excludeWorktreeDir(repo: string): Promise<void> {
  try {
    const rel = (await run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repo })).stdout.trim();
    const file = rel.startsWith("/") ? rel : join(repo, rel);
    const line = `/${WORKTREE_DIR}/`;
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // Datei fehlt noch
    }
    if (current.split("\n").some((l) => l.trim() === line)) return;
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
  } catch {
    // nur Komfort: ohne Eintrag funktioniert alles, der Ordner wird bloß als ungesichert angezeigt
  }
}
