// Lernbuch: every learned rule with its origin, each one can be switched off. Own subpage `/settings/lernbuch`
// (formerly at the bottom of the long settings page).
import { t } from "@nyxos/shared";
import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/skeleton";
import { useRules, useSetRuleActive } from "../../hooks/useRules";

const KIND_LABEL: Record<string, string> = { sortierung: t("Sortierung"), reservierung: t("Reservierung"), konflikt: t("Konflikt"), freigabe: t("Freigabe") };

export function LearnbookPanel() {
  const { data, isLoading, isError, refetch } = useRules();
  const setActive = useSetRuleActive();

  return (
    <section className="grid gap-2" aria-label={t("Lernbuch")}>
      {isLoading && <Skeleton className="h-40 w-full" />}
      {isError && (
        <button type="button" onClick={() => void refetch()} className="min-h-11 w-fit rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
          {t("Erneut versuchen")}
        </button>
      )}
      {data && (
        <Card className="grid gap-1 p-2">
          {data.rules.length === 0 && <p className="p-2 text-callout text-a-mut">{t("Noch keine gelernte Regel.")}</p>}
          {data.rules.map((rule) => (
            <div key={rule.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 text-callout hover:bg-a-p2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
              <span className="w-fit rounded-full bg-a-p3 px-2 py-0.5 text-label text-a-mut">{KIND_LABEL[rule.kind] ?? rule.kind}</span>
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <div className="truncate text-a-ink">{typeof rule.action.message === "string" ? rule.action.message : JSON.stringify(rule.action)}</div>
                <div className="truncate text-label text-a-mut">{rule.origin}</div>
              </div>
              <span className="font-mono text-label text-a-mut">{t("{n} Treffer", { n: rule.hitCount })}</span>
              <label className="flex min-h-11 items-center gap-1.5 text-caption text-a-mut sm:min-h-0">
                <input type="checkbox" checked={rule.active} onChange={(e) => void setActive.mutateAsync({ id: rule.id, active: e.target.checked })} />
                {t("aktiv")}
              </label>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}
