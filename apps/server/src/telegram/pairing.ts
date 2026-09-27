// Kopplungs-Code. Übernommen und angepasst aus Hermes `gateway/pairing.py` (MIT, Nous Research) und
// OpenClaw `src/pairing/pairing-store.ts` (MIT): 8 Zeichen ohne 0/O/1/I über `crypto.randomInt`, gültig 1 h,
// nur ein gesalzener SHA-256-Hash wird gespeichert, zeitkonstanter Vergleich, Sperre nach 5 Fehlversuchen,
// der Code landet nie im Protokoll. Anders als dort erzeugt NyxOS den Code (Einstellungen → Telegram) und
// der Nutzer schickt ihn dem Bot mit `/start <code>`.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { TELEGRAM_PAIRING_ALPHABET, TELEGRAM_PAIRING_LENGTH, TELEGRAM_PAIRING_LOCK_MS, TELEGRAM_PAIRING_MAX_FAILURES, TELEGRAM_PAIRING_TTL_MS } from "@nyxos/shared";

export function randomPairingCode(): string {
  let out = "";
  for (let i = 0; i < TELEGRAM_PAIRING_LENGTH; i++) out += TELEGRAM_PAIRING_ALPHABET[randomInt(0, TELEGRAM_PAIRING_ALPHABET.length)];
  return out;
}

/** Handys fügen Leerzeichen ein und schreiben klein: alles Leere raus, groß (Hermes #89937). */
export function normalizePairingCode(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

export function hashPairingCode(code: string, saltHex: string): string {
  return createHash("sha256").update(Buffer.from(saltHex, "hex")).update(code, "utf8").digest("hex");
}

export interface PairingRecord {
  pairHash: string | null;
  pairSalt: string | null;
  pairExpiresAt: string | null;
  pairFailures: number;
  pairLockedUntil: string | null;
}

export function newPairing(now: number): { code: string; record: PairingRecord } {
  const code = randomPairingCode();
  const salt = randomBytes(16).toString("hex");
  return {
    code,
    record: { pairHash: hashPairingCode(code, salt), pairSalt: salt, pairExpiresAt: new Date(now + TELEGRAM_PAIRING_TTL_MS).toISOString(), pairFailures: 0, pairLockedUntil: null },
  };
}

export type PairingCheck = { ok: true } | { ok: false; reason: "none" | "expired" | "locked" | "wrong"; record?: Partial<PairingRecord> };

export function isLocked(r: Pick<PairingRecord, "pairLockedUntil">, now: number): boolean {
  return !!r.pairLockedUntil && Date.parse(r.pairLockedUntil) > now;
}

export function isActive(r: Pick<PairingRecord, "pairHash" | "pairExpiresAt">, now: number): boolean {
  return !!r.pairHash && !!r.pairExpiresAt && Date.parse(r.pairExpiresAt) > now;
}

/**
 * Prüft einen Code. Bei „wrong“ liefert `record` den neuen Fehlerstand (ab 5 Fehlversuchen gesperrt, Code
 * verworfen). Die Sperre gilt VOR dem Vergleich — sonst käme ein schon ausgegebener Code an ihr vorbei (Hermes).
 */
export function checkPairingCode(r: PairingRecord, input: string, now: number): PairingCheck {
  if (isLocked(r, now)) return { ok: false, reason: "locked" };
  if (!r.pairHash || !r.pairSalt) return { ok: false, reason: "none" };
  if (!isActive(r, now)) return { ok: false, reason: "expired" };
  const got = Buffer.from(hashPairingCode(normalizePairingCode(input), r.pairSalt), "hex");
  const want = Buffer.from(r.pairHash, "hex");
  if (got.length === want.length && timingSafeEqual(got, want)) return { ok: true };
  const failures = r.pairFailures + 1;
  if (failures >= TELEGRAM_PAIRING_MAX_FAILURES) {
    return { ok: false, reason: "wrong", record: { pairFailures: failures, pairLockedUntil: new Date(now + TELEGRAM_PAIRING_LOCK_MS).toISOString(), pairHash: null, pairSalt: null, pairExpiresAt: null } };
  }
  return { ok: false, reason: "wrong", record: { pairFailures: failures } };
}
