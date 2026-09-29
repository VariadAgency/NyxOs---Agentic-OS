// Prompt verbessern: Aufruf an den Server (Sonnet 5 · Reasoning hoch) und der Entwurf je Session im
// Browser-Speicher (localStorage, jede Stelle in try/catch – privates Fenster o. Ä. darf nichts kaputt machen).
import { t, type PromptAssistAnswer, type PromptAssistRequest, type PromptAssistResult } from "@nyxos/shared";
import { useMutation } from "@tanstack/react-query";
import { authFetch } from "../terminal/authClient";

export function usePromptAssist(sessionId: string) {
  return useMutation({
    mutationFn: async (body: PromptAssistRequest): Promise<PromptAssistResult> => {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt-assist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = ((await res.json()) as { error?: string }).error ?? "";
        } catch {
          // kein JSON
        }
        throw new Error(detail || t("Sonnet konnte den Prompt gerade nicht verbessern. Bitte noch einmal versuchen."));
      }
      return (await res.json()) as PromptAssistResult;
    },
  });
}

/** Was je Session gemerkt wird: Entwurf, Ergänzungen, Antworten, Versionen, aktuelle Version. */
export interface PromptAssistState {
  entwurf: string;
  zusaetze: string[];
  antworten: PromptAssistAnswer[];
  versions: PromptAssistResult[];
  current: number;
}

const PREFIX = "nyx.prompt-assist.";
const OPEN_KEY = "nyx.prompt-assist.open";
const VERSIONS_KEEP = 12;

export const EMPTY_STATE: PromptAssistState = {
  entwurf: "",
  zusaetze: [],
  antworten: [],
  versions: [],
  current: -1,
};

export function loadAssistState(sessionId: string): PromptAssistState {
  try {
    const raw = localStorage.getItem(PREFIX + sessionId);
    if (!raw) return EMPTY_STATE;
    const s = JSON.parse(raw) as Partial<PromptAssistState>;
    const versions = Array.isArray(s.versions) ? s.versions.filter((v) => v && typeof v.prompt === "string") : [];
    const current = typeof s.current === "number" && s.current >= 0 && s.current < versions.length ? s.current : versions.length - 1;
    return {
      entwurf: typeof s.entwurf === "string" ? s.entwurf : "",
      zusaetze: Array.isArray(s.zusaetze) ? s.zusaetze.filter((z): z is string => typeof z === "string") : [],
      antworten: Array.isArray(s.antworten) ? s.antworten.filter((a) => a && typeof a.frage === "string") : [],
      versions,
      current,
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveAssistState(sessionId: string, state: PromptAssistState): void {
  try {
    const versions = state.versions.slice(-VERSIONS_KEEP);
    const current = Math.min(state.current - (state.versions.length - versions.length), versions.length - 1);
    if (!state.entwurf && versions.length === 0) localStorage.removeItem(PREFIX + sessionId);
    else localStorage.setItem(PREFIX + sessionId, JSON.stringify({ ...state, versions, current }));
  } catch {
    // Speicher voll oder gesperrt – dann eben nur für diese Sitzung.
  }
}

export function loadAssistOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAssistOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // egal
  }
}

/** Auswahl + Freitext je Frage → Antworten für den Server (leere Fragen fallen weg). */
export function collectAnswers(questions: PromptAssistResult["fragen"], picks: Record<string, string[]>, texts: Record<string, string>): PromptAssistAnswer[] {
  const out: PromptAssistAnswer[] = [];
  for (const q of questions) {
    const auswahl = picks[q.id] ?? [];
    const text = (texts[q.id] ?? "").trim();
    if (auswahl.length === 0 && !text) continue;
    out.push({
      frage: q.frage,
      ...(auswahl.length ? { auswahl } : {}),
      ...(text ? { text } : {}),
    });
  }
  return out;
}
