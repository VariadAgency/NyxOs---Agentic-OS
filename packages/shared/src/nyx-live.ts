// (das EINE Format – der Kern sendet nur noch über diese Schemas): Vertrag für die Live-Ereignisse von Nyx (GOAL „Verträge“ → Nyx-Zustand) und die Bilder-/Datei-Ablage
// des Nyx-Tabs. Der Kern meldet Zustände und Aufgaben über `publishNyxState`/`publishNyxTask`
// (apps/server/src/nyx/live.ts), der Tab (apps/web/src/features/nyx/tab) und Telegram hören zu.
import { z } from "zod";
import { NyxChannelSchema } from "./nyx-persona.js";

export const NYX_STATES = ["idle", "listening", "thinking", "speaking", "tool"] as const;
export type NyxState = (typeof NYX_STATES)[number];

/** Vorschau, die Nyx zu einem Zustand mitgibt (z. B. das Bild, das `show_image` gerade zeigt). */
export const NyxPreviewSchema = z.object({
  kind: z.enum(["image", "link"]),
  url: z.string().min(1).max(2000),
  title: z.string().max(200).optional(),
  /** Bei Bildern aus der Ablage: die ID in `nyx_files`. */
  fileId: z.number().int().positive().optional(),
});
export type NyxPreview = z.infer<typeof NyxPreviewSchema>;

/** `{type:"nyx.state", …}` über `/live`. `node` = Knoten-ID aus dem Gehirn-Graph, der leuchten soll (optional). */
export const NyxStateEventSchema = z.object({
  state: z.enum(NYX_STATES),
  tool: z.string().max(80).optional(),
  detail: z.string().max(300).optional(),
  preview: NyxPreviewSchema.optional(),
  node: z.string().max(300).optional(),
  /** Faden, in dem Nyx gerade arbeitet (Chat, Telegram, Stimme). */
  threadId: z.number().int().positive().nullable().optional(),
  /** Woher die laufende Frage kam. */
  channel: NyxChannelSchema.optional(),
});
export type NyxStateEvent = z.infer<typeof NyxStateEventSchema>;

export const NYX_TASK_PHASES = ["started", "step", "done", "failed"] as const;
export type NyxTaskPhase = (typeof NYX_TASK_PHASES)[number];

export const NYX_STEP_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;
export type NyxStepStatus = (typeof NYX_STEP_STATUSES)[number];

/** `{type:"nyx.task", …}`: Aufgabe begonnen / Schritt / fertig, mit Kurztext und optionalem Bild oder Link. */
export const NyxTaskEventSchema = z.object({
  taskId: z.string().min(1).max(80),
  phase: z.enum(NYX_TASK_PHASES),
  /** Worum es geht, z. B. „Simulator-Screenshot machen“. */
  title: z.string().min(1).max(200),
  /** Kurztext zum aktuellen Schritt, in einfacher Sprache. */
  text: z.string().max(500).optional(),
  /** Wo Nyx das gerade tut (Route in NyxOS, Session, Server …). */
  where: z.string().max(200).optional(),
  /** Route in NyxOS, zu der ein Klick auf die Karte führt. */
  href: z.string().max(500).optional(),
  step: z
    .object({
      index: z.number().int().nonnegative(),
      total: z.number().int().positive().optional(),
      label: z.string().min(1).max(200),
      /** pending = noch offen (Plan-Schritt), cancelled = verworfen. */
      status: z.enum(NYX_STEP_STATUSES),
    })
    .optional(),
  image: z.object({ fileId: z.number().int().positive(), title: z.string().max(200).optional() }).optional(),
  link: z.object({ url: z.string().min(1).max(2000), title: z.string().max(200).optional() }).optional(),
  /** Werkzeug, das dafür läuft (lässt im Netz dessen Knoten leuchten). */
  tool: z.string().max(80).optional(),
  /** Faden, zu dem die Aufgabe gehört (Telegram schickt Bilder nur aus dem eigenen Faden). */
  threadId: z.number().int().positive().nullable().optional(),
  at: z.string().optional(),
});
export type NyxTaskEvent = z.infer<typeof NyxTaskEventSchema>;
/** Wie der Server sie verteilt: immer mit Zeitstempel. */
export type NyxTaskEventOut = NyxTaskEvent & { at: string };

// ───────────── Ablage (Bilder von Nyx, Anhänge vom Nutzer) ─────────────

export const NYX_FILE_KINDS = ["image", "upload"] as const;
export type NyxFileKind = (typeof NYX_FILE_KINDS)[number];

/** Woher eine Datei kommt: von Nyx gezeigt (`show_image`, `simulator`) oder vom Nutzer gegeben (`upload`). */
export const NyxFileSourceSchema = z.enum(["show_image", "simulator", "upload", "telegram"]);
export type NyxFileSource = z.infer<typeof NyxFileSourceSchema>;

/** Größte Datei, die in die Nyx-Ablage geht. */
export const NYX_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** Bild-Arten, die der Browser direkt anzeigen darf (kein SVG: könnte Skripte enthalten). */
export const NYX_INLINE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export interface NyxFile {
  id: number;
  kind: NyxFileKind;
  source: NyxFileSource;
  name: string;
  title: string | null;
  mime: string;
  size: number;
  createdAt: string;
  /** Inline ansehen (nur mit Anmeldung). */
  url: string;
  /** Herunterladen (Content-Disposition: attachment). */
  downloadUrl: string;
}

/** Antwort von `GET /api/nyx/live`: letzter Zustand + jüngste Aufgaben-Ereignisse (für einen frisch geöffneten Tab). */
export interface NyxLiveSnapshot {
  state: NyxStateEvent & { at: string };
  tasks: NyxTaskEventOut[];
}

/** Den Teil einer Antwort speichern, den der Nutzer gehört hat, bevor er Nyx unterbrochen hat. */
export const NyxInterruptedSchema = z.object({
  heard: z.string().max(8000),
  /** Die Frage dieser Runde. Ist inzwischen eine neuere Frage gespeichert, kam die Meldung zu spät (409). */
  question: z.string().max(8000).optional(),
});
export type NyxInterrupted = z.infer<typeof NyxInterruptedSchema>;
