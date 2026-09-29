// P3 Schritt 5 · Zusatzsignal „wartet auf dich" aus dem tmux-Bildschirm (Muster wie Agent Deck, nur
// die Idee, kein Code übernommen). Nur ERGÄNZEND zu den Hooks aus P2 — der Server wertet es nur aus,
// solange der Prozess lebt (state.ts). Jede Regel hat einen Test mit einem echten Bildschirm-Abzug
// (apps/bridge/test/fixtures/screens/).

export interface WaitRule {
  id: string;
  tool: "claude" | "codex" | "any";
  /** Muss im unteren Bildschirmteil stehen (dort, wo die Frage gerade offen ist). */
  re: RegExp;
}

export const WAIT_RULES: WaitRule[] = [
  // Claude Code: Freigabe-Dialoge („Do you want to proceed?", „Do you want to make this edit to …?",
  // „Do you want to create …?") mit nummerierter Auswahl „❯ 1. Yes".
  { id: "claude-permission", tool: "claude", re: /Do you want to (proceed|make this edit|create|allow|run)[^\n]*\?/ },
  { id: "claude-choice", tool: "claude", re: /^\s*❯\s*1\.\s+Yes\b/m },
  // Codex: bewusst noch keine Regel — es gibt keinen echten Bildschirm-Abzug. Für Codex gilt bis dahin nur
  // Stop/task_complete aus den Hooks.
];

/** Wie viele Zeilen vom unteren Rand geprüft werden (alte Fragen weiter oben zählen nicht). */
const TAIL_LINES = 25;

export function screenWaiting(tool: "claude" | "codex", screen: string): { waiting: boolean; rule: string | null } {
  const lines = screen.replace(/\s+$/, "").split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  for (const r of WAIT_RULES) {
    if (r.tool !== "any" && r.tool !== tool) continue;
    if (r.re.test(tail)) return { waiting: true, rule: r.id };
  }
  return { waiting: false, rule: null };
}
