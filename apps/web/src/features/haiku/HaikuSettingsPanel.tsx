// Haiku-Einstellungen + Verbrauch, Route `/einstellungen/haiku`. Motor, Tages-Budget, Zeiten;
// Verbrauch heute als Ring und die letzten Aufrufe.
import { friendlyError } from "../../lib/friendlyError";
import { formatTokensCompact, getLang, t, type HaikuCall, type HaikuEngineKind, type HaikuSettings, type HaikuSettingsPatch, type HaikuStatus } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { EngineNotice, EngineStateLine, useHaikuStatus } from "./EngineStatus";
import { fetchHaikuCalls, patchHaikuSettings, runHaikuSelftest } from "./haikuApi";
import { ErrorBox, FIELD, LABEL, formatUsd, riseStyle } from "./ui";

type NumField = "dailyBudgetUsd" | "rundgangMinutes" | "timeoutSeconds" | "ideaLinkBudgetPercent" | "ideaLinkIdeasPerLinkDay" | "ideaLinkIdeasPerDay";
type TimeField = "briefingTime" | "recapTime";
type Draft = Partial<Record<NumField | TimeField, string>> & { engine?: HaikuEngineKind };

const ENGINE_OPTIONS: { kind: HaikuEngineKind; label: string; hint: string }[] = [
  { kind: "claude-cli", label: t("Claude-CLI (Max-Plan)"), hint: t("Offizielles Claude-Programm auf dem Server, läuft über deinen Max-Plan") },
  { kind: "api", label: t("Reserve-API"), hint: t("Modell per API-Schlüssel") },
  { kind: "off", label: t("Aus"), hint: t("Briefing und Recap nur aus Zahlen, kein Chat") },
];

const NUM_FIELDS: { key: NumField; label: string; step: number; min: number; max: number }[] = [
  { key: "dailyBudgetUsd", label: t("Tagesgrenze (Gegenwert in USD)"), step: 0.5, min: 0, max: 100 },
  { key: "rundgangMinutes", label: t("Rundgang alle (Minuten)"), step: 5, min: 5, max: 240 },
  { key: "timeoutSeconds", label: t("Zeitlimit je Aufruf (Sekunden)"), step: 10, min: 10, max: 600 },
  { key: "ideaLinkBudgetPercent", label: t("Ideen-Links: Anteil an der Tagesgrenze (%)"), step: 5, min: 0, max: 100 },
  { key: "ideaLinkIdeasPerLinkDay", label: t("Ideen-Links: neue Ideen je Link und Tag"), step: 1, min: 0, max: 100 },
  { key: "ideaLinkIdeasPerDay", label: t("Ideen-Links: neue Ideen pro Tag insgesamt"), step: 1, min: 0, max: 500 },
];

const TIME_FIELDS: { key: TimeField; label: string }[] = [
  { key: "briefingTime", label: t("Briefing um") },
  { key: "recapTime", label: t("Recap um") },
];

const CALL_KIND: Record<HaikuCall["kind"], string> = {
  chat: t("Chat"),
  briefing: t("Briefing"),
  recap: t("Recap"),
  rundgang: t("Rundgang"),
  idealink: t("Ideen-Link"),
  antwort: t("Antwort"),
  auswertung: t("Auswertung"),
  sortierung: t("Sortierung"),
  plan: t("Plan"),
  review: t("Lernprüfung"),
  schedule: t("Geplante Aufgabe"),
  compact: t("Verdichtung"),
  idee: t("Ideen"),
  prompt: t("Prompt verbessern"),
};

const CALL_STATUS: Record<HaikuCall["status"], { label: string; cls: string }> = {
  queued: { label: t("wartet"), cls: "bg-a-p3 text-a-mut" },
  running: { label: t("läuft"), cls: "bg-a-ok/10 text-a-ok" },
  ok: { label: t("ok"), cls: "bg-a-ok/10 text-a-ok" },
  error: { label: t("Fehler"), cls: "bg-a-bad/10 text-a-bad" },
  timeout: { label: t("Zeitlimit"), cls: "bg-a-wait/10 text-a-wait" },
  budget: { label: t("Budget"), cls: "bg-a-wait/10 text-a-wait" },
  cancelled: { label: t("abgebrochen"), cls: "bg-a-p3 text-a-mut" },
};

export function formatDuration(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < 1000) return `${ms} ms`;
  const secs = (ms / 1000).toFixed(1);
  return `${getLang() === "en" ? secs : secs.replace(".", ",")} s`;
}

/** Vorschau der Test-Antwort – ohne Markdown-Zeichen, gekürzt nur an einer Wortgrenze und dann mit „…“. */
export function answerPreview(text: string, max = 160): string {
  const plain = text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?–-]+$/, "")}…`;
}

function toPatch(draft: Draft, current: HaikuSettings): { patch: HaikuSettingsPatch; invalid: boolean } {
  const patch: HaikuSettingsPatch = {};
  let invalid = false;
  if (draft.engine && draft.engine !== current.engine) patch.engine = draft.engine;
  for (const f of NUM_FIELDS) {
    const raw = draft[f.key];
    if (raw === undefined) continue;
    const n = Number(raw.replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(n) || n < f.min || n > f.max) {
      invalid = true;
      continue;
    }
    const value = f.key === "dailyBudgetUsd" ? n : Math.round(n);
    if (value !== current[f.key]) patch[f.key] = value;
  }
  for (const f of TIME_FIELDS) {
    const raw = draft[f.key];
    if (raw === undefined) continue;
    if (!/^\d{2}:\d{2}$/.test(raw)) invalid = true;
    else if (raw !== current[f.key]) patch[f.key] = raw;
  }
  return { patch, invalid };
}

export function HaikuSettingsPanel() {
  const qc = useQueryClient();
  const status = useHaikuStatus();
  const calls = useQuery({ queryKey: ["haiku", "calls"], queryFn: () => fetchHaikuCalls(50) });
  const [draft, setDraft] = useState<Draft>({});

  const save = useMutation({
    mutationFn: (patch: HaikuSettingsPatch) => patchHaikuSettings(patch),
    onSuccess: (next) => {
      qc.setQueryData(["haiku", "status"], next);
      setDraft({});
    },
  });

  const selftest = useMutation({
    mutationFn: runHaikuSelftest,
    onSettled: () => void qc.invalidateQueries({ queryKey: ["haiku"] }),
  });

  const s = status.data;
  const { patch, invalid } = s ? toPatch(draft, s.settings) : { patch: {}, invalid: false };
  const dirty = Object.keys(patch).length > 0;

  return (
    <div className="grid w-full min-w-0 content-start gap-4 p-4 md:p-6">
      <header className="grid gap-1">
        <h1 className="font-display text-title2 font-bold text-a-ink">Nyx</h1>
        <p className="text-callout text-a-mut">{t("Motor, Budget und Zeiten für Briefing, Recap und Rundgang.")}</p>
      </header>

      {status.isLoading && <div className="h-[180px] animate-pulse rounded-xl bg-a-p2 motion-reduce:animate-none" />}
      {status.isError && <ErrorBox text={t("Nyx-Status konnte nicht geladen werden.")} onRetry={() => void status.refetch()} />}

      {s && <UsageCard status={s} />}

      {s && (
        <form
          className="cc-card grid min-w-0 gap-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !invalid) save.mutate(patch);
          }}
        >
          <fieldset className="grid min-w-0 gap-2">
            <legend className={cn(LABEL, "mb-1")}>{t("Motor")}</legend>
            {ENGINE_OPTIONS.map((opt) => {
              const disabled = opt.kind === "api" && !s.reserve.configured;
              const checked = (draft.engine ?? s.settings.engine) === opt.kind;
              return (
                <label
                  key={opt.kind}
                  className={cn(
                    "flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors duration-150",
                    checked ? "border-a-acc/50 bg-a-acc/5" : "border-a-line bg-a-p2",
                    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-a-dim",
                  )}
                >
                  <input type="radio" name="engine" value={opt.kind} checked={checked} disabled={disabled} onChange={() => setDraft((d) => ({ ...d, engine: opt.kind }))} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-callout text-a-ink">{opt.label}</span>
                    <span className="block text-caption text-a-mut">
                      {disabled ? t("kein Schlüssel hinterlegt") : opt.kind === "api" && s.reserve.model ? `${opt.hint} · ${s.reserve.model}` : opt.hint}
                    </span>
                  </span>
                </label>
              );
            })}
            {/* Ehrlicher Zustand des GESPEICHERTEN Motors (bereit · wartet auf Token · aus · Fehler). */}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-caption text-a-mut">{t("Zustand:")}</span>
              <EngineStateLine status={s} className="text-caption" />
              {s.settings.engine !== "off" && (
                <button
                  type="button"
                  onClick={() => selftest.mutate()}
                  disabled={selftest.isPending}
                  className="ml-auto rounded-md border border-a-line bg-a-p3 px-2.5 py-1 text-caption text-a-ink hover:border-a-acc/60 disabled:opacity-50"
                >
                  {selftest.isPending ? t("Testet …") : t("Motor testen")}
                </button>
              )}
            </div>
            {selftest.data && (
              <p role="status" className={cn("text-caption leading-snug", selftest.data.ok ? "text-a-ok" : "text-a-wait")}>
                {selftest.data.ok
                  ? t("Antwort nach {duration}: „{text}“", { duration: formatDuration(selftest.data.ms), text: answerPreview(selftest.data.text ?? "") })
                  : t("Keine Antwort: {reason}", { reason: selftest.data.reason ?? t("unbekannter Grund") })}
              </p>
            )}
            {selftest.isError && <p className="text-caption text-a-bad">{t("Test nicht möglich: {error}", { error: friendlyError(selftest.error) })}</p>}
            <EngineNotice status={s} where="settings" onRetry={() => void status.refetch()} />
          </fieldset>

          {s.settings.engine === "claude-cli" && (
            <p className="text-caption leading-snug text-a-mut">
              {t("Beim Max-Plan kostet Nyx nichts extra. Die Tagesgrenze ist nur eine Bremse, falls Nyx sich festläuft – gerechnet im Gegenwert, den dieselben Aufrufe über die API kosten würden.")}
            </p>
          )}
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            {NUM_FIELDS.map((f) => (
              <label key={f.key} className="grid min-w-0 gap-1">
                <span className={LABEL}>{f.label}</span>
                <input
                  className={cn(FIELD, "font-mono tabular-nums")}
                  type="number"
                  inputMode="decimal"
                  step={f.step}
                  min={f.min}
                  max={f.max}
                  value={draft[f.key] ?? String(s.settings[f.key])}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </label>
            ))}
            {TIME_FIELDS.map((f) => (
              <label key={f.key} className="grid min-w-0 gap-1">
                <span className={LABEL}>{f.label}</span>
                <input
                  className={cn(FIELD, "font-mono")}
                  type="time"
                  value={draft[f.key] ?? s.settings[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </label>
            ))}
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!dirty || invalid || save.isPending}
              className="rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 font-mono text-caption text-a-acc disabled:opacity-40"
            >
              {save.isPending ? t("Speichert …") : t("Speichern")}
            </button>
            {invalid && <span className="text-caption text-a-wait">{t("Ein Wert liegt außerhalb des erlaubten Bereichs.")}</span>}
            {save.isError && <span className="text-caption text-a-bad">{t("Nicht gespeichert: {error}", { error: friendlyError(save.error) })}</span>}
            {save.isSuccess && !dirty && <span className="text-caption text-a-ok">{t("Gespeichert.")}</span>}
          </div>
        </form>
      )}

      <section aria-label={t("Letzte Aufrufe")} className="cc-card grid min-w-0 gap-2 p-4">
        <h2 className="font-display text-headline font-semibold text-a-ink">{t("Letzte Aufrufe")}</h2>
        {calls.isLoading && <div className="h-[120px] animate-pulse rounded-lg bg-a-p2 motion-reduce:animate-none" />}
        {calls.isError && <ErrorBox text={t("Aufrufe konnten nicht geladen werden.")} onRetry={() => void calls.refetch()} />}
        {calls.isSuccess && calls.data.length === 0 && <p className="text-caption text-a-mut">{t("Noch keine Aufrufe.")}</p>}
        {calls.isSuccess && calls.data.length > 0 && (
          <ul className="grid min-w-0 gap-0.5">
            {calls.data.map((c, i) => (
              <li
                key={c.id}
                className="cc-rise grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg px-2.5 py-1.5 hover:bg-a-p2 sm:grid-cols-[minmax(0,1.2fr)_repeat(4,auto)]"
                style={riseStyle(i)}
                title={c.error ?? undefined}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-callout text-a-ink">{CALL_KIND[c.kind] ?? c.kind}</span>
                  <span className={cn("shrink-0 rounded-full px-1.5 py-px font-mono text-label", CALL_STATUS[c.status]?.cls)}>{CALL_STATUS[c.status]?.label ?? c.status}</span>
                </span>
                <span className="font-mono text-caption tabular-nums text-a-mut" title={formatDateTime(c.createdAt)}>
                  {relativeTime(c.createdAt)}
                </span>
                <span className="font-mono text-caption tabular-nums text-a-mut">{formatDuration(c.durationMs)}</span>
                <span className="font-mono text-caption tabular-nums text-a-mut">
                  {formatTokensCompact(c.inputTokens)} → {formatTokensCompact(c.outputTokens)}
                </span>
                <span className="font-mono text-caption tabular-nums text-a-ink">{formatUsd(c.costUsd)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;

function UsageCard({ status }: { status: HaikuStatus }) {
  const { today } = status;
  const budget = today.budgetUsd;
  const ratio = budget > 0 ? today.costUsd / budget : 0;
  const pct = Math.round(ratio * 100);
  // Max-Plan = kein Aufpreis → keine Warnfarbe unterwegs, nur wenn die Grenze wirklich erreicht ist
  // (dann pausiert Haiku bis morgen). Die Reserve-API kostet echtes Geld → dort bleibt die Warnung ab 80 %.
  const maxPlan = status.settings.engine === "claude-cli";
  const color = ratio >= 1 ? (maxPlan ? "var(--a-wait)" : "var(--a-bad)") : !maxPlan && ratio >= 0.8 ? "var(--a-wait)" : "var(--a-acc)";
  const dash = Math.min(1, ratio) * RING_C;

  return (
    <section aria-label={t("Verbrauch heute")} className="cc-card grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-5 p-4">
      <svg
        viewBox="0 0 88 88"
        className="h-[104px] w-[104px]"
        role="img"
        aria-label={
          maxPlan
            ? t("{pct} % der Tagesgrenze (Gegenwert {cost} von {budget}, beim Max-Plan kein Aufpreis)", { pct, cost: formatUsd(today.costUsd), budget: formatUsd(budget) })
            : t("{pct} % des Tages-Budgets verbraucht ({cost} von {budget})", { pct, cost: formatUsd(today.costUsd), budget: formatUsd(budget) })
        }
      >
        <circle cx="44" cy="44" r={RING_R} fill="none" stroke="var(--a-p3)" strokeWidth="8" />
        <circle
          cx="44"
          cy="44"
          r={RING_R}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${RING_C}`}
          transform="rotate(-90 44 44)"
          className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-500"
        />
        <text x="44" y="44" textAnchor="middle" dominantBaseline="central" className="fill-a-ink font-display text-title2 font-bold tabular-nums">
          {pct} %
        </text>
      </svg>
      <div className="grid min-w-0 gap-1.5">
        <h2 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Verbrauch heute")}</h2>
        {maxPlan ? (
          <>
            <p className="font-display text-title2 font-bold leading-none text-a-ink">{t("Max-Plan: kein Aufpreis")}</p>
            <p className="text-caption tabular-nums text-a-mut">
              {t("Gegenwert ca. {cost} · Tagesgrenze {budget}", { cost: formatUsd(today.costUsd), budget: formatUsd(budget) })}
              {ratio >= 1 && <span className="text-a-wait"> · {t("erreicht, Nyx pausiert bis morgen")}</span>}
            </p>
          </>
        ) : (
          <p className="font-display text-[26px] font-bold leading-none tabular-nums text-a-ink">
            {formatUsd(today.costUsd)} <span className="text-callout font-medium text-a-mut">{t("von {budget}", { budget: formatUsd(budget) })}</span>
          </p>
        )}
        <p className="font-mono text-caption text-a-mut">
          {t("{calls} Aufrufe · {input} rein · {output} raus", { calls: today.calls, input: formatTokensCompact(today.inputTokens), output: formatTokensCompact(today.outputTokens) })}
          {status.queue.running + status.queue.waiting > 0 && ` · ${t("{running} läuft, {waiting} wartet", { running: status.queue.running, waiting: status.queue.waiting })}`}
        </p>
        {status.lastRundgang && (
          <p className="font-mono text-caption text-a-mut">
            {t("Letzter Rundgang {when} · {n} Funde", { when: relativeTime(status.lastRundgang.at), n: status.lastRundgang.findings })}
            {status.lastRundgang.calledHaiku ? ` · ${t("mit Nyx")}` : ""}
          </p>
        )}
      </div>
    </section>
  );
}
