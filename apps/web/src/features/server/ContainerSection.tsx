// Container nach den Serverdaten — nie riesig: zusammengeklappt eine große Kachel, in der man alle Container
// grün sieht, rot wenn sie nicht laufen, gelb, wenn nur ein Fehler existiert; aufklappbar zur Liste.
// - Kompakt (Standard): EINE Kachel mit Zusammenfassung und je Gruppe einer Reihe farbiger Kästchen
//   (Titel = Name + Zustand). Klick auf ein Kästchen → Liste, Gruppe auf, Container markiert.
// - Liste: Gruppen (NyxOS, jedes andere Projekt) einzeln mit Pfeil auf-/zuklappbar.
// Ansicht und offene Gruppen merkt sich der Browser (localStorage, abgesichert).
import { t, type ServerSnapshot } from "@nyxos/shared";
import { useState } from "react";
import { Sparkline } from "../../components/charts/Sparkline";
import { Card } from "../../components/ui/Card";
import { cn } from "../../lib/cn";
import { toneVar } from "../../lib/tones";
import { bucketColor, ContainerGroups, LIGHT_CLASS, LIGHT_WORD, LightCounts } from "./ContainerList";
import { containersCaption } from "./HostOverview";
import { containerBuckets, containerLight, containerStatus, decimal, formatBytes, isSteadyRunning, isTroubled, sumHistories } from "./serverView";

export const CONTAINER_VIEW_KEY = "nyx.server.containerView";
export const CONTAINER_GROUPS_KEY = "nyx.server.containerGroups";

type View = "compact" | "list";

function load<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ohne Speicher: nur für diesen Besuch
  }
}

const parseGroups = (raw: string): Set<string> => {
  const v: unknown = JSON.parse(raw);
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
};

function Total({ label, value, history, tone }: { label: string; value: string; history: number[]; tone: "claude" | "indigo" }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-label uppercase tracking-wider text-a-mut">{label}</span>
        <span className="font-display text-headline font-semibold tabular-nums text-a-ink">{value}</span>
      </span>
      <div className="h-5">{history.length > 2 && <Sparkline values={history} height={20} color={toneVar(tone)} />}</div>
    </div>
  );
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const btn = (v: View, label: string) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={view === v}
      className={cn("rounded-md px-2.5 py-1 text-caption transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-a-acc", view === v ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-a-line p-0.5" role="group" aria-label={t("Ansicht der Container")}>
      {btn("compact", t("Kompakt"))}
      {btn("list", t("Liste"))}
    </div>
  );
}

function CompactGrid({ data, onPick }: { data: ServerSnapshot; onPick: (groupKey: string, id: string) => void }) {
  return (
    <ul className="grid gap-2.5" data-testid="containers-compact">
      {containerBuckets(data.containers).map((b) => (
        <li key={b.key} className="grid gap-1.5 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-center sm:gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: bucketColor(b) }} aria-hidden />
            <span className="truncate text-callout font-medium text-a-ink">{b.label}</span>
            <span className="font-mono text-label tabular-nums text-a-mut">
              {b.running}/{b.containers.length}
            </span>
          </span>
          <span className="flex flex-wrap gap-1">
            {b.containers.map((c) => {
              const light = containerLight(c);
              const word = containerStatus(c).label;
              return (
                <button
                  key={c.id}
                  type="button"
                  data-light={light}
                  aria-label={`${c.name}: ${word}`}
                  title={`${c.name} · ${word} (${LIGHT_WORD[light]})`}
                  onClick={() => onPick(b.key, c.id)}
                  className={cn("h-4 w-4 rounded-[4px] transition-transform duration-150 hover:scale-125 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-a-acc motion-reduce:hover:scale-100", LIGHT_CLASS[light], light === "green" && "opacity-85")}
                />
              );
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ContainerSection({ data }: { data: ServerSnapshot }) {
  const [view, setView] = useState<View>(() => load<View>(CONTAINER_VIEW_KEY, (r) => (r === "list" ? "list" : "compact"), "compact"));
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => load(CONTAINER_GROUPS_KEY, parseGroups, new Set<string>()));
  const [focusId, setFocusId] = useState<string | null>(null);

  const changeView = (v: View) => {
    setView(v);
    save(CONTAINER_VIEW_KEY, v);
    if (v === "compact") setFocusId(null);
  };
  const storeGroups = (next: Set<string>) => {
    setOpenGroups(next);
    save(CONTAINER_GROUPS_KEY, JSON.stringify([...next]));
  };
  const toggleGroup = (key: string) => {
    const next = new Set(openGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    storeGroups(next);
  };
  const pick = (groupKey: string, id: string) => {
    if (!openGroups.has(groupKey)) storeGroups(new Set([...openGroups, groupKey]));
    setFocusId(id);
    changeView("list");
  };

  const all = data.containers;
  const running = all.filter((c) => c.state === "running");
  const steady = all.filter(isSteadyRunning);
  const troubled = all.filter(isTroubled);
  const lights = { green: 0, yellow: 0, red: 0 };
  for (const c of all) lights[containerLight(c)] += 1;
  const measured = running.some((c) => c.cpuPercent !== null);
  const cpuNow = running.reduce((s, c) => s + (c.cpuPercent ?? 0), 0);
  const memNow = running.reduce((s, c) => s + (c.memBytes ?? 0), 0);
  const cpuHist = sumHistories(running.map((c) => c.cpuHistory));
  const memHist = sumHistories(running.map((c) => c.memHistory));

  return (
    <div className="grid gap-3">
      <Card className="grid gap-4" data-testid="containers-summary">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-display text-title2 font-semibold tabular-nums text-a-ink">
              {steady.length} / {all.length}
            </span>
            <span className="text-callout text-a-mut">{t("laufen · {caption}", { caption: containersCaption(all) })}</span>
            {troubled.length > 0 ? (
              <span className="rounded-full bg-a-bad/12 px-2 py-0.5 text-caption text-a-bad">{t("{n} gestört", { n: troubled.length })}</span>
            ) : (
              <span className="rounded-full bg-a-ok/10 px-2 py-0.5 text-caption text-a-ok">{t("alles gesund")}</span>
            )}
            <LightCounts lights={lights} />
          </div>
          <ViewSwitch view={view} onChange={changeView} />
        </div>
        {view === "compact" && all.length > 0 && <CompactGrid data={data} onPick={pick} />}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4 border-t border-a-line pt-3">
          <Total label={t("CPU aller Container")} value={measured ? t("{n} Kerne", { n: decimal(cpuNow / 100) }) : t("misst …")} history={cpuHist} tone="claude" />
          <Total label={t("RAM aller Container")} value={memNow > 0 ? formatBytes(memNow) : "–"} history={memHist} tone="indigo" />
        </div>
      </Card>

      {view === "list" && <ContainerGroups containers={all} openGroups={openGroups} onToggleGroup={toggleGroup} focusId={focusId} dozzleUrl={data.dozzleUrl} />}
    </div>
  );
}
