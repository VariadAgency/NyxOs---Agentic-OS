// „Nyx fragen“ während der Einrichtung: Seitenfeld rechts. Mit verbundener KI ein kleiner Chat über denselben Weg wie das
// Nyx-Zentrum (`useHaikuChat`, Wegwerf-Faden); vorher kurze Antworten auf die häufigsten Fragen.
import { t, tc, type HaikuContext } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { NyxAura } from "../../components/brand/NyxAura";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { Markdown } from "../../lib/markdown";
import { pendingText, useHaikuChat } from "../haiku/useHaikuChat";
import { useOnboardingAi } from "./onboardingApi";

const CONTEXT: HaikuContext = { path: "/onboarding", tab: "onboarding", filters: {}, openSessionId: null, openEntryId: null, title: t("Einrichtung von NyxOS") };

export const HELP_FAQ: { q: string; a: string }[] = [
  { q: t("Was ist NyxOS?"), a: t("Eine Kommandozentrale für deine KI-Sessions: Du siehst alle Claude-Code- und Codex-Sessions, Aufgaben, Git und Kosten an einem Ort. Nyx ist die Assistentin, die mitdenkt.") },
  { q: t("Brauche ich ein Claude-Abo?"), a: t("Nein. Mit Abo ist es am einfachsten. Ohne geht es mit einem API-Schlüssel (du zahlst je Nutzung) oder einem lokalen Modell (kostenlos, aber schwächer).") },
  { q: t("Was ist ein Terminal?"), a: t("Ein Fenster, in dem man Befehle eintippt. Am Mac: Programm „Terminal“ (mit ⌘ Leertaste suchen). Unter Linux meist mit Strg+Alt+T. Befehl einfügen, Enter drücken – fertig.") },
  { q: t("Was sind Projekt-Ordner?"), a: t("Die Ordner, in denen deine Code-Projekte liegen, z. B. ~/code. NyxOS zeigt Sessions, Git und Dateien aus diesen Ordnern. Wählst du keinen, zeigt NyxOS einfach alle Sessions.") },
  { q: t("Sind meine Schlüssel sicher?"), a: t("Ja. Schlüssel werden verschlüsselt auf deinem Rechner gespeichert und nie wieder angezeigt. NyxOS läuft nur bei dir, nichts geht an fremde Server außer an den KI-Anbieter, den du wählst.") },
  { q: t("Kann ich Schritte überspringen?"), a: t("Ja, alles außer deinem Namen. Du findest jeden Schritt später in den Einstellungen – und kannst die Einrichtung dort auch neu starten.") },
];

function Faq() {
  return (
    <div className="grid gap-2">
      <p className="text-callout text-a-mut">{t("Sobald eine KI verbunden ist, kannst du Nyx hier alles fragen. Bis dahin die häufigsten Fragen:")}</p>
      {HELP_FAQ.map((f) => (
        <details key={f.q} className="group rounded-lg border border-a-line bg-a-p2 px-3 py-2">
          <summary className="cursor-pointer list-none text-callout font-medium text-a-ink marker:hidden">
            <span aria-hidden className="mr-1.5 inline-block text-a-mut transition-transform group-open:rotate-90">
              ›
            </span>
            {f.q}
          </summary>
          <p className="mt-1.5 text-callout text-a-mut">{f.a}</p>
        </details>
      ))}
    </div>
  );
}

function Chat() {
  const chat = useHaikuChat();
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const { setTemporaryNext } = chat;
  // Fragen aus der Einrichtung landen in einem Wegwerf-Faden (verschwindet nach ein paar Stunden von selbst).
  useEffect(() => setTemporaryNext(true), [setTemporaryNext]);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [chat.entries]);
  const send = () => {
    const v = text.trim();
    if (!v || chat.busy) return;
    void chat.send(v, CONTEXT);
    setText("");
  };
  return (
    <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3">
      <div className="cc-scroll grid content-start gap-2.5 overflow-y-auto pr-1">
        {chat.entries.length === 0 && <p className="text-callout text-a-mut">{t("Frag Nyx, was du wissen willst – zum Beispiel „Was ist ein API-Schlüssel?“")}</p>}
        {chat.entries.map((e) =>
          e.role === "user" ? (
            <div key={e.key} className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-a-p3 px-3 py-2 text-callout text-a-ink">
              {e.text}
            </div>
          ) : (
            <div key={e.key} className="w-fit max-w-full rounded-2xl rounded-tl-md border border-a-line bg-a-p2 px-3 py-2 text-callout text-a-ink">
              {e.error ? <span className="text-a-bad">{e.error.message}</span> : e.text ? <Markdown text={e.text} sources={e.sources} /> : <span className="text-a-mut">{(e.pending && pendingText(e.pending)) ?? t("denkt nach …")}</span>}
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          rows={2}
          value={text}
          maxLength={4000}
          aria-label={t("Frage an Nyx")}
          placeholder={t("Deine Frage …")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className="min-w-0 flex-1 resize-none rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none"
        />
        <Button variant="primary" type="submit" disabled={chat.busy || !text.trim()}>
          {tc("onboarding", "Fragen")}
        </Button>
      </form>
    </div>
  );
}

export function NyxHelpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ai = useOnboardingAi(false);
  // Einmal geöffnet, bleibt das Gespräch eingehängt (nur versteckt) – Schließen verliert nichts.
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <aside
      aria-label={t("Nyx fragen")}
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "fixed inset-y-0 right-0 z-50 grid w-[400px] max-w-full grid-rows-[auto_minmax(0,1fr)] gap-3 border-l border-a-line bg-a-p p-4 shadow-pop transition-transform duration-200 ease-apple",
        open ? "translate-x-0" : "translate-x-full",
      )}
    >
      <div className="flex items-center gap-2.5">
        <NyxAura size={24} state="idle" />
        <h2 className="text-headline font-semibold text-a-ink">{t("Nyx fragen")}</h2>
        <Button variant="ghost" className="ml-auto" onClick={onClose} aria-label={t("Schließen")}>
          ✕
        </Button>
      </div>
      {seen && (ai.data?.ready ? <Chat /> : <div className="cc-scroll min-h-0 overflow-y-auto"><Faq /></div>)}
    </aside>
  );
}
