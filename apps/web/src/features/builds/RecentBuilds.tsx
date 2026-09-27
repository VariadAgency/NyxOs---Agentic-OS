// Build-Wächter — kleine Liste „Letzte Builds" für Server/Überblick. Zeigt die letzten Läufe
// insgesamt, unabhängig von der Session.
// Gleiche Fehler = ein Eintrag mit Zähler („4× seit 09:12“); oben ein Satz, die Rohmeldung
// nur zugeklappt unter „Details“; „nicht eingerichtet“ ist gelb, nicht rot.
import { BUILD_KIND_LABEL, formatBuildCount, t, type BuildStatus } from "@nyxos/shared";
import { relativeTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { RawDetails } from "./RawDetails";
import { useBuildGroups } from "./useBuilds";

const STATUS_DOT: Record<BuildStatus, string> = {
  queued: "bg-a-dim",
  running: "bg-a-wait animate-pulse motion-reduce:animate-none",
  green: "bg-a-ok",
  red: "bg-a-bad",
  unavailable: "bg-a-wait",
};
const STATUS_LABEL: Record<BuildStatus, string> = { queued: t("wartet"), running: t("baut …"), green: t("grün"), red: t("rot"), unavailable: t("nicht eingerichtet") };
const STATUS_TEXT: Record<BuildStatus, string> = { queued: "text-a-mut", running: "text-a-wait", green: "text-a-ok", red: "text-a-bad", unavailable: "text-a-wait" };

export function RecentBuilds() {
  const { data, isLoading, isError } = useBuildGroups();
  const groups = (data ?? []).slice(0, 8);

  if (isLoading) return <p className="text-callout text-a-mut">{t("Lädt …")}</p>;
  if (isError) return <p className="text-callout text-a-mut">{t("Build-Läufe konnten nicht geladen werden.")}</p>;
  if (groups.length === 0) return <p className="text-callout text-a-mut">{t("Noch kein Build ausgelöst — läuft automatisch nach jeder Session (Stop-Hook) oder auf Knopfdruck.")}</p>;

  return (
    <div className="grid gap-1">
      {groups.map((g) => {
        const needsWords = g.state === "red" || g.state === "unavailable";
        return (
          <div key={g.key} className="grid min-w-0 gap-0.5 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-a-p2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-callout">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[g.state])} aria-hidden />
              <span className="text-a-ink">{BUILD_KIND_LABEL[g.kind] ?? g.kind}</span>
              <span className={STATUS_TEXT[g.state]}>{STATUS_LABEL[g.state]}</span>
              <span className="ml-auto flex items-center gap-2 font-mono text-label text-a-mut">
                <span className={cn(g.count > 1 && "rounded-full bg-a-p3 px-1.5 text-a-ink")}>{formatBuildCount(g)}</span>
                <span>{relativeTime(g.lastAt) ?? "–"}</span>
              </span>
            </div>
            {needsWords && <p className="pl-3.5 text-caption leading-snug text-a-mut">{g.sentence}</p>}
            {needsWords && g.details && <RawDetails text={g.details} className="pl-3.5" />}
          </div>
        );
      })}
    </div>
  );
}
