// Einstellung „Nach wie vielen Stunden ohne Prozess gilt eine Session nicht mehr als abgestürzt?“
// Wirkt auf Zustand, Zähler, „Kritische Sessions“, Briefing und Rundgang (Server rechnet sofort neu).
import { DEFAULT_CRASHED_MAX_HOURS, t, type SessionStateSettings } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { writeJson } from "../../lib/api";

const URL = "/api/settings/session-state";
const MAX_HOURS = 24 * 90;

async function fetchSettings(): Promise<SessionStateSettings> {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(t("Einstellung konnte nicht geladen werden."));
  return (await res.json()) as SessionStateSettings;
}

const FIELD = "w-24 rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 font-mono text-callout text-a-ink focus:border-a-acc focus:outline-none";

export function SessionStateSettingsPanel() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["session-state-settings"], queryFn: fetchSettings });
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(data?.crashedMaxHours ?? DEFAULT_CRASHED_MAX_HOURS);
  const hours = Number(value);
  const valid = Number.isInteger(hours) && hours >= 1 && hours <= MAX_HOURS;

  const save = useMutation({
    mutationFn: (crashedMaxHours: number) => writeJson<SessionStateSettings>("PATCH", URL, { crashedMaxHours }),
    onSuccess: (next) => {
      qc.setQueryData(["session-state-settings"], next);
      setDraft(null);
      // Zähler und Listen ändern sich sofort — Überblick, Sessions und Briefing neu holen.
      for (const key of [["overview"], ["sessions"], ["categories"], ["haiku", "report"]]) void qc.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <section aria-label={t("Sessions")} className="min-w-0 space-y-3 rounded-xl border border-a-line bg-a-p p-4">
      <h3 className="font-display text-headline text-a-ink">{t("Sessions")}</h3>
      <p className="text-callout text-a-mut">
        {t(
          "Ist der Prozess einer Session weg, ohne dass sie sauber beendet wurde, gilt sie als abgestürzt. Nach dieser Zeit zählt sie nicht mehr dazu und steht unter „Beendet“ – im Überblick, im Briefing und bei „Braucht dich“. Standard: {n} Stunden (ein Arbeitstag mit Abend).",
          { n: DEFAULT_CRASHED_MAX_HOURS },
        )}
      </p>
      {isLoading && <p className="text-callout text-a-mut">{t("Lädt …")}</p>}
      {isError && (
        <button type="button" onClick={() => void refetch()} className="w-fit rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
          {t("Erneut versuchen")}
        </button>
      )}
      {data && (
        <form
          className="flex min-w-0 flex-wrap items-center gap-2 text-callout text-a-ink"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate(hours);
          }}
        >
          <label htmlFor="crashed-max-hours">{t("Als abgestürzt zählen, bis")}</label>
          <input
            id="crashed-max-hours"
            className={FIELD}
            type="number"
            min={1}
            max={MAX_HOURS}
            step={1}
            value={value}
            aria-invalid={!valid}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span>{t("Stunden ohne Prozess vergangen sind")}</span>
          <button
            type="submit"
            disabled={!valid || save.isPending || draft === null}
            className="rounded-lg border border-transparent bg-a-primary px-3 py-1 text-caption font-semibold text-a-on-primary hover:brightness-110 disabled:opacity-50"
          >
            {t("Speichern")}
          </button>
          {save.isSuccess && draft === null && <span className="text-caption text-a-ok">{t("Gespeichert")}</span>}
          {!valid && <span className="text-caption text-a-bad">{t("Bitte eine ganze Zahl von 1 bis {max} (90 Tage).", { max: MAX_HOURS })}</span>}
          {save.isError && <span className="text-caption text-a-bad">{t("Nicht gespeichert – bitte noch einmal.")}</span>}
        </form>
      )}
    </section>
  );
}
