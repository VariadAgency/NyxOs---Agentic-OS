// Die Nyx-Leiste oben in der Kopfzeile (ersetzt „Haiku fragen …“ und den schwebenden Kreis).
//   • Klick                → Nyx-Zentrum klappt von oben herunter (wie das iOS-Kontrollzentrum).
//   • Gedrückt halten      → sprechen (Pegel in der Leiste), Loslassen schickt den Satz an Nyx.
//     Weit weggezogen, Fenster verlassen oder Esc → abgebrochen, nichts wird gesendet (wie „Wegwischen“ bei iOS).
//   • Kleines lebendiges Nyx-Logo (die Aura, `NyxAura`) = Nyx' Zustand; aus ihm startet und landet der Nyx-Cursor.
import { nyxToolDoing, t, type HaikuStatus } from "@nyxos/shared";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { cn } from "../../../lib/cn";
import { NyxAura } from "../../../components/brand/NyxAura";
import type { NyxVisualState } from "../netModel";
import { nyxStateWord } from "../stateWord";
import { NYX_ANCHOR_ATTR } from "./useBarCursor";
import "../nyx.css";

/** Ab so langer Berührung gilt es als „gedrückt halten“ (sonst Klick). */
export const HOLD_MS = 260;
/** So weit (px) außerhalb der Leiste gezogen, bricht das Halten ab (bzw. wird aus dem Klick nichts). */
export const LEAVE_PX = 48;

export interface NyxBarProps {
  open: boolean;
  onToggle: () => void;
  status: HaikuStatus | undefined;
  /** Nyx antwortet gerade (Zentrum oder Sprache). */
  busy: boolean;
  /** Offene Entscheidungen + Freigaben. */
  badge: string | null;
  /** Sortier-Vorschläge – zählen nicht in `badge`, stehen als grauer Zusatz „+2“ daneben. */
  sorting?: number;
  visual: NyxVisualState;
  toolName: string | null;
  /** Mikrofon offen (gedrückt halten). */
  talking: boolean;
  level: () => number;
  /** Nyx-Cursor ist gerade unterwegs (Symbol leuchtet, bis er zurück ist). */
  cursorOut: boolean;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  /** Halten abgebrochen (weggezogen, Fenster verlassen): Aufnahme verwerfen, nichts senden. */
  onHoldCancel: () => void;
  buttonRef: Ref<HTMLButtonElement>;
  /** Rückfall ohne Kopfzeile (Tests, eingebettete Ansicht): oben mittig schwebend. */
  floating?: boolean;
}

/**
 * Zustand in Worten + Farbe für Name, Tooltip und Anzeige. Dieselbe Zuordnung wie Nyx-Tab und
 * Nyx-Zentrum (`stateWord.ts`) – überall heißt es „bereit“, „hört zu“, „denkt nach“, „spricht“, „arbeitet“.
 */
export function barState(status: HaikuStatus | undefined, busy: boolean): { key: string; short: string; text: string; dot: string } {
  const w = nyxStateWord(status?.engine.state);
  if (!status) return { key: "unknown", short: w.word, text: w.text, dot: w.dot };
  if (busy) return { key: status.engine.state, short: t("{state} · antwortet gerade", { state: w.word }), text: "text-a-nyx", dot: "bg-a-nyx cc-pulse" };
  return { key: status.engine.state, short: w.word, text: w.text, dot: w.dot };
}

/** „2 Sortier-Vorschläge“ / „1 Sortier-Vorschlag“. */
const sortingText = (n: number) => (n === 1 ? t("1 Sortier-Vorschlag") : t("{n} Sortier-Vorschläge", { n }));

/** Was Nyx gerade tut (Wort aus `stateWord.ts`); „hört zu“ ohne Pünktchen, alles Laufende mit „…“. */
export function phaseWord(visual: NyxVisualState, toolName: string | null): string {
  if (visual === "idle") return "";
  // Nie die rohe Werkzeug-ID („nutzt server_lage“), sondern einfache Wörter („prüft den Server“).
  if (visual === "tool") return `${nyxToolDoing(toolName)} …`;
  const w = nyxStateWord("ready", visual).word;
  return visual === "listening" ? w : `${w} …`;
}

/** Fünf Pegel-Balken, pro Bild aus `level()` gelesen (keine React-Neuzeichnung). */
function LevelMeter({ level }: { level: () => number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    let raf = 0;
    const shape = [0.55, 0.85, 1, 0.8, 0.5];
    // „Bewegung reduzieren“: nur der echte Pegel, kein Zittern obendrauf.
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const el = ref.current;
      if (!el) return;
      const l = level();
      el.childNodes.forEach((n, i) => {
        const wob = calm ? 0.18 : 0.18 + 0.12 * Math.sin(now / 140 + i * 1.3);
        const h = Math.max(0.16, Math.min(1, (shape[i] ?? 1) * (l * 1.25 + wob * (0.4 + l))));
        (n as HTMLElement).style.transform = `scaleY(${h.toFixed(3)})`;
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [level]);
  return (
    <span ref={ref} data-testid="nyx-bar-level" aria-hidden="true" className="flex h-4 shrink-0 items-center gap-[3px]">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="nyx-level-bar h-4 w-[3px] origin-center rounded-full" />
      ))}
    </span>
  );
}

export function NyxBar(p: NyxBarProps) {
  const st = barState(p.status, p.busy);
  const sorting = p.sorting ?? 0;
  const ready = p.status?.engine.state === "ready";
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const suppressClick = useRef(false);

  const endHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    if (!holding.current) return;
    holding.current = false;
    suppressClick.current = true;
    p.onHoldEnd();
  };
  const cancelRef = useRef(p.onHoldCancel);
  cancelRef.current = p.onHoldCancel;
  /** Weggezogen/Fenster verlassen: weder Klick noch Senden. */
  const abortHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    suppressClick.current = true;
    if (!holding.current) return;
    holding.current = false;
    cancelRef.current();
  };
  const abortRef = useRef(abortHold);
  abortRef.current = abortHold;
  useEffect(() => {
    const onBlur = () => {
      if (holdTimer.current || holding.current) abortRef.current();
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom/alte Browser
    }
    suppressClick.current = false;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      holding.current = true;
      p.onHoldStart();
    }, HOLD_MS);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!holdTimer.current && !holding.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const out = Math.max(r.left - e.clientX, e.clientX - r.right, r.top - e.clientY, e.clientY - r.bottom);
    if (out > LEAVE_PX) abortHold();
  };

  const phase = p.talking ? "talking" : p.visual === "tool" ? "tool" : p.busy || p.visual === "thinking" ? "thinking" : p.visual === "speaking" ? "speaking" : "idle";
  const phaseText = phaseWord(p.visual, p.toolName);

  return (
    <button
      ref={p.buttonRef}
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endHold}
      onPointerCancel={endHold}
      onLostPointerCapture={endHold}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        p.onToggle();
      }}
      aria-expanded={p.open}
      aria-haspopup="dialog"
      aria-label={`${t("Nyx öffnen (⌘J) – gedrückt halten zum Sprechen (⌥ Leertaste) – {state}", { state: st.short })}${p.badge ? `, ${t("{n} offen", { n: p.badge })}` : ""}${sorting > 0 ? `, ${sortingText(sorting)}` : ""}`}
      title={t("Nyx – klicken öffnet das Zentrum (⌘J), gedrückt halten zum Sprechen (⌥ Leertaste) · {state}", { state: st.short })}
      data-engine-state={st.key}
      data-nyx="nyx-chat"
      data-testid="nyx-bar"
      data-phase={phase}
      data-busy={p.busy ? "true" : undefined}
      className={cn(
        "nyx-bar @container/haiku relative flex min-w-0 select-none items-center gap-2 border text-left [-webkit-touch-callout:none] [touch-action:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-nyx",
        p.floating
          ? "fixed left-1/2 top-2 z-30 h-10 w-[340px] max-w-[calc(100vw-24px)] -translate-x-1/2 rounded-full pl-1.5 pr-2 shadow-[0_14px_30px_rgba(0,0,0,.55)]"
          : // Breite gibt die Kopfzeile vor (`TopBar`, 84–360 px); Höhe wie alle Kopf-Bedienelemente.
            "h-(--a-ctl-h) w-full overflow-hidden rounded-full pl-1 pr-1.5",
        p.open && "nyx-bar-open",
      )}
    >
      <span {...{ [NYX_ANCHOR_ATTR]: "" }} aria-hidden="true" className={cn("nyx-bar-net relative grid h-[24px] w-[24px] shrink-0 place-items-center rounded-full", p.cursorOut && "nyx-bar-net-out")}>
        <NyxAura state={p.talking ? "listening" : p.visual === "idle" && p.busy ? "thinking" : p.visual} size={24} />
        <span className={cn("absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-[1.5px] border-a-p2", st.dot)} />
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-caption @max-[130px]/haiku:gap-1">
        {p.talking ? (
          <>
            <LevelMeter level={p.level} />
            <span className="truncate text-a-ink">
              <span className="@max-[200px]/haiku:hidden">{t("Ich höre zu – loslassen zum Senden")}</span>
              <span className="hidden @max-[200px]/haiku:inline">{t("hört zu")}</span>
            </span>
          </>
        ) : phaseText ? (
          <span className="truncate text-a-nyx">
            <span className="@max-[130px]/haiku:hidden">Nyx </span>
            {phaseText}
          </span>
        ) : ready && !p.busy ? (
          <>
            <span className="truncate text-a-mut @max-[130px]/haiku:hidden">
              <span className="@max-[230px]/haiku:hidden">{t("Nyx fragen – halten zum Sprechen")}</span>
              <span className="hidden @max-[230px]/haiku:inline">Nyx</span>
            </span>
            {/* Zustand in der Textschrift (vorher grüne Monoschrift wie ein Terminal). */}
            <span className={cn("shrink-0 text-caption @min-[300px]/haiku:hidden", st.text)}>
              <span className="@max-[130px]/haiku:hidden">· </span>
              {st.short}
            </span>
          </>
        ) : (
          <span className={cn("truncate", st.text)}>
            <span className="@max-[130px]/haiku:hidden">Nyx </span>
            {p.busy ? t("antwortet …") : st.short}
          </span>
        )}
      </span>
      {p.badge && (
        <span
          aria-hidden="true"
          data-testid="nyx-bar-badge"
          className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-a-wait px-1 font-mono text-label font-semibold text-a-bg @max-[130px]/haiku:absolute @max-[130px]/haiku:top-0 @max-[130px]/haiku:left-[19px] @max-[130px]/haiku:h-3.5 @max-[130px]/haiku:min-w-3.5 @max-[130px]/haiku:px-0.5 @max-[130px]/haiku:text-label @max-[130px]/haiku:leading-none"
        >
          {p.badge}
        </span>
      )}
      {sorting > 0 && (
        <span
          aria-label={sortingText(sorting)}
          data-testid="nyx-bar-sorting"
          className="shrink-0 font-mono text-label tabular-nums text-a-mut @max-[130px]/haiku:hidden"
        >
          +{sorting > 99 ? "99+" : sorting}
        </span>
      )}
      <kbd aria-hidden="true" className="shrink-0 rounded border border-a-line px-1.5 py-px font-mono text-label text-a-mut @max-[200px]/haiku:hidden">
        ⌘J
      </kbd>
    </button>
  );
}
