// „Nyx fragen“ an JEDER Entscheidung (Karte, erledigte Zeile, Großansicht). Ein Klick → Nyx' Einschätzung in
// genau drei Teilen: „Worum geht's“, „Meine Empfehlung“, „Wichtig zu wissen“ (POST …/nyx-summary, Server merkt sie
// sich je Eintrag). Nyx empfiehlt nur – die Antwort-Knöpfe drückst immer du. Karte und Großansicht teilen sich
// dasselbe Ergebnis (gleicher Query-Schlüssel): einmal gefragt, überall da.
import type { DecisionRefKind, DecisionSummary } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { NyxAura } from "../../components/brand/NyxAura";
import { claimReadAloud } from "../../components/nyx/ReadAloudMessageButton";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/friendlyError";
import { fetchDecisionSummary } from "../haiku/haikuApi";
import { reportNyxLevel } from "../nyx/voice/levelBus";
import { createSpeaker, type Speaker } from "../nyx/voice/speaker";

const KEEP_MS = 30 * 60_000;
const failedText = () => t("Nyx antwortet gerade nicht – bitte gleich noch einmal.");

export const decisionSummaryKey = (kind: DecisionRefKind, id: number) => ["decision-summary", kind, id] as const;

export interface DecisionNyx {
  open: boolean;
  loading: boolean;
  summary: DecisionSummary | null;
  error: string | null;
  speaking: boolean;
  toggle(): void;
  retry(): void;
  refresh(): void;
  speak(): void;
}

/** Gesprochene Fassung der drei Teile. */
export function summarySpeech(s: DecisionSummary): string {
  return [
    t("Worum es geht: {text}", { text: s.worum }),
    t("Meine Empfehlung: {choice}. {reason}", { choice: s.empfehlung.wahl, reason: s.empfehlung.grund }),
    t("Wichtig zu wissen: {text}", { text: (s.wichtig ?? []).join(" ") }),
  ].join(" ");
}

export function useDecisionNyx(kind: DecisionRefKind, id: number): DecisionNyx {
  const qc = useQueryClient();
  const key = decisionSummaryKey(kind, id);
  // Schon einmal gefragt (z. B. auf der Karte)? Dann in der Großansicht gleich offen.
  const [open, setOpen] = useState(() => qc.getQueryData(key) !== undefined);
  const query = useQuery({ queryKey: key, queryFn: () => fetchDecisionSummary(kind, id), enabled: open, staleTime: KEEP_MS, gcTime: KEEP_MS, retry: false });
  const fresh = useMutation({ mutationFn: () => fetchDecisionSummary(kind, id, true), onSuccess: (s) => qc.setQueryData(key, s) });
  const [speaking, setSpeaking] = useState(false);
  const speakerRef = useRef<Speaker | null>(null);

  const stop = useCallback(() => {
    speakerRef.current?.cancel();
    speakerRef.current = null;
    setSpeaking(false);
  }, []);
  useEffect(() => () => speakerRef.current?.cancel(), []);

  const summary = query.data ?? null;
  const speak = () => {
    if (speaking) return stop();
    if (!summary) return;
    const sp = createSpeaker();
    // Nur eine Stimme: beendet ein laufendes „Vorlesen“ einer Nachricht (und wird von dort beendet).
    const release = claimReadAloud(sp);
    speakerRef.current = sp;
    setSpeaking(true);
    const unreport = reportNyxLevel(() => sp.level());
    sp.say(summarySpeech(summary));
    void sp.end().finally(() => {
      unreport();
      release();
      if (speakerRef.current === sp) {
        speakerRef.current = null;
        setSpeaking(false);
      }
    });
  };

  const err = fresh.error ?? query.error;
  return {
    open,
    loading: open && (query.isFetching || fresh.isPending),
    summary,
    error: open && err ? friendlyError(err, failedText()) : null,
    speaking,
    toggle: () => {
      if (open) stop();
      setOpen(!open);
    },
    retry: () => {
      fresh.reset();
      void query.refetch();
    },
    refresh: () => fresh.mutate(),
    speak,
  };
}

const CHIP = "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-caption font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc";
const SMALL = "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-caption transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc";

const stopBubble = (e: MouseEvent) => e.stopPropagation();

/** Der einheitliche Knopf „Nyx fragen“ (gut sichtbar, mit Nyx-Zeichen). `compact`: nur das Zeichen (Erledigt-Liste). */
export function NyxAskChip({ nyx, compact = false, label: labelProp }: { nyx: DecisionNyx; compact?: boolean; label?: string }) {
  const label = labelProp ?? t("Nyx fragen");
  const title = nyx.open ? t("Einschätzung zuklappen") : t("{label}: Worum geht's, Empfehlung, wichtig zu wissen", { label });
  return (
    <button
      type="button"
      data-testid="decision-ask-nyx"
      data-card-ignore=""
      aria-expanded={nyx.open}
      aria-label={compact ? label : undefined}
      title={title}
      onClick={(e) => {
        stopBubble(e);
        nyx.toggle();
      }}
      className={cn(
        compact ? "inline-grid h-7 w-7 shrink-0 place-items-center rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc" : CHIP,
        nyx.open ? "border-a-violet/60 bg-a-violet/15 text-a-ink" : "border-a-violet/35 bg-a-violet/8 text-a-ink hover:border-a-violet/60 hover:bg-a-violet/15",
      )}
    >
      <NyxAura size={14} state={nyx.loading ? "thinking" : nyx.speaking ? "speaking" : "idle"} />
      {!compact && <span>{nyx.loading ? t("Nyx schaut …") : label}</span>}
    </button>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-1">
      <h3 className="font-mono text-label uppercase tracking-[.12em] text-a-mut">{title}</h3>
      {children}
    </section>
  );
}

/** Die aufgeklappte Einschätzung. Klicks darin öffnen nie die Großansicht und lösen keine Entscheidung aus. */
export function NyxSummaryPanel({ nyx }: { nyx: DecisionNyx }) {
  if (!nyx.open) return null;
  const s = nyx.summary;
  return (
    <div data-testid="nyx-summary" data-card-ignore="" onClick={stopBubble} className="grid min-w-0 gap-3 rounded-xl border border-a-violet/35 bg-a-violet/5 p-3.5 md:p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-label uppercase tracking-[.12em] text-a-violet">
        <NyxAura size={16} state={nyx.loading ? "thinking" : nyx.speaking ? "speaking" : "idle"} />
        {t("Nyx' Einschätzung")}
        <span className="normal-case tracking-normal text-a-mut">· {t("nur eine Empfehlung – entscheiden tust du")}</span>
      </div>
      {nyx.loading && !s && (
        <p role="status" className="text-callout text-a-mut">
          {t("Nyx schaut sich das an …")}
        </p>
      )}
      {nyx.error && (
        <p role="alert" className="text-callout text-a-bad">
          {nyx.error}
        </p>
      )}
      {s && (
        <div role="status" aria-live="polite" className={cn("grid min-w-0 gap-3", nyx.loading && "opacity-60")}>
          <Part title={t("Worum geht's")}>
            <p className="min-w-0 text-callout leading-relaxed text-a-ink [overflow-wrap:anywhere]">{s.worum}</p>
          </Part>
          <Part title={t("Meine Empfehlung")}>
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-callout leading-relaxed text-a-ink [overflow-wrap:anywhere]">
              <span className="rounded-full border border-a-violet/40 bg-a-violet/15 px-2.5 py-px font-semibold text-a-ink">{s.empfehlung.wahl}</span>
              <span className="min-w-0">{s.empfehlung.grund}</span>
            </p>
          </Part>
          <Part title={t("Wichtig zu wissen")}>
            <ul className="grid min-w-0 list-disc gap-1 pl-5 text-callout leading-relaxed text-a-ink marker:text-a-violet">
              {(s.wichtig ?? []).map((w, i) => (
                <li key={i} className="min-w-0 [overflow-wrap:anywhere]">
                  {w}
                </li>
              ))}
            </ul>
          </Part>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {s && (
          <button type="button" onClick={nyx.speak} className={cn(SMALL, "border-a-line bg-a-p2 text-a-ink hover:bg-a-p3")}>
            {nyx.speaking ? `■ ${t("Stopp")}` : `▶ ${t("Vorlesen")}`}
          </button>
        )}
        {nyx.error ? (
          <button type="button" onClick={nyx.retry} className={cn(SMALL, "border-a-acc/50 bg-a-acc/10 text-a-acc hover:bg-a-acc/15")}>
            {t("Noch einmal")}
          </button>
        ) : (
          s && (
            <button type="button" disabled={nyx.loading} onClick={nyx.refresh} className={cn(SMALL, "border-a-line bg-a-p2 text-a-ink hover:bg-a-p3 disabled:opacity-50")}>
              {t("Neu fragen")}
            </button>
          )
        )}
        <button type="button" onClick={nyx.toggle} className={cn(SMALL, "border-transparent text-a-mut hover:bg-a-p2 hover:text-a-ink")}>
          {t("Zuklappen")}
        </button>
        {s && <span className="min-w-0 text-caption text-a-mut">{s.cached ? t("gemerkt") : t("gerade")} · {relativeTime(s.at)}</span>}
      </div>
    </div>
  );
}
