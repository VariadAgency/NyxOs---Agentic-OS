// Telegram spricht mit Nyx über diese kleine Schnittstelle (der Bot bleibt gleich, nur die Umsetzung zählt).
// Die Umsetzung ist der Nyx-Kern (`NyxCore.ask`) – derselbe Weg wie der Web-Chat, nicht mehr der alte
// Haiku-Weg mit eigenem Prompt und eigener Notfall-Verdichtung.
import { t, type HaikuContext } from "@nyxos/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { haikuThreads } from "../db/schema.js";
import type { LiveHub } from "../live.js";
import { isInlineImage, readNyxFile, storeNyxFile } from "../nyx/files.js";
import type { NyxCore } from "../nyx/index.js";
import { onNyxTask } from "../nyx/live.js";
import { compactAnswer } from "../nyx/turn.js";
import { stripRefs } from "./format.js";

export interface NyxAttachment {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface NyxAskRequest {
  threadId: number | null;
  message: string;
  channel: "telegram";
  /** true = der Nutzer hat gesprochen → Nyx-Kanal „voice“ (Antwort wird vorgelesen → kurz, ohne Markdown). */
  voice: boolean;
  attachments: NyxAttachment[];
  signal: AbortSignal;
}

export type NyxEvent =
  | { type: "thread"; threadId: number }
  | { type: "status"; status: "queued" | "thinking" | "tool"; tool?: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; speak: string }
  /** Bild, das Nyx in diesem Faden gezeigt hat (`show_image`, `screenshot_simulator`) → Foto. */
  | { type: "image"; data: Uint8Array; name: string; mime: string; title: string }
  | { type: "error"; message: string };

export interface NyxChannel {
  ask(req: NyxAskRequest): AsyncIterable<NyxEvent>;
  /** Faden verdichten (im selben Faden). `compacted: false` = es gab nichts zu verdichten (`summary` sagt es). */
  compact(threadId: number | null): Promise<{ threadId: number | null; summary: string; compacted?: boolean }>;
}

/** Kurze, sprechbare Fassung: ohne Marker/Markdown, höchstens zwei Sätze bzw. 300 Zeichen. */
export function speakableOf(text: string): string {
  const plain = stripRefs(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
  let out = "";
  for (const s of sentences.slice(0, 2)) if ((out + s).length <= 300) out += s;
  return (out || plain.slice(0, 300)).trim();
}

export interface NyxChannelDeps {
  db: Db;
  hub: LiveHub;
  /** Ablage (`nyx_files`): Bilder lesen, Telegram-Anhänge ablegen. `null` = ohne Bilder. */
  archiveDir: string | null;
  /** Der Nyx-Kern (entsteht mit den Haiku-Routen); `null` = Nyx gerade nicht verfügbar. */
  core: () => NyxCore | null;
}

const TELEGRAM_CONTEXT: HaikuContext = { path: "telegram", tab: null, filters: {}, openSessionId: null, openEntryId: null };
const NOT_READY = "Nyx ist gerade nicht erreichbar.";

/**
 * Telegram spricht mit dem Nyx-Kern (`NyxCore.ask`, dieselbe Runde wie der Web-Chat): Kanal „telegram“,
 * bei Sprachnachrichten „voice“ (Sprech-Regeln, Antwort mit `speak`), Faden-Gedächtnis, Plan, Verdichtung.
 * Bilder, die Nyx in DIESEM Faden zeigt (`show_image`, `screenshot_simulator`), kommen als `image`-Ereignis.
 */
export function runtimeNyxChannel(deps: NyxChannelDeps): NyxChannel {
  const { db, hub, archiveDir } = deps;

  /** Bild-Anhänge landen in der Ablage (Reiter „Bilder“), damit Nyx sie per bild_id zeigen kann. */
  async function describeAttachments(threadId: number | null, attachments: NyxAttachment[]): Promise<string> {
    const parts: string[] = [];
    for (const a of attachments) {
      const kb = Math.max(1, Math.round(a.data.byteLength / 1024));
      if (archiveDir && isInlineImage(a.mime)) {
        const file = await storeNyxFile(db, archiveDir, hub, { bytes: Buffer.from(a.data), mime: a.mime, name: a.name, source: "telegram", threadId });
        parts.push(`${file.name} (Bild, ${kb} KB, bild_id ${file.id})`);
      } else parts.push(`${a.name} (${a.mime}, ${kb} KB)`);
    }
    return parts.length ? `[Anhang über Telegram: ${parts.join(", ")}]` : "";
  }

  async function imageEvent(fileId: number, title: string | undefined): Promise<NyxEvent | null> {
    if (!archiveDir) return null;
    const found = await readNyxFile(db, archiveDir, fileId);
    if (!found || !isInlineImage(found.row.mime)) return null;
    return { type: "image", data: new Uint8Array(found.bytes), name: found.row.name, mime: found.row.mime, title: title || found.row.title || found.row.name };
  }

  return {
    async *ask(req) {
      const core = deps.core();
      if (!core) {
        yield { type: "error", message: t(NOT_READY) };
        return;
      }
      const thread = req.threadId ? (await db.select().from(haikuThreads).where(and(eq(haikuThreads.id, req.threadId), eq(haikuThreads.scope, "full"))).limit(1))[0] : undefined;
      // Bilder aus dem eigenen Faden sammeln, während Nyx arbeitet (Werkzeuge melden sie als `nyx.task`).
      let threadId: number | null = thread?.id ?? null;
      const shown: { fileId: number; title?: string }[] = [];
      const off = onNyxTask(hub, (ev) => {
        if (ev.image && threadId !== null && ev.threadId === threadId && !shown.some((s) => s.fileId === ev.image?.fileId)) shown.push({ fileId: ev.image.fileId, title: ev.image.title });
      });
      let sent = 0;
      const flush = async function* (): AsyncGenerator<NyxEvent> {
        while (sent < shown.length) {
          const s = shown[sent++] as { fileId: number; title?: string };
          const ev = await imageEvent(s.fileId, s.title);
          if (ev) yield ev;
        }
      };
      try {
        const promptSuffix = await describeAttachments(threadId, req.attachments);
        for await (const ev of core.ask({
          thread,
          message: req.message,
          context: TELEGRAM_CONTEXT,
          channel: req.voice ? "voice" : "telegram",
          topic: "telegram",
          title: `Telegram: ${req.message.replace(/\s+/g, " ").slice(0, 70)}`,
          whereLine:
            "Der Nutzer ist am Handy (Telegram), nicht in NyxOS. Den NyxOS-Cursor (ui_*) benutzt du nur, wenn er ausdrücklich etwas im offenen NyxOS-Fenster geklickt, gewechselt oder getippt haben will – sonst app_api.",
          remote: true,
          promptSuffix,
          signal: req.signal,
        })) {
          if (ev.type === "thread") {
            threadId = ev.threadId;
            yield { type: "thread", threadId: ev.threadId };
          } else if (ev.type === "status") yield { type: "status", status: ev.status, tool: ev.tool };
          else if (ev.type === "delta") yield { type: "delta", text: ev.text };
          else if (ev.type === "error") yield { type: "error", message: ev.message };
          else if (ev.type === "done") {
            yield* flush();
            yield { type: "done", text: ev.text, speak: ev.speak || speakableOf(ev.text) };
          }
          yield* flush();
        }
      } finally {
        off();
      }
    },

    // `/compact` = Verdichtung des Kerns im selben Faden (Hermes-Schema; ohne Modell: Notfall-Fassung).
    async compact(threadId) {
      const core = deps.core();
      if (!core) return { threadId, summary: t(NOT_READY), compacted: false };
      if (!threadId) return { threadId: null, summary: t("Da gibt es noch nichts zu verdichten – wir haben noch nicht gesprochen."), compacted: false };
      const r = await core.compact(threadId);
      if (r.mode === "nichts" || !r.summary) return { threadId, summary: compactAnswer(r), compacted: false };
      return { threadId, summary: r.summary, compacted: true };
    },
  };
}
