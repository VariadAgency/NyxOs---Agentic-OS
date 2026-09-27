// Ansichten-Leiste: vorgefertigte Gehirne als Reiter, „Pro Baustelle" mit Auswahl, eigenes
// Gehirn je Session (Hinweis-Chip), gespeicherte eigene Ansichten.
import { t, type GraphNode } from "@nyxos/shared";
import { useState } from "react";
import { cn } from "../../lib/cn";
import type { BrainSettings } from "./settings";
import { applyPreset, applySavedView, clearFocus, deleteView, PRESETS, saveView } from "./views";

interface Props {
  settings: BrainSettings;
  onChange(next: BrainSettings): void;
  /** Baustellen im Graphen (für „Pro Baustelle"), nach Größe sortiert. */
  baustellen: GraphNode[];
  focusLabel: string | null;
}

const pill = (on: boolean) =>
  cn(
    "rounded-full border px-2.5 py-1 text-caption leading-none transition-colors duration-150",
    on ? "border-a-acc/60 bg-a-acc/15 text-a-ink" : "border-a-line bg-a-p/80 text-a-mut hover:border-a-acc/40 hover:text-a-ink",
  );

export function ViewBar({ settings, onChange, baustellen, focusLabel }: Props) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const active = settings.activeView;

  const pickPreset = (id: (typeof PRESETS)[number]["id"]) => {
    if (id === "baustelle") {
      const current = settings.focus?.id.startsWith("baustelle:") ? settings.focus.id : baustellen[0]?.id;
      const b = baustellen.find((x) => x.id === current);
      onChange(applyPreset(settings, "baustelle", { focusId: b?.id, focusLabel: b?.label }));
      return;
    }
    onChange(applyPreset(settings, id));
  };

  const commitName = () => {
    const clean = name.trim();
    if (clean) onChange(saveView(settings, clean));
    setNaming(false);
    setName("");
  };

  return (
    <div className="grid gap-1.5" data-testid="brain-views">
      <div role="tablist" aria-label={t("Gehirne")} className="flex max-w-[680px] flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" role="tab" aria-selected={active === p.id} title={p.hint} onClick={() => pickPreset(p.id)} className={pill(active === p.id)}>
            {p.label}
          </button>
        ))}
        {settings.savedViews.map((v) => (
          <span key={v.name} className="group inline-flex items-center">
            <button type="button" role="tab" aria-selected={active === `saved:${v.name}`} title={t("Eigene Ansicht")} onClick={() => onChange(applySavedView(settings, v))} className={pill(active === `saved:${v.name}`)}>
              ★ {v.name}
            </button>
            <button
              type="button"
              aria-label={t("Ansicht „{name}“ löschen", { name: v.name })}
              onClick={() => onChange(deleteView(settings, v.name))}
              title={t("Ansicht löschen")}
              // Immer da (Touch/Tastatur) — nur dezent, bis man auf die Ansicht zeigt oder hinspringt.
              className="ml-0.5 rounded px-1 text-label text-a-mut/60 transition-colors duration-150 hover:text-a-bad focus-visible:text-a-bad focus-visible:outline focus-visible:outline-1 focus-visible:outline-a-bad/60 group-hover:text-a-mut"
            >
              ✕
            </button>
          </span>
        ))}
        {naming ? (
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              commitName();
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNaming(false);
              }}
              placeholder={t("Name der Ansicht")}
              aria-label={t("Name der Ansicht")}
              className="w-36 rounded-full border border-a-line bg-a-p2 px-2.5 py-1 text-caption text-a-ink outline-none placeholder:text-a-mut focus:border-a-acc/60"
            />
            <button type="submit" className={pill(false)}>
              {t("Speichern")}
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setNaming(true)} className={cn(pill(false), "border-dashed")} title={t("Aktuelle Filter als eigene Ansicht speichern")}>
            {t("+ Ansicht speichern")}
          </button>
        )}
      </div>
      {active === "baustelle" && baustellen.length > 0 ? (
        <label className="flex w-fit items-center gap-2 rounded-lg border border-a-line bg-a-p/85 px-2.5 py-1.5 text-caption text-a-mut backdrop-blur">
          {t("Baustelle")}
          <select
            value={settings.focus?.id ?? ""}
            onChange={(e) => {
              const b = baustellen.find((x) => x.id === e.target.value);
              onChange(applyPreset(settings, "baustelle", { focusId: b?.id, focusLabel: b?.label }));
            }}
            className="rounded border border-a-line bg-a-p2 px-1.5 py-0.5 text-caption text-a-ink outline-none"
            aria-label={t("Baustelle wählen")}
          >
            {baustellen.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} ({b.degree})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {settings.focus && active !== "baustelle" ? (
        <div className="flex w-fit items-center gap-2 rounded-lg border border-a-acc/40 bg-a-acc/10 px-2.5 py-1.5 text-caption text-a-ink backdrop-blur" data-testid="brain-focus">
          <span>
            {t("Eigenes Gehirn:")} <b className="font-semibold">{focusLabel ?? settings.focus.label ?? t("Auswahl")}</b>
          </span>
          <span className="flex rounded-md border border-a-line bg-a-p2 p-0.5" role="radiogroup" aria-label={t("Tiefe")}>
            {([1, 2, 3] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={settings.focus?.depth === d}
                onClick={() => settings.focus && onChange({ ...settings, focus: { ...settings.focus, depth: d } })}
                className={cn("rounded px-1.5 text-label", settings.focus?.depth === d ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
              >
                {t("Tiefe {d}", { d })}
              </button>
            ))}
          </span>
          <button type="button" onClick={() => onChange(clearFocus(settings))} aria-label={t("Eigenes Gehirn schließen")} className="rounded px-1 text-a-mut hover:text-a-ink">
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}
