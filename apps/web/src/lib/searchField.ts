import { t } from "@nyxos/shared";
import type { SearchHit } from "./api";

/** Anzeigename je Treffer-Feld — gemeinsam für `SearchBox` (ART-Zeile) und `CommandPalette` (⌘K),
 * damit beide Suchoberflächen dieselbe Beschriftung zeigen. */
export const SEARCH_FIELD_LABEL: Record<SearchHit["field"], string> = {
  title: t("Titel"),
  prompt: t("erster Prompt"),
  file: t("Datei"),
  chat: t("Chat"),
};
