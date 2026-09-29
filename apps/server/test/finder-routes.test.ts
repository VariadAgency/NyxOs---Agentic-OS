// Finder-Routen des Servers. Alles unter /api/finder/* braucht die Anmeldung (auch Lesen —
// es sind persönliche Dateien), Schreiben zusätzlich CSRF. Der Server prüft Wurzel + Pfad selbst (zweite
// Linie hinter der Brücke) und reicht dann den RPC `finder` weiter. Brücke im selben Prozess (Fake-Socket).
import { createHash } from "node:crypto";
import { BRIDGE_CAP_FINDER, FINDER_CHUNK_BYTES, FINDER_ERR, finderPermissionText, type FinderReadResult, type ServerToBridge } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { CSRF_HEADER, needsAuth, SESSION_COOKIE } from "../src/terminal/auth.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type Handler = (params: Record<string, unknown>) => { ok: true; result: unknown } | { ok: false; error: string; code: string };

function fakeBridge(hub: BridgeHub, handler: Handler, caps = [BRIDGE_CAP_FINDER]) {
  const calls: Record<string, unknown>[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc" || msg.method !== "finder") return;
        const params = msg.params as Record<string, unknown>;
        calls.push(params);
        const out = handler(params);
        queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ...out })));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "r2", tmuxSocket: "nyxos", caps }));
  return calls;
}

const TECH = /tmux|CSRF|ENOENT|nicht gefunden|bridge|rpc|finder_/i;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function fileBytes(total: number): Buffer {
  const b = Buffer.alloc(total);
  for (let i = 0; i < total; i++) b[i] = i % 251;
  return b;
}

/** Brücke, die eine Datei in Blöcken liefert (wie finder/fs.ts). */
function chunkedReader(file: Buffer, mtimeMs = 1_700_000_000_000): Handler {
  return (p) => {
    if (p.op === "stat") return { ok: true, result: { root: p.root, writable: true, entry: { name: String(p.rel).split("/").pop(), rel: p.rel, kind: "markdown", isDir: false, size: file.length, mtimeMs, children: null, hidden: false, secret: false, link: false } } };
    if (p.op !== "read") return { ok: false, error: "?", code: "failed" };
    const offset = Number(p.offset ?? 0);
    const length = Math.min(Number(p.length ?? FINDER_CHUNK_BYTES), FINDER_CHUNK_BYTES);
    const part = file.subarray(offset, offset + length);
    const eof = offset + part.length >= file.length;
    const result: FinderReadResult = { b64: part.toString("base64"), offset, size: file.length, mtimeMs, sha256: offset === 0 && eof ? sha(part) : null, eof };
    return { ok: true, result };
  };
}

describe("Finder-Routen", () => {
  it("jeder Finder-Weg braucht die Anmeldung, auch lesend", async () => {
    expect(needsAuth("GET", "/api/finder/list", false)).toBe(true);
    expect(needsAuth("GET", "/api/finder/raw", false)).toBe(true);
    const hub = new BridgeHub();
    fakeBridge(hub, () => ({ ok: true, result: { root: "project", rel: "", entries: [], truncated: false, writable: true } }));
    const t = await setup({ bridgeHub: hub, signedIn: false });
    expect((await t.app.request("/api/finder/list?root=project&p=")).status).toBe(401);
    // angemeldet, aber ohne CSRF-Kopf: Schreiben wird verweigert
    const res = await t.app.request("/api/finder/write", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${t.login.token}` },
      body: JSON.stringify({ root: "project", rel: "a.md", content: "x", baseSha256: sha(""), baseMtimeMs: 0 }),
    });
    expect(res.status).toBe(403);
    const ok = await t.app.request("/api/finder/list?root=project&p=", { headers: { cookie: `${SESSION_COOKIE}=${t.login.token}`, [CSRF_HEADER]: t.login.csrf } });
    expect(ok.status).toBe(200);
  });

  it("prüft Wurzel und Pfad selbst, bevor etwas zur Brücke geht", async () => {
    const hub = new BridgeHub();
    const calls = fakeBridge(hub, () => ({ ok: true, result: {} }));
    const t = await setup({ bridgeHub: hub });
    for (const q of ["root=project&p=../x", "root=project&p=%2Fetc%2Fpasswd", "root=etc&p=", "root=project&p=a%5Cb", "root=project&p=a%2F..%2F..%2Fb"]) {
      const res = await t.app.request(`/api/finder/list?${q}`);
      expect(res.status, q).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toMatch(TECH);
    }
    const w = await t.post("/api/finder/write", { root: "project", rel: "../../x.md", content: "x", baseSha256: sha(""), baseMtimeMs: 0 }, {});
    expect(w.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("Mac nicht verbunden: verständlicher Satz statt Technik", async () => {
    const t = await setup({ bridgeHub: new BridgeHub() });
    const res = await t.app.request("/api/finder/list?root=project&p=");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("bridge_offline");
    expect(body.error).toMatch(/Rechner/);
    expect(body.error).not.toMatch(TECH);
    const roots = (await (await t.app.request("/api/finder/roots")).json()) as { bridge: string; roots: { id: string }[] };
    expect(roots.bridge).toBe("offline");
    expect(roots.roots.map((r) => r.id)).toContain("project");
  });

  it("ältere Brücke ohne Finder: ehrlicher Hinweis", async () => {
    const hub = new BridgeHub();
    fakeBridge(hub, () => ({ ok: true, result: {} }), []);
    const t = await setup({ bridgeHub: hub });
    const res = await t.app.request("/api/finder/list?root=project&p=");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("bridge_outdated");
  });

  it("Fehler der Brücke werden zu passenden Antworten", async () => {
    const hub = new BridgeHub();
    const codes: Record<string, string> = { "a.md": FINDER_ERR.notFound, "b.md": FINDER_ERR.badPath, "c.env": FINDER_ERR.secret };
    fakeBridge(hub, (p) => ({ ok: false, error: "Diese Datei gibt es nicht mehr.", code: codes[String(p.rel)] ?? "failed" }));
    const t = await setup({ bridgeHub: hub });
    expect((await t.app.request("/api/finder/stat?root=project&p=a.md")).status).toBe(404);
    expect((await t.app.request("/api/finder/stat?root=project&p=b.md")).status).toBe(400);
    expect((await t.app.request("/api/finder/stat?root=project&p=c.env")).status).toBe(403);
  });

  it("Rohdaten: setzt die Blöcke zusammen, mit Art, Download-Namen und Schutz-Köpfen", async () => {
    const file = fileBytes(FINDER_CHUNK_BYTES * 2 + 1234);
    const hub = new BridgeHub();
    const calls = fakeBridge(hub, chunkedReader(file));
    const t = await setup({ bridgeHub: hub });
    const res = await t.app.request("/api/finder/raw?root=downloads&p=Fotos%2FB%C3%BChne%201.jpg&download=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(String(file.length));
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''B%C3%BChne%201.jpg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(file)).toBe(true);
    expect(calls.filter((c) => c.op === "read").map((c) => c.offset)).toEqual([0, FINDER_CHUNK_BYTES, FINDER_CHUNK_BYTES * 2]);
  });

  it("aktive Inhalte (HTML, SVG) laufen nie in unserer Seite", async () => {
    const hub = new BridgeHub();
    fakeBridge(hub, chunkedReader(Buffer.from("<script>alert(1)</script>")));
    const t = await setup({ bridgeHub: hub });
    const html = await t.app.request("/api/finder/raw?root=project&p=x.html");
    expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const svg = await t.app.request("/api/finder/raw?root=project&p=x.svg");
    expect(svg.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(svg.headers.get("content-security-policy")).toMatch(/script-src 'none'|default-src 'none'/);
  });

  it("Text: ganze Datei mit Prüfsumme, Schreibrecht und Änderungszeit", async () => {
    const md = Buffer.from("# Titel\n\nÄrger über Umlaute\n");
    const hub = new BridgeHub();
    fakeBridge(hub, chunkedReader(md, 1_700_000_000_123));
    const t = await setup({ bridgeHub: hub });
    const res = await t.app.request("/api/finder/text?root=project&p=docs%2Fplan.md");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ root: "project", rel: "docs/plan.md", name: "plan.md", content: md.toString("utf8"), size: md.length, mtimeMs: 1_700_000_000_123, sha256: sha(md), writable: true });
  });

  it("Text: Binärdatei wird nicht als Text geöffnet", async () => {
    const hub = new BridgeHub();
    fakeBridge(hub, chunkedReader(Buffer.from([0x89, 0x50, 0, 0, 1, 2])));
    const t = await setup({ bridgeHub: hub });
    const res = await t.app.request("/api/finder/text?root=project&p=x.md");
    expect(res.status).toBe(415);
  });

  it("Speichern: reicht Inhalt + Prüfsumme durch; Konflikt wird 409", async () => {
    const hub = new BridgeHub();
    let conflict = false;
    const calls = fakeBridge(hub, (p) =>
      conflict ? { ok: false, error: "Die Datei wurde inzwischen woanders geändert.", code: FINDER_ERR.conflict } : { ok: true, result: { mtimeMs: 5, sha256: sha(String(p.content)), size: 3, backup: "/x/plan.md.bak" } },
    );
    const t = await setup({ bridgeHub: hub });
    const body = { root: "project", rel: "docs/plan.md", content: "neu", baseSha256: sha("alt"), baseMtimeMs: 1 };
    const ok = await t.post("/api/finder/write", body, {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, sha256: sha("neu") });
    expect(calls.at(-1)).toMatchObject({ op: "write", root: "project", rel: "docs/plan.md", content: "neu", baseSha256: sha("alt") });
    conflict = true;
    const c = await t.post("/api/finder/write", body, {});
    expect(c.status).toBe(409);
    const cb = (await c.json()) as { code: string; error: string };
    expect(cb.code).toBe(FINDER_ERR.conflict);
    expect(cb.error).not.toMatch(TECH);
  });
});

describe("Finder-Tempo · Kinderzahlen nachladen", () => {
  it("GET /api/finder/counts reicht `counts` an die Brücke und liefert die Zahlen", async () => {
    const hub = new BridgeHub();
    const calls = fakeBridge(hub, (p) => (p.op === "counts" ? { ok: true, result: { root: p.root, rel: p.rel, counts: { a: 3, b: null } } } : { ok: false, error: "?", code: "failed" }));
    const t = await setup({ bridgeHub: hub });
    const res = await t.app.request("/api/finder/counts?root=downloads&p=");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ root: "downloads", rel: "", counts: { a: 3, b: null } });
    expect(calls).toEqual([{ op: "counts", root: "downloads", rel: "" }]);
    expect((await t.app.request("/api/finder/counts?root=downloads&p=..%2Fx")).status).toBe(400);
  });
});

describe("macOS fragt nach der Freigabe", () => {
  it("der Code der Brücke kommt als 503 mit ihrem Satz durch (kein 504, kein Warten)", async () => {
    const hub = new BridgeHub();
    const text = finderPermissionText("Downloads");
    fakeBridge(hub, () => ({ ok: false, error: text, code: FINDER_ERR.macosPermission }));
    const t = await setup({ bridgeHub: hub });
    for (const path of ["/api/finder/list?root=downloads&p=", "/api/finder/counts?root=downloads&p="]) {
      const res = await t.app.request(path);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("macos_freigabe_offen");
      expect(body.error).toBe(text);
      expect(body.error).not.toMatch(TECH);
    }
  });
});
