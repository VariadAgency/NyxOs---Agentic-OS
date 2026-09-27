// HTTP-Ebene: /api/entries/* — dieselben Store-Funktionen, aber über die echte Route (wie die
// Web-App und die MCP-Brücke sie ansprechen).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entries } from "../src/db/schema.js";
import type { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

/** `Response.json()` ist bei `hono`/`undici` `Promise<any>` — ein eigener Helfer statt `any` an
 * jeder Aufrufstelle (kein `no-explicit-any`-Verstoß, kein `!`). */
async function j<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface EntryResponse {
  entry: { id: number; kind: string; stage: string; progressPercent: number };
}

describe("routes/entries", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("POST /api/entries legt einen Bug an, prüft sofort die Reife (bleibt geplant, keine Beschreibung)", async () => {
    const res = await ctx.post("/api/entries", { kind: "bug", title: "Neuer Bug", subtasks: ["A", "B"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { entry: { id: number; stage: string; progressPercent: number } };
    expect(body.entry.stage).toBe("geplant");
    expect(body.entry.progressPercent).toBe(0);
  });

  it("DELETE /api/entries/:id löscht NUR Einträge mit dem Test-Präfix 'Live-Update-Beweis ' (Playwright-Aufräumen)", async () => {
    const testEntry = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "bug", title: "Live-Update-Beweis chromium 123" }));
    const realEntry = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "bug", title: "Echter Bug" }));

    const deleteHeaders = { ...ctx.auth, "content-type": "application/json" }; // Pflicht für nicht-GET unter /api (app.ts)
    const deniedRes = await ctx.app.request(`/api/entries/${realEntry.entry.id}`, { method: "DELETE", headers: deleteHeaders });
    expect(deniedRes.status).toBe(403);
    expect((await ctx.app.request(`/api/entries/${realEntry.entry.id}`)).status).toBe(200); // weiterhin da

    const okRes = await ctx.app.request(`/api/entries/${testEntry.entry.id}`, { method: "DELETE", headers: deleteHeaders });
    expect(okRes.status).toBe(200);
    expect((await ctx.app.request(`/api/entries/${testEntry.entry.id}`)).status).toBe(404); // weg
  });

  it("GET /api/entries/:id liefert Großansicht-Daten (Teilaufgaben, Verknüpfungen, Verlauf)", async () => {
    const created = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "bug", title: "X", subtasks: ["T1"] }));
    const res = await ctx.app.request(`/api/entries/${created.entry.id}`);
    expect(res.status).toBe(200);
    const body = await j<{ subtasks: unknown[]; events: { kind: string }[] }>(res);
    expect(body.subtasks).toHaveLength(1);
    expect(body.events.some((e) => e.kind === "angelegt")).toBe(true);
  });

  it("POST /api/entries/:id/subtasks/complete bewegt den Fortschritt über HTTP", async () => {
    const created = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "bug", title: "Y", subtasks: ["Nur eine"] }));
    const res = await ctx.post(`/api/entries/${created.entry.id}/subtasks/complete`, { subtaskTitle: "Nur eine", sessionKey: null });
    const body = await j<EntryResponse>(res);
    expect(body.entry.progressPercent).toBe(100);
    expect(body.entry.stage).toBe("pruefen");
  });

  it("GET /api/entries?kind=bug&stage=geplant filtert", async () => {
    await ctx.post("/api/entries", { kind: "bug", title: "Bug 1" });
    await ctx.post("/api/entries", { kind: "frage", title: "Frage 1" });
    const res = await ctx.app.request("/api/entries?kind=bug");
    const body = await j<{ entries: { kind: string }[] }>(res);
    expect(body.entries.every((e) => e.kind === "bug")).toBe(true);
  });

  it("GET /api/entries/:id/start-plan liefert einen Plan (Worktree/Branch/tmux), OHNE etwas anzulegen", async () => {
    const created = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "bug", title: "NyxOS-interner Testauftrag" }));
    const res = await ctx.app.request(`/api/entries/${created.entry.id}/start-plan`);
    const plan = await j<{ anchor: string; worktreePath: string; branch: string; tmuxSocket: string }>(res);
    expect(plan.anchor).toBe("");
    expect(plan.worktreePath).toMatch(/^\.\/\.worktrees\/|^\.worktrees\/|\/\.worktrees\//);
    expect(plan.branch).toContain(`auftrag/${created.entry.id}-`);
    expect(plan.tmuxSocket).toBe("nyxos");
  });

  it("POST /api/entries/:id/start lehnt ab, wenn nicht startklar", async () => {
    const created = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "bug", title: "Nicht bereit" }));
    const res = await ctx.post(`/api/entries/${created.entry.id}/start`, {});
    expect(res.status).toBe(409);
  });

  it("POST /api/entries/:id/promote wechselt eine 'idee' mit fertigem Konzept nach 'aufgabe'/'geplant'", async () => {
    const created = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "idee", title: "Gute Idee" }));
    // Idee direkt auf "konzept_fertig" setzen (normalerweise durch den Ideen-Import).
    await ctx.db.update(entries).set({ stage: "konzept_fertig" }).where(eq(entries.id, created.entry.id));
    const res = await ctx.post(`/api/entries/${created.entry.id}/promote`, {});
    const body = await j<EntryResponse>(res);
    expect(body.entry.kind).toBe("aufgabe");
    expect(body.entry.stage).toBe("geplant");
  });

  it("POST /api/entries/:id/promote lehnt eine Idee ohne fertiges Konzept ab", async () => {
    const created = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "idee", title: "Roh" }));
    const res = await ctx.post(`/api/entries/${created.entry.id}/promote`, {});
    expect(res.status).toBe(409);
  });

  it("PATCH /api/entries/:id trägt Schätzung nach und löst den Reife-Check neu aus (→ startklar)", async () => {
    const created = await j<EntryResponse & { entry: { fileScope: string[] } }>(
      await ctx.post("/api/entries", { kind: "bug", title: "Fast fertig", description: "Ziel klar, Abnahme klar.", fileScope: ["a"] }),
    );
    const before = await ctx.app.request(`/api/entries/${created.entry.id}`);
    const beforeBody = await j<{ entry: { stage: string } }>(before);
    expect(beforeBody.entry.stage).toBe("geplant"); // fehlende Schätzung blockiert noch

    const res = await ctx.app.request(`/api/entries/${created.entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ estimate: "2 Std" }),
    });
    const body = await j<EntryResponse>(res);
    expect(body.entry.stage).toBe("startklar");
  });

  it("POST /api/entries/git/commit verknüpft per numerischer Eintrags-ID", async () => {
    const created = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "bug", title: "Z" }));
    const res = await ctx.post("/api/entries/git/commit", { sha: "abc", message: `fix: [${created.entry.id}] behoben` });
    const body = await j<{ matched: number[] }>(res);
    expect(body.matched).toEqual([created.entry.id]);
  });

  // Sicherheits-Nachbesserung: Ein-Klick-Start baute `model`/`modelSuggestion`
  // früher UNGEQUOTET in einen Shell-String, den tmux an `sh -c` weiterreicht. Reproduktion wörtlich
  // Beispiel: `PATCH {"modelSuggestion":"x; touch /tmp/pwn"}` → muss 400 geben, nie ausgeführt
  // werden. Diese Test-Gruppe verifiziert außerdem, dass der ECHTE Start (bei gültigem Modell) über
  // die Brücken-RPCs mit Argument-LISTEN läuft (`fakeBridge` protokolliert jeden Aufruf).
  describe("Ein-Klick-Start: Modell-Injektion", () => {
    function fakeBridge() {
      const calls: { method: string; params: unknown }[] = [];
      const rpc = async (method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
        calls.push({ method, params });
        if (method === "worktree_add") {
          const p = params as { kind: string; slug: string; branch: string };
          return { ok: true, result: { repoRoot: "/tmp/fake-repo", worktreePath: `/tmp/fake-repo/.claude/worktrees/${p.slug}`, branch: p.branch } };
        }
        if (method === "start") return { ok: true, result: { tmuxName: "zc-claude-abcd1234", tool: "claude", sessionId: "fake-session-id", startedMs: 5 } };
        return { ok: false, error: "unbekannte RPC in fakeBridge" };
      };
      // Strukturell erfüllt der Fake `BridgeHub.rpc(...)` schon (s. `entries/start.ts`s `BridgeRpc`);
      // `AppDeps.bridgeHub` verlangt aber die konkrete Klasse — hier bewusst durchgecastet, echte
      // Verdrahtungs-Tests der Klasse selbst laufen in `terminal.test.ts`.
      return { calls, rpc } as unknown as BridgeHub & { calls: typeof calls };
    }

    async function startklarEntry(title: string) {
      const created = await j<EntryResponse & { entry: { fileScope: string[] } }>(
        await ctx.post("/api/entries", { kind: "bug", title, description: "Ziel klar, Abnahme klar.", fileScope: ["a"] }),
      );
      await ctx.app.request(`/api/entries/${created.entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ estimate: "1 Std" }),
      });
      return created.entry.id;
    }

    it("PATCH modelSuggestion mit dem Injektions-Beispiel gibt 400, nichts wird gespeichert", async () => {
      const created = await j<EntryResponse>(await ctx.post("/api/entries", { kind: "bug", title: "Injektion PATCH" }));
      const res = await ctx.app.request(`/api/entries/${created.entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelSuggestion: "x; touch /tmp/pwn" }),
      });
      expect(res.status).toBe(400);
      const after = await j<EntryResponse & { entry: { modelSuggestion: string | null } }>(await ctx.app.request(`/api/entries/${created.entry.id}`));
      expect(after.entry.modelSuggestion).toBeNull();
    });

    it("POST .../start mit demselben Injektions-Beispiel als 'model' gibt 400 und ruft die Brücke NIE", async () => {
      const bridge = fakeBridge();
      ctx = await setup({ bridgeHub: bridge });
      const id = await startklarEntry("Injektion Start");
      const res = await ctx.post(`/api/entries/${id}/start`, { model: "x; touch /tmp/pwn" });
      expect(res.status).toBe(400);
      expect(bridge.calls).toHaveLength(0);
    });

    it("POST .../start mit gültigem Modell läuft über 'worktree_add' dann 'start', beides mit strukturierten Parametern (nie ein zusammengesetzter Shell-String)", async () => {
      const bridge = fakeBridge();
      ctx = await setup({ bridgeHub: bridge });
      const id = await startklarEntry("Echter Start");
      const res = await ctx.post(`/api/entries/${id}/start`, { model: "sonnet" });
      expect(res.status).toBe(200);
      expect(bridge.calls.map((c) => c.method)).toEqual(["worktree_add", "start"]);
      const secondCall = bridge.calls[1];
      if (!secondCall) throw new Error("erwarteter zweiter Brücken-Aufruf ('start') fehlt");
      const startParams = secondCall.params as { model: string; cwd: string; prompt: string | null };
      expect(startParams.model).toBe("sonnet");
      expect(startParams.cwd).toContain("worktrees");
      const detail = await j<EntryResponse & { entry: { tmuxName: string | null; worktreePath: string | null } }>(await ctx.app.request(`/api/entries/${id}`));
      expect(detail.entry.stage).toBe("laeuft");
      expect(detail.entry.tmuxName).toBe("zc-claude-abcd1234");
    });
  });
});

// `import/goals?root=`/`import/audit?path=` lasen bisher jeden Pfad im
// Container, auch mit dem Maschinen-Token. Feste Wurzel `NYXOS_IMPORT_ROOT` + realpath-Prüfung
// (löst `..` auf — ein naiver `startsWith` täte das nicht).
describe("Import-Wurzel: feste Grenze, per realpath geprüft (HINWEISE main)", () => {
  const savedRoot = process.env.NYXOS_IMPORT_ROOT;
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.NYXOS_IMPORT_ROOT;
    else process.env.NYXOS_IMPORT_ROOT = savedRoot;
  });

  it("POST .../import/goals?root= außerhalb der Wurzel (auch per '..') gibt 400; innerhalb funktioniert es", async () => {
    const ctx = await setup();
    const base = mkdtempSync(join(tmpdir(), "nyxos-import-root-"));
    const allowedRoot = join(base, "projects");
    const outside = join(base, "Ausserhalb");
    mkdirSync(join(allowedRoot, "App", "docs"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "GOAL.md"), "# X\n");
    process.env.NYXOS_IMPORT_ROOT = allowedRoot;

    // Textuell beginnt dieser Pfad mit der erlaubten Wurzel, `realpath` löst das `..` aber auf und
    // zeigt tatsächlich auf `outside` — genau der Bug, den ein naiver `startsWith` durchließe.
    const traversal = join(allowedRoot, "..", "Ausserhalb");
    const viaTraversal = await ctx.app.request(`/api/entries/import/goals?root=${encodeURIComponent(traversal)}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(viaTraversal.status).toBe(400);

    const direct = await ctx.app.request(`/api/entries/import/goals?root=${encodeURIComponent(outside)}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(direct.status).toBe(400); // auch ganz ohne Traversal: einfach außerhalb der Wurzel

    const ok = await ctx.app.request(`/api/entries/import/goals?root=${encodeURIComponent(allowedRoot)}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(ok.status).toBe(200);
  });

  it("POST .../import/audit?path= außerhalb der Wurzel gibt 400", async () => {
    const ctx = await setup();
    const base = mkdtempSync(join(tmpdir(), "nyxos-import-root-audit-"));
    const allowedRoot = join(base, "projects");
    mkdirSync(allowedRoot, { recursive: true });
    const outsideFile = join(base, "MASSNAHMENPLAN.md");
    writeFileSync(outsideFile, "kein Treffer\n");
    process.env.NYXOS_IMPORT_ROOT = allowedRoot;

    const res = await ctx.app.request(`/api/entries/import/audit?path=${encodeURIComponent(outsideFile)}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });

  it("ohne konfigurierte Wurzel (existiert auf diesem Server nicht) gibt 400 statt abzustürzen", async () => {
    const ctx = await setup();
    process.env.NYXOS_IMPORT_ROOT = "/pfad/den/es/hier/nicht/gibt";
    const res = await ctx.app.request(`/api/entries/import/goals?root=/pfad/den/es/hier/nicht/gibt`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });
});
