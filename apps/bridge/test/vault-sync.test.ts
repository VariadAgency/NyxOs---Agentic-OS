import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VaultIngestSchema, type VaultIngest } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { VaultScanner } from "../src/vault/scan.js";
import { VaultSync } from "../src/vault/sync.js";
import { noLog } from "./helpers.js";

/** Synthetischer Mini-Vault (keine echten Vault-Inhalte). */
function miniVault() {
  const root = mkdtempSync(join(tmpdir(), "nyxos-vault-"));
  const put = (rel: string, content: string) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };
  put("Start.md", "# Start\n[[Idee A]] [[Ordner/Tief]]");
  put("Ideen/Idee A.md", "---\ntags: [idee]\n---\nZurück zu [[Start]]");
  put("Ordner/Tief.md", "Session aaaaaaaa-0000-4000-8000-000000000001");
  put(".obsidian/workspace.md", "[[Versteckt]]");
  put(".trash/Alt.md", "[[Weg]]");
  put("node_modules/x/readme.md", "nein");
  put("Bilder/bild.png", "png");
  return { root, put };
}

interface Call {
  url: string;
  auth: string | null;
  body: VaultIngest;
}

/** Fake-Server: zeichnet Anfragen auf, prüft das Schema und zählt gleichzeitige Anfragen. */
function fakeServer(opts: { failFirst?: number; status?: number; delayMs?: number } = {}) {
  const calls: Call[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let failures = opts.failFirst ?? 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (failures > 0) {
        failures--;
        if (opts.status) return new Response("kaputt", { status: opts.status });
        throw new Error("ECONNREFUSED");
      }
      const body = VaultIngestSchema.parse(JSON.parse(String(init?.body)));
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get("authorization"), body });
      return Response.json({ ok: true, upserted: body.notes.length, deleted: body.deleted.length });
    } finally {
      inflight--;
    }
  }) as typeof fetch;
  return { calls, fetchImpl, maxInflight: () => maxInflight };
}

async function until(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("Zeitüberschreitung");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const syncs: VaultSync[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of syncs.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeSync(root: string, fetchImpl: typeof fetch, opts: ConstructorParameters<typeof VaultSync>[3] = {}) {
  dirs.push(root);
  const s = new VaultSync({ vaultDir: root, serverUrl: "http://srv", token: "tok" }, noLog, fetchImpl, { debounceMs: 40, minBackoffMs: 20, maxBackoffMs: 40, ...opts });
  syncs.push(s);
  return s;
}

describe("VaultScanner", () => {
  it("findet nur sichtbare .md-Dateien, ohne .obsidian/.trash/node_modules, folgt keinen Symlinks", async () => {
    const { root, put } = miniVault();
    dirs.push(root);
    const outside = mkdtempSync(join(tmpdir(), "nyxos-vault-aussen-"));
    dirs.push(outside);
    writeFileSync(join(outside, "Fremd.md"), "x");
    symlinkSync(outside, join(root, "Verknuepft"));
    symlinkSync(join(outside, "Fremd.md"), join(root, "Link.md"));
    put("Gross.MD", "Grossbuchstaben-Endung");
    const scanner = new VaultScanner(root);
    const notes = await scanner.scanAll();
    expect(notes.map((n) => n.path).sort()).toEqual(["Gross.MD", "Ideen/Idee A.md", "Ordner/Tief.md", "Start.md"]);
    expect(notes.find((n) => n.path === "Gross.MD")?.title).toBe("Gross");
  });

  it("parst unveränderte Dateien beim erneuten Vollscan nicht neu (Cache)", async () => {
    const { root, put } = miniVault();
    dirs.push(root);
    const scanner = new VaultScanner(root);
    await scanner.scanAll();
    expect(scanner.parsedCount).toBe(3);
    await scanner.scanAll();
    expect(scanner.parsedCount).toBe(3);
    await new Promise((r) => setTimeout(r, 15));
    put("Start.md", "# Start neu, länger als vorher\n[[Idee A]]");
    const notes = await scanner.scanAll();
    expect(scanner.parsedCount).toBe(4);
    expect(notes.find((n) => n.path === "Start.md")?.links).toEqual(["Idee A"]);
  });
});

describe("VaultSync", () => {
  it("Vollabgleich beim Start: Token, Pfad, Schema, done am Ende", async () => {
    const { root } = miniVault();
    const srv = fakeServer();
    const s = makeSync(root, srv.fetchImpl, { watch: false });
    await s.start();
    await until(() => srv.calls.length === 1);
    const [c] = srv.calls;
    expect(c?.url).toBe("http://srv/ingest/vault");
    expect(c?.auth).toBe("Bearer tok");
    expect(c?.body.mode).toBe("full");
    expect(c?.body.done).toBe(true);
    expect(c?.body.root).toBe(root);
    expect(c?.body.notes.map((n) => n.path).sort()).toEqual(["Ideen/Idee A.md", "Ordner/Tief.md", "Start.md"]);
    expect(c?.body.notes.find((n) => n.path === "Ordner/Tief.md")?.mentions).toEqual(["aaaaaaaa-0000-4000-8000-000000000001"]);
    expect(s.status.notes).toBe(3);
    expect(s.status.lastOkAt).not.toBeNull();
  });

  it("teilt den Vollabgleich in Teile (gleiche syncId, done nur beim letzten)", async () => {
    const { root, put } = miniVault();
    for (let i = 0; i < 7; i++) put(`Viele/N${i}.md`, `[[Start]] ${i}`);
    const srv = fakeServer();
    const s = makeSync(root, srv.fetchImpl, { watch: false, chunkSize: 4 });
    await s.start();
    await until(() => srv.calls.length === 3);
    expect(srv.calls.map((c) => c.body.notes.length)).toEqual([4, 4, 2]);
    expect(srv.calls.map((c) => c.body.done)).toEqual([false, false, true]);
    expect(new Set(srv.calls.map((c) => c.body.syncId)).size).toBe(1);
  });

  it("leerer Vault schickt trotzdem einen Teil mit done:true (Server kann Altes löschen)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nyxos-vault-leer-"));
    const srv = fakeServer();
    const s = makeSync(root, srv.fetchImpl, { watch: false });
    await s.start();
    await until(() => srv.calls.length === 1);
    expect(srv.calls[0]?.body).toMatchObject({ mode: "full", done: true, notes: [] });
  });

  it("Delta bei Neu/Änderung/Löschen, gebündelt, mit syncId des letzten Vollabgleichs", async () => {
    const { root, put } = miniVault();
    const srv = fakeServer();
    const s = makeSync(root, srv.fetchImpl);
    await s.start();
    await until(() => srv.calls.length === 1);
    const fullId = srv.calls[0]?.body.syncId;

    put("Neu.md", "[[Start]]");
    put("Start.md", "# Start\n[[Neu]]");
    rmSync(join(root, "Ordner/Tief.md"));
    put("Bilder/zweites.png", "ignoriert");
    // Auf den END-Zustand warten, nicht auf „Start.md kam irgendwie vor“. `writeFileSync` kürzt
    // erst und schreibt dann — unter Last meldet der Wächter dazwischen eine Änderung, die Brücke schickt
    // Start.md kurz leer (links: []) und gleich danach richtig. Die alte Bedingung war dann schon erfüllt,
    // die Prüfung unten auf `links` lief vor dem zweiten Delta → rot. Frist großzügig, Test mit eigenem Limit.
    await until(() => {
      const deltas = srv.calls.filter((c) => c.body.mode === "delta");
      const notes = deltas.flatMap((c) => c.body.notes);
      const deleted = new Set(deltas.flatMap((c) => c.body.deleted));
      const lastStart = notes.filter((n) => n.path === "Start.md").at(-1);
      return notes.some((n) => n.path === "Neu.md") && lastStart?.links.join() === "Neu" && deleted.has("Ordner/Tief.md");
    }, 45_000);
    const deltas = srv.calls.filter((c) => c.body.mode === "delta");
    for (const d of deltas) expect(d.body.syncId).toBe(fullId);
    const start = deltas.flatMap((c) => c.body.notes).filter((n) => n.path === "Start.md").at(-1);
    expect(start?.links).toEqual(["Neu"]);
    expect(deltas.flatMap((c) => c.body.notes).some((n) => n.path.endsWith(".png"))).toBe(false);
    expect(srv.maxInflight()).toBe(1);
  }, 60_000);

  it("Netzfehler → Backoff → neuer Vollabgleich mit neuer syncId", async () => {
    const { root } = miniVault();
    const srv = fakeServer({ failFirst: 2 });
    const s = makeSync(root, srv.fetchImpl, { watch: false });
    await s.start();
    await until(() => srv.calls.length === 1);
    expect(srv.calls[0]?.body.mode).toBe("full");
    expect(srv.calls[0]?.body.done).toBe(true);
    expect(s.status.lastError).toBeNull();
  });

  it("Serverfehler (404, alter Server) → später erneut, wirft nie", async () => {
    const { root } = miniVault();
    const srv = fakeServer({ failFirst: 1, status: 404 });
    const s = makeSync(root, srv.fetchImpl, { watch: false });
    await s.start();
    expect(s.status.lastError).toMatch(/404/);
    await until(() => srv.calls.length === 1);
    expect(srv.calls[0]?.body.mode).toBe("full");
  });

  it("Fehler mitten im Vollabgleich → erneuter kompletter Vollabgleich mit neuer syncId", async () => {
    const { root, put } = miniVault();
    for (let i = 0; i < 5; i++) put(`Viele/N${i}.md`, `${i}`);
    let n = 0;
    const calls: VaultIngest[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      n++;
      if (n === 2) throw new Error("abgebrochen");
      calls.push(VaultIngestSchema.parse(JSON.parse(String(init?.body))));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const s = makeSync(root, fetchImpl, { watch: false, chunkSize: 3 });
    await s.start();
    await until(() => calls.filter((c) => c.done).length === 1);
    const ids = [...new Set(calls.map((c) => c.syncId))];
    expect(ids.length).toBe(2);
    const second = calls.filter((c) => c.syncId === ids[1]);
    expect(second.flatMap((c) => c.notes).length).toBe(8);
  });

  it("periodischer Vollabgleich", async () => {
    const { root } = miniVault();
    const srv = fakeServer();
    const s = makeSync(root, srv.fetchImpl, { watch: false, fullResyncMs: 60 });
    await s.start();
    await until(() => srv.calls.filter((c) => c.body.mode === "full").length >= 3);
    expect(new Set(srv.calls.map((c) => c.body.syncId)).size).toBeGreaterThanOrEqual(3);
  });

  it("stop() wartet die laufende Sendung ab und sendet danach nichts mehr", async () => {
    const { root, put } = miniVault();
    const srv = fakeServer({ delayMs: 80 });
    const s = makeSync(root, srv.fetchImpl);
    const started = s.start();
    await new Promise((r) => setTimeout(r, 20));
    await s.stop();
    await started;
    const count = srv.calls.length;
    expect(count).toBeLessThanOrEqual(1);
    put("Nachher.md", "x");
    await new Promise((r) => setTimeout(r, 200));
    expect(srv.calls.length).toBe(count);
  });
});

describe("unvollständiger Scan löscht nie", () => {
  it("fehlt die Vault-Wurzel, wird kein done:true geschickt (Server löscht nichts)", async () => {
    const { root } = miniVault();
    dirs.push(root);
    const srv = fakeServer();
    const s = makeSync(join(root, "gibt-es-nicht"), srv.fetchImpl, { watch: false });
    await s.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(srv.calls.some((c) => c.body.mode === "full" && c.body.done)).toBe(false);
  });

  it("schrumpft der Vault um mehr als die Hälfte, bestätigt erst ein zweiter Scan das Löschen", async () => {
    const { root, put } = miniVault();
    for (let i = 0; i < 30; i++) put(`Masse/N${i}.md`, `Notiz ${i}`);
    const srv = fakeServer();
    const s = makeSync(root, srv.fetchImpl, { watch: false });
    await s.start();
    await until(() => srv.calls.some((c) => c.body.done));
    rmSync(join(root, "Masse"), { recursive: true, force: true });
    srv.calls.length = 0;
    s.resync();
    await until(() => srv.calls.some((c) => c.body.done));
    const fulls = srv.calls.filter((c) => c.body.mode === "full");
    expect(fulls[0]?.body.done).toBe(false);
    expect(fulls.at(-1)?.body.done).toBe(true);
    expect(new Set(fulls.map((c) => c.body.syncId)).size).toBeGreaterThanOrEqual(2);
  });
});
