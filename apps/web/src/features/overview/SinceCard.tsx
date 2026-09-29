// „Seit du weg warst“: oben auf Überblick und Briefing. Zeigt, was seit dem letzten Besuch (im Browser
// gemerkt, s. lastVisit.ts) oder einem gewählten Zeitraum passiert ist — aus `GET /api/changes`. Jede Zeile
// springt zur Quelle, jede Zahl ist die Länge der Liste, leer heißt ehrlich „Nichts Neues seit …“.
// Ruhig gehalten: eine Fläche, keine Verläufe, Farbe nur als Punkt je Art (Tokens aus app.css).
import { locale, t, timeZone, type ChangesGroup, type ChangesKind } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { fetchChanges } from "../../lib/api";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useLastVisit } from "./lastVisit";

type Mode = "visit" | "8h" | "24h" | "gestern" | "7d";
const MODES: { id: Mode; label: string }[] = [
  { id: "visit", label: t("Letzter Besuch") },
  { id: "8h", label: t("8 Std") },
  { id: "24h", label: t("24 Std") },
  { id: "gestern", label: t("Seit gestern") },
  { id: "7d", label: t("7 Tage") },
];
const MODE_KEY = "nyxos.sinceMode";
/** So viele Zeilen je Gruppe zuerst, der Rest per Knopf. */
const FIRST_ROWS = 5;

/** Jede Art ihre Farbe (bunt, nie grau). */
const KIND_COLOR: Record<ChangesKind, string> = {
  sessions_waiting: "var(--a-wait)",
  sessions_crashed: "var(--a-bad)",
  decisions: "var(--a-conf)",
  sessions_done: "var(--a-ok)",
  commits: "var(--a-indigo)",
  tasks: "var(--a-done)",
  ideas: "var(--a-lime)",
  sessions_new: "var(--a-acc)",
  deploys: "var(--a-violet)",
  usage: "var(--a-nyx-2)",
};
const TOOL_COLOR: Record<string, string> = { Claude: "var(--a-claude)", Codex: "var(--a-codex)" };

const sinceFmt = new Intl.DateTimeFormat(locale(), { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: timeZone() });

function readMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return MODES.some((m) => m.id === v) ? (v as Mode) : "visit";
  } catch {
    return "visit";
  }
}

function writeMode(m: Mode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // ohne Speicher gilt die Wahl bis zum Neuladen
  }
}

function GroupBlock({ group }: { group: ChangesGroup }) {
  const [open, setOpen] = useState(false);
  const color = KIND_COLOR[group.kind];
  const rows = open ? group.items : group.items.slice(0, FIRST_ROWS);
  const hidden = group.items.length - rows.length;
  return (
    <section aria-label={group.title} className="grid min-w-0 gap-1 py-3 first:pt-0 last:pb-0">
      <h3 className="flex min-w-0 items-center gap-2 text-callout font-semibold text-a-ink">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 truncate">{group.title}</span>
        {group.kind !== "usage" && (
          <span data-testid="since-count" className="rounded-full px-1.5 font-mono text-label tabular-nums" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
            {group.count + group.more}
          </span>
        )}
      </h3>
      <ul className="grid min-w-0">
        {rows.map((it, i) => (
          <li key={`${it.path}-${i}`} className="min-w-0">
            <Link
              to={it.path}
              className="-mx-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc"
            >
              <span className="grid min-w-0">
                <span className="flex min-w-0 items-baseline gap-2">
                  {group.kind === "usage" && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full" style={{ background: TOOL_COLOR[it.label] ?? color }} />}
                  <span className="min-w-0 truncate text-callout text-a-ink">{it.label}</span>
                </span>
                {it.detail && <span className="min-w-0 truncate text-caption text-a-mut">{it.detail}</span>}
              </span>
              <span className="font-mono text-label tabular-nums text-a-mut">{group.kind === "usage" ? "" : relativeTime(it.at)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {(hidden > 0 || (open && group.items.length > FIRST_ROWS)) && (
        <button type="button" onClick={() => setOpen(!open)} className="w-fit rounded-md px-1.5 py-0.5 text-caption text-a-mut transition-colors hover:bg-a-p2 hover:text-a-ink">
          {open ? t("Weniger zeigen") : t("Alle {n} zeigen", { n: group.items.length })}
        </button>
      )}
      {group.more > 0 && <p className="text-caption text-a-mut">{t("und {n} weitere – hier stehen nur die neuesten.", { n: group.more })}</p>}
    </section>
  );
}

const OPEN_KEY = "nyxos.sinceOpen.";

function readOpen(place: string): boolean {
  try {
    return localStorage.getItem(OPEN_KEY + place) === "1";
  } catch {
    return false;
  }
}

function writeOpen(place: string, open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY + place, open ? "1" : "0");
  } catch {
    // ohne Speicher gilt der Zustand bis zum Neuladen
  }
}

/** Eingeklappt nur eine Zeile je Art (Punkt, Name, Zahl) — sonst schiebt die Karte auf Überblick und
 * Briefing alles, was zum Handeln führt, eine Bildschirmhöhe nach unten. */
function Summary({ groups }: { groups: ChangesGroup[] }) {
  return (
    <ul aria-label={t("Kurzfassung")} className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5">
      {groups.map((g) => (
        <li key={`${g.kind}-${g.title}`} className="flex min-w-0 items-center gap-1.5 text-callout text-a-ink">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[g.kind] }} />
          <span className="truncate">{g.title}</span>
          {g.kind !== "usage" && <span className="font-mono text-caption tabular-nums text-a-mut">{g.count + g.more}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * @param collapsible startet eingeklappt (eine Zeile je Art) und merkt sich den Zustand je Ort
 *   (`place`, z. B. „overview“, „briefing“). Ohne `collapsible` wie bisher immer offen.
 */
export function SinceCard({ className, collapsible = false, place = "default" }: { className?: string; collapsible?: boolean; place?: string }) {
  const lastVisit = useLastVisit();
  const [mode, setModeState] = useState<Mode>(readMode);
  const [openState, setOpenState] = useState(() => readOpen(place));
  const open = !collapsible || openState;
  const toggle = () => {
    setOpenState(!openState);
    writeOpen(place, !openState);
  };
  const setMode = (m: Mode) => {
    setModeState(m);
    writeMode(m);
  };
  const param = mode === "visit" ? (lastVisit ? new Date(lastVisit).toISOString() : "24h") : mode;
  const q = useQuery({ queryKey: ["changes", param], queryFn: () => fetchChanges(param), refetchInterval: 60_000 });
  const data = q.data;
  const sinceText = data ? sinceFmt.format(new Date(data.since)) : null;
  const total = data ? data.groups.filter((g) => g.kind !== "usage").reduce((a, g) => a + g.count + g.more, 0) : 0;

  if (!open) {
    return (
      <section aria-label={t("Seit du weg warst")} data-testid="since-card" className={cn("grid min-w-0 gap-2 rounded-xl border border-a-line bg-a-p px-4 py-3 sm:px-5", className)}>
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 className="flex min-w-0 items-baseline gap-2 font-display text-headline font-semibold text-a-ink">
            {t("Seit du weg warst")}
            <span className="truncate font-sans text-caption font-normal text-a-mut">{sinceText ? t("seit {time}", { time: sinceText }) : q.isError ? t("Zeitraum nicht geladen") : t("lädt …")}</span>
          </h2>
          {data && data.groups.length > 0 && (
            <button type="button" aria-expanded={false} onClick={toggle} className="h-7 rounded-full px-2.5 text-caption text-a-acc transition-colors duration-150 hover:bg-a-p2 pointer-coarse:h-11">
              {total === 1 ? t("1 Änderung") : t("{n} Änderungen", { n: total })} ▾
            </button>
          )}
        </header>
        {q.isError ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <p className="text-callout text-a-mut">{t("Was seit deinem letzten Besuch passiert ist, konnte gerade nicht geladen werden.")}</p>
            <button type="button" onClick={() => void q.refetch()} className="h-7 rounded-full border border-a-line px-3 text-caption text-a-ink transition-colors hover:bg-a-p2">
              {t("Erneut versuchen")}
            </button>
          </div>
        ) : data && data.groups.length === 0 ? (
          <p className="text-callout text-a-mut">{t("Nichts Neues seit {time}.", { time: sinceText })}</p>
        ) : data ? (
          <Summary groups={data.groups} />
        ) : null}
      </section>
    );
  }

  return (
    <section aria-label={t("Seit du weg warst")} data-testid="since-card" className={cn("grid min-w-0 gap-3 rounded-xl border border-a-line bg-a-p p-4 sm:p-5", className)}>
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-0.5">
          <h2 className="font-display text-title2 font-semibold text-a-ink">{t("Seit du weg warst")}</h2>
          <p className="text-caption text-a-mut">
            {sinceText ? t("seit {time}", { time: sinceText }) : q.isError ? t("Zeitraum nicht geladen") : t("lädt …")}
            {data && relativeTime(data.since) && <span>{` · ${relativeTime(data.since)}`}</span>}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <div role="group" aria-label={t("Zeitraum wählen")} className="flex min-w-0 flex-wrap gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={mode === m.id}
                onClick={() => setMode(m.id)}
                className={cn("h-7 rounded-full px-2.5 text-caption transition-colors duration-150", mode === m.id ? "bg-a-p3 text-a-ink" : "text-a-mut hover:bg-a-p2 hover:text-a-ink")}
              >
                {m.label}
              </button>
            ))}
          </div>
          {collapsible && (
            <button type="button" aria-expanded onClick={toggle} className="h-7 rounded-full px-2.5 text-caption text-a-acc transition-colors duration-150 hover:bg-a-p2 pointer-coarse:h-11">
              {t("Zuklappen")} ▴
            </button>
          )}
        </div>
      </header>

      {mode === "visit" && !lastVisit && <p className="text-caption text-a-mut">{t("Kein letzter Besuch gemerkt – hier stehen die letzten 24 Std.")}</p>}
      {data?.capped && <p className="text-caption text-a-mut">{t("Weiter als 7 Tage zurück geht es nicht – hier stehen die letzten 7 Tage.")}</p>}

      {q.isLoading ? (
        <div className="grid gap-2" aria-busy="true" aria-label={t("Lädt")}>
          {[70, 55, 62].map((w) => (
            <div key={w} className="h-4 animate-pulse rounded bg-a-p2 motion-reduce:animate-none" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : q.isError || !data ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <p className="text-callout text-a-mut">{t("Was seit deinem letzten Besuch passiert ist, konnte gerade nicht geladen werden.")}</p>
          <button type="button" onClick={() => void q.refetch()} className="h-7 rounded-full border border-a-line px-3 text-caption text-a-ink transition-colors hover:bg-a-p2">
            {t("Erneut versuchen")}
          </button>
        </div>
      ) : data.groups.length === 0 ? (
        <p className="text-callout text-a-mut">{t("Nichts Neues seit {time}.", { time: sinceText })}</p>
      ) : (
        <div className="grid min-w-0 divide-y divide-a-line">
          {data.groups.map((g) => (
            <GroupBlock key={`${g.kind}-${g.title}`} group={g} />
          ))}
        </div>
      )}
    </section>
  );
}
