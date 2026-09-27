import { t, locale, timeZone } from "@nyxos/shared";
import { memo, useState } from "react";
import type { TranscriptItem } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Markdown } from "../../lib/markdown";
import { SubagentBlock } from "./SubagentBlock";

let dateFmt: Intl.DateTimeFormat | null = null;

function time(ts: string): string {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return "";
  dateFmt ??= new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() });
  return dateFmt.format(new Date(parsed));
}

interface ChatItemProps {
  item: TranscriptItem;
  sessionId: string;
  highlighted?: boolean;
}

/** Ein Verlaufs-Eintrag: Nutzer/Assistent als Blase, Werkzeug-Aufruf eingeklappt, Sub-Agent-Block eingeklappt. */
/** `memo`: der Chat zeichnet sich bei jedem Scroll-/Live-Wechsel neu — die Zeilen selbst nur, wenn sich ihr Eintrag ändert. */
export const ChatItem = memo(function ChatItem({ item, sessionId, highlighted }: ChatItemProps) {
  const [expanded, setExpanded] = useState(false);

  if (item.role === "tool" && item.tool) {
    const statusClass = item.tool.status === "error" ? "text-a-bad" : item.tool.status === "ok" ? "text-a-ok" : "text-a-mut";
    return (
      <div className="border-l-2 border-a-line py-1 pl-2.5 font-mono text-label text-a-mut">
        <span className="text-a-ink">{item.tool.name}</span>
        {item.tool.target && <span> · {item.tool.target}</span>}
        {item.tool.status && <span className={cn("ml-1.5", statusClass)}>{item.tool.status === "ok" ? "✓" : "✗"}</span>}
      </div>
    );
  }

  if (item.role === "subagent" && item.subagent) {
    return (
      <SubagentBlock sessionId={sessionId} subagent={item.subagent} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
    );
  }

  if (item.role === "system") {
    if (!item.internal) {
      // Inhaltliche System-Zeile (heute nur „Kontext komprimiert“) – ruhig, mittig, mit Uhrzeit.
      const at = time(item.ts);
      return (
        <div data-item-id={item.id} data-testid="chat-system-line" className="flex items-center gap-2 py-1 text-label text-a-mut">
          <span aria-hidden className="h-px flex-1 bg-a-line" />
          <span>
            {item.text}
            {at && <span> · {at}</span>}
          </span>
          <span aria-hidden className="h-px flex-1 bg-a-line" />
        </div>
      );
    }
    // Interne Plumbing-Zeilen (`internal`) landen nur hier, wenn der
    // Nutzer sie über den Knopf in ChatPanel bewusst eingeblendet hat — entsprechend dezent.
    return (
      <div className={cn("py-0.5 text-label text-a-mut", item.internal && "italic")}>{item.text}</div>
    );
  }

  const isUser = item.role === "user";
  const text = item.text ?? "";
  const long = isLongMessage(text);
  return (
    <div
      data-item-id={item.id}
      className={cn(
        "max-w-[85%] rounded-lg border px-3 py-2 text-caption",
        isUser ? "ml-auto border-a-acc/25 bg-[color-mix(in_srgb,var(--a-acc)_12%,var(--a-p2))]" : "border-a-line bg-a-p2",
        highlighted && "ring-2 ring-a-acc",
      )}
    >
      <div className="mb-1 font-mono text-label text-a-mut">
        {isUser ? t("DU") : t("ASSISTENT")} · {time(item.ts)}
      </div>
      {text ? (
        // Der VOLLE Text steht immer im DOM (nichts still gekürzt); sehr lange Nachrichten
        // sind nur optisch eingeklappt, mit Verlauf nach unten und Knopf zum Aufklappen.
        <div data-testid="chat-message-body" className={cn("relative", long && !expanded && "max-h-[22rem] overflow-hidden")}>
          <Markdown text={text} />
          {long && !expanded && <div aria-hidden="true" className={cn("pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t", isUser ? "from-[color-mix(in_srgb,var(--a-acc)_12%,var(--a-p2))]" : "from-[var(--a-p2)]")} />}
        </div>
      ) : (
        <span className="text-a-mut italic">{t("(kein Text)")}</span>
      )}
      {item.images && item.images.length > 0 && <ChatImages sessionId={sessionId} itemId={item.id} images={item.images} />}
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 inline-flex items-center gap-1 rounded text-caption font-medium text-a-acc hover:underline"
        >
          {expanded ? t("Weniger zeigen") : t("Ganze Nachricht zeigen ({n} Zeichen)", { n: charFmt().format(text.length) })}
        </button>
      )}
    </div>
  );
});

const sizeFmt = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFmt.format(Math.round(bytes / 1024))} KB`;
  return `${sizeFmt.format(bytes / (1024 * 1024))} MB`;
}

function typeLabel(mediaType: string): string {
  return (mediaType.split("/")[1] ?? t("Bild")).replace("jpeg", "jpg").toUpperCase();
}

/**
 * Vorschau der Bilder, die der Nutzer mitgeschickt hat (statt nur „[Image #1]“). Das Bild kommt
 * über den Server aus dem Archiv dieser Session (nur eigene Eingaben, nur angemeldet). Lädt es nicht
 * (abgemeldet, Archiv noch nicht da), steht ein klarer Datei-Chip mit Art und Größe da.
 */
function ChatImages({ sessionId, itemId, images }: { sessionId: string; itemId: string; images: NonNullable<TranscriptItem["images"]> }) {
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((img) => {
        const label = t("Bild {n}", { n: img.n });
        const src = `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(itemId)}/${img.n}`;
        return failed.has(img.n) ? (
          <span key={img.n} data-testid="chat-image-chip" className="inline-flex items-center gap-1.5 rounded-md border border-a-line bg-a-p px-2 py-1 font-mono text-label text-a-mut">
            {label} · {typeLabel(img.mediaType)} · {sizeLabel(img.bytes)}
          </span>
        ) : (
          <a key={img.n} href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-a-line bg-a-p hover:border-a-acc" title={t("{label} groß öffnen", { label })}>
            <img
              src={src}
              alt={t("{label} – von dir gesendet", { label })}
              loading="lazy"
              className="block max-h-40 max-w-[240px] object-contain"
              onError={() => setFailed((prev) => new Set(prev).add(img.n))}
            />
          </a>
        );
      })}
    </div>
  );
}

/** Ab hier wird eine Nachricht eingeklappt gezeigt (voller Text bleibt da). */
const LONG_CHARS = 1800;
const LONG_LINES = 28;
const charFmt = (): Intl.NumberFormat => new Intl.NumberFormat(locale());

export function isLongMessage(text: string): boolean {
  if (text.length > LONG_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > LONG_LINES) return true;
  return false;
}
