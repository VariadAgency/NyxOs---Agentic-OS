// „Nyx fragen“-Knopf: klein und unaufdringlich. Ein Tipp → Nyx fasst das Thema kurz zusammen (Antwort in einer
// kleinen Karte) und liest sie vor. Überall derselbe Knopf: Briefing-Kacheln, Konflikte, Audits, Entscheidungen.
// `inline` (Standard): die Karte steht direkt unter dem Knopf. `inline={false}` (in engen Kacheln): die Karte
// schwebt unten rechts über der Seite, ohne etwas abzudunkeln.
import { t } from "@nyxos/shared";
import { createPortal } from "react-dom";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { NyxAura } from "../brand/NyxAura";
import { useAskNyx, type AskNyx } from "./useAskNyx";

export interface AskNyxButtonProps {
  /** Die Frage an Nyx, z. B. „Was ist beim Konflikt in apps/web los?“. */
  question: string;
  /** Die Daten dazu (Zahlen, Dateien, Sessions) – Nyx soll nichts erfinden müssen. */
  facts?: string | null;
  /** Beschriftung (Standard „Nyx fragen“). */
  label?: string;
  /** Nur das Logo zeigen (für enge Kacheln); Beschriftung dann als Tooltip. */
  compact?: boolean;
  inline?: boolean;
  className?: string;
}

const stop = (e: MouseEvent) => {
  // Der Knopf sitzt oft in klickbaren Karten/Links – deren Klick nicht mit auslösen.
  e.preventDefault();
  e.stopPropagation();
};

const SMALL = "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-caption transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc";

export function AskNyxButton({ question, facts, label = t("Nyx fragen"), compact = false, inline = true, className }: AskNyxButtonProps) {
  const nyx = useAskNyx(question, facts);
  const busy = nyx.state === "asking";
  const open = nyx.state !== "idle";
  const onClick = (e: MouseEvent) => {
    stop(e);
    if (nyx.speaking) nyx.stopSpeaking();
    else nyx.ask();
  };
  const title = nyx.speaking ? t("Nyx still stellen") : t("{label}: kurze Zusammenfassung, vorgelesen", { label });
  const button = (
    <button
      type="button"
      data-testid="ask-nyx"
      onClick={onClick}
      aria-busy={busy}
      aria-label={compact ? title : undefined}
      title={title}
      className={cn(
        compact ? "inline-grid h-7 w-7 place-items-center rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc" : SMALL,
        nyx.speaking || busy ? "border-a-violet/60 bg-a-violet/15 text-a-ink" : "border-a-line bg-a-p2/80 text-a-mut hover:border-a-violet/50 hover:text-a-ink",
        className,
      )}
    >
      <NyxAura size={14} state={busy ? "thinking" : nyx.speaking ? "speaking" : "idle"} />
      {!compact && <span>{nyx.speaking ? t("Stopp") : busy ? t("Nyx schaut …") : label}</span>}
    </button>
  );
  if (!open) return button;
  const card = <AnswerCard nyx={nyx} floating={!inline} />;
  if (inline) {
    return (
      <div className="grid min-w-0 justify-items-start gap-2">
        {button}
        {card}
      </div>
    );
  }
  return (
    <>
      {button}
      {typeof document !== "undefined" ? createPortal(card, document.body) : null}
    </>
  );
}

function CardShell({ floating, children }: { floating: boolean; children: ReactNode }) {
  if (!floating) return <div className="grid w-full min-w-0 gap-2 rounded-xl border border-a-violet/35 bg-a-violet/5 p-3">{children}</div>;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-(--a-demo-bar-h) z-50 flex justify-end px-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto grid w-full max-w-[400px] gap-2 rounded-2xl border border-a-violet/40 bg-a-p/95 p-3.5 shadow-[0_18px_50px_-12px_color-mix(in_srgb,var(--a-bg)_80%,transparent)] backdrop-blur">{children}</div>
    </div>
  );
}

function AnswerCard({ nyx, floating }: { nyx: AskNyx; floating: boolean }) {
  const text = nyx.answer?.text ?? (nyx.partial || null);
  return (
    <CardShell floating={floating}>
      <div role="status" aria-live="polite" data-testid="ask-nyx-answer" className="grid min-w-0 gap-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex min-w-0 items-center gap-2 font-mono text-label uppercase tracking-[.12em] text-a-violet">
          <NyxAura size={16} state={nyx.state === "asking" ? "thinking" : nyx.speaking ? "speaking" : "idle"} />
          Nyx
          {nyx.speaking && <span className="normal-case tracking-normal text-a-mut">{t("spricht …")}</span>}
        </div>
        {nyx.state === "asking" && !text && <p className="text-callout text-a-mut">{t("Ich schau mal …")}</p>}
        {text && <p className="min-w-0 whitespace-pre-line text-callout leading-relaxed text-a-ink [overflow-wrap:anywhere]">{text}</p>}
        {nyx.error && <p className="text-caption text-a-wait">{nyx.error}</p>}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {nyx.speaking ? (
            <button type="button" onClick={(e) => (stop(e), nyx.stopSpeaking())} className={cn(SMALL, "border-a-line bg-a-p2 text-a-ink hover:bg-a-p3")}>
              ■ {t("Stopp")}
            </button>
          ) : nyx.answer ? (
            <button type="button" onClick={(e) => (stop(e), nyx.replay())} className={cn(SMALL, "border-a-line bg-a-p2 text-a-ink hover:bg-a-p3")}>
              ▶ {t("Vorlesen")}
            </button>
          ) : null}
          {nyx.state === "error" && (
            <button type="button" onClick={(e) => (stop(e), nyx.ask())} className={cn(SMALL, "border-a-acc/50 bg-a-acc/10 text-a-acc hover:bg-a-acc/15")}>
              {t("Noch einmal")}
            </button>
          )}
          <button type="button" onClick={(e) => (stop(e), nyx.reset())} className={cn(SMALL, "border-transparent text-a-mut hover:bg-a-p2 hover:text-a-ink")}>
            {t("Schließen")}
          </button>
        </div>
      </div>
    </CardShell>
  );
}
