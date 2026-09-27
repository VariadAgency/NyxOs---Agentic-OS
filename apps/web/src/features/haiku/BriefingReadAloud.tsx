// Briefing zum Anhören: Knopf „▶ Vorlesen“, Untertitel-Leiste und Hervorhebung.
//
// Während des Vorlesens trägt die Briefing-Fläche `data-reading`. Nichts wird abgedunkelt – nur die Stelle, über
// die der aktuelle Satz spricht (`data-speech-target` = `target` aus der Sprechfassung), trägt `data-speech-active`,
// bekommt einen farbigen Rahmen in ihrer Farbe und wird sanft in den Blick gescrollt. Unten steht der gesprochene Satz als Untertitel mit
// Pause/Weiter, Stopp und Tempo. Esc oder ein Klick daneben beendet das Vorlesen.
import { BRIEF_SPEECH_SECTION_TITLE, getLang, nyxVoicePartSentence, t, tc, type NyxVoiceStatus } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { createBriefingReader, createBrowserReaderDeps, type BriefingReader, type ReaderDeps, type ReaderSnapshot } from "./briefingReader";
import { fetchBriefingSpeech, getJson } from "./haikuApi";

const SPEED_KEY = "nyxos.briefing.tempo";
/** Tempo-Stufen (der Server nimmt 0,5–2). */
export const SPEEDS = [0.85, 1, 1.15, 1.3] as const;
const speedLabel = (s: number) => `${getLang() === "en" ? String(s) : String(s).replace(".", ",")}×`;

function readSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return (SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}
function writeSpeed(v: number) {
  try {
    localStorage.setItem(SPEED_KEY, String(v));
  } catch {
    // ohne Speicher gilt das Tempo bis zum Neuladen
  }
}

const IDLE: ReaderSnapshot = { state: "idle", index: -1, sentence: null, total: 0, speed: 1, message: null };
const isReading = (s: ReaderSnapshot) => s.state === "loading" || s.state === "playing" || s.state === "paused";

export interface ReadAloud {
  snap: ReaderSnapshot;
  /** Stimme bereit? `null` = Stand noch unbekannt (Knopf trotzdem an). */
  voiceReady: boolean | null;
  voiceReason: string | null;
  preparing: boolean;
  error: string | null;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setSpeed(s: number): void;
}

/**
 * Vorleser für einen Bericht. `rootRef` = die Briefing-Fläche (dort liegen die `data-speech-target`-Stellen).
 * `depsOverride` nur für Tests; im Browser Server-Stimme + EIN `<audio>` je Seite (beim Verlassen freigegeben).
 */
export function useBriefingReadAloud(rootRef: RefObject<HTMLElement | null>, reportId: number | null, depsOverride?: ReaderDeps): ReadAloud {
  const [deps] = useState<ReaderDeps>(() => depsOverride ?? createBrowserReaderDeps());
  const [snap, setSnap] = useState<ReaderSnapshot>(IDLE);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readerRef = useRef<BriefingReader | null>(null);
  /** Jeder Start/Stopp zählt hoch – eine Sprechfassung, die nach „Stopp“ noch ankommt, startet nichts mehr. */
  const seqRef = useRef(0);
  const speedRef = useRef(readSpeed());
  const voice = useQuery({ queryKey: ["nyx", "voice-status"], queryFn: () => getJson<NyxVoiceStatus>("/api/nyx/voice/status"), staleTime: 30_000, retry: false });
  const voiceReady = voice.data ? voice.data.tts.ready : null;
  const voiceReason = voice.data && !voice.data.tts.ready ? nyxVoicePartSentence(voice.data.tts, voice.data.scope).sentence : null;

  const stop = useCallback(() => {
    seqRef.current++;
    setPreparing(false);
    readerRef.current?.stop();
    readerRef.current = null;
    setError(null);
    setSnap(IDLE);
  }, []);

  const start = useCallback(() => {
    if (reportId === null) return;
    readerRef.current?.stop();
    // Noch im Klick: Ton freischalten, bevor Sprechfassung und Stimme (> 1 s) geladen sind (Safari/iOS).
    deps.unlock?.();
    const seq = ++seqRef.current;
    setError(null);
    setPreparing(true);
    fetchBriefingSpeech(reportId)
      .then((speech) => {
        if (seq !== seqRef.current) return;
        if (speech.sentences.length === 0) {
          setError(t("In diesem Bericht gibt es nichts vorzulesen."));
          return;
        }
        const reader = createBriefingReader(speech.sentences, deps, setSnap, { speed: speedRef.current });
        readerRef.current = reader;
        reader.start();
      })
      .catch((err: unknown) => {
        if (seq === seqRef.current) setError(friendlyError(err, t("Die Sprechfassung ließ sich gerade nicht laden – bitte noch einmal.")));
      })
      .finally(() => {
        if (seq === seqRef.current) setPreparing(false);
      });
  }, [reportId, deps]);

  // Anderer Bericht (neu erstellt, Briefing ↔ Recap) oder Seite verlassen: sofort still.
  useEffect(() => stop, [reportId, stop]);
  // Seite verlassen: das `<audio>` samt Blob-URL freigeben (wird bei Bedarf neu angelegt).
  useEffect(() => () => deps.dispose?.(), [deps]);

  // Hervorhebung: genau die Stelle des aktuellen Satzes (farbiger Rahmen), alles andere bleibt lesbar.
  const target = isReading(snap) ? (snap.sentence?.target ?? null) : null;
  const reading = isReading(snap);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (reading) root.setAttribute("data-reading", "");
    else root.removeAttribute("data-reading");
    for (const el of root.querySelectorAll("[data-speech-active]")) el.removeAttribute("data-speech-active");
    if (!target) return;
    // Kennungen sind fest („tile:commits“) – alles andere wird nicht gesucht.
    const el = /^[a-z_]+(?::[a-z0-9_]+)?$/.test(target) ? root.querySelector<HTMLElement>(`[data-speech-target="${target}"]`) : null;
    if (!el) return;
    el.setAttribute("data-speech-active", "");
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }, [rootRef, target, reading]);
  useEffect(
    () => () => {
      const root = rootRef.current;
      root?.removeAttribute("data-reading");
      for (const el of root?.querySelectorAll("[data-speech-active]") ?? []) el.removeAttribute("data-speech-active");
    },
    [rootRef],
  );

  // Esc beendet, Leertaste = Pause/Weiter (nicht in Eingabefeldern).
  useEffect(() => {
    if (!reading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stop();
        return;
      }
      const target = e.target as HTMLElement | null;
      // Auf Knöpfen/Links bleibt die Leertaste deren Klick (sonst pausiert „■ Stopp“ mit Leertaste nur).
      if (e.key === " " && !target?.closest("input, textarea, select, button, a[href], summary, [role=button], [contenteditable]")) {
        e.preventDefault();
        const r = readerRef.current;
        if (r?.snapshot().state === "paused") r.resume();
        else r?.pause();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [reading, stop]);

  // Klick daneben (nicht auf die Leiste) beendet. Bewusst `click`, nicht `pointerdown`: Wischen zum Scrollen
  // (iPhone) oder die Scrollleiste ziehen darf das Vorlesen nicht abbrechen.
  useEffect(() => {
    if (!reading) return;
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest("[data-speech-keep]")) return;
      stop();
    };
    // erst nach dem auslösenden Klick lauschen
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
    };
  }, [reading, stop]);

  return {
    snap,
    voiceReady,
    voiceReason,
    preparing,
    error,
    start,
    stop,
    pause: () => readerRef.current?.pause(),
    resume: () => readerRef.current?.resume(),
    setSpeed: (s) => {
      speedRef.current = s;
      writeSpeed(s);
      readerRef.current?.setSpeed(s);
      setSnap((cur) => ({ ...cur, speed: s }));
    },
  };
}

const TOGGLE = "h-(--a-ctl-h) rounded-lg border px-2.5 text-caption transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc";

/** Knopf im Kopf des Briefings. Ohne Stimme aus – mit Grund daneben. */
export function ReadAloudButton({ ra, disabled }: { ra: ReadAloud; disabled?: boolean }) {
  const reading = isReading(ra.snap) || ra.preparing;
  const off = ra.voiceReady === false || disabled === true;
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        data-speech-keep
        disabled={off && !reading}
        aria-pressed={reading}
        aria-describedby={ra.voiceReason ? reasonId : undefined}
        title={ra.voiceReason ?? t("Das Briefing vorlesen – der erwähnte Abschnitt leuchtet auf")}
        onClick={() => (reading ? ra.stop() : ra.start())}
        className={cn(TOGGLE, "inline-flex items-center gap-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-50", reading ? "border-a-acc bg-a-acc text-a-bg" : "border-a-acc/50 bg-a-acc/10 text-a-acc hover:bg-a-acc/15")}
      >
        <span aria-hidden="true">{reading ? "■" : "▶"}</span>
        {ra.preparing ? t("Vorlesen abbrechen") : reading ? t("Vorlesen beenden") : t("Vorlesen")}
      </button>
      {ra.voiceReason && (
        <span id={reasonId} className="basis-full text-right text-caption text-a-wait">
          {ra.voiceReason}
        </span>
      )}
    </>
  );
}

/**
 * Beim ersten Vorlesen schreibt Nyx die Sprechfassung (einige Sekunden), danach lädt die Stimme den
 * ersten Satz. Solange das dauert, läuft oben über die ganze Breite ein Balken „Vorlesen wird erstellt“ – statt
 * nur ein Hinweis im Knopf (der jetzt „Vorlesen abbrechen“ heißt – bis zu 25 s Warten muss abbrechbar sein). Der Balken läuft schnell an und wird dann langsamer (ehrlich: die Dauer ist unbekannt).
 */
export function ReadAloudProgress({ ra }: { ra: ReadAloud }) {
  const firstAudio = ra.snap.state === "loading" && ra.snap.index <= 0;
  if (!ra.preparing && !firstAudio) return null;
  const label = ra.preparing ? t("Vorlesen wird erstellt – Nyx fasst das Briefing in eigenen Worten zusammen …") : t("Vorlesen wird erstellt – die Stimme spricht gleich …");
  return (
    <div data-testid="read-aloud-progress" data-speech-keep role="status" aria-live="polite" className="grid gap-1.5">
      <div role="progressbar" aria-label={t("Vorlesen wird erstellt")} aria-busy="true" className="relative h-1.5 w-full overflow-hidden rounded-full bg-a-acc/15">
        <div className="cc-prep-fill absolute inset-y-0 left-0 rounded-full bg-a-acc" />
      </div>
      <p className="text-caption text-a-mut">{label}</p>
    </div>
  );
}

/** Untertitel-Leiste unten (über der Seite, nicht abgedunkelt). */
export function ReaderBar({ ra }: { ra: ReadAloud }) {
  const { snap } = ra;
  const visible = isReading(snap) || snap.state === "error" || ra.error !== null;
  if (typeof document === "undefined") return null;
  const message = snap.message ?? ra.error;
  const sentence = visible ? snap.sentence : null;
  // Die Ansage-Fläche steht IMMER im Dokument: eine erst mit dem Text eingefügte aria-live-Fläche liest der
  // Screenreader oft nicht vor (der erste Satz ginge verloren).
  const live = (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {visible ? (message ?? sentence?.text ?? "") : ""}
    </p>
  );
  return createPortal(
    <>
      {live}
      {visible && (
        <div data-speech-keep role="region" aria-label={t("Vorlesen")} className="cc-speech-bar pointer-events-none fixed inset-x-0 bottom-(--a-demo-bar-h) z-50 flex justify-center px-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          <div className="pointer-events-auto grid w-full max-w-[760px] gap-2.5 rounded-2xl border border-a-acc/40 bg-a-p/95 p-3.5 shadow-[0_18px_50px_-12px_color-mix(in_srgb,var(--a-bg)_80%,transparent)] backdrop-blur sm:p-4">
            {sentence && (
              <div className="flex min-w-0 items-center gap-2 font-mono text-label uppercase tracking-[.12em] text-a-acc">
                <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full bg-a-acc", snap.state === "playing" && "cc-speech-pulse")} />
                {t(BRIEF_SPEECH_SECTION_TITLE[sentence.section])}
                <span className="normal-case tracking-normal text-a-mut">
                  {snap.index + 1} / {snap.total}
                </span>
              </div>
            )}
            {sentence && (
              <p data-testid="speech-subtitle" className="min-w-0 text-balance font-display text-headline font-medium leading-snug text-a-ink sm:text-title2">
                {sentence.text}
              </p>
            )}
            {message && (
              <p className="text-caption text-a-wait">
                {message}
              </p>
            )}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {snap.state === "paused" ? (
                <button type="button" onClick={ra.resume} className={cn(TOGGLE, "border-a-acc bg-a-acc font-semibold text-a-bg")}>
                  ▶ {tc("briefing", "Weiter")}
                </button>
              ) : (
                <button type="button" disabled={snap.state !== "playing"} onClick={ra.pause} className={cn(TOGGLE, "border-a-line bg-a-p2 text-a-ink hover:bg-a-p3 disabled:opacity-50")}>
                  {snap.state === "loading" ? t("Lädt …") : `❚❚ ${t("Pause")}`}
                </button>
              )}
              {snap.state === "error" && (
                <button type="button" onClick={ra.start} className={cn(TOGGLE, "border-a-acc bg-a-acc font-semibold text-a-bg")}>
                  {tc("briefing", "Noch einmal")}
                </button>
              )}
              <button type="button" onClick={ra.stop} className={cn(TOGGLE, "border-a-line bg-a-p2 text-a-ink hover:bg-a-p3")}>
                ■ {t("Stopp")}
              </button>
              <span className="flex-1" />
              <div role="group" aria-label={t("Tempo")} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-line bg-a-p2 p-0.5">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={snap.speed === s}
                    onClick={() => ra.setSpeed(s)}
                    className={cn("h-full rounded-md px-2 font-mono text-caption tabular-nums transition-colors duration-150", snap.speed === s ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
                  >
                    {speedLabel(s)}
                  </button>
                ))}
              </div>
              <span className="hidden text-label text-a-mut sm:inline">{t("Esc beendet")}</span>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
