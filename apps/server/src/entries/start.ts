// Ein-Klick-Start ("Start-Blatt"). Plant einen Git-Worktree + eine tmux-Auftrags-Session und lässt
// BEIDES von der Brücke ausführen.
//
// Sicherheit: Worktree und Start laufen über die Brücken-RPCs `worktree_add`/`start` (Argumente je als
// LISTE, nie als ein zusammengesetzter String, s. `apps/bridge/src/terminal/manager.ts`) — eine Injektion
// über `model` ist damit strukturell nicht möglich, unabhängig von der zusätzlichen Regex-Prüfung unten.
//
// Nur für Einträge mit Stufe "startklar" (Route prüft das vor dem Aufruf). Der Worktree liegt immer im
// Repo des Auftrags unter `<repo>/.worktrees/<slug>` (`WORKTREE_DIR`). Welches Repo, bestimmt der Anker
// (GOAL.md des Auftrags, sonst der erste Ordner aus dem Dateibereich, sonst der Projektordner). Die Brücke
// berechnet die TATSÄCHLICHEN Pfade selbst — `computeStartPlan` hier bleibt reine Vorschau fürs
// Start-Blatt, mit derselben Konvention.
import { posix } from "node:path";
import { eq } from "drizzle-orm";
import { MODEL_NAME_RE, TERM_ERR, WORKTREE_DIR, WorktreeAnchorSchema, type BridgeRpcMethod, type StartResult, type WorktreeAddResult, t } from "@nyxos/shared";
import type { Db } from "../db/client.js";
import { entries } from "../db/schema.js";

/** Nur die Felder, die die Start-Planung wirklich braucht — bewusst kein `import type { Entry }`
 * aus `@nyxos/shared` (deren `priority` ist eine enge Literal-Union, die Store-DTOs roh aus der
 * DB nicht ohne Weiteres erfüllen; diese Funktion braucht `priority` ohnehin nicht). */
export interface StartableEntry {
  id: number;
  title: string;
  fileScope: string[];
  sourceId: string | null;
  modelSuggestion?: string | null;
}

/** Schlanke Schnittstelle zur Brücke — absichtlich nicht die ganze `BridgeHub`-Klasse importiert,
 * damit Tests einen einfachen Fake statt einer echten WebSocket-Verbindung einsetzen können.
 * `BridgeHub.rpc(...)` erfüllt diese Schnittstelle strukturell schon (gleiche Form). */
export interface BridgeRpc {
  rpc(method: BridgeRpcMethod, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }>;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export interface StartPlan {
  slug: string;
  /** Pfad relativ zum Projektordner, dessen Git-Repo den Worktree bekommt (`""` = Projektordner). */
  anchor: string;
  /** Vorschau: Ordner des Ankers relativ zum Projektordner (`.` = Projektordner) — das Repo darüber
   * bestimmt die Brücke. */
  repoRoot: string;
  /** Vorschau: `<repo>/.worktrees/<slug>`; den echten, absoluten Pfad liefert die Brücke beim Start. */
  worktreePath: string;
  branch: string;
  tmuxSocket: string;
  tmuxSession: string;
  goalPathHint: string | null;
}

/** Glob-Muster → fester Ordner davor (`src/auth/**` → `src/auth`). */
function staticDir(pattern: string): string {
  const parts = pattern.split("/");
  const cut = parts.findIndex((p) => /[*?[\]{}]/.test(p));
  return (cut === -1 ? parts : parts.slice(0, cut)).join("/");
}

/** Anker des Auftrags: GOAL.md (Import) > erster fester Ordner aus dem Dateibereich > Projektordner. */
export function startAnchor(entry: Pick<StartableEntry, "fileScope" | "sourceId">): string {
  const goal = entry.sourceId?.endsWith(".md") ? entry.sourceId : "";
  const candidates = [goal, ...entry.fileScope.map(staticDir)];
  for (const c of candidates) {
    const clean = c.replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (clean && WorktreeAnchorSchema.safeParse(clean).success) return clean;
  }
  return "";
}

/** Reine Planungsfunktion (keine Seiteneffekte) — für die Vorschau im Start-Blatt und für Tests. */
export function computeStartPlan(entry: StartableEntry): StartPlan {
  const slug = `${entry.id}-${slugify(entry.title)}`;
  const anchor = startAnchor(entry);
  const anchorDir = anchor.endsWith(".md") ? posix.dirname(anchor) : anchor;
  const repoRoot = anchorDir === "" ? "." : anchorDir;
  return {
    slug,
    anchor,
    repoRoot,
    worktreePath: posix.join(repoRoot, WORKTREE_DIR, slug),
    branch: `auftrag/${slug}`,
    tmuxSocket: "nyxos",
    tmuxSession: `zc-start-${slug}`,
    goalPathHint: entry.sourceId,
  };
}

/** Worktree über die Brücke anlegen. Ein schon vorhandener Worktree (unterbrochener Start) gilt als
 * Erfolg, wenn die Brücke ihn mit `reused` zurückgibt. */
export async function addWorktreeViaBridge(bridge: BridgeRpc, plan: StartPlan): Promise<{ ok: true; worktree: WorktreeAddResult } | { ok: false; error: string }> {
  const r = await bridge.rpc("worktree_add", { anchor: plan.anchor, slug: plan.slug, branch: plan.branch });
  if (!r.ok) {
    if (r.code === TERM_ERR.worktreeExists) return { ok: false, error: t("Der Worktree für diesen Auftrag gibt es schon – die Brücke ist zu alt, um ihn weiterzuverwenden.") };
    return { ok: false, error: r.error ?? t("Worktree konnte nicht angelegt werden") };
  }
  const worktree = r.result as WorktreeAddResult | undefined;
  if (!worktree?.worktreePath) return { ok: false, error: t("Die Brücke hat keinen Worktree-Pfad geliefert") };
  return { ok: true, worktree };
}

export interface ExecuteStartOptions {
  model: string;
  /** true: nur den Plan zurückgeben, NICHTS ausführen (keine Brücken-RPC, kein echter Worktree/keine
   * echte Session) — für Vorschau/Tests. Die Mechanik selbst (Worktree anlegen, tmux starten) ist
   * jetzt Sache der Brücke und dort getestet (`apps/bridge/test/terminal.test.ts`, `worktree_add`). */
  dryRun: boolean;
}

export interface ExecuteStartResult {
  ok: boolean;
  plan: StartPlan;
  command: string;
  error?: string;
}

export async function executeStart(db: Db, entry: StartableEntry, bridge: BridgeRpc, opts: ExecuteStartOptions): Promise<ExecuteStartResult> {
  const plan = computeStartPlan(entry);
  // Zweite Verteidigungslinie direkt vor der Ausführung — die Route validiert `model`/`modelSuggestion`
  // schon (s. routes/entries.ts), aber diese Funktion darf sich darauf nicht allein verlassen.
  if (!MODEL_NAME_RE.test(opts.model)) return { ok: false, plan, command: "", error: t("Ungültiger Modell-Name") };

  if (opts.dryRun) return { ok: true, plan, command: t("(Probe, nichts ausgeführt) {slug}", { slug: plan.slug }) };

  const wt = await addWorktreeViaBridge(bridge, plan);
  if (!wt.ok) return { ok: false, plan, command: "", error: wt.error };
  const worktree = wt.worktree;

  // Die GOAL.md relativ zum Worktree (die Brücke kennt die Lage im Repo) — als Freitext-Prompt an die
  // Brücke, nie zu einem Shell-Befehl zusammengesetzt (s. Kommentar oben).
  const goal = plan.goalPathHint ? (worktree.anchorInRepo ?? plan.goalPathHint) : null;
  const prompt = goal ? `/goal ${goal}` : null;
  // TODO: Einträge kennen bisher kein eigenes `tool` (immer "claude", wie vor dieser
  // Nachbesserung) — Codex-Aufträge bräuchten eine eigene Spalte, außerhalb dieses Sicherheits-Fixes.
  const startOutcome = await bridge.rpc("start", { tool: "claude", model: opts.model, cwd: worktree.worktreePath, prompt, cols: 120, rows: 36 });
  if (!startOutcome.ok) return { ok: false, plan, command: "", error: startOutcome.error ?? "Start fehlgeschlagen" };
  const started = startOutcome.result as StartResult;

  await db
    .update(entries)
    .set({ stage: "laeuft", worktreePath: worktree.worktreePath, gitBranch: worktree.branch, tmuxName: started.tmuxName, updatedAt: new Date().toISOString() })
    .where(eq(entries.id, entry.id));
  return { ok: true, plan, command: `claude --model ${opts.model} -- ${prompt ?? ""}` };
}
