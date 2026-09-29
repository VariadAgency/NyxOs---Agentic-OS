// Onboarding: step logic (pure, tested in apps/web/test/onboarding-wizard.test.tsx) and the progress that survives a
// reload – choosing the language reloads the page, and the wizard must come back at the same place with the name kept.
import { ONBOARDING_STEPS, t, type OnboardingStep } from "@nyxos/shared";

export interface InterviewAnswers {
  who: string;
  work: string;
  style: string;
}

export interface WizardState {
  step: OnboardingStep;
  name: string;
  answers: InterviewAnswers;
  /** Steps the user skipped (shown as "übersprungen" in the progress bar). */
  skipped: OnboardingStep[];
}

export const EMPTY_ANSWERS: InterviewAnswers = { who: "", work: "", style: "" };
export const INITIAL_STATE: WizardState = { step: "welcome", name: "", answers: EMPTY_ANSWERS, skipped: [] };
export const NAME_MAX = 60;

export const STEP_LABEL: Record<OnboardingStep, string> = {
  welcome: t("Willkommen"),
  ai: t("KI verbinden"),
  interview: t("Kennenlernen"),
  setup: t("Einrichten"),
  done: t("Fertig"),
};

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

/** Every step can be skipped – except the name (the first step) and the last one. */
export function canSkip(step: OnboardingStep): boolean {
  return step !== "welcome" && step !== "done";
}

/** "Weiter" is only blocked on the first step without a name. */
export function canContinue(state: WizardState): boolean {
  if (state.step === "welcome") return state.name.trim().length > 0 && state.name.trim().length <= NAME_MAX;
  return state.step !== "done";
}

export function nextStep(step: OnboardingStep): OnboardingStep {
  return ONBOARDING_STEPS[Math.min(stepIndex(step) + 1, ONBOARDING_STEPS.length - 1)] as OnboardingStep;
}

export function prevStep(step: OnboardingStep): OnboardingStep {
  return ONBOARDING_STEPS[Math.max(stepIndex(step) - 1, 0)] as OnboardingStep;
}

/** Nyx help (side panel) is there from step 2 on. */
export function helpAvailable(step: OnboardingStep): boolean {
  return stepIndex(step) >= 1;
}

export type WizardAction =
  | { type: "name"; name: string }
  | { type: "answers"; answers: Partial<InterviewAnswers> }
  | { type: "next" }
  | { type: "back" }
  | { type: "skip" }
  | { type: "goto"; step: OnboardingStep };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "name":
      return { ...state, name: action.name.slice(0, NAME_MAX) };
    case "answers":
      return { ...state, answers: { ...state.answers, ...action.answers } };
    case "next":
      if (!canContinue(state)) return state;
      return { ...state, step: nextStep(state.step), skipped: state.skipped.filter((s) => s !== state.step) };
    case "skip":
      if (!canSkip(state.step)) return state;
      return { ...state, step: nextStep(state.step), skipped: state.skipped.includes(state.step) ? state.skipped : [...state.skipped, state.step] };
    case "back":
      return { ...state, step: prevStep(state.step) };
    case "goto":
      // Only backwards, or forwards past steps that are already behind us – never past the name.
      if (stepIndex(action.step) > stepIndex(state.step)) return state;
      return { ...state, step: action.step };
  }
}

const STORE_KEY = "nyxos.onboarding";

export function loadWizardState(): WizardState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return INITIAL_STATE;
    const v = JSON.parse(raw) as Partial<WizardState>;
    const step = ONBOARDING_STEPS.includes(v.step as OnboardingStep) ? (v.step as OnboardingStep) : "welcome";
    const name = typeof v.name === "string" ? v.name.slice(0, NAME_MAX) : "";
    const a = (v.answers ?? {}) as Partial<InterviewAnswers>;
    const answers = { who: typeof a.who === "string" ? a.who : "", work: typeof a.work === "string" ? a.work : "", style: typeof a.style === "string" ? a.style : "" };
    const skipped = Array.isArray(v.skipped) ? v.skipped.filter((s): s is OnboardingStep => ONBOARDING_STEPS.includes(s as OnboardingStep)) : [];
    // Never land behind the name step without a name.
    return { step: name.trim() ? step : "welcome", name, answers, skipped };
  } catch {
    return INITIAL_STATE;
  }
}

export function saveWizardState(state: WizardState): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // private mode: the wizard still works, it just starts over after a reload
  }
}

export function clearWizardState(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // nothing stored
  }
}
