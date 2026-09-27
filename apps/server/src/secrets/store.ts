// Geheimnis-Speicher. AES-256-GCM, Schlüssel `NYXOS_SECRETS_KEY` (32 Byte, base64) aus der .env
// (Server-Modus: infra/.env, einmalig mit `openssl rand -base64 32` erzeugt; nie ausgegeben). Der Name des
// Geheimnisses ist als AAD gebunden (ein umkopiertes Chiffrat geht unter anderem Namen nicht auf).
//
// Schnittstelle für andere Pakete (Telegram-Token, MCP-Tokens, API-Schlüssel):
//   getSecret(db, name)  → Klartext oder null (wirft SecretsKeyError, wenn der Schlüssel fehlt/nicht passt)
//   setSecret(db, name, value) / deleteSecret(db, name)
// Klartext verlässt den Server nie: Routen geben nur „gesetzt“ + letzte 4 Zeichen zurück. Nie loggen.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretInfo, SecretsKeyState, SecretsStatus } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { secrets } from "../db/schema.js";

export const SECRETS_KEY_ENV = "NYXOS_SECRETS_KEY";

/** Einfache Worte für den Nutzer (UI zeigt sie wörtlich). */
export const SECRETS_REASON = {
  missing: "Der Schlüssel für den Geheimnis-Speicher fehlt noch. Claude legt ihn beim nächsten Deploy an – danach kannst du hier Schlüssel eintragen.",
  invalid: "Gespeicherte Schlüssel lassen sich nicht mehr öffnen (der Speicher-Schlüssel wurde getauscht). Bitte die betroffenen Schlüssel neu eintragen.",
} as const;

export class SecretsKeyError extends Error {
  constructor(readonly state: Exclude<SecretsKeyState, "ok">) {
    super(t(SECRETS_REASON[state]));
  }
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** 32 Byte aus base64 – sonst `null` (kein halbgarer Schlüssel). */
export function parseSecretsKey(raw: string | undefined | null): Buffer | null {
  const s = raw?.trim();
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === 32 ? buf : null;
}

export function encryptValue(key: Buffer, name: string, value: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptValue(key: Buffer, name: string, enc: EncryptedValue): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretsKeyError("invalid");
  }
}

/** Letzte 4 Zeichen nur bei Werten, die lang genug sind (sonst verrät die Anzeige zu viel). */
export function last4Of(value: string): string | null {
  const v = value.trim();
  if (v.length < 12 || v.startsWith("{")) return null;
  return v.slice(-4);
}

export class SecretStore {
  private readonly key: Buffer | null;
  constructor(
    private readonly db: Db,
    rawKey: string | undefined = process.env[SECRETS_KEY_ENV],
  ) {
    this.key = parseSecretsKey(rawKey);
  }

  /** Nur ob ein Schlüssel da ist – ob er zu den Daten passt, sagt {@link status}. */
  get keyState(): SecretsKeyState {
    return this.key ? "ok" : "missing";
  }

  private requireKey(): Buffer {
    if (!this.key) throw new SecretsKeyError("missing");
    return this.key;
  }

  async getSecret(name: string): Promise<string | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.name, name)).limit(1);
    if (!row) return null;
    return decryptValue(this.requireKey(), name, row);
  }

  async has(name: string): Promise<boolean> {
    const [row] = await this.db.select({ name: secrets.name }).from(secrets).where(eq(secrets.name, name)).limit(1);
    return !!row;
  }

  async setSecret(name: string, value: string, opts: { showLast4?: boolean } = {}): Promise<SecretInfo> {
    const key = this.requireKey();
    const enc = encryptValue(key, name, value);
    const last4 = opts.showLast4 === false ? null : last4Of(value);
    const now = new Date().toISOString();
    await this.db
      .insert(secrets)
      .values({ name, ...enc, last4, updatedAt: now })
      .onConflictDoUpdate({ target: secrets.name, set: { ...enc, last4, updatedAt: now } });
    return { name, set: true, last4, updatedAt: now };
  }

  async deleteSecret(name: string): Promise<boolean> {
    const rows = await this.db.delete(secrets).where(eq(secrets.name, name)).returning({ name: secrets.name });
    return rows.length > 0;
  }

  async info(name: string): Promise<SecretInfo> {
    const [row] = await this.db.select({ name: secrets.name, last4: secrets.last4, updatedAt: secrets.updatedAt }).from(secrets).where(eq(secrets.name, name)).limit(1);
    return row ? { name, set: true, last4: row.last4, updatedAt: row.updatedAt } : { name, set: false, last4: null, updatedAt: null };
  }

  async list(): Promise<SecretInfo[]> {
    const rows = await this.db.select({ name: secrets.name, last4: secrets.last4, updatedAt: secrets.updatedAt }).from(secrets).orderBy(asc(secrets.name));
    return rows.map((r) => ({ name: r.name, set: true, last4: r.last4, updatedAt: r.updatedAt }));
  }

  /** Zustand für die Oberfläche: passt der Schlüssel zu den gespeicherten Daten? (Probe am ersten Eintrag.) */
  async status(): Promise<SecretsStatus> {
    const list = await this.list();
    if (!this.key) return { key: "missing", reason: t(SECRETS_REASON.missing), secrets: list };
    const [first] = await this.db.select().from(secrets).limit(1);
    if (first) {
      try {
        decryptValue(this.key, first.name, first);
      } catch {
        return { key: "invalid", reason: t(SECRETS_REASON.invalid), secrets: list };
      }
    }
    return { key: "ok", reason: null, secrets: list };
  }
}

/** Kurzform für andere Pakete (Schlüssel aus der Umgebung). */
export function getSecret(db: Db, name: string): Promise<string | null> {
  return new SecretStore(db).getSecret(name);
}

export function setSecret(db: Db, name: string, value: string): Promise<SecretInfo> {
  return new SecretStore(db).setSecret(name, value);
}

export function deleteSecret(db: Db, name: string): Promise<boolean> {
  return new SecretStore(db).deleteSecret(name);
}
