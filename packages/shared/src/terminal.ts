// Terminal: gemeinsame Typen für Browser ↔ Server (`WS /terminal/:id`) und Server ↔ Brücke
// (`WS /bridge`). Nur Daten, keine Logik mit Nebenwirkungen — die Brücke (Bun-Binary), der Server
// (Node) und die Web-App importieren dieselben Schemas.
import { z } from "zod";
import { t } from "./i18n/index.js";
import { UsageReadingsMsgSchema } from "./usage-readings.js";

/** Eigene Kopie von `ToolSchema` (events.ts importiert diese Datei — kein Import-Kreis). */
const ToolSchema = z.enum(["claude", "codex"]);

/** tmux-Session-Name der NyxOS: `zc-<werkzeug>-<kurz-id>` (nur Kleinbuchstaben/Ziffern). Alles andere
 * wird nie an tmux weitergereicht — Schutz gegen Befehlsinjektion über Zielnamen. */
export const TMUX_NAME_RE = /^zc-(claude|codex)-[a-z0-9]{4,16}$/;
export const TmuxNameSchema = z.string().regex(TMUX_NAME_RE);

// ── Server-SSH (Terminal zu einem eigenen Server) ───────────────────────────────────────────────
// Eigene Terminal-Art: eine tmux-Session `zc-ssh-<kurz-id>` auf dem Rechner mit GENAU dem festen Befehl
// `ssh -t <host>`. Der Host kommt nur aus der Einstellung `NYXOS_SERVER_SSH_HOST` des Servers (z. B. ein
// Host-Alias aus ~/.ssh/config) — nie aus einer Anfrage des Browsers. Ohne Einstellung ist die Funktion aus.
// Bewusst NICHT in TMUX_NAME_RE: alles, was Sessions zählt, zuordnet, archiviert oder Text hineinschickt
// (Chat, /compact, Esc), prüft TMUX_NAME_RE und lässt die ssh-Sitzung damit von selbst aus. Nur das
// Anhängen (Kanal `open`) und die drei festen Befehle `ssh_start`/`ssh_status`/`ssh_stop` kennen sie.
export const SSH_TMUX_NAME_RE = /^zc-ssh-[a-z0-9]{4,16}$/;
export const SshTmuxNameSchema = z.string().regex(SSH_TMUX_NAME_RE);
/** Jede tmux-Session, an die ein Browser-Kanal andocken darf (Werkzeug-Sessions + Server-SSH). */
export const isAttachableTmuxName = (name: string) => TMUX_NAME_RE.test(name) || SSH_TMUX_NAME_RE.test(name);
export const AttachTmuxNameSchema = z.string().refine(isAttachableTmuxName, { error: () => t("Ungültiger tmux-Name") });
/** Erlaubte Form eines SSH-Ziels: Host-Alias, Hostname oder `user@host` — nie mit `-` am Anfang (kein
 * Schalter für ssh), keine Leerzeichen, keine Shell-Zeichen. */
export const SSH_HOST_RE = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;
export const SshHostSchema = z.string().regex(SSH_HOST_RE);
/** SSH-Ziel aus der Umgebung (`NYXOS_SERVER_SSH_HOST`); `null` = nicht eingerichtet oder ungültig (Funktion aus). */
export function serverSshHost(env: Record<string, string | undefined>): string | null {
  const raw = env.NYXOS_SERVER_SSH_HOST?.trim();
  return raw && SSH_HOST_RE.test(raw) ? raw : null;
}
/** Höchstens so viele ssh-Sitzungen gleichzeitig (eine bestehende wird wiederverwendet). */
export const SERVER_SSH_MAX = 1;
/** Fähigkeit im `hello` der Brücke — ältere Brücken kennen die ssh-Befehle nicht. */
export const BRIDGE_CAP_SERVER_SSH = "server_ssh";

export const TERM_MIN_COLS = 20;
export const TERM_MAX_COLS = 500;
export const TERM_MIN_ROWS = 5;
export const TERM_MAX_ROWS = 200;
/** Verlauf, der beim Öffnen mitkommt (Zeilen oberhalb des sichtbaren Bildschirms). */
export const TERM_SNAPSHOT_HISTORY = 5000;
/** Obergrenze für eine einzelne Eingabe-Nachricht (Einfügen großer Texte wird gestückelt). */
export const TERM_MAX_INPUT = 64 * 1024;

const Cols = z.number().int().min(TERM_MIN_COLS).max(TERM_MAX_COLS);
const Rows = z.number().int().min(TERM_MIN_ROWS).max(TERM_MAX_ROWS);

/** Server-SSH starten (oder die laufende wiederverwenden). Nur die Feldgröße — kein Befehl, kein Host. */
export const SshStartRequestSchema = z.object({ cols: Cols.default(120), rows: Rows.default(36) }).strict();
export type SshStartRequest = z.infer<typeof SshStartRequestSchema>;
/** RPC `ssh_start` vom Server an die Brücke: Feldgröße plus das eingestellte SSH-Ziel (`serverSshHost`). */
export const SshStartRpcSchema = z.object({ cols: Cols, rows: Rows, host: SshHostSchema }).strict();
export type SshStartRpc = z.infer<typeof SshStartRpcSchema>;
/** `ssh_status` / `ssh_stop`: keine Parameter. */
export const SshEmptyRequestSchema = z.object({}).strict();
export interface SshStatusResult {
  running: boolean;
  tmuxName: string | null;
}
export interface SshStartResult {
  tmuxName: string;
  /** true = es lief schon eine, die wird weiterverwendet. */
  reused: boolean;
}
export interface SshStopResult {
  stopped: number;
}

/** Browser → Server. */
export const TermClientMsgSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("in"), d: z.string().min(1).max(TERM_MAX_INPUT) }),
  z.object({ t: z.literal("resize"), cols: Cols, rows: Rows }),
  /** Messung Tastendruck → Echo: der Server antwortet sofort mit `pong` (reine Leitungszeit). */
  z.object({ t: z.literal("ping"), id: z.number() }),
]);
export type TermClientMsg = z.infer<typeof TermClientMsgSchema>;

export type TermStatus = "connected" | "bridge_offline" | "ended" | "error" | "not_attachable";

/** Server → Browser. */
export type TermServerMsg =
  | { t: "snapshot"; d: string; cols: number; rows: number; cursor: { x: number; y: number }; readOnly: boolean }
  | { t: "out"; d: string }
  | { t: "size"; cols: number; rows: number }
  | { t: "status"; s: TermStatus; msg?: string }
  | { t: "pong"; id: number };

// ── Server ↔ Brücke ────────────────────────────────────────────────────────────────────────────

/** Modell-Name/Alias, nur harmlose Zeichen (landet als eigenes Argument, nie in einer Shell) — MUSS
 * mit einem Buchstaben/einer Ziffer beginnen (ein führendes `-` ließe sich als
 * Kommandozeilen-OPTION statt als Wert lesen, z. B. `--dangerously-skip-permissions`). Von
 * `apps/server/src/entries/start.ts`/`routes/entries.ts` als Whitelist für `model`/`modelSuggestion`
 * wiederverwendet — dieselbe Regel, ein Ort. */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

export const StartRequestSchema = z.object({
  tool: ToolSchema,
  model: z.string().regex(MODEL_NAME_RE).nullable().default(null),
  /** Arbeitsordner, absolut; die Brücke prüft zusätzlich, dass er unter dem Projektordner liegt. */
  cwd: z.string().min(1).max(1000),
  prompt: z.string().max(20_000).nullable().default(null),
  cols: Cols.default(120),
  rows: Rows.default(36),
  /** Start-Kette: Auftrags-Session → Leitplanken-Hook per `--settings`, Umgebung NYXOS_AUFTRAG/
   * NYXOS_WORKTREE, autonomer Modus. Nur Claude. Ohne Angabe: normale Session (des Nutzers eigene). */
  auftrag: z
    .object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/), worktree: z.string().min(1).max(1000) })
    .nullish(),
  /** Kontext-Wächter: zusätzliche Umgebungsvariablen für den neuen Prozess (Claude:
   * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`), vom Server aus der aufgelösten Erzwingen-Schwelle
   * berechnet — die Brücke kennt keine Schwellen, sie setzt nur, was ankommt. */
  autoCompactEnv: z.record(z.string(), z.string()).nullable().default(null),
  /** zusätzliche CLI-Argumente VOR Modell/Prompt (Codex: `-c model_auto_compact_token_limit=<n>`). */
  autoCompactArgs: z.array(z.string()).nullable().default(null),
  /** zusätzliche Ordner (`claude --add-dir`), z. B. `~/.claude/skills` für Skill-Aufträge. Die Brücke
   * lässt nur ihre eigenen Skill-Wurzeln zu (s. `apps/bridge/src/skills.ts`). Nur Claude. */
  addDirs: z.array(z.string().min(1).max(1000)).max(4).nullish(),
});
export type StartRequest = z.infer<typeof StartRequestSchema>;

/** Session-ID, wie sie an `claude --resume <id>` / `codex resume <id>` geht. Kritik D-c: nie mit „-“ vorne —
 * sonst läse das Programm sie als Schalter (z. B. `--dangerously-skip-permissions`). */
export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/);

export const ResumeRequestSchema = z.object({
  tool: ToolSchema,
  sessionId: SessionIdSchema,
  cwd: z.string().min(1).max(1000).nullable(),
  cols: Cols.default(120),
  rows: Rows.default(36),
  autoCompactEnv: z.record(z.string(), z.string()).nullable().default(null),
  autoCompactArgs: z.array(z.string()).nullable().default(null),
});
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

/** „In der NyxOS übernehmen" — erst nachsehen, was an der Session hängt (für den Dialog). */
export const TakeoverInfoRequestSchema = z.object({
  tool: ToolSchema,
  sessionId: SessionIdSchema,
});
export type TakeoverInfoRequest = z.infer<typeof TakeoverInfoRequestSchema>;

/** Ein Programm (Claude/Codex), das gerade an der Session arbeitet — außerhalb der NyxOS. */
export interface TakeoverProcess {
  pid: number;
  /** Wo es läuft, so weit erkennbar: „Terminal", „iTerm", „VS Code" … (null = unbekanntes Fenster). */
  app: string | null;
}

export interface TakeoverInfo {
  /** Programme außerhalb der NyxOS an dieser Session (leer = läuft nirgends, einfach fortsetzen). */
  processes: TakeoverProcess[];
  /** Läuft sie schon in der NyxOS (eigener tmux-Socket)? Dann deren Name, sonst null. */
  inNyxOS: string | null;
}

/** Übernehmen. `endPids` = GENAU die Programme, die der Nutzer im Dialog gesehen und zum Beenden
 * freigegeben hat. Die Brücke beendet nie etwas anderes; hängt inzwischen ein anderes Programm an der
 * Session, bricht sie mit `process_changed` ab. */
export const TakeoverRequestSchema = ResumeRequestSchema.extend({
  endPids: z.array(z.number().int().positive()).max(8).default([]),
});
export type TakeoverRequest = z.infer<typeof TakeoverRequestSchema>;

export const KillRequestSchema = z.object({
  tool: ToolSchema,
  sessionId: SessionIdSchema,
  tmuxName: TmuxNameSchema.nullable(),
});
export type KillRequest = z.infer<typeof KillRequestSchema>;

/** W-1-Vorbereitung: Text in eine Session schicken, sobald sie wartet (z. B. `/compact`). */
export const SendTextRequestSchema = z.object({
  tmuxName: TmuxNameSchema,
  text: z.string().min(1).max(TERM_MAX_INPUT),
  /** Enter hinterher senden. */
  submit: z.boolean().default(true),
  /** Nur senden, wenn die Session gerade auf Eingabe wartet; sonst `{ sent: false }`. */
  onlyWhenWaiting: z.boolean().default(true),
  /** Zustand laut Hooks (Server): `false` = Runde offen → nie senden. Fehlt bei älteren Servern. */
  hookWaiting: z.boolean().optional(),
});
export type SendTextRequest = z.infer<typeof SendTextRequestSchema>;

/** „Beide pausieren“: einmal Esc in die tmux-Session (Claude/Codex brechen die laufende
 * Runde ab und warten dann auf Eingabe). Geht nur bei Sessions, die in tmux laufen. */
export const InterruptRequestSchema = z.object({ tmuxName: TmuxNameSchema });
export type InterruptRequest = z.infer<typeof InterruptRequestSchema>;

/** Git-Stand-Name für den Vergleich: Commit, Zweig, `HEAD~2` … — nie mit `-` am Anfang (keine Optionen). */
export const GitRefSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._/~^-]{0,119}$/);

/** NUR LESEND — `git log`/`git diff` für eine Datei (oder einen Ordner) unter dem Projektordner.
 * `from` fehlt → nur die letzten Commits. `to` fehlt → Vergleich mit der Arbeitskopie. */
export const GitCompareRequestSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith("/"), { error: () => t("absoluter Pfad nötig") })
    // keine „.“/„..“-Teile, keine Steuerzeichen — der Pfad wird nie „weggerechnet“.
    .refine((p) => !p.split("/").some((seg) => seg === ".." || seg === "."), { error: () => t("kein .. im Pfad") })
    // eslint-disable-next-line no-control-regex -- Steuerzeichen im Pfad gezielt ablehnen
    .refine((p) => !/[\u0000-\u001f]/.test(p), { error: () => t("keine Steuerzeichen") }),
  from: GitRefSchema.optional(),
  to: GitRefSchema.optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export type GitCompareRequest = z.infer<typeof GitCompareRequestSchema>;

export interface GitCompareRawResult {
  repoRoot: string;
  relPath: string;
  commits: { sha: string; short: string; author: string; at: string; subject: string }[];
  diff: string | null;
  truncated: boolean;
  /** Datei ist in keinem Commit (neu, noch nicht hinzugefügt). */
  untracked?: boolean;
}

/** Ein-Klick-Start (`entries/start.ts`, `haiku/auftrag.ts`): den Git-Worktree legt die Brücke an. Sie
 * berechnet den Pfad SELBST (nie einen vom Server gelieferten Pfad übernehmen): `anchor` ist ein Pfad
 * relativ zum Projektordner (z. B. die GOAL.md des Auftrags oder ein Ordner aus dem Dateibereich, `""` =
 * der Projektordner selbst). Die Brücke sucht das Git-Repo, in dem der Anker liegt (per realpath innerhalb
 * eines Projektordners), und legt den Worktree unter `<repo>/.worktrees/<slug>` an (`WORKTREE_DIR` in
 * git.ts), s. `apps/bridge/src/terminal/manager.ts`. */
export const SlugSchema = z.string().regex(/^[a-z0-9-]{1,60}$/);

/** Repo-relativer Anker: kein absoluter Pfad, kein `..`, keine leeren Teile, kein Backslash. */
export const WorktreeAnchorSchema = z
  .string()
  .max(500)
  .refine((p) => p === "" || (!p.startsWith("/") && !p.includes("\\") && p.split("/").every((part) => part !== "" && part !== "." && part !== "..")), { error: () => t("Ungültiger Anker") });

export const WorktreeAddRequestSchema = z.object({
  anchor: WorktreeAnchorSchema,
  slug: SlugSchema,
  /** Zweigname, den `git worktree add -b <branch>` anlegt. */
  branch: z.string().regex(/^auftrag\/[a-z0-9-]{1,60}$/),
});
export type WorktreeAddRequest = z.infer<typeof WorktreeAddRequestSchema>;

export interface WorktreeAddResult {
  /** Wurzel des Git-Repos, in dem der Anker liegt (absolut, auf dem Rechner der Brücke). */
  repoRoot: string;
  /** `<repoRoot>/.worktrees/<slug>` (absolut). */
  worktreePath: string;
  branch: string;
  /** Pfad des Ankers relativ zu `repoRoot` (z. B. `docs/auth/GOAL.md`), `null` = Anker ist die Repo-Wurzel. */
  anchorInRepo?: string | null;
  /** true = der Worktree mit diesem Zweig bestand schon (unterbrochener Start) und wird weiterverwendet. */
  reused?: boolean;
}

/** Nyx-Faden als Notiz in den Obsidian-Vault. Die Brücke berechnet den Pfad SELBST (fester
 * Ordner unter dem Vault, harmloser Dateiname aus `day` + `title`) und überschreibt nie. */
export const BRIDGE_CAP_VAULT_NOTE = "vault_note";
export const VAULT_NOTE_MAX_BYTES = 512 * 1024;
export const VaultNoteRequestSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(200),
  markdown: z.string().min(1).max(VAULT_NOTE_MAX_BYTES),
});
export type VaultNoteRequest = z.infer<typeof VaultNoteRequestSchema>;
export interface VaultNoteResult {
  /** Pfad relativ zum Vault, z. B. `01 Sessions/Nyx/2026-09-25 Nyx – Titel.md`. */
  relPath: string;
}

/** `save_upload` (Anhänge ablegen) + `send_message` (Nachricht einfügen), s. session-chat.ts. */
export type BridgeRpcMethod = "start" | "resume" | "kill" | "send_text" | "list_folders" | "worktree_add" | "run_build" | "status" | "interrupt" | "git_compare" | "voice_probe" | "transcribe" | "takeover_info" | "takeover" | "save_upload" | "send_message" | "vault_note" | "http_proxy_local" | "simulator_screenshot" | "skills_list" | "skill_read" | "skill_backup" | "skill_restore" | "finder" | "notify" | "ssh_start" | "ssh_status" | "ssh_stop" | "setup.state" | "setup.apply" | "setup.browse";

export interface StartResult {
  tmuxName: string;
  tool: "claude" | "codex";
  /** Bei Claude vorab vergeben (`--session-id`), bei Codex erst nach dem ersten Schreiben bekannt. */
  sessionId: string | null;
  startedMs: number;
}

/** Server → Brücke. */
export const ServerToBridgeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("open"), ch: z.number().int(), tmuxName: AttachTmuxNameSchema, cols: Cols, rows: Rows, readOnly: z.boolean() }),
  z.object({ op: z.literal("in"), ch: z.number().int(), d: z.string().min(1).max(TERM_MAX_INPUT) }),
  z.object({ op: z.literal("resize"), ch: z.number().int(), cols: Cols, rows: Rows }),
  z.object({ op: z.literal("close"), ch: z.number().int() }),
  z.object({ op: z.literal("pause"), ch: z.number().int() }),
  z.object({ op: z.literal("resume"), ch: z.number().int() }),
  z.object({ op: z.literal("rpc"), id: z.number().int(), method: z.enum(["start", "resume", "kill", "send_text", "list_folders", "worktree_add", "run_build", "status", "interrupt", "git_compare", "voice_probe", "transcribe", "takeover_info", "takeover", "save_upload", "send_message", "vault_note", "http_proxy_local", "simulator_screenshot", "skills_list", "skill_read", "skill_backup", "skill_restore", "finder", "notify", "ssh_start", "ssh_status", "ssh_stop", "setup.state", "setup.apply", "setup.browse"]), params: z.unknown() }),
]);
export type ServerToBridge = z.infer<typeof ServerToBridgeSchema>;

/** Brücke → Server. */
export const BridgeToServerSchema = z.discriminatedUnion("op", [
  // `caps` = Fähigkeiten dieser Brücke (z. B. `run_build`); ältere Brücken schicken keine.
  z.object({ op: z.literal("hello"), version: z.string(), tmuxSocket: z.string(), caps: z.array(z.string().max(40)).max(40).optional() }),
  z.object({
    op: z.literal("snapshot"),
    ch: z.number().int(),
    d: z.string(),
    cols: z.number().int(),
    rows: z.number().int(),
    cursor: z.object({ x: z.number().int(), y: z.number().int() }),
  }),
  z.object({ op: z.literal("out"), ch: z.number().int(), d: z.string() }),
  z.object({ op: z.literal("size"), ch: z.number().int(), cols: z.number().int(), rows: z.number().int() }),
  z.object({ op: z.literal("exit"), ch: z.number().int(), reason: z.string() }),
  // `ms` = Rechenzeit auf dem Rechner (ab Eingang des Befehls), damit der Server langsame Antworten
  // in „Mac rechnet“ und „Weg dorthin und zurück“ aufteilen kann. Ältere Brücken schicken es nicht.
  z.object({ op: z.literal("rpc_result"), id: z.number().int(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional(), code: z.string().optional(), ms: z.number().nonnegative().optional() }),
  // echte Claude-Limits aus CodexBar (nur Zahlen), s. usage-readings.ts.
  UsageReadingsMsgSchema,
]);
export type BridgeToServer = z.infer<typeof BridgeToServerSchema>;

/** Zuordnung tmux ↔ Session, von der Brücke über den normalen Ingest-Puffer gemeldet. */
export const TerminalInfoSchema = z.object({
  tool: ToolSchema,
  sessionId: z.string().min(1).max(100),
  tmuxName: TmuxNameSchema.nullable(),
  attachable: z.boolean(),
  /** Bildschirm zeigt eine Freigabe-Frage/Eingabe-Aufforderung (Zusatzsignal zu den Hooks). */
  screenWaiting: z.boolean().nullable().default(null),
  observedAt: z.iso.datetime({ offset: true }),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

/** Fehlercodes der Start-/Fortsetzen-Sperre, damit die Web-App passende Texte zeigt. */
export const TERM_ERR = {
  processRunning: "process_running",
  badFolder: "bad_folder",
  notFound: "not_found",
  tmuxMissing: "tmux_missing",
  bridgeOffline: "bridge_offline",
  timeout: "timeout",
  /** `worktree_add`: unter diesem Slug gibt es schon einen Worktree — Aufrufer, die einen
   * unterbrochenen Start fortsetzen (z. B. P7 `startAuftrag`), dürfen das als „schon da,
   * weiterverwenden" behandeln statt als Fehler. */
  worktreeExists: "worktree_exists",
  /** am alten Fenster hat sich seit dem Dialog etwas geändert (anderes Programm) → nichts beendet. */
  processChanged: "process_changed",
  /** D-c: das alte Programm hat auf das saubere Beenden (SIGTERM) nicht reagiert → nichts gestartet. */
  processStuck: "process_stuck",
} as const;
