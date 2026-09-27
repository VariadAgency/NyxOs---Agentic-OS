// Der Motor-Zustand ist ehrlich und steht fest, BEVOR der Nutzer schreibt:
// bereit · wartet auf Token · aus · Fehler (mit Grund in einfachen Worten). CLI gemockt.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HaikuSelftest, HaikuStatus, HaikuThread } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { ClaudeCliEngine } from "../../src/haiku/claudeCli.js";
import type { EngineEvent } from "../../src/haiku/engine.js";
import { RemoteEngine } from "../../src/haiku/remoteEngine.js";
import { patchHaikuSettings } from "../../src/haiku/settings.js";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant, TOKEN } from "./assistant-helpers.js";

/** Keine Technik-Meldungen an den Nutzer. */
const TECH = /nicht gefunden|ENOENT|CLI|tmux|CSRF|nyxos-agent|spawn/;

function fakeClaude(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("Motor-Zustand (claude-CLI gemockt)", () => {
  it("kein CLI → noch nicht verbunden (kein Fehler), mit Grund in einfachen Worten", async () => {
    const engine = new ClaudeCliEngine({ apiUrl: "http://127.0.0.1:1", bin: join(tmpdir(), "gibt-es-nicht-claude"), env: { PATH: "/usr/bin:/bin" } });
    const a = await engine.available();
    expect(a).toMatchObject({ ok: false, state: "waiting_token" });
    expect(a.reason).toBeTruthy();
    expect(a.reason).not.toMatch(TECH);
  });

  it("CLI vorhanden → bereit, Version wird gemeldet", async () => {
    const engine = new ClaudeCliEngine({ apiUrl: "http://127.0.0.1:1", bin: fakeClaude('echo "2.1.282 (Claude Code)"'), env: { PATH: "/usr/bin:/bin" } });
    const a = await engine.available();
    expect(a).toMatchObject({ ok: true, state: "ready", version: "2.1.282" });
  });

  it("Server-Betrieb ohne Token → „Wartet auf Token vom Nutzer“, ohne Technik-Wörter", async () => {
    const remote = new RemoteEngine({ tokenConfigured: false });
    const a = await remote.available();
    expect(a).toMatchObject({ ok: false, state: "waiting_token" });
    expect(a.reason).toMatch(/Wartet auf Token vom Nutzer/);
    expect(a.reason).not.toMatch(TECH);
  });

  it("Server-Betrieb mit Token, aber Motor nicht verbunden → Fehler mit Grund", async () => {
    const remote = new RemoteEngine({ tokenConfigured: true });
    const a = await remote.available();
    expect(a).toMatchObject({ ok: false, state: "error" });
    expect(a.reason).not.toMatch(TECH);
  });

  it("Arbeiter meldet sich: ohne CLI → Fehler, ohne Token → wartet, mit beidem → bereit", async () => {
    const remote = new RemoteEngine({ tokenConfigured: true });
    const sock = { send: () => {}, close: () => {} };
    remote.attach(sock);
    remote.onMessage(JSON.stringify({ type: "hello", version: "r1", cli: null, token: true }));
    expect(await remote.available()).toMatchObject({ ok: false, state: "error" });
    remote.onMessage(JSON.stringify({ type: "hello", version: "r1", cli: "2.1.282", token: false }));
    expect(await remote.available()).toMatchObject({ ok: false, state: "waiting_token" });
    remote.onMessage(JSON.stringify({ type: "hello", version: "r1", cli: "2.1.282", token: true }));
    expect(await remote.available()).toMatchObject({ ok: true, state: "ready", version: "2.1.282" });
  });

  it("Status: aus / wartet / bereit – und der Chat meldet 'not_ready' statt „Haiku ist aus“", async () => {
    const t = await setupAssistant({ engine: new RemoteEngine({ tokenConfigured: false }) });
    let s = (await (await t.app.request("/api/haiku/status")).json()) as HaikuStatus;
    expect(s.engine).toMatchObject({ kind: "claude-cli", state: "waiting_token", available: false });
    const e = await readNdjson(await t.json("/api/haiku/chat", { message: "Wer bist du?", context: CTX }));
    expect(e.find((x) => x.type === "error")).toMatchObject({ code: "not_ready" });

    await patchHaikuSettings(t.db, { engine: "off" });
    s = (await (await t.app.request("/api/haiku/status")).json()) as HaikuStatus;
    expect(s.engine).toMatchObject({ kind: "off", state: "off", available: false });
    const e2 = await readNdjson(await t.json("/api/haiku/chat", { message: "Hallo", context: CTX }));
    expect(e2.find((x) => x.type === "error")).toMatchObject({ code: "disabled" });

    const t2 = await setupAssistant({ engine: new FakeEngine(answer("Ich bin Haiku.")) });
    const s2 = (await (await t2.app.request("/api/haiku/status")).json()) as HaikuStatus;
    expect(s2.engine).toMatchObject({ state: "ready", available: true });
  });

  it("Token abgelehnt → Zustand „wartet auf Token“ mit Grund; nächster Erfolg heilt", async () => {
    let fail = true;
    const engine = new FakeEngine(async function* () {
      if (fail) {
        yield { type: "result", text: "Invalid API key · Please run /login", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, model: null, sessionId: null, isError: true, error: "Invalid API key · Please run /login" } as EngineEvent;
        return;
      }
      yield* answer("Ich bin Haiku.")({} as never);
    });
    const t = await setupAssistant({ engine });
    await t.runtime.run({ kind: "chat", scope: "full", systemPrompt: "s", prompt: "p" });
    const s = await t.runtime.status();
    expect(s.engine).toMatchObject({ state: "waiting_token", available: false });
    expect(s.engine.reason).toMatch(/abgelehnt/);
    fail = false;
    const r = await t.runtime.run({ kind: "chat", scope: "full", systemPrompt: "s", prompt: "p" });
    expect(r.type).toBe("final");
    expect((await t.runtime.status()).engine.state).toBe("ready");
  });
});

describe("Selbsttest „Wer bist du?“ (für scripts/haiku-smoke.mjs und „Motor testen“)", () => {
  it("mit Maschinen-Token: echte Frage durch die Laufzeit, Antwort + Dauer, kein Faden", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(answer("Ich bin Haiku, dein Assistent.")), signedIn: false });
    const res = await t.json("/api/haiku/selftest", {}, "POST", { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HaikuSelftest;
    expect(body).toMatchObject({ ok: true, state: "ready", text: "Ich bin Haiku, dein Assistent." });
    expect(typeof body.ms).toBe("number");
    expect((t.engine as FakeEngine).requests[0]?.prompt).toMatch(/Wer bist du\?/);
    const threads = (await (await t.app.request("/api/haiku/threads")).json()) as { threads: HaikuThread[] };
    expect(threads.threads).toHaveLength(0);
  });

  it("ohne Anmeldung → 401; Token fehlt → sofort „wartet“, ohne Motor-Lauf", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(answer("x")), signedIn: false });
    expect((await t.json("/api/haiku/selftest", {})).status).toBe(401);

    const w = await setupAssistant({ engine: new RemoteEngine({ tokenConfigured: false }), signedIn: false });
    const res = await w.json("/api/haiku/selftest", {}, "POST", { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, state: "waiting_token" });
  });

  it("das Maschinen-Token öffnet NUR den Selbsttest, nicht den Chat", async () => {
    const t = await setupAssistant({ engine: new FakeEngine(answer("x")), signedIn: false });
    const res = await t.json("/api/haiku/chat", { message: "Hallo", context: CTX }, "POST", { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
  });
});
