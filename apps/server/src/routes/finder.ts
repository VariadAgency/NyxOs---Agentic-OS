// Reiter „Dateien“ wie der Finder. Alle Wege brauchen die Anmeldung (auth.ts `needsAuth`), Schreiben
// zusätzlich CSRF. Die Dateien liegen auf dem Rechner; jede Anfrage geht als RPC `finder` an die Brücke.
//
// - GET  /api/finder/roots                 Favoriten (+ ob der Rechner da ist)
// - GET  /api/finder/list?root&p           Ordnerinhalt
// - GET  /api/finder/stat?root&p           ein Eintrag (+ darf gespeichert werden?)
// - GET  /api/finder/search?root&p&q       Namenssuche unterhalb eines Ordners
// - GET  /api/finder/text?root&p           Textdatei für Editor/Dokumentansicht (mit Prüfsumme)
// - GET  /api/finder/raw?root&p[&download] Datei als Bytes (in Blöcken gestreamt) — Bild, PDF, Download
// - GET  /api/finder/thumb?root&p&size     Vorschaubild (sips auf dem Rechner)
// - POST /api/finder/write                 Markdown/Text speichern (Sicherungskopie + Konflikt-Prüfung)
import {
  BRIDGE_CAP_FINDER,
  FINDER_CHUNK_BYTES,
  FINDER_ROOTS,
  FINDER_TEXT_MAX_BYTES,
  FinderRootIdSchema,
  FinderWriteBodySchema,
  finderExt,
  finderMimeOf,
  finderRelOk,
  type FinderCountsResult,
  type FinderListResult,
  type FinderReadResult,
  type FinderRootId,
  type FinderRootInfo,
  type FinderRootsResponse,
  type FinderSearchResult,
  type FinderStatResult,
  type FinderTextResponse,
  type FinderThumbResult,
  type FinderWriteResult,
  t,
} from "@nyxos/shared";
import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import { FINDER_TEXT, finderCall, type FinderHub, type FinderOutcome } from "../finder/service.js";

/** Aktive Inhalte: nie mit ihrem echten Typ „inline“ ausliefern (liefen sonst in unserer Seite). */
const ACTIVE_EXT = new Set([".html", ".htm", ".xhtml", ".xml", ".js", ".mjs", ".cjs", ".css", ".xsl", ".swf", ".shtml"]);
/** Selbst Bilder bekommen eine Sandbox (SVG kann Skript enthalten). PDF nicht: Chrome zeigt PDFs in einer Sandbox gar nicht. */
const SANDBOX_CSP = "sandbox; default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'";

function params(c: Context): { root: FinderRootId; rel: string } | null {
  const root = FinderRootIdSchema.safeParse(c.req.query("root"));
  const rel = c.req.query("p") ?? "";
  if (!root.success || !finderRelOk(rel)) return null;
  return { root: root.data, rel };
}

function fail<T>(c: Context, out: Extract<FinderOutcome<T>, { ok: false }>) {
  return c.json({ error: out.error, code: out.code }, out.status);
}

const bad = (c: Context) => c.json({ error: FINDER_TEXT.badPath, code: "finder_bad_path" }, 400);

function nameOf(rel: string): string {
  return rel.split("/").pop() || t("Datei");
}

/** RFC 5987: Dateiname in UTF-8, damit Umlaute/Leerzeichen heil ankommen. */
function disposition(kind: "attachment" | "inline", name: string): string {
  return `${kind}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export function registerFinderRoutes(app: Hono<AppEnv>, deps: { bridgeHub: FinderHub }): void {
  const hub = deps.bridgeHub;

  app.get("/api/finder/roots", async (c) => {
    const bridge: FinderRootsResponse["bridge"] = !hub.online ? "offline" : hub.supports(BRIDGE_CAP_FINDER) ? "online" : "outdated";
    const fallback: FinderRootInfo[] = FINDER_ROOTS.map((r) => ({ id: r.id, label: r.label, icon: r.icon, abs: "", exists: false, writable: r.writable }));
    if (bridge !== "online") return c.json({ bridge, roots: fallback } satisfies FinderRootsResponse);
    const out = await finderCall<FinderRootInfo[]>(hub, { op: "roots" });
    return c.json({ bridge: out.ok ? "online" : "offline", roots: out.ok ? out.value : fallback } satisfies FinderRootsResponse);
  });

  app.get("/api/finder/list", async (c) => {
    const p = params(c);
    if (!p) return bad(c);
    const out = await finderCall<FinderListResult>(hub, { op: "list", ...p });
    return out.ok ? c.json(out.value) : fail(c, out);
  });

  // Finder-Tempo: Kinderzahlen der Unterordner eines großen Ordners (die Liste kam ohne, `childrenPending`).
  app.get("/api/finder/counts", async (c) => {
    const p = params(c);
    if (!p) return bad(c);
    const out = await finderCall<FinderCountsResult>(hub, { op: "counts", ...p });
    return out.ok ? c.json(out.value) : fail(c, out);
  });

  app.get("/api/finder/stat", async (c) => {
    const p = params(c);
    if (!p) return bad(c);
    const out = await finderCall<FinderStatResult>(hub, { op: "stat", ...p });
    return out.ok ? c.json(out.value) : fail(c, out);
  });

  app.get("/api/finder/search", async (c) => {
    const p = params(c);
    const q = (c.req.query("q") ?? "").trim().slice(0, 200);
    if (!p || !q) return bad(c);
    const out = await finderCall<FinderSearchResult>(hub, { op: "search", ...p, q }, 15_000);
    return out.ok ? c.json(out.value) : fail(c, out);
  });

  app.get("/api/finder/text", async (c) => {
    const p = params(c);
    if (!p) return bad(c);
    const st = await finderCall<FinderStatResult>(hub, { op: "stat", ...p });
    if (!st.ok) return fail(c, st);
    if (st.value.entry.isDir) return c.json({ error: FINDER_TEXT.notText, code: "finder_not_a_file" }, 400);
    if (st.value.entry.size > FINDER_TEXT_MAX_BYTES) return c.json({ error: FINDER_TEXT.tooLarge, code: "finder_too_large" }, 413);
    const parts: Buffer[] = [];
    let offset = 0;
    let last: FinderReadResult | undefined;
    for (;;) {
      const out = await finderCall<FinderReadResult>(hub, { op: "read", ...p, offset, length: FINDER_CHUNK_BYTES });
      if (!out.ok) return fail(c, out);
      last = out.value;
      const buf = Buffer.from(last.b64, "base64");
      parts.push(buf);
      offset += buf.length;
      if (last.eof || buf.length === 0 || offset > FINDER_TEXT_MAX_BYTES) break;
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length > FINDER_TEXT_MAX_BYTES) return c.json({ error: FINDER_TEXT.tooLarge, code: "finder_too_large" }, 413);
    // NUL-Byte in den ersten 8 KB = Binärdatei (wie git/grep).
    if (bytes.subarray(0, 8192).includes(0)) return c.json({ error: FINDER_TEXT.notText, code: "finder_not_text" }, 415);
    const body: FinderTextResponse = {
      root: p.root,
      rel: p.rel,
      name: nameOf(p.rel),
      content: bytes.toString("utf8"),
      size: bytes.length,
      mtimeMs: last?.mtimeMs ?? st.value.entry.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      writable: st.value.writable,
    };
    return c.json(body);
  });

  app.get("/api/finder/raw", async (c) => {
    const p = params(c);
    if (!p || p.rel === "") return bad(c);
    const first = await finderCall<FinderReadResult>(hub, { op: "read", ...p, offset: 0, length: FINDER_CHUNK_BYTES });
    if (!first.ok) return fail(c, first);
    const name = nameOf(p.rel);
    const download = c.req.query("download") === "1";
    const ext = finderExt(name);
    let mime = finderMimeOf(name);
    if (!download && ACTIVE_EXT.has(ext)) mime = "text/plain; charset=utf-8";
    const headers: Record<string, string> = {
      "content-type": mime,
      "content-length": String(first.value.size),
      "content-disposition": disposition(download ? "attachment" : "inline", name),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    };
    if (mime !== "application/pdf") headers["content-security-policy"] = SANDBOX_CSP;
    const firstBuf = Buffer.from(first.value.b64, "base64");
    const size = first.value.size;
    let offset = firstBuf.length;
    let done = first.value.eof || firstBuf.length === 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (firstBuf.length > 0) controller.enqueue(new Uint8Array(firstBuf));
        if (done) controller.close();
      },
      async pull(controller) {
        if (done) return;
        const out = await finderCall<FinderReadResult>(hub, { op: "read", ...p, offset, length: FINDER_CHUNK_BYTES });
        if (!out.ok) {
          controller.error(new Error(out.error));
          return;
        }
        const buf = Buffer.from(out.value.b64, "base64");
        if (buf.length > 0) controller.enqueue(new Uint8Array(buf));
        offset += buf.length;
        if (out.value.eof || buf.length === 0 || offset >= size) {
          done = true;
          controller.close();
        }
      },
    });
    return new Response(stream, { status: 200, headers });
  });

  app.get("/api/finder/thumb", async (c) => {
    const p = params(c);
    if (!p || p.rel === "") return bad(c);
    const size = Math.max(32, Math.min(1024, Number(c.req.query("size") ?? 320) || 320));
    const out = await finderCall<FinderThumbResult>(hub, { op: "thumb", ...p, size }, 30_000);
    if (!out.ok) return fail(c, out);
    return new Response(new Uint8Array(Buffer.from(out.value.b64, "base64")), {
      status: 200,
      headers: { "content-type": out.value.mime, "x-content-type-options": "nosniff", "cache-control": "private, max-age=300", "content-security-policy": SANDBOX_CSP },
    });
  });

  app.post("/api/finder/write", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return bad(c);
    }
    const body = FinderWriteBodySchema.safeParse(raw);
    if (!body.success) return bad(c);
    const out = await finderCall<FinderWriteResult>(hub, { op: "write", ...body.data }, 30_000);
    if (!out.ok) return fail(c, out);
    return c.json({ ok: true, ...out.value });
  });
}
