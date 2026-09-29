// „Nyx fasst zusammen“: jede geöffnete Session hat einen Nyx-Knopf bei den Session-Infos – Nyx erklärt ausführlich,
// was in der Session gemacht wurde, statt dass man den ganzen Chat durchlesen muss.
//
// Knopf „Nyx fasst zusammen“ (Session-Infos, Handy-Blatt „⋯“, Symbol im Kopf) → die Zusammenfassung steht als
// BLEIBENDE, aufklappbare Karte oben im Chat (nicht als flüchtige „Nyx fragen“-Karte): dort ist auf Mac und Handy die
// meiste Breite zum Lesen, und sie ist beim nächsten Öffnen der Session wieder da. Text strömt, während Nyx schreibt.
import { t, type NyxSessionSummary } from "@nyxos/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NyxAura } from "../../components/brand/NyxAura";
import { ReadAloudMessageButton } from "../../components/nyx/ReadAloudMessageButton";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { useCreateSummary, useSessionSummary } from "./api";

const label = () => t("Nyx fasst zusammen");
const COPIED_MS = 2_000;

// ── Auf/zu + letzter Start-Fehler je Session (geteilt zwischen Knöpfen und Karte) ──────────────────────────────────
interface UiState {
  open: boolean;
  error: string | null;
}
const CLOSED: UiState = { open: false, error: null };
const ui = new Map<string, UiState>();
const listeners = new Set<() => void>();
function setUi(sessionId: string, patch: Partial<UiState>) {
  ui.set(sessionId, { ...(ui.get(sessionId) ?? CLOSED), ...patch });
  for (const l of listeners) l();
}
function useUi(sessionId: string): UiState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => ui.get(sessionId) ?? CLOSED,
  );
}

/** Knopf-Logik: vorhandene, aktuelle Zusammenfassung nur aufklappen – sonst (keine, veraltet, Fehler) neu erstellen. */
function useSummaryAction(sessionId: string) {
  const query = useSessionSummary(sessionId);
  const create = useCreateSummary(sessionId);
  const s = query.data?.summary ?? null;
  const fresh = s !== null && (s.status === "running" || (s.status === "done" && (query.data?.newMessages ?? 0) === 0));
  const start = () => {
    setUi(sessionId, { open: true, error: null });
    create.mutate(undefined, { onError: (e) => setUi(sessionId, { open: true, error: e instanceof Error ? e.message : t("Das hat gerade nicht geklappt.") }) });
  };
  return {
    query,
    pending: create.isPending || s?.status === "running",
    start,
    trigger: () => (fresh ? setUi(sessionId, { open: true, error: null }) : start()),
  };
}

/** Der Nyx-Knopf. `icon`: nur das Logo (Kopf, eingeklappte Leiste), Beschriftung als Tooltip/aria-label. */
export function SummaryButton({ sessionId, variant = "full", onTriggered, className }: { sessionId: string; variant?: "full" | "icon"; onTriggered?: () => void; className?: string }) {
  const a = useSummaryAction(sessionId);
  const engine = a.query.data?.engine;
  const hint = engine && !engine.ready ? `${label()} – ${engine.reason ?? t("Nyx ist gerade nicht bereit.")}` : t("{label}: was in dieser Session gemacht wurde, erscheint oben im Chat", { label: label() });
  const onClick = () => {
    a.trigger();
    onTriggered?.();
  };
  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label()}
        title={hint}
        aria-busy={a.pending}
        data-testid="summary-button-icon"
        className={cn(
          "grid h-(--a-ctl-h) w-(--a-ctl-h) shrink-0 place-items-center rounded-md border border-a-line text-a-mut transition-colors duration-150 hover:border-a-violet/50 hover:text-a-ink focus-visible:outline-2 focus-visible:outline-a-acc max-md:h-11 max-md:w-11 max-md:border-0",
          className,
        )}
      >
        <NyxAura size={16} state={a.pending ? "thinking" : "idle"} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-busy={a.pending}
      data-testid="summary-button"
      className={cn(
        "inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-lg border border-a-violet/40 bg-a-violet/10 px-3 text-callout font-medium text-a-ink transition-colors duration-150 hover:bg-a-violet/20 focus-visible:outline-2 focus-visible:outline-a-acc pointer-coarse:min-h-11",
        className,
      )}
    >
      <NyxAura size={16} state={a.pending ? "thinking" : "idle"} />
      {a.pending ? t("Nyx schreibt …") : label()}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("ok");
    } catch {
      setState("fail");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex items-center gap-1 rounded-md border border-a-line px-2 py-0.5 text-label text-a-mut transition-colors duration-150 hover:text-a-ink focus-visible:outline-2 focus-visible:outline-a-acc pointer-coarse:min-h-11"
    >
      <span aria-live="polite">{state === "ok" ? t("Kopiert ✓") : state === "fail" ? t("Kopieren ging nicht") : t("Kopieren")}</span>
    </button>
  );
}

function Body({ summary, error, onRetry }: { summary: NyxSessionSummary | null; error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <div className="grid justify-items-start gap-2" role="alert">
        <p className="text-caption text-a-wait">{error}</p>
        <button type="button" onClick={onRetry} className="text-caption font-medium text-a-acc hover:underline pointer-coarse:min-h-11">
          {t("Noch einmal versuchen")}
        </button>
      </div>
    );
  }
  if (!summary) return null;
  if (summary.status === "running") {
    return (
      <div className="grid gap-2" aria-live="polite">
        <p className="flex items-center gap-2 text-caption text-a-mut">
          <span className="h-2 w-2 rounded-full bg-a-violet motion-safe:animate-pulse" />
          {t("Nyx schreibt die Zusammenfassung – das dauert meist unter einer Minute.")}
        </p>
        {summary.text && (
          <div className="text-callout text-a-ink opacity-80">
            <Markdown text={summary.text} />
          </div>
        )}
      </div>
    );
  }
  if (summary.status === "error") {
    return (
      <div className="grid justify-items-start gap-2" role="alert">
        <p className="text-caption text-a-wait">{summary.error ?? t("Die Zusammenfassung ist nicht fertig geworden.")}</p>
        <button type="button" onClick={onRetry} className="text-caption font-medium text-a-acc hover:underline pointer-coarse:min-h-11">
          {t("Noch einmal versuchen")}
        </button>
      </div>
    );
  }
  const shortened = summary.itemsRead !== null && summary.itemsTotal !== null && summary.itemsRead < summary.itemsTotal;
  return (
    <div className="grid gap-3">
      <div className="min-w-0 text-callout break-words text-a-ink [&_[role=heading]]:mt-2 [&_[role=heading]]:text-a-violet">
        <Markdown text={summary.text} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ReadAloudMessageButton text={summary.text} className="pointer-coarse:min-h-11" />
        <CopyButton text={summary.text} />
      </div>
      {(shortened || summary.dropped > 0) && (
        <p className="text-label text-a-mut">
          {shortened && `${t("Gelesen: Anfang und Ende ({read} von {total} Einträgen), dazu alle Werkzeuge und Dateien.", { read: summary.itemsRead ?? 0, total: summary.itemsTotal ?? 0 })} `}
          {summary.dropped > 0 && (summary.dropped === 1 ? t("1 Angabe ohne Beleg im Verlauf weggelassen.") : t("{n} Angaben ohne Beleg im Verlauf weggelassen.", { n: summary.dropped }))}
        </p>
      )}
    </div>
  );
}

/** Die Karte oben im Chat. Erscheint, sobald es eine Zusammenfassung gibt (oder ein Start fehlschlug). */
export function SessionSummaryCard({ sessionId }: { sessionId: string }) {
  const a = useSummaryAction(sessionId);
  const state = useUi(sessionId);
  const s = a.query.data?.summary ?? null;
  const fresh = a.query.data?.newMessages ?? 0;
  if (!s && !state.error) return null;
  const when = s ? relativeTime(s.finishedAt ?? s.createdAt) : null;
  const toggle = () => setUi(sessionId, { open: !state.open });
  return (
    <section data-testid="session-summary" aria-label={t("Zusammenfassung von Nyx")} className="cc-kb-hide shrink-0 border-b border-a-line bg-a-violet/5">
      <div className="flex min-w-0 items-center gap-1 pr-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={state.open}
          aria-label={state.open ? t("Zusammenfassung zuklappen") : t("Zusammenfassung aufklappen")}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 text-left focus-visible:outline-2 focus-visible:outline-a-acc max-md:min-h-11"
        >
          <NyxAura size={16} state={s?.status === "running" || a.pending ? "thinking" : "idle"} />
          <span className="truncate text-caption font-semibold text-a-ink">{t("Zusammenfassung von Nyx")}</span>
          {when && <span className="shrink-0 font-mono text-label text-a-mut">{when}</span>}
          <span aria-hidden="true" className={cn("ml-auto shrink-0 text-a-mut transition-transform duration-150", state.open && "rotate-180")}>
            ▾
          </span>
        </button>
      </div>
      {s?.status === "done" && fresh > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2">
          <span className="rounded-full border border-a-wait/40 bg-a-wait/10 px-2 py-0.5 text-label text-a-wait">
            {fresh === 1 ? t("1 neue Nachricht seit der Zusammenfassung") : t("{n} neue Nachrichten seit der Zusammenfassung", { n: fresh })}
          </span>
          <button type="button" onClick={a.start} disabled={a.pending} className="text-caption font-medium text-a-acc hover:underline disabled:opacity-50 pointer-coarse:min-h-11">
            {t("Neu erstellen")}
          </button>
        </div>
      )}
      {state.open && (
        <div className="cc-scroll max-h-[45vh] overflow-y-auto px-3 pb-3 max-md:max-h-[55dvh]">
          <Body summary={s} error={state.error} onRetry={a.start} />
          {s?.status === "done" && !state.error && fresh === 0 && (
            <button type="button" onClick={a.start} disabled={a.pending} className="mt-2 text-label text-a-mut hover:text-a-acc hover:underline disabled:opacity-50 pointer-coarse:min-h-11">
              {t("Neu erstellen")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
