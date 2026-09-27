// EINE Schreibweise für Token-Mengen in Web und Server (Briefing, Warnungen, Kacheln).
// Vorher formatierten Agenten-Reiter („3.874,2 Mio.“), Haiku-Einstellungen („12,3 Mio“) und Server-Texte
// jeweils selbst — dieselbe Zahl hieß an einer Stelle „3,9 Mrd.“, an der anderen „3.874,2 Mio.“.

import { locale, timeZone } from "./i18n/index.js";

// Formatierer je Sprache/Zeitzone zwischengespeichert: beides kann sich zur Laufzeit ändern (Einstellungen),
// darum nie als feste Konstante beim Laden des Moduls anlegen.
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

/** Datums-/Zeit-Formatierer in der Sprache (`locale()`) und Zeitzone (`timeZone()`) des Nutzers.
 * `loc` überschreibt die Sprache (z. B. „en-CA“ für ISO-Tage `YYYY-MM-DD`). */
export function dateTimeFormat(opts: Intl.DateTimeFormatOptions, loc: string = locale()): Intl.DateTimeFormat {
  const full: Intl.DateTimeFormatOptions = { timeZone: timeZone(), ...opts };
  const key = `${loc}|${JSON.stringify(full)}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, full);
    dateFormats.set(key, f);
  }
  return f;
}

/** Zahlen-Formatierer in der Sprache des Nutzers. */
export function numberFormat(opts: Intl.NumberFormatOptions = {}, loc: string = locale()): Intl.NumberFormat {
  const key = `${loc}|${JSON.stringify(opts)}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(loc, opts);
    numberFormats.set(key, f);
  }
  return f;
}

/** Kalendertag `YYYY-MM-DD` in der Zeitzone des Nutzers. */
export function localDayOf(d: Date): string {
  return dateTimeFormat({ year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").format(d);
}

/** einheitlich — unter einer Million die ganze Zahl mit Tausenderpunkt („1.234“),
 * ab einer Million „Mio.“/„Mrd.“/„Bio.“ mit höchstens einer Nachkommastelle („3,9 Mrd.“). */
export function formatTokensCompact(n: number): string {
  return Math.abs(n) >= 1_000_000 ? numberFormat({ notation: "compact", maximumFractionDigits: 1 }).format(n) : numberFormat().format(Math.round(n));
}
