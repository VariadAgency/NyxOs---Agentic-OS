// Knopf an jeder Nachricht, damit Nyx sie noch einmal vorliest. Liest den ganzen Text einer
// Nyx-Antwort mit Stimme und Tempo aus den Nyx-Einstellungen (der Sprecher liest sie selbst). Es spricht immer nur
// eine Nachricht: ein neuer Klick irgendwo beendet die vorige; ein zweiter Klick auf denselben Knopf stoppt.
import { t } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { reportNyxLevel } from "../../features/nyx/voice/levelBus";
import { createSpeaker, type Speaker } from "../../features/nyx/voice/speaker";
import { cn } from "../../lib/cn";

let active: { speaker: Speaker; stop: () => void } | null = null;

/**
 * EINE Stimme für alle „Vorlesen“-Knöpfe (Nachrichten UND Nyx' Einschätzung an Entscheidungen). Beendet,
 * was gerade vorgelesen wird, und meldet `speaker` als neuen Sprecher an. Rückgabe: abmelden (nach `end()`).
 */
export function claimReadAloud(speaker: Speaker): () => void {
  if (active && active.speaker !== speaker) active.stop();
  active = { speaker, stop: () => speaker.cancel() };
  return () => {
    if (active?.speaker === speaker) active = null;
  };
}

/** Markdown → gesprochener Text (Überschriften, Listen, Hervorhebung, Links, Code-Zeichen, Trennlinien weg). */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+(.+?)[.:!?]?\s*$/gm, "$1.")
    .replace(/^\s{0,3}(>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\n{2,}/g, ".\n")
    .replace(/\.\s*\./g, ".")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function ReadAloudMessageButton({ text, className }: { text: string; className?: string }) {
  const [speaking, setSpeaking] = useState(false);
  const mine = useRef<Speaker | null>(null);

  useEffect(
    () => () => {
      if (active && active.speaker === mine.current) active.stop();
    },
    [],
  );

  const start = () => {
    const sp = createSpeaker();
    const release = claimReadAloud(sp);
    mine.current = sp;
    const unreport = reportNyxLevel(() => sp.level());
    setSpeaking(true);
    sp.push(speakableText(text));
    void sp.end().finally(() => {
      unreport();
      release();
      if (mine.current === sp) setSpeaking(false);
    });
  };

  return (
    <button
      type="button"
      onClick={() => (speaking ? mine.current?.cancel() : start())}
      aria-pressed={speaking}
      aria-label={speaking ? t("Vorlesen stoppen") : t("Diese Antwort vorlesen")}
      title={speaking ? t("Vorlesen stoppen") : t("Diese Antwort noch einmal vorlesen")}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-label transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-a-acc",
        speaking ? "border-a-acc bg-a-acc/15 text-a-acc" : "border-a-line text-a-mut hover:text-a-ink",
        className,
      )}
    >
      <span aria-hidden="true">{speaking ? "■" : "🔊"}</span>
      {speaking ? t("Stopp") : t("Vorlesen")}
    </button>
  );
}
