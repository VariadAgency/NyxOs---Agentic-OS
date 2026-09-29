// Leitplanken: der `PreToolUse`-Hook. Läuft NUR für Sessions, die NyxOS gestartet hat
// (Umgebung `NYXOS_AUFTRAG`). Harmlose Befehle: keine Ausgabe, kein Netz. Gefährliche Befehle:
// Server fragen (`POST /guard/check`); nur eine erteilte Freigabe lässt GENAU einen Durchlauf zu.
// Server weg oder Fehler → verweigern (fail closed, aber nur für die Leitplanken-Befehle).
// Zeitgrenze: Claude Code lässt einen Hook, der sein `timeout` (5 s) überschreitet, DURCH (fail-open).
// Deshalb entscheidet der Hook selbst spätestens nach GUARD_DEADLINE_MS (2 s) – und verweigert dann.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GUARD_RULE_LABELS, GuardCheckResultSchema, t, tc, type GuardCheck } from "@nyxos/shared";
import { loadConfig, paths } from "../config.js";
import { classifyCommand, parseProdHosts, type GuardHit } from "./rules.js";

/** Umgebungsvariablen, die die Start-Kette einer NyxOS-Session mitgibt. */
export const GUARD_ENV = { auftrag: "NYXOS_AUFTRAG", worktree: "NYXOS_WORKTREE", config: "NYXOS_BRIDGE_CONFIG" } as const;

export const GUARD_TIMEOUT_MS = 1500;
/** Harte interne Grenze für den ganzen Hook (deutlich unter Claude Codes 5 s, nach denen es durchlässt). */
export const GUARD_DEADLINE_MS = 2000;
export function deadlineText(): string {
  return t("Leitplanke: Die Prüfung dieses Befehls hat zu lange gedauert (über 2 s) – er wurde vorsorglich angehalten. Führe denselben Befehl gleich noch einmal genau so aus; bleibt es dabei, liegt es an der Verbindung zu NyxOS.");
}

export interface GuardDeps {
  fetchImpl?: typeof fetch;
  /** Server-Adresse + Maschinen-Token; Standard: Brücken-Konfiguration (`config.json`). */
  server?: () => { serverUrl: string; token: string };
  timeoutMs?: number;
  /** Tests: interne Gesamt-Zeitgrenze (Standard GUARD_DEADLINE_MS). */
  deadlineMs?: number;
}

export interface GuardOutcome {
  /** Genau das, was der Hook auf stdout schreibt ("" = erlauben). */
  stdout: string;
  hit: GuardHit | null;
  /** Wurde der Server gefragt? (harmlose Befehle: nie) */
  asked: boolean;
  approvalId: number | null;
}

const ALLOW = (hit: GuardHit | null = null, asked = false, approvalId: number | null = null): GuardOutcome => ({ stdout: "", hit, asked, approvalId });

/** Sucht nach oben den Ordner mit `.git` (Datei in Worktrees, Ordner im Haupt-Checkout). Kein git-Prozess. */
export function findGitTop(start: string | null): string | null {
  if (!start) return null;
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    try {
      statSync(join(dir, ".git"));
      return dir;
    } catch {
      // weiter nach oben
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Aktueller Zweig aus der HEAD-Datei (Worktree: `.git`-Datei → `gitdir:` → HEAD). `null` = losgelöst/unbekannt. */
export function readBranch(top: string | null): string | null {
  if (!top) return null;
  try {
    const dotGit = join(top, ".git");
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m?.[1]) return null;
      const p = m[1].trim();
      gitDir = isAbsolute(p) ? p : resolve(top, p);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Produktionsserver: `NYXOS_PROD_HOSTS` der Session plus `prodHosts` aus der Brücken-Konfiguration. */
function prodHostsFor(env: Record<string, string | undefined>): string[] {
  const fromEnv = parseProdHosts(env.NYXOS_PROD_HOSTS);
  try {
    const cfg = loadConfig(env[GUARD_ENV.config] || paths().config);
    return [...fromEnv, ...(cfg.prodHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)];
  } catch {
    return fromEnv;
  }
}

function defaultServer(env: Record<string, string | undefined>): { serverUrl: string; token: string } {
  if (env.NYXOS_SERVER_URL && env.NYXOS_MACHINE_TOKEN) return { serverUrl: env.NYXOS_SERVER_URL, token: env.NYXOS_MACHINE_TOKEN };
  const cfg = loadConfig(env[GUARD_ENV.config] || paths().config);
  return { serverUrl: cfg.serverUrl, token: cfg.token };
}

export function denyJson(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

function denyText(hit: GuardHit, approvalId: number | null, unreachable: string | null): string {
  const was = t("Leitplanke: „{rule}“ ist in NyxOS-Sessions freigabepflichtig. Grund: {reason}.", { rule: GUARD_RULE_LABELS[hit.rule], reason: hit.reason });
  if (unreachable) {
    return `${was} ${t("NyxOS ist gerade nicht erreichbar ({why}), deshalb gibt es noch keine Freigabe-Anfrage. Arbeite an etwas anderem weiter und führe denselben Befehl später genau so erneut aus – dann landet die Anfrage beim Nutzer.", { why: unreachable })}`;
  }
  return `${was} ${t("Freigabe-Anfrage #{id} liegt beim Nutzer (NyxOS → Freigaben). Nach der Freigabe denselben Befehl genau so erneut ausführen; die Freigabe gilt genau einmal. Bis dahin an etwas anderem weiterarbeiten.", { id: approvalId ?? "?" })}`;
}

/**
 * Prüft eine Claude-Code-`PreToolUse`-Eingabe. Wirft nie; im Zweifel (kaputte Eingabe, eigener Fehler)
 * wird ein harmloser Befehl nie blockiert, ein erkannter Leitplanken-Befehl immer.
 */
export async function runGuard(stdinJson: string, env: Record<string, string | undefined>, deps: GuardDeps = {}): Promise<GuardOutcome> {
  if (!env[GUARD_ENV.auftrag]) return ALLOW();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<GuardOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ stdout: denyJson(deadlineText()), hit: null, asked: false, approvalId: null }), deps.deadlineMs ?? GUARD_DEADLINE_MS);
  });
  try {
    return await Promise.race([checkWithServer(stdinJson, env, deps), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkWithServer(stdinJson: string, env: Record<string, string | undefined>, deps: GuardDeps): Promise<GuardOutcome> {
  const auftrag = env[GUARD_ENV.auftrag] ?? "";

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdinJson) as Record<string, unknown>;
  } catch {
    return ALLOW();
  }
  if (!payload || typeof payload !== "object" || payload.tool_name !== "Bash") return ALLOW();
  const input = payload.tool_input && typeof payload.tool_input === "object" ? (payload.tool_input as Record<string, unknown>) : {};
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return ALLOW();
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : (env.PWD ?? null);
  const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id.slice(0, 200) : null;

  let hit: GuardHit | null;
  let worktree: string | null = null;
  try {
    worktree = env[GUARD_ENV.worktree] || findGitTop(cwd);
    const currentBranch = readBranch(worktree);
    hit = classifyCommand({ tool: "Bash", command, cwd, worktreeRoot: worktree, currentBranch, env, prodHosts: prodHostsFor(env) });
  } catch {
    hit = null;
  }
  if (!hit) return ALLOW();

  const body: GuardCheck = {
    tool: "Bash",
    command: command.slice(0, 8000),
    cwd: cwd ? cwd.slice(0, 2000) : null,
    sessionId,
    auftrag: auftrag.slice(0, 200),
    worktree: worktree ? worktree.slice(0, 2000) : null,
    rule: hit.rule,
    reason: hit.reason.slice(0, 500),
  };
  try {
    const { serverUrl, token } = (deps.server ?? (() => defaultServer(env)))();
    const res = await (deps.fetchImpl ?? fetch)(`${serverUrl.replace(/\/$/, "")}/guard/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? GUARD_TIMEOUT_MS),
    });
    if (!res.ok) return { stdout: denyJson(denyText(hit, null, t("Antwort {status}", { status: res.status }))), hit, asked: true, approvalId: null };
    const result = GuardCheckResultSchema.parse(await res.json());
    if (result.decision === "allow") return ALLOW(hit, true, result.approvalId);
    return { stdout: denyJson(denyText(hit, result.approvalId, null)), hit, asked: true, approvalId: result.approvalId };
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? tc("guard", "Zeitlimit") : t("keine Verbindung");
    return { stdout: denyJson(denyText(hit, null, why)), hit, asked: true, approvalId: null };
  }
}

const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Hook-Eintrag für `claude --settings '<json>'`: hängt die Leitplanke NUR an die von NyxOS
 * gestartete Session (kein Eintrag in ~/.claude/settings.json nötig). Die Start-Kette setzt dazu
 * `NYXOS_AUFTRAG` (und möglichst `NYXOS_WORKTREE`) in der Umgebung der Session.
 */
export function guardSettingsJson(binPath: string = paths().hook): string {
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${q(binPath)} guard`, timeout: 5 }] }] } });
}

/** Umgebung für eine NyxOS-Session (Start-Kette): Auftrag + Worktree. */
export function guardSessionEnv(auftrag: string, worktree: string): Record<string, string> {
  return { [GUARD_ENV.auftrag]: auftrag, [GUARD_ENV.worktree]: worktree };
}
