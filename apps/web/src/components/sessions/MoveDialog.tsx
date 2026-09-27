import { t } from "@nyxos/shared";
import { useEffect, useState } from "react";
import { usePreviewAssign } from "../../hooks/useSessionApi";
import type { AssignTarget, RuleDimension } from "../../lib/api";
import { Button } from "../ui/button";

export interface PendingMove {
  sessionId: string;
  sessionTitle: string;
  /** Welche Dimension(en) korrigiert werden — Ziehen auf einen ART-Tab setzt nur "art", Ziehen auf
   * einen BAUSTELLEN-Tab nur "baustelle" ("getrennte Dimensionen"). */
  dims: RuleDimension[];
  art?: string;
  artLabel?: string;
  baustelle?: { slug: string; label: string } | null;
}

interface MoveDialogProps {
  move: PendingMove | null;
  onConfirm: (asRule: boolean) => void;
  onCancel: () => void;
  pending?: boolean;
}

function targetLabel(move: PendingMove): string {
  const parts: string[] = [];
  if (move.dims.includes("art") && move.artLabel) parts.push(move.artLabel);
  if (move.dims.includes("baustelle")) parts.push(move.baustelle?.label ?? t("Ohne Baustelle"));
  return parts.join(" → ") || "…";
}

function assignTargetFor(move: PendingMove): AssignTarget {
  const target: AssignTarget = {};
  if (move.dims.includes("art")) target.art = move.art;
  if (move.dims.includes("baustelle")) target.baustelle = move.baustelle ?? null;
  return target;
}

/**
 * Bestätigung nach Ziehen bzw. „Verschieben nach…“ (Vorschau vor dem Speichern). Zeigt die Bedingung, die eine Regel bekäme, je korrigierter Dimension getrennt, plus
 * wie viele andere Sessions betroffen wären — und lässt den Nutzer ehrlich zwischen „Als Regel
 * speichern“ und „Nur diese Session“ wählen, statt immer stillschweigend eine Regel anzulegen.
 */
export function MoveDialog({ move, onConfirm, onCancel, pending }: MoveDialogProps) {
  const previewMutation = usePreviewAssign();
  const [asRule, setAsRule] = useState(true);
  const [showAffected, setShowAffected] = useState(false);

  useEffect(() => {
    if (!move) return;
    setAsRule(true);
    setShowAffected(false);
    previewMutation.mutate({ id: move.sessionId, target: assignTargetFor(move) });
    // Absichtlich nur diese Felder: `previewMutation` (Mutation-Objekt) würde bei jedem Render eine
    // neue Referenz haben und den Effekt endlos neu auslösen.
  }, [move?.sessionId, move?.art, move?.baustelle?.slug, move?.dims.join(",")]);

  if (!move) return null;
  const preview = previewMutation.data;
  const dims = move.dims.map((dim) => ({ dim, result: dim === "art" ? preview?.art : preview?.baustelle }));
  const anyConditionPossible = dims.some(({ result }) => result?.condition);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center cc-scrim p-4" role="presentation" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="move-dialog-title"
        className="grid w-full max-w-md gap-3 rounded-2xl border border-a-line bg-a-p2 p-4 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="move-dialog-title" className="font-display text-callout font-semibold text-a-ink">
          {t("Session nach {target} verschieben?", { target: targetLabel(move) })}
        </h2>
        <p className="text-caption text-a-mut">{t("„{title}“ wird zugeordnet.", { title: move.sessionTitle })}</p>

        {previewMutation.isPending && <p className="text-caption text-a-mut">{t("Prüfe Bedingung …")}</p>}
        {previewMutation.isError && <p className="text-caption text-a-bad">{t("Vorschau fehlgeschlagen — „Verschieben“ ordnet trotzdem nur diese Session zu.")}</p>}

        {preview &&
          dims.map(({ dim, result }) =>
            result ? (
              <div key={dim} className="rounded-md border border-a-line bg-a-p2 p-2 text-caption">
                {result.condition ? <p className="text-a-ink">{t("Bedingung: {text}", { text: result.condition.text })}</p> : <p className="text-a-mut">{result.reason}</p>}
              </div>
            ) : null,
          )}

        {preview && (
          <label className="flex items-center gap-2 text-caption text-a-mut">
            <input type="checkbox" checked={asRule} disabled={!anyConditionPossible} onChange={(e) => setAsRule(e.target.checked)} />
            {t("Als Regel speichern (ähnliche Sessions sortieren sich künftig automatisch dorthin)")}
          </label>
        )}

        {preview && asRule && preview.affectedCount > 0 && (
          <div className="rounded-md border border-a-line bg-a-p2 p-2 text-caption">
            <button type="button" className="text-a-acc underline" onClick={() => setShowAffected((v) => !v)}>
              {t(preview.affectedCount === 1 ? "betrifft {n} weitere Session" : "betrifft {n} weitere Sessions", { n: preview.affectedCount })}
            </button>
            {showAffected && (
              <ul className="mt-1.5 grid gap-1 text-a-mut">
                {preview.affected.map((a) => (
                  <li key={a.sessionId}>
                    {a.title ?? a.sessionId}: {a.fromArt} → {a.toArt}
                    {a.toBaustelle ? ` (${a.toBaustelle.label})` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {t("Abbrechen")}
          </Button>
          <Button variant="primary" onClick={() => onConfirm(asRule && anyConditionPossible)} disabled={pending || previewMutation.isPending}>
            {pending ? t("Verschiebe …") : asRule && anyConditionPossible ? t("Als Regel speichern") : t("Nur diese Session")}
          </Button>
        </div>
      </div>
    </div>
  );
}
