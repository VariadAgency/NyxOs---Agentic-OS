// Session-Chat: in eine laufende Session schreiben (mit Anhang), „Kontext komprimieren“ nur, wenn die
// Session wartet, und der Chat-Verlauf ungekürzt. Brücke im selben Prozess (Fake-Socket).
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { BRIDGE_CAP_CHAT, type ServerToBridge, type TranscriptResponse } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type App = Awaited<ReturnType<typeof setup>>;
const TECH = /tmux|CSRF|ENOENT|nicht gefunden|bridge/i;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

/** Brücke im selben Prozess: meldet ihre Fähigkeiten und beantwortet RPCs nach Skript. */
function fakeBridge(hub: BridgeHub, opts: { caps?: string[]; sendMessage?: { sent: boolean; busy: boolean; reason?: string }; sendText?: { sent: boolean; reason?: string } } = {}) {
  const calls: RpcCall[] = [];
  const socket = {
    send(data: string) {
      const msg = JSON.parse(data) as ServerToBridge;
      if (msg.op !== "rpc") return;
      const params = msg.params as Record<string, unknown>;
      calls.push({ method: msg.method, params });
      let result: unknown = { ok: true };
      if (msg.method === "save_upload") {
        const files = params.files as { name: string; dataBase64: string }[];
        result = { files: files.map((f, i) => ({ name: f.name, path: `/Users/test/Library/Application Support/NyxOS/uploads/claude-s1/${i}-${f.name}`, bytes: 10 })) };
      }
      if (msg.method === "send_message") result = opts.sendMessage ?? { sent: true, busy: false };
      if (msg.method === "send_text") result = opts.sendText ?? { sent: true };
      queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result })));
    },
    close() {},
  };
  hub.attach(socket, "m1");
  hub.handle(JSON.stringify({ op: "hello", version: "r1", tmuxSocket: "nyxos", caps: opts.caps ?? [BRIDGE_CAP_CHAT] }));
  return { calls };
}

async function insertSession(t: App, overrides: Partial<typeof sessions.$inferInsert> = {}) {
  await t.db.insert(sessions).values({
    id: "claude:s1",
    sessionId: "s1",
    tool: "claude",
    status: "running",
    state: "waiting",
    attachable: true,
    tmuxName: "zc-claude-abcd1234",
    models: ["claude-opus-5-5"],
    ...overrides,
  });
}

function send(t: App, body: unknown, headers: Record<string, string> = {}) {
  return t.app.request("/api/sessions/claude:s1/message", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("Nachricht an die laufende Session", () => {
  it("ohne Anmeldung geht nichts raus", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub, signedIn: false });
    const bridge = fakeBridge(hub);
    await insertSession(t);
    const res = await send(t, { text: "Hallo" });
    expect([401, 403]).toContain(res.status);
    expect(bridge.calls).toEqual([]);
  });

  it("Text ohne Anhang: genau ein send_message an die richtige tmux-Session, Antwort „nicht in der Warteschlange“", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub);
    await insertSession(t);
    const res = await send(t, { text: "Zeile 1\nZeile 2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, queued: false, attachments: [] });
    expect(bridge.calls).toEqual([{ method: "send_message", params: { tmuxName: "zc-claude-abcd1234", images: [], text: "Zeile 1\nZeile 2", hookWaiting: true, onlyWhenIdle: true } }]);
  });

  it("mit Bild + Textdatei: erst ablegen (save_upload), dann Bild als eigenes Einfügen, Datei als @\"pfad\"", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub);
    await insertSession(t);
    const txt = Buffer.from("Zauberwort: Kolibri").toString("base64");
    const res = await send(t, { text: "Schau dir das an", attachments: [{ name: "rot.png", dataBase64: PNG_B64 }, { name: "notiz.txt", dataBase64: txt }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachments: { name: string; image: boolean }[] };
    expect(body.attachments.map((a) => [a.name, a.image])).toEqual([
      ["rot.png", true],
      ["notiz.txt", false],
    ]);
    // Je Datei ein eigener Aufruf (Nachrichtengröße zur Brücke bleibt klein).
    expect(bridge.calls.map((c) => c.method)).toEqual(["save_upload", "save_upload", "send_message"]);
    expect(bridge.calls[0]?.params).toMatchObject({ sessionKey: "claude:s1", files: [{ name: "rot.png" }] });
    expect(bridge.calls[1]?.params).toMatchObject({ sessionKey: "claude:s1", files: [{ name: "notiz.txt" }] });
    const dir = "/Users/test/Library/Application Support/NyxOS/uploads/claude-s1";
    expect(bridge.calls[2]?.params).toEqual({ tmuxName: "zc-claude-abcd1234", images: [`${dir}/0-rot.png`], text: `Schau dir das an\n\nAnhang: @"${dir}/0-notiz.txt"`, hookWaiting: true, onlyWhenIdle: true });
  });

  it("Session arbeitet gerade → angenommen, steht in der Warteschlange", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    fakeBridge(hub, { sendMessage: { sent: true, busy: true } });
    await insertSession(t, { state: "running" });
    const res = await send(t, { text: "Und danach bitte die Tests" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, queued: true });
  });

  it("offene Freigabe-Frage im Terminal → nichts eingefügt, klarer Satz statt Technik", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    fakeBridge(hub, { sendMessage: { sent: false, busy: false, reason: "Die Session wartet auf eine Freigabe. Beantworte sie zuerst im Terminal." } });
    await insertSession(t);
    const res = await send(t, { text: "ja" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Freigabe/);
  });

  it("Brücke antwortet nicht rechtzeitig → „unklar, ob angekommen“ statt „nochmal senden“ (kein Doppelt-Senden)", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const socket = { send() {}, close() {} }; // beantwortet nie
    hub.attach(socket, "m1");
    hub.handle(JSON.stringify({ op: "hello", version: "r1", tmuxSocket: "nyxos", caps: [BRIDGE_CAP_CHAT] }));
    await insertSession(t);
    const origRpc = hub.rpc.bind(hub);
    hub.rpc = ((method: Parameters<typeof hub.rpc>[0], params: unknown) => origRpc(method, params, 50)) as typeof hub.rpc;
    const res = await send(t, { text: "Hallo" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, uncertain: true });
  });

  it("Session läuft nicht in der NyxOS → gesperrt (409), die Brücke wird nie gefragt", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub);
    await insertSession(t, { attachable: false, tmuxName: null });
    const res = await send(t, { text: "Hallo" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe("not_in_nyxos");
    expect(body.error).not.toMatch(TECH);
    expect(bridge.calls).toEqual([]);
  });

  it("alte Brücke ohne Chat-Fähigkeit → ehrlich gesperrt", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub, { caps: ["run_build"] });
    await insertSession(t);
    const res = await send(t, { text: "Hallo" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("bridge_outdated");
    expect(bridge.calls).toEqual([]);
  });

  it("verbotene Dateiart → 400, zu groß → 413; nichts wird abgelegt", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub);
    await insertSession(t);
    const bad = await send(t, { text: "x", attachments: [{ name: "virus.exe", dataBase64: PNG_B64 }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/virus\.exe/);
    const big = Buffer.alloc(10 * 1024 * 1024 + 10, 1).toString("base64");
    const tooBig = await send(t, { text: "x", attachments: [{ name: "gross.png", dataBase64: big }] });
    expect(tooBig.status).toBe(413);
    expect(bridge.calls).toEqual([]);
  });

  it("GET …/chat liefert denselben Sperr-Zustand wie die Prüfung beim Senden", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    fakeBridge(hub);
    await insertSession(t, { state: "running" });
    const res = await t.app.request("/api/sessions/claude:s1/chat");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canSend: true, reason: null, message: null, busy: true });
  });
});

describe("„Kontext komprimieren“ nur, wenn die Session wartet", () => {
  it("arbeitet die Session → 409 mit Grund, kein /compact", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub);
    await insertSession(t, { state: "running" });
    const res = await t.app.request("/api/context-guard/sessions/claude:s1/compact-now", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ onlyWhenWaiting: true }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).not.toMatch(TECH);
    expect(bridge.calls).toEqual([]);
  });

  it("wartet die Session → /compact geht raus, die Brücke prüft den Bildschirm noch einmal", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub);
    await insertSession(t, { state: "waiting" });
    const res = await t.app.request("/api/context-guard/sessions/claude:s1/compact-now", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ onlyWhenWaiting: true }) });
    expect(res.status).toBe(200);
    expect(bridge.calls).toEqual([{ method: "send_text", params: { tmuxName: "zc-claude-abcd1234", text: "/compact", submit: true, onlyWhenWaiting: true, hookWaiting: true } }]);
  });
});

describe("Chat-Verlauf zeigt den vollen Text", () => {
  it("eine 3.000-Zeichen-Nachricht kommt ungekürzt im Transkript an (Anfang und Ende)", async () => {
    const t = await setup();
    const sid = "dddddddd-0000-4000-8000-00000000d011";
    const long = `ANFANG-${"y".repeat(3000 - 12)}-ENDE`;
    const base = { isSidechain: false, cwd: "/Users/alex/projects", sessionId: sid, version: "2.1.282" };
    const raw = Buffer.from(
      [
        JSON.stringify({ ...base, type: "user", uuid: "u-1", timestamp: "2026-09-25T10:00:00.000Z", message: { role: "user", content: long } }),
        JSON.stringify({ ...base, type: "assistant", uuid: "u-2", timestamp: "2026-09-25T10:00:03.000Z", message: { model: "claude-opus-5-5", id: "m1", role: "assistant", content: [{ type: "text", text: long }] } }),
      ].join("\n") + "\n",
    );
    const sha = createHash("sha256").update(raw).digest("hex");
    const up = await t.app.request("/ingest/archive", {
      method: "POST",
      body: gzipSync(raw),
      headers: {
        authorization: t.auth.authorization,
        "x-nyxos-tool": "claude",
        "x-nyxos-session": sid,
        "x-nyxos-path": encodeURIComponent(`-Users-alex-projects/${sid}.jsonl`),
        "x-nyxos-sha256": sha,
        "x-nyxos-size": String(raw.length),
      },
    });
    expect(up.status).toBe(200);
    const res = await t.app.request(`/api/sessions/${sid}/transcript`);
    const body = (await res.json()) as TranscriptResponse;
    const texts = body.items.filter((i) => i.role === "user" || i.role === "assistant").map((i) => i.text ?? "");
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toHaveLength(3000);
      expect(text.startsWith("ANFANG-")).toBe(true);
      expect(text.endsWith("-ENDE")).toBe(true);
    }
  });
});
