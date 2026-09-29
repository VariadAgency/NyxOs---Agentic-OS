// Telegram-Bot für Nyx (grammY, MIT). Läuft im API-Prozess per Long-Polling — kein offener Port.
//
// Zugang: genau EIN Chat (der Nutzer). NyxOS erzeugt einen Kopplungs-Code (Einstellungen → Telegram), der Nutzer
// schickt `/start <code>`. Alles andere — fremde Chats, Gruppen, Knopf-Klicks von Fremden — wird still
// verworfen (OpenClaw `dm-access.ts`/`authorizeCallback`, MIT; Hermes `pairing.py`, MIT).
//
// Übernommene Muster (angepasst, s. NOTICE):
// - Anthropic Telegram-Plugin (claude-plugins-official, Apache-2.0): `bot.catch` hält das Polling am Leben,
//   Neustart-Schleife mit Backoff und 409-Erkennung, Foto-Download über `getFile`, Knopf-Handler mit Rechte-Prüfung.
// - OpenClaw (MIT): `/stop` in eigener Spur, Eingang 300 ms bündeln (Befehle nie), Knopf sofort bestätigen,
//   Auswahl-Menüs bearbeiten dieselbe Nachricht, Status-Reaktionen 👀 🤔 👨‍💻 👍 💔, eine Fortschritts-Nachricht
//   (höchstens 1 Bearbeitung/s, nach 3 Fehlern Schluss, am Ende gelöscht), Befehlsmenü nur bei Änderung.
// - Hermes (MIT): Sprachblase OGG/Opus per `sendVoice`, Sprachmodus je Chat, Freigabe-Knöpfe `fg:<wahl>:<id>`.
import { createHash } from "node:crypto";
import { TELEGRAM_PAIRING_ALPHABET, TELEGRAM_PAIRING_LENGTH, composeChatInput, chatFileAllowed, chatFileIsImage, fixTranscriptFor, GUARD_RULE_LABELS, nyxToolDoing, type Approval, type SaveUploadResult, type TelegramPairingResult, type TelegramSettingsPatch, type TelegramStatus, type Tool, getLang, quote, t } from "@nyxos/shared";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Bot, GrammyError, InputFile, type Context, type Transformer } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup, MessageOrigin, ReactionTypeEmoji, UserFromGetMe } from "grammy/types";
import type { AwayQuestion } from "../away/notifier.js";
import type { Db } from "../db/client.js";
import { haikuThreads, sessionEvents, sessions } from "../db/schema.js";
import { visibleSession } from "../db/visible.js";
import { COMPACT_TTL_HOURS, deliverOrQueue, type DeliveryDeps } from "../delivery/queue.js";
import { latestReport } from "../haiku/report.js";
import { countOpenApprovalCards } from "../haiku/tools.js";
import { sessionTitle, takeSnapshot } from "../overview/snapshot.js";
import { isQuietNow } from "../push/dispatcher.js";
import { logDelivery } from "../push/log.js";
import { loadOrInitSettings } from "../push/settings.js";
import { loadTemporaryHours, setSessionTemporary } from "../temporary.js";
import { CallbackRegistry, cb, parseCb } from "./callbacks.js";
import { chunkText, clip, escapeTelegramHtml, markdownToTelegramHtml, PARSE_ERR_RE, safeName, stripRefs, TELEGRAM_CAPTION_LIMIT, wrapUntrusted } from "./format.js";
import { speakableOf, type NyxAttachment, type NyxChannel } from "./nyx.js";
import { checkPairingCode, isActive, isLocked, newPairing } from "./pairing.js";
import { loadTelegramState, patchTelegramState, settingsOf, type TelegramRow } from "./store.js";
import type { TelegramTokenSource } from "./tokens.js";
import type { TelegramVoice } from "./voice.js";

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface TelegramBridge {
  readonly online: boolean;
  rpc(method: string, params: unknown, timeoutMs?: number): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }>;
}

export type StartSessionOutcome = { ok: true; sessionKey: string | null; tmuxName: string } | { ok: false; error: string };

export interface TelegramServiceDeps {
  db: Db;
  tokens: TelegramTokenSource;
  log?: Log;
  nyx?: NyxChannel | null;
  voice?: TelegramVoice | null;
  bridge?: TelegramBridge | null;
  hub?: { broadcast(message: unknown): void };
  /** Bestehender Start-Weg (`POST /api/terminal/start`, routes/terminal.ts). */
  startSession?: (req: { tool: Tool; cwd: string; temporary: boolean }) => Promise<StartSessionOutcome>;
  /** Bestehender Freigabe-Weg (routes/approvals.ts): entscheidet und sagt der wartenden Session Bescheid. */
  approvals?: { decide(id: number, decision: "approve" | "deny"): Promise<{ ok: boolean; message: string }> } | null;
  /** Abwesenheit: bestehender Inbox-Antwort-Weg (wie `POST /api/inbox/:id/answer`), Option nach Position. */
  inbox?: { answer(id: number, optionIndex: number): Promise<{ ok: boolean; message: string }> } | null;
  /** Sessions-Liste im Web neu laden (nach „temporär“). */
  publish?: (keys: Set<string>) => Promise<void>;
  /** Tests: eigener Bot (Fake-Bot-API). Standard: `new Bot(token)`. */
  botFactory?: (token: string) => Bot;
  /** false = kein Long-Polling (Tests füttern Updates über {@link TelegramService.handleUpdate}). */
  polling?: boolean;
  /** Datei von Telegram laden (Tests: Fake). Die URL enthält das Token — nie loggen. */
  fetchFile?: (token: string, filePath: string) => Promise<Uint8Array>;
  now?: () => number;
  /** Eingang bündeln (OpenClaw: 300 ms). */
  bufferMs?: number;
  /** HTTPS-Adresse des Nyx-Tabs für den Mini-App-Knopf (Tailscale). Ohne: aus. */
  miniAppUrl?: string | null;
}

export interface TelegramNotice {
  text: string;
  image?: { data: Uint8Array; name?: string };
  /** true = `text` vorlesen; Bytes = fertige OGG/Opus-Datei. */
  voice?: boolean | Uint8Array;
  buttons?: { text: string; url?: string; command?: "status" | "sessions" | "briefing" | "nyx" | "neu" }[];
  /** Dringend = auch in der Ruhezeit. */
  urgent?: boolean;
}

export type NotifyOutcome = { sent: true } | { sent: false; reason: "no_bot" | "not_paired" | "quiet_hours" | "send_failed" };

export const TELEGRAM_COMMANDS = [
  { command: "nyx", description: "Mit Nyx sprechen (Standard)" },
  { command: "sessions", description: "Lebende Sessions – auswählen und schreiben" },
  { command: "neu", en: "new", description: "Neue Session starten" },
  { command: "compact", description: "Verlauf verdichten" },
  { command: "status", description: "Kurzer Überblick" },
  { command: "briefing", description: "Briefing von heute" },
  { command: "stop", description: "Laufende Arbeit abbrechen (Esc)" },
  { command: "temporaer", en: "temporary", description: "Als Wegwerf-Chat markieren" },
  { command: "hilfe", en: "help", description: "Was ich kann" },
] as const;

/** Bot menu in the current app language (the German list above is the source; German names stay registered as aliases). */
export function telegramCommands(): { command: string; description: string }[] {
  const en = getLang() === "en";
  return TELEGRAM_COMMANDS.map((c) => ({ command: en && "en" in c ? c.en : c.command, description: t(c.description) }));
}

function helpText(): string {
  return [
    t("🌙 <b>Nyx über Telegram</b>"),
    "",
    t("Schreib einfach los oder schick eine Sprachnachricht – ich antworte als Text und Sprache."),
    "",
    t("/nyx – mit Nyx sprechen (Standard)"),
    t("/sessions – lebende Sessions wählen, dann gehen deine Nachrichten dorthin"),
    t("/neu – neue Session starten (Ordner, Claude/Codex, temporär)"),
    t("/compact – Verlauf verdichten (Session oder Nyx)"),
    t("/status – kurzer Überblick"),
    t("/briefing – Briefing von heute"),
    t("/stop – laufende Arbeit abbrechen"),
    t("/temporaer – als Wegwerf-Chat markieren"),
    t("/hilfe – diese Liste"),
    "",
    t("Fotos und Dateien kannst du mitschicken. Freigaben kommen hier als Knöpfe."),
  ].join("\n");
}

const NO_TOKEN_SENTENCE = "Wartet auf Bot-Token.";
const NO_TOKEN_FIX = "So geht's: In Telegram @BotFather öffnen → /newbot → Namen wählen → das Token kopieren und hier eintragen.";
/** Telegram-Dateien für Bots: höchstens 20 MB (Cloud-Bot-API). */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Kürzere Sprachnachrichten sind fast immer versehentlich (OpenClaw: unter 1 KB verwerfen). */
const MIN_VOICE_BYTES = 1024;
const PROGRESS_EDIT_MS = 1000;
const SESSION_REPLY_CLIP = 1200;
const STATE_ICON: Record<string, string> = { waiting: "🟡", running: "🟢", idle: "⚪" };

type Reg = { kind: "cwd"; cwd: string; label: string } | { kind: "session"; key: string } | { kind: "text"; text: string };

/** Kopplungs-Code als normale Nachricht (8 Zeichen aus dem Kopplungs-Alphabet, Groß/klein egal). */
const PLAIN_PAIRING_CODE = new RegExp(`^[${TELEGRAM_PAIRING_ALPHABET}]{${TELEGRAM_PAIRING_LENGTH}}$`, "i");
const UNPAIRED_HINT_EVERY_MS = 10 * 60_000;
export const UNPAIRED_HINT =
  "Hallo! Ich bin noch mit niemandem gekoppelt und darf deshalb noch nicht antworten.\n\nSo geht's: NyxOS öffnen → Einstellungen → Telegram → „Kopplungs-Code erzeugen“ – dann den Link antippen oder mir den Code hier schicken.";

/** Zeitlimit für den ersten direkten getMe-Aufruf (danach übernimmt grammYs Polling). */
export const PREFLIGHT_TIMEOUT_MS = 15_000;

/** Fehler fürs Log: Art, Text und Netz-Ursache (z. B. ECONNRESET) – nie das Token (steht nur in der URL). */
export function errorDetail(e: unknown): { kind: string; detail: string; cause: string | null } {
  const err = e as { name?: string; message?: string; error?: { message?: string; code?: string; cause?: { code?: string } }; cause?: { code?: string; message?: string } };
  const strip = (s: string | undefined) => (s ?? "").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<token>").slice(0, 300);
  return {
    kind: err?.name ?? typeof e,
    detail: strip(err?.error?.message ?? err?.message),
    cause: err?.error?.code ?? err?.error?.cause?.code ?? err?.cause?.code ?? null,
  };
}

function botError(e: unknown): { sentence: string; fix: string | null; fatal: boolean } {
  if (e instanceof GrammyError && (e.error_code === 401 || e.error_code === 404)) {
    return { sentence: t("Das Bot-Token passt nicht."), fix: t("Bei @BotFather mit /token das Token neu kopieren und hier eintragen."), fatal: true };
  }
  if (e instanceof GrammyError && e.error_code === 409) {
    return { sentence: t("Ein anderes Programm nutzt gerade denselben Bot."), fix: t("Den anderen Dienst mit diesem Bot beenden – NyxOS versucht es weiter."), fatal: false };
  }
  return { sentence: t("Telegram ist gerade nicht erreichbar – NyxOS versucht es weiter."), fix: null, fatal: false };
}

export class TelegramService {
  private readonly db: Db;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly reg = new CallbackRegistry<Reg>();
  private bot: Bot | null = null;
  private token: string | null = null;
  private info: UserFromGetMe | null = null;
  private state: TelegramStatus["state"] = "no_token";
  private error: { sentence: string; fix: string | null } | null = null;
  private generation = 0;
  /** Arbeits-Spur: Nyx-Züge und Session-Nachrichten nacheinander. Steuerung (/stop, Knöpfe) läuft daneben. */
  private work: Promise<void> = Promise.resolve();
  private turn: AbortController | null = null;
  private buffer: { chatId: string; parts: string[]; messageIds: number[]; timer: NodeJS.Timeout; done: Promise<void>; resolve: () => void } | null = null;

  constructor(private readonly deps: TelegramServiceDeps) {
    this.db = deps.db;
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
  }

  // ───────────────────────────── Lebenszyklus ─────────────────────────────

  async start(): Promise<void> {
    if (this.bot) return;
    let token: string | null;
    try {
      token = await this.deps.tokens.get();
    } catch {
      this.setState("error", { sentence: t("Der Schlüssel-Speicher lässt sich gerade nicht öffnen."), fix: t("Beim nächsten Deploy prüft Claude den Speicher-Schlüssel.") });
      return;
    }
    if (!token) {
      this.setState("no_token", null);
      return;
    }
    const gen = ++this.generation;
    const bot = (this.deps.botFactory ?? ((tok: string) => new Bot(tok)))(token);
    bot.api.config.use(retryTransformer(this.log));
    this.bot = bot;
    this.token = token;
    this.install(bot);
    // Anthropic-Plugin: ohne eigenen Fehler-Fänger beendet grammY bei einem Handler-Fehler das Polling.
    bot.catch((err) => this.log("telegram-handler-fehler", { error: err.error instanceof Error ? err.error.message : String(err.error) }));
    this.setState("starting", null);
    if (this.deps.polling === false) {
      try {
        await bot.init();
        await this.connected(bot);
      } catch (e) {
        const be = botError(e);
        this.setState("error", be);
      }
      return;
    }
    void this.pollLoop(bot, gen);
  }

  /**
   * `bot.start()` wiederholt Netzfehler von getMe/deleteWebhook still und endlos (grammY
   * `withRetries`) – NyxOS stand dann ewig auf „Verbindet mit Telegram …“ ohne Log. Darum vorher EIN direkter
   * getMe-Aufruf mit Zeitlimit: der echte Fehler landet im Log und als Satz in der Oberfläche.
   */
  private async preflight(bot: Bot): Promise<void> {
    if (bot.isInited()) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PREFLIGHT_TIMEOUT_MS);
    timer.unref?.();
    try {
      bot.botInfo = await bot.api.getMe(ctl.signal as Parameters<Bot["api"]["getMe"]>[0]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async pollLoop(bot: Bot, gen: number): Promise<void> {
    for (let attempt = 1; gen === this.generation; attempt++) {
      try {
        await this.preflight(bot);
        if (gen !== this.generation) return;
        await bot.start({
          drop_pending_updates: true,
          allowed_updates: ["message", "callback_query"],
          onStart: () => {
            attempt = 0;
            void this.connected(bot).catch((e: unknown) => this.log("telegram-start-fehler", { error: String(e) }));
          },
        });
        return; // bot.stop() — sauberes Ende
      } catch (e) {
        if (gen !== this.generation) return;
        if (e instanceof Error && e.message === "Aborted delay") return;
        const be = botError(e);
        this.setState("error", be);
        this.log("telegram-polling-fehler", { attempt, code: e instanceof GrammyError ? e.error_code : null, ...errorDetail(e) });
        if (be.fatal) return;
        await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 15_000)).unref());
      }
    }
  }

  private async connected(bot: Bot): Promise<void> {
    this.info = bot.botInfo;
    this.setState("connected", null);
    this.log("telegram-verbunden", { bot: this.info.username });
    // OpenClaw T-4: Befehlsmenü nur setzen, wenn es sich geändert hat (sonst 429 bei vielen Neustarts).
    const commands = telegramCommands();
    const hash = createHash("sha256").update(`${this.info.id}:${JSON.stringify(commands)}`).digest("hex").slice(0, 16);
    const st = await loadTelegramState(this.db);
    if (st.commandsHash === hash) return;
    await bot.api.setMyCommands(commands, { scope: { type: "all_private_chats" } });
    await patchTelegramState(this.db, { commandsHash: hash });
  }

  async stop(): Promise<void> {
    this.generation++;
    const bot = this.bot;
    this.bot = null;
    this.token = null;
    this.info = null;
    this.turn?.abort();
    if (this.buffer) {
      clearTimeout(this.buffer.timer);
      this.buffer.resolve();
      this.buffer = null;
    }
    if (bot?.isRunning()) await bot.stop().catch(() => {});
    this.setState("no_token", null);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private setState(state: TelegramStatus["state"], error: { sentence: string; fix: string | null } | null): void {
    this.state = state;
    this.error = error ? { sentence: error.sentence, fix: error.fix } : null;
    this.deps.hub?.broadcast({ type: "telegram" });
  }

  /** Tests: ein Update direkt einspeisen (statt Long-Polling). */
  async handleUpdate(update: unknown): Promise<void> {
    if (!this.bot) throw new Error("Bot läuft nicht");
    await this.bot.handleUpdate(update as never);
  }

  /** Tests: warten, bis Puffer und Arbeits-Spur leer sind. */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (this.buffer) {
        await this.buffer.done;
        continue;
      }
      const w = this.work;
      await w;
      if (w === this.work && !this.buffer) return;
    }
  }

  // ───────────────────────────── Zustand für die Oberfläche ─────────────────────────────

  async status(): Promise<TelegramStatus> {
    const [st, token, voice] = await Promise.all([
      loadTelegramState(this.db),
      this.deps.tokens.info().catch(() => ({ set: false, last4: null, source: null }) as const),
      this.deps.voice ? this.deps.voice.status().catch(() => ({ ready: false, sentence: t("Die Stimme auf dem Server antwortet gerade nicht.") })) : Promise.resolve({ ready: false, sentence: t("Die Stimme auf dem Server ist noch nicht eingerichtet – Nyx antwortet dann nur als Text.") }),
    ]);
    const now = this.now();
    const sentence =
      this.state === "no_token" ? t(NO_TOKEN_SENTENCE) : this.state === "starting" ? t("Verbindet mit Telegram …") : this.state === "connected" ? t("Verbunden als @{name}.", { name: this.info?.username ?? "?" }) : (this.error?.sentence ?? t("Telegram ist gerade nicht erreichbar."));
    const fix = this.state === "no_token" ? t(NO_TOKEN_FIX) : this.state === "error" ? (this.error?.fix ?? null) : null;
    return {
      state: this.state,
      sentence,
      fix,
      bot: this.info ? { username: this.info.username, name: this.info.first_name } : null,
      token: { ...token, canEdit: this.deps.tokens.canEdit, editHint: this.deps.tokens.editHint ? t(this.deps.tokens.editHint) : null },
      paired: st.chatId ? { name: st.chatName ?? "Telegram", since: st.pairedAt ?? st.updatedAt } : null,
      pairing: { active: isActive(st, now), expiresAt: isActive(st, now) ? st.pairExpiresAt : null, lockedUntil: isLocked(st, now) ? st.pairLockedUntil : null, failures: st.pairFailures },
      target: await this.targetView(st),
      talkMode: st.talkMode,
      settings: settingsOf(st),
      voice,
      miniApp: this.miniApp(),
    };
  }

  private miniApp(): { enabled: boolean; sentence: string } {
    const url = this.deps.miniAppUrl ?? null;
    if (url && /^https:\/\//.test(url)) return { enabled: true, sentence: t("„Live mit Nyx sprechen“ öffnet den Nyx-Tab direkt in Telegram.") };
    return { enabled: false, sentence: t("Live-Gespräch als Telegram-Mini-App ist noch aus: dafür braucht NyxOS eine HTTPS-Adresse (Tailscale). Bis dahin: 📞 Sprechen per Sprachnachrichten.") };
  }

  private async targetView(st: TelegramRow): Promise<TelegramStatus["target"]> {
    if (st.target !== "session" || !st.sessionKey) return { kind: "nyx" };
    const [row] = await this.db.select({ title: sessions.title, sessionId: sessions.sessionId }).from(sessions).where(eq(sessions.id, st.sessionKey)).limit(1);
    return { kind: "session", sessionKey: st.sessionKey, title: row?.title ?? row?.sessionId ?? st.sessionKey };
  }

  // ───────────────────────────── Kopplung, Token, Einstellungen ─────────────────────────────

  get isConnected(): boolean {
    return this.state === "connected" && !!this.bot;
  }

  /** Kann Nyx der Nutzer jetzt über Telegram erreichen (Bot verbunden und Chat gekoppelt)? */
  async canNotify(): Promise<boolean> {
    if (!this.isConnected) return false;
    return Boolean((await loadTelegramState(this.db)).chatId);
  }

  async createPairing(): Promise<TelegramPairingResult> {
    const now = this.now();
    const st = await loadTelegramState(this.db);
    if (isLocked(st, now)) throw new PairingLockedError(st.pairLockedUntil);
    const { code, record } = newPairing(now);
    await patchTelegramState(this.db, record);
    this.log("telegram-kopplung-code-erzeugt"); // der Code selbst nie ins Protokoll
    this.deps.hub?.broadcast({ type: "telegram" });
    return { code, expiresAt: record.pairExpiresAt ?? "", link: this.info ? `https://t.me/${this.info.username}?start=${code}` : null };
  }

  async unpair(): Promise<void> {
    await patchTelegramState(this.db, { chatId: null, chatName: null, pairedAt: null, target: "nyx", sessionKey: null, talkMode: false, pairHash: null, pairSalt: null, pairExpiresAt: null });
    this.log("telegram-entkoppelt");
    this.deps.hub?.broadcast({ type: "telegram" });
  }

  async setToken(token: string): Promise<void> {
    if (!this.deps.tokens.set) throw new Error(this.deps.tokens.editHint ? t(this.deps.tokens.editHint) : t("Token kann hier nicht gespeichert werden"));
    await this.deps.tokens.set(token);
    this.log("telegram-token-gesetzt");
    await this.restart();
  }

  async clearToken(): Promise<void> {
    await this.deps.tokens.clear?.();
    this.log("telegram-token-entfernt");
    await this.stop();
  }

  async patchSettings(patch: TelegramSettingsPatch): Promise<void> {
    const st = await loadTelegramState(this.db);
    await patchTelegramState(this.db, { settings: { ...settingsOf(st), ...patch } });
    this.deps.hub?.broadcast({ type: "telegram" });
  }

  // ───────────────────────────── Nach außen: Nyx meldet sich von selbst ─────────────────────────────

  /** Proaktive Nachricht an den Nutzer (geplante Aufgaben, `show_image`; Ereignisse). Ruhezeiten wie Push. */
  async notifyUser(n: TelegramNotice): Promise<NotifyOutcome> {
    const st = await loadTelegramState(this.db);
    if (!st.chatId) return { sent: false, reason: "not_paired" };
    const bot = this.bot;
    if (!bot || this.state !== "connected") return { sent: false, reason: "no_bot" };
    if (!n.urgent && settingsOf(st).respectQuietHours) {
      const push = await loadOrInitSettings(this.db);
      if (isQuietNow(push, new Date(this.now()))) return { sent: false, reason: "quiet_hours" };
    }
    const markup = n.buttons?.length
      ? {
          inline_keyboard: [
            n.buttons.map((b): InlineKeyboardButton => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: cb("cmd", b.command ?? "status") })),
          ],
        }
      : undefined;
    try {
      if (n.image) {
        const fits = n.text.length <= TELEGRAM_CAPTION_LIMIT;
        await bot.api.sendPhoto(st.chatId, new InputFile(n.image.data, n.image.name ?? "bild.png"), { ...(fits ? { caption: n.text } : {}), ...(markup && fits ? { reply_markup: markup } : {}) });
        if (!fits) await this.sendLong(st.chatId, n.text, markup);
      } else {
        await this.sendLong(st.chatId, n.text, markup);
      }
      if (n.voice) {
        const audio = n.voice instanceof Uint8Array ? { audio: n.voice, seconds: 0 } : this.deps.voice ? await this.deps.voice.speak(speakableOf(n.text)) : null;
        if (audio) await bot.api.sendVoice(st.chatId, new InputFile(audio.audio, "nyx.ogg"), audio.seconds ? { duration: Math.round(audio.seconds) } : {});
      }
      return { sent: true };
    } catch (e) {
      this.log("telegram-senden-fehler", { error: e instanceof Error ? e.message : String(e) });
      return { sent: false, reason: "send_failed" };
    }
  }

  /** Neue Freigabe-Anfrage → Karte mit Knöpfen (riskante Aktionen weiterhin nur nach des Nutzers Klick). */
  async onApprovalCreated(a: Approval): Promise<void> {
    const st = await loadTelegramState(this.db);
    if (!st.chatId || !this.bot || !settingsOf(st).notifyApprovals) return;
    const rule = (GUARD_RULE_LABELS as Record<string, string>)[a.rule] ?? a.rule;
    const text = [`🔐 <b>${t("Freigabe nötig: {rule}", { rule: escapeTelegramHtml(rule) })}</b>`, a.auftrag ? t("Auftrag: {name}", { name: escapeTelegramHtml(a.auftrag) }) : null, `<code>${escapeTelegramHtml(clip(a.command, 600))}</code>`].filter(Boolean).join("\n");
    const markup: InlineKeyboardMarkup = { inline_keyboard: [[{ text: t("✅ Freigeben"), callback_data: cb("fg", "a", a.id) }, { text: t("❌ Ablehnen"), callback_data: cb("fg", "d", a.id) }]] };
    const ok = await this.bot.api.sendMessage(st.chatId, text, { parse_mode: "HTML", reply_markup: markup }).then(
      () => true,
      (e: unknown) => {
        this.log("telegram-freigabe-fehler", { id: a.id, error: String(e) });
        return false;
      },
    );
    // Protokoll für Nyx' `mitteilungen_liste` (Nyx soll wissen, was es dem Nutzer geschickt hat).
    await logDelivery(this.db, { kind: "approval_telegram", title: t("Freigabe nötig: {rule}", { rule }), message: clip(a.command, 280), priority: "high", channels: [{ channel: "telegram", ok }] });
  }

  /**
   * Abwesenheit: offene Fragen an den Nutzer – eine Nachricht, je Frage eigene Knöpfe. Inbox-Optionen antworten
   * über den bestehenden Inbox-Weg (Knopf `ib:<id>:<position>`); eine wartende Session bekommt „Hierhin schreiben“
   * (danach gehen des Nutzers Nachrichten in diese Session, wie bei /sessions). Die Ruhezeit prüft der Aufrufer.
   */
  async sendQuestions(questions: AwayQuestion[]): Promise<boolean> {
    const st = await loadTelegramState(this.db);
    const bot = this.bot;
    if (!st.chatId || !bot || this.state !== "connected" || questions.length === 0) return false;
    const many = questions.length > 1;
    const lines = [`❓ <b>${many ? t("Nyx braucht dich – {n} Fragen", { n: questions.length }) : t("Nyx braucht dich")}</b>`, ""];
    const rows: InlineKeyboardButton[][] = [];
    questions.forEach((q, i) => {
      const n = many ? `${i + 1}. ` : "";
      const tag = many ? `${i + 1}: ` : "";
      lines.push(`${n}${escapeTelegramHtml(clip(q.title, 300))}`);
      if (q.body) lines.push(`<i>${escapeTelegramHtml(clip(q.body, 300))}</i>`);
      if (q.kind === "inbox" && q.options.length > 0) {
        const buttons = q.options.slice(0, 6).map((o, idx): InlineKeyboardButton => ({ text: `${tag}${clip(o.label, 30)}`, callback_data: cb("ib", q.ref, idx) }));
        for (let k = 0; k < buttons.length; k += 3) rows.push(buttons.slice(k, k + 3));
      } else if (q.kind === "inbox") {
        lines.push(t("→ Antwort bitte in NyxOS (Entscheidungen)."));
      } else if (q.kind === "session") {
        rows.push([{ text: `${tag}${t("💬 Hierhin schreiben")}`, callback_data: cb("ss", this.reg.put({ kind: "session", key: String(q.ref) })) }]);
      }
      lines.push("");
    });
    const title = many ? t("Nyx braucht dich – {n} Fragen", { n: questions.length }) : t("Nyx braucht dich");
    const logIt = (ok: boolean) => logDelivery(this.db, { kind: "away_questions", title, message: questions.map((q) => q.title).join(" · "), channels: [{ channel: "telegram", ok }], bundle: many });
    try {
      await bot.api.sendMessage(st.chatId, lines.join("\n").trim(), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
      await logIt(true);
      return true;
    } catch (e) {
      this.log("telegram-fragen-fehler", { error: errorDetail(e).detail });
      await logIt(false);
      return false;
    }
  }

  /**
   * Nach jedem Ingest: Ist die in Telegram gewählte Session gerade fertig geworden (wartet), kommt ihre letzte
   * Antwort gekürzt zurück — mit „mehr“-Knopf. Jede Antwort höchstens einmal (Ereignis-ID in `forwarded`).
   */
  async onSessionsTouched(keys: string[]): Promise<void> {
    if (!this.bot || keys.length === 0) return;
    const st = await loadTelegramState(this.db);
    if (!st.chatId || st.target !== "session" || !st.sessionKey || !keys.includes(st.sessionKey) || !settingsOf(st).notifySessions) return;
    const key = st.sessionKey;
    const [row] = await this.db.select({ state: sessions.state, title: sessions.title, sessionId: sessions.sessionId }).from(sessions).where(eq(sessions.id, key)).limit(1);
    if (row?.state !== "waiting") return;
    const last = await this.lastAnswer(key);
    if (!last || (st.forwarded as Record<string, string>)[key] === last.id) return;
    await patchTelegramState(this.db, { forwarded: { ...(st.forwarded as Record<string, string>), [key]: last.id } });
    const title = row.title ?? row.sessionId;
    const clipped = clip(last.text, SESSION_REPLY_CLIP);
    const buttons: InlineKeyboardButton[] = [];
    if (clipped.length < last.text.trim().length) buttons.push({ text: t("📄 mehr"), callback_data: cb("mo", this.reg.put({ kind: "text", text: last.text })) });
    buttons.push({ text: t("🌙 Zu Nyx"), callback_data: cb("nyx") });
    await this.sendLong(st.chatId, `${t("✅ {title} wartet auf dich:", { title })}\n\n${clipped}`, { inline_keyboard: [buttons] }, false);
  }

  private async lastAnswer(key: string): Promise<{ id: string; text: string } | null> {
    const [ev] = await this.db
      .select({ id: sessionEvents.id, data: sessionEvents.data })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionKey, key), eq(sessionEvents.kind, "assistant")))
      .orderBy(desc(sessionEvents.ts))
      .limit(1);
    const text = (ev?.data as { text?: unknown } | undefined)?.text;
    return ev && typeof text === "string" && text.trim() ? { id: ev.id, text } : null;
  }

  // ───────────────────────────── Bot: Tor und Handler ─────────────────────────────

  private install(bot: Bot): void {
    // Tor: nur der gekoppelte Chat kommt durch — für ALLE Update-Arten, auch Knopf-Klicks (OpenClaw T-2).
    bot.use(async (ctx, next) => {
      if (ctx.chat?.type !== "private" || !ctx.from) return;
      const st = await loadTelegramState(this.db);
      if (st.chatId && String(ctx.chat.id) === st.chatId && String(ctx.from.id) === st.chatId) return next();
      const text = ctx.message?.forward_origin ? "" : (ctx.message?.text ?? "").trim();
      // R3-Live: den Code auch als normale Nachricht annehmen (nicht nur über den /start-Link)
      const code = /^\/start(?:@\w+)?\s+(\S+)/.exec(text)?.[1] ?? (PLAIN_PAIRING_CODE.test(text) ? text.toUpperCase() : undefined);
      if (code) return this.tryPair(ctx, st, code);
      // R3-Live: Der Nutzer schrieb „Hallo“ und bekam nichts zurück. Solange noch NIEMAND gekoppelt ist, sagt der Bot
      // einmal (je Chat höchstens alle 10 Min), wie man koppelt. Ist schon jemand gekoppelt, bleibt er für Fremde stumm.
      if (!st.chatId && ctx.message) await this.hintUnpaired(String(ctx.chat.id));
    });

    // Weitergeleitetes stammt von jemand anderem — nie ein Befehl, für Nyx/Session nur eingerahmter Fremdtext.
    bot.use((ctx, next) => {
      const m = ctx.message;
      if (!m?.forward_origin || m.text === undefined) return next();
      this.bufferText(this.chat(ctx), wrapUntrusted(`Vom Nutzer weitergeleitete Nachricht (${forwardSource(m.forward_origin)})`, m.text), m.message_id);
    });

    bot.command("start", (ctx) => this.say(this.chat(ctx), helpText()));
    bot.command(["hilfe", "help"], (ctx) => this.say(this.chat(ctx), helpText()));
    bot.command("nyx", (ctx) => this.cmdNyx(this.chat(ctx)));
    bot.command("sessions", (ctx) => this.cmdSessions(this.chat(ctx)));
    bot.command(["neu", "new"], (ctx) => this.cmdNew(this.chat(ctx)));
    bot.command("compact", (ctx) => this.cmdCompact(this.chat(ctx)));
    bot.command("status", (ctx) => this.cmdStatus(this.chat(ctx)));
    bot.command("briefing", (ctx) => this.cmdBriefing(this.chat(ctx)));
    bot.command("stop", (ctx) => this.cmdStop(this.chat(ctx)));
    bot.command(["temporaer", "temporär", "temporary"], (ctx) => this.cmdTemporary(this.chat(ctx)));

    bot.on("callback_query:data", async (ctx) => {
      // OpenClaw T-8: sofort bestätigen, damit der Lade-Kreisel am Knopf verschwindet — Arbeit danach.
      await ctx.answerCallbackQuery().catch(() => {});
      await this.onButton(ctx, parseCb(ctx.callbackQuery.data));
    });

    bot.on("message:text", (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return this.say(this.chat(ctx), t("Den Befehl kenne ich nicht. /hilfe zeigt alle."));
      this.bufferText(this.chat(ctx), text, ctx.message.message_id);
    });
    bot.on("message:voice", (ctx) => {
      const v = ctx.message.voice;
      this.enqueue(() => this.voiceTurn(this.chat(ctx), v.file_id, v.mime_type ?? "audio/ogg", ctx.message.message_id));
    });
    bot.on("message:audio", (ctx) => {
      const a = ctx.message.audio;
      this.enqueue(() => this.voiceTurn(this.chat(ctx), a.file_id, a.mime_type ?? "audio/ogg", ctx.message.message_id));
    });
    bot.on("message:photo", (ctx) => {
      const best = ctx.message.photo[ctx.message.photo.length - 1];
      if (!best) return;
      const caption = ctx.message.caption ?? "";
      this.enqueue(() => this.fileTurn(this.chat(ctx), best.file_id, `telegram-${best.file_unique_id}.jpg`, "image/jpeg", caption, ctx.message.message_id));
    });
    bot.on("message:document", (ctx) => {
      const d = ctx.message.document;
      const name = safeName(d.file_name) ?? `telegram-${d.file_unique_id}`;
      this.enqueue(() => this.fileTurn(this.chat(ctx), d.file_id, name, d.mime_type ?? "application/octet-stream", ctx.message.caption ?? "", ctx.message.message_id));
    });
  }

  private chat(ctx: Context): string {
    return String(ctx.chat?.id ?? "");
  }

  private readonly unpairedHints = new Map<string, number>();

  private async hintUnpaired(chatId: string): Promise<void> {
    const now = this.now();
    const last = this.unpairedHints.get(chatId);
    if (last !== undefined && now - last < UNPAIRED_HINT_EVERY_MS) return;
    this.unpairedHints.set(chatId, now);
    this.log("telegram-ungekoppelt-hinweis");
    await this.say(chatId, t(UNPAIRED_HINT));
  }

  private async tryPair(ctx: Context, st: TelegramRow, code: string): Promise<void> {
    const now = this.now();
    const r = checkPairingCode(st, code, now);
    const chatId = String(ctx.chat?.id ?? "");
    if (r.ok) {
      const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || ctx.from?.username || "Telegram";
      await patchTelegramState(this.db, { chatId, chatName: name, pairedAt: new Date(now).toISOString(), pairHash: null, pairSalt: null, pairExpiresAt: null, pairFailures: 0, pairLockedUntil: null, target: "nyx", sessionKey: null });
      this.log("telegram-gekoppelt");
      this.deps.hub?.broadcast({ type: "telegram" });
      await this.say(chatId, `${t("✅ Du bist gekoppelt, {name}. Ab jetzt höre ich nur auf diesen Chat.", { name: escapeTelegramHtml(name) })}\n\n${helpText()}`);
      return;
    }
    if (r.record) await patchTelegramState(this.db, r.record);
    this.log("telegram-kopplung-abgelehnt", { reason: r.reason });
    // Nur antworten, wenn gerade wirklich gekoppelt werden soll (sonst verrät der Bot sich Fremden nicht).
    if (r.reason === "wrong") await this.say(chatId, r.record?.pairLockedUntil ? t("Zu viele falsche Codes. Die Kopplung ist für eine Stunde gesperrt.") : t("Der Code stimmt nicht. Bitte in NyxOS → Einstellungen → Telegram nachsehen."));
    else if (r.reason === "expired") await this.say(chatId, t("Der Code ist abgelaufen. In NyxOS → Einstellungen → Telegram einen neuen erzeugen."));
  }

  // ───────────────────────────── Befehle ─────────────────────────────

  private nyxKeyboard(talkMode: boolean): InlineKeyboardMarkup {
    const rows: InlineKeyboardButton[][] = [
      [talkMode ? { text: t("📴 Sprechen beenden"), callback_data: cb("tk", "off") } : { text: t("📞 Sprechen (Sprachnachrichten)"), callback_data: cb("tk", "on") }],
      [
        { text: t("▣ Sessions"), callback_data: cb("cmd", "sessions") },
        { text: t("➕ Neue Session"), callback_data: cb("cmd", "neu") },
      ],
    ];
    if (this.miniApp().enabled && this.deps.miniAppUrl) rows.push([{ text: t("🎧 Live mit Nyx sprechen"), web_app: { url: this.deps.miniAppUrl } }]);
    return { inline_keyboard: rows };
  }

  private async cmdNyx(chatId: string, edit?: Context): Promise<void> {
    const st = await patchTelegramState(this.db, { target: "nyx", sessionKey: null });
    const text = t("🌙 Du sprichst mit Nyx. Schreib oder schick eine Sprachnachricht.");
    if (edit) await this.edit(edit, text, this.nyxKeyboard(st.talkMode));
    else await this.say(chatId, text, this.nyxKeyboard(st.talkMode));
  }

  private async liveSessions() {
    return this.db
      .select({ id: sessions.id, title: sessions.title, sessionId: sessions.sessionId, tool: sessions.tool, state: sessions.state })
      .from(sessions)
      .where(and(eq(sessions.attachable, true), isNotNull(sessions.tmuxName), isNull(sessions.closedAt), isNull(sessions.parentId), visibleSession, inArray(sessions.state, ["running", "waiting", "idle"])))
      .orderBy(sql`${sessions.lastActivityAt} desc nulls last`)
      .limit(12);
  }

  private async cmdSessions(chatId: string, edit?: Context): Promise<void> {
    const rows = await this.liveSessions();
    const buttons: InlineKeyboardButton[][] = rows.map((r) => [
      { text: `${STATE_ICON[r.state ?? ""] ?? "▫️"} ${clip(r.title ?? r.sessionId, 40)} · ${r.tool === "codex" ? "Codex" : "Claude"}`, callback_data: cb("ss", this.reg.put({ kind: "session", key: r.id })) },
    ]);
    buttons.push([{ text: t("➕ Neue Session"), callback_data: cb("cmd", "neu") }, { text: "🌙 Nyx", callback_data: cb("nyx") }]);
    const text = rows.length ? t("Welche Session? Danach gehen deine Nachrichten dorthin (🟡 wartet · 🟢 arbeitet).") : t("Gerade läuft keine Session in NyxOS. Starte eine mit /neu.");
    if (edit) await this.edit(edit, text, { inline_keyboard: buttons });
    else await this.say(chatId, text, { inline_keyboard: buttons });
  }

  private async selectSession(ctx: Context, key: string): Promise<void> {
    const [row] = await this.db.select({ title: sessions.title, sessionId: sessions.sessionId }).from(sessions).where(eq(sessions.id, key)).limit(1);
    if (!row) return this.edit(ctx, t("Diese Session gibt es nicht mehr. /sessions zeigt die aktuellen."));
    const st = await loadTelegramState(this.db);
    const last = await this.lastAnswer(key);
    // Ab jetzt zählt nur, was NACH der Auswahl fertig wird — alte Antworten nicht noch einmal schicken.
    const forwarded = { ...(st.forwarded as Record<string, string>) };
    if (last) forwarded[key] = last.id;
    await patchTelegramState(this.db, { target: "session", sessionKey: key, forwarded });
    this.deps.hub?.broadcast({ type: "telegram" });
    await this.edit(ctx, t("✅ Deine Nachrichten gehen jetzt an „{title}“. Wenn sie fertig ist, schicke ich dir ihre Antwort.\n/nyx bringt dich zurück zu Nyx.", { title: escapeTelegramHtml(row.title ?? row.sessionId) }));
  }

  private async cmdNew(chatId: string, edit?: Context): Promise<void> {
    const bridge = this.deps.bridge;
    if (!bridge?.online || !this.deps.startSession) return this.say(chatId, t("Dein Mac ist gerade nicht verbunden – neue Sessions starten, sobald er wieder da ist."));
    const r = await bridge.rpc("list_folders", {});
    const folders = r.ok && Array.isArray(r.result) ? (r.result as { label: string; path: string }[]) : [];
    if (folders.length === 0) return this.say(chatId, t("Ich finde gerade keine Projekt-Ordner auf dem Rechner. Bitte gleich noch einmal versuchen."));
    const rows: InlineKeyboardButton[][] = folders.slice(0, 20).map((f) => [{ text: `📁 ${clip(f.label, 50)}`, callback_data: cb("nw", "f", this.reg.put({ kind: "cwd", cwd: f.path, label: f.label })) }]);
    const text = t("➕ Neue Session – in welchem Ordner?");
    if (edit) await this.edit(edit, text, { inline_keyboard: rows });
    else await this.say(chatId, text, { inline_keyboard: rows });
  }

  private async cmdCompact(chatId: string): Promise<void> {
    const st = await loadTelegramState(this.db);
    if (st.target === "session" && st.sessionKey) {
      const r = await deliverOrQueue(this.deliveryDeps(), { sessionKey: st.sessionKey, kind: "compact", text: "/compact", ttlHours: COMPACT_TTL_HOURS, dedupeKey: "compact" });
      return this.say(chatId, r.status === "sent" ? t("🗜 /compact ist in der Session angekommen.") : r.status === "queued" ? t("🗜 /compact wartet: {reason}", { reason: escapeTelegramHtml(r.reason) }) : t("🗜 Geht gerade nicht: {reason}", { reason: escapeTelegramHtml(r.reason) }));
    }
    if (!this.deps.nyx) return this.say(chatId, t("Nyx ist gerade nicht erreichbar."));
    const r = await this.deps.nyx.compact(st.nyxThreadId);
    if (r.threadId !== null && r.threadId !== st.nyxThreadId) await patchTelegramState(this.db, { nyxThreadId: r.threadId });
    // Gab es nichts zu verdichten, sagt Nyx das ehrlich statt „Verdichtet“.
    if (r.compacted === false) return this.say(chatId, `🗜 ${escapeTelegramHtml(r.summary)}`);
    await this.say(chatId, `${t("🗜 Verdichtet. Wir machen mit dieser Zusammenfassung weiter:")}\n\n${escapeTelegramHtml(clip(r.summary, 1500))}`);
  }

  private async cmdStatus(chatId: string): Promise<void> {
    const snap = await takeSnapshot(this.db, new Date(this.now()));
    // Freigabe-Karten zählen wie blockierte Befehle (gleiche Zahl wie Nyx' `lage`).
    const cards = await countOpenApprovalCards(this.db);
    const lines = [`📊 <b>${escapeTelegramHtml(snap.lage)}</b>`, t("🟢 arbeiten: {running} · 🟡 warten auf dich: {waiting} · 🔐 Freigaben offen: {approvals}", { running: snap.running.length, waiting: snap.waiting.length, approvals: snap.pendingApprovals.length + cards })];
    if (snap.crashed.length) lines.push(t("🔴 abgestürzt: {n}", { n: snap.crashed.length }));
    if (snap.waiting.length) lines.push("", `<b>${t("Wartet auf dich:")}</b>`, ...snap.waiting.slice(0, 5).map((s) => `🟡 ${escapeTelegramHtml(clip(sessionTitle(s), 60))}`));
    if (snap.running.length) lines.push("", `<b>${t("Arbeitet:")}</b>`, ...snap.running.slice(0, 5).map((s) => `🟢 ${escapeTelegramHtml(clip(sessionTitle(s), 60))}`));
    await this.say(chatId, lines.join("\n"), { inline_keyboard: [[{ text: t("▣ Sessions"), callback_data: cb("cmd", "sessions") }, { text: t("☀ Briefing"), callback_data: cb("cmd", "briefing") }]] });
  }

  private async cmdBriefing(chatId: string): Promise<void> {
    const report = await latestReport(this.db, "briefing", new Date(this.now()));
    const base = (await loadOrInitSettings(this.db)).publicBaseUrl.replace(/\/$/, "");
    const link = `${base}/briefing`;
    if (!report) return this.say(chatId, t("☀ Heute gibt es noch kein Briefing – es kommt morgens von selbst.\nIm Browser: {link}", { link: escapeTelegramHtml(link) }));
    const lines = [`☀ <b>${escapeTelegramHtml(report.greeting)}</b>`, escapeTelegramHtml(report.lage)];
    if (report.needsYou.length) lines.push("", `<b>${t("Braucht dich:")}</b>`, ...report.needsYou.slice(0, 3).map((i) => `• ${escapeTelegramHtml(clip(i.title, 90))}`));
    for (const s of report.sections.slice(0, 2)) {
      const first = s.statements[0];
      if (first) lines.push("", `<b>${escapeTelegramHtml(s.title)}:</b> ${escapeTelegramHtml(clip(stripRefs(first.text), 200))}`);
    }
    lines.push("", `Ganzes Briefing: ${escapeTelegramHtml(link)}`);
    await this.say(chatId, lines.join("\n"));
  }

  /** Steuer-Spur: läuft sofort, auch während Nyx arbeitet (OpenClaw T-3). */
  private async cmdStop(chatId: string): Promise<void> {
    if (this.turn) {
      this.turn.abort();
      return this.say(chatId, t("⏹ Nyx gestoppt."));
    }
    const st = await loadTelegramState(this.db);
    if (st.target === "session" && st.sessionKey) {
      const [row] = await this.db.select({ tmuxName: sessions.tmuxName, title: sessions.title }).from(sessions).where(eq(sessions.id, st.sessionKey)).limit(1);
      if (!row?.tmuxName || !this.deps.bridge) return this.say(chatId, t("Diese Session läuft nicht in NyxOS – dort kann ich nichts abbrechen."));
      const r = await this.deps.bridge.rpc("interrupt", { tmuxName: row.tmuxName });
      const out = r.result as { interrupted?: boolean; reason?: string } | undefined;
      if (r.ok && out?.interrupted) return this.say(chatId, t("⏹ Esc geschickt – die Session hält an und wartet auf dich."));
      return this.say(chatId, `⏹ ${escapeTelegramHtml(out?.reason ?? (r.code === "bridge_offline" ? t("Dein Mac ist gerade nicht verbunden.") : t("Das hat nicht geklappt – bitte gleich noch einmal.")))}`);
    }
    await this.say(chatId, t("Gerade läuft nichts, das ich abbrechen könnte."));
  }

  private async cmdTemporary(chatId: string): Promise<void> {
    const st = await loadTelegramState(this.db);
    const hours = await loadTemporaryHours(this.db);
    if (!(st.target === "session" && st.sessionKey) && !st.nyxThreadId) return this.say(chatId, t("Es gibt noch kein Nyx-Gespräch – schreib erst etwas."));
    const question =
      st.target === "session" && st.sessionKey
        ? t("⏳ Soll diese Session ein Wegwerf-Chat werden? Er wird {hours} Std. nach der letzten Nachricht aufgeräumt.", { hours })
        : t("⏳ Soll das Nyx-Gespräch ein Wegwerf-Chat werden? Er wird {hours} Std. nach der letzten Nachricht aufgeräumt.", { hours });
    await this.say(chatId, question, {
      inline_keyboard: [[{ text: t("⏳ Temporär"), callback_data: cb("tp", "1") }, { text: t("📌 Behalten"), callback_data: cb("tp", "0") }]],
    });
  }

  // ───────────────────────────── Knöpfe ─────────────────────────────

  private async onButton(ctx: Context, parts: string[] | null): Promise<void> {
    const chatId = this.chat(ctx);
    if (!parts) return this.edit(ctx, t("Dieser Knopf ist abgelaufen. Bitte das Menü neu öffnen."));
    const [kind, a, b, c] = parts;
    switch (kind) {
      case "nyx":
        return this.cmdNyx(chatId, ctx);
      case "cmd":
        if (a === "sessions") return this.cmdSessions(chatId, ctx);
        if (a === "neu") return this.cmdNew(chatId, ctx);
        if (a === "briefing") return this.cmdBriefing(chatId);
        if (a === "nyx") return this.cmdNyx(chatId, ctx);
        return this.cmdStatus(chatId);
      case "tk": {
        const on = a === "on";
        await patchTelegramState(this.db, { talkMode: on, ...(on ? { target: "nyx", sessionKey: null } : {}) });
        this.deps.hub?.broadcast({ type: "telegram" });
        const text = on
          ? t("📞 Sprachmodus an: Schick mir Sprachnachrichten – ich antworte sofort, nur mit Stimme.\n(Echte Anrufe kann ein Telegram-Bot nicht annehmen.)")
          : t("📴 Sprachmodus aus. Ich antworte wieder als Text (und Sprache, wenn du sprichst).");
        return this.edit(ctx, text, this.nyxKeyboard(on));
      }
      case "ss": {
        const item = this.reg.get(a);
        if (item?.kind !== "session") return this.edit(ctx, t("Dieser Knopf ist abgelaufen. /sessions zeigt die aktuelle Liste."));
        return this.selectSession(ctx, item.key);
      }
      case "nw":
        return this.onNewStep(ctx, a, b, c, parts[4]);
      case "fg": {
        const id = Number(b);
        if (!this.deps.approvals || !Number.isInteger(id)) return;
        const decision = a === "a" ? "approve" : "deny";
        const r = await this.deps.approvals.decide(id, decision);
        this.log("telegram-freigabe", { id, decision, ok: r.ok });
        const original = ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message ? (ctx.callbackQuery.message.text ?? "") : "";
        const outcome = r.ok ? (decision === "approve" ? t("✅ Freigegeben") : t("❌ Abgelehnt")) : `⚠️ ${r.message}`;
        return this.edit(ctx, `${escapeTelegramHtml(original)}\n\n${escapeTelegramHtml(outcome)}`);
      }
      case "ib": {
        const id = Number(a);
        const idx = Number(b);
        if (!this.deps.inbox || !Number.isInteger(id) || !Number.isInteger(idx)) return;
        const r = await this.deps.inbox.answer(id, idx);
        this.log("telegram-inbox-antwort", { id, option: idx, ok: r.ok });
        const msg = ctx.callbackQuery?.message;
        const original = msg && "text" in msg ? (msg.text ?? "") : "";
        // Nur die Knöpfe DIESER Frage entfernen – andere Fragen in derselben Nachricht bleiben beantwortbar.
        const prefix = `${cb("ib", id)}:`;
        const keyboard = (msg && "reply_markup" in msg ? msg.reply_markup?.inline_keyboard : undefined) ?? [];
        const rest = keyboard.filter((row) => !row.some((btn) => "callback_data" in btn && typeof btn.callback_data === "string" && btn.callback_data.startsWith(prefix)));
        const outcome = r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`;
        return this.edit(ctx, `${escapeTelegramHtml(original)}\n\n${escapeTelegramHtml(outcome)}`, rest.length ? { inline_keyboard: rest } : undefined);
      }
      case "mo": {
        const item = this.reg.get(a);
        if (item?.kind !== "text") return this.say(chatId, t("Den ganzen Text habe ich nicht mehr – schau im Session-Chat in NyxOS nach."));
        return this.sendLong(chatId, item.text);
      }
      case "tp":
        return this.onTemporary(ctx, a === "1");
      default:
        return this.edit(ctx, t("Dieser Knopf ist abgelaufen. Bitte das Menü neu öffnen."));
    }
  }

  /** `/neu` in Schritten, immer in derselben Nachricht (OpenClaw T-7): Ordner → Claude/Codex → Temporär → Start. */
  private async onNewStep(ctx: Context, step: string | undefined, id: string | undefined, tool: string | undefined, temp: string | undefined): Promise<void> {
    const item = this.reg.get(id);
    if (item?.kind !== "cwd") return this.edit(ctx, t("Dieser Knopf ist abgelaufen. /neu startet neu."));
    const label = escapeTelegramHtml(item.label);
    if (step === "f") {
      return this.edit(ctx, t("➕ Neue Session in „{label}“ – mit wem?", { label }), {
        inline_keyboard: [[{ text: "Claude", callback_data: cb("nw", "t", id ?? "", "c") }, { text: "Codex", callback_data: cb("nw", "t", id ?? "", "x") }]],
      });
    }
    const toolName: Tool = tool === "x" ? "codex" : "claude";
    const toolLabel = toolName === "codex" ? "Codex" : "Claude";
    if (step === "t") {
      return this.edit(ctx, t("➕ {tool} in „{label}“ – normal oder als Wegwerf-Session?", { tool: toolLabel, label }), {
        inline_keyboard: [[{ text: t("▶ Normal"), callback_data: cb("nw", "s", id ?? "", tool ?? "c", "0") }, { text: t("⏳ Temporär"), callback_data: cb("nw", "s", id ?? "", tool ?? "c", "1") }]],
      });
    }
    if (step !== "s" || !this.deps.startSession) return;
    await this.edit(ctx, t("⏳ Starte {tool} in „{label}“ …", { tool: toolLabel, label }));
    const r = await this.deps.startSession({ tool: toolName, cwd: item.cwd, temporary: temp === "1" });
    if (!r.ok) return this.edit(ctx, t("Start hat nicht geklappt: {error}", { error: escapeTelegramHtml(r.error) }));
    if (r.sessionKey) {
      await patchTelegramState(this.db, { target: "session", sessionKey: r.sessionKey });
      this.deps.hub?.broadcast({ type: "telegram" });
      return this.edit(ctx, temp === "1"
          ? t("✅ {tool} läuft in „{label}“ (temporär). Deine Nachrichten gehen jetzt dorthin.\n/nyx bringt dich zurück zu Nyx.", { tool: toolLabel, label })
          : t("✅ {tool} läuft in „{label}“. Deine Nachrichten gehen jetzt dorthin.\n/nyx bringt dich zurück zu Nyx.", { tool: toolLabel, label }));
    }
    return this.edit(ctx, t("✅ {tool} läuft in „{label}“. Sobald sie in der Liste erscheint, findest du sie unter /sessions.", { tool: toolLabel, label }));
  }

  private async onTemporary(ctx: Context, temporary: boolean): Promise<void> {
    const st = await loadTelegramState(this.db);
    const hours = await loadTemporaryHours(this.db);
    if (st.target === "session" && st.sessionKey) {
      const row = await setSessionTemporary(this.db, st.sessionKey, temporary, new Date(this.now()));
      if (!row) return this.edit(ctx, t("Diese Session gibt es nicht mehr."));
      await this.deps.publish?.(new Set([row.id])).catch(() => {});
    } else if (st.nyxThreadId) {
      await this.db
        .update(haikuThreads)
        .set(temporary ? { temporary: true, updatedAt: new Date(this.now()).toISOString() } : { temporary: false })
        .where(eq(haikuThreads.id, st.nyxThreadId));
      this.deps.hub?.broadcast({ type: "haiku", what: "threads" });
    }
    return this.edit(ctx, temporary ? t("⏳ Temporär: wird {hours} Std. nach der letzten Nachricht aufgeräumt.", { hours }) : t("📌 Wird behalten."));
  }

  // ───────────────────────────── Eingang: bündeln, Spur, Züge ─────────────────────────────

  private enqueue(fn: () => Promise<void>): void {
    this.work = this.work.then(fn).catch((e: unknown) => this.log("telegram-zug-fehler", { error: e instanceof Error ? e.message : String(e) }));
  }

  /** OpenClaw T-15: schnell nacheinander getippte Nachrichten 300 ms sammeln (Befehle gehen nie hier durch). */
  private bufferText(chatId: string, text: string, messageId: number): void {
    const ms = this.deps.bufferMs ?? 300;
    if (this.buffer && this.buffer.chatId === chatId) {
      this.buffer.parts.push(text);
      this.buffer.messageIds.push(messageId);
      this.buffer.timer.refresh();
      return;
    }
    let resolve: () => void = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    const flush = () => {
      const b = this.buffer;
      this.buffer = null;
      if (!b) return;
      this.enqueue(() => this.textTurn(b.chatId, b.parts.join("\n"), b.messageIds.at(-1) ?? null));
      b.resolve();
    };
    this.buffer = { chatId, parts: [text], messageIds: [messageId], timer: setTimeout(flush, ms), done, resolve };
  }

  private async textTurn(chatId: string, text: string, messageId: number | null): Promise<void> {
    const st = await loadTelegramState(this.db);
    if (st.target === "session" && st.sessionKey) return this.sessionTurn(chatId, st.sessionKey, text, [], messageId);
    return this.nyxTurn(chatId, text, { voice: false, attachments: [], messageId });
  }

  private async download(fileId: string): Promise<Uint8Array | null> {
    const bot = this.bot;
    const token = this.token;
    if (!bot || !token) return null;
    const file = await bot.api.getFile(fileId);
    if (!file.file_path || (file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return null;
    const fetchFile =
      this.deps.fetchFile ??
      (async (t: string, p: string) => {
        const res = await fetch(`https://api.telegram.org/file/bot${t}/${p}`, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      });
    const data = await fetchFile(token, file.file_path);
    return data.byteLength > MAX_DOWNLOAD_BYTES ? null : data;
  }

  private async voiceTurn(chatId: string, fileId: string, mime: string, messageId: number): Promise<void> {
    const voice = this.deps.voice;
    if (!voice) return this.say(chatId, t("Sprachnachrichten kann ich noch nicht hören – die Stimme auf dem Server ist noch nicht eingerichtet. Schreib mir kurz."));
    this.react(chatId, messageId, "👀");
    let audio: Uint8Array | null;
    try {
      audio = await this.download(fileId);
    } catch (e) {
      this.log("telegram-download-fehler", { error: e instanceof Error ? e.message : String(e) });
      audio = null;
    }
    if (!audio) return this.say(chatId, t("Die Sprachnachricht konnte ich nicht laden (höchstens 20 MB). Bitte noch einmal schicken."));
    if (audio.byteLength < MIN_VOICE_BYTES) return this.say(chatId, t("Die Sprachnachricht war zu kurz – bitte noch einmal sprechen."));
    void this.bot?.api.sendChatAction(chatId, "typing").catch(() => {});
    let text: string;
    try {
      // dieselben Korrekturen wie jede Erkennung über die API (Nyx, Build auf dem Rechner).
      // nur auf deutschen Text (englische Sprachnachrichten bleiben, wie sie erkannt wurden).
      const heard = await voice.transcribe(audio, mime.split(";")[0]?.trim() || "audio/ogg");
      text = fixTranscriptFor(heard.text, heard.language).trim();
    } catch (e) {
      this.log("telegram-transkription-fehler", { error: e instanceof Error ? e.message : String(e) });
      this.react(chatId, messageId, "💔");
      return this.say(chatId, t("Ich konnte die Sprachnachricht gerade nicht verstehen – die Stimme auf dem Server antwortet nicht. Schreib mir kurz, dann geht es weiter."));
    }
    if (!text) return this.say(chatId, t("Ich habe nichts verstanden – bitte noch einmal sprechen."));
    const st = await loadTelegramState(this.db);
    if (settingsOf(st).echoTranscript && !st.talkMode) await this.say(chatId, `📝 ${quote(escapeTelegramHtml(text))}`);
    if (st.target === "session" && st.sessionKey) return this.sessionTurn(chatId, st.sessionKey, text, [], messageId);
    return this.nyxTurn(chatId, wrapUntrusted("Sprachnachricht vom Nutzer, transkribiert", text), { voice: true, attachments: [], messageId });
  }

  private async fileTurn(chatId: string, fileId: string, name: string, mime: string, caption: string, messageId: number): Promise<void> {
    this.react(chatId, messageId, "👀");
    let data: Uint8Array | null;
    try {
      data = await this.download(fileId);
    } catch (e) {
      this.log("telegram-download-fehler", { error: e instanceof Error ? e.message : String(e) });
      data = null;
    }
    if (!data) return this.say(chatId, t("Die Datei konnte ich nicht laden (höchstens 20 MB). Bitte noch einmal schicken."));
    const st = await loadTelegramState(this.db);
    if (st.target === "session" && st.sessionKey) return this.sessionTurn(chatId, st.sessionKey, caption, [{ name, data }], messageId);
    const text = caption ? wrapUntrusted("Bildunterschrift", caption) : "Der Nutzer hat dir eine Datei geschickt.";
    return this.nyxTurn(chatId, text, { voice: false, attachments: [{ name, mime, data }], messageId });
  }

  /** Freie Nachricht an die gewählte Session — immer über die Zustell-Warteschlange, nie blind getippt. */
  private async sessionTurn(chatId: string, key: string, text: string, files: { name: string; data: Uint8Array }[], messageId: number | null): Promise<void> {
    const [row] = await this.db.select({ id: sessions.id, tool: sessions.tool }).from(sessions).where(eq(sessions.id, key)).limit(1);
    if (!row) {
      await patchTelegramState(this.db, { target: "nyx", sessionKey: null });
      return this.say(chatId, t("Die gewählte Session gibt es nicht mehr – deine Nachrichten gehen wieder an Nyx."));
    }
    const bridge = this.deps.bridge;
    const saved: { name: string; path: string; image: boolean }[] = [];
    for (const f of files) {
      if (!chatFileAllowed(f.name)) return this.say(chatId, t("„{name}“ kann ich nicht anhängen. Erlaubt sind Bilder, PDF und Text-/Code-Dateien.", { name: escapeTelegramHtml(f.name) }));
      if (!bridge?.online) return this.say(chatId, t("Dein Mac ist gerade nicht verbunden – Dateien gehen raus, sobald er wieder da ist."));
      const up = await bridge.rpc("save_upload", { sessionKey: row.id, files: [{ name: f.name, dataBase64: Buffer.from(f.data).toString("base64") }] }, 60_000);
      if (!up.ok) return this.say(chatId, t("Die Datei konnte nicht auf deinem Mac abgelegt werden. Bitte noch einmal schicken."));
      for (const s of (up.result as SaveUploadResult).files) saved.push({ name: s.name, path: s.path, image: chatFileIsImage(s.name) });
    }
    const input = composeChatInput(row.tool as Tool, text, saved);
    if (!input.text && input.images.length === 0) return;
    const r = await deliverOrQueue(this.deliveryDeps(), { sessionKey: row.id, kind: "chat", text: input.text, ...(input.images.length ? { images: input.images } : {}) });
    if (r.status === "sent") {
      if (messageId) this.react(chatId, messageId, "👌");
      return;
    }
    return this.say(chatId, r.status === "queued" ? `⏳ ${escapeTelegramHtml(r.reason)}` : `⚠️ ${escapeTelegramHtml(r.reason)}`);
  }

  /** Ein Nyx-Zug: eine Fortschritts-Nachricht, Reaktionen, am Ende Text und/oder Sprache. */
  private async nyxTurn(chatId: string, message: string, opts: { voice: boolean; attachments: NyxAttachment[]; messageId: number | null }): Promise<void> {
    const nyx = this.deps.nyx;
    const bot = this.bot;
    if (!bot) return;
    if (!nyx) return this.say(chatId, t("Nyx ist gerade nicht erreichbar."));
    const st = await loadTelegramState(this.db);
    const settings = settingsOf(st);
    const ctrl = new AbortController();
    this.turn = ctrl;
    if (opts.messageId) this.react(chatId, opts.messageId, "👀");
    const typing = setInterval(() => void bot.api.sendChatAction(chatId, "typing").catch(() => {}), 4000);
    typing.unref();
    void bot.api.sendChatAction(chatId, "typing").catch(() => {});
    const progress = await bot.api.sendMessage(chatId, t("💭 Nyx denkt …")).catch(() => null);
    let lastEdit = 0;
    let editFails = 0;
    let answer: { text: string; speak: string } | null = null;
    let failure: string | null = null;
    const editProgress = async (text: string) => {
      if (!progress || editFails >= 3 || this.now() - lastEdit < PROGRESS_EDIT_MS) return;
      lastEdit = this.now();
      await bot.api.editMessageText(chatId, progress.message_id, text).catch(() => void editFails++);
    };
    try {
      for await (const ev of nyx.ask({ threadId: st.nyxThreadId, message, channel: "telegram", voice: opts.voice, attachments: opts.attachments, signal: ctrl.signal })) {
        if (ctrl.signal.aborted) break;
        if (ev.type === "thread" && ev.threadId !== st.nyxThreadId) await patchTelegramState(this.db, { nyxThreadId: ev.threadId });
        else if (ev.type === "status" && ev.status === "thinking" && opts.messageId) this.react(chatId, opts.messageId, "🤔");
        else if (ev.type === "status" && ev.status === "tool") {
          if (opts.messageId) this.react(chatId, opts.messageId, "👨‍💻");
          await editProgress(`🔧 Nyx ${nyxToolDoing(ev.tool)} …`); // Wörter aus der gemeinsamen Zuordnung, nie die ID
        } else if (ev.type === "status" && ev.status === "queued") await editProgress(t("⏳ Nyx ist gleich dran …"));
        else if (ev.type === "image") {
          // Bild aus show_image/screenshot_simulator sofort als Foto (Beschriftung = Titel).
          await bot.api.sendPhoto(chatId, new InputFile(ev.data, ev.name), { caption: clip(ev.title, TELEGRAM_CAPTION_LIMIT) }).catch((e: unknown) => this.log("telegram-bild-fehler", { error: e instanceof Error ? e.message : String(e) }));
        } else if (ev.type === "done") answer = { text: ev.text, speak: ev.speak };
        else if (ev.type === "error") failure = ev.message;
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      clearInterval(typing);
      if (this.turn === ctrl) this.turn = null;
      if (progress) await bot.api.deleteMessage(chatId, progress.message_id).catch(() => {});
    }
    if (ctrl.signal.aborted) return; // /stop hat schon geantwortet
    if (!answer) {
      if (opts.messageId) this.react(chatId, opts.messageId, "💔");
      return this.say(chatId, t("Nyx konnte gerade nicht antworten. {reason}", { reason: escapeTelegramHtml(failure ?? "") }).trim());
    }
    const wantVoice = st.talkMode || settings.voiceReply === "always" || (settings.voiceReply === "voice_only" && opts.voice);
    let voiceSent = false;
    if (wantVoice && this.deps.voice) {
      try {
        void bot.api.sendChatAction(chatId, "record_voice").catch(() => {});
        const s = await this.deps.voice.speak(answer.speak || speakableOf(answer.text));
        if (s.contentType.includes("ogg")) await bot.api.sendVoice(chatId, new InputFile(s.audio, "nyx.ogg"), s.seconds ? { duration: Math.round(s.seconds) } : {});
        else await bot.api.sendAudio(chatId, new InputFile(s.audio, "nyx.wav"));
        voiceSent = true;
      } catch (e) {
        this.log("telegram-sprache-fehler", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Sprachmodus = nur Stimme; klappt die Stimme nicht, kommt die Antwort trotzdem als Text.
    if (!st.talkMode || !voiceSent) await this.sendLong(chatId, stripRefs(answer.text));
    if (opts.messageId) this.react(chatId, opts.messageId, "👍");
  }

  // ───────────────────────────── Senden ─────────────────────────────

  private deliveryDeps(): DeliveryDeps {
    return { db: this.db, bridge: this.deps.bridge ?? null, hub: this.deps.hub, log: this.log };
  }

  private react(chatId: string, messageId: number, emoji: string): void {
    void this.bot?.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] }]).catch(() => {});
  }

  /** Kurze Nachricht (schon HTML). */
  private async say(chatId: string, html: string, markup?: InlineKeyboardMarkup): Promise<void> {
    await this.sendChunks(chatId, chunkText(html), markup);
  }

  /**
   * Längerer Text: `markdown` = Nyx-Markdown → Telegram-HTML (sonst ist der Text schon HTML bzw. wird maskiert).
   * Teilen bei 4000 Zeichen, HTML mit Klartext-Rückfall (OpenClaw T-12).
   */
  private async sendLong(chatId: string, text: string, markup?: InlineKeyboardMarkup, markdown = true): Promise<void> {
    const chunks = chunkText(text).map((c) => (markdown ? markdownToTelegramHtml(c) : escapeTelegramHtml(c)));
    await this.sendChunks(chatId, chunks, markup, chunkText(text));
  }

  private async sendChunks(chatId: string, html: string[], markup?: InlineKeyboardMarkup, plain?: string[]): Promise<void> {
    const bot = this.bot;
    if (!bot) return;
    for (let i = 0; i < html.length; i++) {
      const last = i === html.length - 1;
      const extra = last && markup ? { reply_markup: markup } : {};
      try {
        await bot.api.sendMessage(chatId, html[i] ?? "", { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
      } catch (e) {
        if (!(e instanceof GrammyError && PARSE_ERR_RE.test(e.description))) throw e;
        await bot.api.sendMessage(chatId, plain?.[i] ?? (html[i] ?? "").replace(/<[^>]+>/g, ""), { link_preview_options: { is_disabled: true }, ...extra });
      }
    }
  }

  /** Menü-Nachricht bearbeiten (statt neu senden); „message is not modified“ ist kein Fehler. */
  private async edit(ctx: Context, html: string, markup?: InlineKeyboardMarkup): Promise<void> {
    try {
      await ctx.editMessageText(html, { parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) });
    } catch (e) {
      if (e instanceof GrammyError && /not modified/i.test(e.description)) return;
      await this.say(this.chat(ctx), html, markup);
    }
  }
}

/** Wer eine weitergeleitete Nachricht ursprünglich geschrieben hat (nur für die Einrahmung). */
function forwardSource(o: MessageOrigin): string {
  if (o.type === "user") return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ") || "unbekannt";
  if (o.type === "hidden_user") return o.sender_user_name;
  if (o.type === "chat") return o.sender_chat.type === "private" ? "Chat" : (o.sender_chat.title ?? "Chat");
  return o.chat.title ?? "Kanal";
}

/** Höchstens so lange wartet ein Aufruf auf Telegrams `retry_after` (länger → Fehler wie bisher). */
const RETRY_MAX_WAIT_S = 30;
const RETRY_ATTEMPTS = 3;

/**
 * Telegram-Rate-Limit (429) und kurze Server-Fehler (5xx) — Aufruf nach `retry_after` bzw. kurzem Backoff
 * wiederholen (Muster wie `@grammyjs/auto-retry`, MIT), statt die Antwort still zu verlieren. `getUpdates` regelt die
 * Polling-Schleife selbst.
 */
export function retryTransformer(log: Log, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Transformer {
  return async (prev, method, payload, signal) => {
    let res = await prev(method, payload, signal);
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS && !res.ok && method !== "getUpdates"; attempt++) {
      const wait = res.error_code === 429 ? (res.parameters?.retry_after ?? 1) : res.error_code >= 500 ? attempt : null;
      if (wait === null || wait > RETRY_MAX_WAIT_S || signal?.aborted) break;
      log("telegram-wiederholung", { method, code: res.error_code, waitS: wait, attempt });
      await sleep(wait * 1000);
      res = await prev(method, payload, signal);
    }
    return res;
  };
}

export class PairingLockedError extends Error {
  constructor(readonly lockedUntil: string | null) {
    super("Kopplung gesperrt");
  }
}
