// „Nutzung einstellen“ — Standard-Zeitraum, Ziele (je Monat/Woche, auf alles oder ein Werkzeug)
// und Warnschwellen (5-Std-Fenster in %, Tagesverbrauch in Tokens). Als Blatt oben im Tab „Nutzung“ und
// als Abschnitt in den Einstellungen. Gespeichert auf dem Server (`PATCH /api/usage/settings`, mit
// Anmeldung über `authFetch`). Token-Mengen dürfen so getippt werden, wie man sie sagt („10 Mrd.“).
import { friendlyError } from "../../lib/friendlyError";
import { t, tc } from "@nyxos/shared";
import type { UsageGoalScope, UsageRange, UsageSettings, UsageSettingsPatch } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { LoginRequiredError } from "../terminal/authClient";
import { fetchUsageSettings, saveUsageSettings } from "./api";
import { formatTokenInput, parseTokenAmount } from "./format";
import { Segmented } from "./parts";

export const USAGE_SETTINGS_KEY = ["usage-settings"] as const;

const FIELD = "w-full rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 font-mono text-callout text-a-ink placeholder:text-a-mut/70 focus:border-a-acc focus:outline-none";
const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";

const RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: "7", label: t("7 Tage") },
  { value: "30", label: t("30 Tage") },
  { value: "all", label: tc("period", "Alles") },
];
const SCOPE_OPTIONS: { value: UsageGoalScope; label: string }[] = [
  { value: "all", label: t("Alle") },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

interface Draft {
  defaultRange: UsageRange;
  goalScope: UsageGoalScope;
  goalMonth: string;
  goalWeek: string;
  warnPct: string;
  warnDaily: string;
}

const amountText = (n: number | null) => (n === null ? "" : formatTokenInput(n));

function toDraft(s: UsageSettings): Draft {
  return {
    defaultRange: s.defaultRange,
    goalScope: s.goalScope,
    goalMonth: amountText(s.goalMonthTokens),
    goalWeek: amountText(s.goalWeekTokens),
    warnPct: s.warnWindowPct === null ? "" : String(s.warnWindowPct),
    warnDaily: amountText(s.warnDailyTokens),
  };
}

/** Entwurf → Änderung für den Server; leere Felder = „aus“ (`null`). Fehler in einfachen Worten. */
export function draftToPatch(d: Draft): { patch: UsageSettingsPatch; errors: string[] } {
  const errors: string[] = [];
  const amount = (label: string, text: string): number | null => {
    if (text.trim() === "") return null;
    const v = parseTokenAmount(text);
    if (v === null) errors.push(t("{label}: bitte eine Zahl wie „10 Mrd.“ oder „500 Mio.“ eingeben (leer = aus).", { label }));
    return v;
  };
  const goalMonthTokens = amount(t("Ziel je Monat"), d.goalMonth);
  const goalWeekTokens = amount(t("Ziel je Woche"), d.goalWeek);
  const warnDailyTokens = amount(t("Warnen ab Tagesverbrauch"), d.warnDaily);
  let warnWindowPct: number | null = null;
  if (d.warnPct.trim() !== "") {
    const v = Number(d.warnPct.trim().replace(",", "."));
    if (!Number.isInteger(v) || v < 1 || v > 100) errors.push(t("Warnen ab Anteil am 5-Std-Fenster: bitte eine ganze Zahl von 1 bis 100 (leer = aus)."));
    else warnWindowPct = v;
  }
  return { patch: { defaultRange: d.defaultRange, goalScope: d.goalScope, goalMonthTokens, goalWeekTokens, warnWindowPct, warnDailyTokens }, errors };
}

export function useUsageSettings() {
  return useQuery({ queryKey: USAGE_SETTINGS_KEY, queryFn: fetchUsageSettings, staleTime: 60_000 });
}

export function UsageSettingsSheet({ variant = "sheet", onClose }: { variant?: "sheet" | "section"; onClose?: () => void }) {
  const qc = useQueryClient();
  const settings = useUsageSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data && draft === null) setDraft(toDraft(settings.data));
  }, [settings.data, draft]);

  const save = useMutation({
    mutationFn: saveUsageSettings,
    onSuccess: (next) => {
      qc.setQueryData(USAGE_SETTINGS_KEY, next);
      void qc.invalidateQueries({ queryKey: ["usage-goals"] });
      setDraft(toDraft(next));
      setSaved(true);
    },
  });

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const onSave = () => {
    if (!draft) return;
    const { patch, errors: errs } = draftToPatch(draft);
    setErrors(errs);
    if (errs.length === 0) save.mutate(patch);
  };

  const body =
    settings.isError ? (
      <div className="flex flex-wrap items-center gap-3 text-callout text-a-mut">
        {t("Einstellungen konnten nicht geladen werden.")}
        <button type="button" onClick={() => void settings.refetch()} className="rounded-md border border-a-line px-2.5 py-1 text-caption text-a-ink hover:bg-a-p2">
          {t("Erneut versuchen")}
        </button>
      </div>
    ) : !draft ? (
      <Skeleton className="h-[260px] rounded-lg" />
    ) : (
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <span className={LABEL}>{t("Standard-Zeitraum")}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label={t("Standard-Zeitraum")} options={RANGE_OPTIONS} value={draft.defaultRange} onChange={(v) => set({ defaultRange: v })} />
            <span className="text-caption text-a-mut">{t("so öffnet sich der Tab „Nutzung“")}</span>
          </div>
        </div>

        <fieldset className="grid gap-3">
          <legend className={cn(LABEL, "mb-1.5")}>{t("Ziele")}</legend>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label={t("Ziele zählen")} options={SCOPE_OPTIONS} value={draft.goalScope} onChange={(v) => set({ goalScope: v })} />
            <span className="text-caption text-a-mut">{t("welche Nutzung zum Ziel zählt")}</span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[repeat(2,minmax(0,1fr))]">
            <label className="grid gap-1">
              <span className="text-caption text-a-ink">{t("Ziel je Monat")}</span>
              <input className={FIELD} value={draft.goalMonth} placeholder={t("z. B. 10 Mrd.")} inputMode="decimal" onChange={(e) => set({ goalMonth: e.target.value })} />
            </label>
            <label className="grid gap-1">
              <span className="text-caption text-a-ink">{t("Ziel je Woche")}</span>
              <input className={FIELD} value={draft.goalWeek} placeholder={t("z. B. 2,5 Mrd.")} inputMode="decimal" onChange={(e) => set({ goalWeek: e.target.value })} />
            </label>
          </div>
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className={cn(LABEL, "mb-1.5")}>{t("Warnschwellen")}</legend>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[repeat(2,minmax(0,1fr))]">
            <label className="grid gap-1">
              <span className="text-caption text-a-ink">{t("Warnen ab Anteil am 5-Std-Fenster (%)")}</span>
              <input className={FIELD} value={draft.warnPct} placeholder={t("z. B. 80")} inputMode="numeric" onChange={(e) => set({ warnPct: e.target.value })} />
            </label>
            <label className="grid gap-1">
              <span className="text-caption text-a-ink">{t("Warnen ab Tagesverbrauch (Tokens)")}</span>
              <input className={FIELD} value={draft.warnDaily} placeholder={t("z. B. 1 Mrd.")} inputMode="decimal" onChange={(e) => set({ warnDaily: e.target.value })} />
            </label>
          </div>
          <p className="text-caption leading-snug text-a-mut">
            {t("Der Anteil am 5-Std-Fenster ist derselbe Wert wie der Ring unter „Fenster und Limits“: bei Codex vom Anbieter gemeldet, bei Claude dein Anteil am bisher stärksten Fenster (Anthropic nennt das echte Limit nicht). Warnungen kommen als Push aufs Handy (Anlass „Nutzung über Warnschwelle“), höchstens einmal am Tag bzw. alle 5 Stunden.")}
          </p>
        </fieldset>

        {errors.length > 0 && (
          <ul className="grid gap-1 text-caption text-a-bad" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={save.isPending}
            onClick={onSave}
            className={cn("rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 font-mono text-caption text-a-acc hover:bg-a-acc/15", save.isPending && "opacity-50")}
          >
            {save.isPending ? t("Speichert …") : t("Speichern")}
          </button>
          {saved && !save.isPending && (
            <span role="status" className="text-caption text-a-ok">
              {t("Gespeichert.")}
            </span>
          )}
          {save.isError && (
            <span className="text-caption text-a-bad">{save.error instanceof LoginRequiredError ? t("Zum Speichern bitte anmelden (Touch ID).") : friendlyError(save.error, t("Nicht gespeichert – bitte noch einmal versuchen."))}</span>
          )}
        </div>
      </div>
    );

  if (variant === "section") {
    return (
      <section aria-label={t("Nutzung")} className="min-w-0 space-y-4 rounded-xl border border-a-line bg-a-p p-4">
        <h3 className="font-display text-headline text-a-ink">{t("Nutzung")}</h3>
        <p className="text-callout text-a-mut">{t("Standard-Zeitraum, Ziele und Warnschwellen für den Tab „Nutzung“.")}</p>
        {body}
      </section>
    );
  }
  return (
    <section aria-label={t("Nutzung einstellen")} data-testid="usage-settings-sheet" className="grid min-w-0 gap-3 rounded-xl border border-a-acc/40 bg-a-p2 p-4 shadow-[0_8px_24px_rgba(0,0,0,.35)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-headline font-semibold text-a-ink">{t("Nutzung einstellen")}</h2>
        {onClose && (
          <button type="button" onClick={onClose} className="shrink-0 rounded-md px-2 py-1 text-caption text-a-mut hover:bg-a-p3 hover:text-a-ink">
            {t("Schließen ✕")}
          </button>
        )}
      </div>
      {body}
    </section>
  );
}
