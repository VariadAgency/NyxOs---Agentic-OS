// Info-Karte im lokalen Graphen — `GET /api/graph/node/:id` liefert Art, Titel, Fakten und
// einen (begrenzten) Textauszug: Notiz-Anfang, Session-Auftrag + letzte Nachricht, Eintragstext.
import { GRAPH_EXCERPT_MAX, emptyTokens, type GraphNodeDetail, type SessionSummary, type VaultNote } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries, sessionEvents } from "../src/db/schema.js";
import { setup } from "./helpers.js";

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: "/Users/x/projects/App",
  title: null,
  titleSource: null,
  startedAt: "2026-09-24T10:00:00.000Z",
  lastActivityAt: "2026-09-24T11:00:00.000Z",
  models: ["claude-opus-5-5"],
  tokens: emptyTokens(),
  toolCalls: {},
  filesWritten: [],
  filesRead: [],
  subagents: [],
  gitBranch: "feat/gehirn",
  cliVersion: null,
  eventCount: 0,
  parseErrors: 0,
  limits: null,
  lastUsage: null,
  lastUsageModel: null,
  modelContextWindow: null,
  ...over,
});
const note = (path: string, over: Partial<VaultNote> = {}): VaultNote => ({
  path,
  title: path.replace(/^.*\//, "").replace(/\.md$/, ""),
  heading: null,
  folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  tags: [],
  links: [],
  mentions: [],
  mtime: "2026-09-20T10:00:00.000Z",
  size: 100,
  ...over,
});

async function seeded() {
  const t = await setup();
  await t.post("/ingest/events", { items: [{ type: "summary", summary: summary({ sessionId: UUID, title: "Gehirn polieren" }) }] });
  await t.db.insert(sessionEvents).values([
    { id: "e1", sessionKey: `claude:${UUID}`, ts: "2026-09-24T10:00:00.000Z", kind: "prompt", source: "hook", data: { text: "Bitte das Gehirn in 3D flüssig machen." } },
    { id: "e2", sessionKey: `claude:${UUID}`, ts: "2026-09-24T10:30:00.000Z", kind: "prompt", source: "hook", data: { text: "Und die Farben bunter." } },
  ]);
  await t.db.execute(
    sql`insert into search_docs (session_key, field, position, text, tsv_german, tsv_simple) values (${`claude:${UUID}`}, 'chat', 7, 'Fertig: 3D läuft jetzt mit 60 Bildern pro Sekunde.', to_tsvector('german', 'x'), to_tsvector('simple', 'x'))`,
  );
  const long = "Wort ".repeat(400);
  const res = await t.post("/ingest/vault", {
    root: "/Users/x/Vault",
    syncId: "s1",
    mode: "full",
    done: true,
    deleted: [],
    notes: [
      note("04 Planung/Heatmap.md", { heading: "Heatmap Live", tags: ["planung"], excerpt: "Die Heatmap zeigt live, wo gerade gefeiert wird." }),
      note("02 Code/Lang.md", { excerpt: long.slice(0, 600) }),
      note("Alt.md"), // alte Brücke ohne Auszug
    ],
  });
  expect(res.status).toBe(200);
  const [entry] = await t.db.insert(entries).values({ kind: "aufgabe", title: "Farben je Art", description: "Sessions, Sub-Agenten und Notizen bunt einfärben.", stage: "geplant" }).returning({ id: entries.id });
  return { t, entryId: entry?.id ?? 0 };
}

async function detail(t: Awaited<ReturnType<typeof setup>>, id: string) {
  const res = await t.app.request(`/api/graph/node/${encodeURIComponent(id)}`);
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as GraphNodeDetail) : null };
}

describe("GET /api/graph/node/:id (Info-Karte)", () => {
  it("Session: Titel, Fakten, erster Auftrag und letzte Nachricht", async () => {
    const { t } = await seeded();
    const { status, body } = await detail(t, `session:claude:${UUID}`);
    expect(status).toBe(200);
    expect(body?.type).toBe("session");
    expect(body?.title).toBe("Gehirn polieren");
    expect(body?.excerpt).toEqual({ label: "Letzte Nachricht", text: "Fertig: 3D läuft jetzt mit 60 Bildern pro Sekunde." });
    expect(body?.extra).toEqual({ label: "Auftrag", text: "Bitte das Gehirn in 3D flüssig machen." });
    const facts = Object.fromEntries(body?.facts ?? []);
    expect(facts.Werkzeug).toBe("Claude");
    expect(facts.Zweig).toBe("feat/gehirn");
    // auch mit nackter Session-ID
    expect((await detail(t, UUID)).body?.id).toBe(`session:claude:${UUID}`);
  });

  it("Notiz: Überschrift, Ordner, Tags und Notiz-Anfang (begrenzt); alte Brücke ohne Auszug → null", async () => {
    const { t } = await seeded();
    const n = (await detail(t, "note:04 Planung/Heatmap.md")).body;
    expect(n?.title).toBe("Heatmap Live");
    expect(n?.excerpt).toEqual({ label: "Notiz-Anfang", text: "Die Heatmap zeigt live, wo gerade gefeiert wird." });
    expect(Object.fromEntries(n?.facts ?? []).Ordner).toBe("04 Planung");
    const lang = (await detail(t, "note:02 Code/Lang.md")).body;
    expect((lang?.excerpt?.text.length ?? 0) <= GRAPH_EXCERPT_MAX).toBe(true);
    expect((await detail(t, "note:Alt.md")).body?.excerpt).toBeNull();
  });

  it("Eintrag: Titel, Stand und Beschreibung", async () => {
    const { t, entryId } = await seeded();
    const e = (await detail(t, `entry:${entryId}`)).body;
    expect(e?.type).toBe("task");
    expect(e?.title).toBe("Farben je Art");
    expect(e?.excerpt?.text).toBe("Sessions, Sub-Agenten und Notizen bunt einfärben.");
    expect(Object.fromEntries(e?.facts ?? []).Stand).toBe("geplant");
  });

  it("unbekannt → 404, Antwort kommt beim zweiten Mal aus dem Zwischenspeicher", async () => {
    const { t } = await seeded();
    expect((await detail(t, "note:gibt es nicht.md")).status).toBe(404);
    const a = await t.app.request(`/api/graph/node/${encodeURIComponent("note:04 Planung/Heatmap.md")}`);
    expect(a.headers.get("x-cache")).toBe("miss");
    const b = await t.app.request(`/api/graph/node/${encodeURIComponent("note:04 Planung/Heatmap.md")}`);
    expect(b.headers.get("x-cache")).toBe("hit");
  });
});
