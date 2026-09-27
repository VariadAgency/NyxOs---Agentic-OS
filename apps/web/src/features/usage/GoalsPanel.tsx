// Ziele mit Fortschrittsring und ehrlicher Hochrechnung („schaffst du bis Monatsende: ja/nein,
// ca. X“) plus Stand der Warnschwellen. Rechnung auf dem Server (usage/goals.ts), hier nur Anzeige.
import { RingMeter, formatDayShort } from "../../components/charts";
import { Skeleton } from "../../components/ui/skeleton";
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";
import type { GoalStatus, GoalsResponse } from "./api";
import { formatTokensCompact } from "./format";
import { Panel, TOOL_NAME } from "./parts";

const SCOPE_LABEL = { all: t("Claude und Codex zusammen"), claude: t("nur Claude"), codex: t("nur Codex") } as const;

function GoalCard({ g }: { g: GoalStatus }) {
  const name = g.kind === "month" ? t("Monatsziel") : t("Wochenziel");
  const until = formatDayShort(g.lastDay);
  const reached = g.soFar >= g.target;
  const tone = reached || g.onTrack ? "var(--a-ok)" : "var(--a-wait)";
  return (
    <div data-goal={g.kind} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4 rounded-lg border border-a-line/70 bg-a-bg/30 p-3">
      <RingMeter pct={Math.min(100, g.pct)} color={tone} sub={name} ariaLabel={name} size={104} />
      <div className="grid min-w-0 gap-1.5">
        <span className="font-display text-title2 font-semibold leading-tight tabular-nums text-a-ink">
          {t("{a} von {b}", { a: formatTokensCompact(g.soFar), b: formatTokensCompact(g.target) })}
        </span>
        {reached ? (
          <span className="w-fit rounded-full bg-a-ok/12 px-2 py-0.5 text-caption font-medium text-a-ok">{t("Geschafft · {pct} %", { pct: Math.round(g.pct) })}</span>
        ) : (
          <span className={cn("w-fit rounded-full px-2 py-0.5 text-caption font-medium", g.onTrack ? "bg-a-ok/12 text-a-ok" : "bg-a-wait/12 text-a-wait")}>
            {g.onTrack
              ? t("Hochrechnung: schaffst du bis {until} (ca. {n})", { until, n: formatTokensCompact(g.projected) })
              : t("Hochrechnung: schaffst du bis {until} eher nicht (ca. {n})", { until, n: formatTokensCompact(g.projected) })}
          </span>
        )}
        <span className="text-caption text-a-mut">
          {reached
            ? t("Ziel am {day} erreicht.", { day: g.reachDay ? formatDayShort(g.reachDay) : "—" })
            : g.neededPerDay === null
              ? t("Zeitraum ist vorbei.")
              : `${t("Dafür nötig: {need} je Tag · zuletzt {pace} je Tag", { need: formatTokensCompact(g.neededPerDay), pace: formatTokensCompact(g.pacePerDay) })}${g.onTrack && g.reachDay ? ` · ${t("erreicht etwa am {day}", { day: formatDayShort(g.reachDay) })}` : ""}`}
        </span>
      </div>
    </div>
  );
}

export function GoalsPanel({ data, onEdit }: { data: GoalsResponse | undefined; onEdit: () => void }) {
  if (!data) {
    return (
      <Panel title={t("Ziele")}>
        <Skeleton className="h-[120px] rounded-lg" />
      </Panel>
    );
  }
  const goals = [data.month, data.week].filter((g): g is GoalStatus => g !== null);
  const { daily, window } = data.warnings;
  if (goals.length === 0 && !daily && !window) {
    return (
      <Panel title={t("Ziele")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-callout text-a-mut">{t("Noch kein Ziel und keine Warnschwelle. Zum Beispiel „10 Mrd. Tokens im Monat“ oder „warnen bei 80 % des 5-Std-Fensters“.")}</p>
          <button type="button" onClick={onEdit} className="rounded-md border border-a-acc/50 px-3 py-1.5 text-caption font-medium text-a-ink hover:bg-a-p2">
            {t("Ziel setzen")}
          </button>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title={t("Ziele")} sub={goals.length > 0 ? t("{scope} · Hochrechnung nach dem Tempo der letzten 7 Tage", { scope: SCOPE_LABEL[data.scope] }) : undefined}>
      {goals.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
          {goals.map((g) => (
            <GoalCard key={g.kind} g={g} />
          ))}
        </div>
      )}
      {(daily || window) && (
        <div className="grid gap-1.5 text-caption" data-warnings>
          {daily && (
            <p className={daily.over ? "text-a-wait" : "text-a-mut"}>
              {daily.over ? "⚠ " : ""}
              {t("Heute {n} Tokens · Warnung ab {limit}", { n: formatTokensCompact(daily.today), limit: formatTokensCompact(daily.threshold) })}
            </p>
          )}
          {window && (
            <p className={window.tools.some((w) => w.over) ? "text-a-wait" : "text-a-mut"}>
              {window.tools.some((w) => w.over) ? "⚠ " : ""}
              {t("5-Std-Fenster:")}{" "}
              {window.tools.map((w) => `${TOOL_NAME[w.tool]} ${w.pct === null ? "—" : `${Math.round(w.pct)} %`}${w.reported || w.pct === null ? "" : ` ${t("(eigene Spitze)")}`}`).join(" · ")} · {t("Warnung ab {pct} %", { pct: window.threshold })}
            </p>
          )}
          <p className="text-a-mut">{t("Warnungen kommen als Push aufs Handy, sobald Push eingerichtet und „Nutzung über Warnschwelle“ an ist (Einstellungen → Push).")}</p>
        </div>
      )}
    </Panel>
  );
}
