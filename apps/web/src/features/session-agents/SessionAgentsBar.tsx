// Agents bar at the bottom of the session chat (and below the terminal): "● 3 agents active · 2 done" with colored
// dots. A click opens the popup in the chat window (on the phone a sheet from the bottom) with list, archive and
// detail. Only shown when the session has agents. Live via `/live` (see api.ts).
import { t } from "@nyxos/shared";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { AgentDetailLive } from "./AgentDetailLive";
import { AgentsOverview } from "./AgentsOverview";
import { useSessionAgentsLive } from "./api";
import { agentColor, agentsPageHref, barSummary, groupAgents, type SessionRef } from "./model";

const DOTS_MAX = 8;
const POPUP_MAX_PX = 620;
const POPUP_GAP_PX = 6;
const POPUP_TOP_PX = 8;

/**
 * From `sm` on the popup hangs on the surrounding chat window (nearest positioned ancestor, see `SessionChat`): bottom
 * at the top edge of the bar, top never beyond the edge (the chat window clips overflow). On the phone it is a fixed
 * sheet from the bottom — then set no sizes.
 */
function usePopupPlacement(open: boolean, wrapper: RefObject<HTMLDivElement | null>): { style: CSSProperties | undefined; sheet: boolean } {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const [sheet, setSheet] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = wrapper.current;
      const parent = el?.offsetParent;
      const wide = typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 640px)").matches;
      setSheet(!wide);
      if (!el || !(parent instanceof HTMLElement) || !wide) {
        setStyle(undefined);
        return;
      }
      const offset = parent.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      const room = parent.clientHeight - offset - POPUP_GAP_PX - POPUP_TOP_PX;
      setStyle({ bottom: offset + POPUP_GAP_PX, maxHeight: Math.max(160, Math.min(POPUP_MAX_PX, room)) });
    };
    measure();
    window.addEventListener("resize", measure);
    // When the input grows (multi-line text) or the queue appears, the bar moves — measure again.
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    const el = wrapper.current;
    if (ro && el) {
      ro.observe(el);
      if (el.offsetParent instanceof HTMLElement) ro.observe(el.offsetParent);
    }
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [open, wrapper]);
  return { style, sheet };
}

interface SessionAgentsBarProps {
  session: SessionRef;
  className?: string;
}

export function SessionAgentsBar({ session, className }: SessionAgentsBarProps) {
  const q = useSessionAgentsLive(session.id);
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { style: placement, sheet } = usePopupPlacement(open, wrapperRef);

  const close = () => {
    setOpen(false);
    setAgentId(null);
    buttonRef.current?.focus();
  };

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Esc and a click outside also close when the focus is not in the popup (e.g. after a button in it disappeared).
  // Esc inside the popup is handled by `onKeyDown` (detail → list → closed) and stops propagation.
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault(); // do not also trigger other global Esc handlers (e.g. Nyx)
      if (agentRef.current) setAgentId(null);
      else {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) return;
      setOpen(false);
      setAgentId(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const data = q.data;
  if (!data || data.agents.length === 0) return null;
  const g = groupAgents(data, false);
  // Everything hidden in the archive → no bar (it would otherwise say "0 agents from earlier runs").
  if (g.active.length + g.finished.length + g.archive.length === 0) return null;
  const dots = [...g.active, ...g.finished].slice(0, DOTS_MAX);
  const more = g.active.length + g.finished.length - dots.length;
  const summary = barSummary(g);
  const activeNow = g.active.length > 0;

  const onKeyDown = (e: KeyboardEvent) => {
    // The phone sheet is modal: Tab stays in the sheet (the background is dimmed and not reachable).
    if (e.key === "Tab" && sheet && panelRef.current) {
      const items = [...panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      const first = items[0];
      const last = items.at(-1);
      if (first && last && e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (first && last && !e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    if (agentId) setAgentId(null);
    else close();
  };

  return (
    <div ref={wrapperRef} className={cn("shrink-0", className)} data-testid="session-agents-bar">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex min-h-[44px] w-full items-center gap-2 border-t border-a-line px-3 text-left text-caption transition-colors hover:bg-a-p2 sm:min-h-9"
      >
        <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", activeNow ? "cc-pulse bg-a-ok" : "bg-a-mut/60")} />
        <span className={cn("min-w-0 truncate", activeNow ? "text-a-ink" : "text-a-mut")}>{summary}</span>
        <span aria-hidden className="ml-auto flex shrink-0 items-center gap-1">
          {dots.map((a) => (
            <span key={a.id} className={cn("h-2 w-2 rounded-full", a.status === "running" && "cc-pulse")} style={{ background: agentColor(a), opacity: a.status === "running" ? 1 : 0.45 }} />
          ))}
          {more > 0 && <span className="font-mono text-label text-a-mut">+{more}</span>}
          <span className="ml-1 text-a-mut">{open ? "▾" : "▴"}</span>
        </span>
      </button>

      {open && (
        <>
          {/* Phone: sheet from the bottom with a dimmed background; from sm on: popup above the bar in the chat window. */}
          <div aria-hidden className="fixed inset-0 z-40 bg-black/50 sm:hidden" onClick={close} />
          <div
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-label={t("Agenten dieser Session")}
            aria-modal={sheet || undefined}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            style={placement}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border border-a-line bg-a-p pb-[env(safe-area-inset-bottom)] shadow-raise outline-none sm:absolute sm:inset-x-2 sm:z-30 sm:rounded-2xl sm:pb-0 motion-safe:animate-[cc-stagger-in_180ms_cubic-bezier(.2,.8,.2,1)_both]"
          >
            <div aria-hidden className="flex justify-center py-2 sm:hidden">
              <span className="h-1 w-10 rounded-full bg-a-line" />
            </div>
            <div className="flex items-center gap-2 border-b border-a-line px-3 pb-2 sm:pt-2">
              <h2 className="min-w-0 truncate font-display text-headline font-semibold text-a-ink">{t("Agenten")}</h2>
              <span className="truncate text-caption text-a-mut">{summary}</span>
              <Link
                to={agentsPageHref(session, agentId)}
                className="ml-auto inline-flex min-h-[44px] shrink-0 items-center rounded-md border border-a-line px-2.5 text-caption text-a-ink hover:bg-a-p2 sm:min-h-8"
              >
                {t("Vollbild")}
              </Link>
              <button type="button" onClick={close} aria-label={t("Schließen")} className="grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded-md text-a-mut hover:bg-a-p2 hover:text-a-ink sm:min-h-8 sm:min-w-8">
                ✕
              </button>
            </div>
            <div className="cc-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-3">
              {agentId ? (
                <AgentDetailLive session={session} agentId={agentId} childKeys={data.childKeys} onBack={() => setAgentId(null)} inPopup />
              ) : (
                <AgentsOverview session={session} data={data} onOpenAgent={setAgentId} inPopup />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
