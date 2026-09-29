// Der zweite Cursor (Nyx-Cursor) entsteht aus der Nyx-Leiste. Er löst sich vom Netz-Symbol in der
// Leiste, fliegt auf einer leicht gebogenen Bahn zum Ziel, klickt (Welle) und fliegt danach zurück in die Leiste,
// wo er wieder im Symbol verschwindet. Riskante Ziele bekommen nur Glow (entscheidet `uiExecutor`).
// Bewegung in Refs + rAF (keine React-Neuzeichnung je Bild); ohne Bild-Takt landet er per Zeitgeber trotzdem.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NyxCursorDriver } from "../uiExecutor";

/** Zeigt den Nyx-Cursor im Netz-Symbol der Leiste an (Start- und Landepunkt). */
export const NYX_ANCHOR_ATTR = "data-nyx-anchor";
/** So lange nach dem letzten Schritt wartet der Cursor, bevor er zurück in die Leiste fliegt. */
const RETURN_AFTER_MS = 700;

type Vec = { x: number; y: number };

interface Flight {
  from: Vec;
  ctrl: Vec;
  to: Vec;
  start: number;
  dur: number;
  done: () => void;
}

interface Highlight {
  id: number;
  rect: { left: number; top: number; width: number; height: number };
  risk: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reducedMotion = () => (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) ?? false;

/** Mitte des Netz-Symbols in der Leiste (Start/Landung); ohne Leiste oben mittig. */
export function anchorPoint(): Vec {
  const el = typeof document !== "undefined" ? document.querySelector(`[${NYX_ANCHOR_ATTR}]`) : null;
  const r = el?.getBoundingClientRect();
  if (r && (r.width > 0 || r.height > 0)) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  return { x: typeof window !== "undefined" ? window.innerWidth / 2 : 640, y: 24 };
}

/** Der Nyx-Cursor: Pfeil in Nyx-Farbe, Spitze genau auf dem Zielpunkt. */
function CursorGlyph() {
  return (
    <svg className="nyx-cursor-glyph" width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">
      <defs>
        <linearGradient id="nyx-bar-cursor-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--a-nyx-2)" />
          <stop offset="1" stopColor="var(--a-nyx)" />
        </linearGradient>
      </defs>
      <path d="M2 2 L2 24 L8.2 18.4 L12.4 27.6 L16.6 25.7 L12.5 16.8 L21 16.4 Z" fill="url(#nyx-bar-cursor-fill)" style={{ stroke: "var(--a-bg)" }} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export interface BarCursor {
  driver: NyxCursorDriver;
  /** Nach dem letzten Schritt: kurz warten, dann zurück in die Leiste. */
  release(): void;
  /** „docked“ = im Symbol der Leiste, „out“ = unterwegs/am Ziel. */
  mode: "docked" | "out";
  layer: ReactNode;
}

export function useBarCursor(): BarCursor {
  const [mode, setMode] = useState<"docked" | "out">("docked");
  const [pressed, setPressed] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [ripple, setRipple] = useState<{ id: number; x: number; y: number } | null>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<SVGPolylineElement>(null);
  const m = useRef({ pos: anchorPoint(), flight: null as Flight | null, trail: [] as (Vec & { t: number })[], raf: 0, out: false, returning: false });
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const paint = useCallback(() => {
    const el = elRef.current;
    if (el) el.style.transform = `translate3d(${m.current.pos.x.toFixed(1)}px, ${m.current.pos.y.toFixed(1)}px, 0)`;
    const line = trailRef.current;
    if (line) line.setAttribute("points", m.current.trail.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
  }, []);

  // Bild-Takt nur, solange etwas fliegt oder der Schweif verblasst.
  const tick = useCallback(
    (now: number) => {
      const s = m.current;
      s.raf = 0;
      const f = s.flight;
      if (f) {
        const t = clamp((now - f.start) / f.dur, 0, 1);
        const k = easeInOut(t);
        const u = 1 - k;
        s.pos = { x: u * u * f.from.x + 2 * u * k * f.ctrl.x + k * k * f.to.x, y: u * u * f.from.y + 2 * u * k * f.ctrl.y + k * k * f.to.y };
        s.trail.push({ ...s.pos, t: now });
        if (t >= 1) {
          s.flight = null;
          f.done();
        }
      }
      s.trail = s.trail.filter((p) => now - p.t < 360);
      paint();
      if ((s.flight || s.trail.length > 0) && typeof requestAnimationFrame !== "undefined") s.raf = requestAnimationFrame(tick);
    },
    [paint],
  );
  const kick = useCallback(() => {
    if (m.current.raf || typeof requestAnimationFrame === "undefined") return;
    m.current.raf = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(
    () => () => {
      if (m.current.raf) cancelAnimationFrame(m.current.raf);
      if (returnTimer.current) clearTimeout(returnTimer.current);
    },
    [],
  );

  const fly = useCallback(
    (to: Vec, pauseAfter = 50): Promise<void> => {
      const s = m.current;
      const from = { ...s.pos };
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      if (reducedMotion() || dist < 2) {
        s.pos = to;
        paint();
        return new Promise((r) => setTimeout(r, 60));
      }
      // Leicht gebogene Bahn (wie eine Hand, nicht wie ein Lineal).
      const nx = -(to.y - from.y) / dist;
      const ny = (to.x - from.x) / dist;
      const bend = Math.min(110, dist * 0.22) * (to.x < from.x ? 1 : -1);
      const ctrl = { x: (from.x + to.x) / 2 + nx * bend, y: (from.y + to.y) / 2 + ny * bend };
      // Schnell – 250–400 ms je Sprung (mit Ease-in-out), damit mehrstufige Wege nicht zäh wirken.
      const dur = clamp(220 + dist * 0.2, 250, 400);
      return new Promise<void>((resolve) => {
        s.flight?.done();
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          setTimeout(resolve, pauseAfter);
        };
        const flight: Flight = { from, ctrl, to, start: performance.now(), dur, done };
        s.flight = flight;
        kick();
        // Sicherheitsnetz: läuft kein Bild-Takt (Hintergrund-Tab, Testumgebung), landet der Cursor trotzdem.
        setTimeout(() => {
          if (s.flight !== flight) return;
          s.flight = null;
          s.pos = to;
          paint();
          done();
        }, dur + 400);
      });
    },
    [kick, paint],
  );

  const flyTo = useCallback(
    async (x: number, y: number) => {
      if (returnTimer.current) clearTimeout(returnTimer.current);
      const s = m.current;
      // Ein neuer Auftrag kam während des Rückflugs: der Cursor bleibt draußen und fliegt von hier weiter.
      s.returning = false;
      if (!s.out) {
        // Aus der Leiste lösen: am Netz-Symbol erscheinen, dann los.
        s.out = true;
        s.pos = anchorPoint();
        paint();
        setMode("out");
        await new Promise((r) => setTimeout(r, reducedMotion() ? 0 : 90));
      }
      await fly({ x, y });
    },
    [fly, paint],
  );

  const release = useCallback(() => {
    if (returnTimer.current) clearTimeout(returnTimer.current);
    returnTimer.current = setTimeout(() => {
      if (!m.current.out) return;
      m.current.returning = true;
      void fly(anchorPoint(), 0).then(() => {
        if (!m.current.returning) return;
        m.current.returning = false;
        m.current.out = false;
        setMode("docked");
      });
    }, RETURN_AFTER_MS);
  }, [fly]);

  const driver: NyxCursorDriver = useMemo(
    () => ({
      flyTo,
      press: async () => {
        const p = m.current.pos;
        setPressed(true);
        setRipple({ id: Date.now(), x: p.x, y: p.y });
        await new Promise((r) => setTimeout(r, 110));
        setPressed(false);
      },
      glow: (rect, ms = 2400, risk = false) => {
        const id = Date.now() + Math.random();
        setHighlights((hs) => [...hs, { id, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, risk }]);
        setTimeout(() => setHighlights((hs) => hs.filter((h) => h.id !== id)), ms);
      },
    }),
    [flyTo],
  );

  const layer = (
    <>
      <svg className="pointer-events-none fixed inset-0 z-[79] h-full w-full" aria-hidden="true">
        <defs>
          <linearGradient id="nyx-bar-trail" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--a-nyx-2)" stopOpacity="0.1" />
            <stop offset="1" stopColor="var(--a-nyx)" stopOpacity="0.85" />
          </linearGradient>
        </defs>
        <polyline ref={trailRef} fill="none" stroke="url(#nyx-bar-trail)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 6px var(--a-nyx))" }} />
      </svg>
      {highlights.map((h) => (
        <div
          key={h.id}
          data-testid="nyx-highlight"
          className="nyx-glow-target pointer-events-none fixed z-[78]"
          data-risk={h.risk ? "true" : "false"}
          style={{ left: h.rect.left - 4, top: h.rect.top - 4, width: h.rect.width + 8, height: h.rect.height + 8 }}
        />
      ))}
      {ripple && <div key={ripple.id} className="nyx-ripple pointer-events-none fixed z-[79]" style={{ left: ripple.x, top: ripple.y }} onAnimationEnd={() => setRipple(null)} />}
      <div
        ref={elRef}
        data-testid="nyx-cursor"
        data-mode={mode}
        data-press={pressed ? "true" : "false"}
        className="nyx-bar-cursor pointer-events-none fixed left-0 top-0 z-[80]"
        style={{ transform: `translate3d(${m.current.pos.x}px, ${m.current.pos.y}px, 0)` }}
        aria-hidden="true"
      >
        <CursorGlyph />
      </div>
    </>
  );

  return { driver, release, mode, layer };
}
