// Kontext-Wächter — Kopf-Badge im Session-Vollbild (`SessionFullscreen.tsx`): Ring/Kreis für den
// Kontext-Anteil (Farbe nach Schwelle), Badge + "Jetzt komprimieren" bei Hinweis, Menü
// "Schwellen für diese Session".
import { CONTEXT_GUARD_DEFAULT, t } from "@nyxos/shared";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { contextRingTitle } from "../../components/sessions/ContextRing";
import { Button } from "../../components/ui/button";
import { useCompactNow, useContextGuardSession, useDeleteSessionThresholds, useSaveSessionThresholds } from "./api";
import { DualRangeSlider } from "./DualRangeSlider";

function ringColor(pct: number, hinweisPct: number, erzwingenPct: number | null): string {
  if (erzwingenPct !== null && pct >= erzwingenPct) return "var(--a-bad)";
  if (pct >= hinweisPct) return "var(--a-wait)";
  return "var(--a-ok)";
}

/** `compact` = einzeilige Kopfleiste — der Hinweis „Komprimieren empfohlen“ steht dann als
 * Ring-Markierung + Hinweistext am Ring, der Knopf dazu ist „Kontext komprimieren“ (Session-Infos → Steuerung). */
export function ContextGuardBadge({ sessionId, compact = false, contextWindow = null, at = null }: { sessionId: string; compact?: boolean; contextWindow?: number | null; at?: string | null }) {
  const { data } = useContextGuardSession(sessionId);
  const compactNow = useCompactNow(sessionId);
  const saveSession = useSaveSessionThresholds(sessionId);
  const deleteSession = useDeleteSessionThresholds(sessionId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(CONTEXT_GUARD_DEFAULT);

  if (!data) return null;
  const { thresholds, pct, hint, attachable } = data;
  const color = pct === null ? "var(--a-dim)" : ringColor(pct, thresholds.hinweisPct, thresholds.erzwingenPct);

  return (
    <div className="relative flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setDraft({ hinweisPct: thresholds.hinweisPct, erzwingenEnabled: thresholds.erzwingenEnabled, erzwingenPct: thresholds.erzwingenPct });
          setMenuOpen((v) => !v);
        }}
        // Derselbe einfache Satz wie am Ring der Session-Infos, ohne Technik-Quelle.
        title={`${contextRingTitle({ pct, window: contextWindow, at })}${compact && hint && pct !== null ? ` – ${t("Komprimieren empfohlen")}` : ""} · ${t("Klick: Schwellen für diese Session")}`}
        // typo-keep: Zahl im 18-px-Ring (wächst nicht mit)
        className={cn("cc-ring cc-hit grid h-6 w-6 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-a-ink", compact && hint && "ring-2 ring-a-wait/60 ring-offset-1 ring-offset-a-p")}
        style={{ background: `conic-gradient(${color} ${(pct ?? 0) * 3.6}deg, var(--a-p3) 0deg)` }}
        aria-label={t("Kontext-Wächter — Schwellen für diese Session")}
      >
        <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-a-p">{pct ?? "–"}</span>
      </button>

      {hint && pct !== null && !compact && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-a-line bg-a-p2 px-2 py-0.5 text-label text-a-wait">
          {t("Kontext {pct}% – Komprimieren empfohlen", { pct })}
          <Button
            variant="ghost"
            className="h-auto px-1 py-0 text-label text-a-wait"
            disabled={!attachable || compactNow.isPending || compactNow.data?.queued === true}
            onClick={() => compactNow.mutate()}
            title={attachable ? (compactNow.data?.queued ? compactNow.data.reason : undefined) : t("Läuft in einem eigenen Fenster auf deinem Rechner – erst in NyxOS übernehmen")}
          >
            {/* Nie blind tippen — arbeitet die Session, wartet /compact auf ihre nächste Pause. */}
            {compactNow.data?.queued ? t("Kommt, sobald sie wartet") : t("Jetzt komprimieren")}
          </Button>
        </span>
      )}

      {menuOpen && (
        <div className="cc-pop-sheet absolute top-8 left-0 z-10 grid w-72 gap-2 rounded-lg border border-a-line bg-a-p p-3 shadow-lg">
          <div className="flex items-center justify-between">
            <h4 className="text-caption font-medium text-a-ink">{t("Schwellen für diese Session")}</h4>
            <span className={cn("font-mono text-label text-a-mut")}>{t("Quelle: {source}", { source: thresholds.source })}</span>
          </div>
          <DualRangeSlider
            hinweisPct={draft.hinweisPct}
            erzwingenPct={draft.erzwingenPct}
            erzwingenEnabled={draft.erzwingenEnabled}
            onChange={({ hinweisPct, erzwingenPct }) => setDraft((d) => ({ ...d, hinweisPct, erzwingenPct }))}
          />
          <label className="flex items-center gap-1.5 text-label text-a-mut">
            <input type="checkbox" checked={draft.erzwingenEnabled} onChange={(e) => setDraft((d) => ({ ...d, erzwingenEnabled: e.target.checked }))} />
            {t("Erzwingen aktiv")}
          </label>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={saveSession.isPending}
              onClick={() => {
                saveSession.mutate(draft);
                setMenuOpen(false);
              }}
            >
              {t("Für diese Session speichern")}
            </Button>
            {thresholds.source === "session" && (
              <Button
                variant="ghost"
                disabled={deleteSession.isPending}
                onClick={() => {
                  deleteSession.mutate();
                  setMenuOpen(false);
                }}
              >
                {t("Zurücksetzen")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
