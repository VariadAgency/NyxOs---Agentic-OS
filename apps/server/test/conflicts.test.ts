import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { checkReservationConflict, computeCollisionMap, globOverlaps, recordConflictEvent, releaseArea, reserveArea } from "../src/conflicts/store.js";
import { checkFolderConflictRule, listRules } from "../src/lessons/learn.js";
import { sessionFiles, sessions } from "../src/db/schema.js";
import { setup } from "./helpers.js";

async function makeSession(db: Awaited<ReturnType<typeof setup>>["db"], id: string, title: string) {
  const sessionId = id.split(":")[1] ?? id;
  // Konflikte nur zwischen lebenden Sessions.
  await db.insert(sessions).values({ id, tool: "claude", sessionId, title, state: "running" });
}

describe("Kollisionskarte", () => {
  it("zwei offene Sessions schreiben dieselbe Datei → 'conflict'", async () => {
    const { db } = await setup();
    await makeSession(db, "claude:a", "Session A");
    await makeSession(db, "claude:b", "Session B");
    await db.insert(sessionFiles).values([
      { sessionKey: "claude:a", path: "apps/web/src/App.tsx", mode: "write" },
      { sessionKey: "claude:b", path: "apps/web/src/App.tsx", mode: "write" },
    ]);
    const map = await computeCollisionMap(db);
    const entry = map.find((e) => e.path === "apps/web/src/App.tsx");
    expect(entry?.state).toBe("conflict");
    expect(entry?.writers).toHaveLength(2);
  });

  it("eine Session schreibt, eine liest → 'shared-read', kein Konflikt", async () => {
    const { db } = await setup();
    await makeSession(db, "claude:a", "Session A");
    await makeSession(db, "claude:b", "Session B");
    await db.insert(sessionFiles).values([
      { sessionKey: "claude:a", path: "apps/server/src/git/store.ts", mode: "write" },
      { sessionKey: "claude:b", path: "apps/server/src/git/store.ts", mode: "read" },
    ]);
    const map = await computeCollisionMap(db);
    expect(map.find((e) => e.path === "apps/server/src/git/store.ts")?.state).toBe("shared-read");
  });

  it("geschlossene Sessions zählen nicht mehr in der Kollisionskarte", async () => {
    const { db } = await setup();
    await makeSession(db, "claude:a", "Session A");
    await makeSession(db, "claude:b", "Session B");
    await db.insert(sessionFiles).values([
      { sessionKey: "claude:a", path: "x.ts", mode: "write" },
      { sessionKey: "claude:b", path: "x.ts", mode: "write" },
    ]);
    // Eine der beiden schließen: nur noch ein Schreiber übrig → kein Konflikt mehr.
    await db.update(sessions).set({ closedAt: new Date().toISOString(), closedBy: "alex" }).where(eq(sessions.id, "claude:b"));
    const entry = (await computeCollisionMap(db)).find((e) => e.path === "x.ts");
    expect(entry?.writers).toHaveLength(1);
    expect(entry?.state).toBe("ok");
  });
});

describe("globOverlaps", () => {
  it("erkennt Präfix- und Wildcard-Überlappung", () => {
    expect(globOverlaps("apps/web/**", "apps/web/src/App.tsx")).toBe(true);
    expect(globOverlaps("apps/web/src/*", "apps/web/src/App.tsx")).toBe(true);
    expect(globOverlaps("apps/bridge/**", "apps/web/src/App.tsx")).toBe(false);
  });
});

describe("Reservierungen", () => {
  it("ein zweiter überlappender Bereich ist nicht reservierbar, mit Begründung", async () => {
    const { db } = await setup();
    const first = await reserveArea(db, { pathGlob: "apps/web/src/features/git/**", label: "P5-Git-UI" });
    expect(first.ok).toBe(true);
    const second = await reserveArea(db, { pathGlob: "apps/web/src/features/git/Panel.tsx", label: "Konkurrierender Auftrag" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.check.reason).toMatch(/P5-Git-UI/);

    const check = await checkReservationConflict(db, "apps/web/src/features/git/Panel.tsx");
    expect(check.blocked).toBe(true);
  });

  it("nach Freigabe ist derselbe Bereich wieder reservierbar", async () => {
    const { db } = await setup();
    const first = await reserveArea(db, { pathGlob: "apps/server/src/lessons/**", label: "A" });
    expect(first.ok).toBe(true);
    if (first.ok) await releaseArea(db, first.reservation.id);
    const second = await reserveArea(db, { pathGlob: "apps/server/src/lessons/**", label: "B" });
    expect(second.ok).toBe(true);
  });

  it("abgelaufene Reservierungen (until in der Vergangenheit) blockieren nicht mehr", async () => {
    const { db } = await setup();
    await reserveArea(db, { pathGlob: "apps/web/src/features/server/**", label: "Alt", untilMinutes: -1 });
    const check = await checkReservationConflict(db, "apps/web/src/features/server/**");
    expect(check.blocked).toBe(false);
  });
});

describe("Lernbuch — 3 Konflikte in 7 Tagen", () => {
  it("legt erst beim dritten Konflikt im selben Ordner eine Regel an", async () => {
    const { db } = await setup();
    expect(await checkFolderConflictRule(db, "App/backend")).toBeNull();
    await recordConflictEvent(db, "kollision", "App/backend", "App/backend/a.swift");
    await recordConflictEvent(db, "kollision", "App/backend", "App/backend/b.swift");
    expect((await listRules(db)).filter((r) => r.kind === "konflikt")).toHaveLength(0);
    await recordConflictEvent(db, "kollision", "App/backend", "App/backend/c.swift");
    const rules = await listRules(db);
    const rule = rules.find((r) => r.kind === "konflikt");
    expect(rule).toBeDefined();
    expect(rule?.condition).toEqual({ folder: "App/backend" });
    expect(rule?.origin).toMatch(/gelernt am/);
    expect(rule?.active).toBe(true);
  });

  it("eine abgeschaltete Regel wirkt nicht mehr ('abschaltbar')", async () => {
    const { db } = await setup();
    await recordConflictEvent(db, "kollision", "App/ios", "a");
    await recordConflictEvent(db, "kollision", "App/ios", "b");
    await recordConflictEvent(db, "kollision", "App/ios", "c");
    const rules = await listRules(db);
    const rule = rules.find((r) => r.kind === "konflikt");
    expect(rule).toBeDefined();
    if (!rule) throw new Error("Regel wurde nicht angelegt");
    const { setRuleActive } = await import("../src/lessons/learn.js");
    await setRuleActive(db, rule.id, false);
    const after = (await listRules(db)).find((r) => r.id === rule.id);
    expect(after?.active).toBe(false);
  });

  it("eine abgeschaltete Regel wird NICHT durch einen weiteren Konflikt im selben Ordner reaktiviert/dupliziert", async () => {
    const { db } = await setup();
    const { setRuleActive } = await import("../src/lessons/learn.js");
    await recordConflictEvent(db, "kollision", "App/backend", "a");
    await recordConflictEvent(db, "kollision", "App/backend", "b");
    await recordConflictEvent(db, "kollision", "App/backend", "c");
    const rule = (await listRules(db)).find((r) => r.kind === "konflikt");
    if (!rule) throw new Error("Regel wurde nicht angelegt");
    await setRuleActive(db, rule.id, false);

    // Ein weiterer Konflikt im selben Ordner darf die Regel NICHT stillschweigend wieder aktivieren
    // oder eine zweite anlegen.
    await recordConflictEvent(db, "kollision", "App/backend", "d");
    const rulesAfter = (await listRules(db)).filter((r) => r.kind === "konflikt" && (r.condition as { folder?: string }).folder === "App/backend");
    expect(rulesAfter).toHaveLength(1);
    expect(rulesAfter[0]?.active).toBe(false);
  });

  it("Probe-Merge-Konflikte (kind='merge') lösen KEINE Ordner-Regel aus (Ordner wäre die ganze Repo-Wurzel)", async () => {
    const { db } = await setup();
    await recordConflictEvent(db, "merge", "/Users/alex/projects/App", "app@feature/x");
    await recordConflictEvent(db, "merge", "/Users/alex/projects/App", "app@feature/y");
    await recordConflictEvent(db, "merge", "/Users/alex/projects/App", "app@feature/z");
    expect((await listRules(db)).filter((r) => r.kind === "konflikt")).toHaveLength(0);
  });

  it("eine gelernte 'konflikt'-Regel blockiert eine neue Reservierung im selben Ordner (wirkt beim Start)", async () => {
    const { db } = await setup();
    await recordConflictEvent(db, "kollision", "App/backend", "a");
    await recordConflictEvent(db, "kollision", "App/backend", "b");
    await recordConflictEvent(db, "kollision", "App/backend", "c");
    const blocked = await checkReservationConflict(db, "App/backend/Sources/Foo.swift");
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toMatch(/Gelernte Regel/);

    // Nach dem Abschalten wirkt sie nicht mehr.
    const rule = (await listRules(db)).find((r) => r.kind === "konflikt");
    if (!rule) throw new Error("Regel fehlt");
    const { setRuleActive } = await import("../src/lessons/learn.js");
    await setRuleActive(db, rule.id, false);
    const allowed = await checkReservationConflict(db, "App/backend/Sources/Foo.swift");
    expect(allowed.blocked).toBe(false);
  });

  it("'App/backend' blockiert NICHT 'App/backend-alt' (Pfad-Trenner-sicherer Vergleich)", async () => {
    const { db } = await setup();
    await recordConflictEvent(db, "kollision", "App/backend", "a");
    await recordConflictEvent(db, "kollision", "App/backend", "b");
    await recordConflictEvent(db, "kollision", "App/backend", "c");
    const result = await checkReservationConflict(db, "App/backend-alt/Foo.swift");
    expect(result.blocked).toBe(false);
  });
});
