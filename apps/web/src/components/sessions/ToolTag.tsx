import { cn } from "../../lib/cn";

/** Werkzeug-Kennung: getönte Pille in der Anbieter-Farbe (Claude Orange, Codex Hellblau) statt harter Rand. */
export function ToolTag({ tool }: { tool: "claude" | "codex" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md px-1.5 py-px text-label font-medium",
        tool === "codex" ? "bg-a-codex/12 text-a-codex" : "bg-a-claude/12 text-a-claude",
      )}
    >
      {tool === "claude" ? "Claude" : "Codex"}
    </span>
  );
}
