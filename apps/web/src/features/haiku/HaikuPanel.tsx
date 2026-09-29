// Nyx-Zentrum: Kontext-Zeile, Fäden, Plan-Karten, Verlauf mit strömender Antwort, Eingabe mit Mikrofon.
// Motor-Zustand im Kopf, Fadenliste mit Suche (von oben nach unten: Fäden, darunter das Gespräch), der zuletzt
// benutzte Faden kommt zurück (Zustand lebt in `HaikuRoot`, das Panel bleibt nach dem ersten Öffnen eingehängt).
// „⏳ Temporär“ für den aktuellen bzw. neuen Faden. Menü „⋯“ je Faden (zusammenfassen, zu Auftrag, Obsidian,
// archivieren, löschen) + Archiv-Ansicht. Ein schmales Feld direkt UNTER der Nyx-Leiste,
// genau so breit wie sie und rechtsbündig (wie die Mitteilungszentrale). Kein abgedunkelter oder verschwommener
// Hintergrund, nicht modal: die Seite bleibt bedienbar, Klicks daneben und Scrollen schließen es nicht – nur Esc, ✕,
// ein zweiter Klick auf die Leiste oder nach oben ziehen. Höchstens 70 % der Fensterhöhe, darin scrollt es selbst.
import { ReadAloudMessageButton } from "../../components/nyx/ReadAloudMessageButton";
import { describeModel, modelName, t, type HaikuThread } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { Markdown } from "../../lib/markdown";
import { MicButton } from "../voice/MicButton";
import { NyxAura } from "../../components/brand/NyxAura";
import type { NyxVisualState } from "../nyx/netModel";
import { nyxStateWord } from "../nyx/stateWord";
import { NyxQuickTiles, type QuickTile } from "../nyx/bar/NyxQuickTiles";
import { dropdownPlacement, type DropdownPlacement } from "../nyx/bar/dropdownPlacement";
import "../nyx/nyx.css";
import { TemporarySwitch } from "../temporary/TemporarySwitch";
import { useDemo } from "../demo/demoApi";
import { DemoQuestions } from "../demo/DemoQuestions";
import { EngineNotice, useHaikuStatus } from "./EngineStatus";
import { fetchArchivedThreads, fetchThreads, patchThread } from "./haikuApi";
import { PlanCards } from "./PlanCards";
import { ThreadList } from "./ThreadList";
import { ThreadMenu } from "./ThreadMenu";
import { ARCHIVE_KEY, THREADS_KEY, useThreadActions } from "./useThreadActions";
import { NyxThoughts } from "../nyx/NyxThoughts";
import { AnswerLengthPicker } from "./AnswerLengthPicker";
import { EstimateTag, FIELD, HAIKU_ERROR_TEXT, SourceChips } from "./ui";
import { useHaikuContext } from "./useHaikuContext";
import { type ChatEntry, pendingText, type useHaikuChat } from "./useHaikuChat";

export type HaikuChat = ReturnType<typeof useHaikuChat>;

interface HaikuPanelProps {
  state: "open" | "closed";
  /** Nach dem Schließen (Animation vorbei) unsichtbar, aber eingehängt: Faden und Entwurf bleiben. */
  hidden: boolean;
  onClose: () => void;
  chat: HaikuChat;
  draft: string;
  setDraft: (v: string | ((prev: string) => string)) => void;
  /** Die Nyx-Leiste: das Zentrum hängt direkt darunter. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Getippte Befehle („Öffne die neueste Session“) zuerst lokal ausführen – Cursor statt Modell. */
  onLocal?: (text: string) => Promise<boolean>;
  /** Schnell-Aktionen als Kacheln. */
  tiles?: QuickTile[];
  visual?: NyxVisualState;
}

/** So weit nach oben gezogen (px) schließt das Zentrum. */
const DRAG_CLOSE_PX = 56;

/** Vorschläge im leeren Faden – ein Klick füllt das Eingabefeld (nichts wird ungefragt gesendet). */
const STARTERS = [t("Was wartet gerade auf mich?"), t("Was lief heute Nacht?"), t("Welche Aufgaben sind startklar?")];

export { THREADS_KEY };

export function HaikuPanel({ state, hidden, onClose, chat, draft, setDraft, anchorRef, tiles, visual = "idle", onLocal }: HaikuPanelProps) {
  const { context, crumbs } = useHaikuContext();
  const qc = useQueryClient();
  const threads = useQuery({ queryKey: THREADS_KEY, queryFn: fetchThreads });
  // Archiv nur laden, wenn du es aufmachst.
  const [view, setView] = useState<"threads" | "archive">("threads");
  const archived = useQuery({ queryKey: ARCHIVE_KEY, queryFn: fetchArchivedThreads, enabled: view === "archive" });
  const threadActions = useThreadActions(chat);
  // Motor-Zustand VOR dem Schreiben. Unbekannt (lädt/Fehler) sperrt nicht – der Chat meldet dann selbst.
  const status = useHaikuStatus();
  const notReady = status.data !== undefined && status.data.engine.state !== "ready";
  // Demo: statt der festen Vorschläge die Fragen, die Nyx dort beantworten kann (über der Eingabe).
  const { demo } = useDemo();
  // Ein Zustandswort für Nyx – Tätigkeit vor Motor. Die technische Zeile
  // „Kontext-Wächter: Hinweis ab … %“ steht nicht mehr im Kopf; sie lebt in den Einstellungen (/einstellungen/nyx/motor).
  const word = nyxStateWord(status.data?.engine.state, visual !== "idle" ? visual : chat.busy ? "thinking" : "idle");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Direkt unter der Leiste, genau so breit, rechtsbündig (`dropdownPlacement`).
  const [pos, setPos] = useState<DropdownPlacement>(() => dropdownPlacement(null, typeof window === "undefined" ? 1024 : window.innerWidth));
  useLayoutEffect(() => {
    if (state !== "open") return;
    const place = () => setPos(dropdownPlacement(anchorRef?.current?.getBoundingClientRect(), window.innerWidth));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [state, anchorRef]);

  // Nach oben ziehen schließt (Griff unten oder Kopf), wie beim Kontrollzentrum.
  const drag = useRef<{ id: number; y: number; dy: number } | null>(null);
  const onDragStart = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,input,textarea,a,[role=menu]")) return;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom
    }
    drag.current = { id: e.pointerId, y: e.clientY, dy: 0 };
    sheetRef.current?.setAttribute("data-dragging", "true");
  };
  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = e.clientY - d.y;
    // Nach oben folgt es dem Finger, nach unten nur zäh (Gummiband).
    const shown = d.dy < 0 ? d.dy : Math.min(24, d.dy * 0.2);
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${shown.toFixed(1)}px)`;
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const el = sheetRef.current;
    el?.removeAttribute("data-dragging");
    if (el) el.style.transform = "";
    if (d.dy < -DRAG_CLOSE_PX) onClose();
  };
  const dragHandlers = { onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd };

  // Beim ersten Öffnen den zuletzt benutzten Faden zurückholen (sobald die Liste da ist).
  const { restore } = chat;
  useEffect(() => {
    if (threads.data) restore(threads.data);
  }, [threads.data, restore]);

  useEffect(() => {
    if (state === "open") inputRef.current?.focus({ preventScroll: true });
  }, [state]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.entries]);

  const current: HaikuThread | undefined = chat.threadId !== null ? threads.data?.find((th) => th.id === chat.threadId) : undefined;
  const toggleTemp = useMutation({
    mutationFn: (v: { id: number; temporary: boolean }) => patchThread(v.id, { temporary: v.temporary }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: THREADS_KEY }),
  });

  const submit = () => {
    const text = draft.trim();
    if (!text || chat.busy || notReady) return;
    setDraft("");
    void (async () => {
      if (onLocal && (await onLocal(text))) return;
      await chat.send(text, context);
    })();
  };

  const askDemo = (question: string) => {
    if (chat.busy || notReady) return;
    void chat.send(question, context);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const openThread = (id: number) => {
    void chat.openThread(id);
    inputRef.current?.focus({ preventScroll: true });
  };
  const newThread = () => {
    chat.reset();
    inputRef.current?.focus({ preventScroll: true });
  };
  // „⏳ Temporär“ gilt für den aktuellen Faden – oder, solange noch keiner da ist, für den neuen.
  const tempChecked = current ? current.temporary : chat.threadId === null ? chat.temporaryNext : false;
  const setTemp = (next: boolean) => {
    if (current) toggleTemp.mutate({ id: current.id, temporary: next });
    else if (chat.threadId === null) chat.setTemporaryNext(next);
  };

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-labelledby="nyx-center-title"
      data-state={state}
      data-testid="nyx-center"
      hidden={hidden}
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      // Nicht modal, kein Hintergrund: nur das Feld selbst nimmt Klicks an, alles daneben bleibt bedienbar.
      className="nyx-center @container/nyxdrop fixed z-[60] flex max-h-[70vh] min-w-0 flex-col overflow-hidden rounded-2xl"
    >
      <header className="relative grid min-w-0 shrink-0 cursor-grab touch-none gap-2.5 border-b border-a-line/60 px-3 pb-2.5 pt-3 active:cursor-grabbing" {...dragHandlers}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center">
            <NyxAura state={visual !== "idle" ? visual : chat.busy ? "thinking" : "idle"} size={28} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <b id="nyx-center-title" className="font-display text-headline text-a-ink">Nyx</b>
              {/* Dasselbe Zustandswort wie im Nyx-Tab und in der Leiste (`nyx/stateWord.ts`). */}
              <span data-testid="nyx-zustandswort" data-tone={word.tone} className={cn("inline-flex min-w-0 items-center gap-1.5 text-caption", word.text)}>
                <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", word.dot, word.active && "cc-pulse")} />
                <span className="truncate">{word.word}</span>
                {!word.active && status.data?.engine.state === "ready" && status.data.engine.model && <span className="truncate text-a-mut" title={describeModel(status.data.engine.model)}>· {modelName(status.data.engine.model)}</span>}
              </span>
            </div>
            <div className="truncate font-mono text-label text-a-mut" title={crumbs.join(" › ")}>
              {crumbs.length > 0 ? t("Sieht: {where}", { where: crumbs.join(" › ") }) : t("Sieht: –")}
            </div>
          </div>
          <kbd className="hidden shrink-0 rounded border border-a-line px-1.5 py-px font-mono text-label text-a-mut @min-[380px]/nyxdrop:inline">⌘J</kbd>
          <button type="button" onClick={onClose} aria-label={t("Nyx schließen")} title={t("Schließen (Esc)")} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-a-mut hover:bg-a-p3 hover:text-a-ink">
            ✕
          </button>
        </div>

        {tiles && tiles.length > 0 && <NyxQuickTiles tiles={tiles} />}
      </header>

      <div ref={scrollRef} className="cc-scroll grid min-h-0 min-w-0 flex-[1_1_auto] content-start gap-2.5 overflow-y-auto overscroll-contain p-3 text-caption">
        {/* Fäden: Suche, „⏳ Temporär“ für den aktuellen/neuen Faden, „+ Neuer Faden“; höchstens ~5 Zeilen hoch.
            Je Faden „⋯“; darunter „Archiv“ – dieselbe Liste zeigt dann die archivierten Fäden. */}
        {view === "threads" ? (
          <ThreadList
            key="threads"
            threads={threads.data}
            loading={threads.isPending}
            failed={threads.isError}
            onRetry={() => void threads.refetch()}
            activeId={chat.threadId}
            onOpen={openThread}
            onNew={newThread}
            renderMenu={(th) => <ThreadMenu title={th.title || th.topic} items={threadActions.itemsFor(th, false)} />}
            listClassName="max-h-[120px]"
            actions={!notReady || current ? <TemporarySwitch checked={tempChecked} onChange={setTemp} what="thread" compact /> : null}
            footer={
              <button type="button" onClick={() => setView("archive")} className="justify-self-start rounded-md px-1.5 py-0.5 text-caption text-a-mut transition-colors duration-150 hover:bg-a-p2 hover:text-a-ink">
                <span aria-hidden="true">🗄 </span>{t("Archiv")}
              </button>
            }
          />
        ) : (
          <ThreadList
            key="archive"
            label={t("Archivierte Fäden")}
            emptyText={t("Das Archiv ist leer. Über „⋯ → Archivieren“ landen Fäden hier.")}
            threads={archived.data}
            loading={archived.isPending}
            failed={archived.isError}
            onRetry={() => void archived.refetch()}
            activeId={chat.threadId}
            onOpen={openThread}
            renderMenu={(th) => <ThreadMenu title={th.title || th.topic} items={threadActions.itemsFor(th, true)} />}
            listClassName="max-h-[120px]"
            actions={
              <button
                type="button"
                onClick={() => setView("threads")}
                className="shrink-0 rounded-md border border-a-line px-2.5 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-p2"
              >
                {t("Zurück zu den Fäden")}
              </button>
            }
          />
        )}
        {threadActions.notice}
        <PlanCards />
        {chat.loadingThread && <div className="h-16 animate-pulse rounded-lg bg-a-p2 motion-reduce:animate-none" aria-label={t("Verlauf lädt")} />}
        {chat.loadError && <p className="text-caption text-a-bad">{chat.loadError}</p>}
        {!chat.loadingThread && chat.entries.length === 0 && (
          <div className="grid gap-2.5 px-1 py-2">
            <p className="text-caption leading-relaxed text-a-mut">
              {t("Frag Nyx nach Sessions, Aufgaben oder Entscheidungen – oder gib einen Auftrag. Er sieht, was du gerade offen hast, und nennt zu jeder Aussage die Quelle.")}
            </p>
            {!notReady && !demo && (
              <div className="flex flex-wrap gap-1.5">
                {STARTERS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => {
                      setDraft(q);
                      inputRef.current?.focus();
                    }}
                    className="rounded-full border border-a-acc/40 bg-a-acc/10 px-2.5 py-1 text-caption text-a-acc transition-colors duration-150 hover:bg-a-acc/20"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {chat.entries.map((entry) => (
          <Bubble key={entry.key} entry={entry} />
        ))}
      </div>

      <div className="grid min-w-0 shrink-0 border-t border-a-line/60">
        {status.data && notReady && <EngineNotice status={status.data} where="panel" onRetry={() => void status.refetch()} className="mx-2.5 mt-2.5" />}
        <DemoQuestions onAsk={askDemo} disabled={chat.busy || notReady} className="mx-2.5 mt-2.5" />
        <Composer inputRef={inputRef} draft={draft} setDraft={setDraft} onKeyDown={onKeyDown} onSubmit={submit} busy={chat.busy} locked={notReady} />
      </div>
      {threadActions.dialog}
    </div>
  );
}

function Composer({
  inputRef,
  draft,
  setDraft,
  onKeyDown,
  onSubmit,
  busy,
  locked,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (v: string | ((prev: string) => string)) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  busy: boolean;
  /** Motor nicht bereit: Eingabe gesperrt, der Grund steht im Hinweis darüber. */
  locked: boolean;
}) {
  return (
    <form
      className="grid min-w-0 gap-1.5 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {/* Längen-Wahl direkt an der Eingabe – dieselbe gemerkte Wahl wie im Nyx-Tab. */}
      {!locked && <AnswerLengthPicker />}
      <div className="flex min-w-0 items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t("Frage an Nyx")}</span>
          <textarea
            ref={inputRef}
            aria-label={t("Frage an Nyx")}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={locked}
            placeholder={locked ? t("Nyx ist noch nicht bereit – siehe Hinweis oben") : t("Frag Nyx oder gib einen Auftrag …")}
            className={cn(FIELD, "block max-h-40 min-h-[44px] resize-none rounded-[9px] bg-a-bg py-2 leading-snug disabled:cursor-not-allowed disabled:opacity-60")}
          />
        </label>
        {!locked && (
          <MicButton
            target="haiku"
            shortcutKey={null}
            className="shrink-0 [&>span:first-of-type]:hidden"
            onResult={(r) => {
              if (!r.text.trim()) return;
              setDraft((prev) => (prev.trim() ? `${prev.trimEnd()} ${r.text.trim()}` : r.text.trim()));
              inputRef.current?.focus();
            }}
          />
        )}
        <button
          type="submit"
          disabled={!draft.trim() || busy || locked}
          // Gesperrt muss gesperrt AUSSEHEN – grau statt türkis, kein Hover-Glanz.
          className="h-11 shrink-0 rounded-[9px] border border-a-acc bg-a-acc px-3 text-caption font-semibold text-a-bg transition-colors duration-150 enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:border-a-line disabled:bg-a-p3 disabled:text-a-mut"
        >
          {t("Senden")}
        </button>
      </div>
    </form>
  );
}

/** Karten aus dem Menü „⋯“ – je Art eigene Farbe und Überschrift. */
const NOTE_META: Record<string, { label: string; icon: string; bar: string }> = {
  summary: { label: t("Zusammenfassung"), icon: "✦", bar: "border-l-a-violet" },
  task: { label: t("Aufgabe"), icon: "☰", bar: "border-l-a-lime" },
  obsidian: { label: "Obsidian", icon: "◆", bar: "border-l-a-indigo" },
};

function NoteCard({ entry }: { entry: ChatEntry }) {
  const meta = NOTE_META[entry.noteKind ?? ""] ?? { label: t("Notiz"), icon: "•", bar: "border-l-a-acc" };
  return (
    <div role="note" aria-label={meta.label} className={cn("cc-rise grid min-w-0 gap-1.5 rounded-lg border border-l-[3px] border-a-line bg-a-p px-3 py-2 text-a-ink", meta.bar)}>
      <div className="flex items-center gap-1.5 font-mono text-label uppercase tracking-wide text-a-mut">
        <span aria-hidden="true">{meta.icon}</span>
        {meta.label}
      </div>
      <div className="min-w-0 break-words leading-relaxed [overflow-wrap:anywhere]">
        <Markdown text={entry.text} sources={entry.sources} />
      </div>
      <SourceChips sources={entry.sources} />
    </div>
  );
}

function Bubble({ entry }: { entry: ChatEntry }) {
  if (entry.role === "note") return <NoteCard entry={entry} />;
  if (entry.role === "user") {
    return <div className="cc-rise max-w-[92%] justify-self-end whitespace-pre-wrap break-words rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-2 text-a-ink">{entry.text}</div>;
  }
  const status = entry.pending ? pendingText(entry.pending) : null;
  return (
    <div className="cc-rise grid min-w-0 max-w-[92%] gap-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2 text-a-ink" aria-busy={entry.pending ? true : undefined}>
      <NyxThoughts thoughts={entry.thoughts} />
      {entry.text && (
        <div className="min-w-0 break-words leading-relaxed [overflow-wrap:anywhere]">
          <Markdown text={entry.text} sources={entry.sources} />
        </div>
      )}
      {status && (
        <div className="flex items-center gap-2 text-caption text-a-mut" role="status">
          {/* Statt drei Pünktchen denkt das Nyx-Logo sichtbar mit. */}
          <NyxAura size={16} state="thinking" />
          <span>{status}</span>
        </div>
      )}
      {entry.error && (
        <div role="alert" className="grid gap-1 text-caption text-a-bad">
          <span>{HAIKU_ERROR_TEXT[entry.error.code] ?? entry.error.message}</span>
          {entry.error.code === "engine" && entry.error.message && <span className="text-caption text-a-mut">{entry.error.message}</span>}
          {entry.error.code === "not_ready" && entry.error.message && <span className="text-caption text-a-mut">{entry.error.message}</span>}
          {entry.error.code === "disabled" && (
            <Link to="/einstellungen/nyx/motor" className="text-caption text-a-acc underline">
              {t("In Einstellungen einschalten")}
            </Link>
          )}
          {entry.error.code === "budget" && (
            <Link to="/einstellungen/nyx/motor" className="text-caption text-a-acc underline">
              {t("Zu den Nyx-Einstellungen")}
            </Link>
          )}
        </div>
      )}
      {!entry.pending && entry.text.trim() && (
        <div>
          <ReadAloudMessageButton text={entry.text} />
        </div>
      )}
      {!entry.pending && !entry.error && (
        <>
          <SourceChips sources={entry.sources} />
          {entry.estimate && (
            <div>
              <EstimateTag long />
            </div>
          )}
        </>
      )}
    </div>
  );
}
