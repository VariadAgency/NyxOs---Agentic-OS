// (Fund aus der Verbindungs-Prüfung): `GET /api/entries/abc/start-plan` gab 500 statt 404 —
// `Number("abc")` ist `NaN` und ging so in die Datenbank-Abfrage. `Number.isInteger` allein reicht
// auch nicht: `1e20` ist eine ganze Zahl, sprengt aber die `serial`-Spalte (int4) und wirft ebenfalls.
// EINE Stelle für alle numerischen IDs aus Pfad/Links; jede Route antwortet bei `null` mit 404.
import { t } from "@nyxos/shared";

/** Größter Wert einer Postgres-`serial`/`integer`-Spalte. */
export const MAX_SERIAL_ID = 2_147_483_647;

/** Liest eine Serial-ID (1 … 2^31-1, nur Ziffern, ohne führende Null). Alles andere → `null`. */
export function parseSerialId(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1 && raw <= MAX_SERIAL_ID ? raw : null;
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_SERIAL_ID ? n : null;
}

/** Einheitliche Antwort für eine unbrauchbare ID: aus Sicht des Aufrufers gibt es das Objekt nicht. */
// Getter statt fester Text: die App-Sprache kann sich zur Laufzeit ändern (JSON.stringify liest ihn mit).
export const NOT_FOUND: { readonly error: string } = {
  get error() {
    return t("Nicht gefunden");
  },
};
