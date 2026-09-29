// Nachtmodus-Einstellungen — eigener Abschnitt für die Einstellungen-Seite. Liest/schreibt `GET`/`PATCH /api/night/settings`.
import { friendlyError } from "../../lib/friendlyError";
import { t, type NightSettings } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { authFetch } from "../terminal/authClient";

async function fetchSettings(): Promise<NightSettings> {
  const res = await fetch("/api/night/settings");
  if (!res.ok) throw new Error(t("Einstellungen konnten nicht geladen werden ({status})", { status: res.status }));
  return res.json();
}

async function patchSettings(patch: Partial<NightSettings>): Promise<NightSettings> {
  const res = await authFetch("/api/night/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(t("Einstellungen konnten nicht gespeichert werden ({status})", { status: res.status }));
  return res.json();
}

const FIELD = "w-full rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 font-mono text-callout text-a-ink focus:border-a-acc focus:outline-none";
const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";

export function NightSettingsPanel() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: ["night-settings"], queryFn: fetchSettings });
  const [draft, setDraft] = useState<NightSettings | null>(null);
  const current = draft ?? settings ?? null;

  const mutation = useMutation({
    mutationFn: patchSettings,
    onSuccess: (next) => {
      qc.setQueryData(["night-settings"], next);
      setDraft(null);
    },
  });

  if (isLoading || !current) return <div className="font-body text-callout text-a-mut">{t("Lädt …")}</div>;

  const set = (patch: Partial<NightSettings>) => setDraft({ ...current, ...patch, budget: { ...current.budget, ...patch.budget } });

  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-a-line bg-a-p p-4">
      <h3 className="font-display text-headline text-a-ink">{t("Nachtmodus")}</h3>

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={LABEL}>{t("Fenster Start")}</span>
          <input className={FIELD} type="time" value={current.window.start} onChange={(e) => set({ window: { ...current.window, start: e.target.value } })} />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>{t("Fenster Ende")}</span>
          <input className={FIELD} type="time" value={current.window.end} onChange={(e) => set({ window: { ...current.window, end: e.target.value } })} />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>{t("Max. parallele Opus-Sessions")}</span>
          <input
            className={FIELD}
            type="number"
            min={1}
            max={10}
            value={current.budget.maxParallelOpus}
            onChange={(e) => set({ budget: { ...current.budget, maxParallelOpus: Number(e.target.value) } })}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>{t("Max. % Wochenlimit pro Nacht")}</span>
          <input
            className={FIELD}
            type="number"
            min={0}
            max={100}
            value={Math.round(current.budget.maxWeeklyFractionPerNight * 100)}
            onChange={(e) => set({ budget: { ...current.budget, maxWeeklyFractionPerNight: Number(e.target.value) / 100 } })}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>{t("Zeitgrenze je Auftrag (Min.)")}</span>
          <input
            className={FIELD}
            type="number"
            min={1}
            value={current.budget.hardTimeLimitMinutesPerTask}
            onChange={(e) => set({ budget: { ...current.budget, hardTimeLimitMinutesPerTask: Number(e.target.value) } })}
          />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>{t("Token-Grenze je Auftrag")}</span>
          <input
            className={FIELD}
            type="number"
            min={1000}
            step={1000}
            value={current.budget.hardTokenLimitPerTask}
            onChange={(e) => set({ budget: { ...current.budget, hardTokenLimitPerTask: Number(e.target.value) } })}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!draft || mutation.isPending}
          onClick={() => draft && mutation.mutate(draft)}
          className={cn("rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 font-mono text-caption text-a-acc", (!draft || mutation.isPending) && "opacity-50")}
        >
          {mutation.isPending ? t("Speichert …") : t("Speichern")}
        </button>
        {mutation.isError && <span className="font-body text-caption text-a-bad">{friendlyError(mutation.error, t("Nicht gespeichert – bitte noch einmal versuchen."))}</span>}
      </div>
    </section>
  );
}
