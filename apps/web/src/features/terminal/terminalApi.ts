// Web-Seite der Terminal-Steuerung: Brücken-Status, Ordner, Starten/Fortsetzen/Beenden.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t } from "@nyxos/shared";
import { writeJson, type Session, type SessionDetail } from "../../lib/api";

export interface BridgeStatus {
  online: boolean;
  machineId: string | null;
  since: string | null;
}

export interface StartResult {
  tmuxName: string;
  tool: "claude" | "codex";
  sessionId: string | null;
  startedMs: number;
}

export interface StartInput {
  tool: "claude" | "codex";
  model: string | null;
  cwd: string;
  prompt: string | null;
  /** Wegwerf-Session (⏳), verschwindet nach X Stunden ins Archiv. */
  temporary?: boolean;
  /** Auftrag, an dem die Session nach dem Start hängt. */
  entryId?: number;
}

export function useBridgeStatus() {
  return useQuery({
    queryKey: ["terminal-status"],
    queryFn: async (): Promise<BridgeStatus> => {
      const r = await fetch("/api/terminal/status");
      if (!r.ok) throw new Error(t("Server antwortet mit {status}", { status: r.status }));
      return (await r.json()) as BridgeStatus;
    },
    refetchInterval: 15_000,
  });
}

export function useFolders(enabled: boolean) {
  return useQuery({
    queryKey: ["terminal-folders"],
    enabled,
    queryFn: async (): Promise<{ label: string; path: string }[]> => {
      const r = await fetch("/api/terminal/folders");
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? t("Server antwortet mit {status}", { status: r.status }));
      return ((await r.json()) as { folders: { label: string; path: string }[] }).folders;
    },
    staleTime: 60_000,
  });
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartInput) => writeJson<StartResult>("POST", "/api/terminal/start", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

// ── „In der NyxOS übernehmen“ ────────────────────────────────────────────────────────────

/** Was hängt an der Session? Antwort des Servers für den Dialog. */
export type TakeoverPreview =
  | { attachable: true }
  | {
      attachable: false;
      tool: "claude" | "codex";
      /** Programme außerhalb der NyxOS (PID + Fenster, so weit erkennbar). Leer = läuft nirgends. */
      processes: { pid: number; app: string | null }[];
      inNyxOS: string | null;
      /** Arbeitet Claude/Codex gerade an einer Antwort? */
      working: boolean;
      /** Vorauswahl im Dialog: altes Fenster beenden, nur mitlesen, oder (nichts dran) einfach fortsetzen. */
      recommended: "end_old" | "watch" | "resume";
    };

export function useTakeoverPreview() {
  return useMutation({
    mutationFn: (s: Pick<Session, "id">) => writeJson<TakeoverPreview>("POST", `/api/sessions/${encodeURIComponent(s.id)}/takeover/preview`, {}),
  });
}

export function useTakeover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { session: Pick<Session, "id">; endPids: number[] }) =>
      writeJson<StartResult>("POST", `/api/sessions/${encodeURIComponent(v.session.id)}/takeover`, { endPids: v.endPids }),
    onSuccess: (r, v) => {
      // Sofort als „in der NyxOS“ markieren, damit das Terminal ohne Warten auf den nächsten Abruf verbindet.
      qc.setQueryData<SessionDetail>(["session", v.session.id], (d) =>
        d ? { ...d, session: { ...d.session, attachable: true, tmuxName: r.tmuxName, startedVia: "nyxos" } } : d,
      );
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: ["session", v.session.id] });
    },
  });
}

export function useKillSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: Pick<Session, "id">) => writeJson<{ killed: boolean }>("POST", `/api/sessions/${encodeURIComponent(s.id)}/kill`, { confirm: true }),
    onSuccess: (_r, s) => {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: ["session", s.id] });
    },
  });
}

/** Neue Session von überall öffnen (Tab-Zeile 3, ⌘K) — ein Ereignis statt geteiltem Zustand. */
export const NEW_SESSION_EVENT = "nyxos:new-session";
export const openNewSession = () => window.dispatchEvent(new Event(NEW_SESSION_EVENT));

/** Vorbelegung des Dialogs (z. B. „Agent starten“ im Aufgaben-Tab). Gestartet wird nur nach Klick. */
export interface NewSessionInitial {
  tool: "claude" | "codex";
  model: string;
  /** Repo relativ zum Projekt-Ordner der Brücke; der Dialog sucht den passenden Ordner. */
  repo: string;
  prompt: string;
  /** Session hängt nach dem Start an diesem Auftrag. */
  entryId: number;
  entryTitle: string;
}

export const openNewSessionWith = (initial: NewSessionInitial) => window.dispatchEvent(new CustomEvent<NewSessionInitial>(NEW_SESSION_EVENT, { detail: initial }));
