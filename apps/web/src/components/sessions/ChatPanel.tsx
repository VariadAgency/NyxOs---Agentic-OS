import { t } from "@nyxos/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLiveTick } from "../../hooks/useLiveTick";
import { useCloseSession, useSessionDetail, useTranscript } from "../../hooks/useSessionApi";
import type { TranscriptItem } from "../../lib/api";
import { cn } from "../../lib/cn";
import { isOrphaned, sessionLabel } from "../../lib/sessionLabel";
import { IconArrowDown, IconPaperclip } from "../../features/session-chat/icons";
import { matchesTranscript, PENDING_STALE_MS, removePending, usePendingMessages, type PendingMessage } from "../../features/session-chat/pending";
import { Skeleton } from "../ui/skeleton";
import { Button } from "../ui/button";
import { ChatItem } from "./ChatItem";
import { CloseDialog } from "./CloseDialog";

interface ChatPanelProps {
  sessionId: string;
  at: number | null;
}

/** Ab dieser Nähe zum unteren Rand (Pixel) gilt der Chat als "unten" — s. `isNearBottomRef`. */
const NEAR_BOTTOM_PX = 80;
/** Hier merkt sich der Browser je Session, bis wohin der Nutzer gelesen hat. */
const LAST_SEEN_KEY = (sessionId: string) => `nyxos.chat.lastSeen.${sessionId}`;

function readLastSeen(sessionId: string): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY(sessionId));
  } catch {
    return null;
  }
}

function writeLastSeen(sessionId: string, itemId: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY(sessionId), itemId);
  } catch {
    // Speicher gesperrt (privates Fenster) — dann startet der Chat eben an der letzten Frage.
  }
}

export interface ChatAnchor {
  index: number;
  align: "start" | "end";
  /** Index des ersten Ungelesenen (dort steht der Trenner), sonst `null`. */
  unreadFrom: number | null;
}

/**
 * Wo der Chat beim Öffnen steht.
 * 1. Gibt es Neues seit dem letzten Besuch → am ersten Ungelesenen (mit Trenner).
 * 2. Sonst an seiner letzten eigenen Nachricht (oben ausgerichtet) — er sieht seine Frage und die
 *    Antwort darunter, statt mitten im Ende einer langen Antwort zu landen.
 * 3. Ohne eigene Nachricht auf dieser Seite: ganz unten.
 */
export function initialChatAnchor(items: Pick<TranscriptItem, "id" | "role">[], lastSeenId: string | null): ChatAnchor {
  const last = items.length - 1;
  if (lastSeenId) {
    const seen = items.findIndex((i) => i.id === lastSeenId);
    if (seen >= 0 && seen < last) return { index: seen + 1, align: "start", unreadFrom: seen + 1 };
  }
  for (let i = last; i >= 0; i--) if (items[i]?.role === "user") return { index: i, align: "start", unreadFrom: null };
  return { index: Math.max(0, last), align: "end", unreadFrom: null };
}

const PENDING_LABEL: Record<PendingMessage["state"], string> = {
  sending: t("Wird übergeben …"),
  delivered: t("Angekommen – die Antwort erscheint gleich hier."),
  queued: t("In der Warteschlange – wird nach dem aktuellen Schritt gelesen."),
  uncertain: t("Unklar, ob sie angekommen ist – dein Rechner hat nicht rechtzeitig geantwortet. Schau gleich im Verlauf nach, bevor du sie noch einmal schickst."),
};

function PendingBubble({ m, now }: { m: PendingMessage; now: number }) {
  const stale = now - m.sentAt > PENDING_STALE_MS && m.state !== "sending";
  return (
    <div data-testid="chat-pending" className="ml-auto max-w-[85%] rounded-lg border border-dashed border-a-acc/40 bg-a-acc/10 px-3 py-2 text-caption">
      <div className="mb-1 flex items-center gap-2 font-mono text-label text-a-mut">
        <span>{t("DU · gerade eben")}</span>
        <span className={cn("inline-flex items-center gap-1", m.state === "queued" || m.state === "uncertain" ? "text-a-wait" : "text-a-acc")}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", m.state === "queued" || m.state === "uncertain" ? "bg-a-wait" : "bg-a-acc", m.state === "sending" && "motion-safe:animate-pulse")} />
          {stale ? t("Noch nicht im Verlauf – schau im Terminal nach, ob sie angekommen ist.") : PENDING_LABEL[m.state]}
        </span>
      </div>
      {m.text && <p className="whitespace-pre-wrap break-words text-a-ink">{m.text}</p>}
      {m.files.length > 0 && (
        <p className="mt-1 flex items-center gap-1 font-mono text-label text-a-mut">
          <IconPaperclip size={12} />
          {m.files.join(", ")}
        </p>
      )}
    </div>
  );
}

/** Keine gelesene Zeile, keine Tokens: die Session hat noch nie etwas geschrieben. */
const isSilent = (s: { parsedEventCount?: number; tokensTotal?: number } | undefined) => !!s && (s.parsedEventCount ?? 0) === 0 && (s.tokensTotal ?? 0) === 0;

/**
 * Leerer Verlauf. Hat die Session noch nie etwas geschrieben, steht ein ruhiger Satz
 * statt „Noch kein Verlauf archiviert.“ bzw. eines roten Fehlers. Ist sie verwaist (wartet > 1 Tag), bietet der
 * Hinweis „Schließen“ an – wie überall nur mit Rückfrage.
 */
function EmptyChat({ sessionId }: { sessionId: string }) {
  const session = useSessionDetail(sessionId).data?.session;
  const close = useCloseSession();
  const [confirm, setConfirm] = useState(false);
  if (!session || !isSilent(session)) return <div className="p-4 text-caption text-a-mut">{t("Noch kein Verlauf archiviert.")}</div>;
  const orphan = isOrphaned(session);
  return (
    <div data-testid="chat-empty-silent" className="grid justify-items-start gap-1.5 p-4">
      <p className="text-callout font-medium text-a-ink">{t("Diese Session hat noch nichts geschrieben.")}</p>
      <p className="text-caption text-a-mut">
        {orphan ? t("Sie wartet seit über einem Tag, ohne dass je eine Nachricht kam. Wenn du sie nicht mehr brauchst, schließ sie.") : t("Sobald jemand etwas schreibt, erscheint es hier.")}
      </p>
      {orphan && session.closedAt === null && (
        <Button variant="ghost" onClick={() => setConfirm(true)} className="mt-1 h-(--a-ctl-h) py-0">
          {t("Schließen")}
        </Button>
      )}
      <CloseDialog
        open={confirm}
        sessionTitle={sessionLabel(session)}
        pending={close.isPending}
        error={close.isError ? t("Das Schließen hat nicht geklappt. Bitte noch einmal versuchen.") : null}
        onConfirm={() => close.mutate(session.id, { onSuccess: () => setConfirm(false) })}
        onCancel={() => {
          close.reset();
          setConfirm(false);
        }}
      />
    </div>
  );
}

/**
 * Virtualisierter Chat-Verlauf: lädt beim Hochscrollen ältere Seiten, springt bei
 * `?at=` an die Fundstelle (around), wächst über `/live` nach.
 *
 * Öffnet NICHT stur ganz unten (s. `initialChatAnchor`), merkt sich je Session, bis wohin
 * der Nutzer gelesen hat, und zeigt „Nach unten“ mit der Zahl ungelesener Einträge, sobald er nicht unten
 * ist. Ist er unten, scrollt neuer Inhalt automatisch mit. Gesendete, noch nicht übernommene
 * Nachrichten stehen als eigene Blase am Ende (`pending.ts`).
 *
 * Chat-Rauschen: interne Plumbing-Zeilen (`role: "system"`,
 * `internal: true`) werden standardmäßig herausgefiltert; ein Knopf blendet sie bei Bedarf ein.
 */
export function ChatPanel({ sessionId, at }: ChatPanelProps) {
  const liveTick = useLiveTick(sessionId);
  const transcript = useTranscript(sessionId, { around: at, liveTick });
  const { items } = transcript;
  const pending = usePendingMessages(sessionId);
  const detailSilent = isSilent(useSessionDetail(sessionId).data?.session);

  const [showInternal, setShowInternal] = useState(false);
  const internalCount = useMemo(() => items.filter((i) => i.role === "system" && i.internal).length, [items]);
  const visibleItems = useMemo(() => (showInternal ? items : items.filter((i) => !(i.role === "system" && i.internal))), [items, showInternal]);

  // Der Server berechnet `anchorIndex` gegen die volle (rohe) Seite — beim Herausfiltern interner
  // Zeilen muss der Index auf `visibleItems` umgerechnet werden (über die Eintrags-`id`).
  const anchorItemId = transcript.anchorIndex !== null ? (items[transcript.anchorIndex]?.id ?? null) : null;
  const visibleAnchorIndex = anchorItemId !== null ? visibleItems.findIndex((i) => i.id === anchorItemId) : -1;

  const parentRef = useRef<HTMLDivElement | null>(null);
  const restoreFromBottom = useRef<number | null>(null);
  const didInitialScroll = useRef(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Bei `?at=` (Sprung aus der Suche) startet die Ansicht nicht am unteren Rand.
  const isNearBottomRef = useRef(at === null);
  const [nearBottom, setNearBottom] = useState(true);
  // Höchster Index, den der Nutzer schon gesehen hat (für „N neue“ und den gemerkten Lesestand).
  // Nach ID gemerkt (nie eine interne Zeile), damit „interne Zeilen einblenden“ und
  // nachgeladene ältere Seiten Lesestand und Zähler nicht verschieben.
  const [seenId, setSeenId] = useState<string | null>(null);
  const seenIdx = seenId === null ? -1 : visibleItems.findIndex((i) => i.id === seenId);
  const [unreadFromId, setUnreadFromId] = useState<string | null>(null);
  const prevItemsLengthRef = useRef(0);

  const rowVirtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 10,
    getItemKey: (index) => visibleItems[index]?.id ?? index,
    // Zeilenhöhen im nächsten Frame übernehmen statt mitten in der ResizeObserver-Runde neu
    // zu zeichnen — sonst meldete der Browser „ResizeObserver loop completed with undelivered notifications“.
    useAnimationFrameWithResizeObserver: true,
  });

  const markSeenUpTo = (idx: number) => {
    let i = Math.min(idx, visibleItems.length - 1);
    while (i >= 0 && visibleItems[i]?.internal) i--;
    const id = i >= 0 ? (visibleItems[i]?.id ?? null) : null;
    if (id === null) return;
    setSeenId((prev) => {
      const prevIdx = prev === null ? -1 : visibleItems.findIndex((x) => x.id === prev);
      return i > prevIdx ? id : prev;
    });
  };

  const updateScrollState = () => {
    const el = parentRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    isNearBottomRef.current = near;
    setNearBottom(near);
    if (near) markSeenUpTo(visibleItems.length - 1);
    else {
      const lastVisible = rowVirtualizer.getVirtualItemForOffset(el.scrollTop + el.clientHeight - 1)?.index;
      if (lastVisible !== undefined) markSeenUpTo(Math.min(lastVisible, visibleItems.length - 1));
    }
  };

  const scrollToBottom = () => {
    const el = parentRef.current;
    if (!el) return;
    if (visibleItems.length > 0) rowVirtualizer.scrollToIndex(visibleItems.length - 1, { align: "end" });
    el.scrollTop = el.scrollHeight;
    isNearBottomRef.current = true;
    setNearBottom(true);
    markSeenUpTo(visibleItems.length - 1);
  };

  // Beim Hochscrollen ältere Seite nachladen (Sentinel: nahe am oberen Rand).
  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    updateScrollState();
    if (!transcript.loadingOlder && transcript.hasOlder && el.scrollTop < 240) {
      restoreFromBottom.current = el.scrollHeight - el.scrollTop;
      transcript.loadOlder();
    }
  };

  // Scroll-Position beim Nachladen älterer Einträge erhalten (Inhalt wächst nach oben); beim
  // Live-Nachwachsen (Inhalt wächst unten an) mitscrollen, wenn der Nutzer unten ist.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    if (restoreFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFromBottom.current;
      restoreFromBottom.current = null;
      // Ältere Einträge kamen VORN dazu: der gesehene Index verschiebt sich mit.
      prevItemsLengthRef.current = visibleItems.length;
      return;
    }
    if (!didInitialScroll.current && visibleItems.length > 0 && !transcript.isLoading) {
      didInitialScroll.current = true;
      prevItemsLengthRef.current = visibleItems.length;
      if (visibleAnchorIndex >= 0) {
        rowVirtualizer.scrollToIndex(visibleAnchorIndex, { align: "center" });
        setHighlightId(anchorItemId);
        isNearBottomRef.current = false;
        return;
      }
      const anchor = initialChatAnchor(visibleItems, readLastSeen(sessionId));
      setUnreadFromId(anchor.unreadFrom !== null ? (visibleItems[anchor.unreadFrom]?.id ?? null) : null);
      if (anchor.align === "end") {
        el.scrollTop = el.scrollHeight;
        isNearBottomRef.current = true;
        markSeenUpTo(visibleItems.length - 1);
      } else {
        markSeenUpTo(anchor.index - 1);
        rowVirtualizer.scrollToIndex(anchor.index, { align: "start" });
        isNearBottomRef.current = anchor.index >= visibleItems.length - 1;
        // Nach dem Messen der echten Zeilenhöhen stimmt die Lage — dann „unten?“ neu bestimmen.
        requestAnimationFrame(() => updateScrollState());
      }
      return;
    }
    const delta = visibleItems.length - prevItemsLengthRef.current;
    if (didInitialScroll.current && delta > 0 && isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      markSeenUpTo(visibleItems.length - 1);
    }
    prevItemsLengthRef.current = visibleItems.length;
  }, [visibleItems.length, transcript.isLoading]);

  // Lesestand merken (nur vorwärts, s. `markSeenUpTo`).
  useEffect(() => {
    if (seenId) writeLastSeen(sessionId, seenId);
  }, [seenId, sessionId]);

  // Gesendete Nachrichten: sobald sie im Verlauf stehen, verschwindet die Warte-Blase.
  useEffect(() => {
    for (const m of pending) if (m.state !== "sending" && matchesTranscript(m, items)) removePending(sessionId, m.key);
  }, [items, pending, sessionId]);

  // Nach dem Senden nach unten, damit der Nutzer seine Nachricht sieht.
  const pendingCount = pending.length;
  const prevPending = useRef(pendingCount);
  useLayoutEffect(() => {
    if (pendingCount > prevPending.current) {
      const el = parentRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
        isNearBottomRef.current = true;
        setNearBottom(true);
      }
    }
    prevPending.current = pendingCount;
  }, [pendingCount]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [pending.length]);

  if (transcript.isLoading && items.length === 0) {
    return (
      <div className="grid gap-2 p-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-16" />
        ))}
      </div>
    );
  }

  if (transcript.isError && pending.length === 0) {
    // Eine Session ohne jede Nachricht hat nichts zu laden – ruhiger Hinweis statt roter Meldung.
    if (items.length === 0 && detailSilent) return <EmptyChat sessionId={sessionId} />;
    return (
      <div className="grid justify-items-start gap-2 p-4 text-caption">
        <p className="text-a-bad">{t("Chat konnte nicht geladen werden.")}</p>
      </div>
    );
  }

  // Nur echte Nachrichten zählen (keine Werkzeug- oder System-Zeilen).
  const unseen = visibleItems.slice(seenIdx + 1).filter((i) => i.role === "user" || i.role === "assistant").length;
  const showToBottom = !nearBottom && !transcript.newerAvailable && visibleItems.length > 0;
  const unreadIndex = unreadFromId ? visibleItems.findIndex((i) => i.id === unreadFromId) : -1;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {internalCount > 0 && (
        <div className="flex shrink-0 justify-end border-b border-a-line px-2 py-1">
          <button type="button" onClick={() => setShowInternal((v) => !v)} className="text-label text-a-mut hover:text-a-ink">
            {showInternal ? t("Interne Zeilen ausblenden") : t(internalCount === 1 ? "{n} interne Zeile einblenden" : "{n} interne Zeilen einblenden", { n: internalCount })}
          </button>
        </div>
      )}
      <div ref={parentRef} onScroll={onScroll} className="cc-scroll min-h-0 flex-1 overflow-y-auto" data-testid="chat-scroll">
        {transcript.loadingOlder && <div className="py-1.5 text-center text-label text-a-mut">{t("Lädt ältere Nachrichten …")}</div>}
        {items.length === 0 ? (
          pending.length === 0 && <EmptyChat sessionId={sessionId} />
        ) : visibleItems.length === 0 ? (
          <div className="p-4 text-caption text-a-mut">{t("Nur interne Zeilen in diesem Verlauf.")}</div>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = visibleItems[virtualRow.index];
              if (!item) return null;
              return (
                <div
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)`, padding: "3px 4px" }}
                >
                  {virtualRow.index === unreadIndex && (
                    <div className="my-2 flex items-center gap-2 text-label font-medium tracking-wide text-a-acc uppercase" role="separator">
                      <span className="h-px flex-1 bg-a-acc/30" />
                      {t("Neu seit deinem letzten Besuch")}
                      <span className="h-px flex-1 bg-a-acc/30" />
                    </div>
                  )}
                  <ChatItem item={item} sessionId={sessionId} highlighted={item.id === highlightId} />
                </div>
              );
            })}
          </div>
        )}
        {pending.length > 0 && (
          <div className="grid gap-1.5 px-1 pt-1.5 pb-2">
            {pending.map((m) => (
              <PendingBubble key={m.key} m={m} now={now} />
            ))}
          </div>
        )}
        {highlightId && (
          <div className="flex justify-center py-2">
            <Button variant="ghost" onClick={() => setHighlightId(null)}>
              {t("Markierung ausblenden")}
            </Button>
          </div>
        )}
      </div>
      {/* „Nach unten“ schwebt nicht mehr über dem Verlauf (verdeckte „Ganze Nachricht zeigen“),
          sondern hat eine eigene Zeile unter dem Verlauf — so liegt nie ein Bedienelement darunter. */}
      {showToBottom && (
        <div className="flex shrink-0 justify-center border-t border-a-line py-1.5" data-testid="chat-to-bottom-bar">
          <button
            type="button"
            onClick={scrollToBottom}
            data-testid="chat-to-bottom"
            className="inline-flex h-(--a-ctl-h) items-center gap-1.5 rounded-full border border-a-line bg-a-p3 pr-3 pl-2.5 text-caption font-medium text-a-ink shadow-lg shadow-black/40 transition hover:border-a-acc"
          >
            <IconArrowDown size={14} className="text-a-acc" />
            {t("Nach unten")}
            {unseen > 0 && <span className="rounded-full bg-a-acc px-1.5 py-px font-mono text-label font-semibold text-a-bg">{unseen === 1 ? t("1 neue Nachricht") : t("{n} neue Nachrichten", { n: unseen })}</span>}
          </button>
        </div>
      )}
      {/* Fenster steht nicht am Ende (Such-Sprung) UND ein `/live`-Signal für
          diese Session kam an — nicht blind anhängen (Lücke), stattdessen bewusst nachholen. */}
      {transcript.newerAvailable && (
        <div className="flex shrink-0 justify-center border-t border-a-line py-1.5">
          <Button variant="default" onClick={() => transcript.jumpToLatest()} data-testid="chat-jump-latest">
            {t("Zu den neuesten springen")}
          </Button>
        </div>
      )}
    </div>
  );
}
