// Kontext-Wächter — Einstellungen-Abschnitt (Einbindung in `features/settings/Settings.tsx`).
// Standard + Haiku (fest, immer da) + Modell-Überschreibungen (Liste,
// hinzufügen/entfernen). Session-Überschreibungen passieren im Vollbild-Kopf (`ContextGuardBadge.tsx`),
// nicht hier — "einstellbar für jede Session" gehört dorthin, wo die Session ist.
import { CONTEXT_GUARD_DEFAULT, t, type ContextGuardThresholdsInput } from "@nyxos/shared";
import { useState } from "react";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { DualRangeSlider } from "./DualRangeSlider";
import { useContextGuardSettings, useDeleteModelThresholds, useSaveDefaultThresholds, useSaveHaikuThresholds, useSaveModelThresholds } from "./api";

function ThresholdsEditor({
  value,
  onSave,
  saving,
}: {
  value: ContextGuardThresholdsInput;
  onSave: (next: ContextGuardThresholdsInput) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = draft.hinweisPct !== value.hinweisPct || draft.erzwingenEnabled !== value.erzwingenEnabled || draft.erzwingenPct !== value.erzwingenPct;

  return (
    <div className="grid gap-2">
      <DualRangeSlider
        hinweisPct={draft.hinweisPct}
        erzwingenPct={draft.erzwingenPct}
        erzwingenEnabled={draft.erzwingenEnabled}
        onChange={({ hinweisPct, erzwingenPct }) => setDraft((d) => ({ ...d, hinweisPct, erzwingenPct }))}
      />
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-caption text-a-mut">
          <input
            type="checkbox"
            checked={draft.erzwingenEnabled}
            onChange={(e) => setDraft((d) => ({ ...d, erzwingenEnabled: e.target.checked, erzwingenPct: e.target.checked ? (d.erzwingenPct ?? Math.max(d.hinweisPct, 80)) : d.erzwingenPct }))}
          />
          {t("Erzwingen aktiv (NyxOS schickt selbst /compact)")}
        </label>
        <span className="flex-1" />
        <Button variant="primary" disabled={!dirty || saving} onClick={() => onSave(draft)}>
          {saving ? t("Speichere …") : t("Speichern")}
        </Button>
      </div>
    </div>
  );
}

export function ContextGuardSettings() {
  const { data, isLoading, isError, refetch } = useContextGuardSettings();
  const saveDefault = useSaveDefaultThresholds();
  const saveHaiku = useSaveHaikuThresholds();
  const saveModel = useSaveModelThresholds();
  const deleteModel = useDeleteModelThresholds();
  const [newModel, setNewModel] = useState("");
  const [newDraft, setNewDraft] = useState<ContextGuardThresholdsInput>(CONTEXT_GUARD_DEFAULT);

  return (
    <section className="grid gap-2">
      <SectionTitle>{t("Kontext-Wächter")}</SectionTitle>
      <p className="text-callout text-a-mut">
        {t("Ab wann eine Session komprimiert wird. Hinweis empfiehlt es dir; Erzwingen schickt /compact selbst, aber nur wenn die Session gerade wartet — nie mitten in einer Runde.")}
      </p>

      {isLoading && <Skeleton className="h-40 w-full" />}
      {isError && (
        <Button onClick={() => void refetch()} className="w-fit">
          {t("Erneut versuchen")}
        </Button>
      )}

      {data && (
        <div className="grid gap-3">
          <Card className="grid gap-2 p-3">
            <h3 className="text-callout font-medium text-a-ink">{t("Standard (alle Sessions, ohne eigene Regel)")}</h3>
            <ThresholdsEditor value={data.default} onSave={(v) => saveDefault.mutate(v)} saving={saveDefault.isPending} />
          </Card>

          <Card className="grid gap-2 p-3">
            <h3 className="text-callout font-medium text-a-ink">{t("Nyx (Werkzeug-intern)")}</h3>
            <ThresholdsEditor value={data.haiku} onSave={(v) => saveHaiku.mutate(v)} saving={saveHaiku.isPending} />
          </Card>

          <Card className="grid gap-2 p-3">
            <h3 className="text-callout font-medium text-a-ink">{t("Je Modell")}</h3>
            {data.models.length === 0 && <p className="text-caption text-a-mut">{t("Noch keine Modell-Regel — Standard gilt.")}</p>}
            <div className="grid gap-3">
              {data.models.map((m) => (
                <div key={m.model} className="grid gap-1.5 rounded-md border border-a-line p-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-caption text-a-ink">{m.model}</span>
                    <span className="flex-1" />
                    <Button variant="ghost" onClick={() => deleteModel.mutate(m.model)} disabled={deleteModel.isPending}>
                      {t("Entfernen")}
                    </Button>
                  </div>
                  <ThresholdsEditor value={m} onSave={(v) => saveModel.mutate({ model: m.model, input: v })} saving={saveModel.isPending} />
                </div>
              ))}
            </div>
            <div className="mt-1 grid gap-1.5 rounded-md border border-dashed border-a-line p-2">
              <div className="flex items-center gap-2">
                <input
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  placeholder={t("Modell-Name (z. B. opus, sonnet-5)")}
                  className="min-w-0 flex-1 rounded-md border border-a-line bg-a-p2 px-2 py-1 font-mono text-caption text-a-ink focus:border-a-acc focus:outline-none"
                />
              </div>
              <DualRangeSlider
                hinweisPct={newDraft.hinweisPct}
                erzwingenPct={newDraft.erzwingenPct}
                erzwingenEnabled={newDraft.erzwingenEnabled}
                onChange={({ hinweisPct, erzwingenPct }) => setNewDraft((d) => ({ ...d, hinweisPct, erzwingenPct }))}
              />
              <Button
                variant="primary"
                className="w-fit"
                disabled={!newModel.trim() || saveModel.isPending}
                onClick={() => {
                  saveModel.mutate({ model: newModel.trim(), input: newDraft });
                  setNewModel("");
                  setNewDraft(CONTEXT_GUARD_DEFAULT);
                }}
              >
                {t("+ Modell-Regel hinzufügen")}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </section>
  );
}
