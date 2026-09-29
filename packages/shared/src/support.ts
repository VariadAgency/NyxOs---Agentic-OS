// "Feedback & Unterstützen" (open-source edition only): bug reports, ideas and donations ("Buy me Tokens") straight
// from NyxOS. The web app talks to `/api/support/*` on the own NyxOS server; that server forwards to the support
// service of the project website (`docs/support-api.md`). Nothing here leaves NyxOS without a click by the user.
//
// This file holds the contracts (zod), the limits, the diagnostics clean-up and the check for messages of the
// embedded payment page — shared by server, web app and tests, so all three agree on one definition.
import { z } from "zod";
import { redactSecrets, SECRET_MASK } from "./redact.js";

/**
 * Address of the NyxOS support service (the project website), e.g. `https://nyxos.example.org/support`.
 * EMPTY = not set up yet: bug reports and ideas wait in the outbox and go out by themselves once an address is
 * there; "Buy me Tokens" says honestly that payment is being set up. This constant is the ONLY place for the
 * default. Overrides: the environment variable `NYXOS_SUPPORT_URL`, then the setting in the sheet (docs/configuration.md).
 */
export const SUPPORT_URL_DEFAULT = "";

export const SUPPORT_LIMITS = {
  /** Free text fields (what happened, steps, expected, description). */
  textChars: 4000,
  titleChars: 160,
  emailChars: 200,
  nameChars: 80,
  messageChars: 500,
  /** Screenshot: the file itself (before base64). */
  screenshotBytes: 2 * 1024 * 1024,
  /** A whole request to `/api/support/*` (base64 screenshot + texts). */
  requestBytes: 4 * 1024 * 1024,
  /** Diagnostics: how many recent error lines and how long each may be. */
  errors: 10,
  errorChars: 300,
  amountMinCents: 100,
  amountMaxCents: 100_000,
  /** Forwarding to the support service. */
  timeoutMs: 10_000,
  responseBytes: 64 * 1024,
} as const;

/** Amount chips of "Buy me Tokens" (euros). */
export const SUPPORT_AMOUNTS_EUR = [3, 5, 10, 25] as const;
export const SUPPORT_SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

// ---------------------------------------------------------------------------------------------------------------
// Diagnostics

export const SupportErrorEntrySchema = z.object({
  source: z.enum(["browser", "server"]),
  /** ISO time of the error. */
  at: z.string().max(40),
  message: z.string().max(SUPPORT_LIMITS.errorChars),
});
export type SupportErrorEntry = z.infer<typeof SupportErrorEntrySchema>;

/** Exactly what "Diagnose anhängen" sends — the preview in the sheet shows this object as it is. */
export const SupportDiagnosticsSchema = z.object({
  version: z.string().max(40),
  mode: z.enum(["local", "server", "unknown"]),
  os: z.string().max(60),
  browser: z.string().max(60),
  /** Only the area of the page (first path part), never ids or project names. */
  page: z.string().max(80),
  language: z.string().max(10),
  errors: z.array(SupportErrorEntrySchema).max(SUPPORT_LIMITS.errors),
});
export type SupportDiagnostics = z.infer<typeof SupportDiagnosticsSchema>;

export interface SanitizeOptions {
  /** Personal words the text must not contain (the user's name, the account name on the computer). */
  words?: readonly string[];
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'<>()[\]{}]+/gi;
// File paths: home folders and the usual system roots (unix), `~/…`, Windows drives and shares. API routes such as
// `/api/support/bug` stay readable — they help and are not personal.
const UNIX_PATH_RE = /(?<![\w.\]])(?:~(?=\/)|\/(?:Users|home|root|private|var|tmp|opt|Volumes|mnt|srv|etc|usr|Library|Applications|System|nix|snap|workspace|data|archive)(?=[/\s"':),]|$))(?:\/[^\s"'<>:),]*)*/g;
const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s"'<>]*|\\\\[^\s"'<>\\]+\\[^\s"'<>]*/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;
const PRIVATE_HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:local|lan|internal|localdomain|home\.arpa|ts\.net|fritz\.box)\b/gi;
const PUBLIC_HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|de|io|dev|app|cloud|eu|ch|at|co|uk|me|xyz|info|biz|ai|sh|nl|fr|it|es|se|no|dk|pl|us)\b/gi;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{24,}\b/gi;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cleans one text for the diagnostics: no paths, host names, IP addresses, e-mail addresses, tokens/keys, ids or
 * personal words. Idempotent (cleaning twice gives the same text), so the preview is exactly what is sent even
 * though the server cleans again before forwarding.
 */
export function sanitizeDiagnosticText(text: string, opts: SanitizeOptions = {}): string {
  let s = text;
  for (const w of opts.words ?? []) {
    const word = w.trim();
    if (word.length >= 3) s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, "giu"), "[name]");
  }
  s = s.replace(EMAIL_RE, "[email]");
  s = s.replace(URL_RE, (_m, scheme: string) => (/^(https?|wss?)$/i.test(scheme) ? `${scheme.toLowerCase()}://[host]` : "[path]"));
  s = s.replace(UNIX_PATH_RE, "[path]");
  s = s.replace(WIN_PATH_RE, "[path]");
  s = s.replace(IPV4_RE, "[ip]");
  s = s.replace(IPV6_RE, (m) => (/[a-f]/i.test(m) || m.includes("::") ? "[ip]" : m));
  s = s.replace(PRIVATE_HOST_RE, "[host]");
  s = s.replace(PUBLIC_HOST_RE, "[host]");
  s = redactSecrets(s);
  s = s.replace(UUID_RE, "[id]");
  s = s.replace(LONG_HEX_RE, SECRET_MASK);
  s = s.replace(LONG_TOKEN_RE, SECRET_MASK);
  return s;
}

/** Only the area of a page: `/sessions/coding/my-project/abc` → `/sessions/…`. Query and hash are dropped. */
export function sanitizePagePath(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  const first = parts[0];
  if (!first || !/^[a-z][a-z-]{0,30}$/.test(first)) return "/";
  return parts.length > 1 ? `/${first}/…` : `/${first}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Cleans the whole diagnostics object (idempotent, keeps the limits of the schema). */
export function sanitizeDiagnostics(d: SupportDiagnostics, opts: SanitizeOptions = {}): SupportDiagnostics {
  const text = (v: string, max: number) => clip(sanitizeDiagnosticText(v, opts), max);
  return {
    version: text(d.version, 40),
    mode: d.mode,
    os: text(d.os, 60),
    browser: text(d.browser, 60),
    page: sanitizePagePath(d.page),
    language: text(d.language, 10),
    errors: d.errors.slice(-SUPPORT_LIMITS.errors).map((e) => ({ source: e.source, at: clip(e.at, 40), message: text(e.message, SUPPORT_LIMITS.errorChars) })),
  };
}

/** "Chrome 140" / "macOS" from a user agent — only the family and the major version, nothing unique. */
export function describeUserAgent(ua: string): { browser: string; os: string } {
  const major = (re: RegExp) => ua.match(re)?.[1] ?? "";
  let browser = "";
  if (/Edg\//.test(ua)) browser = `Edge ${major(/Edg\/(\d+)/)}`;
  else if (/Firefox\//.test(ua)) browser = `Firefox ${major(/Firefox\/(\d+)/)}`;
  else if (/(?:Chrome|CriOS)\//.test(ua)) browser = `Chrome ${major(/(?:Chrome|CriOS)\/(\d+)/)}`;
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = `Safari ${major(/Version\/(\d+)/)}`;
  else if (/jsdom|HeadlessChrome|Playwright/i.test(ua)) browser = "Test";
  let os = "";
  if (/iPad/.test(ua)) os = "iPadOS";
  else if (/iPhone|iPod/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Linux/.test(ua)) os = "Linux";
  return { browser: browser.trim() || "unknown", os: os || "unknown" };
}

// ---------------------------------------------------------------------------------------------------------------
// Requests from the web app to the own NyxOS server

const email = z
  .union([z.literal(""), z.email().max(SUPPORT_LIMITS.emailChars)])
  .nullish()
  .transform((v) => (v ? v : null));
const longText = (min: number) => z.string().trim().min(min).max(SUPPORT_LIMITS.textChars);
const optionalText = z.string().trim().max(SUPPORT_LIMITS.textChars).default("");

/** base64 length for the file limit (4 characters per 3 bytes). */
const SCREENSHOT_BASE64_CHARS = Math.ceil(SUPPORT_LIMITS.screenshotBytes / 3) * 4;

export const SupportScreenshotSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(SUPPORT_SCREENSHOT_TYPES),
  /** File content, base64 without the `data:` prefix. */
  dataBase64: z
    .string()
    .min(4)
    .max(SCREENSHOT_BASE64_CHARS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type SupportScreenshot = z.infer<typeof SupportScreenshotSchema>;

export const SupportBugInputSchema = z.object({
  what: longText(3),
  before: optionalText,
  expected: optionalText,
  email,
  diagnostics: SupportDiagnosticsSchema.nullish().transform((v) => v ?? null),
  screenshot: SupportScreenshotSchema.nullish().transform((v) => v ?? null),
  /** A draft (prepared by Nyx) that this report replaces. */
  draftId: z.number().int().positive().optional(),
});
export type SupportBugInput = z.input<typeof SupportBugInputSchema>;
export type SupportBug = z.output<typeof SupportBugInputSchema>;

export const SUPPORT_IMPORTANCE = ["nice", "important", "essential"] as const;
export const SupportImportanceSchema = z.enum(SUPPORT_IMPORTANCE);
export type SupportImportance = z.infer<typeof SupportImportanceSchema>;

export const SupportIdeaInputSchema = z.object({
  title: z.string().trim().min(3).max(SUPPORT_LIMITS.titleChars),
  description: longText(3),
  importance: SupportImportanceSchema,
  email,
  draftId: z.number().int().positive().optional(),
});
export type SupportIdeaInput = z.input<typeof SupportIdeaInputSchema>;
export type SupportIdea = z.output<typeof SupportIdeaInputSchema>;

export const SupportDonateInputSchema = z.object({
  amountCents: z.number().int().min(SUPPORT_LIMITS.amountMinCents).max(SUPPORT_LIMITS.amountMaxCents),
  currency: z.literal("EUR").default("EUR"),
  interval: z.enum(["once", "monthly"]),
  name: z.string().trim().max(SUPPORT_LIMITS.nameChars).default(""),
  message: z.string().trim().max(SUPPORT_LIMITS.messageChars).default(""),
  publicThanks: z.boolean().default(false),
});
export type SupportDonateInput = z.input<typeof SupportDonateInputSchema>;
export type SupportDonate = z.output<typeof SupportDonateInputSchema>;

/** Draft of a report — Nyx may prepare it (`PUT /api/support/draft`), only the user sends it. */
export const SupportDraftInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bug"),
    what: z.string().trim().max(SUPPORT_LIMITS.textChars).default(""),
    before: z.string().trim().max(SUPPORT_LIMITS.textChars).default(""),
    expected: z.string().trim().max(SUPPORT_LIMITS.textChars).default(""),
  }),
  z.object({
    kind: z.literal("idea"),
    title: z.string().trim().max(SUPPORT_LIMITS.titleChars).default(""),
    description: z.string().trim().max(SUPPORT_LIMITS.textChars).default(""),
    importance: SupportImportanceSchema.default("important"),
  }),
]);
export type SupportDraftInput = z.input<typeof SupportDraftInputSchema>;
export type SupportDraft = z.output<typeof SupportDraftInputSchema>;

export const SupportSettingsInputSchema = z.object({
  /** Empty = back to the default. */
  url: z.string().trim().max(300),
});

// ---------------------------------------------------------------------------------------------------------------
// Answers of the own NyxOS server

export const SUPPORT_OUTBOX_STATUS = ["waiting", "sending", "sent", "rejected"] as const;
export type SupportOutboxStatus = (typeof SUPPORT_OUTBOX_STATUS)[number];

export interface SupportOutboxItem {
  id: number;
  kind: "bug" | "idea";
  title: string;
  status: SupportOutboxStatus;
  createdAt: string;
  sentAt: string | null;
  attempts: number;
  /** Why the last attempt did not go out (plain sentence) — or why the service rejected it. */
  lastError: string | null;
  /** Reference the support service gave back (e.g. `BUG-123`). */
  reference: string | null;
}

export interface SupportDraftRow {
  id: number;
  draft: SupportDraft;
  updatedAt: string;
}

export interface SupportState {
  /** Is a support address set? Without one, reports wait and donations are not possible yet. */
  configured: boolean;
  /** Origin of the support service (`https://…`) — the only origin the payment frame may come from. */
  origin: string | null;
  /** Where the address comes from. */
  source: "env" | "setting" | "default" | "none";
  /** The address stored in the setting (editable unless `envLocked`). */
  settingUrl: string;
  /** `NYXOS_SUPPORT_URL` is set: the setting is ignored. */
  envLocked: boolean;
  /** Plain sentence when the configured address cannot be used (e.g. `http://` for a public host). */
  problem: string | null;
  outbox: { waiting: number; items: SupportOutboxItem[] };
  drafts: { bug: SupportDraftRow | null; idea: SupportDraftRow | null };
  /** The server's part of the diagnostics (already cleaned). */
  diagnostics: { version: string; mode: "local" | "server" | "unknown"; errors: SupportErrorEntry[] };
}

export interface SupportSendResult {
  /** `sent` = the support service has it; `queued` = waits in the outbox and goes out by itself later. */
  status: "sent" | "queued";
  item: SupportOutboxItem;
  /** Short sentence from the support service (sent) or why it waits (queued). */
  message: string | null;
}

export interface SupportDonateResult {
  embedUrl: string;
  origin: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Messages of the embedded payment page (window.postMessage)

export const SUPPORT_MESSAGE_PREFIX = "nyxos-support:";

export const SupportEmbedMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("nyxos-support:ready") }),
  z.object({ type: z.literal("nyxos-support:resize"), height: z.number().int().min(120).max(4000) }),
  z.object({ type: z.literal("nyxos-support:paid"), reference: z.string().max(100).optional() }),
  z.object({ type: z.literal("nyxos-support:cancelled") }),
  z.object({ type: z.literal("nyxos-support:error"), message: z.string().max(300).optional() }),
]);
export type SupportEmbedMessage = z.infer<typeof SupportEmbedMessageSchema>;

/**
 * Reads one `message` event of the payment frame. `null` unless it comes from exactly the support origin (and, if
 * given, from exactly that frame window) and has a known shape. Everything else is ignored silently.
 */
export function readSupportEmbedMessage(event: { origin: string; data: unknown; source?: unknown }, expected: { origin: string | null; source?: unknown }): SupportEmbedMessage | null {
  if (!expected.origin || event.origin !== expected.origin) return null;
  if (expected.source !== undefined && event.source !== expected.source) return null;
  const parsed = SupportEmbedMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}

/** Origin of an address, or `null` when it is not a valid http(s) address. */
export function supportOriginOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Title of a report in lists: the idea title, or the first line of "what happened". */
export function supportTitle(kind: "bug" | "idea", payload: { what?: string; title?: string }): string {
  const raw = kind === "idea" ? (payload.title ?? "") : (payload.what ?? "");
  const first = raw.split("\n")[0]?.trim() ?? "";
  return clip(first, 80);
}
