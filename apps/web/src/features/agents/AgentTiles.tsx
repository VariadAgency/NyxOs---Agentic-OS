// „Alle Agenten“ als Kacheln + Großansicht eines Agenten (Beschreibung, Werkzeuge, Prompt
// formatiert, letzte Einsätze mit Links). Die URL (`?agent=`) ist die eine Quelle der Wahrheit.
import { t } from "@nyxos/shared";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { MiniRing, Sparkline } from "../../components/charts";
import { Tile, TileGrid } from "../../components/ui/Tile";
import { cn } from "../../lib/cn";
import { relativeTime, shortenPath } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { sessionHref } from "../git/meta";
import { modelLabel, ORIGIN_LABEL, STATE_META, type AgentOrigin, type AgentTileData } from "./agentTileModel";
import type { AgentRun } from "./api";
import { formatDurationMs } from "./format";

const DAY_MS = 86_400_000;
const RECENT_RUNS = 10;
const PROMPT_PREVIEW_CHARS = 1_800;

function monogram(label: string): string {
  const parts = label.split(/[-_\s]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : label.slice(0, 2);
  return letters.toUpperCase();
}

function modelTone(tile: AgentTileData): string {
  return tile.origin === "codex" ? "var(--a-codex)" : "var(--a-claude)";
}

function StateBadge({ tile }: { tile: AgentTileData }) {
  const s = STATE_META[tile.state];
  return (
    <span title={s.hint} className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-label font-medium whitespace-nowrap" style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 13%, transparent)` }}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", tile.state === "laeuft" && "cc-pulse")} style={{ background: s.color, boxShadow: `0 0 6px ${s.color}` }} />
      {s.label}
    </span>
  );
}

function ModelChip({ tile }: { tile: AgentTileData }) {
  const tone = modelTone(tile);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-label font-medium" style={{ color: tone, borderColor: `color-mix(in srgb, ${tone} 40%, var(--a-line))`, background: `color-mix(in srgb, ${tone} 9%, transparent)` }}>
      <span aria-hidden>◆</span>
      {modelLabel(tile)}
    </span>
  );
}

/** Einsätze je Tag, letzte 14 Tage (für die Mini-Kurve auf der Kachel). */
function perDay(runs: AgentRun[], now: number): number[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const out = Array.from({ length: 14 }, () => 0);
  for (const r of runs) {
    const at = Date.parse(r.startedAt ?? r.endedAt ?? "");
    if (!Number.isFinite(at)) continue;
    const idx = 13 - Math.floor((t0 + DAY_MS - 1 - at) / DAY_MS);
    if (idx >= 0 && idx < 14) out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}

function AgentTile({ tile, index, selected, now, onOpen }: { tile: AgentTileData; index: number; selected: boolean; now: number; onOpen: () => void }) {
  const days = useMemo(() => perDay(tile.runs, now), [tile.runs, now]);
  return (
    <Tile
      color={tile.color}
      icon={monogram(tile.label)}
      title={tile.label}
      subtitle={`${ORIGIN_LABEL[tile.origin]} · ${tile.tools.length > 0 ? t("{n} Werkzeuge", { n: tile.tools.length }) : t("alle Werkzeuge")}`}
      badge={<StateBadge tile={tile} />}
      onClick={onOpen}
      selected={selected}
      data={{ "data-agent-tile": tile.key }}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
      footer={
        <>
          <span>
            <b className="font-mono font-medium tabular-nums text-a-ink">{tile.total}×</b> {t("genutzt")}
            {tile.runs7d > 0 && <span className="text-a-mut"> · {t("{n} diese Woche", { n: tile.runs7d })}</span>}
          </span>
          <span className="font-mono">{tile.lastAt ? relativeTime(tile.lastAt, now) : "—"}</span>
          {tile.passRate !== null && (
            <span className="ml-auto inline-flex items-center gap-1" title={t("{pct} % bestanden (auch „mit Hinweisen“) von {n} Einsätzen mit Urteil", { pct: tile.passRate, n: tile.judged })}>
              <MiniRing pct={tile.passRate} size={16} />
              <span className="font-mono tabular-nums">{tile.passRate} %</span>
            </span>
          )}
        </>
      }
    >
      <span className="line-clamp-2 min-h-[34px] text-caption leading-[17px] text-a-mut">{tile.description ?? t("Ohne Beschreibung.")}</span>
      <span className="flex items-end justify-between gap-3">
        <ModelChip tile={tile} />
        <span className="w-[96px] shrink-0 opacity-90">{tile.total > 0 ? <Sparkline values={days} height={22} color={tile.color} label={t("Einsätze je Tag, 14 Tage: {name}", { name: tile.label })} /> : null}</span>
      </span>
    </Tile>
  );
}

const ORIGIN_FILTERS: { value: AgentOrigin | "alle"; label: string }[] = [
  { value: "alle", label: t("Alle") },
  { value: "projekt", label: t("Projekt") },
  { value: "eigen", label: t("Eigene") },
  { value: "eingebaut", label: t("Eingebaut") },
  { value: "codex", label: "Codex" },
];

export function AgentTileSection({ tiles, openKey, now, onOpen, onClose, onOpenRun }: { tiles: AgentTileData[]; openKey: string | null; now: number; onOpen: (key: string) => void; onClose: () => void; onOpenRun: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<AgentOrigin | "alle">("alle");
  const q = query.trim().toLowerCase();
  const visible = tiles.filter((x) => (origin === "alle" || x.origin === origin || (origin === "eingebaut" && x.origin === "sonstig")) && (!q || x.label.toLowerCase().includes(q) || (x.description ?? "").toLowerCase().includes(q)));
  const selected = openKey ? (tiles.find((x) => x.key === openKey) ?? null) : null;
  const originCount = (o: AgentOrigin | "alle") => (o === "alle" ? tiles.length : tiles.filter((x) => x.origin === o || (o === "eingebaut" && x.origin === "sonstig")).length);

  return (
    <section aria-label={t("Alle Agenten")} className="grid min-w-0 content-start gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-mono text-label font-semibold uppercase tracking-wider text-a-mut">
          {t("Alle Agenten")}
          <span className="rounded-full bg-a-p3 px-1.5 py-0.5 text-label tabular-nums text-a-mut">{tiles.length}</span>
        </h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Agent suchen …")}
          aria-label={t("Agent suchen")}
          className="h-(--a-ctl-h) w-full max-w-[240px] rounded-lg border border-a-line bg-a-bg/60 px-2.5 text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc/60 focus:outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Herkunft")}>
        {ORIGIN_FILTERS.filter((f) => originCount(f.value) > 0).map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={origin === f.value}
            onClick={() => setOrigin(f.value)}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-caption transition-colors", origin === f.value ? "border-a-acc/50 bg-a-acc/10 text-a-acc" : "border-a-line text-a-mut hover:bg-a-p2")}
          >
            {f.label} <span className="font-mono tabular-nums">{originCount(f.value)}</span>
          </button>
        ))}
      </div>

      {selected && <AgentTileDetail tile={selected} now={now} onClose={onClose} onOpenRun={onOpenRun} />}

      {tiles.length === 0 ? (
        <div className="grid min-h-[140px] place-items-center rounded-2xl border border-dashed border-a-line p-6 text-center">
          <div>
            <b className="text-a-ink">{t("Noch keine Agenten bekannt.")}</b>
            <p className="mt-1 text-caption text-a-mut">{t("Sobald die Brücke deine Agenten-Dateien meldet oder ein Agent läuft, erscheint er hier als Kachel.")}</p>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="grid min-h-[96px] place-items-center rounded-2xl border border-dashed border-a-line p-4 text-center text-callout text-a-mut">
          <span>
            {t("Kein Agent passt.")}{" "}
            <button
              type="button"
              className="text-a-acc hover:underline"
              onClick={() => {
                setQuery("");
                setOrigin("alle");
              }}
            >
              {t("Filter zurücksetzen")}
            </button>
          </span>
        </div>
      ) : (
        <TileGrid>
          {visible.map((x, i) => (
            <AgentTile key={x.key} tile={x} index={i} now={now} selected={x.key === openKey} onOpen={() => (x.key === openKey ? onClose() : onOpen(x.key))} />
          ))}
        </TileGrid>
      )}
    </section>
  );
}

function VerdictChip({ run }: { run: AgentRun }) {
  const meta = run.running
    ? { label: t("läuft"), color: "var(--a-ok)" }
    : run.verdict === "PASS"
      ? { label: "PASS", color: "var(--a-ok)" }
      : run.verdict === "PASS_WITH_NOTES"
        ? { label: t("mit Hinweisen"), color: "var(--a-wait)" }
        : run.verdict === "BLOCK"
          ? { label: "BLOCK", color: "var(--a-bad)" }
          : { label: t("fertig"), color: "var(--a-done)" };
  return (
    <span className="inline-flex w-[96px] shrink-0 items-center justify-center gap-1.5 rounded-full px-2 py-0.5 text-label font-medium" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 13%, transparent)` }}>
      {run.running && <span aria-hidden className="cc-pulse h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />}
      {meta.label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 rounded-xl border border-a-line bg-a-bg/40 px-3 py-2">
      <span className="font-mono text-label uppercase tracking-wide text-a-mut">{label}</span>
      <span className="font-display text-title2 font-semibold tabular-nums text-a-ink">{value}</span>
    </div>
  );
}

function AgentTileDetail({ tile, now, onClose, onOpenRun }: { tile: AgentTileData; now: number; onClose: () => void; onOpenRun: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fullPrompt, setFullPrompt] = useState(false);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [tile.key]);
  const prompt = tile.prompt ?? "";
  const longPrompt = prompt.length > PROMPT_PREVIEW_CHARS;
  const shownPrompt = fullPrompt || !longPrompt ? prompt : `${prompt.slice(0, PROMPT_PREVIEW_CHARS)} …`;
  const recent = tile.runs.slice(0, RECENT_RUNS);

  return (
    <div
      ref={ref}
      data-testid="agent-tile-detail"
      style={{ "--c": tile.color } as CSSProperties}
      className="relative grid min-w-0 gap-4 overflow-hidden rounded-2xl border border-(--c)/45 bg-a-p2 p-4 shadow-raise motion-safe:animate-[cc-stagger-in_220ms_cubic-bezier(.2,.8,.2,1)_both] md:p-5"
    >
      <header className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3">
        <span aria-hidden className="grid h-12 w-12 place-items-center rounded-2xl font-display text-title2 font-semibold" style={{ background: `color-mix(in srgb, ${tile.color} 20%, var(--a-p2))`, color: tile.color }}>
          {monogram(tile.label)}
        </span>
        <div className="grid min-w-0 gap-1.5">
          <h2 className="truncate font-display text-title2 font-semibold leading-tight text-a-ink">{tile.label}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <StateBadge tile={tile} />
            <ModelChip tile={tile} />
            <span className="rounded-full bg-a-p3 px-2 py-0.5 text-label text-a-mut">{ORIGIN_LABEL[tile.origin]}</span>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label={t("Schließen")} className="shrink-0 rounded-md px-2 py-1 text-caption text-a-mut hover:bg-a-p3 hover:text-a-ink">
          <span className="hidden sm:inline">{t("Schließen")} </span>✕
        </button>
      </header>

      <p className="relative text-callout leading-relaxed text-a-ink">{tile.description ?? t("Für diesen Agenten gibt es keine Beschreibung.")}</p>

      <div className="relative grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 md:grid-cols-[repeat(4,minmax(0,1fr))]">
        <Stat label={t("Einsätze")} value={String(tile.total)} />
        <Stat label={t("Diese Woche")} value={String(tile.runs7d)} />
        <Stat label={t("Bestanden")} value={tile.passRate === null ? "—" : `${tile.passRate} %`} />
        <Stat label={t("Ø Dauer")} value={formatDurationMs(tile.avgDurationMs)} />
      </div>

      <section aria-label={t("Werkzeuge")} className="relative grid gap-1.5">
        <h3 className="font-mono text-label font-semibold uppercase tracking-wider text-a-mut">{t("Werkzeuge")}</h3>
        {tile.tools.length === 0 ? (
          <p className="text-caption text-a-mut">{tile.origin === "codex" ? t("Codex entscheidet selbst.") : t("Keine Einschränkung: der Agent darf alle Werkzeuge der Session nutzen.")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tile.tools.map((tool) => (
              <span key={tool} className="rounded-md border px-2 py-0.5 font-mono text-caption" style={{ color: tile.color, borderColor: `color-mix(in srgb, ${tile.color} 35%, var(--a-line))`, background: `color-mix(in srgb, ${tile.color} 8%, transparent)` }}>
                {tool}
              </span>
            ))}
          </div>
        )}
      </section>

      {prompt && (
        <section aria-label="Prompt" className="relative grid gap-1.5">
          <h3 className="font-mono text-label font-semibold uppercase tracking-wider text-a-mut">Prompt</h3>
          <div className="cc-scroll max-h-[420px] overflow-y-auto rounded-xl border border-a-line bg-a-bg/60 p-3.5 text-callout leading-relaxed text-a-ink">
            <Markdown text={shownPrompt} />
          </div>
          {longPrompt && (
            <button type="button" onClick={() => setFullPrompt((v) => !v)} className="w-fit rounded-md px-2 py-1 text-caption hover:bg-a-p3" style={{ color: tile.color }}>
              {fullPrompt ? t("Kürzer anzeigen") : t("Ganzen Prompt zeigen")}
            </button>
          )}
        </section>
      )}
      {tile.path && (
        <p className="relative truncate font-mono text-caption text-a-mut" title={tile.path}>
          {t("Datei: {path}", { path: shortenPath(tile.path, 90) })}
        </p>
      )}

      <section aria-label={t("Einsätze")} className="relative grid gap-1.5">
        <h3 className="font-mono text-label font-semibold uppercase tracking-wider text-a-mut">{t("Letzte Einsätze")} {tile.total > RECENT_RUNS && <span className="normal-case">{t("({shown} von {total})", { shown: RECENT_RUNS, total: tile.total })}</span>}</h3>
        {recent.length === 0 ? (
          <p className="text-caption text-a-mut">{t("Dieser Agent wurde noch nie gestartet. Er steht bereit, sobald eine Session ihn aufruft.")}</p>
        ) : (
          <ul aria-label={t("Letzte Einsätze")} className="grid gap-0.5">
            {recent.map((r) => (
              <li key={r.id} className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-a-p3/60 sm:grid-cols-[96px_minmax(0,1fr)_auto]">
                <VerdictChip run={r} />
                <span className="grid min-w-0">
                  <button type="button" onClick={() => onOpenRun(r.id)} className="truncate text-left text-callout font-medium text-a-ink hover:underline" title={r.agentName ?? undefined}>
                    {r.agentName ?? t("Einsatz")}
                  </button>
                  {r.parentSessionKey ? (
                    <Link to={sessionHref(r.parentSessionKey)} className="w-fit max-w-full truncate text-caption text-a-mut hover:text-a-ink hover:underline">
                      ↳ {r.parentTitle ?? t("Eltern-Session")}
                    </Link>
                  ) : (
                    <span className="text-caption text-a-mut">{t("ohne Eltern-Session")}</span>
                  )}
                </span>
                <span className="whitespace-nowrap font-mono text-caption tabular-nums text-a-mut">
                  {formatDurationMs(r.durationMs)} · {relativeTime(r.startedAt ?? r.endedAt, now) ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
