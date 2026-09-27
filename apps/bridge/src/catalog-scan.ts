// Bestand an Agenten/Skills: `~/.claude/agents` (source "user"), `.claude/agents` in den Projektordnern und
// ihren direkten Unterordnern (source "project"), Skills analog aus `~/.claude/skills` bzw.
// `<ordner>/.claude/skills/*/SKILL.md`. Plugins (`~/.claude/plugins/*/{agents,skills}`) werden nicht gelesen.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_COLOR_MAX, AGENT_MODEL_MAX, AGENT_PROMPT_MAX_CHARS, AGENT_TOOL_NAME_MAX, AGENT_TOOLS_MAX, type AgentDetails, type CatalogEntry } from "@nyxos/shared";

/** Liest `name`/`description` aus dem YAML-Frontmatter (`---\n...\n---`) — bewusst ohne YAML-
 * Bibliothek: beide Felder sind bei Agenten/Skills immer einzeilig. */
function frontmatter(text: string): { name: string | null; description: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: null, description: null };
  const block = m[1] ?? "";
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
  const description = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
  return { name, description };
}

/** Modell, Werkzeuge, Farbe (Frontmatter, einzeilig) und der Prompt (alles nach dem
 * Frontmatter) — für die Agenten-Kacheln. `tools` ist bei Claude-Agenten eine Komma-Liste. */
export function agentDetails(text: string): AgentDetails {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const block = m?.[1] ?? "";
  // `[ \t]*` statt `\s*` — sonst greift ein leeres Feld („model:“) auf die nächste Zeile über.
  const field = (key: string, max: number): string | null => {
    const v = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "");
    return v ? v.slice(0, max) : null;
  };
  const unquote = (t: string) => t.trim().replace(/^["']|["']$/g, "");
  const toolsRaw = field("tools", Number.MAX_SAFE_INTEGER);
  // YAML-Liste („tools:“ und darunter „  - Read“) oder Komma-Liste in einer Zeile.
  const toolsList = toolsRaw ? toolsRaw.replace(/^\[|\]$/g, "").split(",") : (/^tools:[ \t]*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m.exec(block)?.[1] ?? "").split("\n").map((l) => l.replace(/^\s*-\s*/, ""));
  // Grenzen wie `AgentDetailsSchema`: der Server lehnt sonst den ganzen Stapel der Quelle ab.
  const tools = toolsList.map(unquote).filter(Boolean).slice(0, AGENT_TOOLS_MAX).map((t) => t.slice(0, AGENT_TOOL_NAME_MAX));
  const body = (m ? text.slice(m[0].length) : text).trim();
  return { model: field("model", AGENT_MODEL_MAX), tools, color: field("color", AGENT_COLOR_MAX), prompt: body.slice(0, AGENT_PROMPT_MAX_CHARS) };
}

async function scanAgentsDir(dir: string, source: string): Promise<CatalogEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: CatalogEntry[] = [];
  for (const n of names) {
    if (!n.endsWith(".md")) continue;
    const path = join(dir, n);
    const text = await readFile(path, "utf8").catch(() => "");
    const fm = frontmatter(text);
    out.push({ kind: "agent", name: fm.name ?? n.replace(/\.md$/, ""), description: fm.description, path, source, details: agentDetails(text) });
  }
  return out;
}

async function scanSkillsDir(dir: string, source: string): Promise<CatalogEntry[]> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CatalogEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const fm = frontmatter(text);
    out.push({ kind: "skill", name: fm.name ?? entry.name, description: fm.description, path, source });
  }
  return out;
}

export interface CatalogScanResult {
  bySource: Map<string, CatalogEntry[]>;
}

/** Höchstens so viele Projekt-`.claude`-Ordner je Lauf. */
const MAX_PROJECT_DIRS = 200;

/** `.claude`-Ordner der Projektordner und ihrer direkten Unterordner (typisch: ein Repo je Unterordner). */
async function projectClaudeDirs(projectRoots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of projectRoots) {
    if (existsSync(join(root, ".claude"))) out.push(join(root, ".claude"));
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_PROJECT_DIRS) return out;
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const dir = join(root, e.name, ".claude");
      if (existsSync(dir) && !out.includes(dir)) out.push(dir);
    }
  }
  return out;
}

export async function scanCatalog(homeDir: string, projectRoots: readonly string[]): Promise<CatalogScanResult> {
  const bySource = new Map<string, CatalogEntry[]>();
  bySource.set("user", [...(await scanAgentsDir(join(homeDir, ".claude", "agents"), "user")), ...(await scanSkillsDir(join(homeDir, ".claude", "skills"), "user"))]);
  const project: CatalogEntry[] = [];
  for (const dir of await projectClaudeDirs(projectRoots)) {
    // Das Home-`.claude` ist schon „user“.
    if (dir === join(homeDir, ".claude")) continue;
    project.push(...(await scanAgentsDir(join(dir, "agents"), "project")), ...(await scanSkillsDir(join(dir, "skills"), "project")));
  }
  bySource.set("project", project);
  return { bySource };
}
