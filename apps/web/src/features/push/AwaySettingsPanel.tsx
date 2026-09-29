// Abwesenheit – Einstellungen „Wenn ich weg bin“. Nyx merkt über den Herzschlag des Fensters, wann du nicht
// mehr in NyxOS arbeitest: Fertiges kommt dann gebündelt aufs iPhone (nur ntfy), Fragen kommen über Telegram.
import { AWAY_EVENT_KINDS, t, type AwayEventKind, type AwaySettings, type AwaySettingsPatch, type AwayStatus } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { authFetch } from "../terminal/authClient";

const EVENT_LABEL: Record<AwayEventKind | "questions", string> = {
  session_done: t("Session fertig"),
  auftrag_done: t("Auftrag erledigt"),
  bug_new: t("Neuer Bug (auch aus Audits)"),
  build_red: t("Build rot"),
  night_done: t("Nachtlauf fertig"),
  questions: t("Fragen an dich → Telegram"),
};

const FIELD = "w-full rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 font-mono text-callout text-a-ink focus:border-a-acc focus:outline-none";
const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";

async function fetchStatus(): Promise<AwayStatus> {
  const res = await fetch("/api/away/status");
  if (!res.ok) throw new Error(t("Einstellungen konnten nicht geladen werden ({status})", { status: res.status }));
  return res.json();
}

async function saveSettings(patch: AwaySettingsPatch): Promise<AwaySettings> {
  const res = await authFetch("/api/away/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(t("Einstellungen konnten nicht gespeichert werden ({status})", { status: res.status }));
  return res.json();
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="space-y-1">
      <span className={LABEL}>{label}</span>
      <input className={FIELD} type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function AwaySettingsPanel() {
  const qc = useQueryClient();
  const { data: status, isLoading, isError, error } = useQuery({ queryKey: ["away-status"], queryFn: fetchStatus, refetchInterval: 60_000 });
  const [draft, setDraft] = useState<AwaySettings | null>(null);
  const save = useMutation({
    mutationFn: saveSettings,
    onSuccess: (settings) => {
      qc.setQueryData<AwayStatus>(["away-status"], (old) => (old ? { ...old, settings } : old));
      setDraft(null);
    },
  });

  if (isLoading) return <div className="font-body text-callout text-a-mut">{t("Lädt …")}</div>;
  if (isError || !status) return <p className="font-body text-caption text-a-bad">{friendlyError(error, t("Einstellungen konnten nicht geladen werden."))}</p>;
  const current = draft ?? status.settings;
  const set = (patch: Partial<AwaySettings>) => setDraft({ ...current, ...patch });
  const setEvent = (k: keyof AwaySettings["events"], v: boolean) => set({ events: { ...current.events, [k]: v } });

  return (
    <div className="min-w-0 space-y-3 rounded-lg border border-a-line bg-a-p2 px-3 py-3" data-testid="away-settings">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="font-display text-callout text-a-ink">{t("Wenn ich weg bin")}</div>
          <p className="font-body text-caption text-a-mut">
            {t("Ist kein NyxOS-Fenster aktiv, schickt Nyx Fertiges gebündelt aufs Handy (nur ntfy) – höchstens eine Mitteilung pro Abstand. Fragen an dich kommen über Telegram, dort kannst du direkt antworten. Solange du weg bist, gehen einzelne Mitteilungen nur noch an deinen Rechner und den Browser.")}
          </p>
          <p className="font-body text-caption text-a-mut">
            {t("Gerade:")} <span className={status.away ? "text-a-wait" : "text-a-ok"}>{status.away ? t("weg") : t("da")}</span>
            {status.pendingEvents > 0 ? ` · ${status.pendingEvents === 1 ? t("1 Meldung gesammelt") : t("{n} Meldungen gesammelt", { n: status.pendingEvents })}` : ""}
          </p>
        </div>
        <input type="checkbox" aria-label={t("Wenn ich weg bin an/aus")} checked={current.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
      </div>

      {current.enabled && (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <NumberField label={t("Weg nach (Minuten)")} value={current.awayAfterMinutes} min={1} max={240} onChange={(v) => set({ awayAfterMinutes: v })} />
            <NumberField label={t("Höchstens alle (Minuten)")} value={current.bundleMinutes} min={1} max={240} onChange={(v) => set({ bundleMinutes: v })} />
            <NumberField label={t("Wichtiges frühestens alle (Minuten)")} value={current.urgentGapMinutes} min={1} max={120} onChange={(v) => set({ urgentGapMinutes: v })} />
            <NumberField label={t("Telegram-Fragen höchstens alle (Minuten)")} value={current.questionGapMinutes} min={0} max={120} onChange={(v) => set({ questionGapMinutes: v })} />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 font-body text-callout text-a-ink">
              <input type="checkbox" checked={current.quietEnabled} onChange={(e) => set({ quietEnabled: e.target.checked })} />
              {t("Ruhezeit (dann nur Wichtiges: Build rot, Bug P0/P1)")}
            </label>
            {current.quietEnabled && (
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className={LABEL}>{t("Ruhezeit Start")}</span>
                  <input className={FIELD} type="time" value={current.quietStart} onChange={(e) => set({ quietStart: e.target.value })} />
                </label>
                <label className="space-y-1">
                  <span className={LABEL}>{t("Ruhezeit Ende")}</span>
                  <input className={FIELD} type="time" value={current.quietEnd} onChange={(e) => set({ quietEnd: e.target.value })} />
                </label>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <span className={LABEL}>{t("Was gemeldet wird")}</span>
            <ul className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
              {[...AWAY_EVENT_KINDS, "questions" as const].map((k) => (
                <li key={k} className="flex items-center justify-between gap-2 rounded-lg border border-a-line bg-a-p px-2.5 py-1.5">
                  <span className="font-body text-callout text-a-ink">{EVENT_LABEL[k]}</span>
                  <input type="checkbox" checked={current.events[k]} onChange={(e) => setEvent(k, e.target.checked)} />
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!draft || save.isPending}
          onClick={() => draft && save.mutate(draft)}
          className={cn("rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 font-mono text-caption text-a-acc", (!draft || save.isPending) && "opacity-50")}
        >
          {save.isPending ? t("Speichert …") : t("Speichern")}
        </button>
        {save.isError && <span className="font-body text-caption text-a-bad">{friendlyError(save.error, t("Das hat nicht geklappt – bitte noch einmal versuchen."))}</span>}
      </div>
    </div>
  );
}
