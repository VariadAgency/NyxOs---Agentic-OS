import "@xterm/xterm/css/xterm.css";
import { useEffect, useState } from "react";
import { t } from "@nyxos/shared";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import type { Session } from "../../lib/api";
import { TakeoverButton } from "./TakeoverButton";
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

/** Reiter „Terminal" im Session-Vollbild. Läuft die Session in einem eigenen Fenster,
 * erklärt der Reiter das in einem Satz und bietet „In der NyxOS übernehmen“ an; danach verbindet er von selbst. */
export function TerminalPanel({ session, onWatch }: { session: Session; onWatch?: () => void }) {
  const bridge = useBridgeStatus();
  const bridgeOnline = bridge.data?.online ?? false;
  const [readOnly, setReadOnly] = useState(() => defaultReadOnly(session));
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const inNyxOS = session.attachable && !!session.tmuxName;
  const term = useTerminal({ sessionId: session.id, readOnly, bridgeOnline, enabled: inNyxOS, attachKey: session.tmuxName });
  const outside = runsOutside(session.state);
  const st = term.state === "not_attachable" && !outside ? { label: t("läuft gerade nicht"), dot: "bg-a-idle" } : STATE_TEXT[term.state];

  // Nach dem Übernehmen ist die Session „aus der NyxOS gestartet“ → Tippen statt „Nur ansehen“.
  useEffect(() => {
    setReadOnly(defaultReadOnly(session));
  }, [session.startedVia]);

  useEffect(() => {
    if (term.state === "connected") term.focus();
  }, [term.state]);

  return (
    <div className="grid h-full min-h-[420px] min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-hidden rounded-lg" data-testid="terminal-panel" data-state={term.state}>
      <div className="flex flex-wrap items-center gap-2 border-b border-a-line px-3 py-1.5 text-caption">
        <span className="inline-flex items-center gap-1.5 text-a-mut" role="status" aria-live="polite" title={session.tmuxName ?? undefined}>
          <span className={cn("h-2 w-2 rounded-full", st.dot)} />
          {st.label}
        </span>
        <span className="flex-1" />
        {searchOpen && (
          <input
            autoFocus
            value={query}
            placeholder={t("Im Verlauf suchen")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.shiftKey ? term.findPrevious : term.findNext)(query);
              if (e.key === "Escape") {
                setSearchOpen(false);
                term.focus();
              }
            }}
            className="w-44 rounded-md border border-a-line bg-a-p2 px-2 py-1 text-caption text-a-ink outline-none focus:border-a-acc"
          />
        )}
        <Button variant="ghost" onClick={() => setSearchOpen((o) => !o)} title={t("Im Verlauf suchen")}>
          {t("Suchen")}
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-a-mut" title={t("Nur mitlesen, keine Eingaben senden")}>
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} className="accent-[var(--a-acc)]" />
          {t("Nur ansehen")}
        </label>
      </div>
      <div className="relative min-h-0 overflow-hidden bg-a-bg">
        <div
          ref={term.hostRef}
          className="absolute inset-0 overflow-auto px-2 py-1.5"
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
    </div>
  );
}
