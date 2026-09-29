// Aus dem Session-Chat der NyxOS in eine LAUFENDE Session schreiben (mit Anhängen).
// Gemeinsam für Web (Eingabe, Sperr-Zustand), Server (Route, Prüfungen) und Brücke (Dateien ablegen,
// Text einfügen). Nur Daten und reine Funktionen — keine Nebenwirkungen.
//
// So kommt eine Nachricht bei Claude Code an (geprüft am 25.09.2026 mit Claude Code 2.1.282 in tmux,
//):
// - Bilder: der rohe Dateipfad als EIGENES Einfügen (tmux `paste-buffer -p`, „bracketed paste“) wird
//   zu „[Image #1]“ — genau wie beim Ziehen eines Bildes ins Terminal. Leerzeichen im Pfad sind egal.
// - Andere Dateien: `@"<pfad>"` im Text — Claude Code liest die Datei selbst ein, OHNE Rückfrage, auch
//   außerhalb des Arbeitsordners. (Ein bloßer Pfad im Text löst dagegen eine Lese-Freigabe aus.)
// - Mehrzeiliger Text als ein Einfügen bleibt EIN Prompt (Enter erst danach).
// - Arbeitet die Session gerade, nimmt Claude Code die Nachricht in seine Warteschlange („queued
//   messages“) und liest sie nach dem laufenden Schritt. Die NyxOS zeigt das ehrlich an.
// - Steht eine Freigabe-Frage offen („Do you want to proceed?“), wird NICHTS eingefügt: Text oder Enter
//   könnten sonst eine Auswahl treffen.
// Codex: Bildpfad als eigenes Einfügen hängt das Bild an; andere Dateien stehen als Pfad im Text (Codex
// liest selbst). Mit Codex noch nicht live geprüft (Codex-Limit bis 28.09.).
import { z } from "zod";
import { t } from "./i18n/index.js";
import { TMUX_NAME_RE } from "./terminal.js";

/** Obergrenzen (Server prüft, Brücke prüft noch einmal). */
export const CHAT_MAX_TEXT = 20_000;
export const CHAT_MAX_FILES = 5;
export const CHAT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CHAT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Fähigkeit der Brücke (aus ihrem `hello`), ältere Brücken können das noch nicht. */
export const BRIDGE_CAP_CHAT = "chat_send";

/** Erlaubte Dateiarten: Endung → Bild ja/nein. Alles andere wird abgelehnt. */
export const CHAT_FILE_TYPES: Record<string, { image: boolean; label: string }> = {
  png: { image: true, label: "Bild" },
  jpg: { image: true, label: "Bild" },
  jpeg: { image: true, label: "Bild" },
  gif: { image: true, label: "Bild" },
  webp: { image: true, label: "Bild" },
  pdf: { image: false, label: "PDF" },
  txt: { image: false, label: "Text" },
  md: { image: false, label: "Text" },
  csv: { image: false, label: "Tabelle" },
  json: { image: false, label: "Daten" },
  log: { image: false, label: "Protokoll" },
  yaml: { image: false, label: "Daten" },
  yml: { image: false, label: "Daten" },
  html: { image: false, label: "Webseite" },
  css: { image: false, label: "Code" },
  js: { image: false, label: "Code" },
  ts: { image: false, label: "Code" },
  tsx: { image: false, label: "Code" },
  swift: { image: false, label: "Code" },
  sql: { image: false, label: "Code" },
  sh: { image: false, label: "Code" },
  py: { image: false, label: "Code" },
};

export function chatFileExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? (m[1] as string).toLowerCase() : "";
}

export function chatFileAllowed(name: string): boolean {
  return chatFileExt(name) in CHAT_FILE_TYPES;
}

export function chatFileIsImage(name: string): boolean {
  return CHAT_FILE_TYPES[chatFileExt(name)]?.image ?? false;
}

/** Dateiname, der sicher im Upload-Ordner landen darf: nur der letzte Teil, harmlose Zeichen, Endung bleibt. */
export function safeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const ext = chatFileExt(base);
  const stem = (ext ? base.slice(0, -(ext.length + 1)) : base)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+/g, "-")
    .slice(0, 60);
  return `${stem || "anhang"}${ext ? `.${ext}` : ""}`;
}

/** Ungefähre Byte-Größe eines Base64-Inhalts (ohne ihn zu dekodieren). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export const ChatAttachmentSchema = z.object({
  name: z.string().min(1).max(200),
  /** Inhalt als Base64 (ohne `data:`-Vorsatz). */
  dataBase64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatSendRequestSchema = z
  .object({
    text: z.string().max(CHAT_MAX_TEXT).default(""),
    attachments: z.array(ChatAttachmentSchema).max(CHAT_MAX_FILES).default([]),
  })
  .refine((v) => v.text.trim().length > 0 || v.attachments.length > 0, { error: () => t("Nachricht ist leer") });
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;

export interface ChatSendResult {
  sent: true;
  /** Die Session arbeitete gerade: die Nachricht wartet in der Zustell-Warteschlange der NyxOS
   * und geht raus, sobald die Session wartet. */
  queued: boolean;
  /** Eintrag in der Zustell-Warteschlange (zum Zurückziehen). */
  deliveryId?: number;
  /** Die Brücke hat nicht rechtzeitig geantwortet — die Nachricht kann angekommen sein oder nicht. */
  uncertain?: boolean;
  attachments: { name: string; path: string; image: boolean }[];
}

/** Ein Eintrag der Zustell-Warteschlange („geht raus, sobald die Session wartet“). */
export interface SessionDeliveryView {
  id: number;
  kind: "compact" | "approval" | "inbox" | "haiku_answer" | "chat";
  text: string;
  /** `sending` = die Brücke tippt gerade (nicht mehr zurückziehbar). */
  status: "queued" | "sending" | "sent" | "expired" | "failed" | "cancelled";
  reason: string | null;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  doneAt: string | null;
}

// ── Sperr-Zustand: Wann kann der Nutzer hier schreiben? ────────────────────────────────────────────

export type ChatBlockReason = "bridge_offline" | "bridge_outdated" | "not_in_nyxos" | "ended";

export interface ChatAvailability {
  canSend: boolean;
  reason: ChatBlockReason | null;
  /** Ein Satz für den Nutzer (kein Technik-Wort), was los ist und was er tun kann. */
  message: string | null;
  /** Die Session arbeitet gerade – eine Nachricht landet in ihrer Warteschlange. */
  busy: boolean;
}

export interface ChatSessionFacts {
  tool: "claude" | "codex";
  status: "running" | "ended" | string;
  state: string | null;
  attachable?: boolean | null;
  tmuxName?: string | null;
}

/** EINE Regel für Web (Anzeige) und Server (Prüfung). */
export function chatAvailability(s: ChatSessionFacts, bridge: { online: boolean; supportsChat: boolean }): ChatAvailability {
  const who = s.tool === "codex" ? "Codex" : "Claude";
  const inNyxOS = !!s.attachable && !!s.tmuxName && TMUX_NAME_RE.test(s.tmuxName);
  if (!bridge.online) return { canSend: false, reason: "bridge_offline", message: t("Dein Mac ist gerade nicht verbunden. Sobald er wieder da ist, kannst du hier schreiben."), busy: false };
  if (!inNyxOS) {
    const ended = s.status !== "running" || s.state === "closed" || s.state === "crashed";
    return ended
      ? { canSend: false, reason: "ended", message: t("Diese Session läuft gerade nicht. Übernimm sie in NyxOS, dann kannst du hier mit {who} weiterschreiben.", { who }), busy: false }
      : { canSend: false, reason: "not_in_nyxos", message: t("Diese Session läuft in einem eigenen Terminal-Fenster. Übernimm sie in NyxOS, dann kannst du hier schreiben."), busy: false };
  }
  if (!bridge.supportsChat) return { canSend: false, reason: "bridge_outdated", message: t("Die Brücke braucht noch ein Update, dann geht Schreiben hier. Das Update kommt mit dem nächsten Einspielen."), busy: false };
  return { canSend: true, reason: null, message: null, busy: s.state === "running" };
}

// ── Brücke: Anhänge ablegen, Nachricht einfügen ─────────────────────────────────────────────────

/** Ordnername je Session im Upload-Ordner (`<tool>:<id>` → `<tool>-<id>`), nur harmlose Zeichen. */
export const UploadSessionKeySchema = z.string().regex(/^(claude|codex):[A-Za-z0-9_-]{1,100}$/);

export const SaveUploadRequestSchema = z.object({
  sessionKey: UploadSessionKeySchema,
  files: z.array(ChatAttachmentSchema).min(1).max(CHAT_MAX_FILES),
});
export type SaveUploadRequest = z.infer<typeof SaveUploadRequestSchema>;

export interface SaveUploadResult {
  files: { name: string; path: string; bytes: number }[];
}

export const SendMessageRequestSchema = z.object({
  tmuxName: z.string().regex(TMUX_NAME_RE),
  /** Absolute Bildpfade, je einzeln eingefügt (→ „[Image #n]“). */
  images: z.array(z.string().min(1).max(1000)).max(CHAT_MAX_FILES).default([]),
  /** Der eigentliche Text (darf mehrzeilig sein), als EIN Einfügen. */
  text: z.string().max(CHAT_MAX_TEXT + 4000).default(""),
  /** Zustand laut Hooks (Server): `false` = Runde offen → „in der Warteschlange“. */
  hookWaiting: z.boolean().optional(),
  /** nur bei leerer Eingabe einfügen — arbeitet die Session, `{ sent: false, busy: true }` statt einfügen. */
  onlyWhenIdle: z.boolean().optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export interface SendMessageResult {
  sent: boolean;
  /** Die Session arbeitete gerade (Nachricht steht in ihrer Warteschlange). */
  busy: boolean;
  /** Nur bei `sent: false`: warum nicht (für den Nutzer formuliert). */
  reason?: string;
}

/**
 * Steuerzeichen entfernen (außer Zeilenumbruch/Tab): Ein eingefügter Text darf nie aus dem
 * Einfüge-Modus ausbrechen (ESC [201~) oder Tasten auslösen.
 */
export function sanitizePasteText(text: string): string {
  // eslint-disable-next-line no-control-regex -- genau diese Steuerzeichen sollen raus
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/** Text + Anhangs-Pfade zu dem, was eingefügt wird (Claude: `@"pfad"`, Codex: Pfad im Text). */
export function composeChatInput(tool: "claude" | "codex", text: string, files: { path: string; image: boolean }[]): { images: string[]; text: string } {
  const images = files.filter((f) => f.image).map((f) => f.path);
  const others = files.filter((f) => !f.image).map((f) => f.path);
  const body = sanitizePasteText(text).trim();
  const refs = others.map((p) => (tool === "claude" ? `@"${p}"` : p));
  const tail = refs.length === 0 ? "" : `${body ? "\n\n" : ""}${refs.length === 1 ? t("Anhang: {files}", { files: refs.join(" ") }) : t("Anhänge: {files}", { files: refs.join(" ") })}`;
  return { images, text: `${body}${tail}` };
}
