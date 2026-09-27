// Geheimnis-Speicher (AES-256-GCM). Rundlauf, falscher Schlüssel, fehlender Schlüssel, Routen nie Klartext.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { secrets } from "../src/db/schema.js";
import { decryptValue, encryptValue, parseSecretsKey, SecretsKeyError, SecretStore } from "../src/secrets/store.js";
import { setup, sharedDb } from "./helpers.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

describe("Verschlüsselung", () => {
  it("Rundlauf: verschlüsselt, entschlüsselt, Klartext steht nirgends im Chiffrat", () => {
    const key = parseSecretsKey(KEY_A);
    if (!key) throw new Error("Schlüssel ungültig");
    const enc = encryptValue(key, "provider.openai", "sk-geheim-1234567890");
    expect(enc.ciphertext).not.toContain("geheim");
    expect(Buffer.from(enc.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(enc.tag, "base64")).toHaveLength(16);
    expect(decryptValue(key, "provider.openai", enc)).toBe("sk-geheim-1234567890");
  });

  it("falscher Schlüssel → Fehler 'invalid', kein Müll-Klartext", () => {
    const a = parseSecretsKey(KEY_A);
    const b = parseSecretsKey(KEY_B);
    if (!a || !b) throw new Error("Schlüssel ungültig");
    const enc = encryptValue(a, "x", "wert");
    expect(() => decryptValue(b, "x", enc)).toThrow(SecretsKeyError);
  });

  it("Name ist gebunden (AAD): umkopiertes Chiffrat unter anderem Namen geht nicht auf", () => {
    const a = parseSecretsKey(KEY_A);
    if (!a) throw new Error("Schlüssel ungültig");
    const enc = encryptValue(a, "telegram.bot", "123:abc");
    expect(() => decryptValue(a, "provider.openai", enc)).toThrow(SecretsKeyError);
  });

  it("Schlüssel muss 32 Byte base64 sein", () => {
    expect(parseSecretsKey(undefined)).toBeNull();
    expect(parseSecretsKey("")).toBeNull();
    expect(parseSecretsKey(Buffer.alloc(16).toString("base64"))).toBeNull();
    expect(parseSecretsKey("kein base64 !!!")).toBeNull();
  });
});

describe("SecretStore", () => {
  it("setSecret/getSecret: in der DB nur Chiffrat, last4 zur Anzeige", async () => {
    const db = await sharedDb();
    const store = new SecretStore(db, KEY_A);
    await store.setSecret("provider.openai", "sk-live-abcdefWXYZ");
    const [row] = await db.select().from(secrets).where(eq(secrets.name, "provider.openai"));
    expect(row?.ciphertext).not.toContain("abcdef");
    expect(row?.last4).toBe("WXYZ");
    expect(await store.getSecret("provider.openai")).toBe("sk-live-abcdefWXYZ");
    expect(await store.getSecret("fehlt")).toBeNull();
    const list = await store.list();
    expect(list).toEqual([expect.objectContaining({ name: "provider.openai", set: true, last4: "WXYZ" })]);
    await store.deleteSecret("provider.openai");
    expect(await store.getSecret("provider.openai")).toBeNull();
  });

  it("ohne Schlüssel: Zustand 'missing', Schreiben wirft, Lesen wirft", async () => {
    const db = await sharedDb();
    const store = new SecretStore(db, undefined);
    expect(store.keyState).toBe("missing");
    await expect(store.setSecret("a", "b")).rejects.toThrow(SecretsKeyError);
    expect((await store.status()).key).toBe("missing");
  });

  it("anderer Schlüssel als beim Speichern: Zustand 'invalid', getSecret wirft", async () => {
    const db = await sharedDb();
    await new SecretStore(db, KEY_A).setSecret("telegram.bot", "123456:ABCDEF");
    const other = new SecretStore(db, KEY_B);
    await expect(other.getSecret("telegram.bot")).rejects.toThrow(SecretsKeyError);
    expect((await other.status()).key).toBe("invalid");
  });
});

describe("Routen /api/secrets", () => {
  const prev = process.env.NYXOS_SECRETS_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.NYXOS_SECRETS_KEY;
    else process.env.NYXOS_SECRETS_KEY = prev;
  });

  it("PUT speichert, GET zeigt nur gesetzt + letzte 4 – nie den Klartext", async () => {
    process.env.NYXOS_SECRETS_KEY = KEY_A;
    const { app } = await setup();
    const put = await app.request("/api/secrets/telegram.bot", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "999:SUPERGEHEIM-token-QRST" }) });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain("SUPERGEHEIM");
    const res = await app.request("/api/secrets");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("SUPERGEHEIM");
    const body = JSON.parse(text) as { key: string; secrets: { name: string; set: boolean; last4: string | null }[] };
    expect(body.key).toBe("ok");
    expect(body.secrets).toEqual([expect.objectContaining({ name: "telegram.bot", set: true, last4: "QRST" })]);
    const del = await app.request("/api/secrets/telegram.bot", { method: "DELETE", headers: { "content-type": "application/json" } });
    expect(del.status).toBe(200);
  });

  it("ohne Schlüssel: GET sagt 'Schlüssel fehlt', PUT 409 mit einfachen Worten", async () => {
    delete process.env.NYXOS_SECRETS_KEY;
    const { app } = await setup();
    const res = await app.request("/api/secrets");
    const body = (await res.json()) as { key: string; reason: string };
    expect(body.key).toBe("missing");
    expect(body.reason).toMatch(/Schlüssel/);
    const put = await app.request("/api/secrets/telegram.bot", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x" }) });
    expect(put.status).toBe(409);
  });

  it("ungültiger Name → 400", async () => {
    process.env.NYXOS_SECRETS_KEY = KEY_A;
    const { app } = await setup();
    const put = await app.request("/api/secrets/GROSS", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x" }) });
    expect(put.status).toBe(400);
  });
});
