// Shape of a settings area. The register lives in `sections.tsx`; search (`searchIndex.ts`) and the redirect of
// old links (`legacy.ts`) only work with these fields (no components) and so stay easy to test.
import type { AppMode } from "@nyxos/shared";
import type { ComponentType } from "react";
import type { Tone } from "../../lib/tones";

/** Short state on the right of an overview row („Angemeldet“, „3 Wege an“, „aus“). */
export interface SectionStatus {
  text: string;
  tone?: "ok" | "wait" | "bad" | "mut";
}

/** A block on a subpage. `id` is also the anchor (`/settings/<area>#<id>`). */
export interface SettingsPanelDef {
  id: string;
  /** Name of the block – search hit and heading of „Erweitert“ blocks. */
  title: string;
  /** Single settings in this block (the search jumps exactly here with them). */
  keywords?: readonly string[];
  /**
   * Spots INSIDE the block – a keyword here jumps exactly there (element id `anchor`; collapsed „Erweitert“ blocks
   * open on the way). For long blocks like „Mitteilungen“ (quiet hours sit further down).
   */
  spots?: readonly { anchor: string; keywords: readonly string[] }[];
  Component: ComponentType;
  /** Rarely needed: collapsed behind „Erweitert“ (the browser remembers the state). */
  advanced?: boolean;
}

/** What changes for an area in local mode (NyxOS on this computer only): other texts, other blocks. */
export type SettingsSectionOverride = Partial<Pick<SettingsSection, "summary" | "lead" | "keywords" | "panels">>;

export interface SettingsSection {
  id: string;
  /** Own subpage (`/settings/<id>` or `/einstellungen/nyx/<id>`) – or, with `href`, the target of the row. */
  path: string;
  title: string;
  /** Symbol in the style of the sidebar (one character) and its fixed colour. */
  icon: string;
  tone: Tone;
  /** One line in the overview. */
  summary: string;
  /** One sentence of explanation at the top of the subpage. */
  lead: string;
  /** Group in the overview (see `SettingsGroup.id`). */
  group: string;
  /** Search words for the whole area. */
  keywords: readonly string[];
  panels: readonly SettingsPanelDef[];
  /** More old anchors that belong here (e.g. `nyx` → Begleiter). Panel ids count automatically. */
  anchors?: readonly string[];
  /** Old paths that redirect here (e.g. `/einstellungen/haiku`). */
  aliases?: readonly string[];
  /** The row leads to another page instead of an own subpage (Allgemein → Nyx, → Info & Hilfe). */
  href?: string;
  /**
   * Subpage of another area (its id): no own row in the overview, linked from the parent instead (Telegram under
   * Mitteilungen, Verbindungen under Betrieb & Zugriff). „‹ <parent>“ leads back. Search, ⌘K and old anchors find it
   * like any area.
   */
  parent?: string;
  /**
   * Old anchors on the parent's page that lead here today (`/settings/mitteilungen#nyx` → „Nyx prüft & schreibt“).
   * Only there – `/settings#nyx` stays with the companion.
   */
  parentAnchors?: readonly string[];
  /** Small state for the overview – only from existing queries, `null` = show nothing. */
  useStatus?: () => SectionStatus | null;
  /** Only in these run modes (default: all) – for areas that exist only on a server (or only locally). */
  modes?: readonly AppMode[];
  /** Other texts/blocks in local mode (applied by `sectionsForMode`). */
  local?: SettingsSectionOverride;
}

export interface SettingsGroup {
  id: string;
  title: string;
}
