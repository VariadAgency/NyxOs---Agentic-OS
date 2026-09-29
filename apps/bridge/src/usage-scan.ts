// Bestand-Scan für die Nutzung ("Alle Projekte, aber ohne Inhalte"): liest ALLE Claude-Projekte (nicht
// nur die Projektordner, anders als `tracker.ts`) und ALLE Codex-Rollouts, aber NUR über
// `extractClaudeUsageLine`/`extractCodexUsageLine` (packages/shared) — diese Funktionen öffnen
// strukturell nie `message.content`, Titel oder Dateipfade, nur Modell/Zeit/Tokenzahlen.
// `project` ist für Sessions in den Projektordnern der feste Wert `"projekte"` (erfasste Sessions),
// für alles andere `"andere"` (kein Projektname, kein Pfad) — s. Schema-Kommentar im Server.
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { claudeDirInProjects, inProjects, type BridgeConfig } from "./config.js";
import { extractClaudeUsageLine, extractCodexModelLine, extractCodexUsageLine, type CodexRawUsage, type UsageIngestRow } from "@nyxos/shared";

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

interface FileState {
  mtimeMs: number;
}

interface ScanState {
  files: Record<string, FileState>;
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth < 6) await walk(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/** Klein genug, dass ein einzelner JSON-Zustand reicht (kein SQLite nötig für diesen Nebenpfad). */
export class UsageScanner {
  private state: ScanState = { files: {} };
  private loaded = false;

  constructor(
    private readonly cfg: Pick<BridgeConfig, "claudeDir" | "codexDir" | "projectRoots">,
    private readonly statePath: string,
    private readonly log: Log,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch {
      this.state = { files: {} };
    }
  }

  private async save(): Promise<void> {
    await writeFile(this.statePath, JSON.stringify(this.state), "utf8");
  }

  /** Liest alle geänderten Dateien komplett neu ein (einfacher als Byte-Offsets über Neustarts
   * hinweg — Kosten sind vertretbar; die Server-Seite dedupliziert
   * über eine inhaltsbasierte ID ohnehin, ein erneutes Einlesen ist also nie falsch, nur unnötig). */
  async scanOnce(): Promise<UsageIngestRow[]> {
    await this.load();
    const rows: UsageIngestRow[] = [];
    await this.scanClaude(rows);
    await this.scanCodex(rows);
    await this.save();
    return rows;
  }

  private async changed(path: string): Promise<boolean> {
    const st = await stat(path).catch(() => null);
    if (!st) return false;
    const prev = this.state.files[path];
    if (prev && prev.mtimeMs === st.mtimeMs) return false;
    this.state.files[path] = { mtimeMs: st.mtimeMs };
    return true;
  }

  private async scanClaude(rows: UsageIngestRow[]): Promise<void> {
    const projectsDir = join(this.cfg.claudeDir, "projects");
    let dirs: string[];
    try {
      dirs = await readdir(projectsDir);
    } catch {
      return;
    }
    for (const dirName of dirs) {
      const tracked = claudeDirInProjects(dirName, this.cfg.projectRoots);
      const project = tracked ? ("projekte" as const) : ("andere" as const);
      const files: string[] = [];
      await walk(join(projectsDir, dirName), 1, files);
      for (const file of files) {
        if (!(await this.changed(file))) continue;
        const rel = file.slice(join(projectsDir, dirName).length + 1);
        const parts = rel.split(sep);
        // Haupt-Session: "<uuid>.jsonl"; Sub-Agent: "<uuid>/subagents/agent-<id>.jsonl" — beide
        // gehören für die Nutzung zur Eltern-Session (deren UUID).
        const sessionId = parts[0]?.replace(/\.jsonl$/, "") ?? null;
        const sessionKey = tracked && sessionId ? `claude:${sessionId}` : null;
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch (e) {
          this.log("nutzung-scan-lesefehler", { file, error: String(e) });
          continue;
        }
        let lastMessageId: string | null = null;
        for (const line of text.split("\n")) {
          if (!line) continue;
          const { row, lastMessageId: next } = extractClaudeUsageLine(line, lastMessageId);
          lastMessageId = next;
          if (row) rows.push({ ...row, tool: "claude", project, sessionKey });
        }
      }
    }
  }

  private async scanCodex(rows: UsageIngestRow[]): Promise<void> {
    const sessionsDir = join(this.cfg.codexDir, "sessions");
    const files: string[] = [];
    await walk(sessionsDir, 0, files);
    for (const file of files) {
      if (!/rollout-.*\.jsonl$/.test(file)) continue;
      if (!(await this.changed(file))) continue;
      const m = /([0-9a-f-]{36})\.jsonl$/i.exec(file);
      const sessionId = m?.[1]?.toLowerCase() ?? null;
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (e) {
        this.log("nutzung-scan-lesefehler", { file, error: String(e) });
        continue;
      }
      let currentModel: string | null = null;
      let previousTotals: CodexRawUsage | null = null;
      let tracked: boolean | null = null;
      // Codex weicht sonst ~5–7 % nach oben ab: Codex meldet
      // `token_count` sehr oft, teils mit `last_token_usage`, das eine vorherige Meldung wiederholt
      // OHNE dass der kumulative `total_token_usage`-Zähler der Session weitergerückt ist (kein
      // neuer echter Turn). Ein erster Versuch, exakt wiederholte last_token_usage-WERTE zu
      // verwerfen, hat weit MEHR entfernt als vermutet (40–70 % zu wenig statt 5–7 % zu viel) — echte,
      // zufällig gleich große Antworten in einer engen Tool-Schleife sehen genauso aus. Die richtige
      // Unterscheidung ist "hat sich `total_token_usage` bewegt?", nicht "ist `last_token_usage`
      // gleich?" (s. `extractCodexUsageLine`, folgt der ccusage-Referenzquelle, NOTICE) — gegen echte
      // Verläufe geprüft: trifft ccusage an allen 4 bekannten Tagen exakt.
      for (const line of text.split("\n")) {
        if (!line) continue;
        currentModel = extractCodexModelLine(line) ?? currentModel;
        if (tracked === null) {
          // Nur zur Eimer-Einordnung gelesen (wie `tracker.ts` `decide()`), nie gespeichert.
          const cwd = cwdOf(line);
          if (cwd) tracked = inProjects(cwd, this.cfg.projectRoots);
        }
        const { row, previousTotals: nextTotals } = extractCodexUsageLine(line, currentModel, previousTotals);
        previousTotals = nextTotals;
        if (row && tracked !== null) {
          const project = tracked ? ("projekte" as const) : ("andere" as const);
          rows.push({ ...row, tool: "codex", project, sessionKey: tracked && sessionId ? `codex:${sessionId}` : null });
        }
      }
    }
  }
}

function cwdOf(line: string): string | null {
  try {
    const o = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } };
    if ((o.type === "session_meta" || o.type === "turn_context") && typeof o.payload?.cwd === "string") return o.payload.cwd;
  } catch {
    // kaputte Zeile — ignorieren, nicht Teil der Nutzung
  }
  return null;
}
