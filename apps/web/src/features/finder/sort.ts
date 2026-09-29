// Sortieren wie im Finder (Name/Datum/Größe/Art), Ordner immer oben. Reine Funktionen.
import { FINDER_KIND_LABEL, getLang, locale, t, timeZone, type FinderEntry } from "@nyxos/shared";

export type SortBy = "name" | "date" | "size" | "kind";
export interface SortSpec {
  by: SortBy;
  dir: "asc" | "desc";
}

export const SORT_LABEL: Record<SortBy, string> = { name: t("Name"), date: t("Änderungsdatum"), size: t("Größe"), kind: t("Art") };

const collator = new Intl.Collator(getLang(), { numeric: true, sensitivity: "base" });

function compare(a: FinderEntry, b: FinderEntry, by: SortBy): number {
  switch (by) {
    case "date":
      return a.mtimeMs - b.mtimeMs;
    case "size":
      return a.size - b.size;
    case "kind":
      return collator.compare(t(FINDER_KIND_LABEL[a.kind]), t(FINDER_KIND_LABEL[b.kind]));
    case "name":
      return 0;
  }
}

export function sortEntries(entries: FinderEntry[], spec: SortSpec): FinderEntry[] {
  const sign = spec.dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const primary = compare(a, b, spec.by) * sign;
    if (primary !== 0) return primary;
    // Gleichstand (und Sortierung „Name“): nach Name, bei „Name ab“ umgekehrt.
    return collator.compare(a.name, b.name) * (spec.by === "name" ? sign : 1);
  });
}

const sizeFmt = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });

/** „1,2 MB“ wie im Finder (Dezimal-Einheiten). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return t("{n} Byte", { n: bytes });
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${sizeFmt.format(v)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timeZone() });
const timeFmt = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() });
/** Kalendertag in der eingestellten Zeitzone („2026-09-21“) — für „Heute“/„Gestern“. */
const dayFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timeZone() });

/** „Heute, 14:05“ / „Gestern, 09:12“ / „21.09.2026, 10:00“ wie im Finder. */
export function formatDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const day = dayFmt.format(d);
  if (day === dayFmt.format(now)) return t("Heute, {time}", { time: timeFmt.format(d) });
  if (day === dayFmt.format(now - 86_400_000)) return t("Gestern, {time}", { time: timeFmt.format(d) });
  return dateFmt.format(d);
}
