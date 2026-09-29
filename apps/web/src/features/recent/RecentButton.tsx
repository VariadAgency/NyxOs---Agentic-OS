// Knopf „Zuletzt geöffnet“ in der Kopfleiste der Sessions-Seite. Öffnet eine Liste der
// Sessions in der Reihenfolge, in der du sie geöffnet hast (neueste oben), mit Zustand, Titel,
// Werkzeug und Zeit; filterbar nach Alle/Claude/Codex. Klick öffnet die Session.
import { t } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ToolTag } from "../../components/sessions/ToolTag";
import { useTooltip } from "../../components/ui/Tooltip";
import { useSessions } from "../../hooks/useSessions";
import { BAUSTELLE_NONE, type ToolFilter } from "../../hooks/useSessionsRoute";
import { artLabel } from "../../lib/arts";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { stateMeta } from "../../lib/stateMeta";
import { fetchRecentSessions, readLocalOpens, type RecentItem } from "./recentApi";
import { sessionLabel } from "../../lib/sessionLabel";

const TOOL_OPTIONS: { id: ToolFilter; label: string }[] = [
  { id: "alle", label: t("Alle") },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

const LIST_MAX = 30;

function hrefFor(item: RecentItem, currentTool: ToolFilter): string {
  // Wie `route.goTo`: Schlüssel roh im Pfad (`claude:…`), der Brotkrümel liest ihn unverändert.
  const path = `/sessions/${item.art}/${item.baustelle?.slug ?? BAUSTELLE_NONE}/${item.sessionKey}`;
  // Werkzeug-Filter der Seite behalten, solange die Session dazu passt.
  return currentTool !== "alle" && currentTool === item.tool ? `${path}?tool=${currentTool}` : path;
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/** Server-Liste plus still im Browser gemerkte Öffnungen (ohne Anmeldung), jüngste zuerst. */
function useRecentList(tool: ToolFilter, enabled: boolean) {
  const server = useQuery({ queryKey: ["recent-sessions", tool], queryFn: () => fetchRecentSessions(tool), enabled, staleTime: 0 });
  const sessions = useSessions();
  const items = useMemo(() => {
    const byKey = new Map<string, RecentItem>();
    for (const item of server.data ?? []) byKey.set(item.sessionKey, item);
    for (const local of enabled ? readLocalOpens() : []) {
      const existing = byKey.get(local.sessionKey);
      if (existing) {
        if (Date.parse(local.openedAt) > Date.parse(existing.openedAt)) byKey.set(local.sessionKey, { ...existing, openedAt: local.openedAt });
        continue;
      }
      const s = sessions.data?.find((x) => x.id === local.sessionKey || x.sessionId === local.sessionKey);
      if (!s || (tool !== "alle" && s.tool !== tool)) continue;
      byKey.set(s.id, {
        sessionKey: s.id,
        sessionId: s.sessionId,
        tool: s.tool,
        title: s.title,
        state: s.state,
        art: s.art,
        baustelle: s.baustelle,
        openedAt: local.openedAt,
        openCount: 1,
        lastActivityAt: s.lastActivityAt,
      });
    }
    return [...byKey.values()].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt)).slice(0, LIST_MAX);
  }, [server.data, sessions.data, tool, enabled]);
  return { items, isLoading: server.isLoading, isError: server.isError && items.length === 0, refetch: server.refetch };
}

export function RecentButton({ currentTool }: { currentTool: ToolFilter }) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<ToolFilter>(currentTool);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const hint = useTooltip(open ? null : t("Sessions in der Reihenfolge, in der du sie geöffnet hast"));
  const { items, isLoading, isError, refetch } = useRecentList(tool, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t("Zuletzt geöffnet")}
        data-nyx="recent"
        onClick={() => {
          // Beim Öffnen gilt zuerst der Filter der Seite — vor der ersten Abfrage gesetzt, kein Aufblitzen.
          if (!open) setTool(currentTool);
          setOpen(!open);
        }}
        className={cn(
          "flex h-(--a-ctl-h) items-center justify-center gap-1.5 rounded-md border border-a-line px-2.5 text-caption transition-colors pointer-coarse:min-w-11",
          open ? "bg-a-p3 text-a-ink" : "text-a-mut hover:bg-a-p2 hover:text-a-ink",
        )}
        {...hint.triggerProps}
      >
        <ClockIcon className="h-3.5 w-3.5" />
        <span className="@max-[960px]:hidden">{t("Zuletzt geöffnet")}</span>
      </button>
      {hint.tooltip}
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t("Zuletzt geöffnet")}
          className="absolute right-0 top-full z-30 mt-1.5 grid w-[380px] max-w-[calc(100vw-32px)] gap-2 rounded-lg border border-a-line bg-a-p p-2.5 shadow-lg motion-safe:animate-[cc-tab-fade_120ms_ease-out]"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-label tracking-wider text-a-mut uppercase">{t("Zuletzt geöffnet")}</span>
            <span className="flex-1" />
            <div className="flex h-7 overflow-hidden rounded-md border border-a-line">
              {TOOL_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={tool === opt.id}
                  onClick={() => setTool(opt.id)}
                  className={cn("px-2 text-caption", tool === opt.id ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-scroll grid max-h-[min(60vh,440px)] overflow-y-auto">
            {isLoading && items.length === 0 && <p className="px-2 py-3 text-caption text-a-mut">{t("Lädt …")}</p>}
            {isError && (
              <div className="flex items-center gap-2 px-2 py-3 text-caption text-a-mut">
                <span>{t("Die Liste lässt sich gerade nicht laden.")}</span>
                <button type="button" onClick={() => void refetch()} className="text-a-acc hover:underline">
                  {t("Nochmal versuchen")}
                </button>
              </div>
            )}
            {!isLoading && !isError && items.length === 0 && (
              <p className="px-2 py-3 text-caption text-a-mut">
                {tool === "alle" ? t("Noch nichts geöffnet. Sobald du eine Session öffnest, steht sie hier.") : t("Noch keine {tool}-Session geöffnet.", { tool: tool === "claude" ? "Claude" : "Codex" })}
              </p>
            )}
            {items.map((item) => {
              const meta = stateMeta(item.state);
              return (
                <Link
                  key={item.sessionKey}
                  to={hrefFor(item, currentTool)}
                  data-nyx={`recent-item:${item.sessionKey}`}
                  onClick={() => setOpen(false)}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-md px-2 py-1.5 hover:bg-a-p2 focus-visible:bg-a-p2 focus-visible:outline-none"
                >
                  <span className={cn("row-span-2 h-2 w-2 rounded-full", meta.dot)} aria-hidden="true" />
                  <span className="min-w-0 truncate text-caption text-a-ink">{sessionLabel(item)}</span>
                  <span className="justify-self-end">
                    <ToolTag tool={item.tool} />
                  </span>
                  <span className="min-w-0 truncate text-label text-a-mut">
                    <span className={meta.text}>{meta.label}</span>
                    {" · "}
                    {artLabel(item.art)}
                    {item.baustelle ? ` → ${item.baustelle.label}` : ""}
                  </span>
                  <span className="text-right font-mono text-label text-a-mut">{relativeTime(item.openedAt) ?? ""}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
