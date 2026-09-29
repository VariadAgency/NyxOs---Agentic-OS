import { t } from "@nyxos/shared";
import type { TranscriptSubagent } from "../../lib/api";
import { useTranscript } from "../../hooks/useSessionApi";
import { Markdown } from "../../lib/markdown";

interface SubagentBlockProps {
  sessionId: string;
  subagent: TranscriptSubagent;
  expanded: boolean;
  onToggle: () => void;
}

/** Eingeklappter Sub-Agent-Block; Aufklappen lädt `?subagent=<id>` (eigener, kleiner Verlauf, nicht virtualisiert). */
export function SubagentBlock({ sessionId, subagent, expanded, onToggle }: SubagentBlockProps) {
  return (
    <div className="rounded-md border border-a-line bg-a-p2">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption text-a-mut">
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="text-a-ink">{subagent.title ? t("Sub-Agent: {title}", { title: subagent.title }) : t("Sub-Agent")}</span>
        <span className="ml-auto font-mono text-a-mut">{t(subagent.count === 1 ? "{n} Ereignis" : "{n} Ereignisse", { n: subagent.count })}</span>
      </button>
      {expanded && <SubagentTranscript sessionId={sessionId} subagentId={subagent.id} />}
    </div>
  );
}

function SubagentTranscript({ sessionId, subagentId }: { sessionId: string; subagentId: string }) {
  const transcript = useTranscript(sessionId, { subagent: subagentId });

  if (transcript.isLoading) return <div className="px-2.5 pb-2 text-label text-a-mut">{t("Lädt …")}</div>;
  if (transcript.isError) return <div className="px-2.5 pb-2 text-label text-a-bad">{t("Verlauf konnte nicht geladen werden.")}</div>;
  if (transcript.items.length === 0) return <div className="px-2.5 pb-2 text-label text-a-mut">{t("Keine Einträge.")}</div>;

  return (
    <div className="grid gap-1.5 border-t border-a-line px-2.5 py-2">
      {transcript.items.map((item) => {
        if (item.role === "tool" && item.tool) {
          return (
            <div key={item.id} className="border-l-2 border-a-line pl-2 font-mono text-label text-a-mut">
              {item.tool.name}
              {item.tool.target && ` · ${item.tool.target}`}
            </div>
          );
        }
        if (!item.text) return null;
        return (
          <div key={item.id} className="text-caption text-a-ink">
            <span className="mr-1 font-mono text-label text-a-mut">{item.role === "user" ? t("DU") : t("ASSISTENT")}</span>
            <Markdown text={item.text} />
          </div>
        );
      })}
    </div>
  );
}
