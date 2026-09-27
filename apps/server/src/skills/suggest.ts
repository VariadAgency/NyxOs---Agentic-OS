// Nyx (Haiku) schreibt aus einem Signal einen kurzen Vorschlag – Problem, Beleg, Idee. Nyx ÄNDERT NIE
// einen Skill (Hermes-Kritik „Misevolution“): umgesetzt wird nur per
// sichtbarer Opus-5.5-Session nach des Nutzers Klick (skills/jobs.ts). Ist Nyx nicht erreichbar, bleibt der
// Vorschlag aus der Regel stehen (ehrlich als „Regel“ markiert).
import { SKILL_SIGNAL_LABEL, t, type SkillSignal } from "@nyxos/shared";
import { extractJson } from "../haiku/json.js";
import type { HaikuRuntime } from "../haiku/runtime.js";

export interface SuggestionInput {
  skillKey: string;
  description: string | null;
  /** Anfang der aktuellen SKILL.md (gekürzt). */
  skillText: string | null;
  signal: SkillSignal;
  evidence: string;
  /** Nutzer-Texte und Fehler nach dem Aufruf. */
  context: string[];
}

export interface SuggestionText {
  problem: string;
  evidence: string;
  idea: string;
}

/** Schreibt den Vorschlag (Nyx). `null` = gerade nicht möglich (Motor aus, Budget, Fehler). */
export type SuggestionWriter = (input: SuggestionInput) => Promise<SuggestionText | null>;

/** deutsche Schlüssel, übersetzt beim Anlegen des Vorschlags */
const RULE_PROBLEM: Record<SkillSignal, string> = {
  fehler_aufruf: "Der Skill-Aufruf ist gescheitert.",
  abbruch: "Der Nutzer hat kurz nach dem Skill abgebrochen.",
  korrektur: "Der Nutzer musste kurz nach dem Skill korrigieren.",
  fehler_danach: "Direkt nach dem Skill gab es mehrere Fehler.",
};

const RULE_IDEA: Record<SkillSignal, string> = {
  fehler_aufruf: "Prüfen, ob Name, Auslöser und Voraussetzungen im Skill stimmen, und den fehlenden Schritt ergänzen.",
  abbruch: "Den Ablauf im Skill mit der Stelle vergleichen, an der abgebrochen wurde, und den Schritt klarer beschreiben.",
  korrektur: "Die Korrektur als feste Regel in den passenden Schritt des Skills aufnehmen.",
  fehler_danach: "Die Befehle im Skill prüfen und die Stolperfalle mit Grund im passenden Schritt festhalten.",
};

/** Vorschlag allein aus der Regel (ohne Nyx). */
export function ruleSuggestion(signal: SkillSignal, evidence: string): SuggestionText {
  return { problem: t(RULE_PROBLEM[signal]), evidence, idea: t(RULE_IDEA[signal]) };
}

const SYSTEM = `Du bist Nyx, der persönliche Assistent des Nutzers. Du liest, was nach einem Skill-Aufruf in einer Claude-Session passiert ist,
und schreibst einen KURZEN Verbesserungsvorschlag für den Skill. Du änderst den Skill nie selbst.

Regeln (aus der Hermes-Lernschleife, übersetzt):
- Ein Skill ist die Anleitung, eine Art Aufgabe so, wie der Nutzer es will, richtig und schnell zu erledigen: Ablauf, Befehle, Reihenfolge, Stolperfallen.
- Schreib eine Regel, kein Protokoll: keine Daten, keine Ticketnummern, keine Nacherzählung der Session.
- Keine Umgebungs-Fehler als Regel (fehlendes Programm, fehlender Login) und keine Behauptung „Werkzeug X geht nicht“.
- Wenn nichts Sinnvolles für den Skill folgt, sag das ehrlich im Problem-Feld.

Antworte NUR mit JSON: {"problem": "…", "beleg": "…", "idee": "…"}
- problem: 1 Satz in einfacher Sprache, was am Skill hakt.
- beleg: wörtliches Zitat aus dem Verlauf (höchstens 200 Zeichen).
- idee: 1–2 Sätze, was im Skill geändert werden sollte.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Standard-Schreiber über den bestehenden Haiku-Weg (`runtime.run`, wie die Session-Prüfung). */
export function haikuSuggestionWriter(runtime: HaikuRuntime): SuggestionWriter {
  return async (input) => {
    const prompt = [
      `Skill: /${input.skillKey}${input.description ? ` – ${input.description}` : ""}`,
      `Signal: ${SKILL_SIGNAL_LABEL[input.signal]}`,
      input.skillText ? `Anfang der SKILL.md:\n${clip(input.skillText, 3000)}` : "SKILL.md: nicht verfügbar",
      `Was danach in der Session passierte (älteste zuerst):\n${input.context.slice(0, 20).join("\n") || "(keine Texte)"}`,
    ].join("\n\n");
    const res = await runtime.run({ kind: "auswertung", scope: "none", systemPrompt: SYSTEM, prompt });
    if (res.type !== "final") return null;
    const parsed = extractJson<{ problem?: unknown; beleg?: unknown; idee?: unknown }>(res.rawText);
    if (!parsed || typeof parsed.problem !== "string" || typeof parsed.idee !== "string") return null;
    return {
      problem: clip(parsed.problem.trim(), 400),
      evidence: clip(typeof parsed.beleg === "string" && parsed.beleg.trim() ? parsed.beleg.trim() : input.evidence, 300),
      idea: clip(parsed.idee.trim(), 600),
    };
  };
}
