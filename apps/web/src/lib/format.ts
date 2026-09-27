// Zeit-/Text-Helfer für den Sessions-Tab. Reine Funktionen, ohne React — leicht zu testen.
import { t, locale, timeZone } from "@nyxos/shared";


/** "vor 4 Min" / "vor 2 Std" / "vor 3 T" — nie erfundene Werte, `null` bei fehlendem Zeitpunkt. */
export function relativeTime(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const diffMs = Math.max(0, now - ts);
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return t("gerade eben");
  if (minutes < 60) return t("vor {n} Min", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("vor {n} Std", { n: hours });
  const days = Math.round(hours / 24);
  return t("vor {n} T", { n: days });
}

/**
 * Kürzt einen langen Pfad für die Anzeige: der Anfang wird abgeschnitten,
 * der Dateiname bleibt immer vollständig sichtbar. Der volle Pfad gehört zusätzlich ins `title`-
 * Attribut des aufrufenden Elements — diese Funktion kürzt nur den sichtbaren Text.
 */
export function shortenPath(path: string, maxChars = 64): string {
  if (path.length <= maxChars) return path;
  const parts = path.split("/").filter((p) => p.length > 0);
  const file = parts.at(-1) ?? path;
  const ellipsis = "…/";
  if (file.length + ellipsis.length >= maxChars) {
    // Selbst der Dateiname allein ist zu lang: vom ENDE des Dateinamens her zeigen (Endung bleibt sichtbar).
    return `${ellipsis}${file.slice(-(maxChars - ellipsis.length))}`;
  }
  let result = file;
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = `${parts[i]}/${result}`;
    if (candidate.length + ellipsis.length > maxChars) break;
    result = candidate;
  }
  return `${ellipsis}${result}`;
}

/** "12 min" / "2 h 5 min" / "1 T 3 h" — Dauer zwischen zwei Zeitpunkten (ISO-Strings). */
export function duration(startIso: string | null, endIso: string | null, now: number = Date.now()): string {
  if (!startIso) return "–";
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "–";
  const end = endIso ? Date.parse(endIso) : now;
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return t("{d} T {h} h", { d: days, h: hours % 24 });
}

let dateTimeFmt: Intl.DateTimeFormat | null = null;

export function formatDateTime(iso: string | null): string {
  if (!iso) return "–";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "–";
  dateTimeFmt ??= new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timeZone() });
  return dateTimeFmt.format(new Date(ts));
}

/**
 * Letzte Aktivität als Satz — nur aus echten Daten. Ohne konkretes Ereignis bleibt es bei der
 * reinen Zeit (kein erfundener Text: "nur wenn die Daten das hergeben").
 */
export function lastActivitySentence(session: { lastActivityAt: string | null }, now: number = Date.now()): string {
  const rel = relativeTime(session.lastActivityAt, now);
  return rel ?? t("noch keine Aktivität");
}
