import { describe, expect, it } from "vitest";
import {
  baustelleFromFolder,
  buildCorrectionCondition,
  categorize,
  computeDominantFolder,
  extractKeyword,
  projectOf,
  type CategorizeFeatures,
  type CorrectionStats,
  type SortRule,
} from "../src/categorize.js";

const feat = (over: Partial<CategorizeFeatures> = {}): CategorizeFeatures => ({
  dominantFolder: null,
  cwd: null,
  skills: [],
  title: null,
  firstPrompt: null,
  writeFileCount: 0,
  ...over,
});

describe("categorize (Tabellen-Tests)", () => {
  it("Stufe 1 (Ordner): ein Audit-Ordner im Projekt bestimmt Art 'audit'", () => {
    const r = categorize(feat({ dominantFolder: "shop/audits" }), []);
    expect(r.art).toBe("audit");
    expect(r.reason.some((x) => x.stage === "folder" && x.detail.includes("shop/audits"))).toBe(true);
  });

  it("Stufe 2 (cwd): greift nur, wenn der Ordner (Stufe 1) nichts liefert", () => {
    const r = categorize(feat({ dominantFolder: null, cwd: "/Users/alex/projects/audits" }), []);
    expect(r.art).toBe("audit");
    expect(r.reason.some((x) => x.stage === "cwd")).toBe(true);
  });

  it("Stufe 3 (Skill): 'review' und 'code-review' bestimmen Art 'audit'", () => {
    expect(categorize(feat({ skills: ["review"] }), []).art).toBe("audit");
    const r = categorize(feat({ skills: ["code-review"], writeFileCount: 3 }), []);
    expect(r.art).toBe("audit");
    expect(r.reason.some((x) => x.stage === "skill" && x.detail === "Skill code-review")).toBe(true);
  });

  it("Stufe 4 (Titel-Schlagwort): Server-Wortfeld vor Audit vor Recherche", () => {
    expect(categorize(feat({ title: "Postgres 18 upgrade" }), []).art).toBe("server");
    expect(categorize(feat({ title: "Shop code audit und Refactoring-plan" }), []).art).toBe("audit");
    expect(categorize(feat({ title: "Zahlungsanbieter Recherche" }), []).art).toBe("recherche");
    expect(categorize(feat({ title: "Server-Audit heute" }), []).art).toBe("server");
  });

  it("Stufe 4: 'Planung' zählt nur ohne Datei-Änderungen, sonst gewinnt der Coding-Rückfall", () => {
    expect(categorize(feat({ title: "Planung Community-Feed", writeFileCount: 0 }), []).art).toBe("planung");
    expect(categorize(feat({ title: "Community-Feed Planung und Änderungen", writeFileCount: 12 }), []).art).toBe("coding");
  });

  it("Rückfall: Datei-Änderungen ohne anderen Treffer → 'coding'", () => {
    const r = categorize(feat({ title: "Aktionsfeed Promotion Bug", writeFileCount: 4 }), []);
    expect(r.art).toBe("coding");
    expect(r.reason.some((x) => x.stage === "fallback")).toBe(true);
  });

  it("Unsortiert ohne jeden Treffer (kein Ordner, kein Skill, kein Titel-Wort, keine Datei-Änderung)", () => {
    const r = categorize(feat(), []);
    expect(r.art).toBe("unsortiert");
    expect(r.baustelle).toBeNull();
    expect(r.reason).toEqual([{ stage: "unsortiert", detail: "kein Treffer", ruleId: null, dim: "art" }]);
  });

  it("Art und Baustelle können aus verschiedenen Stufen kommen (Baustelle aus Ordner, Art aus Titel-Wort)", () => {
    const r = categorize(feat({ dominantFolder: "shop/.worktrees/a02-checkout", title: "Checkout-Rolle Design-Audit", writeFileCount: 5 }), []);
    expect(r.art).toBe("audit");
    expect(r.baustelle).toEqual({ slug: "a02-checkout", label: "Checkout" });
    expect(r.reason.map((x) => x.stage)).toEqual(["folder", "keyword"]);
  });

  it("Worktree, Thema und Projekt ergeben je eine Baustelle, ohne Ordner keine", () => {
    expect(baustelleFromFolder("shop/.worktrees/notifications")).toEqual({ slug: "notifications", label: "Notifications" });
    expect(baustelleFromFolder("shop/billing")).toEqual({ slug: "billing", label: "Billing" });
    expect(baustelleFromFolder("shop/services/billing")).toEqual({ slug: "billing", label: "Billing" });
    expect(baustelleFromFolder("NyxOS")).toEqual({ slug: "nyxos", label: "NyxOS" });
    expect(baustelleFromFolder(null)).toBeNull();
  });

  it("Vorrang: eine aktive Baustelle-Regel (Korrektur) schlägt die Standard-Ableitung — Art bleibt unberührt", () => {
    // Eine Regel setzt nur, was korrigiert wurde. Die Art läuft hier unverändert über die Standard-Pipeline
    // ("coding", weil Schreib-Dateien ohne anderen Treffer).
    const rules: SortRule[] = [
      { id: 7, condition: { stage: "folder", value: "shop" }, dimension: "baustelle", targetArt: null, targetBaustelleSlug: "sonstiges", targetBaustelleLabel: "Sonstiges", origin: "korrektur", active: true },
    ];
    const withoutRule = categorize(feat({ dominantFolder: "shop", writeFileCount: 5 }), []);
    expect(withoutRule.art).toBe("coding");
    expect(withoutRule.baustelle).toEqual({ slug: "shop", label: "shop" });

    const r = categorize(feat({ dominantFolder: "shop", writeFileCount: 5 }), rules);
    expect(r.art).toBe("coding"); // unverändert von der Regel — nur die Baustelle wurde korrigiert
    expect(r.baustelle).toEqual({ slug: "sonstiges", label: "Sonstiges" });
    expect(r.ruleId).toBe(7);
    expect(r.reason).toEqual([
      { stage: "korrektur", detail: "Ordner shop", ruleId: 7, dim: "baustelle" },
      { stage: "fallback", detail: "Datei-Änderungen ohne anderen Treffer", ruleId: null, dim: "art" },
    ]);
  });

  it("Vorrang: eine aktive Art-Regel (Korrektur, nie über einen Ordner) schlägt die Standard-Ableitung — Baustelle bleibt unberührt", () => {
    const rules: SortRule[] = [
      { id: 8, condition: { stage: "skill", value: "review" }, dimension: "art", targetArt: "planung", targetBaustelleSlug: null, targetBaustelleLabel: null, origin: "korrektur", active: true },
    ];
    const r = categorize(feat({ dominantFolder: "shop/.worktrees/a02-checkout", skills: ["review"] }), rules);
    expect(r.art).toBe("planung"); // Regel überschreibt "audit" (Standard-Skill-Regel für "review")
    expect(r.baustelle).toEqual({ slug: "a02-checkout", label: "Checkout" }); // unverändert vom Ordner
    expect(r.ruleId).toBe(8);
    expect(r.reason).toEqual([
      { stage: "folder", detail: "Ordner shop/.worktrees/a02-checkout", ruleId: null, dim: "baustelle" },
      { stage: "korrektur", detail: "Skill review", ruleId: 8, dim: "art" },
    ]);
  });

  it("eine inaktive Regel wird übersprungen, die Standard-Pipeline greift wieder", () => {
    const rules: SortRule[] = [
      { id: 1, condition: { stage: "folder", value: "shop" }, dimension: "baustelle", targetArt: null, targetBaustelleSlug: "sonstiges", targetBaustelleLabel: "Sonstiges", origin: "korrektur", active: false },
    ];
    const r = categorize(feat({ dominantFolder: "shop", writeFileCount: 5 }), rules);
    expect(r.art).toBe("coding");
    expect(r.baustelle).toEqual({ slug: "shop", label: "shop" });
    expect(r.ruleId).toBeNull();
  });

  it("eine 'manuell'-Regel greift wie 'korrektur', nur mit anderem Grund-Label", () => {
    const rules: SortRule[] = [
      { id: 2, condition: { stage: "skill", value: "obsidian" }, dimension: "art", targetArt: "recherche", targetBaustelleSlug: null, targetBaustelleLabel: null, origin: "manuell", active: true },
    ];
    const r = categorize(feat({ skills: ["obsidian"] }), rules);
    expect(r.art).toBe("recherche");
    expect(r.reason.find((x) => x.dim === "art")?.stage).toBe("manuell");
  });

  it("eine Ordner-Regel (Baustelle) trifft auch OHNE session_files, wenn cwd im Regel-Ordner liegt", () => {
    const rules: SortRule[] = [
      { id: 9, condition: { stage: "folder", value: "nyxos" }, dimension: "baustelle", targetArt: null, targetBaustelleSlug: "nyxos", targetBaustelleLabel: "NyxOS", origin: "korrektur", active: true },
    ];
    // Neue Session ganz ohne Datei-Aktivität (dominantFolder null), aber cwd ist das Regel-Projekt.
    const r = categorize(feat({ dominantFolder: null, cwd: "/Users/alex/code/nyxos" }), rules);
    expect(r.baustelle).toEqual({ slug: "nyxos", label: "NyxOS" });
    expect(r.reason).toContainEqual({ stage: "korrektur", detail: "Ordner nyxos", ruleId: 9, dim: "baustelle" });

    // Ein Worktree des Projekts zählt noch als "im Ordner".
    const inWorktree = categorize(feat({ dominantFolder: null, cwd: "/Users/alex/code/nyxos/.worktrees/agent-1" }), rules);
    expect(inWorktree.baustelle?.slug).toBe("nyxos");

    // Mit echter Datei-Aktivität bleibt der dominante Ordner maßgeblich — cwd zählt dann NICHT mehr
    // als Ersatz, wenn der dominante Ordner ein anderer ist.
    const withFiles = categorize(feat({ dominantFolder: "shop", cwd: "/Users/alex/code/nyxos", writeFileCount: 3 }), rules);
    expect(withFiles.baustelle?.slug).not.toBe("nyxos");
  });
});

describe("projectOf", () => {
  it("Projekt aus dem Arbeitsordner, Worktrees zählen zu ihrem Repo", () => {
    expect(projectOf("/Users/alex/projects/shop")).toEqual({ root: "/Users/alex/projects/shop", name: "shop", worktree: null });
    expect(projectOf("/Users/alex/projects/shop/.worktrees/checkout")).toEqual({ root: "/Users/alex/projects/shop", name: "shop", worktree: "checkout" });
    expect(projectOf("/Users/alex/projects/shop/.claude/worktrees/agent-1/src")).toEqual({ root: "/Users/alex/projects/shop", name: "shop", worktree: "agent-1" });
    expect(projectOf(null)).toBeNull();
    expect(projectOf("relativ/pfad")).toBeNull();
  });
});

describe("Thema innerhalb eines Projekts (feiner als das ganze Projekt)", () => {
  const P = "/Users/alex/projects/shop/";
  const cwd = "/Users/alex/projects/shop";
  const files = (paths: string[], mode = "write") => paths.map((p) => ({ path: `${P}${p}`, mode }));

  it("ein Themen-Ordner mit Mehrheit bestimmt die Baustelle", () => {
    const folder = computeDominantFolder(files(["billing/a.ts", "billing/b.ts", "billing/c.ts", "README.md"]), cwd);
    expect(folder).toBe("shop/billing");
    expect(baustelleFromFolder(folder)).toEqual({ slug: "billing", label: "Billing" });
  });

  it("unter Sammel-Ordnern (services/, packages/, docs/ …) ist der Unterordner das Thema", () => {
    expect(computeDominantFolder(files(["services/messenger/a.go", "services/messenger/b.go"]), cwd)).toBe("shop/services/messenger");
    expect(computeDominantFolder(files(["docs/notification/plan.md", "docs/notification/spec.md"]), cwd)).toBe("shop/docs/notification");
  });

  it("Code und Doku desselben Themas fallen zusammen (Rollen- und Datums-Suffix fallen weg)", () => {
    expect(computeDominantFolder(files(["services/billing-service/a.ts", "services/billing-service/b.ts"]), cwd)).toBe("shop/services/billing");
    expect(computeDominantFolder(files(["docs/billing-audit-2026-09/a.md", "docs/billing-audit-2026-09/b.md"]), cwd)).toBe("shop/docs/billing");
  });

  it("keine Mehrheit (< 40 %) über viele Themen → das Projekt selbst", () => {
    const folder = computeDominantFolder(files(["a/x.ts", "a/y.ts", "b/x.ts", "b/y.ts", "c/x.ts", "c/y.ts"]), cwd);
    expect(folder).toBe("shop");
    expect(baustelleFromFolder(folder)).toEqual({ slug: "shop", label: "shop" });
  });

  it("Schwelle liegt exakt bei 40 %: 2 von 5 reicht, 2 von 6 (33 %) nicht mehr", () => {
    expect(computeDominantFolder(files(["billing/a.ts", "billing/b.ts", "x/1.ts", "y/1.ts", "z/1.ts"]), cwd)).toBe("shop/billing");
    expect(computeDominantFolder(files(["billing/a.ts", "billing/b.ts", "x/1.ts", "y/1.ts", "z/1.ts", "w/1.ts"]), cwd)).toBe("shop");
  });

  it("eine einzelne Datei allein reicht nicht für ein Thema (keine Ein-Datei-Baustelle)", () => {
    expect(computeDominantFolder(files(["billing/a.ts"]), cwd)).toBe("shop");
  });

  it("Dateien direkt in der Wurzel oder direkt in einem Sammel-Ordner werden nicht selbst zum Thema", () => {
    expect(computeDominantFolder(files(["README.md", "package.json", "services/x.ts", "docs/y.md"]), cwd)).toBe("shop");
  });

  it("Worktree-Vorrang: Dateien in einem Worktree bleiben bei der Worktree-Baustelle", () => {
    const folder = computeDominantFolder(files([".worktrees/checkout/billing/a.ts", ".worktrees/checkout/billing/b.ts"]), cwd);
    expect(folder).toBe("shop/.worktrees/checkout");
  });
});

describe("Titel gegen bekannte Baustellen (letzter Rückfall ohne jede Datei-Evidenz)", () => {
  const known: { slug: string; label: string }[] = [
    { slug: "notification", label: "Notification" },
    { slug: "checkout", label: "Checkout" },
  ];

  it("Titel-Wort trifft eine bekannte Baustelle → wird übernommen, statt 'Ohne Baustelle'", () => {
    const r = categorize(feat({ title: "Notifications-Architektur überprüfen" }), [], known);
    expect(r.baustelle).toEqual({ slug: "notification", label: "Notification" });
    expect(r.reason.some((x) => x.stage === "baustelle-titel")).toBe(true);
  });

  it("ohne Treffer gegen die bekannten Baustellen bleibt die Baustelle 'null' (keine hartkodierte Liste, kein Raten)", () => {
    const r = categorize(feat({ title: "Ganz anderes Thema ohne Bezug" }), [], known);
    expect(r.baustelle).toBeNull();
  });

  it("Ordner/cwd haben Vorrang vor dem Titel-Rückfall gegen bekannte Baustellen", () => {
    const r = categorize(feat({ dominantFolder: "NyxOS", title: "Notifications-Architektur überprüfen" }), [], known);
    expect(r.baustelle).toEqual({ slug: "nyxos", label: "NyxOS" });
  });

  it("ohne jede bekannte Baustelle (leere Liste) bleibt es bei 'null'", () => {
    const r = categorize(feat({ title: "Notifications-Architektur überprüfen" }), []);
    expect(r.baustelle).toBeNull();
  });

  it("ein einzelnes generisches Teil-Wort eines zusammengesetzten Slugs reicht NICHT ('shop' aus 'shop-app')", () => {
    const r = categorize(feat({ title: "Shop Projektstruktur reorganisieren" }), [], [{ slug: "shop-app", label: "Shop-App" }]);
    expect(r.baustelle).toBeNull();
  });

  it("Beugung/Mehrzahl im Titel trifft trotzdem (kein Wortende-Zwang): 'Notifications' findet den Slug 'notification'", () => {
    const r = categorize(feat({ title: "Notifications-Architektur überprüfen" }), [], [{ slug: "notification", label: "Notification" }]);
    expect(r.baustelle).toEqual({ slug: "notification", label: "Notification" });
  });
});

describe("computeDominantFolder (Schreiben vor Lesen)", () => {
  const cwd = "/Users/alex/projects/shop";

  it("nimmt den meistgeschriebenen Bucket, auch wenn ein anderer öfter gelesen wurde", () => {
    const files = [
      { path: `${cwd}/.worktrees/checkout/a.ts`, mode: "write" },
      { path: `${cwd}/.worktrees/checkout/b.ts`, mode: "write" },
      { path: `${cwd}/docs/x.md`, mode: "read" },
      { path: `${cwd}/docs/y.md`, mode: "read" },
      { path: `${cwd}/docs/z.md`, mode: "read" },
    ];
    expect(computeDominantFolder(files, cwd)).toBe("shop/.worktrees/checkout");
  });

  it("fällt auf die Lese-Verteilung zurück, wenn nichts geschrieben wurde", () => {
    const files = [
      { path: `${cwd}/billing/x.ts`, mode: "read" },
      { path: `${cwd}/billing/y.ts`, mode: "read" },
    ];
    expect(computeDominantFolder(files, cwd)).toBe("shop/billing");
  });

  it("ignoriert Pfade außerhalb des Projekts und liefert null ohne Treffer", () => {
    expect(computeDominantFolder([{ path: "/tmp/irgendwas.txt", mode: "write" }], cwd)).toBeNull();
    expect(computeDominantFolder([{ path: `${cwd}/a/b.ts`, mode: "write" }], null)).toBeNull();
    expect(computeDominantFolder([], cwd)).toBeNull();
  });
});

describe("buildCorrectionCondition (dimensionsscharf, nie ein Ordner für Art)", () => {
  const statsOf = (folderShares: Record<string, number> = {}, wordShares: Record<string, number> = {}): CorrectionStats => ({
    folderShare: (folder) => folderShares[folder] ?? 0,
    titleWordShare: (word) => wordShares[word.toLowerCase()] ?? 0,
  });

  it("Baustelle: nimmt den dominanten Ordner, wenn er unter der 25-%-Schwelle liegt", () => {
    const f = feat({ dominantFolder: "shop/billing" });
    expect(buildCorrectionCondition(f, "baustelle", statsOf({ "shop/billing": 0.1 }))).toEqual({ stage: "folder", value: "shop/billing" });
  });

  it("Baustelle: keine Regel, wenn der Ordner mehr als 25 % aller Haupt-Sessions dominiert (z. B. das ganze Projekt)", () => {
    const f = feat({ dominantFolder: "shop" });
    expect(buildCorrectionCondition(f, "baustelle", statsOf({ shop: 0.5 }))).toBeNull();
  });

  it("Baustelle: keine Regel ohne dominanten Ordner (nur diese Session wird zugeordnet)", () => {
    expect(buildCorrectionCondition(feat(), "baustelle", statsOf())).toBeNull();
  });

  it("Art: nimmt NIE einen Ordner — eine NyxOS-Audit-Session darf keine NyxOS-Coding-Sessions umsortieren", () => {
    const f = feat({ dominantFolder: "NyxOS", title: "NyxOS Audit" });
    // Derselbe Ordner ist hier bewusst SELTEN (10 %) — trotzdem darf die Art nie über den Ordner
    // laufen, weil im selben Ordner ganz unterschiedliche Arten vorkommen (Audit UND Coding).
    const condition = buildCorrectionCondition(f, "art", statsOf({ NyxOS: 0.1 }, { audit: 0.2 }));
    expect(condition?.stage).not.toBe("folder");
    expect(condition).toEqual({ stage: "keyword", anyOf: ["NyxOS"] }); // "audit" ist über der 15-%-Schwelle, fällt raus
  });

  it("Art: nimmt den genutzten Skill vor jedem Titel-Wort", () => {
    const f = feat({ skills: ["release-notes"], title: "Irrelevant" });
    expect(buildCorrectionCondition(f, "art", statsOf())).toEqual({ stage: "skill", value: "release-notes" });
  });

  it("Art: ein Titel-Wort über 15 % Häufigkeit erzeugt KEINE Regel (Projektname im Titel)", () => {
    const f = feat({ title: "Shop Besprechung" });
    expect(buildCorrectionCondition(f, "art", statsOf({}, { shop: 0.37, besprechung: 0.37 }))).toBeNull();
  });

  it("Art: nimmt unter der Schwelle das längste passende Titel-Wort", () => {
    const f = feat({ title: "Shop-Server-Backup" });
    expect(buildCorrectionCondition(f, "art", statsOf({}, { shop: 0.4 }))).toEqual({ stage: "keyword", anyOf: ["Server"] });
  });

  it("Art: ohne Skill und ohne tragfähiges Titel-Wort keine Regel", () => {
    expect(buildCorrectionCondition(feat({ title: "und die das" }), "art", statsOf())).toBeNull();
  });
});

describe("extractKeyword", () => {
  it("nimmt das längste bedeutungstragende Wort und lässt Stoppwörter/kurze Wörter aus", () => {
    expect(extractKeyword("Tunnel start problem")).toBe("problem");
    expect(extractKeyword("und die das zu im am")).toBeNull();
    expect(extractKeyword(null)).toBeNull();
  });
});
