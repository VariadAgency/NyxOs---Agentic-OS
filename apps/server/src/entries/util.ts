/** `noUncheckedIndexedAccess` markiert `rows[0]` immer als `T | undefined` — nach einem eigenen
 * Insert/Update/Select auf die gerade geschriebene ID ist die Zeile aber eine Invariante, kein
 * echter Fehlerfall. Ein Wurf hier wäre ein Programmierfehler (falsche ID), nie ein Nutzer-Eingabefehler. */
export function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Erwartete Zeile fehlt (Programmierfehler)");
  return row;
}
