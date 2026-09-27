// Onboarding: Vollbild-Assistent beim ersten Start (solange `settings.onboardingDone === false`) und später über
// Einstellungen → Info & Hilfe → „Onboarding erneut starten“ (Route `/onboarding`). Fortschritt oben, Zurück/Weiter unten,
// jeder Schritt außer dem Namen überspringbar, „Nyx fragen“ ab Schritt 2.
import { ONBOARDING_STEPS, getLang, t, type AppInfo } from "@nyxos/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { NyxAura } from "../../components/brand/NyxAura";
import { Button } from "../../components/ui/button";
import { APP_INFO_KEY, saveAppSettings, useAppInfo, useUserName } from "../../hooks/useAppInfo";
import { cn } from "../../lib/cn";
import { NyxHelpPanel } from "./NyxHelpPanel";
import { finishOnboarding } from "./onboardingApi";
import { StepAi } from "./StepAi";
import { StepDone } from "./StepDone";
import { StepInterview } from "./StepInterview";
import { StepSetup } from "./StepSetup";
import { StepWelcome } from "./StepWelcome";
import { canContinue, canSkip, clearWizardState, helpAvailable, loadWizardState, saveWizardState, STEP_LABEL, stepIndex, wizardReducer, type WizardState } from "./wizardState";

/** Where the user lands after the onboarding (the overview greets by name). */
export const ONBOARDING_LANDING = "/overview";

function Progress({ state, onGoto }: { state: WizardState; onGoto: (i: number) => void }) {
  const current = stepIndex(state.step);
  return (
    <ol aria-label={t("Fortschritt")} className="grid grid-cols-5 gap-1.5">
      {ONBOARDING_STEPS.map((step, i) => {
        const done = i < current;
        const skipped = state.skipped.includes(step);
        return (
          <li key={step} className="min-w-0">
            <button
              type="button"
              onClick={() => onGoto(i)}
              disabled={i >= current}
              aria-current={i === current ? "step" : undefined}
              className="grid w-full gap-1.5 text-left disabled:cursor-default"
            >
              <span
                aria-hidden
                className={cn(
                  "h-1 rounded-full transition-colors duration-300",
                  i === current ? "bg-a-acc" : done ? (skipped ? "bg-a-dim" : "bg-a-ok") : "bg-a-p3",
                )}
              />
              <span className={cn("truncate text-label max-sm:hidden", i === current ? "font-medium text-a-ink" : "text-a-mut")}>
                {STEP_LABEL[step]}
                {skipped && done ? ` · ${t("übersprungen")}` : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function OnboardingWizard({ again = false }: { again?: boolean }) {
  const [state, dispatch] = useReducer(wizardReducer, undefined, loadWizardState);
  const [helpOpen, setHelpOpen] = useState(false);
  const [interviewSaved, setInterviewSaved] = useState(false);
  const knownName = useUserName();
  const scrollRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Beim erneuten Start den bekannten Namen vorschlagen.
  useEffect(() => {
    if (!state.name && knownName) dispatch({ type: "name", name: knownName });
  }, [knownName, state.name]);
  useEffect(() => saveWizardState(state), [state]);
  // The language shown in the wizard (browser language or the user's pick) also applies to texts the server
  // writes (status lines, briefing) — store it right away, not only when the onboarding finishes.
  const serverLang = useAppInfo().data?.settings.lang;
  useEffect(() => {
    if (serverLang && serverLang !== getLang()) void saveAppSettings({ lang: getLang() }).then(() => qc.invalidateQueries());
  }, [serverLang, qc]);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [state.step]);

  const finish = useMutation({
    mutationFn: (briefing: boolean) => finishOnboarding({ userName: state.name.trim(), lang: getLang(), briefing }),
    onSuccess: (res) => {
      qc.setQueryData<AppInfo>(APP_INFO_KEY, (old) => (old ? { ...old, settings: { ...old.settings, userName: res.userName, onboardingDone: true, lang: getLang() } } : old));
      void qc.invalidateQueries({ queryKey: APP_INFO_KEY });
      void qc.invalidateQueries({ queryKey: ["nyx", "profile"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
      clearWizardState();
      navigate(ONBOARDING_LANDING, { replace: true });
    },
  });

  const step = state.step;
  const showNext = step !== "done" && (step !== "interview" || interviewSaved);

  return (
    <div data-testid="onboarding" className="fixed inset-0 z-40 flex flex-col bg-a-bg text-a-ink">
      <header className="border-b border-a-line bg-a-bg px-4 py-3 md:px-6">
        <div className="mx-auto grid max-w-2xl gap-3">
          <div className="flex items-center gap-2.5">
            <NyxAura size={20} state="idle" />
            <span className="font-display text-headline font-semibold tracking-tight">NyxOS</span>
            <span className="text-caption text-a-mut">
              {t("Schritt {n} von {total}", { n: stepIndex(step) + 1, total: ONBOARDING_STEPS.length })}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {helpAvailable(step) && (
                <Button onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen}>
                  <NyxAura size={14} state="idle" />
                  {t("Nyx fragen")}
                </Button>
              )}
              {again && (
                <Button variant="ghost" onClick={() => navigate("/einstellungen/info")}>
                  {t("Abbrechen")}
                </Button>
              )}
            </div>
          </div>
          <Progress state={state} onGoto={(i) => dispatch({ type: "goto", step: ONBOARDING_STEPS[i] ?? "welcome" })} />
        </div>
      </header>

      <main ref={scrollRef} className="cc-scroll min-h-0 flex-1 overflow-y-auto">
        <div key={step} className="mx-auto max-w-2xl px-4 py-8 motion-safe:animate-[cc-tab-fade_200ms_ease-out] md:py-12">
          {step === "welcome" && <StepWelcome name={state.name} onName={(name) => dispatch({ type: "name", name })} onSubmit={() => dispatch({ type: "next" })} beforeReload={() => saveWizardState(state)} />}
          {step === "ai" && <StepAi />}
          {step === "interview" && (
            <StepInterview
              name={state.name.trim()}
              answers={state.answers}
              onAnswer={(key, text) => dispatch({ type: "answers", answers: { [key]: text } })}
              onDone={() => {
                setInterviewSaved(true);
                dispatch({ type: "next" });
              }}
            />
          )}
          {step === "setup" && <StepSetup />}
          {step === "done" && <StepDone name={state.name.trim()} skipped={state.skipped} busy={finish.isPending} error={finish.error} onFinish={(b) => finish.mutate(b)} />}
        </div>
      </main>

      <footer className="border-t border-a-line bg-a-bg px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          {stepIndex(step) > 0 && (
            <Button variant="ghost" onClick={() => dispatch({ type: "back" })}>
              {t("Zurück")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {canSkip(step) && (
              <Button variant="ghost" onClick={() => dispatch({ type: "skip" })}>
                {t("Überspringen")}
              </Button>
            )}
            {showNext && (
              <Button variant="primary" onClick={() => dispatch({ type: "next" })} disabled={!canContinue(state)}>
                {t("Weiter")}
              </Button>
            )}
          </div>
        </div>
      </footer>

      <NyxHelpPanel open={helpOpen && helpAvailable(step)} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
