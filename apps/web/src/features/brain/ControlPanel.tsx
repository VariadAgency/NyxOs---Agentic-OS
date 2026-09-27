// Steuerleiste oben rechts wie in Obsidian: Filter · Gruppen · Darstellung · Kräfte (einklappbar).
import { GRAPH_NODE_TYPE_LABELS, locale, t, tc, type GraphNodeType } from "@nyxos/shared";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { colorKeyLabel, DEFAULT_COLORS, familyBackground, groupColor, hasSubgroups, leavesOf, NODE_UNIFORM, NOTE_CATEGORIES, NOTE_CATEGORY_LABELS, type ColorKey, type FamilyKey } from "./colors";
import { DEFAULT_FORCES, SESSION_STATE_LABELS, SESSION_STATES, type BrainSettings, type Period, type Visibility } from "./settings";

interface Props {
  settings: BrainSettings;
  onChange(next: BrainSettings): void;
  /** Anzahl Knoten je Art im geladenen Graphen (Gruppen-Liste zeigt nur vorhandene Arten + Dateien). */
  counts: Partial<Record<GraphNodeType, number>>;
  /** Anzahl je Farbgruppe (Blatt: Notiz-Kategorien, Code-Unterordner, Bibliotheks-Arten). */
  colorCounts: Partial<Record<ColorKey, number>>;
  visibleCount: number;
  totalCount: number;
  onFit(): void;
}

type SectionKey = keyof BrainSettings["openSections"];

function Section({ id, title, open, onToggle, children }: { id: SectionKey; title: string; open: boolean; onToggle(id: SectionKey): void; children: ReactNode }) {
  return (
    <section className="border-t border-a-line first:border-t-0">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-label font-semibold uppercase tracking-wide text-a-mut transition-colors duration-150 hover:text-a-ink"
      >
        <span aria-hidden="true" className={cn("inline-block text-label transition-transform duration-150", open && "rotate-90")}>
          ▶
        </span>
        {title}
      </button>
      {open ? <div className="grid gap-2.5 px-3 pb-3">{children}</div> : null}
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-caption text-a-ink">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn("relative h-[18px] w-8 shrink-0 rounded-full border transition-colors duration-150", checked ? "border-a-acc/60 bg-a-acc/70" : "border-a-line bg-a-p3")}
      >
        <span className={cn("absolute top-[2px] h-3 w-3 rounded-full bg-a-ink transition-[left] duration-150", checked ? "left-[15px]" : "left-[2px]")} />
      </button>
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange(v: number): void; format?: (v: number) => string }) {
  return (
    <label className="grid gap-1 text-caption text-a-ink">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-label tabular-nums text-a-mut">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer accent-[var(--a-acc)]"
      />
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string; title?: string }>; onChange(v: T): void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border border-a-line bg-a-p2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title ?? o.label}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded px-1.5 py-1 text-caption transition-colors duration-150",
            value === o.value ? "bg-a-p3 text-a-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" : "text-a-mut hover:text-a-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const VIS_OPTIONS: Array<{ value: Visibility; label: string; title: string }> = [
  { value: "show", label: t("zeigen"), title: t("zeigen") },
  { value: "dim", label: t("grau"), title: t("ausgrauen") },
  { value: "hide", label: t("aus"), title: t("ausblenden") },
];

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "all", label: tc("period", "Alles") },
  { value: "7d", label: t("7 Tage") },
  { value: "30d", label: t("30 Tage") },
  { value: "archive", label: t("Archiv") },
];

const GROUP_ORDER: GraphNodeType[] = ["session", "subagent", "baustelle", "art", "note", "file", "task", "idea", "bug", "problem", "finding", "decision", "question", "commit", "branch"];

/** Farbpunkt, der zugleich Farbwähler ist (Wahl wird in den Einstellungen gemerkt). */
function Swatch({ colorKey, label, settings, onChange }: { colorKey: ColorKey; label: string; settings: BrainSettings; onChange(next: BrainSettings): void }) {
  const color = settings.colorByType ? groupColor(colorKey, settings.colors) : NODE_UNIFORM;
  return (
    <label
      className="relative h-3.5 w-3.5 shrink-0 cursor-pointer rounded-full ring-1 ring-white/10 transition-transform duration-150 hover:scale-125"
      style={{ background: color, boxShadow: settings.glow ? `0 0 7px ${color}` : undefined }}
      title={t("Farbe für {label} ändern", { label })}
    >
      <input
        type="color"
        value={groupColor(colorKey, settings.colors)}
        aria-label={t("Farbe: {label}", { label })}
        onChange={(e) => onChange({ ...settings, colorByType: true, colors: { ...settings.colors, [colorKey]: e.target.value } })}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );
}

export function ControlPanel({ settings, onChange, counts, colorCounts, visibleCount, totalCount, onFit }: Props) {
  const [openFamilies, setOpenFamilies] = useState<Partial<Record<FamilyKey, boolean>>>({});
  const famCount = (f: FamilyKey) => leavesOf(f).reduce((sum, k) => sum + (colorCounts[k] ?? 0), 0);
  const set = (patch: Partial<BrainSettings>) => onChange({ ...settings, ...patch });
  const toggleSection = (id: SectionKey) => set({ openSections: { ...settings.openSections, [id]: !settings.openSections[id] } });
  const groups = GROUP_ORDER.filter((nt) => (counts[nt] ?? 0) > 0 || nt === "file");
  const fmt = new Intl.NumberFormat(locale());

  const open = settings.panelOpen;

  // Beim Öffnen des Gehirns immer zugeklappt — nur ein schmaler Griff am rechten Rand (die Leiste
  // verdeckte ~¼ der Fläche). Ausfahren/Einfahren mit kleiner Flug-Animation (CSS `brain-panel`).
  // Die ausgefahrene Leiste liegt absolut über dem Gehirn und meldet sich dann als Kachel
  // (`data-brain-overlay`), damit „Alles einpassen“ um sie herum einpasst. Schmale Bildschirme: Blatt von
  // unten mit höchstens 45 % der Höhe (sonst verdeckt sie das ganze Gehirn).
  return (
    <div className="brain-panel relative flex items-center justify-end gap-2 max-sm:static" data-open={open ? "1" : "0"} data-testid="brain-panel">
      {/* 2D/3D sitzt immer sichtbar
          neben dem Griff — auch bei offener Leiste (die fährt darunter aus). */}
      <div className="rounded-lg border border-a-line bg-a-p/85 shadow-lg backdrop-blur">
        <Segmented
          label={t("Ansicht")}
          value={settings.mode}
          options={[
            { value: "2d", label: "2D", title: t("Flache Ansicht") },
            { value: "3d", label: "3D", title: t("Räumliche Ansicht") },
          ]}
          onChange={(mode) => set({ mode })}
        />
      </div>
      {/* Griff waagrecht (vorher senkrechte Schrift am rechten Rand). */}
      <button
        type="button"
        onClick={() => set({ panelOpen: true })}
        aria-label={t("Steuerung öffnen")}
        aria-expanded={open}
        inert={open}
        title={t("Filter, Gruppen, Darstellung und Kräfte")}
        className="brain-panel-handle flex items-center gap-1.5 rounded-lg border border-a-line bg-a-p/85 px-2.5 py-1.5 text-caption text-a-mut shadow-lg backdrop-blur hover:text-a-ink"
      >
        <span aria-hidden="true">⚙</span>
        <span>{t("Steuerung")}</span>
      </button>
      <div
        className="brain-panel-body cc-scroll absolute right-0 top-11 z-20 w-[312px] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-184px)] overflow-y-auto rounded-xl border border-a-line bg-a-p2/95 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:w-auto max-sm:max-w-none max-sm:max-h-[45%]"
        data-brain-overlay={open ? "" : undefined}
        data-testid="brain-panel-body"
        aria-label={t("Steuerung Gehirn")}
        inert={!open}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
          <span className="font-mono text-label tabular-nums text-a-mut" data-testid="brain-visible-count">
            {t("{visible} / {total} Punkte", { visible: fmt.format(visibleCount), total: fmt.format(totalCount) })}
          </span>
          <button type="button" onClick={() => set({ panelOpen: false })} aria-label={t("Steuerung schließen")} className="rounded px-1.5 text-a-mut hover:text-a-ink">
            ✕
          </button>
        </div>

        <Section id="filter" title={t("Filter")} open={settings.openSections.filter} onToggle={toggleSection}>
          <input
            type="search"
            value={settings.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder={t("Suchen …")}
            aria-label={t("Im Gehirn suchen")}
            className="h-(--a-ctl-h) rounded-md border border-a-line bg-a-p2 px-2.5 text-caption text-a-ink outline-none placeholder:text-a-mut focus:border-a-acc/60"
          />
          <Toggle label={t("Waisen")} checked={settings.showOrphans} onChange={(v) => set({ showOrphans: v })} />
          <Toggle label={t("Nicht erstellte Notizen")} checked={settings.showUnresolved} onChange={(v) => set({ showUnresolved: v })} />
          <div className="grid gap-1">
            <span className="text-caption text-a-mut">{t("Zeitraum")}</span>
            <Segmented label={t("Zeitraum")} value={settings.period} options={PERIODS} onChange={(period) => set({ period })} />
          </div>
          <div className="grid gap-1">
            <span className="text-caption text-a-mut">{t("Zustand (Sessions)")}</span>
            <div className="flex flex-wrap gap-1">
              {SESSION_STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={settings.states[s]}
                  onClick={() => set({ states: { ...settings.states, [s]: !settings.states[s] } })}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-label transition-colors duration-150",
                    settings.states[s] ? "border-a-acc/50 bg-a-acc/10 text-a-ink" : "border-a-line text-a-mut line-through",
                  )}
                >
                  {SESSION_STATE_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section id="groups" title={t("Gruppen")} open={settings.openSections.groups} onToggle={toggleSection}>
          <p className="text-label leading-snug text-a-mut">{t("Farbpunkt anklicken, um die Farbe zu ändern.")}</p>
          {groups.map((nt) => (
            <div key={nt} className="grid gap-1.5">
              <div className="grid grid-cols-[1fr_auto] items-center gap-2" data-testid={`group-${nt}`}>
                <span className="flex min-w-0 items-center gap-2 text-caption text-a-ink">
                  {nt === "note" ? (
                    <span
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 rounded-full"
                      style={{ background: settings.colorByType ? `conic-gradient(${NOTE_CATEGORIES.flatMap((c) => leavesOf(`note.${c}`)).map((k) => groupColor(k, settings.colors)).join(",")})` : NODE_UNIFORM }}
                    />
                  ) : (
                    <Swatch colorKey={nt} label={t(GRAPH_NODE_TYPE_LABELS[nt])} settings={settings} onChange={onChange} />
                  )}
                  <span className="truncate">{t(GRAPH_NODE_TYPE_LABELS[nt])}</span>
                  <span className="font-mono text-label tabular-nums text-a-mut">{counts[nt] ?? 0}</span>
                </span>
                <div className="w-[128px]">
                  <Segmented
                    label={t("{label}: Sichtbarkeit", { label: t(GRAPH_NODE_TYPE_LABELS[nt]) })}
                    value={settings.groups[nt]}
                    options={VIS_OPTIONS}
                    onChange={(v) => set({ groups: { ...settings.groups, [nt]: v } })}
                  />
                </div>
              </div>
              {nt === "note" && settings.groups.note !== "hide" ? (
                <div className="ml-2 grid gap-1.5 border-l border-a-line pl-3" data-testid="note-groups">
                  {NOTE_CATEGORIES.filter((c) => famCount(`note.${c}`) > 0).map((c) => {
                    const fam = `note.${c}` as const;
                    const withSubs = hasSubgroups(fam);
                    const isOpen = withSubs && openFamilies[fam] === true;
                    return (
                      <div key={c} className="grid gap-1.5">
                        <div className="grid grid-cols-[1fr_auto] items-center gap-2" data-testid={`note-group-${c}`}>
                          <span className="flex min-w-0 items-center gap-2 text-caption text-a-ink">
                            {withSubs ? (
                              <button
                                type="button"
                                onClick={() => setOpenFamilies((o) => ({ ...o, [fam]: !isOpen }))}
                                aria-expanded={isOpen}
                                aria-label={isOpen ? t("{label}: Unterordner zuklappen", { label: NOTE_CATEGORY_LABELS[c] }) : t("{label}: Unterordner zeigen", { label: NOTE_CATEGORY_LABELS[c] })}
                                className="flex shrink-0 items-center gap-1 text-a-mut hover:text-a-ink"
                              >
                                <span aria-hidden="true" className={cn("inline-block text-label transition-transform duration-150", isOpen && "rotate-90")}>
                                  ▶
                                </span>
                                <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full ring-1 ring-white/10" style={{ background: settings.colorByType ? familyBackground(fam, settings.colors) : NODE_UNIFORM }} />
                              </button>
                            ) : (
                              <Swatch colorKey={fam as ColorKey} label={NOTE_CATEGORY_LABELS[c]} settings={settings} onChange={onChange} />
                            )}
                            <span className="truncate">{NOTE_CATEGORY_LABELS[c]}</span>
                            <span className="font-mono text-label tabular-nums text-a-mut">{famCount(fam)}</span>
                          </span>
                          <div className="w-[108px]">
                            <Segmented
                              label={t("{label}: Sichtbarkeit", { label: NOTE_CATEGORY_LABELS[c] })}
                              value={settings.noteGroups[c]}
                              options={VIS_OPTIONS}
                              onChange={(v) => set({ noteGroups: { ...settings.noteGroups, [c]: v } })}
                            />
                          </div>
                        </div>
                        {isOpen ? (
                          <div className="ml-2 grid gap-1.5 border-l border-a-line pl-3" data-testid={`note-subgroups-${c}`}>
                            {leavesOf(fam).filter((k) => (colorCounts[k] ?? 0) > 0).map((k) => {
                              const label = colorKeyLabel(k, GRAPH_NODE_TYPE_LABELS);
                              return (
                                <div key={k} className="grid grid-cols-[1fr_auto] items-center gap-2" data-testid={`note-subgroup-${k}`}>
                                  <span className="flex min-w-0 items-center gap-2 text-caption text-a-ink">
                                    <Swatch colorKey={k} label={label} settings={settings} onChange={onChange} />
                                    <span className="truncate">{label}</span>
                                    <span className="font-mono text-label tabular-nums text-a-mut">{colorCounts[k] ?? 0}</span>
                                  </span>
                                  <div className="w-[96px]">
                                    <Segmented
                                      label={t("{label}: Sichtbarkeit", { label })}
                                      value={settings.subGroups[k] ?? "show"}
                                      options={VIS_OPTIONS}
                                      onChange={(v) => set({ subGroups: { ...settings.subGroups, [k]: v } })}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ))}
          <Toggle label={t("Farben je Art")} checked={settings.colorByType} onChange={(v) => set({ colorByType: v })} />
          <Toggle label={t("Leuchten")} checked={settings.glow} onChange={(v) => set({ glow: v })} />
          {Object.keys(settings.colors).length > 0 ? (
            <button
              type="button"
              onClick={() => set({ colors: {} })}
              className="rounded-md border border-a-line bg-a-p2 px-2 py-1 text-caption text-a-mut transition-colors duration-150 hover:text-a-ink"
              title={t("Zurück zur Grundpalette ({n} Farben)", { n: Object.keys(DEFAULT_COLORS).length })}
            >
              {t("Farben zurücksetzen")}
            </button>
          ) : null}
        </Section>

        <Section id="display" title={tc("brain", "Darstellung")} open={settings.openSections.display} onToggle={toggleSection}>
          {settings.mode === "3d" ? (
            <Segmented
              label={t("3D-Steuerung")}
              value={settings.control3d}
              options={[
                { value: "orbit", label: t("Umkreisen") },
                { value: "fly", label: t("Fliegen") },
              ]}
              onChange={(control3d) => set({ control3d })}
            />
          ) : null}
          <Toggle label={t("Pfeile")} checked={settings.arrows} onChange={(v) => set({ arrows: v })} />
          <Slider label={t("Beschriftung ab Zoom")} value={settings.labelZoom} min={0.3} max={4} step={0.1} onChange={(labelZoom) => set({ labelZoom })} format={(v) => `${v.toFixed(1)}×`} />
          <Slider label={t("Knotengröße")} value={settings.nodeSize} min={0.4} max={3} step={0.1} onChange={(nodeSize) => set({ nodeSize })} format={(v) => v.toFixed(1)} />
          <Slider label={t("Linienstärke")} value={settings.linkWidth} min={0.2} max={3} step={0.1} onChange={(linkWidth) => set({ linkWidth })} format={(v) => v.toFixed(1)} />
          <button type="button" onClick={onFit} className="rounded-md border border-a-line bg-a-p2 px-2 py-1 text-caption text-a-mut transition-colors duration-150 hover:text-a-ink">
            {t("Alles einpassen")}
          </button>
        </Section>

        <Section id="forces" title={t("Kräfte")} open={settings.openSections.forces} onToggle={toggleSection}>
          <Slider label={t("Zentrumskraft")} value={settings.forces.center} min={0} max={1} step={0.01} onChange={(center) => set({ forces: { ...settings.forces, center } })} format={(v) => v.toFixed(2)} />
          <Slider label={t("Abstoßung")} value={settings.forces.repel} min={0} max={20} step={0.5} onChange={(repel) => set({ forces: { ...settings.forces, repel } })} format={(v) => v.toFixed(1)} />
          <Slider label={t("Verbindungskraft")} value={settings.forces.link} min={0} max={1} step={0.01} onChange={(link) => set({ forces: { ...settings.forces, link } })} format={(v) => v.toFixed(2)} />
          <Slider label={t("Verbindungsabstand")} value={settings.forces.distance} min={30} max={500} step={5} onChange={(distance) => set({ forces: { ...settings.forces, distance } })} format={(v) => String(Math.round(v))} />
          {/* Leichte Eigenbewegung der 3D-Wolke (0 = ganz still, schont den Rechner). */}
          {settings.mode === "3d" ? (
            <Slider label={t("Schweben")} value={settings.forces.drift} min={0} max={1} step={0.05} onChange={(drift) => set({ forces: { ...settings.forces, drift } })} format={(v) => (v === 0 ? t("aus") : v.toFixed(2))} />
          ) : null}
          <button
            type="button"
            onClick={() => set({ forces: { ...DEFAULT_FORCES } })}
            className="rounded-md border border-a-line bg-a-p2 px-2 py-1 text-caption text-a-mut transition-colors duration-150 hover:text-a-ink"
          >
            {t("Kräfte zurücksetzen")}
          </button>
        </Section>
      </div>
    </div>
  );
}
