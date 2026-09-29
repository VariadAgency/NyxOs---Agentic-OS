// Das AKTUELLE Modell einer Session. `models` ist nach erstem Auftreten geordnet (der erste
// Eintrag ist das Start-Modell, nicht das jetzige) — maßgeblich ist das Modell der zuletzt gesehenen
// Antwort (`lastUsageModel`), sonst das zuletzt neu aufgetauchte.
import type { Session } from "../../lib/api";

export function currentModel(session: Pick<Session, "models" | "lastUsageModel">): string | null {
  return session.lastUsageModel ?? session.models.at(-1) ?? null;
}

/** Für schmale Anzeigen: „claude-opus-5-5“ → „opus-5-5“, „claude-haiku-4-5-20251001“ → „haiku-4-5“. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// Jede Claude-Familie („fable“, künftige Namen), nicht nur opus/sonnet/haiku — echte DB-Namen wie
// „claude-fable-5-1“ blieben sonst roh stehen. Ohne „claude-“ nur die bekannten Familien („opus-5-5“ aus
// haiku_calls), damit fremde Namen („mistral-large-2“) nicht falsch geraten werden.
const CLAUDE_MODEL = /^claude-(?:([a-z]+)-(\d+(?:-\d{1,2})?)|(\d+(?:-\d{1,2})?)-([a-z]+))(?:-\d{8})?$/i;
const BARE_CLAUDE_MODEL = /^(opus|sonnet|haiku|fable)-(\d+(?:-\d{1,2})?)(?:-\d{8})?$/i;
const GPT_MODEL = /^gpt-([\d.]+)(?:-(.+))?$/i;

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/**
 * Modell-Name für Menschen — „claude-opus-5-5“ → „Opus 5.5“, „claude-3-5-sonnet-20241022“ →
 * „Sonnet 3.5“, „claude-opus-4-6[1m]“ → „Opus 4.6 · 1M“, „gpt-5.6-terra“ → „GPT-5.6 Terra“. Unbekanntes bleibt,
 * wie es ist. Der volle Name gehört zusätzlich in den Tooltip.
 */
export function modelLabel(model: string): string {
  const oneM = /\[1m\]$/i.test(model);
  const raw = model.replace(/\[1m\]$/i, "").trim();
  const suffix = oneM ? " · 1M" : "";
  const claude = CLAUDE_MODEL.exec(raw);
  const bare = claude ? null : BARE_CLAUDE_MODEL.exec(raw);
  if (claude || bare) {
    const family = claude ? (claude[1] ?? claude[4] ?? "") : (bare?.[1] ?? "");
    const version = (claude ? (claude[2] ?? claude[3] ?? "") : (bare?.[2] ?? "")).replace("-", ".");
    return `${capitalize(family)} ${version}${suffix}`;
  }
  const gpt = GPT_MODEL.exec(raw);
  if (gpt) {
    const rest = (gpt[2] ?? "")
      .split("-")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return `GPT-${gpt[1]}${rest ? ` ${rest}` : ""}${suffix}`;
  }
  return `${raw}${suffix}`;
}

/** Arbeitsordner mit dem letzten Ordnernamen vorn — „/home/…/projects/NyxOS“ → „…/NyxOS“. */
export function folderLabel(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const last = parts.at(-1);
  if (!last) return cwd || "/";
  return parts.length > 1 || cwd.startsWith("/") ? `…/${last}` : last;
}
