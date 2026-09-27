import { t } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import type { Baustelle, CategoryCount, RuleDimension } from "../../lib/api";
import { ART_ORDER, artLabel } from "../../lib/arts";
import { Button } from "../ui/button";
import { useTooltip } from "../ui/Tooltip";
import { IconMove } from "../../features/session-chat/icons";

interface MoveMenuProps {
  categories: CategoryCount[];
  /** Die aktuelle Art/Baustelle der Session — nur was sich gegenüber diesen Werten ändert, wird
   * korrigiert ("getrennte Dimensionen" gilt auch für die manuelle Auswahl, nicht nur fürs Ziehen). */
  currentArt: string;
  currentBaustelle: Baustelle | null;
  onPick: (dims: RuleDimension[], art: string, baustelle: Baustelle | null) => void;
  /** Nur Symbol + Hinweis — der Kopf misst selbst, wann der Platz fehlt. */
  compact?: boolean;
}

const NONE_VALUE = "__ohne__";

/** Tastatur-Alternative zum Ziehen: „Verschieben nach…“ mit Art- und Baustellen-Auswahl. */
export function MoveMenu({ categories, currentArt, currentBaustelle, onPick, compact = false }: MoveMenuProps) {
  const [open, setOpen] = useState(false);
  const arts = [...new Set([...ART_ORDER, ...categories.map((c) => c.art)])];
  const [art, setArt] = useState(currentArt);
  const baustellen = categories.find((c) => c.art === art)?.baustellen.filter((b) => b.slug) ?? [];
  const [baustelleValue, setBaustelleValue] = useState<string>(currentBaustelle?.slug ?? NONE_VALUE);
  const hint = useTooltip(open ? null : t("Verschieben nach … (andere Art oder Baustelle)"));
  const wrap = useRef<HTMLDivElement | null>(null);
  // Klick daneben oder Esc (egal wo der Fokus steht) schließt das schwebende Feld.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const chosen = baustelleValue === NONE_VALUE ? null : (baustellen.find((b) => b.slug === baustelleValue) ?? null);

  // Knopf bleibt in der einzeiligen Kopfleiste stehen (bei wenig Platz nur Symbol + Hinweis),
  // die Auswahl öffnet als schwebendes Feld darunter statt die Zeile aufzuschieben.
  return (
    <div ref={wrap} className="relative shrink-0">
      <Button variant="ghost" onClick={() => setOpen((v) => !v)} aria-haspopup="true" aria-expanded={open} aria-label={t("Verschieben nach …")} className="h-(--a-ctl-h) py-0" {...hint.triggerProps}>
        <IconMove size={14} />
        {!compact && <span>{t("Verschieben nach …")}</span>}
      </Button>
      {hint.tooltip}
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1.5 grid w-64 gap-2 rounded-md border border-a-line bg-a-p2 p-2.5 shadow-xl shadow-black/40" role="group" aria-label={t("Verschieben nach")}>
          <label className="grid gap-1 text-label text-a-mut">
            {t("Art")}
            <select
              className="rounded border border-a-line bg-a-p px-2 py-1 text-caption text-a-ink"
              value={art}
              onChange={(e) => {
                setArt(e.target.value);
                setBaustelleValue(NONE_VALUE);
              }}
            >
              {arts.map((a) => (
                <option key={a} value={a}>
                  {artLabel(a)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-label text-a-mut">
            {t("Baustelle")}
            <select className="rounded border border-a-line bg-a-p px-2 py-1 text-caption text-a-ink" value={baustelleValue} onChange={(e) => setBaustelleValue(e.target.value)}>
              <option value={NONE_VALUE}>{t("Ohne Baustelle")}</option>
              {baustellen.map((b) => (
                <option key={b.slug} value={b.slug ?? ""}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t("Abbrechen")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setOpen(false);
                const baustelle = chosen ? { slug: chosen.slug as string, label: chosen.label } : null;
                const dims: RuleDimension[] = [];
                if (art !== currentArt) dims.push("art");
                if ((baustelle?.slug ?? null) !== (currentBaustelle?.slug ?? null)) dims.push("baustelle");
                if (dims.length === 0) return; // nichts geändert — nichts zu korrigieren
                onPick(dims, art, baustelle);
              }}
            >
              {t("Übernehmen")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
