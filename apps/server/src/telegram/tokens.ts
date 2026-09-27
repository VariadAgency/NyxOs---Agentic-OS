// Woher das Bot-Token kommt. Vorrang hat der Geheimnis-Speicher (`telegram.bot_token`,
// AES-256-GCM, Einstellungen → Telegram). Als Rückfall gilt `TELEGRAM_BOT_TOKEN`
// aus der Server-.env (Compose reicht die .env per `env_file` durch). Das Token verlässt diese Schicht nur
// zum Bot selbst — nach außen gehen nur „gesetzt“, die letzten 4 Zeichen und die Quelle.
//
// Anschluss in app.ts: `secretStoreTokenSource(new SecretStore(db))` — der Speicher ist hier nur strukturell
// getippt (`getSecret/setSecret/deleteSecret`).

export const TELEGRAM_TOKEN_SECRET = "telegram.bot_token";
export const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

export interface TelegramTokenInfo {
  set: boolean;
  last4: string | null;
  source: "store" | "env" | null;
}

export interface TelegramTokenSource {
  get(): Promise<string | null>;
  info(): Promise<TelegramTokenInfo>;
  /** Fehlt, wenn es keinen beschreibbaren Speicher gibt (dann `canEdit: false`). */
  set?(token: string): Promise<void>;
  clear?(): Promise<void>;
  readonly canEdit: boolean;
  /** Satz für die Oberfläche, wenn `canEdit` false ist. */
  readonly editHint: string | null;
}

/** Strukturell wie `SecretStore` (`apps/server/src/secrets/store.ts`). */
export interface SecretStoreLike {
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<unknown>;
  deleteSecret(name: string): Promise<unknown>;
}

const last4 = (t: string) => t.slice(-4);
const ENV_ONLY_HINT = "Der Schlüssel-Speicher kommt mit dem nächsten Deploy. Bis dahin trägt Claude das Token als TELEGRAM_BOT_TOKEN in die Server-.env ein.";

export function envTokenSource(env: NodeJS.ProcessEnv = process.env): TelegramTokenSource {
  const read = () => env[TELEGRAM_TOKEN_ENV]?.trim() || null;
  return {
    get: async () => read(),
    info: async () => {
      const t = read();
      return t ? { set: true, last4: last4(t), source: "env" } : { set: false, last4: null, source: null };
    },
    canEdit: false,
    editHint: ENV_ONLY_HINT,
  };
}

export function secretStoreTokenSource(store: SecretStoreLike, env: NodeJS.ProcessEnv = process.env): TelegramTokenSource {
  const fromEnv = envTokenSource(env);
  return {
    async get() {
      return (await store.getSecret(TELEGRAM_TOKEN_SECRET)) ?? (await fromEnv.get());
    },
    async info() {
      const t = await store.getSecret(TELEGRAM_TOKEN_SECRET);
      if (t) return { set: true, last4: last4(t), source: "store" };
      return fromEnv.info();
    },
    async set(token) {
      await store.setSecret(TELEGRAM_TOKEN_SECRET, token);
    },
    async clear() {
      await store.deleteSecret(TELEGRAM_TOKEN_SECRET);
    },
    canEdit: true,
    editHint: null,
  };
}

/** Tests und Probe: festes Token (oder keins). */
export function staticTokenSource(token: string | null): TelegramTokenSource {
  let current = token;
  return {
    get: async () => current,
    info: async () => (current ? { set: true, last4: last4(current), source: "env" } : { set: false, last4: null, source: null }),
    set: async (t) => void (current = t),
    clear: async () => void (current = null),
    canEdit: true,
    editHint: null,
  };
}
