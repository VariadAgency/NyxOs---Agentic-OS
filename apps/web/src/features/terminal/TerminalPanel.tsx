import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { t } from "@nyxos/shared";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import type { Session } from "../../lib/api";
import { matchesQuery, PHONE_QUERY, useMediaQuery, useTouch } from "../../hooks/useMediaQuery";
import { TakeoverButton } from "./TakeoverButton";
import { TerminalKeys } from "./TerminalKeys";
import { useBridgeStatus } from "./terminalApi";
import { NOT_IN_NYXOS_TEXT, NOT_RUNNING_TEXT, runsOutside, useTerminal, type TermState } from "./useTerminal";

const STATE_TEXT: Record<TermState, { label: string; dot: string }> = {
  connecting: { label: t("verbinde …"), dot: "bg-a-wait" },
  connected: { label: t("verbunden"), dot: "bg-a-ok" },
  reconnecting: { label: t("verbinde neu …"), dot: "bg-a-wait animate-pulse" },
  offline: { label: t("Brücke offline"), dot: "bg-a-bad" },
  ended: { label: t("beendet"), dot: "bg-a-idle" },
  not_attachable: { label: t("läuft in einem eigenen Fenster"), dot: "bg-a-wait" },
  login: { label: t("Anmeldung nötig"), dot: "bg-a-wait" },
};

/** Standard „Nur ansehen": an bei Sessions aus dem Terminal-Programm, aus bei Sessions aus der NyxOS. */
export const defaultReadOnly = (s: Pick<Session, "startedVia">) => s.startedVia !== "nyxos";

// Schriftgröße je Gerät (Handy kleiner, damit genug Spalten passen), per A−/A+ und Zwei-Finger-Zoom.
export const TERM_FONT_KEY = "nyx.terminal.fontSize";
export const TERM_FONT_MIN = 8;
export const TERM_FONT_MAX = 22;
const clampFont = (n: number) => Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, Math.round(n)));

function readFontSize(): number {
  try {
    const v = Number(localStorage.getItem(TERM_FONT_KEY));
    if (v >= TERM_FONT_MIN && v <= TERM_FONT_MAX) return v;
  } catch {
    // private window or similar
  }
  return matchesQuery(PHONE_QUERY) ? 11 : 13;
}

function writeFontSize(n: number): void {
  try {
    localStorage.setItem(TERM_FONT_KEY, String(n));
  } catch {
    // never mind – then it only lasts until the next reload
  }
}

/** Copying also without a secure connection (e.g. `http://<ip>` in the home network): fall back to the old way. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

/** Reiter „Terminal" im Session-Vollbild. Läuft die Session in einem eigenen Fenster,
 * erklärt der Reiter das in einem Satz und bietet „In der NyxOS übernehmen“ an; danach verbindet er von selbst.
 * On touch devices with a key row (Esc, Tab, Ctrl, arrows, Ctrl-C …), copy/paste buttons and font size via A−/A+
 * or two-finger zoom. */
export function TerminalPanel({ session, onWatch }: { session: Session; onWatch?: () => void }) {
  const bridge = useBridgeStatus();
  const bridgeOnline = bridge.data?.online ?? false;
  const [readOnly, setReadOnly] = useState(() => defaultReadOnly(session));
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [note, setNote] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const touch = useTouch();
  const phone = useMediaQuery(PHONE_QUERY);
  const showKeys = touch || phone;
  const inNyxOS = session.attachable && !!session.tmuxName;
  const term = useTerminal({ sessionId: session.id, readOnly, bridgeOnline, enabled: inNyxOS, attachKey: session.tmuxName, fontSize });
  const outside = runsOutside(session.state);
  const st = term.state === "not_attachable" && !outside ? { label: t("läuft gerade nicht"), dot: "bg-a-idle" } : STATE_TEXT[term.state];
  const canType = term.state === "connected" && !readOnly;

  // Nach dem Übernehmen ist die Session „aus der NyxOS gestartet“ → Tippen statt „Nur ansehen“.
  useEffect(() => {
    setReadOnly(defaultReadOnly(session));
  }, [session.startedVia]);

  // Am Rechner sofort tippen können; auf dem Handy nicht ungefragt die Tastatur hochholen (verdeckt das halbe Bild).
  useEffect(() => {
    if (term.state === "connected" && !showKeys) term.focus();
  }, [term.state]);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 1800);
    return () => clearTimeout(id);
  }, [note]);

  const changeFont = (next: number) => {
    const n = clampFont(next);
    setFontSize(n);
    writeFontSize(n);
  };

  // Zwei-Finger-Zoom im Terminal = Schriftgröße (statt die ganze Seite zu vergrößern).
  const pinch = useRef<{ dist: number; base: number } | null>(null);
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;
  useEffect(() => {
    const host = term.hostRef.current;
    if (!host) return;
    const dist = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch.current = { dist: dist(e), base: fontRef.current };
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !pinch.current || pinch.current.dist === 0) return;
      e.preventDefault();
      const next = clampFont(pinch.current.base * (dist(e) / pinch.current.dist));
      if (next !== fontRef.current) setFontSize(next);
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2 && pinch.current) {
        pinch.current = null;
        writeFontSize(fontRef.current);
      }
    };
    host.addEventListener("touchstart", onStart, { passive: true });
    host.addEventListener("touchmove", onMove, { passive: false });
    host.addEventListener("touchend", onEnd);
    host.addEventListener("touchcancel", onEnd);
    return () => {
      host.removeEventListener("touchstart", onStart);
      host.removeEventListener("touchmove", onMove);
      host.removeEventListener("touchend", onEnd);
      host.removeEventListener("touchcancel", onEnd);
    };
  }, [term.hostRef]);

  const copy = async () => {
    const { text, what } = term.copyText();
    if (!text) return setNote(t("Nichts zum Kopieren"));
    setNote((await copyToClipboard(text)) ? (what === "selection" ? t("Auswahl kopiert") : t("Bildschirm kopiert")) : t("Kopieren ging nicht"));
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        term.paste(text);
        setNote(t("Eingefügt"));
        return;
      }
    } catch {
      // no access (http, denied) → own field, „Einfügen“ by long press always works there
    }
    setPasteOpen(true);
  };

  return (
    <div className="grid h-full min-h-[420px] min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] overflow-hidden rounded-lg max-md:min-h-0 max-md:rounded-none" data-testid="terminal-panel" data-state={term.state}>
      <div className="flex flex-wrap items-center gap-2 border-b border-a-line px-3 py-1.5 text-caption">
        <span className="inline-flex items-center gap-1.5 text-a-mut" role="status" aria-live="polite" title={session.tmuxName ?? undefined}>
          <span className={cn("h-2 w-2 rounded-full", st.dot)} />
          {note ?? st.label}
        </span>
        <span className="flex-1" />
        {searchOpen && (
          <input
            autoFocus
            value={query}
            placeholder={t("Im Verlauf suchen")}
            aria-label={t("Im Verlauf suchen")}
            enterKeyHint="search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.shiftKey ? term.findPrevious : term.findNext)(query);
              if (e.key === "Escape") {
                setSearchOpen(false);
                term.focus();
              }
            }}
            className="w-44 rounded-md border border-a-line bg-a-p2 px-2 py-1 text-caption text-a-ink outline-none focus:border-a-acc max-md:order-last max-md:w-full"
          />
        )}
        {searchOpen && showKeys && (
          <span className="flex gap-1 max-md:order-last">
            <Button onClick={() => term.findPrevious(query)} aria-label={t("Vorheriger Treffer")} className="cc-hit">
              ↑
            </Button>
            <Button onClick={() => term.findNext(query)} aria-label={t("Nächster Treffer")} className="cc-hit">
              ↓
            </Button>
          </span>
        )}
        <Button variant="ghost" onClick={() => setSearchOpen((o) => !o)} title={t("Im Verlauf suchen")} className="cc-hit">
          {t("Suchen")}
        </Button>
        <span className="inline-flex items-center" role="group" aria-label={t("Schriftgröße")}>
          <Button variant="ghost" onClick={() => changeFont(fontSize - 1)} disabled={fontSize <= TERM_FONT_MIN} aria-label={t("Schrift kleiner")} title={t("Schrift kleiner (oder mit zwei Fingern zusammenziehen)")} className="cc-hit px-2">
            A−
          </Button>
          <Button variant="ghost" onClick={() => changeFont(fontSize + 1)} disabled={fontSize >= TERM_FONT_MAX} aria-label={t("Schrift größer")} title={t("Schrift größer (oder mit zwei Fingern aufziehen)")} className="cc-hit px-2">
            A+
          </Button>
        </span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-a-mut max-md:min-h-11" title={t("Nur mitlesen, keine Eingaben senden")}>
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} className="accent-[var(--a-acc)] max-md:h-5 max-md:w-5" />
          {t("Nur ansehen")}
        </label>
      </div>
      <div className="relative min-h-0 overflow-hidden bg-a-bg">
        <div
          ref={term.hostRef}
          className="absolute inset-0 overflow-auto px-2 py-1.5 max-md:px-1"
          onKeyDownCapture={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
              e.preventDefault();
              setSearchOpen(true);
            }
          }}
        />
        {term.state !== "connected" && term.state !== "connecting" && term.state !== "reconnecting" && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-a-bg/80 backdrop-blur-[1px]">
            <div className="grid max-w-md justify-items-center gap-2 px-4 text-center text-caption">
              <p className="text-a-ink">{term.state === "offline" ? t("Die Brücke ist gerade nicht verbunden.") : term.state === "not_attachable" ? (outside ? NOT_IN_NYXOS_TEXT : NOT_RUNNING_TEXT) : term.message}</p>
              {term.state === "offline" && <p className="text-a-mut">{t("Sobald die Brücke wieder da ist, verbindet sich das Terminal von selbst.")}</p>}
              {term.state === "not_attachable" && (
                <div className="flex flex-wrap justify-center gap-2">
                  <TakeoverButton session={session} onWatch={onWatch} onDone={term.retry} />
                </div>
              )}
              {term.state === "login" && <Button onClick={term.retry}>{t("Erneut verbinden")}</Button>}
            </div>
          </div>
        )}
      </div>
      {showKeys ? (
        <div className="grid">
          {pasteOpen && (
            <form
              className="flex items-end gap-1.5 border-t border-a-line bg-a-p px-2 py-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (pasteText) term.paste(pasteText);
                setPasteText("");
                setPasteOpen(false);
              }}
            >
              <textarea
                autoFocus
                rows={2}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                aria-label={t("Text zum Einfügen")}
                placeholder={t("Lange drücken → Einfügen, dann „Senden“")}
                className="min-w-0 flex-1 resize-none rounded-md border border-a-line bg-a-p2 px-2 py-1.5 text-a-ink outline-none focus:border-a-acc"
              />
              <Button variant="primary" type="submit" disabled={!pasteText} className="h-11">
                {t("Senden")}
              </Button>
              <Button variant="ghost" onClick={() => setPasteOpen(false)} aria-label={t("Einfügen abbrechen")} className="h-11">
                ✕
              </Button>
            </form>
          )}
          <TerminalKeys disabled={!canType} ctrlArmed={term.ctrlArmed} onCtrlToggle={term.toggleCtrl} onSend={term.sendInput} appCursor={term.appCursor}>
            <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => void paste()} disabled={!canType} className="grid h-11 shrink-0 place-items-center rounded-lg border border-a-line bg-a-p3 px-3 text-caption text-a-ink active:bg-a-p2 disabled:opacity-40">
              {t("Einfügen")}
            </button>
            <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => void copy()} disabled={term.state !== "connected"} className="grid h-11 shrink-0 place-items-center rounded-lg border border-a-line bg-a-p3 px-3 text-caption text-a-ink active:bg-a-p2 disabled:opacity-40">
              {t("Kopieren")}
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => term.focus()}
              disabled={!canType}
              aria-label={t("Tastatur zeigen")}
              className="grid h-11 shrink-0 place-items-center rounded-lg border border-a-line bg-a-p3 px-3 text-caption text-a-ink active:bg-a-p2 disabled:opacity-40"
            >
              ⌨
            </button>
          </TerminalKeys>
          {readOnly && term.state === "connected" && (
            <p className="border-t border-a-line bg-a-p px-3 py-1.5 text-caption text-a-mut">{t("„Nur ansehen“ ist an – zum Tippen oben ausschalten.")}</p>
          )}
        </div>
      ) : (
        <span aria-hidden="true" />
      )}
    </div>
  );
}
