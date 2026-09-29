// "Feedback & Unterstützen" (open-source edition): one sheet with three tabs — Fehler melden · Idee an den Entwickler ·
// Buy me Tokens. Everything happens inside NyxOS, no link to the outside: reports go through the own server (and wait
// in the outbox while there is no support address or no connection), payment is embedded (TokensTab/DonationFrame).
// Opened via `?support=<tab>` (openSupport.ts) — from the status line, the connections page, the settings, ⌘K or Nyx.
import { t, tc, type SupportOutboxItem, type SupportState } from "@nyxos/shared";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { LoginRequiredError } from "../terminal/authClient";
import { useFlushOutbox, useRemoveOutboxItem, useSaveSupportUrl, useSupportState } from "./api";
import { BugTab } from "./BugTab";
import { IdeaTab } from "./IdeaTab";
import { isSupportTab, OPEN_SUPPORT_EVENT, SUPPORT_PARAM, SUPPORT_TABS, type SupportTab } from "./openSupport";
import { FIELD, HeartIcon, Note } from "./parts";
import { TokensTab } from "./TokensTab";

const TAB_LABEL: Record<SupportTab, string> = { bug: t("Fehler melden"), idea: t("Idee an den Entwickler"), tokens: t("Buy me Tokens") };
const TAB_SHORT: Record<SupportTab, string> = { bug: t("Fehler"), idea: t("Idee"), tokens: t("Tokens") };
const STATUS_LABEL: Record<SupportOutboxItem["status"], string> = { waiting: t("wartet"), sending: t("wird gesendet"), sent: t("gesendet"), rejected: tc("support", "abgelehnt") };
const STATUS_TONE: Record<SupportOutboxItem["status"], string> = {
  waiting: "border-a-wait/40 bg-a-wait/10 text-a-wait",
  sending: "border-a-acc/40 bg-a-acc/10 text-a-acc",
  sent: "border-a-ok/40 bg-a-ok/10 text-a-ok",
  rejected: "border-a-bad/40 bg-a-bad/10 text-a-bad",
};

/** The sheet is part of the app shell (App.tsx) and shows itself when the address says so. */
export function SupportSheet() {
  const [params, setParams] = useSearchParams();
  const raw = params.get(SUPPORT_PARAM);
  const tab = isSupportTab(raw) ? raw : null;

  useEffect(() => {
    const onOpen = (e: Event) => {
      const next = (e as CustomEvent<SupportTab>).detail;
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set(SUPPORT_PARAM, isSupportTab(next) ? next : "bug");
          return p;
        },
        { replace: false },
      );
    };
    window.addEventListener(OPEN_SUPPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SUPPORT_EVENT, onOpen);
  }, [setParams]);

  if (!tab) return null;
  const setTab = (next: SupportTab) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set(SUPPORT_PARAM, next);
        return p;
      },
      { replace: true },
    );
  const close = () =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete(SUPPORT_PARAM);
        return p;
      },
      { replace: true },
    );
  return <SheetFrame tab={tab} onTab={setTab} onClose={close} />;
}

function SheetFrame({ tab, onTab, onClose }: { tab: SupportTab; onTab: (t: SupportTab) => void; onClose: () => void }) {
  const state = useSupportState(true);
  const dialog = useRef<HTMLElement>(null);
  const tabRefs = useRef<Partial<Record<SupportTab, HTMLButtonElement | null>>>({});

  // Focus into the sheet on open, back to where it was on close; Escape closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    tabRefs.current[tab]?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
    // Only when the sheet opens/closes, not on every tab change.
  }, []);

  const onTabKey = (e: KeyboardEvent) => {
    const i = SUPPORT_TABS.indexOf(tab);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = SUPPORT_TABS[(i + step + SUPPORT_TABS.length) % SUPPORT_TABS.length] ?? "bug";
    onTab(next);
    tabRefs.current[next]?.focus();
  };

  const needsLogin = state.error instanceof LoginRequiredError;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center cc-scrim sm:items-center sm:p-4" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="support-title"
        data-testid="support-sheet"
        className="flex max-h-[92dvh] w-full min-w-0 flex-col overflow-hidden rounded-t-2xl border border-a-line bg-a-p2 shadow-pop motion-safe:animate-[cc-tab-fade_150ms_ease-out] sm:max-h-[88dvh] sm:max-w-[560px] sm:rounded-2xl"
      >
        <header className="flex items-center gap-2 border-b border-a-line px-4 pb-2 pt-3">
          <HeartIcon className="h-4 w-4 text-a-conf" />
          <h2 id="support-title" className="min-w-0 flex-1 font-display text-headline font-semibold text-a-ink">
            {t("Feedback & Unterstützen")}
          </h2>
          <button type="button" onClick={onClose} aria-label={t("Schließen")} className="grid h-11 w-11 place-items-center rounded-lg text-title2 text-a-mut hover:bg-a-p3 hover:text-a-ink sm:h-9 sm:w-9">
            ×
          </button>
        </header>
        <div role="tablist" aria-label={t("Feedback & Unterstützen")} className="grid grid-cols-3 gap-1 border-b border-a-line px-3 py-2" onKeyDown={onTabKey}>
          {SUPPORT_TABS.map((id) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`support-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`support-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              aria-label={TAB_LABEL[id]}
              data-nyx={`support-tab-${id}`}
              onClick={() => onTab(id)}
              className={cn(
                "min-h-11 min-w-0 truncate rounded-lg px-2 text-callout transition-colors duration-150 sm:min-h-9",
                tab === id ? "bg-a-p3 font-medium text-a-ink" : "text-a-mut hover:bg-a-p hover:text-a-ink",
              )}
            >
              <span className="sm:hidden">{TAB_SHORT[id]}</span>
              <span className="max-sm:hidden">{TAB_LABEL[id]}</span>
            </button>
          ))}
        </div>
        <div className="cc-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
          <div role="tabpanel" id={`support-panel-${tab}`} aria-labelledby={`support-tab-${tab}`} className="grid gap-5">
            {state.isLoading && <Skeleton className="h-40 w-full" />}
            {state.isError && (
              <Note tone={needsLogin ? "info" : "bad"} role="alert">
                <span>{needsLogin ? t("Bitte anmelden, dann geht es weiter.") : friendlyError(state.error, t("Der Server hat nicht geantwortet – bitte gleich noch einmal versuchen."))}</span>
                <Button className="w-fit min-h-11 sm:min-h-8" onClick={() => void state.refetch()}>
                  {t("Erneut versuchen")}
                </Button>
              </Note>
            )}
            {state.data && (
              <>
                {tab !== "tokens" && <OutboxPanel state={state.data} />}
                {tab === "bug" && <BugTab state={state.data} />}
                {tab === "idea" && <IdeaTab state={state.data} />}
                {tab === "tokens" && <TokensTab state={state.data} />}
                <AdvancedPanel state={state.data} />
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/** Waiting reports (and the last few sent ones) — honest about where they are. */
function OutboxPanel({ state }: { state: SupportState }) {
  const flush = useFlushOutbox();
  const remove = useRemoveOutboxItem();
  const { waiting, items } = state.outbox;
  if (items.length === 0) return null;
  const text =
    waiting === 0
      ? null
      : state.configured
        ? t(waiting === 1 ? "1 Meldung wartet – geht raus, sobald die Meldestelle erreichbar ist." : "{n} Meldungen warten – gehen raus, sobald die Meldestelle erreichbar ist.", { n: waiting })
        : t(waiting === 1 ? "1 Meldung wartet – geht raus, sobald die Meldestelle eingerichtet ist." : "{n} Meldungen warten – gehen raus, sobald die Meldestelle eingerichtet ist.", { n: waiting });
  return (
    <div className="grid gap-2" data-testid="support-outbox">
      {text && (
        <Note tone="wait" role="status">
          <span data-testid="support-outbox-waiting">{text}</span>
          {state.configured && (
            <Button className="w-fit min-h-11 sm:min-h-8" onClick={() => flush.mutate()} disabled={flush.isPending} aria-busy={flush.isPending}>
              {flush.isPending ? t("Sendet …") : t("Jetzt senden")}
            </Button>
          )}
        </Note>
      )}
      <details className="rounded-lg border border-a-line bg-a-p">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-caption text-a-mut hover:text-a-ink sm:min-h-9">{t("Deine Meldungen ({n})", { n: items.length })}</summary>
        <ul className="grid gap-1 px-2 pb-2">
          {items.map((item) => (
            <li key={item.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1.5" data-status={item.status}>
              <span className={cn("rounded-full border px-2 py-0.5 text-label font-medium", STATUS_TONE[item.status])}>{STATUS_LABEL[item.status]}</span>
              <span className="grid min-w-0">
                <span className="truncate text-caption text-a-ink">
                  {item.kind === "idea" ? t("Idee") : t("Fehler")}: {item.title || "–"}
                </span>
                {item.status !== "sent" && item.lastError && <span className="truncate text-label text-a-mut">{item.lastError}</span>}
                {item.status === "sent" && item.reference && <span className="truncate text-label text-a-mut">{t("Nummer: {ref}", { ref: item.reference })}</span>}
              </span>
              {item.status === "waiting" || item.status === "rejected" ? (
                <Button variant="ghost" data-nyx-risk="" className="min-h-11 sm:min-h-7" onClick={() => remove.mutate(item.id)} aria-label={t("Meldung „{title}“ löschen", { title: item.title })}>
                  {t("Löschen")}
                </Button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Where reports go. For own builds and forks; the environment variable wins. */
function AdvancedPanel({ state }: { state: SupportState }) {
  const save = useSaveSupportUrl();
  const [url, setUrl] = useState(state.settingUrl);
  const [saved, setSaved] = useState(false);
  const where = state.origin ? new URL(state.origin).host : null;
  return (
    <details className="group border-t border-a-line pt-3">
      <summary className="flex min-h-11 cursor-pointer items-center text-caption text-a-mut hover:text-a-ink sm:min-h-8">{t("Erweitert: Meldestelle")}</summary>
      <div className="grid gap-2 pt-2">
        <p className="text-caption leading-relaxed text-a-mut">
          {where ? t("Meldungen und Spenden gehen an {host}.", { host: where }) : t("Noch keine Meldestelle eingerichtet – Meldungen warten im Postausgang.")}{" "}
          {t("Nur für eigene Fassungen von NyxOS nötig.")}
        </p>
        {state.envLocked ? (
          <p className="text-caption text-a-mut">{t("Festgelegt über die Umgebungsvariable NYXOS_SUPPORT_URL.")}</p>
        ) : (
          <form
            className="flex min-w-0 flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSaved(false);
              save.mutate(url, { onSuccess: () => setSaved(true) });
            }}
          >
            <input
              data-nyx="support-url"
              className={cn(FIELD, "flex-1 basis-60 font-mono")}
              value={url}
              inputMode="url"
              placeholder="https://…"
              aria-label={t("Adresse der Meldestelle")}
              onChange={(e) => (setUrl(e.target.value), setSaved(false))}
            />
            <Button type="submit" data-nyx-risk="" className="min-h-11 sm:min-h-9" disabled={save.isPending}>
              {save.isPending ? t("Speichert …") : t("Speichern")}
            </Button>
          </form>
        )}
        {state.problem && <p className="text-caption text-a-wait">{state.problem}</p>}
        {saved && !save.isPending && (
          <p role="status" className="text-caption text-a-ok">
            {t("Gespeichert.")}
          </p>
        )}
        {save.isError && <p className="text-caption text-a-bad">{friendlyError(save.error, t("Nicht gespeichert – bitte noch einmal versuchen."))}</p>}
      </div>
    </details>
  );
}
