// Aus dem Session-Chat in eine LAUFENDE Session schreiben, mit Anhängen.
//
// Weg: Web (Passkey-Anmeldung + CSRF über `authFetch`, Tor in `terminal/auth.ts`) → diese Route →
// Brücke per RPC: erst `save_upload` (Anhänge landen auf dem Rechner unter
// `~/Library/Application Support/NyxOS/uploads/<session>/`), dann `send_message` (Bildpfade als
// eigene Einfügungen, Text als ein Einfügen, dann Enter). Regeln und Texte in
// `packages/shared/src/session-chat.ts` — dieselbe Sperr-Regel zeigt die Web-App an.
import {
  BRIDGE_CAP_CHAT,
  CHAT_MAX_FILE_BYTES,
  CHAT_MAX_TOTAL_BYTES,
  ChatSendRequestSchema,
  base64Bytes,
  chatAvailability,
  chatFileAllowed,
  chatFileIsImage,
  composeChatInput,
  type ChatSendResult,
  type SaveUploadResult,
  type SendMessageResult,
  type Tool, t } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { claimSend, deliverOrQueue, releaseSend } from "../delivery/queue.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";

export interface SessionChatDeps {
  db: Db;
  bridgeHub: BridgeHub;
  hub?: { broadcast(message: unknown): void };
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Base64 bläht um ein Drittel auf, dazu JSON-Rahmen und Text. */
const BODY_MAX = Math.ceil((CHAT_MAX_TOTAL_BYTES * 4) / 3) + 256 * 1024;
/** Ablegen großer Dateien über den Tunnel darf länger dauern als ein normaler Befehl. */
const UPLOAD_TIMEOUT_MS = 60_000;
/** Einfügen + Enter; großzügig, weil der Rechner unter Last langsam antworten kann. */
const SEND_TIMEOUT_MS = 30_000;

async function findSession(db: Db, idOrUuid: string) {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db.select().from(sessions).where(where).limit(1);
  return row ?? null;
}

function availability(row: NonNullable<Awaited<ReturnType<typeof findSession>>>, bridgeHub: BridgeHub) {
  return chatAvailability(
    { tool: row.tool as Tool, status: row.status, state: row.state, attachable: row.attachable, tmuxName: row.tmuxName },
    { online: bridgeHub.online, supportsChat: bridgeHub.supports(BRIDGE_CAP_CHAT) },
  );
}

const FAILED = "Die Nachricht ist nicht angekommen. Bitte gleich noch einmal senden.";

export function registerSessionChatRoutes(app: Hono<Env>, deps: SessionChatDeps): void {
  const { db, bridgeHub, log } = deps;

  // Sperr-Zustand für die Eingabezeile (dieselbe Regel wie beim Senden).
  app.get("/api/sessions/:id/chat", async (c) => {
    const row = await findSession(db, c.req.param("id"));
    if (!row) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    return c.json(availability(row, bridgeHub));
  });

  app.post("/api/sessions/:id/message", bodyLimit({ maxSize: BODY_MAX, onError: (c) => c.json({ error: t("Die Anhänge sind zusammen zu groß (höchstens 20 MB).") }, 413) }), async (c) => {
    const row = await findSession(db, c.req.param("id"));
    if (!row) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: t("Die Nachricht war unvollständig. Bitte noch einmal senden.") }, 400);
    }
    const parsed = ChatSendRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: t("Schreib etwas oder hänge eine Datei an.") }, 400);
    const { text, attachments } = parsed.data;

    // Dateien prüfen, BEVOR irgendetwas auf den Rechner geht.
    const refused = attachments.find((a) => !chatFileAllowed(a.name));
    if (refused) return c.json({ error: t("„{name}“ kann ich nicht anhängen. Erlaubt sind Bilder, PDF und Text-/Code-Dateien.", { name: refused.name }) }, 400);
    const tooBig = attachments.find((a) => base64Bytes(a.dataBase64) > CHAT_MAX_FILE_BYTES);
    if (tooBig) return c.json({ error: t("„{name}“ ist zu groß (höchstens 10 MB je Datei).", { name: tooBig.name }) }, 413);
    if (attachments.reduce((sum, a) => sum + base64Bytes(a.dataBase64), 0) > CHAT_MAX_TOTAL_BYTES) return c.json({ error: t("Die Anhänge sind zusammen zu groß (höchstens 20 MB).") }, 413);

    const avail = availability(row, bridgeHub);
    if (!avail.canSend || !row.tmuxName) return c.json({ error: avail.message ?? t(FAILED), reason: avail.reason }, 409);

    // Je Datei ein eigener Aufruf: eine Nachricht an die Brücke bleibt so unter ~14 MB (Base64 von
    // höchstens 10 MB) — die installierte Brücke (Bun) nimmt keine beliebig großen Nachrichten an.
    const saved: SaveUploadResult["files"] = [];
    for (const file of attachments) {
      const up = await bridgeHub.rpc("save_upload", { sessionKey: row.id, files: [file] }, UPLOAD_TIMEOUT_MS);
      if (!up.ok) {
        log("chat-anhang-fehlgeschlagen", { session: row.id, code: up.code, error: up.error });
        return c.json({ error: up.code === "bridge_offline" ? t("Dein Mac ist gerade nicht verbunden.") : t("„{name}“ konnte nicht auf deinem Mac abgelegt werden. Bitte noch einmal senden.", { name: file.name }) }, 502);
      }
      saved.push(...(up.result as SaveUploadResult).files);
    }
    const files = saved.map((f) => ({ name: f.name, path: f.path, image: chatFileIsImage(f.name) }));
    const input = composeChatInput(row.tool as Tool, text, files);

    // Arbeitet die Session laut Hook, gar nicht erst einfügen — die Nachricht wartet in der
    // Zustell-Warteschlange der NyxOS und geht raus, sobald die Session wartet (sichtbar, zurückziehbar).
    const enqueue = async (reason?: string) => {
      const q = await deliverOrQueue({ db, bridge: bridgeHub, hub: deps.hub, log }, { sessionKey: row.id, kind: "chat", text: input.text, images: input.images, queueOnly: true, queueReason: reason });
      if (q.status !== "queued") return c.json({ error: q.status === "rejected" ? q.reason : t(FAILED), reason: "not_ready" }, 409);
      log("chat-wartet", { session: row.id, id: q.id });
      return c.json({ sent: true, queued: true, deliveryId: q.id, attachments: files } satisfies ChatSendResult);
    };
    if (row.state !== "waiting") return enqueue();
    // dieselbe 20-s-Sperre wie die Warteschlange — gerade eben ging etwas raus (Hook sagt evtl.
    // noch „wartet“) oder eine Zustellung läuft parallel: nicht hinterhertippen, sondern einreihen.
    if (!claimSend(bridgeHub, row.id, Date.now())) return enqueue();

    // „sofort“ nur, wenn Hooks UND Bildschirm „wartet“ sagen; `onlyWhenIdle`: bei Spinner nicht
    // einfügen, sondern `busy` melden (ältere Brücken kennen das Feld nicht und fügen wie bisher ein).
    const out = await bridgeHub.rpc("send_message", { tmuxName: row.tmuxName, images: input.images, text: input.text, hookWaiting: true, onlyWhenIdle: true }, SEND_TIMEOUT_MS);
    releaseSend(bridgeHub, row.id, (out.ok && (out.result as SendMessageResult | undefined)?.sent === true) || (!out.ok && out.code === "timeout"), Date.now());
    // D-a 3: Zeitüberschreitung heißt NICHT „nicht angekommen“ — die Brücke kann Text und Enter
    // schon eingefügt haben. Ehrlich „unklar“ melden, damit der Nutzer nicht doppelt sendet.
    if (!out.ok && out.code === "timeout") {
      log("chat-senden-unklar", { session: row.id });
      return c.json({ sent: true, queued: false, uncertain: true, attachments: files } satisfies ChatSendResult);
    }
    if (!out.ok) {
      log("chat-senden-fehlgeschlagen", { session: row.id, code: out.code, error: out.error });
      const gone = out.code === "not_found";
      return c.json({ error: gone ? t("Die Session läuft nicht mehr in NyxOS. Übernimm sie neu, dann geht es weiter.") : out.code === "bridge_offline" ? t("Dein Mac ist gerade nicht verbunden.") : t(FAILED) }, gone ? 409 : 502);
    }
    const result = out.result as SendMessageResult;
    if (!result.sent && result.busy) return enqueue(result.reason);
    if (!result.sent) return c.json({ error: result.reason ?? t(FAILED), reason: "not_ready" }, 409);
    log("chat-gesendet", { session: row.id, chars: text.length, files: files.length, busy: result.busy });
    return c.json({ sent: true, queued: result.busy, attachments: files } satisfies ChatSendResult);
  });
}
