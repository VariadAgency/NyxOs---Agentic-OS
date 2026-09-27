// Zugriffsschutz: Host-Allowlist gegen DNS-Rebinding,
// Origin-Prüfung für WebSocket /live + nicht-GET-Anfragen, Content-Type-Pflicht für nicht-GET
// unter /api. Gilt für alles außer /ingest/* (Token) und /health. S. src/security.ts + app.ts.
import { connect } from "node:net";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { isAllowedHost, isAllowedOrigin, parseAllowedHosts } from "../src/security.js";
import { setup } from "./helpers.js";

describe("security.ts (reine Funktionen)", () => {
  it("erlaubt 127.0.0.1/localhost mit beliebigem Port, sonst nur explizit erlaubte Hosts", () => {
    const extra = parseAllowedHosts("mein-mac.tailnet.ts.net,mein-mac.tailnet.ts.net:47801");
    expect(isAllowedHost("127.0.0.1:47800", extra)).toBe(true);
    expect(isAllowedHost("127.0.0.1:47801", extra)).toBe(true);
    expect(isAllowedHost("127.0.0.1:8080", extra)).toBe(true);
    expect(isAllowedHost("localhost:47890", extra)).toBe(true);
    expect(isAllowedHost("localhost", extra)).toBe(true);
    expect(isAllowedHost("MEIN-MAC.TAILNET.TS.NET:47801", extra)).toBe(true); // Groß-/Kleinschreibung egal
    expect(isAllowedHost("mein-mac.tailnet.ts.net", extra)).toBe(true);
    expect(isAllowedHost("evil.example", extra)).toBe(false);
    expect(isAllowedHost("evil.example:47800", extra)).toBe(false); // DNS-Rebinding: Port allein reicht nicht
    expect(isAllowedHost(null, extra)).toBe(false);
  });

  it("ohne NYXOS_ALLOWED_HOSTS bleibt nur 127.0.0.1/localhost erlaubt", () => {
    const extra = parseAllowedHosts(undefined);
    expect(isAllowedHost("127.0.0.1:47801", extra)).toBe(true);
    expect(isAllowedHost("evil.example", extra)).toBe(false);
  });

  it("fehlender Origin (kein Browser: curl/Brücke) ist erlaubt, ein fremder nicht", () => {
    const extra = parseAllowedHosts(undefined);
    expect(isAllowedOrigin(null, extra)).toBe(true);
    expect(isAllowedOrigin(undefined, extra)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:47801", extra)).toBe(true);
    expect(isAllowedOrigin("http://evil.example", extra)).toBe(false);
    expect(isAllowedOrigin("kaputt", extra)).toBe(false);
  });
});

describe("Middleware: Host-Allowlist", () => {
  it("fremder Host-Header wird abgelehnt (421), erlaubte Hosts kommen durch", async () => {
    const t = await setup();
    const foreign = await t.app.request("/api/sessions", { headers: { host: "evil.example" } });
    expect(foreign.status).toBe(421);

    const ok = await t.app.request("/api/sessions", { headers: { host: "127.0.0.1:47801" } });
    expect(ok.status).toBe(200);
  });

  it("fehlender Host-Header wird nicht blockiert (kein Browser kann den Host-Header weglassen — nur In-Process-Aufrufe ohne echten Transport haben keinen)", async () => {
    const t = await setup();
    const res = await t.app.request("/api/sessions");
    expect(res.status).toBe(200);
  });

  it("zusätzliche Hosts aus NYXOS_ALLOWED_HOSTS werden akzeptiert", async () => {
    const t = await setup({ allowedHosts: "mac.tailnet.ts.net" });
    const res = await t.app.request("/api/sessions", { headers: { host: "mac.tailnet.ts.net" } });
    expect(res.status).toBe(200);
  });

  it("/ingest/* und /health bleiben ohne Host-Prüfung erreichbar (Brücke hat kein festes Host-Ziel)", async () => {
    const t = await setup();
    const health = await t.app.request("/health", { headers: { host: "irgendwas.example" } });
    expect(health.status).not.toBe(421);
    const ingest = await t.app.request("/ingest/events", {
      method: "POST",
      headers: { ...t.auth, "content-type": "application/json", host: "irgendwas.example" },
      body: JSON.stringify({ items: [] }),
    });
    expect(ingest.status).not.toBe(421);
  });
});

describe("Middleware: Content-Type unter /api", () => {
  it("nicht-GET unter /api ohne application/json ist 415", async () => {
    const t = await setup();
    const res = await t.app.request("/api/sessions/irgendwas/close", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "by=alex",
    });
    expect(res.status).toBe(415);
  });

  it("nicht-GET unter /api mit application/json kommt normal durch (404, nicht 415 — Session existiert nicht)", async () => {
    const t = await setup();
    const res = await t.app.request("/api/sessions/irgendwas/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: "alex" }),
    });
    expect(res.status).toBe(404);
  });

  it("/ingest/* bleibt von der Content-Type-Pflicht unberührt (eigene Prüfung dort)", async () => {
    const t = await setup();
    const res = await t.app.request("/ingest/events", { method: "POST", headers: { ...t.auth, "content-type": "text/plain" }, body: "{}" });
    expect(res.status).not.toBe(415);
  });
});

describe("Middleware: Origin-Prüfung für nicht-GET", () => {
  it("nicht-GET mit fremdem Origin ist 403, ohne Origin oder mit erlaubtem Origin kommt durch", async () => {
    const t = await setup();
    const foreign = await t.app.request("/api/sessions/irgendwas/close", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ by: "alex" }),
    });
    expect(foreign.status).toBe(403);

    const noOrigin = await t.app.request("/api/sessions/irgendwas/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: "alex" }),
    });
    expect(noOrigin.status).toBe(404); // kam durch die Sicherheits-Middleware, Session existiert nur nicht

    const okOrigin = await t.app.request("/api/sessions/irgendwas/close", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:47801" },
      body: JSON.stringify({ by: "alex" }),
    });
    expect(okOrigin.status).toBe(404);
  });

  it("GET mit fremdem Origin wird NICHT über die Origin-Prüfung blockiert (nur Host zählt für GET)", async () => {
    const t = await setup();
    const res = await t.app.request("/api/sessions", { headers: { origin: "http://evil.example" } });
    expect(res.status).toBe(200); // kein Host-Header im In-Process-Aufruf → Host-Prüfung greift nicht, GET prüft den Origin gar nicht erst
  });
});

describe("Middleware: WebSocket /live (echter Handshake über einen echten Server)", () => {
  async function rawUpgrade(port: number, origin: string | null): Promise<string> {
    return new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        const headers = [
          "GET /live HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
        ];
        if (origin) headers.push(`Origin: ${origin}`);
        socket.write(headers.join("\r\n") + "\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        resolve(data.split("\r\n")[0] ?? "");
        socket.end();
      });
      socket.on("error", (e) => resolve(`ERROR ${e.message}`));
      setTimeout(() => resolve(`TIMEOUT ${data.split("\r\n")[0] ?? ""}`), 2000);
    });
  }

  it("fremder Origin wird abgelehnt (403), fehlender/GENAU passender Origin lässt den Handschlag zu (101)", async () => {
    const t = await setup();
    const server = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" });
    t.injectWebSocket(server);
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    expect(await rawUpgrade(port, null)).toContain("101"); // kein Browser (curl/Brücke) — erlaubt
    expect(await rawUpgrade(port, `http://127.0.0.1:${port}`)).toContain("101"); // Origin == Host genau
    expect(await rawUpgrade(port, "http://evil.example")).toContain("403");

    server.close();
  });

  // `/live` trägt Session-Nachrichten ALLER offenen Sessions — die grobe
  // Loopback-Erlaubnis (jeder Port auf 127.0.0.1/localhost) reichte hier nicht: eine beliebige Seite
  // auf einem ANDEREN Port desselben Rechners konnte den Handschlag vorher ebenfalls öffnen. Jetzt
  // MUSS der Origin exakt zum Host (inkl. Port) passen, wie beim Terminal-Handschlag `/terminal/:id`.
  it("ein ANDERER Port auf 127.0.0.1 — vorher fälschlich erlaubt — wird jetzt abgelehnt (403)", async () => {
    const t = await setup();
    const server = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" });
    t.injectWebSocket(server);
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const otherPort = port === 47801 ? 47802 : 47801;

    expect(await rawUpgrade(port, `http://127.0.0.1:${otherPort}`)).toContain("403");

    server.close();
  });
});

describe("originMatchesHost (reine Funktion)", () => {
  it("fehlender Origin ist erlaubt (kein Browser), Origin muss sonst GENAU zum Host passen (Port inklusive)", async () => {
    const { originMatchesHost } = await import("../src/security.js");
    expect(originMatchesHost(null, "127.0.0.1:47801")).toBe(true);
    expect(originMatchesHost(undefined, "127.0.0.1:47801")).toBe(true);
    expect(originMatchesHost("http://127.0.0.1:47801", "127.0.0.1:47801")).toBe(true);
    expect(originMatchesHost("http://127.0.0.1:47802", "127.0.0.1:47801")).toBe(false); // anderer Port
    expect(originMatchesHost("http://evil.example", "127.0.0.1:47801")).toBe(false);
    expect(originMatchesHost("kaputt", "127.0.0.1:47801")).toBe(false);
    expect(originMatchesHost("http://127.0.0.1:47801", null)).toBe(false); // kein Host-Header (In-Process-Test)
  });
});

describe("assertAuthReadsWithAllowedHosts: Serverstart-Wächter", () => {
  it("ohne NYXOS_ALLOWED_HOSTS: nie ein Problem, egal was in NYXOS_AUTH_READS steht", async () => {
    const { assertAuthReadsWithAllowedHosts } = await import("../src/security.js");
    expect(() => assertAuthReadsWithAllowedHosts(undefined, undefined)).not.toThrow();
    expect(() => assertAuthReadsWithAllowedHosts("", "0")).not.toThrow();
  });

  it("NYXOS_ALLOWED_HOSTS gesetzt OHNE NYXOS_AUTH_READS=1 → Serverstart abgebrochen", async () => {
    const { assertAuthReadsWithAllowedHosts } = await import("../src/security.js");
    expect(() => assertAuthReadsWithAllowedHosts("mac.tailnet.ts.net", undefined)).toThrow(/NYXOS_AUTH_READS/);
    expect(() => assertAuthReadsWithAllowedHosts("mac.tailnet.ts.net", "0")).toThrow(/NYXOS_AUTH_READS/);
  });

  it("NYXOS_ALLOWED_HOSTS gesetzt MIT NYXOS_AUTH_READS=1 → Start erlaubt", async () => {
    const { assertAuthReadsWithAllowedHosts } = await import("../src/security.js");
    expect(() => assertAuthReadsWithAllowedHosts("mac.tailnet.ts.net", "1")).not.toThrow();
  });
});
