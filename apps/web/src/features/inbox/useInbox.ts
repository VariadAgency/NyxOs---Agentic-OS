// Queries/Mutationen der Entscheidungs-Inbox und der Freigaben — geteilt von FAB-Badge,
// Nav-Badge, Plan-Karten im Panel, Briefing (Leichter Tag) und InboxView.
import type { InboxAnswer } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { answerInbox, decideApproval, dismissInbox, fetchApprovals, fetchInbox, fetchOpenQuestions } from "../haiku/haikuApi";

/** Sicherheitsnetz neben den `/live`-Signalen (useHaikuLive). */
const REFRESH_MS = 60_000;

export function useOpenInbox() {
  return useQuery({ queryKey: ["inbox", "open"], queryFn: () => fetchInbox("open"), refetchInterval: REFRESH_MS });
}

export function usePendingApprovals() {
  return useQuery({ queryKey: ["approvals", "pending"], queryFn: () => fetchApprovals("pending"), refetchInterval: REFRESH_MS });
}

/** Freigaben + Entscheidungs-Karten + offene Konflikt-Fragen — dieselbe Zahl wie die Überblick-Kachel. */
export function useOpenQuestions() {
  return useQuery({ queryKey: ["open-questions"], queryFn: fetchOpenQuestions, refetchInterval: REFRESH_MS });
}

/** `delayMs` > 0: erst nach dem Ausblenden der Karte neu laden (sonst verschwindet sie schlagartig). */
function useInvalidateDecisions(delayMs = 0) {
  const qc = useQueryClient();
  return () => {
    const run = () => {
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["open-questions"] });
      void qc.invalidateQueries({ queryKey: ["haiku", "light-day"] });
    };
    if (delayMs > 0) setTimeout(run, delayMs);
    else run();
  };
}

export function useAnswerInbox(delayMs = 0) {
  const invalidate = useInvalidateDecisions(delayMs);
  return useMutation({ mutationFn: ({ id, answer }: { id: number; answer: InboxAnswer }) => answerInbox(id, answer), onSuccess: invalidate });
}

export function useDismissInbox(delayMs = 0) {
  const invalidate = useInvalidateDecisions(delayMs);
  return useMutation({ mutationFn: (id: number) => dismissInbox(id), onSuccess: invalidate });
}

export function useDecideApproval(delayMs = 0) {
  const invalidate = useInvalidateDecisions(delayMs);
  return useMutation({ mutationFn: ({ id, decision }: { id: number; decision: "approve" | "deny" }) => decideApproval(id, decision), onSuccess: invalidate });
}
