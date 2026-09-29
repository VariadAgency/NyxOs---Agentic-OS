// Old links stay valid. Formerly everything hung on ONE page (`/settings#push`, `#verbindungen`,
// `#zugaenge-einrichten`, `/einstellungen/nyx#stimme`) or on own paths (`/einstellungen/haiku`,
// `/einstellungen/ideen-links`). This function says which subpage (and which spot) they lead to today.
import type { SettingsSection } from "./types";

/** The two overviews old anchors can hang on. */
const OVERVIEW_PATHS = new Set(["/settings", "/einstellungen/nyx"]);

/**
 * Neues Ziel für einen alten Link oder `null`, wenn nichts umzuleiten ist.
 * - Pfad-Alias (`/einstellungen/haiku`) → Unterseite des Bereichs (ein Anker bleibt dran).
 * - Anker auf einer Übersicht: gleich der Bereichs-id → Unterseite; gleich einem Abschnitt (auch `zugaenge-einrichten`
 *   für den Abschnitt `zugaenge`) → Unterseite + Anker; sonst die `anchors` des Bereichs → Unterseite.
 */
export function resolveLegacySettingsPath(pathname: string, hash: string, sections: readonly SettingsSection[]): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const anchor = hash.replace(/^#/, "");
  const own = sections.filter((s) => !s.href);

  const aliased = own.find((s) => s.aliases?.includes(path));
  if (aliased) return anchor ? `${aliased.path}#${anchor}` : aliased.path;

  if (!anchor || !OVERVIEW_PATHS.has(path)) return null;
  const bySection = own.find((s) => s.id === anchor);
  if (bySection) return bySection.path;
  for (const s of own) {
    if (s.panels.some((p) => anchor === p.id || anchor.startsWith(`${p.id}-`))) return `${s.path}#${anchor}`;
  }
  const byAnchor = own.find((s) => s.anchors?.includes(anchor));
  return byAnchor ? byAnchor.path : null;
}
