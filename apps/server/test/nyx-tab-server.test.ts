// Nyx-Tab (Server-Teil): Live-Ereignisse `nyx.state`/`nyx.task` über `/live`, Bilder-/Datei-Ablage im
// Archiv-Volume (nur mit Anmeldung, Download-Kopf) und „unterbrochen“ — der gehörte Teil einer Antwort wird
// gespeichert, wenn der Nutzer Nyx ins Wort fällt (Lücke aus docs/research/nyx/jarvis-voice.md §5.5).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NyxFile, NyxLiveSnapshot } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { haikuMessages, haikuThreads } from "../src/db/schema.js";
import { publishNyxState, publishNyxTask } from "../src/nyx/live.js";
import { storeNyxFile } from "../src/nyx/files.js";
import { setup } from "./helpers.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

type App = Awaited<ReturnType<typeof setup>>;

function listen(t: App): unknown[] {
  const got: unknown[] = [];
  t.hub.add({ send: (d: string) => void got.push(JSON.parse(d)) });
  return got;
}

async function upload(t: App, body: Buffer, mime: string, name: string, extra: Record<string, string> = {}) {
  return t.app.request("/api/nyx/files", { method: "POST", body, headers: { "content-type": mime, "x-nyx-file-name": encodeURIComponent(name), ...extra } });
}

describe("nyx.state / nyx.task über /live", () => {
  it("verteilt gültige Zustände und Aufgaben an alle offenen /live-Verbindungen", async () => {
    const t = await setup();
    const got = listen(t);
    expect(publishNyxState(t.hub, { state: "tool", tool: "git_lage", detail: "Lese Git" })).toBe(true);
    expect(publishNyxTask(t.hub, { taskId: "t1", phase: "started", title: "Simulator-Screenshot" })).toBe(true);
    expect(got[0]).toMatchObject({ type: "nyx.state", state: "tool", tool: "git_lage", detail: "Lese Git" });
    expect(got[1]).toMatchObject({ type: "nyx.task", taskId: "t1", phase: "started", title: "Simulator-Screenshot" });
    expect(typeof (got[1] as { at?: unknown }).at).toBe("string");
  });

  it("lehnt kaputte Ereignisse ab, statt Müll zu verteilen", async () => {
    const t = await setup();
    const got = listen(t);
    expect(publishNyxState(t.hub, { state: "schlafen" } as never)).toBe(false);
    expect(publishNyxTask(t.hub, { taskId: "", phase: "started", title: "x" })).toBe(false);
    expect(got).toHaveLength(0);
  });

  it("GET /api/nyx/live liefert den letzten Zustand und die jüngsten Aufgaben (frisch geöffneter Tab)", async () => {
    const t = await setup();
    const empty = (await (await t.app.request("/api/nyx/live")).json()) as NyxLiveSnapshot;
    expect(empty.state.state).toBe("idle");
    expect(empty.tasks).toEqual([]);
    publishNyxState(t.hub, { state: "thinking" });
    for (let i = 0; i < 60; i++) publishNyxTask(t.hub, { taskId: `t${i}`, phase: "done", title: `Aufgabe ${i}` });
    const snap = (await (await t.app.request("/api/nyx/live")).json()) as NyxLiveSnapshot;
    expect(snap.state.state).toBe("thinking");
    // Nur die jüngsten 50, neueste zuletzt.
    expect(snap.tasks).toHaveLength(50);
    expect(snap.tasks.at(-1)?.taskId).toBe("t59");
  });

  it("POST /api/nyx/events meldet Zustände von außerhalb des Prozesses (nur angemeldet)", async () => {
    const t = await setup();
    const got = listen(t);
    const ok = await t.post("/api/nyx/events", { kind: "state", event: { state: "speaking" } }, {});
    expect(ok.status).toBe(200);
    expect(got[0]).toMatchObject({ type: "nyx.state", state: "speaking" });
    const bad = await t.post("/api/nyx/events", { kind: "state", event: { state: "nix" } }, {});
    expect(bad.status).toBe(400);
    const anon = await setup({ signedIn: false });
    const denied = await anon.post("/api/nyx/events", { kind: "state", event: { state: "idle" } }, {});
    expect(denied.status).toBe(401);
  });
});

describe("Bilder-Ablage (show_image, Simulator, Anhänge)", () => {
  it("storeNyxFile legt das Bild im Archiv-Volume ab, meldet es live und listet es in der Galerie", async () => {
    const t = await setup();
    const got = listen(t);
    const file = await storeNyxFile(t.db, t.archiveDir, t.hub, { bytes: PNG, mime: "image/png", name: "sim.png", title: "Simulator", source: "simulator" });
    expect(file).toMatchObject({ kind: "image", source: "simulator", mime: "image/png", size: PNG.length, title: "Simulator" });
    expect(file.url).toBe(`/api/nyx/files/${file.id}`);
    expect(file.downloadUrl).toBe(`/api/nyx/files/${file.id}?download=1`);
    const onDisk = join(t.archiveDir, "nyx");
    expect(existsSync(onDisk)).toBe(true);
    expect(got[0]).toMatchObject({ type: "nyx.file", file: { id: file.id, kind: "image" } });
    const list = (await (await t.app.request("/api/nyx/files?kind=image")).json()) as { files: NyxFile[] };
    expect(list.files.map((f) => f.id)).toEqual([file.id]);
  });

  it("liefert das Bild inline aus und mit ?download=1 als Download", async () => {
    const t = await setup();
    const file = await storeNyxFile(t.db, t.archiveDir, t.hub, { bytes: PNG, mime: "image/png", name: "Bild 1.png", source: "show_image" });
    const inline = await t.app.request(file.url);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await inline.arrayBuffer()).equals(PNG)).toBe(true);
    const dl = await t.app.request(file.downloadUrl);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="Bild 1\.png"; filename\*=UTF-8''Bild%201\.png$/);
  });

  it("Bilder und Anhänge gibt es nur mit Anmeldung — auch lesend", async () => {
    const t = await setup({ signedIn: false });
    const file = await storeNyxFile(t.db, t.archiveDir, t.hub, { bytes: PNG, mime: "image/png", name: "a.png", source: "show_image" });
    expect((await t.app.request(file.url)).status).toBe(401);
    expect((await t.app.request("/api/nyx/files")).status).toBe(401);
  });

  it("Alex gibt Nyx eine Datei: Upload landet als Anhang, Bilder zusätzlich in der Galerie", async () => {
    const t = await setup();
    const txt = await upload(t, Buffer.from("Notiz für Nyx"), "text/plain", "notiz.txt");
    expect(txt.status).toBe(200);
    const { file } = (await txt.json()) as { file: NyxFile };
    expect(file).toMatchObject({ kind: "upload", source: "upload", name: "notiz.txt", mime: "text/plain" });
    const img = (await (await upload(t, PNG, "image/png", "foto.png")).json()) as { file: NyxFile };
    expect(img.file.kind).toBe("image");
    const gallery = (await (await t.app.request("/api/nyx/files?kind=image")).json()) as { files: NyxFile[] };
    expect(gallery.files.map((f) => f.name)).toEqual(["foto.png"]);
    // Textdateien werden nie als HTML o. Ä. ausgeliefert, sondern immer als Download.
    const served = await t.app.request(file.url);
    expect(served.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(readFileSync(join(t.archiveDir, "nyx", (await import("node:fs")).readdirSync(join(t.archiveDir, "nyx")).find((n) => n.endsWith(".txt")) ?? "x"), "utf8")).toBe("Notiz für Nyx");
  });

  it("SVG ist nie ein Inline-Bild (könnte Skripte enthalten), zu große Dateien werden abgelehnt", async () => {
    const t = await setup();
    const svg = (await (await upload(t, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), "image/svg+xml", "x.svg")).json()) as { file: NyxFile };
    expect(svg.file.kind).toBe("upload");
    const served = await t.app.request(svg.file.url);
    expect(served.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    const big = await upload(t, Buffer.alloc(21 * 1024 * 1024), "application/octet-stream", "gross.bin");
    expect(big.status).toBe(413);
    const noName = await t.app.request("/api/nyx/files", { method: "POST", body: PNG, headers: { "content-type": "image/png" } });
    expect(noName.status).toBe(400);
  });

  it("unbekannte ID → 404", async () => {
    const t = await setup();
    expect((await t.app.request("/api/nyx/files/999")).status).toBe(404);
    expect((await t.app.request("/api/nyx/files/abc")).status).toBe(404);
  });
});

describe("Unterbrechen: gehörter Teil wird als „unterbrochen“ gespeichert", () => {
  async function thread(t: App) {
    const [th] = await t.db.insert(haikuThreads).values({ scope: "full", topic: "nyx", day: "2026-09-25", title: "Stimme" }).returning();
    const id = (th as { id: number }).id;
    await t.db.insert(haikuMessages).values({ threadId: id, role: "user", text: "Was läuft gerade?" });
    return id;
  }

  it("legt eine Antwort mit dem gehörten Text an, wenn der Server noch keine gespeichert hat", async () => {
    const t = await setup();
    const id = await thread(t);
    const res = await t.post(`/api/haiku/threads/${id}/interrupted`, { heard: "Gerade laufen drei Sessions." }, {});
    expect(res.status).toBe(200);
    const body = (await (await t.app.request(`/api/haiku/threads/${id}`)).json()) as { messages: { role: string; text: string; interrupted?: boolean }[] };
    expect(body.messages.at(-1)).toMatchObject({ role: "assistant", text: "Gerade laufen drei Sessions.", interrupted: true });
    expect(body.messages[0]).toMatchObject({ role: "user", interrupted: false });
  });

  it("kürzt eine schon gespeicherte volle Antwort auf den gehörten Teil (Wettlauf Abbruch ↔ Ende)", async () => {
    const t = await setup();
    const id = await thread(t);
    await t.db.insert(haikuMessages).values({ threadId: id, role: "assistant", text: "Gerade laufen drei Sessions. Eine wartet auf dich, zwei arbeiten." });
    await t.post(`/api/haiku/threads/${id}/interrupted`, { heard: "Gerade laufen drei Sessions." }, {});
    const body = (await (await t.app.request(`/api/haiku/threads/${id}`)).json()) as { messages: { role: string; text: string; interrupted?: boolean }[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toMatchObject({ text: "Gerade laufen drei Sessions.", interrupted: true });
  });

  it("kommt die Meldung zu spät (Alex hat schon neu gefragt), bleibt die neue Runde unangetastet", async () => {
    const t = await setup();
    const id = await thread(t);
    await t.db.insert(haikuMessages).values({ threadId: id, role: "assistant", text: "Gerade laufen drei Sessions." });
    await t.db.insert(haikuMessages).values({ threadId: id, role: "user", text: "Und welche wartet?" });
    await t.db.insert(haikuMessages).values({ threadId: id, role: "assistant", text: "Die Session Heatmap wartet auf dich." });
    const res = await t.post(`/api/haiku/threads/${id}/interrupted`, { heard: "Gerade", question: "Was läuft gerade?" }, {});
    expect(res.status).toBe(409);
    const body = (await (await t.app.request(`/api/haiku/threads/${id}`)).json()) as { messages: { role: string; text: string; interrupted?: boolean }[] };
    expect(body.messages).toHaveLength(4);
    expect(body.messages.at(-1)).toMatchObject({ text: "Die Session Heatmap wartet auf dich.", interrupted: false });
  });

  it("nichts gehört → Kennzeichen „(unterbrochen, bevor Nyx etwas sagen konnte)“ statt leerer Antwort", async () => {
    const t = await setup();
    const id = await thread(t);
    await t.post(`/api/haiku/threads/${id}/interrupted`, { heard: "  " }, {});
    const body = (await (await t.app.request(`/api/haiku/threads/${id}`)).json()) as { messages: { text: string; interrupted?: boolean }[] };
    expect(body.messages.at(-1)).toMatchObject({ interrupted: true });
    expect(body.messages.at(-1)?.text).toMatch(/unterbrochen/);
  });

  it("unbekannter Faden → 404", async () => {
    const t = await setup();
    expect((await t.post("/api/haiku/threads/4242/interrupted", { heard: "x" }, {})).status).toBe(404);
  });
});
