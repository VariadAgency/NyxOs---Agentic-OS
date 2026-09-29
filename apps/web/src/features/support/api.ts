// Web side of "Feedback & Unterstützen": `/api/support/*` on the own NyxOS server (routes/support.ts).
import {
  t,
  type SupportBugInput,
  type SupportDonateInput,
  type SupportDonateResult,
  type SupportIdeaInput,
  type SupportSendResult,
  type SupportState,
} from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../terminal/authClient";

export const SUPPORT_STATE_KEY = ["support-state"] as const;
/** While the sheet is open the outbox count stays fresh (a waiting report may go out in the server's tick). */
const POLL_MS = 15_000;

/** Error with the server's sentence (`error`) and code (`not_configured`, `rejected`, …). */
export class SupportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
  const body = (await res.json().catch(() => null)) as ({ error?: unknown; code?: unknown } & Record<string, unknown>) | null;
  if (!res.ok) {
    const msg = typeof body?.error === "string" ? body.error : t("Server antwortet mit {status}", { status: res.status });
    throw new SupportError(msg, res.status, typeof body?.code === "string" ? body.code : null);
  }
  return body as T;
}

const send = <T>(method: string, url: string, body: unknown) => request<T>(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchSupportState = () => request<SupportState>("/api/support/state");

export function useSupportState(enabled: boolean) {
  return useQuery({ queryKey: SUPPORT_STATE_KEY, queryFn: fetchSupportState, enabled, refetchInterval: enabled ? POLL_MS : false, retry: false });
}

function useSupportMutation<I, O>(fn: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => void qc.invalidateQueries({ queryKey: SUPPORT_STATE_KEY }) });
}

export const useSendBug = () => useSupportMutation((input: SupportBugInput) => send<SupportSendResult>("POST", "/api/support/bug", input));
export const useSendIdea = () => useSupportMutation((input: SupportIdeaInput) => send<SupportSendResult>("POST", "/api/support/idea", input));
export const useStartDonation = () => useSupportMutation((input: SupportDonateInput) => send<SupportDonateResult>("POST", "/api/support/donate", input));
export const useFlushOutbox = () => useSupportMutation(() => send<{ sent: number }>("POST", "/api/support/flush", {}));
export const useRemoveOutboxItem = () => useSupportMutation((id: number) => request<{ ok: true }>(`/api/support/outbox/${id}`, { method: "DELETE" }));
export const useSaveSupportUrl = () => useSupportMutation((url: string) => send<SupportState>("PUT", "/api/support/settings", { url }));
