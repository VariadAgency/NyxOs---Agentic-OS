// Legende unten links: welche Farbe welche Gruppe ist, mit Anzahl. Oben die
// Familien (Sessions, Planung, Eigener Code, Bibliotheken …); Familien mit Untergruppen klappen in ihre
// Töne auf (Code-Unterordner, Bibliotheks-Arten). Klick blendet eine Gruppe aus/ein; ausgegraute und
// ausgeblendete Gruppen sind als solche beschriftet.
// Standardmäßig eingeklappt (nur Knopf mit Farbpunkten), sitzt als Kachel auf derselben Ebene
// wie die Bedienleiste und klappt mit einer kleinen Flug-Animation hoch/runter (CSS `brain-legend`).
import { GRAPH_NODE_TYPE_LABELS, t, type GraphNodeType } from "@nyxos/shared";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { colorKeyLabel, familyBackground, familyOf, groupColor, hasSubgroups, leavesOf, NODE_UNIFORM, type ColorKey, type FamilyKey, type NoteCategory } from "./colors";
import type { BrainSettings, Visibility } from "./settings";

interface Props {
  /** Aufgeklappt starten (Tests); sonst eingeklappt. */
  defaultOpen?: boolean;
  settings: BrainSettings;
  /** Anzahl je Farbgruppe (Blatt). */
  counts: Partial<Record<ColorKey, number>>;
  onToggle(key: ColorKey | FamilyKey): void;
}

const RANK: Record<Visibility, number> = { show: 0, dim: 1, hide: 2 };
const stricter = (a: Visibility, b: Visibility | undefined): Visibility => (b && RANK[b] > RANK[a] ? b : a);

/** Wirksame Sichtbarkeit einer Familie bzw. Untergruppe (Art → Notiz-Familie → Untergruppe). */
export function groupVisibility(s: BrainSettings, key: ColorKey | FamilyKey): Visibility {
  const fam = familyOf(key);
  if (!fam.startsWith("note.")) return s.groups[fam as GraphNodeType] ?? "show";
  const famVis = stricter(s.groups.note ?? "show", s.noteGroups[fam.slice(5) as NoteCategory]);
  return fam === key ? famVis : stricter(famVis, s.subGroups?.[key as ColorKey]);
}

/** Ältere Stelle (BrainView): ist die Gruppe ganz ausgeblendet? */
export function isGroupHidden(s: BrainSettings, key: ColorKey | FamilyKey): boolean {
  return groupVisibility(s, key) === "hide";
}

/** Klick in der Legende: ausgeblendet → zeigen, sonst → ausblenden (nur diese Ebene). Eine ausgegraute
 * Familie/Art wird voll gezeigt (Bibliotheken sind standardmäßig ausgegraut — ein Klick
 * darauf soll sie hervorholen, nicht verschwinden lassen). */
export function toggleGroup(s: BrainSettings, key: ColorKey | FamilyKey): BrainSettings {
  const fam = familyOf(key);
  const vis = groupVisibility(s, key);
  const show = vis === "hide" || (fam === key && vis === "dim" && ownVisibility(s, fam) === "dim");
  if (!fam.startsWith("note.")) return { ...s, groups: { ...s.groups, [fam]: show ? "show" : "hide" } };
  const cat = fam.slice(5) as NoteCategory;
  if (fam === key) {
    return { ...s, groups: { ...s.groups, note: show && s.groups.note === "hide" ? "show" : s.groups.note }, noteGroups: { ...s.noteGroups, [cat]: show ? "show" : "hide" } };
  }
  const next: BrainSettings = { ...s, subGroups: { ...s.subGroups, [key]: show ? "show" : "hide" } };
  if (show) {
    // Einblenden einer Untergruppe holt auch ihre Familie zurück, sonst passiert sichtbar nichts.
    if (s.noteGroups[cat] === "hide") next.noteGroups = { ...s.noteGroups, [cat]: "show" };
    if (s.groups.note === "hide") next.groups = { ...s.groups, note: "show" };
  }
  return next;
}

/** Eigene Stufe einer Familie/Art (ohne die übergeordnete Knotenart „Notiz"). */
function ownVisibility(s: BrainSettings, fam: FamilyKey): Visibility {
  return fam.startsWith("note.") ? (s.noteGroups[fam.slice(5) as NoteCategory] ?? "show") : (s.groups[fam as GraphNodeType] ?? "show");
}

/** Hinweis am Legenden-Knopf: was ein Klick tut. */
function clickTitle(vis: Visibility, family: boolean): string {
  if (vis === "hide") return t("Einblenden");
  return vis === "dim" && family ? t("Voll zeigen") : t("Ausblenden");
}

const STATE_LABEL: Record<Visibility, string | null> = { show: null, dim: t("ausgegraut"), hide: t("ausgeblendet") };

function StateBadge({ vis, partial }: { vis: Visibility; partial?: boolean }) {
  const text = STATE_LABEL[vis] ?? (partial ? t("teils aus") : null);
  if (!text) return null;
  return <span className="rounded-full border border-a-line px-1.5 font-mono text-label leading-[15px] text-a-mut no-underline">{text}</span>;
}

export function Legend({ settings, counts, onToggle, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState<Partial<Record<FamilyKey, boolean>>>({});
  const famCounts = new Map<FamilyKey, number>();
  for (const [k, n] of Object.entries(counts) as Array<[ColorKey, number | undefined]>) {
    if (!n) continue;
    const f = familyOf(k);
    famCounts.set(f, (famCounts.get(f) ?? 0) + n);
  }
  const families = [...famCounts.keys()].sort((a, b) => (famCounts.get(b) ?? 0) - (famCounts.get(a) ?? 0));
  if (families.length === 0) return null;
  const bg = (f: FamilyKey) => (settings.colorByType ? familyBackground(f, settings.colors) : NODE_UNIFORM);

  return (
    <div
      className="brain-legend pointer-events-auto relative w-fit rounded-xl border border-a-line bg-a-p/85 px-3 py-2 shadow-lg backdrop-blur"
      aria-label={t("Legende")}
      data-testid="brain-legend"
      data-open={open ? "1" : "0"}
    >
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-1.5 font-mono text-label font-semibold uppercase tracking-wide text-a-mut hover:text-a-ink">
        <span aria-hidden="true" className={cn("inline-block text-label transition-transform duration-200", open ? "-rotate-90" : "rotate-0")}>
          ▶
        </span>
        {t("Legende")}
        <span className="brain-legend-dots ml-1 flex gap-0.5" aria-hidden="true">
          {families.slice(0, 14).map((f, i) => (
            <span key={f} className="h-2 w-2 rounded-full" style={{ background: bg(f), ["--i" as string]: i }} />
          ))}
        </span>
      </button>
      {/* Aufgeklappt: eigene Kachel ÜBER dem Knopf (fliegt hoch) — die Bedienleiste daneben verrutscht nie. */}
      <div
        className="brain-legend-body absolute bottom-[calc(100%+8px)] left-0 z-20 w-max max-w-[min(560px,calc(100vw-2rem))] rounded-xl border border-a-line bg-a-p/90 px-3 pb-2 pt-0.5 shadow-lg backdrop-blur"
        inert={!open}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="cc-scroll flex max-h-[40vh] flex-wrap gap-x-3 gap-y-1 overflow-y-auto pt-1.5">
          {families.map((f, idx) => {
            const vis = groupVisibility(settings, f);
            const label = colorKeyLabel(f, GRAPH_NODE_TYPE_LABELS);
            const subs = hasSubgroups(f) ? leavesOf(f).filter((k) => (counts[k] ?? 0) > 0) : [];
            const isOpen = subs.length > 0 && expanded[f] === true;
            const partial = vis === "show" && subs.some((k) => groupVisibility(settings, k) !== "show");
            const single = !hasSubgroups(f);
            const color = single ? (settings.colorByType ? groupColor(f as ColorKey, settings.colors) : NODE_UNIFORM) : undefined;
            return (
              <li key={f} className={cn("brain-legend-item flex flex-wrap items-center gap-x-1", isOpen && "basis-full")} style={{ ["--i" as string]: Math.min(idx, 16) }} data-testid={`legend-family-${f}`}>
                <button
                  type="button"
                  onClick={() => onToggle(f)}
                  aria-pressed={vis !== "hide"}
                  title={clickTitle(vis, true)}
                  className={cn("flex items-center gap-1.5 text-caption transition-opacity duration-150", vis === "hide" ? "text-a-mut opacity-60" : vis === "dim" ? "text-a-mut" : "text-a-ink")}
                  {...(color ? { "data-color": color } : {})}
                >
                  <span
                    aria-hidden="true"
                    className={cn("h-2.5 w-2.5 shrink-0 rounded-full", vis === "dim" && "opacity-50")}
                    style={{ background: bg(f), boxShadow: settings.glow && vis === "show" && color ? `0 0 6px ${color}` : undefined }}
                  />
                  <span className={cn(vis === "hide" && "line-through")}>{label}</span>
                  <span className="font-mono text-label tabular-nums text-a-mut">{famCounts.get(f)}</span>
                </button>
                <StateBadge vis={vis} partial={partial} />
                {subs.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [f]: !isOpen }))}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? t("{label} zuklappen", { label }) : t("{label} aufklappen", { label })}
                    title={isOpen ? t("Unterordner zuklappen") : t("{n} Unterordner zeigen", { n: subs.length })}
                    className="rounded px-1 text-label text-a-mut transition-colors duration-150 hover:text-a-ink"
                  >
                    <span aria-hidden="true" className={cn("inline-block transition-transform duration-150", isOpen && "rotate-90")}>
                      ▶
                    </span>
                  </button>
                ) : null}
                {isOpen ? (
                  <ul className="ml-3 flex basis-full flex-wrap gap-x-3 gap-y-1 border-l border-a-line py-0.5 pl-2.5">
                    {subs.map((k) => {
                      const sv = groupVisibility(settings, k);
                      const c = settings.colorByType ? groupColor(k, settings.colors) : NODE_UNIFORM;
                      return (
                        <li key={k} className="flex items-center gap-1" data-testid={`legend-leaf-${k}`}>
                          <button
                            type="button"
                            onClick={() => onToggle(k)}
                            aria-pressed={sv !== "hide"}
                            title={sv === "hide" ? t("Einblenden") : t("Ausblenden")}
                            className={cn("flex items-center gap-1.5 text-label transition-opacity duration-150", sv === "hide" ? "text-a-mut opacity-60" : sv === "dim" ? "text-a-mut" : "text-a-ink")}
                            data-color={c}
                          >
                            <span
                              aria-hidden="true"
                              className={cn("h-2 w-2 shrink-0 rounded-full", sv === "dim" && "opacity-50")}
                              style={{ background: c, boxShadow: settings.glow && sv === "show" ? `0 0 5px ${c}` : undefined }}
                            />
                            <span className={cn(sv === "hide" && "line-through")}>{colorKeyLabel(k, GRAPH_NODE_TYPE_LABELS)}</span>
                            <span className="font-mono text-label tabular-nums text-a-mut">{counts[k]}</span>
                          </button>
                          <StateBadge vis={sv} />
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
          </ul>
        </div>
      </div>
    </div>
  );
}
