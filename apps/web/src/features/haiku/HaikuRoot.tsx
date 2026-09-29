// Haiku global im App-Rahmen: Nyx lebt oben in der Leiste.
//   • Nyx-Leiste in der Kopfzeile: Klick (oder ⌘J) öffnet das Nyx-Feld direkt unter der Leiste (so breit wie
//     die Leiste, rechtsbündig, nicht modal – die Seite bleibt bedienbar; wie die Mitteilungszentrale).
//   • Nyx hört nie von selbst zu – Dauer-Zuhören ist nur ein bewusst eingeschalteter Wunsch in den Einstellungen.
//   • Gedrückt halten (Maus/Trackpad/Touch oder ⌥ Leertaste) = sprechen; Loslassen → Transkription → Nyx.
//     Direkt unter der Leiste klappt das Ausgabe-Feld auf (Gesagtes, Antwort, Zustand), die Stimme spricht mit.
//   • `nyx.ui`: der Nyx-Cursor startet sichtbar aus der Leiste, fliegt zum Ziel, klickt und fliegt zurück.
// Das Zentrum wird beim ersten Öffnen eingehängt und bleibt danach eingehängt (nur versteckt) – Faden, Verlauf,
// Entwurf und eine laufende Antwort überleben das Schließen.
import { t, type HaikuContext, type HaikuSource, type NyxUiCommand } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { subscribeNyxLive } from "../../lib/liveBus";
import { NAV_ITEMS } from "../../nav";
import { useOpenQuestions } from "../inbox/useInbox";
import { NYX_ASK_EVENT, type NyxAskDetail } from "./askNyx";
import { NyxBar } from "../nyx/bar/NyxBar";
import { NyxCaption } from "../nyx/bar/NyxCaption";
import { ICONS, type QuickTile } from "../nyx/bar/NyxQuickTiles";
import { useBarCursor } from "../nyx/bar/useBarCursor";
import { usePushToTalk } from "../nyx/bar/usePushToTalk";
import { useCompanionSettings } from "../nyx/companionSettings";
import { parseLocalCommand } from "../nyx/localCommands";
import type { NyxVisualState } from "../nyx/netModel";
import { executeNyxUi, type ExecResult, type NyxCursorDriver } from "../nyx/uiExecutor";
import { createUiRemote, errorText, newTabId } from "../nyx/uiRemote";
import { useNyxVoiceLoop } from "../nyx/useNyxVoiceLoop";
import { useNyxVisualSequence } from "../nyx/visualSequence";
import { transcribe } from "../nyx/voice/serverVoice";
import { authFetch } from "../terminal/authClient";
import { openNewSession } from "../terminal/terminalApi";
import { useHaikuStatus } from "./EngineStatus";
import { HaikuPanel } from "./HaikuPanel";
import { HAIKU_SLOT_ID } from "./slot";
import "./ui";
import { useHaikuChat } from "./useHaikuChat";
import { useHaikuContext } from "./useHaikuContext";
import { useHaikuLive } from "./useHaikuLive";
import { THREADS_KEY } from "./useThreadActions";

/** Dauer der Schließ-Animation des Nyx-Felds (kurz, ~180 ms). */
const EXIT_MS = 180;
/** Länger darf ein Befehl im Browser nie dauern (der Server wartet 12 s). */
const RUN_LIMIT_MS = 10_000;
/** Kennung dieses Fensters für `nyx.ui.run` (Hintergrund-Ausführung auf Zuruf des Servers). */
const TAB_ID = newTabId();
/** Hintergrund-Fenster: kein Cursor-Flug (kein Bild-Takt, gebremste Zeitgeber), nur das Ergebnis zählt. */
const INSTANT_CURSOR: NyxCursorDriver = { flyTo: async () => {}, press: async () => {}, glow: () => {} };
/** Lokale Bestätigungen („öffne Git“) haben keine Belege – stabiler leerer Wert. */
const NO_SOURCES: HaikuSource[] = [];
/** Ausgabe-Feld schließt sich nach so langer Ruhe von selbst. */
export const CAPTION_IDLE_MS = 9_000;
/** Faden der Leiste (Sprache + Ausgabe-Feld), über Seitenwechsel gemerkt. */
export const BAR_THREAD_KEY = "nyxos:companion-thread";

const NAV = NAV_ITEMS.flatMap((n) => (n.status === "active" ? [{ id: n.id, label: n.label, path: n.path }] : []));

function readBarThread(): number | null {
  try {
    const v = Number(sessionStorage.getItem(BAR_THREAD_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function HaikuRoot() {
  useHaikuLive();
  // Farbig zählen nur die echten offenen Fragen; Sortier-Vorschläge stehen grau daneben.
  const openQuestions = useOpenQuestions().data;
  const count = openQuestions?.total ?? null;
  const status = useHaikuStatus();
  const loopRef = useRef<ReturnType<typeof useNyxVoiceLoop> | null>(null);
  // Auch getippte Fragen im Zentrum (⌘J, ⌘K „Nyx fragen“) liest Nyx vor – außer „Vorlesen“ ist aus (die Stimme
  // prüft `settings.speak`). Gesprochen wird nur die Zwischenmeldung und die fertige Antwort, nie die Gedanken.
  const chat = useHaikuChat({ onFiller: (text) => loopRef.current?.say(text, { filler: true }), onAnswer: (text) => loopRef.current?.speakAnswer(text) });
  const settings = useCompanionSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { context } = useHaikuContext();
  const ctxRef = useRef<HaikuContext>(context);
  ctxRef.current = context;

  // ─── Nyx-Zentrum (von oben) ───
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [hidden, setHidden] = useState(true);
  const barRef = useRef<HTMLButtonElement>(null);
  // Einhängepunkt in der Kopfzeile (TopBar) – erst nach dem ersten Rendern im DOM.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(HAIKU_SLOT_ID)), []);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);

  const wasOpen = useRef(false);
  /** Wo der Fokus vor dem Öffnen stand – dorthin kehrt er nach dem Schließen zurück (sonst zur Leiste). */
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && active !== document.body && !active.closest("[data-testid='nyx-center']") ? active : null;
      wasOpen.current = true;
      setMounted(true);
      setHidden(false);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    setShown(false);
    const timer = setTimeout(() => {
      setHidden(true);
      // Nur zurückholen, wenn der Fokus nicht schon woanders hingewandert ist (z. B. Nyx hat ein Feld angeklickt).
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest("[data-testid='nyx-center']")) return;
      const back = returnFocus.current?.isConnected ? returnFocus.current : barRef.current;
      back?.focus({ preventScroll: true });
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // ─── Ausgabe-Feld + Sprache ───
  const cursor = useBarCursor();
  const ptt = usePushToTalk();
  const [holdActive, setHoldActive] = useState(false);
  const holdRef = useRef(false);
  /** Zählt jedes Halten: ein spät scheiterndes Mikrofon eines alten Haltens beendet nicht das neue. */
  const holdGen = useRef(0);
  const [transcribing, setTranscribing] = useState(false);
  const [captionOpen, setCaptionOpen] = useState(false);
  const [captionFocused, setCaptionFocused] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [serverState, setServerState] = useState<{ state: NyxVisualState; tool: string | null } | null>(null);
  /** Seit dem letzten Öffnen des Zentrums lief ein Gespräch in der Leiste → das Zentrum zeigt diesen Faden. */
  const barTurnSinceOpen = useRef(false);

  // ─── Plattform steuern (`nyx.ui`), strikt nacheinander ───
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const { driver: cursorDriver, release: releaseCursor } = cursor;
  const execDeps = useMemo(() => ({ navigate: (r: string) => navigate(r), cursor: cursorDriver, route: () => window.location.pathname + window.location.search }), [navigate, cursorDriver]);
  const openRef = useRef(open);
  openRef.current = open;
  const runSteps = useCallback(
    (steps: NyxUiCommand[], opts: { background?: boolean } = {}): Promise<ExecResult> => {
      // Im Hintergrund-Fenster ohne Cursor-Flug: dort läuft kein Bild-Takt, Zeitgeber werden stark gebremst.
      // Auch ohne Tipp-Pause: jeder Zeitgeber dauert im Hintergrund ≥ 1 s – 20 Zeichen sprengten sonst das Zeitlimit.
      const deps = opts.background ? { ...execDeps, cursor: INSTANT_CURSOR, typeDelayMs: 0 } : execDeps;
      const job = chain.current.then(async (): Promise<ExecResult> => {
        try {
          // Nyx bedient die Seite: das Zentrum geht aus dem Weg, damit man den Cursor sieht.
          if (!opts.background && openRef.current && steps.some((s) => s.action !== "read_screen")) {
            setOpen(false);
            await new Promise((r) => setTimeout(r, EXIT_MS));
          }
          let result: ExecResult = { ok: true };
          for (const step of steps) {
            result = await executeNyxUi(step, deps);
            if (!result.ok) break;
          }
          return result;
        } catch (e) {
          return { ok: false, detail: errorText(e), route: window.location.pathname };
        } finally {
          releaseCursor();
        }
      });
      // Ein hängender Schritt darf die Kette nie für immer blockieren (sonst antwortet kein Befehl mehr).
      const guarded = Promise.race([job, new Promise<ExecResult>((r) => setTimeout(() => r({ ok: false, detail: t("Das hat im Browser zu lange gedauert.") }), RUN_LIMIT_MS))]);
      chain.current = guarded.catch(() => undefined);
      return guarded;
    },
    [execDeps, releaseCursor],
  );

  const handleLocal = useCallback(
    async (text: string): Promise<boolean> => {
      const plan = parseLocalCommand(text, { path: window.location.pathname, nav: NAV });
      if (!plan) return false;
      setReply(plan.say);
      setNote(null);
      setCaptionOpen(true);
      loopRef.current?.say(plan.say);
      if (plan.back) {
        window.history.back();
        return true;
      }
      const r = await runSteps(plan.steps);
      if (!r.ok) {
        const msg =
          plan.steps.some((s) => "target" in s && s.target === "recent-item:*") && !r.risky
            ? t("Du hast noch keine Session geöffnet – öffne eine, dann finde ich sie wieder.")
            : (r.detail ?? t("Das hat nicht geklappt."));
        setReply(msg);
        loopRef.current?.say(msg);
      }
      return true;
    },
    [runSteps],
  );

  // Im Nyx-Tab gehört das Dauer-Zuhören dem Tab (großer Sprech-Knopf) – sonst hörten und antworteten beide.
  // Während gedrückt gehalten wird, pausiert es auch (sonst ginge derselbe Satz zweimal an Nyx).
  const onNyxTab = /^\/nyx(\/|$)/.test(location.pathname);
  const loop = useNyxVoiceLoop({
    listening: settings.listening && !onNyxTab && !holdActive,
    speak: settings.speak,
    channel: "voice",
    context: () => ctxRef.current,
    intercept: handleLocal,
    threadKey: BAR_THREAD_KEY,
  });
  loopRef.current = loop;

  // Dauer-Zuhören hat etwas gehört / Nyx antwortet → im Ausgabe-Feld zeigen.
  useEffect(() => {
    if (loop.heard) {
      setHeard(loop.heard);
      setCaptionOpen(true);
      barTurnSinceOpen.current = true;
    }
  }, [loop.heard]);
  useEffect(() => {
    if (loop.answer) setReply(loop.answer);
  }, [loop.answer]);
  useEffect(() => {
    if (loop.error) setCaptionOpen(true);
  }, [loop.error]);
  // Nach einer Antwort aus der Leiste: Fadenliste im Zentrum auffrischen.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !loop.busy) void qc.invalidateQueries({ queryKey: THREADS_KEY });
    wasBusy.current = loop.busy;
  }, [loop.busy, qc]);

  const ask = useCallback(
    async (text: string, channel: "voice" | "web") => {
      setHeard(text);
      setReply("");
      setNote(null);
      setCaptionOpen(true);
      barTurnSinceOpen.current = true;
      if (await handleLocal(text)) return;
      await loopRef.current?.send(text, { channel, speak: settings.speak });
    },
    [handleLocal, settings.speak],
  );

  // ─── Gedrückt halten = sprechen ───
  const holdStart = useCallback(async () => {
    if (holdRef.current) return;
    holdRef.current = true;
    const mine = ++holdGen.current;
    setHoldActive(true);
    loopRef.current?.interrupt();
    setNote(null);
    // Sprechen gehört ins Ausgabe-Feld unter der Leiste – ein offenes Zentrum geht dafür zu.
    setOpen(false);
    setCaptionOpen(true);
    const ok = await ptt.start();
    if (!ok && holdGen.current === mine && holdRef.current) {
      holdRef.current = false;
      setHoldActive(false);
    }
  }, [ptt]);

  const holdEnd = useCallback(async () => {
    if (!holdRef.current) return;
    holdRef.current = false;
    setHoldActive(false);
    const rec = await ptt.stop();
    if (!rec) {
      setNote(t("Das war zu kurz – halte die Leiste gedrückt, solange du sprichst."));
      return;
    }
    setTranscribing(true);
    try {
      const r = await transcribe(rec.blob, { audioSeconds: rec.ms / 1000 });
      if (!r.text) {
        setNote(t("Ich habe nichts verstanden – halte die Leiste gedrückt und sprich noch einmal."));
        return;
      }
      setTranscribing(false);
      await ask(r.text, "voice");
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : t("Die Erkennung hat nicht geklappt – bitte noch einmal sprechen."));
    } finally {
      setTranscribing(false);
    }
  }, [ptt, ask]);

  /** Weggezogen, Fenster verlassen oder Esc: Aufnahme verwerfen, nichts geht an Nyx. */
  const holdCancel = useCallback(() => {
    if (!holdRef.current) return;
    holdRef.current = false;
    setHoldActive(false);
    ptt.cancel();
    setNote(t("Abgebrochen – nichts gesendet."));
  }, [ptt]);

  // Fenster verliert den Fokus (⌘Tab, anderer Tab) während gehalten wird: sonst bliebe das Mikrofon offen,
  // weil das Loslassen nie ankommt.
  useEffect(() => {
    const onBlur = () => holdCancel();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") holdCancel();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [holdCancel]);

  // ─── Tastatur: ⌘J Zentrum, Esc (Halten abbrechen → Zentrum → Ausgabe-Feld), ⌥ Leertaste halten = sprechen ───
  const captionOpenRef = useRef(captionOpen);
  captionOpenRef.current = captionOpen;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggle();
      } else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) void holdStart();
      } else if (e.key === "Escape") {
        // Ein Menü/Dialog darüber hat Esc schon verbraucht.
        if (e.defaultPrevented) return;
        if (holdRef.current) holdCancel();
        else if (openRef.current) close();
        else if (captionOpenRef.current) setCaptionOpen(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (holdRef.current && (e.code === "Space" || e.key === "Alt")) {
        e.preventDefault();
        void holdEnd();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [toggle, close, holdStart, holdEnd, holdCancel]);

  // ─── Server-Nachrichten: `nyx.ui` ausführen und antworten, `nyx.state` anzeigen ───
  // Nur über den angemeldeten Weg (Anmeldung + Schutz-Token): `/live` ist ohne Anmeldung lesbar, eine Antwort
  // dort könnte jeder fälschen, der mithört (die erste Antwort gewinnt).
  const uiRemote = useMemo(
    () =>
      createUiRemote({
        tabId: TAB_ID,
        visible: () => document.visibilityState === "visible",
        route: () => window.location.pathname + window.location.search,
        post: (body) => void authFetch("/api/nyx/ui/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}),
        run: (steps, opts) => runSteps(steps, opts),
      }),
    [runSteps],
  );

  useEffect(
    () =>
      subscribeNyxLive((msg) => {
        if (msg.type === "nyx.state") {
          const st = msg.state;
          if (st === "idle" || st === "listening" || st === "thinking" || st === "speaking" || st === "tool") setServerState({ state: st, tool: typeof msg.tool === "string" ? msg.tool : null });
          return;
        }
        uiRemote.handle(msg);
      }),
    [uiRemote],
  );
  useEffect(() => {
    if (!serverState) return;
    const timer = setTimeout(() => setServerState(null), 30_000);
    return () => clearTimeout(timer);
  }, [serverState]);

  // ─── Test-/Probe-Haken: denselben Weg wie ein gesprochener Satz gehen ───
  useEffect(() => {
    const api = {
      command: (text: string) => ask(text, "voice"),
      run: (steps: NyxUiCommand[]) => runSteps(steps),
      state: () => loopRef.current?.state ?? "idle",
    };
    (window as unknown as { __nyx?: typeof api }).__nyx = api;
    return () => {
      delete (window as unknown as { __nyx?: typeof api }).__nyx;
    };
  }, [ask, runSteps]);

  const talking = holdActive || ptt.recording;
  // Roher Zustand aus Stimme, getipptem Chat (Nyx-Feld) und Server – daraus macht `useNyxVisualSequence` die ruhige
  // Farbfolge blau → rot → orange → grün → lila (Leiste, Nyx-Feld und Ausgabe-Feld zeigen dieselbe).
  const pending = chat.entries.at(-1)?.pending;
  const chatState: NyxVisualState | null = !chat.busy || !pending ? null : pending.phase === "tool" ? "tool" : pending.phase === "streaming" ? "speaking" : "thinking";
  const rawVisual: NyxVisualState = talking ? "listening" : transcribing ? "thinking" : loop.state !== "idle" ? loop.state : (chatState ?? serverState?.state ?? "idle");
  const rawTool = loop.tool ?? (pending?.phase === "tool" ? (pending.tool ?? null) : null) ?? serverState?.tool ?? null;
  const { state: visual, tool: toolName } = useNyxVisualSequence(rawVisual, rawTool);

  // Ausgabe-Feld schließt sich nach kurzer Ruhe von selbst (nicht, solange gesprochen/gedacht/getippt wird).
  const quiet = !talking && !transcribing && !loop.busy && visual !== "speaking" && visual !== "thinking" && visual !== "tool" && !captionFocused && !captionDraft.trim();
  useEffect(() => {
    if (!captionOpen || !quiet) return;
    const timer = setTimeout(() => setCaptionOpen(false), CAPTION_IDLE_MS);
    return () => clearTimeout(timer);
  }, [captionOpen, quiet, reply, heard, note]);

  // Zentrum öffnet sich: Ausgabe-Feld weg; lief gerade ein Gespräch in der Leiste, zeigt das Zentrum diesen Faden.
  const { openThread } = chat;
  useEffect(() => {
    if (!open) return;
    setCaptionOpen(false);
    if (!barTurnSinceOpen.current) return;
    barTurnSinceOpen.current = false;
    const id = readBarThread();
    if (id !== null) void openThread(id);
  }, [open, openThread]);

  const notReady = status.data !== undefined && status.data.engine.state !== "ready";
  const tiles: QuickTile[] = [
    {
      id: "briefing",
      label: t("Briefing vorlesen"),
      hint: t("Öffnet das heutige Briefing und liest es vor – der gerade gelesene Abschnitt leuchtet auf."),
      icon: ICONS.briefing,
      tone: "bg-a-violet text-a-bg",
      onClick: () => {
        close();
        void navigate("/briefing?vorlesen=1");
      },
    },
    {
      id: "session",
      nyx: "neue-session",
      label: t("Neue Session"), hint: t("Neue Claude- oder Codex-Session starten."), icon: ICONS.session, tone: "bg-a-acc text-a-bg", onClick: () => {
        close();
        openNewSession();
      },
    },
    {
      id: "status",
      label: t("Status"),
      hint: t("Was läuft, was wartet auf dich?"),
      icon: ICONS.status,
      tone: "bg-a-lime text-a-bg",
      disabled: notReady || chat.busy,
      onClick: () => void chat.send(t("Wie ist der Stand? Was läuft gerade und was wartet auf mich?"), ctxRef.current),
    },
    // Keine „Zuhören“-Kachel mehr – Nyx hört nur, solange die Leiste gedrückt gehalten wird.
    {
      id: "tab",
      label: t("Nyx-Tab öffnen"),
      hint: t("Nyx groß: Gedächtnis, Aufgaben, Stimme."),
      icon: ICONS.nyx,
      tone: "bg-a-nyx text-a-bg",
      onClick: () => {
        close();
        void navigate("/nyx");
      },
    },
    {
      id: "last-session",
      label: t("Letzte Session öffnen"),
      hint: t("Öffnet die zuletzt geöffnete Session – Nyx klickt sich sichtbar hin."),
      icon: ICONS.recent,
      tone: "bg-a-wait text-a-bg",
      onClick: () => {
        close();
        void handleLocal("öffne die letzte Session");
      },
    },
  ];

  // ⌘K „Nyx fragen: …“ → Panel öffnen, Frage ins Eingabefeld (nicht abschicken).
  useEffect(() => {
    const onAsk = (e: Event) => {
      const text = (e as CustomEvent<NyxAskDetail>).detail?.text ?? "";
      setDraft(text);
      setOpen(true);
    };
    window.addEventListener(NYX_ASK_EVENT, onAsk);
    return () => window.removeEventListener(NYX_ASK_EVENT, onAsk);
  }, []);

  const badge = count && count > 0 ? (count > 99 ? "99+" : String(count)) : null;
  const sorting = openQuestions?.sorting ?? 0;
  const barProps = {
    open,
    onToggle: toggle,
    status: status.data,
    busy: chat.busy || loop.busy,
    badge,
    sorting,
    visual,
    toolName,
    talking,
    level: talking ? ptt.level : loop.level,
    cursorOut: cursor.mode === "out",
    onHoldStart: () => void holdStart(),
    onHoldEnd: () => void holdEnd(),
    onHoldCancel: holdCancel,
    buttonRef: barRef,
  };
  const captionError = ptt.error ?? note ?? loop.error ?? loop.micError;

  return (
    <>
      {slot ? createPortal(<NyxBar {...barProps} />, slot) : <NyxBar {...barProps} floating />}
      {captionOpen && !open && (
        <NyxCaption
          anchorRef={barRef}
          talking={talking}
          transcribing={transcribing}
          visual={visual}
          toolName={toolName}
          heard={heard}
          reply={reply}
          sources={reply === loop.answer ? loop.answerSources : NO_SOURCES}
          thoughts={reply === loop.answer ? loop.thoughts : undefined}
          error={captionError}
          draft={captionDraft}
          setDraft={setCaptionDraft}
          onSubmit={() => {
            const text = captionDraft.trim();
            if (!text) return;
            setCaptionDraft("");
            void ask(text, "web");
          }}
          onClose={() => setCaptionOpen(false)}
          onOpenCenter={() => setOpen(true)}
          onFocusChange={setCaptionFocused}
        />
      )}
      {mounted && (
        <HaikuPanel state={shown && open ? "open" : "closed"} hidden={hidden} onClose={close} chat={chat} draft={draft} setDraft={setDraft} anchorRef={barRef} tiles={tiles} visual={visual} onLocal={handleLocal} />
      )}
      {cursor.layer}
    </>
  );
}
