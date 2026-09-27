// Schritt 3: Kennenlernen. Nyx stellt drei Fragen (wer bist du, woran arbeitest du, wie soll Nyx sein) – mit KI als kleines
// Gespräch (tippen oder diktieren), ohne KI als einfaches Formular. Daraus entsteht ein Vorschlag fürs Nyx-Profil
// (`/api/onboarding/interview`), den der Nutzer prüft und ändert, bevor er gespeichert wird (`PUT /api/nyx/profile`).
import { BUILTIN_NYX_PRESETS, getLang, NYX_FIELD_MAX, NYX_SLIDER_KEYS, t, tc, type NyxProfile, type NyxUserProfile, type OnboardingInterviewResult } from "@nyxos/shared";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NyxAura } from "../../components/brand/NyxAura";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { FIELD, LABEL } from "../settings/fieldStyles";
import { MicButton } from "../voice/MicButton";
import { runInterview, saveProfile, useOnboardingAi } from "./onboardingApi";
import { Block, ErrorLine, Segmented, StatusPill, StepHeader } from "./ui";
import type { InterviewAnswers } from "./wizardState";

type Key = keyof InterviewAnswers;

export const INTERVIEW_QUESTIONS: { key: Key; question: string; placeholder: string }[] = [
  { key: "who", question: t("Erzähl mir kurz von dir: Wer bist du, und wie viel Erfahrung hast du mit KI-Werkzeugen?"), placeholder: t("z. B. Ich bin Designerin und nutze Claude seit ein paar Wochen.") },
  { key: "work", question: t("Woran arbeitest du gerade? Welche Projekte sind dir wichtig?"), placeholder: t("z. B. Eine Web-App für Rezepte und meine Portfolio-Seite.") },
  { key: "style", question: t("Und wie soll ich mit dir umgehen? Kurz oder ausführlich, locker oder sachlich, technisch oder ganz einfach erklärt?"), placeholder: t("z. B. Kurz, locker und bitte ohne Fachbegriffe.") },
];

/** How many questions are answered in order (the chat asks the next one). */
export function answeredCount(a: InterviewAnswers): number {
  let n = 0;
  for (const q of INTERVIEW_QUESTIONS) {
    if (!a[q.key].trim()) break;
    n++;
  }
  return n;
}

function NyxBubble({ children, thinking = false }: { children: ReactNode; thinking?: boolean }) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2.5 motion-safe:animate-[cc-tab-fade_200ms_ease-out]">
      <NyxAura size={28} state={thinking ? "thinking" : "idle"} />
      <div className="w-fit max-w-prose rounded-2xl rounded-tl-md border border-a-line bg-a-p2 px-3.5 py-2.5 text-headline text-a-ink">{children}</div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return <div className="ml-auto w-fit max-w-prose whitespace-pre-wrap rounded-2xl rounded-tr-md bg-a-p3 px-3.5 py-2.5 text-headline text-a-ink">{text}</div>;
}

function AnswerInput({ placeholder, onSend, disabled }: { placeholder: string; onSend: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), [placeholder]);
  const send = () => {
    const v = text.trim();
    if (!v) return;
    onSend(v);
    setText("");
  };
  return (
    <div className="flex items-end gap-2 rounded-xl border border-a-line bg-a-p p-2 focus-within:border-a-acc">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        maxLength={2000}
        disabled={disabled}
        aria-label={t("Deine Antwort")}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        className="min-h-12 min-w-0 flex-1 resize-y bg-transparent px-1.5 py-1 text-headline text-a-ink placeholder:text-a-mut focus:outline-none"
      />
      <MicButton compact target="haiku" shortcutKey={null} onResult={(r) => setText((prev) => (prev.trim() ? `${prev.trim()} ${r.text}` : r.text))} />
      <Button variant="primary" onClick={send} disabled={disabled || !text.trim()}>
        {t("Senden")}
      </Button>
    </div>
  );
}

function ChatInterview({ name, answers, onAnswer, onComplete, busy }: { name: string; answers: InterviewAnswers; onAnswer: (key: Key, text: string) => void; onComplete: (a: InterviewAnswers) => void; busy: boolean }) {
  const n = answeredCount(answers);
  const current = INTERVIEW_QUESTIONS[n];
  return (
    <div className="grid gap-3" aria-live="polite">
      <NyxBubble>{t("Hallo {name}! Ich bin Nyx. Drei kurze Fragen, dann kenne ich dich ein bisschen.", { name })}</NyxBubble>
      {INTERVIEW_QUESTIONS.slice(0, n).map((q) => (
        <div key={q.key} className="grid gap-3">
          <NyxBubble>{q.question}</NyxBubble>
          <UserBubble text={answers[q.key]} />
        </div>
      ))}
      {current ? (
        <>
          <NyxBubble>{current.question}</NyxBubble>
          <AnswerInput
            placeholder={current.placeholder}
            onSend={(text) => {
              onAnswer(current.key, text);
              if (n === INTERVIEW_QUESTIONS.length - 1) onComplete({ ...answers, [current.key]: text });
            }}
          />
        </>
      ) : (
        busy && <NyxBubble thinking>{t("Danke! Ich fasse kurz zusammen, was ich verstanden habe …")}</NyxBubble>
      )}
    </div>
  );
}

function FormInterview({ answers, onAnswer, onSubmit, busy }: { answers: InterviewAnswers; onAnswer: (key: Key, text: string) => void; onSubmit: () => void; busy: boolean }) {
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {INTERVIEW_QUESTIONS.map((q) => (
        <label key={q.key} className="grid gap-1.5">
          <span className="text-headline text-a-ink">{q.question}</span>
          <textarea rows={3} maxLength={2000} value={answers[q.key]} placeholder={q.placeholder} onChange={(e) => onAnswer(q.key, e.target.value)} className={cn(FIELD, "resize-y text-headline")} />
        </label>
      ))}
      <Button variant="primary" type="submit" className="w-fit" disabled={busy || answeredCount(answers) === 0}>
        {busy ? t("Werte aus …") : t("Übersicht zeigen")}
      </Button>
    </form>
  );
}

const USER_FIELDS: { key: Exclude<keyof NyxUserProfile, "name" | "notes">; label: string }[] = [
  { key: "role", label: t("Über dich") },
  { key: "projects", label: t("Woran du arbeitest") },
  { key: "workStyle", label: t("Wie Nyx mit dir arbeiten soll") },
  { key: "likes", label: t("Was du in Antworten magst") },
  { key: "noGos", label: t("Was Nyx lassen soll") },
];

function Review({ result, onSaved, onRedo }: { result: OnboardingInterviewResult; onSaved: () => void; onRedo: () => void }) {
  const [draft, setDraft] = useState<NyxProfile>(result.profile);
  const save = useMutation({ mutationFn: saveProfile, onSuccess: onSaved });
  const setUser = (key: keyof NyxUserProfile, value: string) => setDraft((d) => ({ ...d, user: { ...d.user, [key]: value } }));
  const activePreset = BUILTIN_NYX_PRESETS.find((p) => NYX_SLIDER_KEYS.every((k) => p.sliders[k] === draft.sliders[k]))?.id ?? "understood";
  return (
    <div className="grid gap-4">
      <Block title={t("Das habe ich verstanden")} status={result.source === "nyx" ? <StatusPill tone="ok">{t("von Nyx")}</StatusPill> : <StatusPill tone="mut">{t("ohne KI zugeordnet")}</StatusPill>}>
        <ul className="grid list-disc gap-1 pl-5 text-callout text-a-ink marker:text-a-mut">
          {result.understood.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-caption text-a-mut">{t("Prüf es kurz und ändere, was nicht stimmt. Gespeichert wird erst mit „Speichern“.")}</p>
      </Block>
      <Block title={t("Dein Profil für Nyx")}>
        <div className="grid gap-3">
          {USER_FIELDS.map((f) => (
            <label key={f.key} className="grid gap-1">
              <span className={LABEL}>{f.label}</span>
              <textarea rows={2} maxLength={NYX_FIELD_MAX} value={draft.user[f.key]} onChange={(e) => setUser(f.key, e.target.value)} className={cn(FIELD, "resize-y")} />
            </label>
          ))}
          {/* du/Sie only exists in German – an English interface doesn't ask. */}
          {getLang() === "de" && (
            <div className="grid gap-1.5">
              <span className={LABEL}>{t("Anrede")}</span>
              <Segmented
                value={draft.personality.address}
                options={[
                  { value: "du", label: tc("onboarding", "Du") },
                  { value: "Sie", label: tc("onboarding", "Sie") },
                ]}
                onChange={(v) => setDraft((d) => ({ ...d, personality: { ...d.personality, address: v } }))}
                label={t("Anrede")}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <span className={LABEL}>{t("Antwort-Stil")}</span>
            <div className="flex flex-wrap gap-1.5">
              <StyleChip active={activePreset === "understood"} onClick={() => setDraft((d) => ({ ...d, sliders: result.profile.sliders, activePreset: result.profile.activePreset }))} title={t("So wie verstanden")}>
                {t("Wie verstanden")}
              </StyleChip>
              {BUILTIN_NYX_PRESETS.map((p) => (
                <StyleChip key={p.id} active={activePreset === p.id} onClick={() => setDraft((d) => ({ ...d, sliders: p.sliders, activePreset: p.id }))} title={t(p.description)}>
                  {t(p.label)}
                </StyleChip>
              ))}
            </div>
            <p className="text-caption text-a-mut">{t("Feiner einstellen kannst du das später unter Einstellungen → Nyx.")}</p>
          </div>
        </div>
      </Block>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => save.mutate(draft)} disabled={save.isPending}>
          {save.isPending ? t("Speichere …") : t("Speichern & weiter")}
        </Button>
        <Button variant="ghost" onClick={onRedo} disabled={save.isPending}>
          {t("Antworten ändern")}
        </Button>
      </div>
      <ErrorLine text={save.error ? friendlyError(save.error) : null} />
    </div>
  );
}

function StyleChip({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn("rounded-full border px-3 py-1 text-callout transition-colors duration-150", active ? "border-a-acc/60 bg-a-acc/12 text-a-ink" : "border-a-line bg-a-p2 text-a-mut hover:text-a-ink")}
    >
      {children}
    </button>
  );
}

export function StepInterview({ name, answers, onAnswer, onDone }: { name: string; answers: InterviewAnswers; onAnswer: (key: Key, text: string) => void; onDone: () => void }) {
  const ai = useOnboardingAi(false);
  const ready = ai.data?.ready === true;
  // Schon alle Antworten da (zurückgekommen)? Dann gleich das Formular zum Prüfen statt eines leeren Gesprächs.
  const [mode, setMode] = useState<"chat" | "form" | null>(() => (answeredCount(answers) === INTERVIEW_QUESTIONS.length ? "form" : null));
  const effective = mode ?? (ai.isLoading ? null : ready ? "chat" : "form");
  const interview = useMutation({ mutationFn: runInterview });
  const evaluate = (a: InterviewAnswers) => interview.mutate({ name, ...a });

  return (
    <div className="grid gap-5">
      <StepHeader title={t("Kennenlernen")} lead={ready ? t("Nyx stellt dir drei kurze Fragen. Antworte, wie du magst – tippen oder diktieren.") : t("Drei kurze Fragen, damit Nyx weiß, wie sie dir am besten hilft.")} />
      {interview.data ? (
        <Review key={JSON.stringify(interview.data.profile)} result={interview.data} onSaved={onDone} onRedo={() => {
          interview.reset();
          setMode("form");
        }} />
      ) : (
        <>
          {effective === "chat" && <ChatInterview name={name} answers={answers} onAnswer={onAnswer} onComplete={evaluate} busy={interview.isPending} />}
          {effective === "form" && <FormInterview answers={answers} onAnswer={onAnswer} onSubmit={() => evaluate(answers)} busy={interview.isPending} />}
          {effective === "chat" && (
            <button type="button" className="w-fit text-caption text-a-mut underline hover:text-a-ink" onClick={() => setMode("form")}>
              {t("Lieber als Formular ausfüllen")}
            </button>
          )}
          <ErrorLine text={interview.error ? friendlyError(interview.error) : null} />
          {interview.isError && (
            <Button className="w-fit" onClick={() => evaluate(answers)}>
              {t("Erneut versuchen")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
