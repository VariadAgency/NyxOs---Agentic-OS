// Model ids ("claude-haiku-4-5-20251001") are jargon. The interface shows the readable name ("Haiku 4.5"), the exact
// id only in the tooltip or as a small addition.
import { catalogModel, t } from "@nyxos/shared";
import { modelLabel } from "../features/session-chat/model";
import { cn } from "./cn";

/** "claude-opus-5-5" → "Opus 5.5", "haiku" → "Haiku 4.5", "gpt-5.6-terra" → "GPT-5.6 Terra"; unknown ids stay. */
export function readableModel(id: string): string {
  const raw = id.trim();
  if (!raw) return raw;
  const short = modelLabel(raw);
  if (short !== raw) return short;
  const known = catalogModel(raw) ?? catalogModel(raw.split("/").pop() ?? "");
  if (known) return known.name.replace(/^Claude\s+/, "");
  return raw;
}

/** Jargon in model additions, replaced by plain words (German source text and its translation). */
function plain(part: string): string {
  return part === "Reasoning hoch" || part === t("Reasoning hoch") ? t("denkt gründlich") : part;
}

/**
 * Display of an active model assignment from the server text ("Claude Haiku 4.5 · claude-haiku-4-5-20251001 (Standard,
 * Claude-Programm)", "Claude Sonnet 5 · claude-sonnet-5 · Reasoning hoch (…)", "<name> · <id> · <provider>"):
 * readable name + additions without the id, the part in brackets separately.
 */
export function splitModelLabel(label: string, model: string): { name: string; extras: string[]; note: string | null } {
  const suffix = /\s*\(([^)]*)\)\s*$/.exec(label);
  const core = suffix ? label.slice(0, suffix.index) : label;
  const id = model.trim().toLowerCase();
  const entry = catalogModel(model);
  // Dropped: the id itself, the catalog name and the exact id of the same model ("haiku" → "claude-haiku-4-5-…").
  const same = (p: string) => p.toLowerCase() === id || (entry !== null && (p === entry.name || catalogModel(p)?.id === entry.id));
  const extras = core
    .split(" · ")
    .map((p) => p.trim())
    .filter((p) => p && !same(p))
    .map(plain);
  return { name: readableModel(model), extras, note: suffix?.[1] ?? null };
}

/** Readable model name, id in the tooltip (and optionally small next to it). */
export function ModelName({ id, showId = false, className }: { id: string; showId?: boolean; className?: string }) {
  const name = readableModel(id);
  return (
    <span className={cn("min-w-0", className)} title={name !== id ? id : undefined}>
      {name}
      {showId && name !== id && <span className="ml-1.5 font-mono text-label text-a-mut">{id}</span>}
    </span>
  );
}
