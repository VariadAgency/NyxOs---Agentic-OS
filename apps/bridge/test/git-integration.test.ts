// Integrationstests mit ECHTEM `git` gegen TEMPORÄRE, selbst angelegte Repos (nie das
// echte Repo) — Scan, Probe-Merge und Nachziehen werden hier gegen ein reales Repo nachgewiesen,
// nicht nur mit den reinen Parsern aus git-parse.test.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { abortAndVerifyClean, decideCatchup, runCatchup } from "../src/git/catchup.js";
import { isManagedWorktreePath, runGitCollector } from "../src/git/collector.js";
import { probeMerge, workingTreeChecksum } from "../src/git/probeMerge.js";
import { scanRepo } from "../src/git/scan.js";

const dirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nyxos-git-it-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (;;) {
    const dir = dirs.pop();
    if (!dir) break;
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(): string {
  const root = tempRepo();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@nyxos.local");
  git(root, "config", "user.name", "NyxOS Test");
  return root;
}

function writeFile(root: string, name: string, content: string): void {
  writeFileSync(join(root, name), content, "utf8");
}

describe("Git-Scan gegen ein echtes temporäres Repo", () => {
  it("scanRepo liest Zweige, ungesicherte Änderungen und Commits korrekt", async () => {
    const root = initRepo();
    writeFile(root, "README.md", "hallo\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "init");
    git(root, "checkout", "-q", "-b", "feature/x");
    writeFile(root, "src.ts", "console.log(1)\n");
    git(root, "add", "src.ts");
    git(root, "commit", "-q", "-m", "feat: neu");
    writeFile(root, "docs.md", "notiz\n"); // ungesichert

    const snap = await scanRepo({ repoId: "test", label: "Test", kind: "app", root, mainBranch: "main" });
    expect(snap.currentBranch).toBe("feature/x");
    expect(snap.branches.find((b) => b.name === "feature/x")?.ahead).toBe(1);
    expect(snap.branches.find((b) => b.name === "main")?.ahead).toBe(0);
    expect(snap.uncommitted.some((u) => u.path === "docs.md" && u.group === "doku")).toBe(true);
    expect(snap.recentCommits[0]?.subject).toBe("feat: neu");
  });
});

describe("Probe-Merge", () => {
  it("sauberer Merge → status 'clean', Prüfsumme vor/nach gleich", async () => {
    const root = initRepo();
    writeFile(root, "a.txt", "a\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-q", "-m", "init");
    git(root, "checkout", "-q", "-b", "feature/ok");
    writeFile(root, "b.txt", "b\n");
    git(root, "add", "b.txt");
    git(root, "commit", "-q", "-m", "feat: b");

    const before = await workingTreeChecksum(root);
    const result = await probeMerge(root, "main", "feature/ok");
    const after = await workingTreeChecksum(root);
    expect(result.status).toBe("clean");
    expect(result.workingTreeChecksumBefore).toBe(result.workingTreeChecksumAfter);
    expect(before).toBe(after); // Arbeitsbaum unverändert
  });

  it("zwei Zweige ändern dieselbe Zeile → Konflikt wird VOR einem echten Merge erkannt, Repo bleibt unverändert", async () => {
    const root = initRepo();
    writeFile(root, "f.txt", "line1\n");
    git(root, "add", "f.txt");
    git(root, "commit", "-q", "-m", "init");
    git(root, "checkout", "-q", "-b", "feature/conflict");
    writeFile(root, "f.txt", "line1\nfeature-change\n");
    git(root, "commit", "-q", "-am", "feat: change");
    git(root, "checkout", "-q", "main");
    writeFile(root, "f.txt", "line1\nmain-change\n");
    git(root, "commit", "-q", "-am", "main: change");

    const before = await workingTreeChecksum(root);
    const result = await probeMerge(root, "main", "feature/conflict");
    const after = await workingTreeChecksum(root);
    expect(result.status).toBe("conflict");
    expect(result.conflictFiles).toContain("f.txt");
    expect(before).toBe(after); // niemals gemergt/committet/ausgecheckt
    // HEAD muss weiterhin auf dem main-Commit stehen — kein echter Merge fand statt.
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });
});

describe("Nachziehen", () => {
  it("saubere, ruhende Worktree wird nach einem Commit auf main automatisch gemergt", async () => {
    const mainRoot = initRepo();
    writeFile(mainRoot, "a.txt", "a\n");
    git(mainRoot, "add", "a.txt");
    git(mainRoot, "commit", "-q", "-m", "init");

    const wtPath = join(mainRoot, "..", "wt-clean-" + Math.random().toString(36).slice(2));
    git(mainRoot, "worktree", "add", "-q", "-b", "auftrag/ruhig", wtPath, "main");
    dirs.push(wtPath);

    // Neuer Commit auf main, NACHDEM die Worktree abgezweigt wurde.
    writeFile(mainRoot, "b.txt", "b\n");
    git(mainRoot, "add", "b.txt");
    git(mainRoot, "commit", "-q", "-m", "feat: b auf main");

    const decision = decideCatchup({ probeStatus: "clean", hasActiveSession: false, workingTreeClean: true });
    expect(decision.action).toBe("merge");

    // apply: true — hier (temporäres Test-Repo) ist "echt mergen" genau das, was geprüft wird;
    // im echten Betrieb bleibt `apply` false, solange `NYXOS_GIT_CATCHUP_APPLY` nicht gesetzt ist.
    const record = await runCatchup({ repoId: "test", worktreePath: wtPath, branch: "auftrag/ruhig", mainBranch: "main", hasActiveSession: false, apply: true });
    expect(record.outcome).toBe("merged");
    expect(record.mainShaAfter).not.toBeNull();
    // Beweis: die Datei aus dem main-Commit ist jetzt in der Worktree da.
    expect(git(wtPath, "show", "HEAD:b.txt").trim()).toBe("b");
  });

  it("Sicherheits-Standard: OHNE apply:true wird NIE gemergt, auch bei einer sauberen, ruhenden Worktree", async () => {
    // Regressionstest: `runCatchup` darf nie von selbst mergen, nur weil die Entscheidung "merge" lautet
    // — ein automatischer Merge in einem echten Repo ohne Zustimmung ist nicht rückgängig zu machen.
    // `apply` ist darum Pflicht-Opt-in (Default `false`).
    const mainRoot = initRepo();
    writeFile(mainRoot, "a.txt", "a\n");
    git(mainRoot, "add", "a.txt");
    git(mainRoot, "commit", "-q", "-m", "init");
    const wtPath = join(mainRoot, "..", "wt-noapply-" + Math.random().toString(36).slice(2));
    git(mainRoot, "worktree", "add", "-q", "-b", "auftrag/kein-apply", wtPath, "main");
    dirs.push(wtPath);
    writeFile(mainRoot, "b.txt", "b\n");
    git(mainRoot, "add", "b.txt");
    git(mainRoot, "commit", "-q", "-m", "feat: b auf main");

    const before = await workingTreeChecksum(wtPath);
    // Kein `apply` übergeben — muss auf den sicheren Default `false` fallen.
    const record = await runCatchup({ repoId: "test", worktreePath: wtPath, branch: "auftrag/kein-apply", mainBranch: "main", hasActiveSession: false });
    const after = await workingTreeChecksum(wtPath);

    expect(record.outcome).toBe("nachzieh-session");
    expect(record.mainShaAfter).toBeNull();
    expect(record.detail).toMatch(/ausgeschaltet/);
    expect(before).toBe(after); // Worktree garantiert unangetastet
    expect(git(wtPath, "log", "-1", "--format=%s").trim()).toBe("init"); // kein Merge-Commit
  });

  it("Worktree mit Konflikt bleibt unangetastet — es wird KEIN Merge ausgeführt (Nachzieh-Session stattdessen)", async () => {
    const mainRoot = initRepo();
    writeFile(mainRoot, "f.txt", "line1\n");
    git(mainRoot, "add", "f.txt");
    git(mainRoot, "commit", "-q", "-m", "init");

    const wtPath = join(mainRoot, "..", "wt-conflict-" + Math.random().toString(36).slice(2));
    git(mainRoot, "worktree", "add", "-q", "-b", "auftrag/konflikt", wtPath, "main");
    dirs.push(wtPath);
    writeFile(wtPath, "f.txt", "line1\nzweig-aenderung\n");
    git(wtPath, "commit", "-q", "-am", "feat: zweig-aenderung");

    writeFile(mainRoot, "f.txt", "line1\nmain-aenderung\n");
    git(mainRoot, "commit", "-q", "-am", "feat: main-aenderung");

    const before = await workingTreeChecksum(wtPath);
    const record = await runCatchup({ repoId: "test", worktreePath: wtPath, branch: "auftrag/konflikt", mainBranch: "main", hasActiveSession: false });
    const after = await workingTreeChecksum(wtPath);

    expect(record.outcome).toBe("nachzieh-session");
    expect(record.mainShaAfter).toBeNull();
    expect(before).toBe(after); // Worktree wurde nicht angefasst
    expect(git(wtPath, "log", "-1", "--format=%s").trim()).toBe("feat: zweig-aenderung");
  });

  it("Worktree mit laufender Session wird trotz sauberem Probe-Merge nicht angefasst", async () => {
    const mainRoot = initRepo();
    writeFile(mainRoot, "a.txt", "a\n");
    git(mainRoot, "add", "a.txt");
    git(mainRoot, "commit", "-q", "-m", "init");
    const wtPath = join(mainRoot, "..", "wt-busy-" + Math.random().toString(36).slice(2));
    git(mainRoot, "worktree", "add", "-q", "-b", "auftrag/laeuft", wtPath, "main");
    dirs.push(wtPath);
    writeFile(mainRoot, "b.txt", "b\n");
    git(mainRoot, "add", "b.txt");
    git(mainRoot, "commit", "-q", "-m", "feat: b");

    const record = await runCatchup({ repoId: "test", worktreePath: wtPath, branch: "auftrag/laeuft", mainBranch: "main", hasActiveSession: true });
    expect(record.outcome).toBe("nachzieh-session");
    expect(record.detail).toMatch(/Session arbeitet/);
  });

  it("ein Merge, der trotz sauberem Probe-Merge fehlschlägt, hinterlässt keine halb gemergte Worktree — 'git merge --abort' läuft, Status ist danach sauber", async () => {
    // Direkter Test der Merge-Ausführung selbst (nicht der Entscheidung davor, s. `decideCatchup`):
    // ein echter Zeilen-Konflikt, den auch ein Probe-Merge sähe — hier interessiert nur, dass ein
    // ECHTER, fehlschlagender `git merge` sauber aufräumt statt mit Konfliktmarkern/MERGE_HEAD
    // stehen zu bleiben.
    const mainRoot = initRepo();
    writeFile(mainRoot, "f.txt", "eins\n");
    git(mainRoot, "add", "f.txt");
    git(mainRoot, "commit", "-q", "-m", "init");
    const wtPath = join(mainRoot, "..", "wt-konflikt-echt-" + Math.random().toString(36).slice(2));
    git(mainRoot, "worktree", "add", "-q", "-b", "auftrag/konflikt-echt", wtPath, "main");
    dirs.push(wtPath);
    writeFile(wtPath, "f.txt", "zweig\n");
    git(wtPath, "commit", "-q", "-am", "feat: zweig");
    writeFile(mainRoot, "f.txt", "haupt\n");
    git(mainRoot, "commit", "-q", "-am", "feat: haupt");

    const detail = await abortAndVerifyClean(wtPath, "CONFLICT (content): Merge conflict in f.txt");
    expect(detail).toMatch(/Sicherheitsnetz/);
    expect(detail).not.toMatch(/ACHTUNG/); // Status war nach dem Abbruch wirklich sauber

    // Kein halb gemergter Zustand: sauberer Status, kein `MERGE_HEAD`, HEAD unverändert.
    expect(git(wtPath, "status", "--porcelain").trim()).toBe("");
    expect(git(wtPath, "log", "-1", "--format=%s").trim()).toBe("feat: zweig");
    expect(() => git(wtPath, "rev-parse", "--verify", "-q", "MERGE_HEAD")).toThrow();
  });

  it("runCatchup selbst nutzt den Abbruch-Pfad bei einem echten Merge-Konflikt: Worktree bleibt sauber, kein Merge-Commit", async () => {
    const mainRoot = initRepo();
    writeFile(mainRoot, "f.txt", "eins\n");
    git(mainRoot, "add", "f.txt");
    git(mainRoot, "commit", "-q", "-m", "init");
    const wtPath = join(mainRoot, "..", "wt-konflikt-runcatchup-" + Math.random().toString(36).slice(2));
    git(mainRoot, "worktree", "add", "-q", "-b", "auftrag/konflikt-runcatchup", wtPath, "main");
    dirs.push(wtPath);
    writeFile(wtPath, "f.txt", "zweig\n");
    git(wtPath, "commit", "-q", "-am", "feat: zweig");
    writeFile(mainRoot, "f.txt", "haupt\n");
    git(mainRoot, "commit", "-q", "-am", "feat: haupt");

    // `decideCatchup` sähe hier "conflict" (Probe-Merge erkennt denselben Konflikt) — dieser Test
    // ruft trotzdem `runCatchup` end-to-end auf (mit `apply: true`), um zu beweisen, dass die
    // Worktree in JEDEM Fehlschlagspfad sauber bleibt, nicht nur im direkt getesteten Merge-Aufruf.
    const record = await runCatchup({ repoId: "test", worktreePath: wtPath, branch: "auftrag/konflikt-runcatchup", mainBranch: "main", hasActiveSession: false, apply: true });
    expect(record.outcome).toBe("nachzieh-session");
    expect(git(wtPath, "status", "--porcelain").trim()).toBe("");
    expect(git(wtPath, "log", "-1", "--format=%s").trim()).toBe("feat: zweig");
  });
});

describe("runGitCollector — Sicherheits-Standard an der Verdrahtung", () => {
  it("ein voller Collector-Lauf OHNE applyCatchups mergt nie, auch bei einer sauberen, ruhenden Worktree", async () => {
    // Projektordner <root> mit Repo <root>/app und einem von NyxOS angelegten Worktree <root>/app/.worktrees/<name>.
    const root = tempRepo();
    const appDir = join(root, "app");
    mkdirSync(appDir, { recursive: true });
    git(root, "init", "-q", "-b", "main", "app");
    git(appDir, "config", "user.email", "test@nyxos.local");
    git(appDir, "config", "user.name", "NyxOS Test");
    writeFile(appDir, "a.txt", "a\n");
    git(appDir, "add", "a.txt");
    git(appDir, "commit", "-q", "-m", "init");

    const wtDir = join(appDir, ".worktrees", "auftrag-ruhig");
    git(appDir, "worktree", "add", "-q", "-b", "auftrag/ruhig", wtDir, "main");

    writeFile(appDir, "b.txt", "b\n");
    git(appDir, "add", "b.txt");
    git(appDir, "commit", "-q", "-m", "feat: b auf main");

    const beforeHead = git(wtDir, "rev-parse", "HEAD").trim();

    // Fake-Server: gibt POST /ingest/git einfach mit leeren activeSessionKeys zurück (server-seitig
    // "keine Session bekannt" — genau der Fall, in dem ein ungefragter Merge drohen würde).
    let posted: unknown = null;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/ingest/git")) {
        posted = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.endsWith("/api/git")) {
        const body = posted as { repos?: { kind: string; worktrees?: { path: string }[] }[] } | null;
        const repos = (body?.repos ?? []).map((r) => (r.kind !== "worktree" ? { ...r, worktrees: (r.worktrees ?? []).map((w) => ({ ...w, activeSessionKeys: [] })) } : r));
        return new Response(JSON.stringify({ repos }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // KEIN applyCatchups übergeben — muss auf den sicheren Default `false` fallen (wie in
    // run-options.ts, wenn NYXOS_GIT_CATCHUP_APPLY nicht gesetzt ist).
    await runGitCollector({
      projectRoots: [root],
      serverUrl: "http://fake",
      token: "x",
      log: () => {},
      fetchImpl,
    });

    const afterHead = git(wtDir, "rev-parse", "HEAD").trim();
    expect(afterHead).toBe(beforeHead); // unverändert — kein Merge, obwohl er sauber möglich wäre
    expect(git(wtDir, "log", "-1", "--format=%s").trim()).toBe("init");
  });
});

describe("isManagedWorktreePath — Pfade vom Server per realpath prüfen, nicht per startsWith", () => {
  it("ein echter Worktree-Pfad unter der verwalteten Wurzel gilt als verwaltet", () => {
    const root = tempRepo();
    const managedDir = join(root, ".worktrees");
    const wt = join(managedDir, "auftrag-x");
    mkdirSync(wt, { recursive: true });
    // realpathSync (macOS: /tmp → /private/tmp) statt des rohen Pfads — `isManagedWorktreePath`
    // gibt bewusst den AUFGELÖSTEN Pfad zurück, nie den rohen Eingabe-String.
    expect(isManagedWorktreePath(wt, managedDir)).toBe(realpathSync(wt));
  });

  it("ein Traversal-Pfad (textuell 'unter' der Wurzel, tatsächlich außerhalb) wird abgelehnt — der alte Bug: 'startsWith' hätte ihn durchgelassen", () => {
    const root = tempRepo();
    const managedDir = join(root, ".worktrees");
    mkdirSync(managedDir, { recursive: true });
    const outside = join(root, "App"); // z. B. das App-Repo selbst
    mkdirSync(outside, { recursive: true });
    // Bewusst NICHT `path.join` (das würde `..` selbst schon auflösen) — ein vom Server gelieferter
    // String kann `..` roh enthalten, genau wie im echten Fund beschrieben.
    const traversal = `${managedDir}/../App`;
    expect(traversal.startsWith(managedDir + "/")).toBe(true); // genau der alte, falsche Vergleich
    expect(isManagedWorktreePath(traversal, managedDir)).toBeNull(); // realpath löst '..' auf → erkannt
  });

  it("ein Symlink innerhalb der Wurzel, der nach außen zeigt, wird ebenfalls abgelehnt", () => {
    const root = tempRepo();
    const managedDir = join(root, ".worktrees");
    mkdirSync(managedDir, { recursive: true });
    const outside = join(root, "geheim");
    mkdirSync(outside, { recursive: true });
    const link = join(managedDir, "auftrag-link");
    symlinkSync(outside, link);
    expect(isManagedWorktreePath(link, managedDir)).toBeNull();
  });

  it("ein nicht existierender Pfad ist nie 'verwaltet' (kein Absturz)", () => {
    const root = tempRepo();
    const managedDir = join(root, ".worktrees");
    mkdirSync(managedDir, { recursive: true });
    expect(isManagedWorktreePath(join(managedDir, "gibt-es-nicht"), managedDir)).toBeNull();
  });
});
