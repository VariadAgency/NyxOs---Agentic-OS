// Focus button – like the Focus modes on macOS/iOS: a small button at the bottom of the sidebar (on the phone in the
// "More" drawer) or a row in Settings → Notifications. A click opens a menu (desktop: floating above the button, phone:
// sheet from the bottom): auto · away · do not disturb, one sentence each, plus the duration. The end of a duration is
// computed here, in the viewer's time zone, and sent as `until` (the server may run in another zone).
import { DEFAULT_FOCUS_STATE, FOCUS_MODES, focusEveningAvailable, focusModeMeta, focusUntilFor, focusUntilLabel, t, type FocusDuration, type FocusMode, type FocusPut, type FocusState } from "@nyxos/shared";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useInRouterContext } from "react-router";
import { useAppMode } from "../../hooks/useAppInfo";
import { cn } from "../../lib/cn";
import { toneVar } from "../../lib/tones";
import { useFocus, useSetFocus } from "./api";

const MENU_W = 300;
const GAP = 8;
/** How long the confirmation stays before the menu closes by itself. */
const CONFIRM_MS = 1100;
const MOBILE_QUERY = "(max-width: 767px)";
export const FOCUS_SETTINGS_HREF = "/settings/mitteilungen#fokus";

function isMobile(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches;
}

/** "Nicht stören · bis 19:00" or "Automatisch". */
export function focusSummary(state: FocusState, now = new Date()): string {
  const meta = focusModeMeta(state.mode);
  const until = focusUntilLabel(state, now);
  return until ? `${meta.label} · ${until}` : meta.label;
}

function durationChoices(now: Date): { id: FocusDuration; label: string }[] {
  return [
    { id: "1h", label: t("1 Stunde") },
    focusEveningAvailable(now) ? { id: "evening", label: t("Bis heute Abend") } : { id: "morning", label: t("Bis morgen früh") },
    { id: "manual", label: t("Bis ich es ausschalte") },
  ];
}

interface MenuProps {
  state: FocusState;
  anchor: HTMLElement | null;
  onClose: () => void;
}

function FocusMenu({ state, anchor, onClose }: MenuProps) {
  const setFocus = useSetFocus();
  const [pending, setPending] = useState<FocusMode | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [mobile] = useState(isMobile);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inRouter = useInRouterContext();
  const local = useAppMode() === "local";

  useLayoutEffect(() => {
    if (mobile || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - MENU_W - GAP));
    setPos({ left, bottom: Math.max(GAP, window.innerHeight - r.top + GAP) });
  }, [anchor, mobile]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
  }, []);

  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(onClose, CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirm, onClose]);

  const choose = (mode: FocusMode, duration?: FocusDuration) => {
    const until = mode === "auto" || !duration ? null : focusUntilFor(duration, new Date());
    const body: FocusPut = mode === "auto" ? { mode } : until ? { mode, duration, until } : { mode, duration };
    setFocus.mutate(body, {
      onSuccess: (data) => {
        setPending(null);
        setConfirm(data.state.mode === "auto" ? t("Automatisch – NyxOS erkennt wieder selbst, ob du da bist.") : t("{summary} – an.", { summary: focusSummary(data.state) }));
      },
    });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-focus-item]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    e.preventDefault();
  };

  const now = new Date();
  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("Fokus wählen")}
      data-testid="focus-menu"
      onKeyDown={onKey}
      style={mobile ? undefined : { left: pos?.left ?? -9999, bottom: pos?.bottom ?? -9999, width: MENU_W }}
      className={cn(
        "cc-rise fixed z-[70] grid gap-1 border border-a-line bg-a-p2 p-2 shadow-[0_18px_40px_rgba(0,0,0,.55)]",
        mobile ? "inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl pb-[max(12px,env(safe-area-inset-bottom))]" : "rounded-xl",
      )}
    >
      {mobile && <span aria-hidden="true" className="mx-auto mb-1 h-1 w-9 rounded-full bg-a-line" />}
      <div className="flex items-baseline justify-between gap-2 px-2 pb-1 pt-0.5">
        <span className="text-headline font-semibold text-a-ink">{t("Fokus")}</span>
        <span className="text-caption text-a-mut">{focusSummary(state, now)}</span>
      </div>
      <div role="radiogroup" aria-label={t("Fokus")} className="grid gap-1">
        {FOCUS_MODES.map((mode) => {
          const meta = focusModeMeta(mode, { local });
          const active = state.mode === mode;
          const open = pending === mode;
          return (
            <div key={mode} className="grid gap-1">
              <button
                type="button"
                role="radio"
                aria-checked={active}
                data-focus-item
                data-testid={`focus-mode-${mode}`}
                disabled={setFocus.isPending}
                onClick={() => (mode === "auto" ? choose("auto") : setPending(open ? null : mode))}
                style={active ? { borderColor: toneVar(meta.tone) } : undefined}
                className={cn(
                  "flex min-h-11 w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors duration-150",
                  active ? "bg-a-p3" : "border-transparent hover:bg-a-p3",
                )}
              >
                <span aria-hidden="true" className="mt-px w-4 text-center text-callout" style={{ color: toneVar(meta.tone) }}>
                  {meta.icon}
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex items-center gap-1.5 text-callout font-medium text-a-ink">
                    {meta.label}
                    {active && (
                      <span className="rounded px-1 text-label font-semibold" style={{ color: toneVar(meta.tone) }}>
                        {mode === "auto" ? t("aktiv") : focusUntilLabel(state, now) || t("an")}
                      </span>
                    )}
                  </span>
                  <span className="text-caption text-a-mut">{meta.sentence}</span>
                </span>
              </button>
              {open && (
                <div role="group" aria-label={t("{mode} – wie lange?", { mode: meta.label })} className="flex flex-wrap gap-1.5 pb-1 pl-9 pr-1">
                  {durationChoices(now).map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      data-focus-item
                      data-testid={`focus-duration-${d.id}`}
                      disabled={setFocus.isPending}
                      onClick={() => choose(mode, d.id)}
                      className="min-h-11 rounded-lg border border-a-line bg-a-p3 px-3 text-caption text-a-ink hover:border-a-acc md:min-h-8"
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div role="status" aria-live="polite" className="min-h-5 px-2 text-caption">
        {confirm ? <span className="text-a-ok">{confirm}</span> : setFocus.isError ? <span className="text-a-bad">{setFocus.error.message}</span> : null}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-a-line px-2 pt-1.5">
        {inRouter ? (
          <Link to={FOCUS_SETTINGS_HREF} onClick={onClose} className="py-2 text-caption text-a-acc hover:text-a-ink">
            {t("Mehr in den Einstellungen →")}
          </Link>
        ) : (
          <a href={FOCUS_SETTINGS_HREF} className="py-2 text-caption text-a-acc hover:text-a-ink">
            {t("Mehr in den Einstellungen →")}
          </a>
        )}
        <button type="button" onClick={onClose} className="min-h-11 px-2 text-caption text-a-mut hover:text-a-ink md:min-h-8">
          {t("Schließen")}
        </button>
      </div>
    </div>
  );

  return createPortal(
    <>
      <div aria-hidden="true" data-testid="focus-backdrop" onClick={onClose} className={cn("fixed inset-0 z-[69]", mobile && "bg-black/45")} />
      {panel}
    </>,
    document.body,
  );
}

/**
 * The button. `sidebar`: small (icon + short name; auto only the icon). `panel`: row for the settings with the sentence
 * and "Ändern".
 */
export function FocusControl({ variant = "sidebar" }: { variant?: "sidebar" | "panel" }) {
  const { data } = useFocus();
  const state = data?.state ?? DEFAULT_FOCUS_STATE;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);
  const local = useAppMode() === "local";
  const meta = focusModeMeta(state.mode, { local });
  const summary = focusSummary(state);
  const until = focusUntilLabel(state, new Date());

  if (variant === "panel") {
    return (
      <div className="grid gap-2 rounded-xl border border-a-line bg-a-p p-3" data-testid="focus-panel">
        <div className="flex items-start gap-2.5">
          <span aria-hidden="true" className="mt-px w-4 text-center text-callout" style={{ color: toneVar(meta.tone) }}>
            {meta.icon}
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-callout font-medium text-a-ink">{t("Fokus: {summary}", { summary })}</span>
            <span className="text-caption text-a-mut">{meta.sentence}</span>
            <span className="text-caption text-a-mut">{t("Den Fokus stellst du auch unten links in der Leiste um (am Handy unter „Mehr“) – oder sag Nyx: „Ich bin weg bis 18 Uhr“.")}</span>
          </span>
          <button
            ref={btnRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="min-h-11 shrink-0 rounded-lg border border-a-line bg-a-p3 px-3 text-caption text-a-ink hover:border-a-acc md:min-h-8"
          >
            {t("Ändern")}
          </button>
        </div>
        {open && <FocusMenu state={state} anchor={btnRef.current} onClose={close} />}
      </div>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid="focus-button"
        data-mode={state.mode}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("Fokus: {summary}", { summary })}
        title={t("Fokus: {summary}", { summary })}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex min-h-8 max-w-full items-center gap-1.5 self-start rounded-lg px-2 text-caption transition-colors duration-150 hover:bg-a-p2 max-md:min-h-11",
          state.mode === "auto" ? "text-a-mut" : "text-a-ink",
        )}
      >
        <span aria-hidden="true" className="w-4 text-center text-callout" style={{ color: toneVar(meta.tone) }}>
          {meta.icon}
        </span>
        {state.mode !== "auto" && (
          <span className="truncate">
            {meta.short}
            {/* "bis du es ausschaltest" doesn't fit the narrow sidebar – it is in the menu and the tooltip. */}
            {until && state.until !== null && <span className="text-a-mut"> · {until}</span>}
          </span>
        )}
      </button>
      {open && <FocusMenu state={state} anchor={btnRef.current} onClose={close} />}
    </>
  );
}

export function FocusSettingsPanel() {
  return <FocusControl variant="panel" />;
}
