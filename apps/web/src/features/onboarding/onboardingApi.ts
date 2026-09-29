// Onboarding: server calls. Own endpoints (`/api/onboarding/*`, contract in packages/shared/src/onboarding.ts) plus the
// existing ones it reuses: access keys (`/api/access`), Nyx profile, app settings, `/api/setup`.
import type {
  SetupApply,
  SetupBrowseResult,
  SetupState,
  AccessCheck,
  AccessId,
  AccessStatus,
  NyxProfile,
  NyxProfileResponse,
  OnboardingAiState,
  OnboardingFinish,
  OnboardingFinishResult,
  OnboardingInterview,
  OnboardingInterviewResult,
  OnboardingUseProvider,
  OnboardingUseProviderResult,
} from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../terminal/authClient";

export class OnboardingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function send<T>(method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<T> {
  const res =
    method === "GET" ? await fetch(url, { credentials: "same-origin" }) : await authFetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!res.ok) {
    const text = data && typeof data.error === "string" ? data.error : res.status === 404 ? t("Dieser Teil ist auf dem Server noch nicht da – bitte NyxOS aktualisieren.") : t("Das hat nicht geklappt – bitte noch einmal versuchen.");
    throw new OnboardingApiError(text, res.status);
  }
  return data as T;
}

// ─── KI-Zugang ───

export const AI_STATE_KEY = ["onboarding", "ai"] as const;

/** Polls while the step is open – the user may run `claude` in a terminal meanwhile. */
export function useOnboardingAi(poll = true) {
  return useQuery({ queryKey: AI_STATE_KEY, queryFn: () => send<OnboardingAiState>("GET", "/api/onboarding/ai"), refetchInterval: poll ? 5_000 : false, retry: false });
}

export function useSaveAccessKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, value }: { id: AccessId; value: string }) => {
      await send<AccessStatus>("PUT", `/api/access/${id}`, { value });
      const { check } = await send<{ check: AccessCheck; status: AccessStatus }>("POST", `/api/access/${id}/check`);
      return check;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: AI_STATE_KEY });
      void qc.invalidateQueries({ queryKey: ["access"] });
      void qc.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useUseProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OnboardingUseProvider) => send<OnboardingUseProviderResult>("POST", "/api/onboarding/ai/use", input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: AI_STATE_KEY });
      void qc.invalidateQueries({ queryKey: ["models"] });
      void qc.invalidateQueries({ queryKey: ["haiku", "status"] });
    },
  });
}

/** Real test run ("Wer bist du?") – proves the Claude login. Costs a tiny run, so only on click. */
export function useSelftest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => send<{ ok: boolean; reason: string | null; text: string | null }>("POST", "/api/haiku/selftest"),
    onSettled: () => void qc.invalidateQueries({ queryKey: AI_STATE_KEY }),
  });
}

// ─── Interview + Profil ───

export const runInterview = (answers: OnboardingInterview) => send<OnboardingInterviewResult>("POST", "/api/onboarding/interview", answers);
export const saveProfile = (profile: NyxProfile) => send<NyxProfileResponse>("PUT", "/api/nyx/profile", profile);

// ─── Fertig ───

export const finishOnboarding = (input: OnboardingFinish) => send<OnboardingFinishResult>("POST", "/api/onboarding/finish", input);

// ─── Einrichtung (`/api/setup`, Vertrag: packages/shared/src/setup.ts) ───

export type { ProjectRootInfo, SetupApply, SetupBrowseResult, SetupState } from "@nyxos/shared";

export const SETUP_KEY = ["setup"] as const;
/** While the background service connects (or macOS still asks for a folder permission): ask again this often. */
export const SETUP_POLL_MS = 3_000;

/** `poll`: keep asking while the background service is not connected yet or the folder search is not complete. */
export function useSetupState(enabled = true, poll = false) {
  return useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => send<SetupState>("GET", "/api/setup"),
    enabled,
    retry: false,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      return poll && (!data || !data.bridgeOnline || data.suggestions.complete === false) ? SETUP_POLL_MS : false;
    },
  });
}

/** Changing the project folders restarts parts of the background service for a moment – retry briefly then. */
const APPLY_RETRIES = 3;
const APPLY_RETRY_MS = 1_500;

export function useApplySetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupApply) => send<SetupState>("POST", "/api/setup", input),
    retry: (count, error) => error instanceof OnboardingApiError && error.status === 503 && count < APPLY_RETRIES,
    retryDelay: APPLY_RETRY_MS,
    onSuccess: (state) => qc.setQueryData(SETUP_KEY, state),
    onError: () => void qc.invalidateQueries({ queryKey: SETUP_KEY }),
  });
}

/** Folder picker: subfolders of `path` (home folder without `path`). */
export function useBrowseFolder(path: string | null, enabled = true) {
  return useQuery({
    queryKey: ["setup", "browse", path ?? "~"] as const,
    queryFn: () => send<SetupBrowseResult>("GET", path ? `/api/setup/browse?path=${encodeURIComponent(path)}` : "/api/setup/browse"),
    enabled,
    retry: false,
    staleTime: 10_000,
  });
}
