// Das schmale Ausgabe-Feld direkt unter der Nyx-Leiste – Live-Untertitel wie bei einem Anruf:
// was du gesagt hast, Nyx' Antwort als Text (wächst beim Strömen), Zustand (hört zu / denkt nach / Werkzeug /
// spricht). Tippen geht auch. Schließt sich nach kurzer Ruhe von selbst oder per Esc/✕.
// Es hängt an genau derselben Stelle wie das Nyx-Feld (so breit wie die Leiste, rechtsbündig) – ein Ort für Nyx.
import { nyxToolStatus, t, type HaikuSource } from "@nyxos/shared";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cn } from "../../../lib/cn";
import { Markdown } from "../../../lib/markdown";
import { SourceChips } from "../../haiku/ui";
import type { NyxVisualState } from "../netModel";
import { dropdownPlacement, type DropdownPlacement } from "./dropdownPlacement";
import { NyxThoughts } from "../NyxThoughts";

export interface NyxCaptionProps {
  /** Die Leiste, unter der das Feld hängt. */
  anchorRef: RefObject<HTMLElement | null>;
  talking: boolean;
  transcribing: boolean;
  visual: NyxVisualState;
  toolName: string | null;
  heard: string;
  reply: string;
  /** Belege der Antwort (kommen mit dem Ende der Antwort); `[n]` im Text verweist auf `sources[n-1]`. */
  sources: HaikuSource[];
  /** Gedanken zur Antwort (eingeklappt, nie vorgelesen). */
  thoughts?: readonly string[];
  error: string | null;
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onOpenCenter: () => void;
  /** Eingabe hat den Fokus (dann schließt das Feld nicht von selbst). */
  onFocusChange: (focused: boolean) => void;
}

function phaseOf(p: NyxCaptionProps): { label: string; tone: string } {
  if (p.talking) return { label: t("Ich höre zu – loslassen zum Senden"), tone: "text-a-ok" };
  if (p.transcribing) return { label: t("Verstehe …"), tone: "text-a-nyx-2" };
  // Dieselbe Farbfolge wie die Aura (blau → rot → orange → grün).
  if (p.visual === "tool") return { label: `${nyxToolStatus(p.toolName)} …`, tone: "text-a-nyx-tool" };
  if (p.visual === "thinking") return { label: t("Denkt nach …"), tone: "text-a-nyx-think" };
  if (p.visual === "speaking") return { label: t("Spricht"), tone: "text-a-nyx-speak" };
  if (p.visual === "listening") return { label: t("Hört zu"), tone: "text-a-nyx-listen" };
  return { label: "Nyx", tone: "text-a-nyx" };
}

export function NyxCaption(p: NyxCaptionProps) {
  const [pos, setPos] = useState<DropdownPlacement>(() => dropdownPlacement(null, typeof window === "undefined" ? 1024 : window.innerWidth));
  const scrollRef = useRef<HTMLDivElement>(null);

  // Direkt unter der Leiste, so breit wie sie, rechtsbündig; passt immer in den Bildschirm.
  useLayoutEffect(() => {
    const place = () => setPos(dropdownPlacement(p.anchorRef.current?.getBoundingClientRect(), window.innerWidth));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [p.anchorRef]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.reply, p.heard]);

  const phase = phaseOf(p);
  return (
    <section
      aria-label={t("Nyx-Ausgabe")}
      data-testid="nyx-caption"
      className="nyx-caption fixed z-[65] grid gap-2 rounded-2xl p-3 text-caption text-a-ink"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("flex min-w-0 items-center gap-1.5 font-mono text-label", phase.tone)} data-testid="nyx-caption-phase">
          <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-current", (p.talking || p.transcribing || p.visual === "thinking" || p.visual === "tool") && "cc-pulse")} />
          <span className="truncate">{phase.label}</span>
        </span>
        <span className="flex-1" />
        <button type="button" onClick={p.onOpenCenter} className="shrink-0 rounded-md px-1.5 py-0.5 text-caption text-a-mut transition-colors duration-150 hover:bg-a-p3 hover:text-a-ink">
          {t("Verlauf & Aktionen")}
        </button>
        <button type="button" aria-label={t("Ausgabe schließen")} onClick={p.onClose} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-a-mut hover:bg-a-p3 hover:text-a-ink">
          ✕
        </button>
      </div>
      <div ref={scrollRef} role="log" aria-live="polite" className="cc-scroll grid max-h-[32vh] min-w-0 gap-1.5 overflow-y-auto">
        {p.heard && (
          <p className="min-w-0 break-words text-a-mut [overflow-wrap:anywhere]" data-testid="nyx-caption-heard">
            <span className="mr-1 font-mono text-label uppercase tracking-wide">{t("Du")}</span>„{p.heard}“
          </p>
        )}
        <NyxThoughts thoughts={p.thoughts} />
        {/* Wie im Zentrum – Markdown (fett, Listen …) und Belege als kleine Verweise, kompakt. */}
        {p.reply && (
          <div className="grid min-w-0 gap-1.5 break-words leading-relaxed [overflow-wrap:anywhere]" data-testid="nyx-caption-reply">
            <Markdown text={p.reply} sources={p.sources} />
          </div>
        )}
        {p.reply && <SourceChips sources={p.sources} />}
        {!p.reply && !p.heard && !p.error && !p.talking && <p className="text-a-mut">{t("Halte die Leiste gedrückt und sprich – oder schreib hier.")}</p>}
        {p.error && (
          <p role="alert" className="text-a-wait">
            {p.error}
          </p>
        )}
      </div>
      <form
        className="flex min-w-0 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit();
        }}
      >
        <input
          value={p.draft}
          onChange={(e) => p.setDraft(e.target.value)}
          onFocus={() => p.onFocusChange(true)}
          onBlur={() => p.onFocusChange(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") p.onClose();
          }}
          aria-label={t("Nachricht an Nyx")}
          placeholder={t("Schreib Nyx … (z. B. „öffne Git“)")}
          className="h-8 min-w-0 flex-1 rounded-lg border border-a-line bg-a-bg/70 px-2.5 text-caption text-a-ink outline-none placeholder:text-a-mut focus:border-a-nyx"
        />
        <button
          type="submit"
          disabled={!p.draft.trim()}
          className="h-8 shrink-0 rounded-lg border border-a-nyx/60 px-2.5 text-caption text-a-nyx transition-colors duration-150 enabled:hover:bg-a-nyx/10 disabled:cursor-not-allowed disabled:border-a-line disabled:text-a-mut"
        >
          {t("Senden")}
        </button>
      </form>
    </section>
  );
}
