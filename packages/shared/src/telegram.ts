// Telegram: Vertrag zwischen Server (`apps/server/src/telegram/`) und Web (Einstellungen → Telegram).
// Der Bot läuft im API-Prozess per Long-Polling (kein offener Port). Zugang hat nur EIN Chat: der, der den
// Kopplungs-Code aus NyxOS mit `/start <code>` geschickt hat. Das Token verlässt den Server nie (nur „gesetzt“
// + letzte 4 Zeichen).
import { z } from "zod";

/** Telegram erlaubt höchstens 64 Byte `callback_data` je Knopf (Bot-API, OpenClaw/Hermes gleich). */
export const TELEGRAM_CALLBACK_MAX_BYTES = 64;
/** Kopplungs-Code: 8 Zeichen ohne 0/O/1/I (OpenClaw `pairing-store.ts`, Hermes `pairing.py`). */
export const TELEGRAM_PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TELEGRAM_PAIRING_LENGTH = 8;
export const TELEGRAM_PAIRING_TTL_MS = 60 * 60_000;
export const TELEGRAM_PAIRING_MAX_FAILURES = 5;
export const TELEGRAM_PAIRING_LOCK_MS = 60 * 60_000;

/** Bot-Token wie von @BotFather: `<Zahl>:<35 Zeichen>`. */
export const TELEGRAM_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
export const TelegramTokenBodySchema = z.object({ token: z.string().trim().regex(TELEGRAM_TOKEN_RE) });

/** Antwort als Sprache: nur wenn der Nutzer selbst spricht (Standard) · immer · nie. */
export const TelegramVoiceReplySchema = z.enum(["voice_only", "always", "never"]);
export type TelegramVoiceReply = z.infer<typeof TelegramVoiceReplySchema>;

export const TelegramSettingsPatchSchema = z
  .object({
    voiceReply: TelegramVoiceReplySchema,
    /** Erkannten Text der Sprachnachricht kurz zurückschicken („📝 …“), damit Fehlhörer auffallen. */
    echoTranscript: z.boolean(),
    notifyApprovals: z.boolean(),
    notifySessions: z.boolean(),
    /** Ruhezeiten aus Einstellungen → Push beachten (dringende Meldungen gehen immer durch). */
    respectQuietHours: z.boolean(),
  })
  .partial();
export type TelegramSettingsPatch = z.infer<typeof TelegramSettingsPatchSchema>;
export type TelegramSettings = Required<TelegramSettingsPatch>;

/**
 * no_token = wartet auf das Bot-Token · starting = verbindet gerade · connected = läuft (Long-Polling) ·
 * error = Token falsch oder Telegram nicht erreichbar (Satz in `reason`).
 */
export type TelegramBotState = "no_token" | "starting" | "connected" | "error";

export interface TelegramStatus {
  state: TelegramBotState;
  /** Einfacher Satz für den Nutzer (nie ein Technik-Text). */
  sentence: string;
  /** Bei `error`: was der Nutzer tun kann. */
  fix: string | null;
  bot: { username: string; name: string } | null;
  token: {
    set: boolean;
    last4: string | null;
    /** store = Geheimnis-Speicher · env = TELEGRAM_BOT_TOKEN aus der Server-.env. */
    source: "store" | "env" | null;
    /** false = der Geheimnis-Speicher ist (noch) nicht da; eintragen geht dann nur über die .env. */
    canEdit: boolean;
    editHint: string | null;
  };
  paired: { name: string; since: string } | null;
  pairing: { active: boolean; expiresAt: string | null; lockedUntil: string | null; failures: number };
  /** Wohin freie Nachrichten gerade gehen. */
  target: { kind: "nyx" } | { kind: "session"; sessionKey: string; title: string };
  talkMode: boolean;
  settings: TelegramSettings;
  voice: { ready: boolean; sentence: string };
  /** „📞 Mit Nyx sprechen“ als Telegram-Mini-App: braucht eine HTTPS-Adresse (Tailscale), bis dahin aus. */
  miniApp: { enabled: boolean; sentence: string };
}

export interface TelegramPairingResult {
  code: string;
  expiresAt: string;
  /** `https://t.me/<bot>?start=<code>` — öffnet den Bot mit dem Code (nur, wenn der Bot verbunden ist). */
  link: string | null;
}
