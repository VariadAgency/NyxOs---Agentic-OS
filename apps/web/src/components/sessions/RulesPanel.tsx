import { t, locale, timeZone } from "@nyxos/shared";
import { useSetSortRuleActive, useSortRules } from "../../hooks/useSessionApi";
import { artLabel } from "../../lib/arts";
import { describeRuleCondition } from "../../lib/ruleCondition";
import { Button } from "../ui/button";

interface RulesPanelProps {
  open: boolean;
  onClose: () => void;
  onToast: (message: string) => void;
}

/**
 * Regeln-Bereich: Liste aller `sort_rules` mit Bedingung, Ziel,
 * Herkunft, Erstellt und einem Schalter aktiv/aus — nach dem Abschalten sortiert der Server sofort
 * neu, der Toast meldet, wie viele Sessions betroffen waren.
 */
export function RulesPanel({ open, onClose, onToast }: RulesPanelProps) {
  const rulesQuery = useSortRules(open);
  const toggleMutation = useSetSortRuleActive();
  if (!open) return null;
  const rules = [...(rulesQuery.data?.rules ?? [])].sort((a, b) => b.id - a.id);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center cc-scrim cc-sheet-wrap p-4" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-panel-title"
        className="cc-sheet grid max-h-[80vh] w-full max-w-lg gap-3 overflow-y-auto rounded-2xl border border-a-line bg-a-p2 p-4 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="rules-panel-title" className="font-display text-callout font-semibold text-a-ink">
            {t("Regeln")}
          </h2>
          <Button variant="ghost" onClick={onClose}>
            {t("Schließen")}
          </Button>
        </div>

        {rulesQuery.isPending && <p className="text-caption text-a-mut">{t("Lädt …")}</p>}
        {rulesQuery.isError && (
          <div className="grid justify-items-start gap-2 text-caption">
            <p className="text-a-bad">{t("Regeln konnten nicht geladen werden.")}</p>
            <Button onClick={() => rulesQuery.refetch()}>{t("Erneut versuchen")}</Button>
          </div>
        )}
        {!rulesQuery.isPending && !rulesQuery.isError && rules.length === 0 && (
          <p className="text-caption text-a-mut">{t("Noch keine Regeln — sie entstehen automatisch, sobald du eine Session per Ziehen korrigierst.")}</p>
        )}

        <ul className="grid gap-2">
          {rules.map((r) => (
            <li key={r.id} className="grid gap-1 rounded-md border border-a-line bg-a-p2 p-2.5 text-caption">
              <div className="flex items-start justify-between gap-2">
                <span className="text-a-ink">{describeRuleCondition(r.condition)}</span>
                <label className="flex shrink-0 items-center gap-1.5 text-a-mut">
                  <input
                    type="checkbox"
                    checked={r.active}
                    disabled={toggleMutation.isPending}
                    onChange={(e) => {
                      const active = e.target.checked;
                      toggleMutation.mutate(
                        { id: r.id, active },
                        {
                          onSuccess: (res) =>
                            onToast(t(res.resorted.length === 1 ? "{n} Session neu einsortiert" : "{n} Sessions neu einsortiert", { n: res.resorted.length })),
                        },
                      );
                    }}
                  />
                  {t("aktiv")}
                </label>
              </div>
              <div className="text-a-mut">
                → {r.dimension === "art" ? t("Art: {label}", { label: artLabel(r.targetArt ?? "unsortiert") }) : t("Baustelle: {label}", { label: r.targetBaustelleLabel ?? t("Ohne Baustelle") })}
              </div>
              <div className="font-mono text-label text-a-mut">
                {r.origin} · {t("erstellt {date}", { date: new Date(r.createdAt).toLocaleDateString(locale(), { timeZone: timeZone() }) })}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
