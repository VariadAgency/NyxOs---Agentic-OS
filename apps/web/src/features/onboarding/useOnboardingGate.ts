// When does the app show the onboarding instead of the normal frame? While `settings.onboardingDone === false`
// (first start), and on `/onboarding` (restarted from Settings → Info & Hilfe). Unknown info (offline, loading) never
// blocks the app.
import { useAppInfo } from "../../hooks/useAppInfo";

export const ONBOARDING_PATH = "/onboarding";

export type OnboardingMode = "first" | "again" | null;

export function onboardingMode(pathname: string, onboardingDone: boolean | undefined): OnboardingMode {
  if (onboardingDone === false) return "first";
  if (pathname === ONBOARDING_PATH) return "again";
  return null;
}

export function useOnboardingGate(pathname: string): OnboardingMode {
  const info = useAppInfo();
  return onboardingMode(pathname, info.data?.settings.onboardingDone);
}
