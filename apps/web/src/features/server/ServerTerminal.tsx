// Server-SSH · „Terminal“ im Server-Tab: eine echte Shell auf dem Server, über die Brücke
// (`ssh -t <NYXOS_SERVER_SSH_HOST>` in einer eigenen tmux-Sitzung). Ohne eingerichteten SSH-Host sagt der
// Status das, und der Knopf bleibt gesperrt. Startet NIE von selbst — erst der Klick öffnet bzw.
// verbindet. Das Terminal selbst ist dieselbe xterm-Ansicht wie bei Claude-Sessions (useTerminal).
import "@xterm/xterm/css/xterm.css";
import { t } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/Card";
import { cn } from "../../lib/cn";
import { writeJson } from "../../lib/api";
import { useTerminal, type TermState } from "../terminal/useTerminal";

export const SSH_HINT = t("Echte Shell auf dem Server – Befehle wirken sofort.");

interface SshStatus {
  bridgeOnline: boolean;
  supported: boolean;
  running: boolean;
  tmuxName: string | null;
  code: string | null;
  message: string | null;
  /** SSH-Host (NYXOS_SERVER_SSH_HOST), fehlt bei älteren Servern. */
  host?: string | null;
  /** false = kein SSH-Host eingerichtet (Funktion aus). */
  configured?: boolean;
}

/** Kein SSH-Host eingerichtet: die Funktion ist aus (ältere Antworten ohne die Felder gelten als eingerichtet). */
const notConfigured = (st: SshStatus | undefined) => !!st && (st.configured === false || st.code === "not_configured" || st.code === "disabled");

const STATUS_KEY = ["server-ssh"] as const;

async function fetchStatus(): Promise<SshStatus> {
  const res = await fetch("/api/server/ssh");
  if (res.status === 401) return { bridgeOnline: true, supported: true, running: false, tmuxName: null, code: "auth_required", message: null };
  if (!res.ok) throw new Error(t("Der Stand des Server-Terminals ließ sich gerade nicht laden."));
  return (await res.json()) as SshStatus;
}

/** Start-Feldgröße; nach dem Verbinden passt sich das Terminal selbst an die Fläche an. */
const START_SIZE = { cols: 120, rows: 30 };

const STATE_TEXT: Record<TermState, { label: string; dot: string }> = {
  connecting: { label: t("verbinde …"), dot: "bg-a-wait" },
  connected: { label: t("verbunden"), dot: "bg-a-ok" },
  reconnecting: { label: t("verbinde neu …"), dot: "bg-a-wait animate-pulse" },
  offline: { label: t("Brücke offline"), dot: "bg-a-bad" },
  ended: { label: t("getrennt"), dot: "bg-a-idle" },
  not_attachable: { label: t("getrennt"), dot: "bg-a-idle" },
  login: { label: t("Anmeldung nötig"), dot: "bg-a-wait" },
};

function StatusDot({ label, dot }: { label: string; dot: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-a-mut" role="status" aria-live="polite">
      <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  );
}

export function ServerTerminal() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: fetchStatus, refetchInterval: 15_000 });
  const [tmuxName, setTmuxName] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const start = useMutation({
    mutationFn: () => writeJson<{ tmuxName: string; reused: boolean }>("POST", "/api/server/ssh/start", START_SIZE),
    onSuccess: (r) => {
      setTmuxName(r.tmuxName);
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
  const stop = useMutation({
    mutationFn: () => writeJson<{ stopped: number }>("POST", "/api/server/ssh/stop", { confirm: true }),
    onSuccess: () => {
      setTmuxName(null);
      setConfirmStop(false);
      setFullscreen(false);
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });

  const st = status.data;
  const bridgeOnline = st?.bridgeOnline ?? true;
  const off = notConfigured(st);
  const blocked = !!st && (off || !st.bridgeOnline || !st.supported);
  const sshHost = typeof st?.host === "string" && st.host.trim() ? st.host.trim() : null;
  const note = st?.message ?? (status.isError ? (status.error as Error).message : null);

  if (!tmuxName) {
    return (
      <Card className="grid gap-3" data-testid="server-terminal">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-callout font-semibold text-a-ink">{t("Terminal zum Server")}</span>
          {sshHost && <code className="rounded-md border border-a-line bg-a-bg px-1.5 py-0.5 font-mono text-caption text-a-mut">ssh {sshHost}</code>}
          <span className="flex-1" />
          <StatusDot
            {...(off
              ? { label: t("nicht eingerichtet"), dot: "bg-a-idle" }
              : blocked
                ? { label: st?.bridgeOnline ? t("Brücke zu alt") : t("Brücke offline"), dot: "bg-a-bad" }
                : st?.running
                  ? { label: t("läuft im Hintergrund"), dot: "bg-a-wait" }
                  : { label: t("getrennt"), dot: "bg-a-idle" })}
          />
        </div>
        {!off && <p className="text-caption text-a-wait">{SSH_HINT}</p>}
        {note ? (
          <p className="text-caption text-a-ink">{note}</p>
        ) : (
          off && <p className="text-caption text-a-mut">{t("Kein SSH-Host eingerichtet. Trag ihn als NYXOS_SERVER_SSH_HOST ein, dann öffnet sich hier eine Shell auf dem Server.")}</p>
        )}
        {st?.code === "auth_required" && <p className="text-caption text-a-mut">{t("Beim Öffnen fragt NyxOS einmal nach deiner Anmeldung.")}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {/* Nyx zeigt nur darauf, klickt nie selbst (echte Shell auf dem Server). */}
          <Button variant="primary" data-nyx-risk="" disabled={blocked || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? t("Öffne …") : st?.running ? t("Wieder verbinden") : t("Terminal zum Server öffnen")}
          </Button>
          {start.isError && <span className="text-caption text-a-bad">{(start.error as Error).message}</span>}
        </div>
      </Card>
    );
  }

  return (
    <SshTerminalView
      key={tmuxName}
      tmuxName={tmuxName}
      bridgeOnline={bridgeOnline}
      fullscreen={fullscreen}
      onFullscreen={setFullscreen}
      confirmStop={confirmStop}
      onConfirmStop={setConfirmStop}
      stopping={stop.isPending}
      stopError={stop.isError ? (stop.error as Error).message : null}
      onStop={() => stop.mutate()}
      reconnecting={start.isPending}
      onReconnect={() => start.mutate()}
    />
  );
}

function SshTerminalView(p: {
  tmuxName: string;
  bridgeOnline: boolean;
  fullscreen: boolean;
  onFullscreen: (v: boolean) => void;
  confirmStop: boolean;
  onConfirmStop: (v: boolean) => void;
  stopping: boolean;
  stopError: string | null;
  onStop: () => void;
  reconnecting: boolean;
  onReconnect: () => void;
}) {
  const term = useTerminal({ sessionId: p.tmuxName, wsPath: `/terminal/ssh/${encodeURIComponent(p.tmuxName)}`, readOnly: false, bridgeOnline: p.bridgeOnline });
  const st = STATE_TEXT[term.state];
  const ended = term.state === "ended" || term.state === "not_attachable";

  useEffect(() => {
    if (term.state === "connected") term.focus();
  }, [term.state]);

  return (
    <Card
      className={cn("grid min-w-0 grid-rows-[auto_auto_1fr] gap-0 overflow-hidden p-0", p.fullscreen && "fixed inset-0 z-50 rounded-none border-0")}
      data-testid="server-terminal"
      data-state={term.state}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-a-line px-3 py-2">
        <span className="font-display text-callout font-semibold text-a-ink">{t("Terminal zum Server")}</span>
        <StatusDot {...st} />
        <span className="flex-1" />
        {p.confirmStop ? (
          <span className="inline-flex flex-wrap items-center gap-2 text-caption text-a-ink">
            {t("Sitzung auf dem Server beenden?")}
            <Button variant="warn" disabled={p.stopping} onClick={p.onStop}>
              {p.stopping ? t("Trenne …") : t("Ja, trennen")}
            </Button>
            <Button variant="ghost" onClick={() => p.onConfirmStop(false)}>
              {t("Abbrechen")}
            </Button>
          </span>
        ) : (
          <>
            <Button variant="ghost" onClick={() => p.onFullscreen(!p.fullscreen)} aria-pressed={p.fullscreen}>
              {p.fullscreen ? t("Vollbild beenden") : t("Vollbild")}
            </Button>
            <Button variant="warn" onClick={() => p.onConfirmStop(true)}>
              {t("Trennen")}
            </Button>
          </>
        )}
      </div>
      <p className="border-b border-a-line px-3 py-1.5 text-caption text-a-wait">
        {SSH_HINT}
        {p.stopError && <span className="ml-2 text-a-bad">{p.stopError}</span>}
      </p>
      {/* Nyx tippt nie in die Shell des Servers (auch nicht ins versteckte xterm-Eingabefeld). */}
      <div className={cn("relative min-h-0 overflow-hidden bg-a-bg", p.fullscreen ? "h-full" : "h-[420px]")} data-testid="server-terminal-view" data-nyx-risk="">
        <div ref={term.hostRef} className="absolute inset-0 overflow-hidden px-2 py-1.5" />
        {term.state !== "connected" && term.state !== "connecting" && term.state !== "reconnecting" && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-a-bg/80 backdrop-blur-[1px]">
            <div className="grid max-w-md justify-items-center gap-2 px-4 text-center text-caption">
              <p className="text-a-ink">
                {term.state === "offline"
                  ? t("Dein Rechner ist gerade nicht verbunden. Das Terminal zum Server läuft über die Brücke.")
                  : ended
                    ? t("Die Verbindung zum Server ist beendet.")
                    : term.message}
              </p>
              {term.state === "offline" && <p className="text-a-mut">{t("Sobald die Brücke wieder da ist, verbindet es sich von selbst.")}</p>}
              {ended && (
                <Button variant="primary" data-nyx-risk="" disabled={p.reconnecting} onClick={p.onReconnect}>
                  {p.reconnecting ? t("Öffne …") : t("Neu verbinden")}
                </Button>
              )}
              {term.state === "login" && <Button onClick={term.retry}>{t("Erneut verbinden")}</Button>}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
