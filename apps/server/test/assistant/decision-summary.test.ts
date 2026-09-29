// „Nyx fragen“ an jeder Entscheidung: POST /api/inbox/:id/nyx-summary und /api/approvals/:id/nyx-summary.
// Nyx liefert genau drei Teile, läuft OHNE Werkzeuge (kann nie freigeben/antworten), Kosten im Protokoll,
// kaputte Antwort → ehrlicher Fehler, schreibende Wege nur mit Anmeldung + CSRF.
import type { DecisionSummary } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { approvals, haikuCalls, inboxItems } from "../../src/db/schema.js";
import { createInboxItem, YES_NO } from "../../src/haiku/inbox.js";
import { parseDecisionSummary } from "../../src/haiku/decisionSummary.js";
import { answer, FakeEngine, setupAssistant } from "./assistant-helpers.js";

const good = JSON.stringify({
  worum: "Eine Session will 126 alte Worktrees löschen.",
  empfehlung: { wahl: "Ablehnen", grund: "Löschen ist nicht umkehrbar, erst die Liste prüfen." },
  wichtig: ["Nicht gemergte Arbeit geht verloren.", "Regel festhalten: Worktrees nur nach Merge löschen."],
});

async function seed(db: Awaited<ReturnType<typeof setupAssistant>>["db"]) {
  const { item } = await createInboxItem(db, { kind: "frage", title: "Alle alten Worktrees löschen (126 Stück)?", body: "Aufräumen in .worktrees.", options: YES_NO, createdBy: "session", sessionKey: "claude:t01" });
  const [appr] = await db
    .insert(approvals)
    .values({ rule: "git_push", reason: "git push ist eine Freigabe von Alex", tool: "Bash", command: "git push origin auftrag/t-01", commandHash: "h1", sessionKey: "claude:t01", auftrag: "T-01" })
    .returning();
  return { item, approvalId: appr?.id ?? 0 };
}

describe("Nyx-Einschätzung zu Entscheidungen", () => {
  it("liefert gültiges JSON mit drei Teilen, läuft ohne Werkzeuge und merkt sich das Ergebnis je Eintrag", async () => {
    const engine = new FakeEngine(answer(`Hier: ${good}`));
    const t = await setupAssistant({ engine });
    const { item } = await seed(t.db);

    const res = await t.json(`/api/inbox/${item.id}/nyx-summary`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: DecisionSummary };
    expect(body.summary.worum).toContain("126");
    expect(body.summary.empfehlung).toEqual({ wahl: "Ablehnen", grund: expect.stringContaining("nicht umkehrbar") });
    expect(body.summary.wichtig).toHaveLength(2);
    expect(body.summary.cached).toBe(false);

    // Keine Werkzeuge: Nyx kann hier weder freigeben noch antworten.
    expect(engine.requests).toHaveLength(1);
    const req = engine.requests[0];
    expect(req?.scope).toBe("none");
    expect(req?.tools).toEqual([]);
    expect(req?.toolDefs).toEqual([]);
    expect(req?.prompt).toContain("Alle alten Worktrees löschen");
    // Befehle/Texte/Session-Titel stammen aus Sessions – Nyx muss sie als Daten behandeln, nicht als Auftrag.
    expect(req?.systemPrompt).toMatch(/keine Anweisungen an dich/);
    // Kosten im bestehenden Protokoll.
    expect(await t.db.select().from(haikuCalls)).toHaveLength(1);
    // Eintrag unverändert offen.
    const [row] = await t.db.select().from(inboxItems).where(eq(inboxItems.id, item.id));
    expect(row?.status).toBe("open");

    // Zweiter Klick: aus dem Speicher, kein neuer Lauf.
    const again = (await (await t.json(`/api/inbox/${item.id}/nyx-summary`, {})).json()) as { summary: DecisionSummary };
    expect(again.summary.cached).toBe(true);
    expect(engine.requests).toHaveLength(1);
    // „Neu fragen“ läuft wieder.
    await t.json(`/api/inbox/${item.id}/nyx-summary`, { fresh: true });
    expect(engine.requests).toHaveLength(2);
  });

  it("Freigabe-Anfragen: Befehl, Regel und Knopf-Folgen gehen an Nyx; Status bleibt offen", async () => {
    const engine = new FakeEngine(answer(good));
    const t = await setupAssistant({ engine });
    const { approvalId } = await seed(t.db);
    const res = await t.json(`/api/approvals/${approvalId}/nyx-summary`, {});
    expect(res.status).toBe(200);
    const prompt = engine.requests[0]?.prompt ?? "";
    expect(prompt).toContain("git push origin auftrag/t-01");
    expect(prompt).toContain("git push (git_push)");
    expect(prompt).toContain("Freigeben: die Session darf genau diesen Befehl EINMAL");
    expect(prompt).toContain("Alle alten Worktrees löschen"); // Verlauf derselben Session
    expect(engine.requests[0]?.scope).toBe("none");
    const [row] = await t.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("pending");
  });

  it("kaputte Modell-Antwort → ehrlicher Fehler (502), nichts gemerkt", async () => {
    const engine = new FakeEngine(answer('{"worum":"nur ein Teil"}'));
    const t = await setupAssistant({ engine });
    const { item } = await seed(t.db);
    const res = await t.json(`/api/inbox/${item.id}/nyx-summary`, {});
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/keine brauchbare Einschätzung/);
    engine.script = answer(good);
    const ok = (await (await t.json(`/api/inbox/${item.id}/nyx-summary`, {})).json()) as { summary: DecisionSummary };
    expect(ok.summary.cached).toBe(false);
  });

  it("unbekannte ID → 404 ohne Lauf; Motor aus → 503 mit Klartext", async () => {
    const engine = new FakeEngine(answer(good));
    const t = await setupAssistant({ engine });
    expect((await t.json("/api/inbox/999/nyx-summary", {})).status).toBe(404);
    expect((await t.json("/api/approvals/999/nyx-summary", {})).status).toBe(404);
    expect((await t.json("/api/inbox/abc/nyx-summary", {})).status).toBe(404);
    expect(engine.requests).toHaveLength(0);
    const { item } = await seed(t.db);
    engine.ok = false;
    const res = await t.json(`/api/inbox/${item.id}/nyx-summary`, {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(5);
  });

  it("braucht Anmeldung und CSRF", async () => {
    const engine = new FakeEngine(answer(good));
    const t = await setupAssistant({ engine, signedIn: false });
    const { item, approvalId } = await seed(t.db);
    expect((await t.json(`/api/inbox/${item.id}/nyx-summary`, {})).status).toBe(401);
    expect((await t.json(`/api/approvals/${approvalId}/nyx-summary`, {})).status).toBe(401);
    const csrfless = await t.app.request(`/api/inbox/${item.id}/nyx-summary`, { method: "POST", body: "{}", headers: { "content-type": "application/json", cookie: t.authHeaders.cookie ?? "" } });
    expect(csrfless.status).toBe(403);
    expect(engine.requests).toHaveLength(0);
  });

  it("Parser: verlangt alle drei Teile, kürzt auf höchstens vier Punkte", () => {
    expect(parseDecisionSummary("kein json")).toBeNull();
    expect(parseDecisionSummary(JSON.stringify({ worum: "x", empfehlung: { wahl: "Ja", grund: "y" }, wichtig: [] }))).toBeNull();
    expect(parseDecisionSummary(JSON.stringify({ worum: "x", empfehlung: { wahl: "", grund: "y" }, wichtig: ["a"] }))).toBeNull();
    const p = parseDecisionSummary(JSON.stringify({ worum: "x", empfehlung: { wahl: "Ja", grund: "y" }, wichtig: ["a", "b", "c", "d", "e", 3] }));
    expect(p?.wichtig).toEqual(["a", "b", "c", "d"]);
  });
});
