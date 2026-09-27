// Wegwerf-Chats: Einstellung „nach X Stunden“ und der Knopf an einer Session. Vertrag:
// `packages/shared/src/temporary.ts`, Server `apps/server/src/routes/temporary.ts`.
import { t, type TemporaryReason, type TemporarySettings } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { writeJson } from "../../lib/api";

const SETTINGS_KEY = ["temporary", "settings"] as const;

async function fetchSettings(): Promise<TemporarySettings> {
  const res = await fetch("/api/temporary/settings");
  if (!res.ok) throw new Error(t("Einstellung konnte nicht geladen werden ({status})", { status: res.status }));
  return (await res.json()) as TemporarySettings;
}

export function useTemporarySettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchSettings, staleTime: 60_000 });
}

export function useSaveTemporaryHours() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hours: number) => writeJson<TemporarySettings>("PATCH", "/api/temporary/settings", { hours }),
    onSuccess: (next) => {
      qc.setQueryData(SETTINGS_KEY, next);
      // Restzeiten in Sessions- und Fadenliste hängen daran.
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: ["haiku", "threads"] });
    },
  });
}

/** „Temporär machen“ bzw. „Behalten“ an einer Session (Behalten sperrt die Auto-Markierung). */
export function useSetSessionTemporary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, temporary }: { id: string; temporary: boolean }) =>
      writeJson<{ id: string; temporary: boolean }>("POST", `/api/sessions/${encodeURIComponent(id)}/temporary`, { temporary }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      // Die Detail-Abfrage hängt an der Adresse (UUID oder Schlüssel) – darum alle Session-Details.
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: ARCHIVE_KEY });
    },
  });
}

/** Eine archivierte Session im Archiv (Einstellungen). Server: `listArchived` in `temporary.ts`. */
export interface ArchivedSession {
  id: string;
  sessionId: string;
  tool: string;
  title: string | null;
  href: string;
  temporaryReason: TemporaryReason | null;
  archivedAt: string;
  lastActivityAt: string | null;
}

const ARCHIVE_KEY = ["temporary", "archive"] as const;

async function fetchArchive(): Promise<ArchivedSession[]> {
  const res = await fetch("/api/temporary/archive");
  if (!res.ok) throw new Error(t("Archiv konnte nicht geladen werden ({status})", { status: res.status }));
  return ((await res.json()) as { sessions: ArchivedSession[] }).sessions;
}

export function useTemporaryArchive() {
  return useQuery({ queryKey: ARCHIVE_KEY, queryFn: fetchArchive, staleTime: 30_000 });
}
