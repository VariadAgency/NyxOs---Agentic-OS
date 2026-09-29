// Ideen sind normale NyxOS-Einträge (kind „idee“) mit eigenem Verlauf: Eingang → In Klärung → Konzept
// fertig → „In Aufgaben übernehmen“. Hier: Stufen-Reihenfolge, Sortierung und der Markdown-Export.
import type { Entry, EntryStage } from "@nyxos/shared";
import { IDEA_STAGES, locale, t } from "@nyxos/shared";
import { PRIORITY_LABELS, STAGE_META } from "../entries/meta";

export type IdeaStage = (typeof IDEA_STAGES)[number];

/** Anzeige-Reihenfolge: was fast fertig ist, steht oben. */
export const IDEA_STAGE_ORDER: IdeaStage[] = ["konzept_fertig", "in_klaerung", "eingang"];

export function isIdeaStage(stage: EntryStage | string | null | undefined): stage is IdeaStage {
  return (IDEA_STAGES as readonly string[]).includes(stage ?? "");
}

/** Beschriftung der Stufe (unbekannte Stufen zeigen ihren Namen statt die Ansicht zu sprengen). */
export function stageLabel(stage: string | null | undefined): string {
  return (stage && STAGE_META[stage as EntryStage]?.label) || stage || t("Eingang");
}

const PRIO_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const prioRank = (e: Pick<Entry, "priority">) => (e.priority ? (PRIO_RANK[e.priority] ?? 4) : 4);
const stageRank = (e: Pick<Entry, "stage">) => {
  const i = IDEA_STAGE_ORDER.indexOf(e.stage as IdeaStage);
  return i === -1 ? IDEA_STAGE_ORDER.length : i;
};
const updatedMs = (e: Pick<Entry, "updatedAt">) => Date.parse(e.updatedAt ?? "") || 0;

export type IdeaSort = "pipeline" | "updated";

/** „Nach Stand“: Konzept fertig zuerst, dann Priorität, dann zuletzt geändert. „Neueste zuerst“: nur Datum. */
export function sortIdeas(ideas: Entry[], sort: IdeaSort): Entry[] {
  const list = [...ideas];
  if (sort === "updated") return list.sort((a, b) => updatedMs(b) - updatedMs(a));
  return list.sort((a, b) => stageRank(a) - stageRank(b) || prioRank(a) - prioRank(b) || updatedMs(b) - updatedMs(a));
}

/** Eine Idee als Markdown („Als Markdown kopieren“). */
export function ideaMarkdown(idea: Entry): string {
  return [
    `# ${idea.title ?? ""}`,
    "",
    `| ${t("Feld")} | ${t("Wert")} |`,
    "|---|---|",
    `| ${t("Stufe")} | ${stageLabel(idea.stage)} |`,
    `| ${t("Priorität")} | ${idea.priority ? PRIORITY_LABELS[idea.priority] : "–"} |`,
    `| ${t("Baustelle")} | ${idea.baustelle?.label ?? "–"} |`,
    "",
    (idea.description ?? "").trim() || t("Kein Text – nur der Titel."),
  ].join("\n");
}

export function ideasMarkdown(ideas: Entry[]): string {
  const sorted = [...ideas].sort((a, b) => stageRank(a) - stageRank(b) || (a.title ?? "").localeCompare(b.title ?? "", locale()));
  return [`# ${t("Ideen – Export")}`, "", ...sorted.flatMap((i) => [ideaMarkdown(i), "", "---", ""])].join("\n");
}

/** Aus dem Freitext des Eingabefelds: erste Zeile = Titel (max. 200 Zeichen), der Rest = Beschreibung. */
export function splitIdeaText(text: string): { title: string; description?: string } {
  const trimmed = text.trim();
  const [first = "", ...rest] = trimmed.split("\n");
  const line = first.trim();
  if (line.length > 200) return { title: `${line.slice(0, 199).trimEnd()}…`, description: trimmed };
  const description = rest.join("\n").trim();
  return description ? { title: line, description } : { title: line };
}
