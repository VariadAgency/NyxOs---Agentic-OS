// Die Brücke liefert GOAL.md-Aufträge und den Audit-Maßnahmenplan an den Server (nur lesen,
// Datei-Wächter + Takt), der Server importiert daraus. Hier: Scanner, Sende-Logik gegen einen
// Fake-Server und einmal Ende-zu-Ende gegen den echten Server (PGlite).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { EntrySourcesIngestSchema, type EntrySourcesIngest } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { entries } from "../../server/src/db/schema.js";
import { setup } from "../../server/test/helpers.js";
import { EntrySourcesSync, scanEntrySources } from "../src/entry-sources.js";
import { noLog } from "./helpers.js";

const goal = (title: string) => `# ${title}\n\n## ZIEL\n\nEtwas bauen.\n\n## ABNAHME\n\n1. Test grün.\n`;
const AUDIT = `| Rang | Stufe | Befund | Schwere | R | Aufwand | Paket | Vorher |
|---:|---:|---|---|---:|---|---|---|
| 1 | 0 | [B-115 — Negative Seitengröße stürzt ab](../x.md) | Kritisch | 5 | S | P-B-115 | — |
`;

/** Synthetischer Mini-Projektordner: ein Repo, Doku, ein zweites Repo — dazu Dinge, die nie mitgehen. */
function miniProject() {
  const root = mkdtempSync(join(tmpdir(), "nyxos-quellen-"));
  const put = (rel: string, content: string) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };
  put("app/docs/feature-a/GOAL.md", goal("Auftrag A"));
  put("app/docs/audit-2026-09/11-Plan/MASSNAHMENPLAN.md", AUDIT);
  put("app/docs/feature-a/SPEC.md", "keine Quelle");
  put("app/docs/node_modules/x/GOAL.md", goal("Paket-Müll"));
  put("doku/produkt/GOAL.md", goal("Doku-Auftrag"));
  put("werkzeug/auftraege/P1-fundament/GOAL.md", goal("P1 Fundament"));
  put("app/.worktrees/kopie/docs/feature-a/GOAL.md", goal("Arbeitskopie"));
  put(".archiv/alt/GOAL.md", goal("Archiv"));
  return { root, put };
}

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops.length = 0;
});

async function waitFor<T>(fn: () => Promise<T | false | undefined | null> | T | false | undefined | null, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("Zeitüberschreitung beim Warten");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("scanEntrySources", () => {
  it("findet nur kanonische GOAL.md und Maßnahmenpläne, keine Arbeitskopien/versteckten Ordner/node_modules", async () => {
    const p = miniProject();
    const scan = await scanEntrySources([p.root]);
    expect(scan.complete).toBe(true);
    expect(scan.files.map((f) => f.path).sort()).toEqual([
      "app/docs/audit-2026-09/11-Plan/MASSNAHMENPLAN.md",
      "app/docs/feature-a/GOAL.md",
      "doku/produkt/GOAL.md",
      "werkzeug/auftraege/P1-fundament/GOAL.md",
    ]);
    expect(scan.files.find((f) => f.path === "app/docs/feature-a/GOAL.md")?.content).toContain("# Auftrag A");
  });

  it("fehlt ein Projektordner, ist die Liste unvollständig (Server markiert dann nichts als entfernt)", async () => {
    const p = miniProject();
    const missing = join(p.root, "gibt-es-nicht");
    const scan = await scanEntrySources([p.root, missing]);
    expect(scan.complete).toBe(false);
    expect(scan.errors.join(" ")).toContain("gibt-es-nicht");
    expect(scan.files.length).toBe(4);
  });

  it("mehrere Projektordner: Pfade relativ zum jeweiligen Ordner", async () => {
    const a = miniProject();
    const b = mkdtempSync(join(tmpdir(), "nyxos-quellen-b-"));
    mkdirSync(join(b, "extra"), { recursive: true });
    writeFileSync(join(b, "extra", "GOAL.md"), goal("Aus B"));
    const scan = await scanEntrySources([a.root, b]);
    expect(scan.files.map((f) => f.path)).toContain("extra/GOAL.md");
    expect(scan.files).toHaveLength(5);
  });

  it("folgt keinen Verknüpfungen (Symlinks) — nichts von außerhalb der Quell-Ordner geht raus", async () => {
    const p = miniProject();
    const outside = mkdtempSync(join(tmpdir(), "nyxos-aussen-"));
    stops.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "geheim.env"), "API_KEY=geheim");
    mkdirSync(join(outside, "ordner"));
    writeFileSync(join(outside, "ordner", "GOAL.md"), goal("Von außerhalb"));
    mkdirSync(join(p.root, "app/docs/verlinkt"), { recursive: true });
    symlinkSync(join(outside, "geheim.env"), join(p.root, "app/docs/verlinkt/GOAL.md"));
    symlinkSync(join(outside, "ordner"), join(p.root, "app/docs/ordner-link"));
    const scan = await scanEntrySources([p.root]);
    expect(scan.files.map((f) => f.path)).not.toContain("app/docs/verlinkt/GOAL.md");
    expect(scan.files.map((f) => f.path)).not.toContain("app/docs/ordner-link/GOAL.md");
    expect(JSON.stringify(scan.files)).not.toContain("geheim");
    expect(JSON.stringify(scan.files)).not.toContain("Von außerhalb");
  });
});

function fakeServer(opts: { failFirst?: number } = {}) {
  const calls: { url: string; auth: string | null; body: EntrySourcesIngest }[] = [];
  let failures = opts.failFirst ?? 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (failures > 0) {
      failures--;
      return new Response("kaputt", { status: 500 });
    }
    const body = EntrySourcesIngestSchema.parse(JSON.parse(String(init?.body)));
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("EntrySourcesSync", () => {
  it("schickt beim Start die volle Liste, danach nur bei Änderung (Datei-Wächter)", async () => {
    const p = miniProject();
    const srv = fakeServer();
    const sync = new EntrySourcesSync({ projectRoots: [p.root], serverUrl: "http://srv", token: "tok" }, noLog, srv.fetchImpl, { debounceMs: 50, intervalMs: 0 });
    stops.push(() => sync.stop());
    await sync.start();
    expect(srv.calls).toHaveLength(1);
    expect(srv.calls[0]?.url).toBe("http://srv/ingest/entry-sources");
    expect(srv.calls[0]?.auth).toBe("Bearer tok");
    expect(srv.calls[0]?.body.complete).toBe(true);
    expect(srv.calls[0]?.body.files).toHaveLength(4);

    await sync.syncNow();
    expect(srv.calls).toHaveLength(1); // nichts geändert → nichts geschickt

    p.put("app/docs/feature-b/GOAL.md", goal("Auftrag B"));
    await waitFor(() => srv.calls.length === 2);
    expect(srv.calls[1]?.body.files.map((f) => f.path)).toContain("app/docs/feature-b/GOAL.md");
    expect(sync.status.lastOkAt).not.toBeNull();
  });

  it("Server-Fehler → später erneut, nie werfen", async () => {
    const p = miniProject();
    const srv = fakeServer({ failFirst: 1 });
    const sync = new EntrySourcesSync({ projectRoots: [p.root], serverUrl: "http://srv", token: "tok" }, noLog, srv.fetchImpl, { debounceMs: 20, intervalMs: 0, minBackoffMs: 30 });
    stops.push(() => sync.stop());
    await sync.start();
    expect(srv.calls).toHaveLength(0);
    expect(sync.status.lastError).toContain("500");
    await waitFor(() => srv.calls.length === 1);
    expect(sync.status.lastError).toBeNull();
  });

  it("gibt es keinen der Projektordner, schickt sie nichts", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "nyxos-leer-")), "weg");
    const srv = fakeServer();
    const sync = new EntrySourcesSync({ projectRoots: [root], serverUrl: "http://srv", token: "tok" }, noLog, srv.fetchImpl, { debounceMs: 20, intervalMs: 0, watch: false });
    stops.push(() => sync.stop());
    await sync.start();
    expect(srv.calls).toHaveLength(0);
    expect(sync.status.lastError).toContain("Keiner der Projektordner");
  });
});

describe("Brücke → echter Server (PGlite)", () => {
  it("Lieferung landet als Aufgaben + Audit-Befunde; gelöschte GOAL.md wird „Quelle entfernt“", async () => {
    const srv = await setup();
    const server = serve({ fetch: srv.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
    stops.push(() => void server.close());
    const p = miniProject();
    const sync = new EntrySourcesSync(
      { projectRoots: [p.root], serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "test-token-123" },
      noLog,
      fetch,
      { debounceMs: 50, intervalMs: 0 },
    );
    stops.push(() => sync.stop());
    await sync.start();
    const rows = await srv.db.select().from(entries);
    expect(rows.filter((r) => r.kind === "aufgabe").map((r) => r.title).sort()).toEqual(["Auftrag A", "Doku-Auftrag", "P1 Fundament"]);
    expect(rows.filter((r) => r.kind === "audit").map((r) => r.sourceId)).toEqual(["B-115"]);

    rmSync(join(p.root, "app/docs/feature-a/GOAL.md"));
    await waitFor(async () => {
      const row = (await srv.db.select().from(entries)).find((r) => r.sourceId === "app/docs/feature-a/GOAL.md");
      return row?.sourceRemovedAt ? row : null;
    });
  });
});
