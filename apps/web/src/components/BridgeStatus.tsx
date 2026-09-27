// Statuszeile „Brücke" mit Verlauf.
//
// Vorher rechnete die Leiste selbst „lastSeenAt jünger als 60 s" mit der Browser-Uhr — und lastSeenAt kam
// nur mit HTTP-Ingest, nie über den offenen Kanal. Jetzt kommt der Zustand fertig vom Server
// (`/api/bridge/presence`): online · verbindet neu … (kurzer Aussetzer, gelb) · offline mit Grund und Dauer.
// Ein Klick öffnet den Verlauf der letzten 24 h.
import { t, locale, timeZone } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { useBridgeHistory, useBridgePresence } from "../hooks/useBridgePresence";
import type { BridgeHistoryItem, BridgePresence, BridgeState } from "../lib/api";
import { cn } from "../lib/cn";

/** Hängt die Abfrage länger, ist der letzte Stand nicht mehr belegt. */
const STALE_MS = 30_000;

export type BridgeTone = "ok" | "wait" | "bad" | "unknown";

const TONE_BG: Record<BridgeTone, string> = { ok: "bg-a-ok", wait: "bg-a-wait", bad: "bg-a-bad", unknown: "bg-a-idle" };
const STATE_TONE: Record<BridgeState, BridgeTone> = { online: "ok", reconnecting: "wait", offline: "bad" };

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 || m >= 10 ? `${m} min` : `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

function formatSince(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return t("seit {d}", { d: `${Math.max(0, Math.floor(ms / 1000))} s` });
  if (m < 60) return t("seit {d}", { d: `${m} min` });
  const h = Math.floor(m / 60);
  return t("seit {d}", { d: m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min` });
}

/**
 * Rein: Anzeige aus der Server-Antwort. `receivedAt`/`now` sind Browser-Zeiten, aber nur ihr ABSTAND zählt
 * (wie lange die Antwort schon her ist) — ein Uhren-Versatz zwischen Browser und Server wirkt nicht.
 */
export function describeBridge(p: BridgePresence, receivedAt: number, now: number): { tone: BridgeTone; text: string; detail: string | null } {
  const sinceReceived = Math.max(0, now - receivedAt);
  if (sinceReceived > STALE_MS) return { tone: "unknown", text: t("Brücke unbekannt"), detail: null };
  const elapsed = Date.parse(p.serverNow) - Date.parse(p.since) + sinceReceived;
  if (p.state === "online") return { tone: "ok", text: p.machine ? t("Brücke online · {name}", { name: p.machine.name }) : t("Brücke online"), detail: null };
  if (p.state === "reconnecting") return { tone: "wait", text: t("Brücke verbindet neu …"), detail: null };
  // Grund + Dauer in eigener Zeile: in der 200 px schmalen Leiste würde eine Zeile den Grund abschneiden.
  return { tone: "bad", text: t("Brücke offline"), detail: p.reason ? `${p.reason} · ${formatSince(elapsed)}` : formatSince(elapsed) };
}

function historyLabel(h: BridgeHistoryItem): string {
  if (h.state === "online") return t("online");
  if (h.state === "reconnecting") return t("kurz neu verbunden");
  return h.reason ? `${t("offline")} · ${h.reason}` : t("offline");
}

function Dot({ tone }: { tone: BridgeTone }) {
  return <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", TONE_BG[tone])} />;
}

/** Ticker, damit „seit …" und die Frische-Prüfung auch ohne neue Antwort weiterlaufen. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function HistoryPanel({ onClose }: { onClose: () => void }) {
  const history = useBridgeHistory(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  const rows = [...(history.data ?? [])].reverse(); // neueste oben
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("Verbindung der Brücke")}
      className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-lg border border-a-line bg-a-p2 p-3 text-a-ink shadow-xl"
    >
      <div className="mb-2 text-caption font-semibold">{t("Verbindung · letzte 24 Stunden")}</div>
      {history.isLoading ? (
        <p className="text-caption text-a-mut">{t("Lade Verlauf …")}</p>
      ) : history.isError ? (
        <p className="text-caption text-a-mut">{t("Verlauf gerade nicht abrufbar. Er kommt beim nächsten Versuch von selbst.")}</p>
      ) : rows.length === 0 ? (
        <p className="text-caption text-a-mut">{t("Noch keine Wechsel aufgezeichnet.")}</p>
      ) : (
        <ul className="cc-scroll grid max-h-64 gap-1.5 overflow-y-auto pr-1">
          {rows.map((h) => (
            <li key={`${h.at}-${h.state}`} className="flex items-center gap-2 text-caption">
              <Dot tone={STATE_TONE[h.state]} />
              <span className="w-10 shrink-0 tabular-nums text-a-mut">{new Date(h.at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() })}</span>
              <span className="min-w-0 flex-1 truncate" title={h.reason ?? undefined}>
                {historyLabel(h)}
              </span>
              <span className="shrink-0 tabular-nums text-a-mut">{h.durationMs === null ? t("läuft") : formatDuration(h.durationMs)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-label leading-snug text-a-mut">{t("Kurze Aussetzer bis 90 s (z. B. Tunnel-Neuaufbau) zeigen „verbindet neu“ und werden nicht rot.")}</p>
    </div>
  );
}

/** Zeile „Brücke" im Leisten-Fuß. `serverOk`: nur wenn der Server antwortet, ist der Stand belegt. */
export function BridgeStatusLine({ serverOk, serverReconnecting = false }: { serverOk: boolean; serverReconnecting?: boolean }) {
  const presence = useBridgePresence();
  const now = useNow(5_000);
  const [open, setOpen] = useState(false);

  const d =
    serverOk && presence.isSuccess
      ? describeBridge(presence.data, presence.dataUpdatedAt, Math.max(now, presence.dataUpdatedAt))
      : serverReconnecting
        ? // Während der Server-Verbindung neu aufgebaut wird (meist der Brücken-Tunnel selbst) gelb statt „unbekannt“.
          { tone: "wait" as const, text: t("Brücke verbindet neu …"), detail: null }
        : { tone: "unknown" as const, text: t("Brücke unbekannt"), detail: null };

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("Verlauf der Verbindung zeigen")}
        className="flex w-full items-start gap-1.5 text-left hover:text-a-ink"
        onClick={() => setOpen((v) => !v)}
      >
        {/* Punkt mittig zur ersten Zeile, auch wenn darunter der Grund umbricht */}
        <span className="flex h-[1.5em] shrink-0 items-center">
          <Dot tone={d.tone} />
        </span>
        <span className="grid min-w-0 flex-1 leading-[1.5]">
          <span className="break-words">{d.text}</span>
          {d.detail && <span className="break-words text-label text-a-mut">{d.detail}</span>}
        </span>
      </button>
      {open && <HistoryPanel onClose={() => setOpen(false)} />}
    </div>
  );
}
