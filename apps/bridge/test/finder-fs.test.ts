// Finder-Dienst der Brücke (nur Wurzeln aus FINDER_ROOTS, Pfad-Ausbruch unmöglich, Schreiben nur
// Markdown/Text in erlaubten Wurzeln, mit Sicherungskopie und Konflikt-Prüfung).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINDER_ERR, type FinderCountsResult, type FinderListResult, type FinderReadResult, type FinderRootsResponse, type FinderSearchResult, type FinderWriteResult } from "@nyxos/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { FinderError, FinderFs } from "../src/finder/fs.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

let home: string;
let project: string;
let backups: string;
let fs: FinderFs;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nyxos-finder-"));
  project = join(home, "projekte");
  backups = join(home, "backups");
  mkdirSync(join(project, "docs"), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(home, "Downloads"), { recursive: true });
  mkdirSync(join(home, "draussen"), { recursive: true });
  writeFileSync(join(project, "docs", "plan.md"), "# Plan\n\nHallo\n");
  writeFileSync(join(project, "docs", "notiz.txt"), "Notiz");
  writeFileSync(join(project, "bild.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(project, "code.ts"), "export const a = 1;\n");
  writeFileSync(join(project, ".git", "config"), "[core]");
  writeFileSync(join(project, ".env"), "SECRET=1");
  writeFileSync(join(home, "draussen", "geheim.md"), "# geheim");
  writeFileSync(join(home, "Downloads", "liste.md"), "# Liste");
  symlinkSync(join(home, "draussen"), join(project, "ausgang"));
  fs = new FinderFs({ projectRoots: [project], home, screenshotsDir: null, backupsDir: backups });
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FinderError);
    return (e as FinderError).code;
  }
  throw new Error("kein Fehler");
}

describe("Finder-Dienst · Lesen", () => {
  it("meldet die Wurzeln mit absolutem Pfad und Schreibrecht", async () => {
    const r = (await fs.handle({ op: "roots" })) as FinderRootsResponse["roots"];
    const byId = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(byId.project).toMatchObject({ abs: project, exists: true, writable: true });
    expect(byId.downloads).toMatchObject({ abs: join(home, "Downloads"), writable: false });
  });

  it("listet einen Ordner mit Art, Größe, Kinderzahl; Links nach draußen fehlen", async () => {
    const r = (await fs.handle({ op: "list", root: "project", rel: "" })) as FinderListResult;
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual([".env", ".git", "bild.png", "code.ts", "docs"]);
    const docs = r.entries.find((e) => e.name === "docs");
    expect(docs).toMatchObject({ isDir: true, kind: "folder", children: 2, rel: "docs" });
    expect(r.entries.find((e) => e.name === "bild.png")).toMatchObject({ kind: "image", size: 7 });
    expect(r.entries.find((e) => e.name === ".env")).toMatchObject({ hidden: true, secret: true });
  });

  it("liest in Blöcken und gibt die Prüfsumme nur für die ganze Datei", async () => {
    const whole = (await fs.handle({ op: "read", root: "project", rel: "docs/plan.md" })) as FinderReadResult;
    expect(Buffer.from(whole.b64, "base64").toString()).toBe("# Plan\n\nHallo\n");
    expect(whole).toMatchObject({ eof: true, size: 14, sha256: sha("# Plan\n\nHallo\n") });
    const part = (await fs.handle({ op: "read", root: "project", rel: "docs/plan.md", offset: 2, length: 4 })) as FinderReadResult;
    expect(Buffer.from(part.b64, "base64").toString()).toBe("Plan");
    expect(part).toMatchObject({ eof: false, sha256: null });
  });

  it("verhindert jeden Pfad-Ausbruch (.., absolut, Link nach draußen)", async () => {
    expect(await code(fs.handle({ op: "read", root: "project", rel: "../../draussen/geheim.md" }))).toBe(FINDER_ERR.badPath);
    expect(await code(fs.handle({ op: "read", root: "project", rel: "/etc/passwd" }))).toBe(FINDER_ERR.badPath);
    expect(await code(fs.handle({ op: "list", root: "project", rel: "ausgang" }))).toBe(FINDER_ERR.badPath);
    expect(await code(fs.handle({ op: "read", root: "project", rel: "ausgang/geheim.md" }))).toBe(FINDER_ERR.badPath);
    expect(await code(fs.handle({ op: "list", root: "nirgends", rel: "" }))).toBe(FINDER_ERR.badPath);
  });

  it("liefert Zugangsdaten-Dateien nie aus", async () => {
    expect(await code(fs.handle({ op: "read", root: "project", rel: ".env" }))).toBe(FINDER_ERR.secret);
  });

  it("sucht rekursiv nach Namen (ohne .git)", async () => {
    const r = (await fs.handle({ op: "search", root: "project", rel: "", q: "PLAN" })) as FinderSearchResult;
    expect(r.hits.map((h) => h.rel)).toEqual(["docs/plan.md"]);
    const git = (await fs.handle({ op: "search", root: "project", rel: "", q: "config" })) as FinderSearchResult;
    expect(git.hits).toEqual([]);
  });
});

describe("Finder-Dienst · Schreiben", () => {
  const base = () => ({ baseSha256: sha("# Plan\n\nHallo\n"), baseMtimeMs: 0 });

  it("speichert Markdown, legt vorher eine Sicherungskopie an", async () => {
    const r = (await fs.handle({ op: "write", root: "project", rel: "docs/plan.md", content: "# Plan\n\nNeu\n", ...base() })) as FinderWriteResult;
    expect(readFileSync(join(project, "docs", "plan.md"), "utf8")).toBe("# Plan\n\nNeu\n");
    expect(r.sha256).toBe(sha("# Plan\n\nNeu\n"));
    expect(existsSync(r.backup)).toBe(true);
    expect(readFileSync(r.backup, "utf8")).toBe("# Plan\n\nHallo\n");
    expect(r.backup.startsWith(backups)).toBe(true);
    // keine Reste (Zwischendatei) im Ordner
    expect(readdirSync(join(project, "docs")).sort()).toEqual(["notiz.txt", "plan.md"]);
  });

  it("Konflikt: wurde die Datei inzwischen geändert, wird nichts überschrieben", async () => {
    writeFileSync(join(project, "docs", "plan.md"), "# Plan\n\nvon woanders\n");
    expect(await code(fs.handle({ op: "write", root: "project", rel: "docs/plan.md", content: "x", ...base() }))).toBe(FINDER_ERR.conflict);
    expect(readFileSync(join(project, "docs", "plan.md"), "utf8")).toBe("# Plan\n\nvon woanders\n");
  });

  it("schreibt nie in versteckte Ordner, nie andere Arten, nie in Nur-Lesen-Wurzeln, nie neue Dateien", async () => {
    writeFileSync(join(project, ".git", "x.md"), "a");
    expect(await code(fs.handle({ op: "write", root: "project", rel: ".git/x.md", content: "b", baseSha256: sha("a"), baseMtimeMs: 0 }))).toBe(FINDER_ERR.readOnly);
    expect(await code(fs.handle({ op: "write", root: "project", rel: "code.ts", content: "b", baseSha256: sha("export const a = 1;\n"), baseMtimeMs: 0 }))).toBe(FINDER_ERR.readOnly);
    expect(await code(fs.handle({ op: "write", root: "downloads", rel: "liste.md", content: "b", baseSha256: sha("# Liste"), baseMtimeMs: 0 }))).toBe(FINDER_ERR.readOnly);
    expect(await code(fs.handle({ op: "write", root: "project", rel: "docs/neu.md", content: "b", baseSha256: sha(""), baseMtimeMs: 0 }))).toBe(FINDER_ERR.notFound);
    expect(await code(fs.handle({ op: "write", root: "project", rel: "ausgang/geheim.md", content: "b", baseSha256: sha("# geheim"), baseMtimeMs: 0 }))).toBe(FINDER_ERR.badPath);
    expect(readFileSync(join(home, "draussen", "geheim.md"), "utf8")).toBe("# geheim");
  });
});

describe("Zugangsdaten und Rechner-Last", () => {
  it("sperrt alle üblichen Zugangsdaten-Dateien und -Ordner (lesen, Vorschau), normale Dateien bleiben offen", async () => {
    const secrets = [".envrc", "prod.env", ".env-prod", ".npmrc", ".netrc", ".pgpass", ".git-credentials", "AuthKey_AB12CD34.p8", "id_vps", "id_dsa", "release.keystore", "upload.jks", "secrets.json", ".mcp.json", "server.ppk", "tresor.kdbx", "prod.tfvars", "aws-credentials.json", "gh.token", ".htpasswd"];
    for (const n of secrets) writeFileSync(join(project, n), "SECRET");
    mkdirSync(join(project, ".ssh"), { recursive: true });
    writeFileSync(join(project, ".ssh", "known.txt"), "SECRET");
    for (const n of secrets) expect(await code(fs.handle({ op: "read", root: "project", rel: n })), n).toBe(FINDER_ERR.secret);
    expect(await code(fs.handle({ op: "read", root: "project", rel: ".ssh/known.txt" }))).toBe(FINDER_ERR.secret);
    // .git/config trägt oft Zugangsdaten in der Remote-Adresse
    expect(await code(fs.handle({ op: "read", root: "project", rel: ".git/config" }))).toBe(FINDER_ERR.secret);
    const listed = (await fs.handle({ op: "list", root: "project", rel: "" })) as FinderListResult;
    for (const n of secrets) expect(listed.entries.find((e) => e.name === n)?.secret, n).toBe(true);
    // Keine Fehlalarme für gewöhnliche Quelltexte
    for (const n of ["TokenStore.swift", "id_mapping.json", "environment.ts", "keyboard.md"]) {
      writeFileSync(join(project, n), "ok");
      const r = (await fs.handle({ op: "read", root: "project", rel: n })) as FinderReadResult;
      expect(Buffer.from(r.b64, "base64").toString(), n).toBe("ok");
    }
  });

  it("startet höchstens zwei sips gleichzeitig (Mac schonen), auch bei vielen Vorschaubildern", async () => {
    const lock = join(home, "sips-lock");
    mkdirSync(lock);
    const sips = join(home, "fake-sips.sh");
    writeFileSync(
      sips,
      `#!/bin/sh\nmkdir "${lock}/$$"\nn=$(ls "${lock}" | wc -l | tr -d ' ')\necho "$n" >> "${home}/sips-max"\nsleep 0.3\nfor a; do out="$a"; done\nprintf 'JPG' > "$out"\nrmdir "${lock}/$$"\n`,
      { mode: 0o755 },
    );
    // sips (Vorschaubilder) nur auf macOS – `platform` lässt die Grenze auch auf Linux prüfen.
    const f = new FinderFs({ projectRoots: [project], home, screenshotsDir: null, backupsDir: backups, sipsBin: sips, platform: "darwin" });
    for (let i = 0; i < 6; i++) writeFileSync(join(project, `b${i}.png`), Buffer.from([0x89, 0x50, i]));
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => f.handle({ op: "thumb", root: "project", rel: `b${i}.png`, size: 64 })));
    expect(out).toHaveLength(6);
    const max = Math.max(...readFileSync(join(home, "sips-max"), "utf8").trim().split("\n").map(Number));
    expect(max).toBeLessThanOrEqual(2);
  });
});

describe("große Ordner: Kinderzahlen kommen nachgereicht (sonst läuft z. B. ~/Downloads mit 1.752 Einträgen in die 20-s-Grenze)", () => {
  it("großer Ordner: Liste kommt ohne Kinderzahlen (childrenPending), die kommen danach über `counts`", async () => {
    const dl = join(home, "Downloads");
    for (let i = 0; i < 400; i++) writeFileSync(join(dl, `datei-${i}.txt`), "x".repeat(i));
    for (let i = 0; i < 60; i++) {
      mkdirSync(join(dl, `ordner-${i}`));
      for (let k = 0; k < i % 4; k++) writeFileSync(join(dl, `ordner-${i}`, `k${k}.md`), "k");
    }
    const r = (await fs.handle({ op: "list", root: "downloads", rel: "" })) as FinderListResult;
    expect(r.entries).toHaveLength(461);
    expect(r.childrenPending).toBe(true);
    expect(r.entries.find((e) => e.name === "ordner-7")).toMatchObject({ isDir: true, kind: "folder", children: null });
    expect(r.entries.find((e) => e.name === "datei-9.txt")).toMatchObject({ isDir: false, size: 9 });
    expect(r.entries.every((e) => e.mtimeMs > 0)).toBe(true);
    const c = (await fs.handle({ op: "counts", root: "downloads", rel: "" })) as FinderCountsResult;
    expect(c.counts["ordner-7"]).toBe(3);
    expect(c.counts["ordner-8"]).toBe(0);
    expect(Object.keys(c.counts)).toHaveLength(60);
  });

  it("kleiner Ordner: Kinderzahlen kommen wie bisher gleich mit", async () => {
    const r = (await fs.handle({ op: "list", root: "project", rel: "" })) as FinderListResult;
    expect(r.childrenPending).toBe(false);
    expect(r.entries.find((e) => e.name === "docs")?.children).toBe(2);
  });

  it("liest die Einträge gleichzeitig statt einzeln nacheinander (kalte Platte: sonst Sekunden)", async () => {
    const dl = join(home, "Downloads");
    for (let i = 0; i < 64; i++) writeFileSync(join(dl, `f${i}.bin`), "x");
    let running = 0;
    let peak = 0;
    const slow = new FinderFs({
      projectRoots: [project],
      home,
      screenshotsDir: null,
      backupsDir: backups,
      onStat: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((res) => setTimeout(res, 20));
        running--;
      },
    });
    const t0 = Date.now();
    const r = (await slow.handle({ op: "list", root: "downloads", rel: "" })) as FinderListResult;
    expect(r.entries).toHaveLength(65);
    // 65 × 20 ms nacheinander wären 1,3 s
    expect(Date.now() - t0).toBeLessThan(600);
    expect(peak).toBeGreaterThan(8);
    expect(peak).toBeLessThanOrEqual(32);
  });
});

describe("`counts` hat dieselben Pfad-Regeln wie `list`", () => {
  it("kein Weg hinaus: Traversal, absolute Pfade, Link nach draußen, fremde Wurzel → badPath", async () => {
    expect(await code(fs.handle({ op: "counts", root: "project", rel: "../../draussen" }))).toBe(FINDER_ERR.badPath);
    expect(await code(fs.handle({ op: "counts", root: "project", rel: "/etc" }))).toBe(FINDER_ERR.badPath);
    expect(await code(fs.handle({ op: "counts", root: "project", rel: "ausgang" }))).toBe(FINDER_ERR.badPath);
    expect(await code(fs.handle({ op: "counts", root: "nirgends", rel: "" }))).toBe(FINDER_ERR.badPath);
  });

  it("Links: nach draußen fehlen sie (wie in der Liste), innerhalb der Wurzel zählen sie wie in `list`", async () => {
    symlinkSync(join(project, "docs"), join(project, "docs-link"));
    const c = (await fs.handle({ op: "counts", root: "project", rel: "" })) as FinderCountsResult;
    expect(c.counts).not.toHaveProperty("ausgang");
    expect(c.counts.docs).toBe(2);
    expect(c.counts["docs-link"]).toBe(2);
    const l = (await fs.handle({ op: "list", root: "project", rel: "" })) as FinderListResult;
    expect(l.entries.find((e) => e.name === "docs-link")?.children).toBe(2);
  });
});
