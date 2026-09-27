import { type FocusEvent, type MouseEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Eigener Hinweis statt nativem `title`. Der native Hinweis des Browsers legte sich über
 * die Tab-Zeile darüber und ließ sich weder platzieren noch per z-index steuern. Dieser hier steht
 * **unter** dem Element (bzw. darüber, wenn unten kein Platz ist), bleibt seitlich im Fenster und
 * fängt keine Klicks ab (`pointer-events: none`), verdeckt also nie ein anderes Bedienelement.
 */

const SHOW_DELAY_MS = 350;
const GAP_PX = 6;
const EDGE_PX = 8;

function isFocusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

interface Anchor {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

function TooltipBubble({ id, anchor, children }: { id: string; anchor: Anchor; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const below = anchor.bottom + GAP_PX;
    const fitsBelow = below + height <= window.innerHeight - EDGE_PX;
    const top = fitsBelow ? below : Math.max(EDGE_PX, anchor.top - GAP_PX - height);
    const centered = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(EDGE_PX, centered), Math.max(EDGE_PX, window.innerWidth - width - EDGE_PX));
    setPos({ top, left });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      style={{ top: pos?.top ?? anchor.bottom + GAP_PX, left: pos?.left ?? anchor.left, visibility: pos ? "visible" : "hidden" }}
      className="pointer-events-none fixed z-50 max-w-[360px] rounded-md border border-a-line bg-a-p3 px-2 py-1 text-caption leading-snug text-a-ink shadow-lg motion-safe:animate-[cc-tab-fade_120ms_ease-out]"
    >
      {children}
    </div>,
    document.body,
  );
}

/** Hinweis an ein beliebiges Element hängen: `triggerProps` auf das Element, `tooltip` daneben rendern. */
export function useTooltip(content: ReactNode) {
  const id = useId();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const el = event.currentTarget;
    // Fokus per Maus-Klick zeigt keinen Hinweis (sonst käme er 350 ms nach jedem Klick zurück) — nur Tastatur.
    if (event.type === "focus" && !isFocusVisible(el)) return;
    clear();
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setAnchor({ top: r.top, bottom: r.bottom, left: r.left, width: r.width });
    }, SHOW_DELAY_MS);
  };
  const hide = () => {
    clear();
    setAnchor(null);
  };

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [anchor]);

  useEffect(() => clear, []);

  const active = anchor !== null && content !== null && content !== undefined && content !== "";
  return {
    triggerProps: {
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: hide,
      onPointerDown: hide,
      "aria-describedby": active ? id : undefined,
    },
    tooltip: active ? (
      <TooltipBubble id={id} anchor={anchor}>
        {content}
      </TooltipBubble>
    ) : null,
  };
}

