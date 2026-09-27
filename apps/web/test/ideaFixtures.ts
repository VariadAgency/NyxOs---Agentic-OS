// Beispiel-Idee (Eintrag mit kind „idee“) für die Tests des Ideen-Tabs.
import type { Entry } from "@nyxos/shared";

export function ideaEntry(over: Partial<Entry>): Entry {
  return {
    id: 41,
    kind: "idee",
    title: "Feed-Filter",
    description: "Nach Kategorie filtern.",
    stage: "eingang",
    priority: null,
    baustelle: null,
    progressPercent: 0,
    progressDoneWeight: 0,
    progressTotalWeight: 0,
    maturity: null,
    maturityCheckedAt: null,
    sourceType: null,
    sourceId: null,
    sourceRemovedAt: null,
    fileScope: [],
    modelSuggestion: null,
    estimate: null,
    worktreePath: null,
    gitBranch: null,
    tmuxName: null,
    startedSessionKey: null,
    createdAt: "2026-09-25T07:00:00.000Z",
    updatedAt: "2026-09-25T08:00:00.000Z",
    ...over,
  };
}
