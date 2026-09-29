// Menü „⋯“ an jedem Nyx-Faden – Löschen, Archivieren (+ Archiv, zurückholen), Zusammenfassen
// (Karte im Faden), Zu Auftrag machen (Aufgabe über die Aufgaben-Schnittstelle, Link zurück), In Obsidian
// ablegen (über die Brücke). Brücke im selben Prozess (Fake-Socket) wie in den Chat-Tests mit Brücke.
import { BRIDGE_CAP_VAULT_NOTE, type HaikuMessage, type HaikuThread, type ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries, haikuMessages, haikuThreads } from "../../src/db/schema.js";
import type { BridgeHub } from "../../src/terminal/bridgeHub.js";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant-helpers.js";

type T = Awaited<ReturnType<typeof setupAssistant>>;
const TECH = /tmux|CSRF|ENOENT|nicht gefunden|bridge|rpc|undefined/i;

async function newThread(t: T, message = "Wie steht der Deploy?"): Promise<number> {
  const events = await readNdjson(await t.json("/api/haiku/chat", { message, context: CTX }));
  return (events.find((e) => e.type === "thread") as { threadId: number }).threadId;
}

async function listThreads(t: T, query = ""): Promise<(HaikuThread & { archivedAt?: string | null })[]> {
  return ((await (await t.app.request(`/api/haiku/threads${query}`)).json()) as { threads: (HaikuThread & { archivedAt?: string | null })[] }).threads;
}

async function threadMessages(t: T, id: number): Promise<HaikuMessage[]> {
  return ((await (await t.app.request(`/api/haiku/threads/${id}`)).json()) as { messages: HaikuMessage[] }).messages;
}

function fakeBridge(hub: BridgeHub, opts: { caps?: string[]; fail?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc") return;
        const params = msg.params as Record<string, unknown>;
        calls.push({ method: msg.method, params });
        const reply = opts.fail
          ? { op: "rpc_result", id: msg.id, ok: false, error: "EACCES: permission denied", code: "failed" }
          : { op: "rpc_result", id: msg.id, ok: true, result: { relPath: `01 Sessions/Nyx/2026-09-25 Nyx – ${String(params.title)}.md` } };
        queueMicrotask(() => hub.handle(JSON.stringify(reply)));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "r2", tmuxSocket: "nyxos", caps: opts.caps ?? [BRIDGE_CAP_VAULT_NOTE] }));
  return { calls };
}

describe("Faden-Menü · Archivieren", () => {
  it("archivierter Faden verschwindet aus der Liste, steht im Archiv und kommt zurück", async () => {
    const t = await setupAssistant();
    const a = await newThread(t, "Faden A");
    const b = await newThread(t, "Faden B");
    const res = await t.json(`/api/haiku/threads/${a}`, { archived: true }, "PATCH");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { thread: { archivedAt: string | null } }).thread.archivedAt).toBeTruthy();
    expect((await listThreads(t)).map((x) => x.id)).toEqual([b]);
    const archived = await listThreads(t, "?archived=1");
    expect(archived.map((x) => x.id)).toEqual([a]);
    expect(archived[0]?.archivedAt).toBeTruthy();
    // Zurückholen
    expect((await t.json(`/api/haiku/threads/${a}`, { archived: false }, "PATCH")).status).toBe(200);
    expect((await listThreads(t)).map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(await listThreads(t, "?archived=1")).toEqual([]);
  });

  it("„temporär“ umschalten geht weiter wie bisher; leerer Körper wird abgelehnt", async () => {
    const t = await setupAssistant();
    const a = await newThread(t);
    expect((await t.json(`/api/haiku/threads/${a}`, { temporary: true }, "PATCH")).status).toBe(200);
    expect((await t.json(`/api/haiku/threads/${a}`, {}, "PATCH")).status).toBe(400);
  });
});

describe("Faden-Menü · Löschen", () => {
  it("löscht Faden samt Nachrichten; unbekannter Faden → 404", async () => {
    const t = await setupAssistant();
    const a = await newThread(t);
    const keep = await newThread(t, "Bleibt");
    const res = await t.json(`/api/haiku/threads/${a}`, {}, "DELETE");
    expect(res.status).toBe(200);
    expect(await t.db.select().from(haikuThreads).where(eq(haikuThreads.id, a))).toHaveLength(0);
    expect(await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, a))).toHaveLength(0);
    expect((await listThreads(t)).map((x) => x.id)).toEqual([keep]);
    expect((await t.json(`/api/haiku/threads/${a}`, {}, "DELETE")).status).toBe(404);
  });

  it("ohne Anmeldung wird nichts gelöscht", async () => {
    const t = await setupAssistant({ signedIn: false });
    const [row] = await t.db.insert(haikuThreads).values({ scope: "full", topic: "x", day: "2026-09-25", title: "Fremd" }).returning();
    const res = await t.json(`/api/haiku/threads/${row?.id}`, {}, "DELETE");
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(await t.db.select().from(haikuThreads)).toHaveLength(1);
  });
});

// Das Menü gilt nur für des Nutzers eigene Nyx-Fäden – Gespräche über einen Ideen-Link (Gäste) bleiben unberührt.
describe("Faden-Menü · nur eigene Fäden", () => {
  it("Ideen-Link-Faden: löschen, archivieren, zusammenfassen, Aufgabe, Obsidian → 404, nichts verändert", async () => {
    const t = await setupAssistant();
    const [row] = await t.db.insert(haikuThreads).values({ scope: "idealink", topic: "ideen-link", day: "2026-09-25", title: "Gast" }).returning();
    const id = row?.id as number;
    await t.db.insert(haikuMessages).values({ threadId: id, role: "user", text: "Hallo" });
    const calls = [
      [`/api/haiku/threads/${id}`, "DELETE"],
      [`/api/haiku/threads/${id}/summary`, "POST"],
      [`/api/haiku/threads/${id}/task`, "POST"],
      [`/api/haiku/threads/${id}/obsidian`, "POST"],
    ] as const;
    for (const [path, method] of calls) expect((await t.json(path, {}, method)).status).toBe(404);
    expect((await t.json(`/api/haiku/threads/${id}`, { archived: true }, "PATCH")).status).toBe(404);
    const [still] = await t.db.select().from(haikuThreads).where(eq(haikuThreads.id, id));
    expect(still?.archivedAt).toBeNull();
    expect(await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, id))).toHaveLength(1);
    expect(await t.db.select().from(entries)).toHaveLength(0);
  });
});

describe("Faden-Menü · Zusammenfassen", () => {
  it("Nyx fasst den Faden zusammen; die Karte liegt als Notiz im Faden und zählt nicht als Gesprächsrunde", async () => {
    const engine = new FakeEngine(answer("Deploy läuft Freitag."));
    const t = await setupAssistant({ engine });
    const a = await newThread(t, "Wann deployen wir?");
    engine.script = answer("- Deploy am Freitag\n- Vorher Backup");
    const res = await t.json(`/api/haiku/threads/${a}/summary`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: HaikuMessage & { noteKind?: string } };
    expect(body.message).toMatchObject({ role: "note", noteKind: "summary", text: "- Deploy am Freitag\n- Vorher Backup" });
    // Der Motor bekam den Verlauf mit.
    const req = engine.requests.at(-1);
    expect(req?.prompt).toContain("Wann deployen wir?");
    expect(req?.prompt).toContain("Deploy läuft Freitag.");
    const msgs = await threadMessages(t, a);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "note"]);
    // Nächste Frage: die Notiz geht nicht als „Frage“ oder „Antwort“ in den Verlauf.
    engine.script = answer("Ok.");
    await readNdjson(await t.json("/api/haiku/chat", { threadId: a, message: "Und danach?", context: CTX }));
    expect(engine.requests.at(-1)?.prompt).not.toContain("Vorher Backup");
  });

  it("Motor nicht bereit: verständlicher Hinweis, keine Notiz", async () => {
    const engine = new FakeEngine(answer("x"));
    const t = await setupAssistant({ engine });
    const a = await newThread(t);
    engine.ok = false;
    const res = await t.json(`/api/haiku/threads/${a}/summary`, {});
    expect(res.status).toBe(503);
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toMatch(/Nyx/);
    expect(err).not.toMatch(TECH);
    expect((await threadMessages(t, a)).some((m) => m.role === "note")).toBe(false);
  });
});

describe("Faden-Menü · Zu Auftrag machen", () => {
  it("legt eine Aufgabe an (Titel, Beschreibung mit Verlauf + Zusammenfassung) und hängt eine Link-Karte an", async () => {
    const engine = new FakeEngine(answer("Wir brauchen einen Export."));
    const t = await setupAssistant({ engine });
    const a = await newThread(t, "Kann die NyxOS CSV exportieren?");
    engine.script = answer("Export als CSV fehlt noch.");
    await t.json(`/api/haiku/threads/${a}/summary`, {});
    const res = await t.json(`/api/haiku/threads/${a}/task`, {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { entry: { id: number; title: string; href: string }; message: HaikuMessage & { noteKind?: string } };
    expect(body.entry.href).toBe(`/tasks?e=${body.entry.id}`);
    const [row] = await t.db.select().from(entries).where(eq(entries.id, body.entry.id));
    expect(row).toMatchObject({ kind: "aufgabe", title: "Kann die NyxOS CSV exportieren?", sourceType: "nyx_thread", sourceId: String(a) });
    expect(row?.description).toContain("Export als CSV fehlt noch.");
    expect(row?.description).toContain("Kann die NyxOS CSV exportieren?");
    expect(body.message).toMatchObject({ role: "note", noteKind: "task" });
    expect(body.message.sources[0]).toMatchObject({ kind: "entry", id: String(body.entry.id), href: `/tasks?e=${body.entry.id}` });
    expect((await threadMessages(t, a)).at(-1)?.role).toBe("note");
  });

  it("unbekannter Faden → 404, nichts angelegt", async () => {
    const t = await setupAssistant();
    expect((await t.json("/api/haiku/threads/999/task", {})).status).toBe(404);
    expect(await t.db.select().from(entries)).toHaveLength(0);
  });
});

describe("Faden-Menü · In Obsidian ablegen", () => {
  it("schickt Titel + Markdown an die Brücke und legt eine Karte mit dem Ablageort in den Faden", async () => {
    const engine = new FakeEngine(answer("Antwort mit **fett**."));
    const t = await setupAssistant({ engine });
    const a = await newThread(t, "Notiz für später");
    const bridge = fakeBridge(t.bridgeHub);
    const res = await t.json(`/api/haiku/threads/${a}/obsidian`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relPath: string; message: HaikuMessage & { noteKind?: string } };
    expect(body.relPath).toBe("01 Sessions/Nyx/2026-09-25 Nyx – Notiz für später.md");
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]?.method).toBe("vault_note");
    const md = String(bridge.calls[0]?.params.markdown);
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("typ: nyx-chat");
    expect(md).toContain("Notiz für später");
    expect(md).toContain("Antwort mit **fett**.");
    expect(body.message).toMatchObject({ role: "note", noteKind: "obsidian" });
    expect(body.message.text).toContain("01 Sessions/Nyx/");
  });

  it("Mac nicht verbunden → ehrlicher Hinweis ohne Technik, keine Karte", async () => {
    const t = await setupAssistant();
    const a = await newThread(t);
    const res = await t.json(`/api/haiku/threads/${a}/obsidian`, {});
    expect(res.status).toBe(503);
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toMatch(/Mac/);
    expect(err).not.toMatch(TECH);
    expect((await threadMessages(t, a)).some((m) => m.role === "note")).toBe(false);
  });

  it("alte Brücke ohne Fähigkeit bzw. Schreibfehler → verständlicher Hinweis", async () => {
    const t = await setupAssistant();
    const a = await newThread(t);
    fakeBridge(t.bridgeHub, { caps: [] });
    const old = await t.json(`/api/haiku/threads/${a}/obsidian`, {});
    expect(old.status).toBe(409);
    expect(((await old.json()) as { error: string }).error).not.toMatch(TECH);
    fakeBridge(t.bridgeHub, { fail: true });
    const failed = await t.json(`/api/haiku/threads/${a}/obsidian`, {});
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).not.toMatch(/EACCES|TECH/);
  });
});
