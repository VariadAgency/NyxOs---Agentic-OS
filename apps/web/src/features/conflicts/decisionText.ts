// Einfache Sprache für „Was muss ich entscheiden?“ — reine Funktionen, mit Tests.
import { t, type ConflictDecision, type ConflictGroupSummary, type ConflictSeverity, type ConflictsSummary, type DecisionSession } from "@nyxos/shared";
import { sessionLabel } from "../../lib/sessionLabel";

export function sessionLetter(index: number): string {
  return String.fromCharCode(65 + index); // A, B, C …
}

/** Dieselbe Regel wie überall (`sessionLabel`) – ohne Titel stünde sonst die rohe Kennung „claude:8dcb…“ da. */
export function sessionName(s: Pick<DecisionSession, "title" | "sessionKey"> & Partial<Pick<DecisionSession, "tool">>): string {
  return sessionLabel({ title: s.title, tool: s.tool ?? s.sessionKey.split(":")[0] ?? null });
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** „A, B und C“ — die letzten beiden mit „und“ verbunden. */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return t("{a} und {b}", { a: items.slice(0, -1).join(", "), b: items.at(-1) ?? "" });
}

function joinLetters(n: number): string {
  return joinAnd(Array.from({ length: n }, (_, i) => sessionLetter(i)));
}

/** Wer ändert was gleichzeitig — ein Satz. */
export function decisionSentence(d: ConflictDecision): string {
  const who = joinLetters(d.sessions.length);
  const one = d.fileCount === 1;
  const vars = { who, file: fileName(d.samplePaths[0] ?? ""), n: d.fileCount, folder: d.folder };
  if (d.kind === "reserved-area") {
    const label = d.reservation?.label ?? t("eine andere Arbeit");
    const single = d.sessions.length === 1;
    if (one) {
      return single
        ? t("{who} schreibt in die Datei „{file}“, obwohl der Bereich für „{label}“ reserviert ist.", { ...vars, label })
        : t("{who} schreiben in die Datei „{file}“, obwohl der Bereich für „{label}“ reserviert ist.", { ...vars, label });
    }
    return single
      ? t("{who} schreibt in {n} Dateien im Bereich „{folder}“, obwohl der Bereich für „{label}“ reserviert ist.", { ...vars, label })
      : t("{who} schreiben in {n} Dateien im Bereich „{folder}“, obwohl der Bereich für „{label}“ reserviert ist.", { ...vars, label });
  }
  return one ? t("{who} ändern gerade gleichzeitig die Datei „{file}“.", vars) : t("{who} ändern gerade gleichzeitig {n} Dateien im Bereich „{folder}“.", vars);
}

/** Was kann passieren — ein Satz. */
export function decisionRisk(d: ConflictDecision): string {
  if (d.kind === "reserved-area") return t("Was kann passieren: Die Reservierung wird unterlaufen – die Arbeit, die dort Vorrang hat, passt danach vielleicht nicht mehr.");
  return t("Was kann passieren: Eine Session überschreibt die Arbeit der anderen – am Ende fehlen Änderungen oder sie passen nicht zusammen.");
}

export const SEVERITY_LABEL: Record<ConflictSeverity, string> = { high: t("dringend"), medium: t("wichtig"), low: t("klein") };
export const SEVERITY_CLASS: Record<ConflictSeverity, string> = {
  high: "border-a-bad/50 bg-a-bad/10 text-a-bad",
  medium: "border-a-wait/50 bg-a-wait/10 text-a-wait",
  low: "border-a-done/50 bg-a-done/10 text-a-done",
};

/** Grund (vom Server) → verständlicher Satzteil. */
export function reasonText(reason: string | null): string {
  switch (reason) {
    case "busy":
      return t("arbeitet oder fragt gerade etwas – der Hinweis wurde nicht dazwischengetippt, bitte selbst Bescheid geben");
    case "not_in_nyxos":
      return t("läuft nicht in NyxOS – bitte selbst Bescheid geben");
    case "bridge_offline":
      return t("die Brücke ist gerade nicht verbunden");
    case "bridge_outdated":
      return t("die Brücke muss erst aktualisiert werden");
    case "not_running":
      return t("läuft gerade nicht");
    default:
      return t("hat nicht geklappt");
  }
}

export interface PauseAvailability {
  enabled: boolean;
  label: string;
  /** Ehrlicher Hinweis, sichtbar unter dem Knopf. */
  hint: string | null;
  sessionKeys: string[];
}

/**
 * „Beide pausieren“ geht nur bei Sessions, die in der NyxOS laufen (tmux, Esc über die Brücke).
 * Nie so tun als ob: laufen nicht alle dort, heißt der Knopf nach denen, die wirklich anhalten.
 */
export function pauseAvailability(d: ConflictDecision, bridgeOnline: boolean): PauseAvailability {
  const indexed = d.sessions.map((s, i) => ({ s, letter: sessionLetter(i) }));
  const can = indexed.filter((x) => x.s.inNyxOS);
  const cannot = indexed.filter((x) => !x.s.inNyxOS);
  const allLabel = d.sessions.length === 2 ? t("Beide pausieren") : d.sessions.length === 1 ? t("{who} pausieren", { who: sessionLetter(0) }) : t("Alle pausieren");
  if (can.length === 0) {
    return { enabled: false, label: allLabel, hint: t("Anhalten geht nur bei Sessions, die in NyxOS laufen (Terminal im Browser)."), sessionKeys: [] };
  }
  if (!bridgeOnline) return { enabled: false, label: allLabel, hint: t("Die Brücke ist gerade nicht verbunden – Anhalten geht erst wieder, wenn sie online ist."), sessionKeys: [] };
  const keys = can.map((x) => x.s.sessionKey);
  if (cannot.length === 0) return { enabled: true, label: allLabel, hint: t("Hält die laufende Arbeit an (wie Esc). Die Sessions warten dann auf dich."), sessionKeys: keys };
  const canLetters = joinAnd(can.map((x) => x.letter));
  const cannotLetters = joinAnd(cannot.map((x) => x.letter));
  return {
    enabled: true,
    label: t("{who} pausieren", { who: canLetters }),
    hint: t("Nur {can} läuft in NyxOS. {cannot} kann hier nicht angehalten werden.", { can: canLetters, cannot: cannotLetters }),
    sessionKeys: keys,
  };
}

/** Status einer schon entschiedenen Frage, kurz. */
export function decidedLabel(d: ConflictDecision): string {
  if (d.status === "ignored") return t("Ignoriert");
  if (d.status === "done") return t("Erledigt");
  if (d.status === "reserved") {
    const i = d.sessions.findIndex((s) => s.sessionKey === d.reservation?.sessionKey);
    return i >= 0 ? t("{letter} hat Vorrang", { letter: sessionLetter(i) }) : t("Bereich reserviert");
  }
  return t("Offen");
}

// ───────────── Nyx erklärt: ein Satz je Gruppe, eine Zusammenfassung über alles ─────────────

const files = (n: number) => (n === 1 ? t("1 Datei") : t("{n} Dateien", { n }));

/** „A“, „B“ und „C“ bzw. „A“, „B“, „C“ und 2 weitere (höchstens drei Namen). */
function writerNames(g: Pick<ConflictGroupSummary, "writers" | "writerCount">): string {
  const shown = g.writers.slice(0, 3).map((w) => t("„{name}“", { name: sessionName({ title: w.title, sessionKey: w.sessionKey }) }));
  const extra = Math.max(0, g.writerCount - shown.length);
  if (shown.length === 0) return t("Mehrere Sessions");
  if (extra > 0) return t("{names} und {n} weitere", { names: shown.join(", "), n: extra });
  return joinAnd(shown);
}

/** Was in einem Ordner der Kollisionskarte gerade passiert – ein einfacher Satz. */
export function groupSentence(g: ConflictGroupSummary): string {
  const names = writerNames(g);
  const many = g.writerCount > 1;
  if (g.conflictCount > 0) return t("{names} ändern hier gleichzeitig {files}.", { names, files: files(g.conflictCount) });
  if (g.sharedReadCount > 0) {
    const vars = { names, files: files(g.sharedReadCount) };
    return many ? t("{names} schreiben hier, andere Sessions lesen {files} mit – kein Streit.", vars) : t("{names} schreibt hier, andere Sessions lesen {files} mit – kein Streit.", vars);
  }
  if (g.pastCount > 0) return t("Beendete Sessions haben hier {files} gemeinsam geändert – nur noch Rückblick.", { files: files(g.pastCount) });
  const vars = { names, files: files(g.fileCount) };
  return many ? t("{names} arbeiten hier allein an {files}.", vars) : t("{names} arbeitet hier allein an {files}.", vars);
}

/** Fester Satz oben auf der Konflikte-Seite (ohne Nyx, nur aus den Daten). */
export function conflictsOverview(s: ConflictsSummary): string {
  const { openDecisions, conflicts, past } = s.totals;
  if (openDecisions === 0 && conflicts === 0) {
    const calm = t("Gerade ändern keine zwei laufenden Sessions dieselben Dateien – alles ruhig.");
    if (past === 0) return calm;
    return `${calm} ${past === 1 ? t("1 Datei ist nur noch Rückblick.") : t("{n} Dateien sind nur noch Rückblick.", { n: past })}`;
  }
  const parts: string[] = [];
  if (openDecisions > 0) parts.push(openDecisions === 1 ? t("1 Konflikt-Frage wartet auf dich.") : t("{n} Konflikt-Fragen warten auf dich.", { n: openDecisions }));
  if (conflicts > 0) {
    const top = [...s.groups].sort((a, b) => b.conflictCount - a.conflictCount)[0];
    const folder = top && top.conflictCount > 0 ? top.key : null;
    const vars = { n: conflicts, folder };
    if (conflicts === 1) {
      parts.push(folder ? t("1 Datei wird von mehreren Sessions gleichzeitig geändert, die meisten im Ordner „{folder}“.", vars) : t("1 Datei wird von mehreren Sessions gleichzeitig geändert."));
    } else {
      parts.push(folder ? t("{n} Dateien werden von mehreren Sessions gleichzeitig geändert, die meisten im Ordner „{folder}“.", vars) : t("{n} Dateien werden von mehreren Sessions gleichzeitig geändert.", vars));
    }
  }
  return parts.join(" ");
}

/** Daten für „Nyx fragen“ oben auf der Konflikte-Seite. */
export function conflictsFacts(s: ConflictsSummary): string {
  const tot = s.totals;
  const lines = [
    t("Offene Konflikt-Fragen: {n}", { n: tot.openDecisions }),
    t("Dateien mit Konflikt: {conflicts} von {files} in {groups} Ordnern", { conflicts: tot.conflicts, files: tot.files, groups: tot.groups }),
    t("Von anderen mitgelesen: {n}", { n: tot.sharedRead }),
    t("Nur Rückblick (Sessions beendet): {n}", { n: tot.past }),
    ...s.decisions
      .filter((d) => d.status === "open")
      .slice(0, 8)
      .map((d) => t("Frage ({severity}): {facts}", { severity: SEVERITY_LABEL[d.severity], facts: decisionFacts(d) })),
    ...s.groups.slice(0, 12).map((g) => `${g.key}: ${groupSentence(g)}`),
  ];
  return lines.join("\n");
}

/** Daten zu EINER Konflikt-Frage (Sessions mit Buchstaben, Dateien, Bereich). */
export function decisionFacts(d: ConflictDecision): string {
  const who = d.sessions
    .map((s, i) => (s.inNyxOS ? t("{letter} = {name} (läuft in NyxOS)", { letter: sessionLetter(i), name: sessionName(s) }) : `${sessionLetter(i)} = ${sessionName(s)}`))
    .join("; ");
  const more = d.fileCount - d.samplePaths.length;
  const paths = more > 0 ? t("{names} und {n} weitere", { names: d.samplePaths.join(", "), n: more }) : d.samplePaths.join(", ");
  const base = t("{sentence} Sessions: {who}. Dateien: {files}.", { sentence: decisionSentence(d), who, files: paths });
  return d.areaGlob ? `${base} ${t("Bereich: {area}.", { area: d.areaGlob })}` : base;
}
