// EINE Gruß-Regel für Überblick, Briefing-Kopf, Server-Bericht und Vorlesen. Vorher hatte jede Stelle
// ihre eigene (um 01:24 stand oben „Guten Abend“, gesprochen wurde „Guten Morgen“). Immer in der Zeitzone
// des Nutzers (`timeZone()`), egal ob Browser oder Server rechnet.
import { t, timeZone } from "./i18n/index.js";

export type GreetingPeriod = "morning" | "day" | "evening" | "night";

/** Stunde 0–23 in der Zeitzone des Nutzers (Formatierer je Aufruf: die Zeitzone kann sich ändern). */
function localHourOf(now: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timeZone(), hour: "2-digit", hour12: false });
  const h = Number(fmt.formatToParts(now).find((p) => p.type === "hour")?.value ?? 0);
  return h === 24 ? 0 : h;
}

/** 5–11 Morgen, 11–18 Tag, 18–22 Abend, 22–5 Nacht (Zeitzone des Nutzers). */
export function greetingPeriod(now: Date): GreetingPeriod {
  const h = localHourOf(now);
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 18) return "day";
  if (h >= 18 && h < 22) return "evening";
  return "night";
}

/** Rückfall, solange kein Name aus dem Nyx-Profil bzw. den App-Einstellungen da ist: leer = Gruß ohne Namen. */
export const DEFAULT_GREETING_NAME = "";

/**
 * Der ganze Gruß, z. B. „Guten Morgen, Alex“; nachts „Noch wach, Alex?“. `name` kommt aus dem Nyx-Profil
 * bzw. den App-Einstellungen (Server: `greetingNameOf`, Überblick: `greetingName`); ohne Namen „Guten Morgen“.
 */
export function greetingLine(now: Date, name?: string | null): string {
  name = name?.trim() || DEFAULT_GREETING_NAME;
  if (!name) {
    switch (greetingPeriod(now)) {
      case "morning":
        return t("Guten Morgen");
      case "day":
        return t("Guten Tag");
      case "evening":
        return t("Guten Abend");
      default:
        return t("Noch wach?");
    }
  }
  switch (greetingPeriod(now)) {
    case "morning":
      return t("Guten Morgen, {name}", { name });
    case "day":
      return t("Guten Tag, {name}", { name });
    case "evening":
      return t("Guten Abend, {name}", { name });
    default:
      return t("Noch wach, {name}?", { name });
  }
}
