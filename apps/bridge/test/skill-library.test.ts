// Skill-Bibliothek der Brücke – Quellen, Erlaubnisliste, Sicherung, Zurücksetzen.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillLibrary, SkillLibraryError } from "../src/skills.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function world() {
  const home = mkdtempSync(join(tmpdir(), "skills-home-"));
  const claudeDir = join(home, ".claude");
  const projectRoot = mkdtempSync(join(tmpdir(), "skills-projekt-"));
  const backupsDir = mkdtempSync(join(tmpdir(), "skills-sicherung-"));
  const skill = (dir: string, name: string, desc: string, extra: Record<string, string> = {}) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
    for (const [rel, text] of Object.entries(extra)) {
      mkdirSync(join(dir, name, rel, ".."), { recursive: true });
      writeFileSync(join(dir, name, rel), text);
    }
  };
  skill(join(claudeDir, "skills"), "dataviz", "Diagramme", { "scripts/check.sh": "echo ok\n" });
  skill(join(projectRoot, ".claude", "skills"), "ideen", "Ideen-Postfach");
  skill(join(projectRoot, "app", ".claude", "skills"), "gitnexus", "Wissensgraph");
  skill(join(projectRoot, "nyxos", ".claude", "skills"), "abnahme", "Abnahme prüfen");
  writeFileSync(join(projectRoot, "nyxos", "package.json"), JSON.stringify({ name: "nyxos" }));
  // Plugin (installiert) + eine alte, nicht mehr installierte Version im Cache (darf NICHT erscheinen).
  const pluginDir = join(claudeDir, "plugins", "cache", "official", "superpowers", "5.0.7");
  skill(join(pluginDir, "skills"), "brainstorming", "Ideen sammeln");
  skill(join(claudeDir, "plugins", "cache", "official", "superpowers", "4.0.0", "skills"), "alt", "veraltet");
  writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "superpowers@official": [{ scope: "user", installPath: pluginDir, version: "5.0.7" }] } }));
  // Claude.ai-Skills: zwei Kopien desselben Skills in zwei synced-Ordnern → einmal.
  skill(join(claudeDir, "skills", "synced", "a_1"), "docx", "Word");
  skill(join(claudeDir, "skills", "synced", "b_2"), "docx", "Word neu");
  return { home, claudeDir, projectRoot, backupsDir, lib: new SkillLibrary({ claudeDir, projectRoots: [projectRoot], backupsDir }) };
}

describe("SkillLibrary.list", () => {
  it("liest alle Quellen mit Aufruf-Name, Herkunft, Schreibrecht und Dateien", async () => {
    const { lib, projectRoot } = world();
    const res = await lib.list();
    const byKey = new Map(res.skills.map((s) => [s.key, s]));
    expect([...byKey.keys()].sort()).toEqual(["abnahme", "anthropic-skills:docx", "brainstorming".replace(/^/, "superpowers:"), "dataviz", "gitnexus", "ideen"].sort());
    expect(byKey.get("dataviz")).toMatchObject({ source: "user", writable: true, description: "Diagramme", files: expect.arrayContaining([{ rel: "scripts/check.sh", bytes: 8 }]) });
    expect(byKey.get("ideen")).toMatchObject({ source: "project", writable: true });
    expect(byKey.get("gitnexus")).toMatchObject({ source: "project", writable: true });
    expect(byKey.get("abnahme")).toMatchObject({ source: "nyxos", writable: true });
    expect(byKey.get("superpowers:brainstorming")).toMatchObject({ source: "plugin", plugin: "superpowers", writable: false });
    expect(byKey.get("anthropic-skills:docx")).toMatchObject({ source: "synced", writable: false });
    const d = byKey.get("dataviz");
    expect(d?.sha256).toBe(sha("---\nname: dataviz\ndescription: Diagramme\n---\n# dataviz\n"));
    expect(res.projectRoot).toBe(projectRoot);
    expect(res.targets.user).toMatch(/\.claude\/skills$/);
  });
});

describe("SkillLibrary.read – nur unter den Skill-Wurzeln", () => {
  it("liest SKILL.md und Zusatzdateien", async () => {
    const { lib, claudeDir } = world();
    const r = await lib.read([join(claudeDir, "skills", "dataviz", "SKILL.md"), join(claudeDir, "skills", "dataviz", "scripts", "check.sh")]);
    expect(r.files[0]?.content).toContain("# dataviz");
    expect(r.files[1]?.content).toBe("echo ok\n");
  });

  it("verweigert Dateien außerhalb (z. B. ~/.ssh) und Symlinks nach draußen", async () => {
    const { lib, home, claudeDir } = world();
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "GEHEIM");
    symlinkSync(join(home, ".ssh"), join(claudeDir, "skills", "dataviz", "raus"));
    const r = await lib.read([join(home, ".ssh", "id_ed25519"), join(claudeDir, "skills", "dataviz", "raus", "id_ed25519")]);
    expect(r.files.every((f) => f.content === null)).toBe(true);
  });
});

describe("SkillLibrary.backup / restore", () => {
  it("sichert den ganzen Ordner und schreibt einen alten Stand nur bei passendem Hash zurück", async () => {
    const { lib, claudeDir, backupsDir } = world();
    const path = join(claudeDir, "skills", "dataviz", "SKILL.md");
    const before = readFileSync(path, "utf8");
    const b = await lib.backup(join(claudeDir, "skills", "dataviz"), "vor-opus");
    expect(b.backupDir.startsWith(backupsDir)).toBe(true);
    expect(readFileSync(join(b.backupDir, "SKILL.md"), "utf8")).toBe(before);
    expect(existsSync(join(b.backupDir, "scripts", "check.sh"))).toBe(true);

    await expect(lib.restore(path, "neu", "0".repeat(64))).rejects.toBeInstanceOf(SkillLibraryError);
    expect(readFileSync(path, "utf8")).toBe(before);

    const r = await lib.restore(path, "# alt\n", sha(before));
    expect(readFileSync(path, "utf8")).toBe("# alt\n");
    expect(r.sha256).toBe(sha("# alt\n"));
    expect(readFileSync(join(r.backupDir, "SKILL.md"), "utf8")).toBe(before);
  });

  it("schreibt nie in Plugin- oder Claude.ai-Skills", async () => {
    const { lib, claudeDir } = world();
    const plugin = join(claudeDir, "plugins", "cache", "official", "superpowers", "5.0.7", "skills", "brainstorming", "SKILL.md");
    await expect(lib.restore(plugin, "x", sha(readFileSync(plugin, "utf8")))).rejects.toBeInstanceOf(SkillLibraryError);
    const synced = join(claudeDir, "skills", "synced", "a_1", "docx", "SKILL.md");
    await expect(lib.restore(synced, "x", sha(readFileSync(synced, "utf8")))).rejects.toBeInstanceOf(SkillLibraryError);
  });
});

describe("Skills als Symlink (wie ~/.claude/skills/x -> ~/.agents/skills/x)", () => {
  it("liest verlinkte Skills, schreibt aber nicht hinein; Symlinks darin bleiben gesperrt", async () => {
    const { lib, home, claudeDir } = world();
    const agents = join(home, ".agents", "skills", "ui-design");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "SKILL.md"), "---\nname: ui-design\ndescription: UI\n---\n# ui\n");
    writeFileSync(join(home, ".agents", "skills", "nachbar.txt"), "nicht lesbar");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "GEHEIM");
    symlinkSync(join(home, ".ssh"), join(agents, "raus"));
    symlinkSync(join("..", "..", ".agents", "skills", "ui-design"), join(claudeDir, "skills", "ui-design"));
    const list = await lib.list();
    expect(list.skills.find((x) => x.key === "ui-design")).toMatchObject({ source: "user", writable: false });
    const r = await lib.read([
      join(claudeDir, "skills", "ui-design", "SKILL.md"),
      join(claudeDir, "skills", "ui-design", "raus", "id_ed25519"),
      join(claudeDir, "skills", "ui-design", "..", "nachbar.txt").replace("/ui-design/..", "/ui-design-x/.."),
      join(home, ".agents", "skills", "nachbar.txt"),
    ]);
    expect(r.files[0]?.content).toContain("# ui");
    expect(r.files[1]?.content).toBeNull();
    expect(r.files[2]?.content).toBeNull();
    expect(r.files[3]?.content).toBeNull();
    await expect(lib.backup(join(claudeDir, "skills", "ui-design"), "vor-opus")).rejects.toBeInstanceOf(SkillLibraryError);
  });
});

describe("Sicherung liest keine SKILL.md, die nach draußen zeigt", () => {
  it("liefert keinen Inhalt einer verlinkten SKILL.md außerhalb des Ordners", async () => {
    const { lib, home, claudeDir } = world();
    writeFileSync(join(home, "geheim.txt"), "GEHEIM");
    const dir = join(claudeDir, "skills", "falle");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(home, "geheim.txt"), join(dir, "SKILL.md"));
    const b = await lib.backup(dir, "vor-opus");
    expect(b.content).toBeNull();
    expect(b.sha256).toBeNull();
  });
});

describe("SkillLibrary.checkAddDir (claude --add-dir für Skill-Aufträge)", () => {
  it("lässt nur ~/.claude/skills zu", () => {
    const { lib, claudeDir, home } = world();
    expect(lib.checkAddDir(join(claudeDir, "skills"))).toMatch(/\.claude\/skills$/);
    expect(lib.checkAddDir(join(claudeDir, "skills", "dataviz"))).toMatch(/dataviz$/);
    expect(() => lib.checkAddDir(home)).toThrow(SkillLibraryError);
    expect(() => lib.checkAddDir(join(claudeDir, "plugins"))).toThrow(SkillLibraryError);
  });
});
