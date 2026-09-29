// Prompt verbessern: Entwurf rein (tippen oder diktieren), Sonnet 5 · Reasoning hoch schreibt mit dem
// Stand der Session einen klaren Prompt. Ergänzen → neu verbessern, Rückfragen anhaken → neuer Prompt,
// Versionen vor/zurück. Abschicken läuft über den bestehenden Chat-Weg (SessionChat), Kopieren über die
// Zwischenablage. Von oben nach unten, alles scrollbar.
import { t, type ChatAvailability, type PromptAssistRequest, type PromptAssistResult } from "@nyxos/shared";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { MicButton } from "../voice/MicButton";
import { IconClose, IconSend } from "./icons";
import { collectAnswers, loadAssistState, type PromptAssistState, saveAssistState, usePromptAssist } from "./promptAssist";

interface PromptAssistPanelProps {
  sessionId: string;
  who: string;
  availability: ChatAvailability | undefined;
  /** Bestehender Weg an die Session (wie die Eingabezeile). Wirft mit einem Satz für dich, wenn es nicht klappt. */
  onSend: (text: string) => Promise<void>;
  sending: boolean;
  /** Text in die normale Eingabezeile übernehmen. */
  onUseInComposer: (text: string) => void;
  onClose: () => void;
  className?: string;
}

const UNDERSTANDING_LABEL: Record<PromptAssistResult["verstaendnis"], string> = {
  hoch: t("gut verstanden"),
  mittel: t("teils verstanden"),
  niedrig: t("kaum verstanden"),
};
const FIELD = "w-full resize-y rounded-md border border-a-line bg-a-bg px-2.5 py-2 text-callout leading-snug text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none disabled:opacity-60";
const BTN = "inline-flex h-(--a-ctl-h) items-center gap-1.5 rounded-md border px-2.5 text-caption font-medium transition disabled:pointer-events-none disabled:opacity-40";
const BTN_GHOST = cn(BTN, "border-a-line text-a-ink hover:border-a-line-strong hover:bg-a-p2");
const BTN_PRIMARY = cn(BTN, "border-transparent bg-a-primary font-semibold text-a-on-primary hover:brightness-110");

const isSubmit = (e: KeyboardEvent) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing;

export function PromptAssistPanel({ sessionId, who, availability, onSend, sending, onUseInComposer, onClose, className }: PromptAssistPanelProps) {
  const [state, setState] = useState<PromptAssistState>(() => loadAssistState(sessionId));
  const [zusatz, setZusatz] = useState("");
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const assist = usePromptAssist(sessionId);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => saveAssistState(sessionId, state), [sessionId, state]);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 2500);
    return () => clearTimeout(timer);
  }, [note]);

  const version = state.current >= 0 ? state.versions[state.current] : undefined;
  const thinking = assist.isPending;
  const canSend = availability?.canSend ?? false;

  const run = (modus: PromptAssistRequest["modus"], extra: { zusatz?: string; antworten?: PromptAssistState["antworten"] } = {}) => {
    const entwurf = state.entwurf.trim();
    if (!entwurf || thinking) return;
    setError(null);
    setConfirmBusy(false);
    const zusaetze = extra.zusatz ? [...state.zusaetze, extra.zusatz] : state.zusaetze;
    const antworten = extra.antworten ? [...state.antworten, ...extra.antworten] : state.antworten;
    assist.mutate(
      {
        entwurf,
        modus,
        ...(version ? { bisher: version.prompt } : {}),
        ...(zusaetze.length ? { zusaetze } : {}),
        ...(antworten.length ? { antworten } : {}),
      },
      {
        onSuccess: (result) => {
          setState((s) => {
            const versions = [...s.versions, result];
            return {
              ...s,
              zusaetze,
              antworten,
              versions,
              current: versions.length - 1,
            };
          });
          if (extra.zusatz) setZusatz("");
          setPicks({});
          setTexts({});
        },
        onError: (e) => setError(friendlyError(e, t("Sonnet konnte den Prompt gerade nicht verbessern."))),
      },
    );
  };

  const editPrompt = (prompt: string) =>
    setState((s) => {
      if (s.current < 0) return s;
      const versions = s.versions.map((v, i) => (i === s.current ? { ...v, prompt } : v));
      return { ...s, versions };
    });

  const reset = () => {
    setState({
      entwurf: "",
      zusaetze: [],
      antworten: [],
      versions: [],
      current: -1,
    });
    setZusatz("");
    setPicks({});
    setTexts({});
    setError(null);
    draftRef.current?.focus();
  };

  const copy = async () => {
    if (!version) return;
    try {
      await navigator.clipboard.writeText(version.prompt);
      setNote(t("Kopiert."));
    } catch {
      setError(t("Kopieren ging nicht – markier den Text und kopier ihn selbst."));
    }
  };

  const send = async () => {
    if (!version?.prompt.trim() || sending) return;
    if (availability?.busy && !confirmBusy) {
      setConfirmBusy(true);
      return;
    }
    setConfirmBusy(false);
    setError(null);
    try {
      await onSend(version.prompt.trim());
      setNote(availability?.busy ? t("Wartet, bis die Session frei ist.") : t("Abgeschickt."));
    } catch (e) {
      setError(friendlyError(e, t("Der Prompt ist nicht angekommen.")));
    }
  };

  const togglePick = (qid: string, option: string, multi: boolean) =>
    setPicks((p) => {
      const cur = p[qid] ?? [];
      const has = cur.includes(option);
      return {
        ...p,
        [qid]: multi ? (has ? cur.filter((o) => o !== option) : [...cur, option]) : has ? [] : [option],
      };
    });

  const answers = version ? collectAnswers(version.fragen, picks, texts) : [];

  return (
    <section aria-label={t("Prompt verbessern")} data-testid="prompt-assist" className={cn("cc-scroll flex min-h-0 flex-col gap-3 overflow-y-auto bg-a-p p-3", className)}>
      <header className="flex items-center gap-2">
        <h2 className="text-callout font-semibold text-a-ink">{t("Prompt verbessern")}</h2>
        <span className="rounded bg-a-p3 px-1.5 py-px text-label text-a-mut" title={t("Modell für diese Funktion – fest eingestellt")}>
          {t("Sonnet 5 · Reasoning hoch")}
        </span>
        <span className="flex-1" />
        {(state.entwurf || state.versions.length > 0) && (
          <button type="button" onClick={reset} disabled={thinking} className="rounded px-1.5 py-0.5 text-label text-a-mut hover:text-a-ink disabled:opacity-40">
            {t("Neu anfangen")}
          </button>
        )}
        <button type="button" onClick={onClose} aria-label={t("Prompt verbessern schließen")} className="grid h-6 w-6 place-items-center rounded text-a-mut hover:bg-a-p2 hover:text-a-ink">
          <IconClose size={13} />
        </button>
      </header>

      {/* 1 · Entwurf */}
      <div className="grid gap-1.5">
        <label htmlFor={`pa-draft-${sessionId}`} className="text-caption text-a-mut">
          {t("Dein Entwurf – schnell getippt oder diktiert reicht")}
        </label>
        <div className="flex items-start gap-1.5">
          <textarea
            id={`pa-draft-${sessionId}`}
            ref={draftRef}
            rows={4}
            value={state.entwurf}
            onChange={(e) => setState((s) => ({ ...s, entwurf: e.target.value }))}
            onKeyDown={(e) => {
              if (!isSubmit(e)) return;
              e.preventDefault();
              run("verbessern");
            }}
            placeholder={t("Was soll {who} als Nächstes tun?", { who })}
            className={cn(FIELD, "min-h-[88px]")}
          />
          <MicButton
            target="haiku"
            shortcutKey={null}
            className="shrink-0 [&>span:first-of-type]:hidden"
            onResult={(r) => {
              const spoken = r.text.trim();
              if (spoken)
                setState((s) => ({
                  ...s,
                  entwurf: s.entwurf.trim() ? `${s.entwurf.trimEnd()} ${spoken}` : spoken,
                }));
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => run("verbessern")} disabled={!state.entwurf.trim() || thinking} className={BTN_PRIMARY} title="⌘↵">
            {t("Verbessern")} <kbd className="font-mono text-label opacity-70">⌘↵</kbd>
          </button>
          <button type="button" onClick={() => run("fragen")} disabled={!state.entwurf.trim() || thinking} className={BTN_GHOST}>
            {t("Fragen stellen")}
          </button>
        </div>
      </div>

      {thinking && (
        <div role="status" className="flex items-center gap-2 rounded-md border border-a-acc/30 bg-a-acc/10 px-3 py-2 text-caption text-a-ink">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-a-acc border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
          {t("Sonnet denkt nach … das dauert meist 10–40 Sekunden.")}
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-a-bad/30 bg-a-bad/10 px-3 py-2 text-caption text-a-ink">
          {error}
        </p>
      )}

      {/* 2 · Ergebnis */}
      {version && (
        <div className="grid gap-2 border-t border-a-line pt-3">
          <div className="flex items-center gap-2">
            <label htmlFor={`pa-result-${sessionId}`} className="text-caption font-medium text-a-ink">
              {t("Verbesserter Prompt")}
            </label>
            <span className="text-label text-a-mut">{UNDERSTANDING_LABEL[version.verstaendnis]}</span>
            <span className="flex-1" />
            {state.versions.length > 1 && (
              <span className="flex items-center gap-1 text-label text-a-mut" aria-label={t("Versionen")}>
                <button
                  type="button"
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      current: Math.max(0, s.current - 1),
                    }))
                  }
                  disabled={state.current <= 0 || thinking}
                  aria-label={t("Vorige Version")}
                  className="rounded px-1.5 hover:bg-a-p2 hover:text-a-ink disabled:opacity-30"
                >
                  ‹
                </button>
                <span data-testid="prompt-assist-version">
                  {t("Version {n} von {total}", { n: state.current + 1, total: state.versions.length })}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      current: Math.min(s.versions.length - 1, s.current + 1),
                    }))
                  }
                  disabled={state.current >= state.versions.length - 1 || thinking}
                  aria-label={t("Nächste Version")}
                  className="rounded px-1.5 hover:bg-a-p2 hover:text-a-ink disabled:opacity-30"
                >
                  ›
                </button>
              </span>
            )}
          </div>
          <textarea id={`pa-result-${sessionId}`} rows={8} value={version.prompt} onChange={(e) => editPrompt(e.target.value)} className={cn(FIELD, "min-h-[140px] font-[inherit]")} />

          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => void send()} disabled={!canSend || sending || !version.prompt.trim()} className={BTN_PRIMARY} title={canSend ? undefined : (availability?.message ?? undefined)}>
              {sending ? t("Sende …") : t("Abschicken")} <IconSend size={13} />
            </button>
            <button type="button" onClick={() => void copy()} className={BTN_GHOST}>
              {t("Kopieren")}
            </button>
            <button type="button" onClick={() => onUseInComposer(version.prompt)} className={BTN_GHOST}>
              {t("In Eingabefeld übernehmen")}
            </button>
            {note && (
              <span role="status" className="text-caption text-a-ok">
                {note}
              </span>
            )}
          </div>
          {!canSend && availability?.message && <p className="text-caption text-a-mut">{availability.message} {t("Kopieren geht trotzdem.")}</p>}
          {confirmBusy && (
            <div role="alertdialog" aria-label={t("Session arbeitet gerade")} className="grid gap-2 rounded-md border border-a-wait/30 bg-a-wait/10 px-3 py-2 text-caption text-a-ink">
              <p>{t("{who} arbeitet gerade. Der Prompt kommt in die Warteschlange und geht raus, sobald die Session wartet.", { who })}</p>
              <div className="flex gap-1.5">
                <button type="button" onClick={() => void send()} className={BTN_PRIMARY}>
                  {t("Trotzdem abschicken")}
                </button>
                <button type="button" onClick={() => setConfirmBusy(false)} className={BTN_GHOST}>
                  {t("Abbrechen")}
                </button>
              </div>
            </div>
          )}

          {version.aenderungen.length > 0 && (
            <div className="grid gap-1">
              <h3 className="text-caption font-medium text-a-ink">{t("Was ich verbessert habe")}</h3>
              <ul className="grid gap-0.5 text-caption text-a-mut">
                {version.aenderungen.map((a, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span aria-hidden="true" className="text-a-ok">
                      ✓
                    </span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 3 · Rückfragen */}
          {version.fragen.length > 0 && (
            <div className="grid gap-2" data-testid="prompt-assist-questions">
              <h3 className="text-caption font-medium text-a-ink">{t("Rückfragen – anhaken oder kurz schreiben")}</h3>
              {version.fragen.map((q) => (
                <fieldset key={q.id} className="grid gap-1.5 rounded-md border border-a-line bg-a-p2 p-2.5">
                  <legend className="px-1 text-caption text-a-ink">{q.frage}</legend>
                  {q.optionen.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {q.optionen.map((o) => {
                        const on = (picks[q.id] ?? []).includes(o);
                        return (
                          <button
                            key={o}
                            type="button"
                            role={q.mehrfach ? "checkbox" : "radio"}
                            aria-checked={on}
                            onClick={() => togglePick(q.id, o, q.mehrfach)}
                            className={cn(
                              "rounded-md border px-2 py-1 text-left text-caption transition",
                              on ? "border-a-acc bg-a-acc/15 text-a-ink" : "border-a-line text-a-mut hover:border-a-line-strong hover:text-a-ink",
                            )}
                          >
                            <span aria-hidden="true" className="mr-1">
                              {on ? "☑" : "☐"}
                            </span>
                            {o}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <input
                    type="text"
                    value={texts[q.id] ?? ""}
                    onChange={(e) => setTexts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    aria-label={t("Eigene Antwort: {question}", { question: q.frage })}
                    placeholder={q.optionen.length ? t("Oder eigene Antwort / Korrektur …") : t("Deine Antwort …")}
                    className="h-(--a-ctl-h) rounded-md border border-a-line bg-a-bg px-2 text-caption text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none"
                  />
                </fieldset>
              ))}
              <div>
                <button type="button" onClick={() => run("verbessern", { antworten: answers })} disabled={answers.length === 0 || thinking} className={BTN_PRIMARY}>
                  {t("Antworten übernehmen")}
                </button>
              </div>
            </div>
          )}

          {/* 4 · Ergänzung */}
          <div className="grid gap-1.5 border-t border-a-line pt-3">
            <label htmlFor={`pa-extra-${sessionId}`} className="text-caption text-a-mut">
              {t("Ergänzung oder Korrektur")}
            </label>
            <textarea
              id={`pa-extra-${sessionId}`}
              rows={2}
              value={zusatz}
              onChange={(e) => setZusatz(e.target.value)}
              onKeyDown={(e) => {
                if (!isSubmit(e) || !zusatz.trim()) return;
                e.preventDefault();
                run("verbessern", { zusatz: zusatz.trim() });
              }}
              placeholder={t("z. B. „Nicht deployen“ oder „Du hast X falsch verstanden …“")}
              className={FIELD}
            />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => run("verbessern", { zusatz: zusatz.trim() })} disabled={!zusatz.trim() || thinking} className={BTN_GHOST}>
                {t("Neu verbessern")}
              </button>
              <button type="button" onClick={() => run("fragen", zusatz.trim() ? { zusatz: zusatz.trim() } : {})} disabled={thinking} className={BTN_GHOST}>
                {t("Fragen stellen")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
