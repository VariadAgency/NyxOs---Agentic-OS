// Agent-Container: Arbeiter verbindet sich per echtem WebSocket, Läufe gehen durch; falsches Geheimnis 401.
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { LiveHub } from "../../src/live.js";
import { RemoteEngine } from "../../src/haiku/remoteEngine.js";
import { HaikuRuntime } from "../../src/haiku/runtime.js";
import { buildDefaultRegistry } from "../../src/haiku/tools.js";
import { runWorker } from "../../src/haiku-worker.js";
import { answer, FakeEngine, sharedAssistantDb } from "./assistant-helpers.js";

// Gegen Wackeln unter Last: Aufräumen rückwärts und abgewartet — erst den Arbeiter stoppen, dann den
// Server schließen. Vorher schloss jeder Test zuerst seine eigene PGlite, während Arbeiter und Server noch
// liefen (späte Anfragen gegen eine geschlossene DB). Die DB ist jetzt die geteilte, vorab migrierte
// (`sharedAssistantDb`) statt je Test eine frische Migration im Testkörper (≈ 1,2 s, unter Last ein Vielfaches).
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start(tokenConfigured = true) {
  const db = await sharedAssistantDb();
  const remote = new RemoteEngine({ tokenConfigured });
  const runtime = new HaikuRuntime({ db, tools: buildDefaultRegistry(), cliEngine: remote, apiEngine: null });
  const hub = new LiveHub();
  const broadcast = vi.spyOn(hub, "broadcast");
  const { app, injectWebSocket } = createApp({ db, hub, archiveDir: mkdtempSync(join(tmpdir(), "assistant-w-")), haiku: { runtime, remoteEngine: remote, workerSecret: "geheim-123" } });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  injectWebSocket(server);
  await new Promise((r) => server.once("listening", r));
  cleanup.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const statusPings = () => broadcast.mock.calls.filter(([m]) => (m as { type?: string; what?: string }).type === "haiku" && (m as { what?: string }).what === "status").length;
  return { runtime, remote, port, statusPings };
}

/** Auf eine Bedingung warten (nicht auf eine feste Zeit); die Frist ist nur das Sicherheitsnetz unter Last. */
const until = async (f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("Zeit abgelaufen");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("Arbeiter im Agent-Container", () => {
  it("ohne Arbeiter: Motor nicht verfügbar; mit Arbeiter: Lauf geht durch", async () => {
    const s = await start();
    expect((await s.runtime.status()).engine).toMatchObject({ available: false, state: "error", reason: expect.stringContaining("Motor") });
    const engine = new FakeEngine(answer("Hallo aus dem Container."));
    cleanup.push(runWorker({ url: `ws://127.0.0.1:${s.port}/haiku-worker`, secret: "geheim-123", engine, tokenSet: true }));
    await until(async () => (await s.remote.available()).ok);
    expect((await s.runtime.status()).engine).toMatchObject({ state: "ready", available: true });
    const r = await s.runtime.run({ kind: "chat", scope: "full", systemPrompt: "s", prompt: "p" });
    expect(r).toMatchObject({ type: "final", text: "Hallo aus dem Container." });
    expect(engine.requests[0]?.tools).toContain("sessions_suchen");
  });

  it("Arbeiter ohne Token meldet sich → „wartet auf Token“, kein Lauf", async () => {
    const s = await start();
    const engine = new FakeEngine(answer("x"));
    cleanup.push(runWorker({ url: `ws://127.0.0.1:${s.port}/haiku-worker`, secret: "geheim-123", engine, tokenSet: false }));
    await until(async () => (await s.runtime.status()).engine.state === "waiting_token");
    const r = await s.runtime.run({ kind: "chat", scope: "full", systemPrompt: "s", prompt: "p" });
    expect(r).toMatchObject({ type: "error", code: "not_ready" });
    expect(engine.requests).toHaveLength(0);
  });

  it("das Hallo des Arbeiters stößt die Oberfläche an (Live-Update, nicht erst beim nächsten Abfragen)", async () => {
    const s = await start();
    const engine = new FakeEngine(answer("x"));
    cleanup.push(runWorker({ url: `ws://127.0.0.1:${s.port}/haiku-worker`, secret: "geheim-123", engine, tokenSet: false }));
    // Erst verbunden (Anstoß 1), dann kommt das Hallo mit „kein Token“ – der Zustand kippt von „bereit“ auf „wartet“.
    await until(async () => (await s.runtime.status()).engine.state === "waiting_token");
    // Ohne zweiten Anstoß zeigt die Oberfläche bis zum nächsten Abfragen (60 s) weiter „Bereit“.
    await until(() => s.statusPings() >= 2);
  });

  it("ohne Token in .env und ohne Arbeiter → „Wartet auf Token vom Nutzer“", async () => {
    const s = await start(false);
    expect((await s.runtime.status()).engine).toMatchObject({ state: "waiting_token", reason: "Wartet auf Token vom Nutzer." });
  });

  it("falsches Geheimnis → keine Verbindung", async () => {
    const s = await start();
    // Auf die Ablehnung warten (Verbindungsfehler beim Handschlag) statt 400 ms zu schlafen — sonst prüfte
    // der Test unter Last evtl., bevor der Arbeiter es überhaupt versucht hat.
    let rejected = false;
    const log = (msg: string) => {
      if (msg === "arbeiter-verbindungsfehler") rejected = true;
    };
    cleanup.push(runWorker({ url: `ws://127.0.0.1:${s.port}/haiku-worker`, secret: "falsch-123", engine: new FakeEngine(answer("x")), log }));
    await until(() => rejected);
    expect((await s.remote.available()).ok).toBe(false);
  });
});
