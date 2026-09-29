// Reiter „Chat“: der ganze Verlauf (gesprochen + getippt), je Antwort was sie gekostet hat und welche
// Werkzeuge Nyx benutzt hat, „unterbrochen“ sichtbar. Unten die Eingabe mit den Anhängen aus „Dateien & Links“.
import { ReadAloudMessageButton } from "../../../../components/nyx/ReadAloudMessageButton";
import { locale, nyxToolDoing, nyxToolName, t, type NyxFile } from "@nyxos/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { NyxAura } from "../../../../components/brand/NyxAura";
import { cn } from "../../../../lib/cn";
import { Markdown } from "../../../../lib/markdown";
import { AnswerLengthPicker } from "../../../haiku/AnswerLengthPicker";
import { EstimateTag, FIELD, formatUsd, SourceChips } from "../../../haiku/ui";
import { DemoQuestions } from "../../../demo/DemoQuestions";
import { NyxThoughts } from "../../NyxThoughts";
import type { ConvMessage, NyxConversation } from "../useNyxConversation";

export interface PendingGift {
  key: string;
  kind: "file" | "link";
  /** Datei in der Nyx-Ablage (bei kind "file"). */
  file?: NyxFile;
  url?: string;
  /** Anfang einer Textdatei, damit Nyx den Inhalt gleich mitliest. */
  excerpt?: string;
}

/** Nachricht an Nyx inklusive Anhängen — höchstens 4000 Zeichen (Server-Grenze). */
export function composeMessage(text: string, gifts: readonly PendingGift[]): string {
  if (gifts.length === 0) return text;
  const lines = gifts.map((g) => {
    if (g.kind === "link") return `- ${t("Link: {url}", { url: g.url })}`;
    const f = g.file as NyxFile;
    const vars = { name: f.name, mime: f.mime, kb: Math.max(1, Math.round(f.size / 1024)), url: f.url };
    const head = `- ${f.kind === "image" ? t("Bild „{name}“ ({mime}, {kb} KB): {url}", vars) : t("Datei „{name}“ ({mime}, {kb} KB): {url}", vars)}`;
    return g.excerpt ? `${head}\n  ${t("Inhalt (Anfang):")}\n  ${g.excerpt.replace(/\n/g, "\n  ")}` : head;
  });
  const body = `${text.trim() || t("Schau dir bitte diese Anhänge an.")}\n\n${t("Anhänge:")}\n${lines.join("\n")}`;
  return body.length > 4000 ? `${body.slice(0, 3990)}\n…` : body;
}

function usageLine(m: ConvMessage): string | null {
  const parts: string[] = [];
  if (m.usage) {
    parts.push(formatUsd(m.usage.costUsd));
    parts.push(`${(m.usage.durationMs / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 })} s`);
    parts.push(t("{n} Tokens", { n: (m.usage.inputTokens + m.usage.outputTokens).toLocaleString(locale()) }));
  }
  if (m.tools.length) parts.push(m.tools.length === 1 ? t("1 Werkzeug") : t("{n} Werkzeuge", { n: m.tools.length }));
  return parts.length ? parts.join(" · ") : null;
}

function Bubble({ m }: { m: ConvMessage }) {
  if (m.role === "user") {
    return (
      <div className="cc-rise grid max-w-[92%] justify-self-end gap-1">
        <div className="whitespace-pre-wrap break-words rounded-[10px] border border-a-acc/35 bg-a-acc/10 px-3 py-2 text-callout text-a-ink [overflow-wrap:anywhere]">{m.text}</div>
        <div className="justify-self-end font-mono text-label text-a-mut">
          {m.channel === "voice" ? t("gesprochen") : t("getippt")}
          {m.attachments?.length ? ` · ${m.attachments.length === 1 ? t("1 Anhang") : t("{n} Anhänge", { n: m.attachments.length })}` : ""}
        </div>
      </div>
    );
  }
  const usage = usageLine(m);
  return (
    <div className="cc-rise grid min-w-0 max-w-[96%] gap-1.5 rounded-[10px] border border-a-line bg-a-p2 px-3 py-2 text-callout text-a-ink" aria-busy={m.streaming ? true : undefined}>
      <NyxThoughts thoughts={m.thoughts} />
      {m.text ? (
        <div className="min-w-0 break-words leading-relaxed [overflow-wrap:anywhere]">
          <Markdown text={m.text} sources={m.sources} />
        </div>
      ) : m.streaming ? (
        // Statt drei Pünktchen denkt das Nyx-Logo sichtbar mit.
        <span className="inline-flex items-center gap-2 py-1 text-caption text-a-mut" role="status" aria-label={t("Nyx denkt")}>
          <NyxAura size={18} state="thinking" />
          <span aria-hidden="true">{t("denkt nach …")}</span>
        </span>
      ) : null}
      {m.error && (
        <div role="alert" className="text-caption text-a-bad">
          {m.error}
        </div>
      )}
      {(m.interrupted || m.estimate || m.tools.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {m.interrupted && (
            <span className="rounded border border-a-wait/40 bg-a-wait/10 px-1.5 py-px font-mono text-label text-a-wait" title={t("Du hast Nyx unterbrochen – gespeichert ist nur, was du gehört hast.")}>
              {t("unterbrochen")}
            </span>
          )}
          {m.estimate && <EstimateTag />}
          {m.tools.map((tool, i) => (
            <span key={`${tool}-${i}`} className="rounded-full border border-a-claude/40 bg-a-claude/10 px-2 py-px text-label text-a-claude" title={`Nyx ${nyxToolDoing(tool)}`}>
              {nyxToolName(tool)}
            </span>
          ))}
        </div>
      )}
      <SourceChips sources={m.sources} />
      {(usage || (!m.streaming && m.text.trim())) && (
        <div className="flex flex-wrap items-center gap-2">
          {!m.streaming && m.text.trim() && <ReadAloudMessageButton text={m.text} />}
          {usage && <span className="font-mono text-label text-a-mut">{usage}</span>}
        </div>
      )}
    </div>
  );
}

export function ChatPanel({
  conversation,
  gifts,
  onClearGifts,
  onSent,
}: {
  conversation: NyxConversation;
  gifts: PendingGift[];
  onClearGifts: () => void;
  /** Getippte Frage abgeschickt (für „auch getippte Antworten vorlesen“). */
  onSent: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const { messages, busy, loading } = conversation;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || (!draft.trim() && gifts.length === 0)) return;
    const text = composeMessage(draft, gifts);
    const attachments = gifts.filter((g) => g.file).map((g) => g.file as NyxFile);
    setDraft("");
    onClearGifts();
    onSent(text);
    void conversation.ask(text, "web", {}, attachments);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={listRef} className="cc-scroll grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3" aria-live="polite" data-nyx="nyx-chat-verlauf">
        {loading && <div className="text-caption text-a-mut">{t("Lade das letzte Gespräch …")}</div>}
        {!loading && messages.length === 0 && (
          <div className="grid gap-2 rounded-xl border border-dashed border-a-line p-4 text-callout text-a-mut">
            <span className="text-a-ink">{t("Noch kein Gespräch.")}</span>
            <span>{t("Sprich mit Nyx (großer Knopf unten) oder schreib hier unten. Alles landet in diesem Verlauf – auch im Nyx-Zentrum oben in der Leiste.")}</span>
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.key} m={m} />
        ))}
      </div>
      <form onSubmit={submit} className="grid gap-2 border-t border-a-line p-3">
        {gifts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label={t("Anhänge für die nächste Nachricht")}>
            {gifts.map((g) => (
              <span key={g.key} className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-a-violet/40 bg-a-violet/10 px-2 py-0.5 text-caption text-a-violet">
                {g.kind === "link" ? "↗" : g.file?.kind === "image" ? "▣" : "▤"} {g.kind === "link" ? g.url : g.file?.name}
              </span>
            ))}
            <button type="button" onClick={onClearGifts} className="text-caption text-a-mut underline hover:text-a-ink">
              {t("entfernen")}
            </button>
          </div>
        )}
        {/* Demo: Fragen, die Nyx dort beantworten kann – ein Klick schickt sie ab. */}
        <DemoQuestions
          disabled={busy}
          onAsk={(question) => {
            if (busy) return;
            onSent(question);
            void conversation.ask(question, "web", {}, []);
          }}
        />
        {/* Längen-Wahl direkt an der Eingabe (gilt auch fürs Sprechen und das Nyx-Feld). */}
        <AnswerLengthPicker />
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            aria-label={t("Nachricht an Nyx")}
            data-nyx="nyx-eingabe"
            placeholder={gifts.length ? t("Was soll Nyx damit machen?") : t("Schreib Nyx … (Enter senden, Umschalt+Enter neue Zeile)")}
            className={cn(FIELD, "max-h-40 min-h-[44px] resize-y")}
          />
          <button
            type="submit"
            disabled={busy || (!draft.trim() && gifts.length === 0)}
            className="h-11 shrink-0 rounded-[9px] border border-a-acc bg-a-acc px-3 text-caption font-semibold text-a-bg transition-colors duration-150 enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:border-a-line disabled:bg-a-p3 disabled:text-a-mut"
          >
            {t("Senden")}
          </button>
        </div>
        {/* „Neues Gespräch“ steht nur einmal.
            Links steht, welcher Faden läuft – derselbe Titel wie in der Fadenliste des Nyx-Zentrums. */}
        <div className="flex min-w-0 items-center justify-between gap-3 text-caption text-a-mut">
          <span className="min-w-0 truncate" data-nyx="nyx-faden" title={conversation.title ?? undefined}>
            {busy ? t("Nyx antwortet …") : conversation.threadId ? (conversation.title ?? t("Gespräch #{id}", { id: conversation.threadId })) : ""}
          </span>
          <button type="button" onClick={conversation.newThread} className="shrink-0 text-a-acc underline hover:brightness-110" data-nyx="nyx-neues-gespraech">
            {t("Neues Gespräch")}
          </button>
        </div>
      </form>
    </div>
  );
}
