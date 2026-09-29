import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_PROMPT_MAX_CHARS, CatalogBatchSchema } from "@nyxos/shared";
import { agentDetails, scanCatalog } from "../src/catalog-scan.js";

function tmpProject() {
  const home = mkdtempSync(join(tmpdir(), "nyxos-katalog-home-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "nyxos-katalog-projekt-"));
  return { home, projectRoot };
}

describe("scanCatalog (Bestand Agenten/Skills)", () => {
  it("liest Agenten aus ~/.claude/agents (source 'user') und dem Projekt (source 'project')", async () => {
    const { home, projectRoot } = tmpProject();
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    writeFileSync(join(home, ".claude", "agents", "haiku-mitgruender.md"), "---\nname: haiku-mitgruender\ndescription: Plant mit dem Team\n---\nInhalt.\n");
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "agents", "test-coverage-critic.md"), "---\nname: test-coverage-critic\ndescription: prueft Tests\n---\nInhalt.\n");

    const { bySource } = await scanCatalog(home, [projectRoot]);
    expect(bySource.get("user")).toEqual([{ kind: "agent", name: "haiku-mitgruender", description: "Plant mit dem Team", path: expect.stringContaining("haiku-mitgruender.md"), source: "user", details: { model: null, tools: [], color: null, prompt: "Inhalt." } }]);
    expect(bySource.get("project")).toEqual([{ kind: "agent", name: "test-coverage-critic", description: "prueft Tests", path: expect.stringContaining("test-coverage-critic.md"), source: "project", details: { model: null, tools: [], color: null, prompt: "Inhalt." } }]);
  });

  // Agenten-Kacheln zeigen Modell, Werkzeuge, Farbe und den Prompt (Text nach dem Frontmatter).
  it("liest Modell, Werkzeuge, Farbe und Prompt eines Agenten", async () => {
    const { home, projectRoot } = tmpProject();
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".claude", "agents", "scope-warden.md"),
      "---\nname: scope-warden\ndescription: Scope-Wächter\ntools: Read, Grep, Glob, Bash\nmodel: sonnet\ncolor: purple\n---\n\nDu bewachst die Grenze.\n\n## Regeln\n- nie raten\n",
    );
    const { bySource } = await scanCatalog(home, [projectRoot]);
    const agent = bySource.get("project")?.[0];
    expect(agent?.details).toEqual({ model: "sonnet", tools: ["Read", "Grep", "Glob", "Bash"], color: "purple", prompt: "Du bewachst die Grenze.\n\n## Regeln\n- nie raten" });
  });

  it("kürzt sehr lange Prompts, statt den Agenten wegzulassen", async () => {
    const { home, projectRoot } = tmpProject();
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "agents", "lang.md"), `---\nname: lang\ndescription: x\n---\n${"a".repeat(50_000)}`);
    const { bySource } = await scanCatalog(home, [projectRoot]);
    expect(bySource.get("project")?.[0]?.details?.prompt.length).toBe(AGENT_PROMPT_MAX_CHARS);
  });

  it("liest Skills aus SKILL.md-Unterordnern", async () => {
    const { home, projectRoot } = tmpProject();
    mkdirSync(join(home, ".claude", "skills", "dataviz"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "dataviz", "SKILL.md"), "---\nname: dataviz\ndescription: Diagramme richtig gestalten\n---\n...\n");

    const { bySource } = await scanCatalog(home, [projectRoot]);
    expect(bySource.get("user")).toContainEqual({ kind: "skill", name: "dataviz", description: "Diagramme richtig gestalten", path: expect.stringContaining("dataviz/SKILL.md"), source: "user" });
  });

  it("liefert leere Listen, wenn keine Ordner existieren (kein Absturz)", async () => {
    const { home, projectRoot } = tmpProject();
    const { bySource } = await scanCatalog(home, [projectRoot]);
    expect(bySource.get("user")).toEqual([]);
    expect(bySource.get("project")).toEqual([]);
  });
});

// Ein einziges Agent-Frontmatter darf nie den ganzen Bestand einer Quelle kippen — der
// Server prüft den Stapel mit `CatalogBatchSchema` und lehnt ihn als Ganzes ab.
describe("agentDetails", () => {
  it("überlange Felder werden gekürzt, der Stapel bleibt gültig", () => {
    const tools = Array.from({ length: 250 }, (_, i) => `Werkzeug${i}${"x".repeat(250)}`).join(", ");
    const d = agentDetails(`---\nname: a\nmodel: ${"m".repeat(300)}\ncolor: ${"c".repeat(80)}\ntools: ${tools}\n---\nText`);
    expect(CatalogBatchSchema.safeParse({ items: [{ kind: "agent", name: "a", description: null, path: "/a.md", source: "user", details: d }] }).success).toBe(true);
  });

  it("leeres Feld greift nicht auf die nächste Zeile über", () => {
    const d = agentDetails("---\nname: a\nmodel:\ndescription: Eine sehr lange Beschreibung\ntools:\n  - Read\n---\nText");
    expect(d.model).toBeNull();
    expect(d.tools).toEqual(["Read"]);
  });
});
