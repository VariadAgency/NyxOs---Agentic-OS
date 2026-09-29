// Tab „Skills“: die Skill-Bibliothek als Kacheln. Je Kachel Zweck, Herkunft (bunt), wie oft und wann
// zuletzt genutzt (echte Zahlen aus den Session-Protokollen), Mini-Verlauf 30 Tage und Zustand (Vorschläge
// offen, zuletzt verbessert, Opus arbeitet). Klick → Großansicht (`/skills/:key`). „Neuer Skill“ startet
// immer eine sichtbare Opus-5.5-Session. Kachel-Aufbau nach ClawHub `SkillCard.tsx` (MIT, s. NOTICE).
import { locale, SKILL_SOURCE_LABEL, t, type SkillSource, type SkillTile } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { PageShell } from "../../components/PageShell";
import { Sparkline, StatCard } from "../../components/charts";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/friendlyError";
import { SOURCE_COLOR, fetchSkills, skillsKey, syncSkills, tint } from "./api";
import { SkillJobDialog, type JobDialogMode } from "./SkillJobDialog";

const DAY_MS = 86_400_000;
const STALE_DAYS = 30;
const numberFmt = new Intl.NumberFormat(locale());

type Sort = "uses" | "recent" | "name";
const SORT_LABEL: Record<Sort, string> = { uses: t("Meist genutzt"), recent: t("Zuletzt genutzt"), name: "A–Z" };

export function SourceChip({ source, plugin, className }: { source: SkillSource; plugin?: string | null; className?: string }) {
  const color = SOURCE_COLOR[source];
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2 py-0.5 text-label font-medium", className)} style={{ color, background: tint(color) }}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{SKILL_SOURCE_LABEL[source]}{plugin ? ` · ${plugin}` : ""}</span>
    </span>
  );
}

/** Nutzungszeile: „12× genutzt · zuletzt vor 2 T“ bzw. ehrlich „noch nie genutzt“ / „seit 40 T ungenutzt“. */
export function usageLine(tile: Pick<SkillTile, "uses" | "lastUsedAt">, now: number): { text: string; tone: "ink" | "mut" | "wait" } {
  if (tile.uses === 0 || !tile.lastUsedAt) return { text: t("noch nie genutzt"), tone: "mut" };
  const days = Math.floor((now - Date.parse(tile.lastUsedAt)) / DAY_MS);
  const when = relativeTime(tile.lastUsedAt, now) ?? "";
  if (days >= STALE_DAYS) return { text: t("{n}× genutzt · seit {days} T ungenutzt", { n: numberFmt.format(tile.uses), days }), tone: "wait" };
  return { text: t("{n}× genutzt · zuletzt {when}", { n: numberFmt.format(tile.uses), when }), tone: "ink" };
}

function Tile({ tile, index, now, onOpen }: { tile: SkillTile; index: number; now: number; onOpen: () => void }) {
  const color = SOURCE_COLOR[tile.source];
  const usage = usageLine(tile, now);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-nyx={`skill-${tile.key}`}
      // Wohin der Klick führt – der Nyx-Cursor geht so Schritt für Schritt bis /skills/<key>.
      data-nyx-href={`/skills/${encodeURIComponent(tile.key)}`}
      data-skill-tile={tile.key}
      className="cc-stagger cc-card-deep group relative grid min-w-0 content-start gap-2 overflow-hidden rounded-2xl border border-a-line p-4 text-left transition-[border-color,transform,background-color,box-shadow] duration-200 ease-apple hover:-translate-y-px hover:border-[color:color-mix(in_srgb,var(--tile-c)_50%,transparent)] hover:bg-a-p2 hover:shadow-raise focus-visible:outline-2 focus-visible:outline-a-acc motion-reduce:hover:translate-y-0"
      style={{ animationDelay: `${Math.min(index, 12) * 25}ms`, ["--tile-c" as string]: color }}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <SourceChip source={tile.source} plugin={tile.plugin} />
        <span className="flex shrink-0 items-center gap-1">
          {tile.pinned && <span className="rounded-full bg-a-violet/15 px-1.5 py-0.5 text-label font-medium text-a-violet" title={t("Angepinnt: Nyx macht keine Vorschläge")}>{t("angepinnt")}</span>}
          {!tile.writable && tile.source !== "builtin" && <span className="rounded-full bg-a-p3 px-1.5 py-0.5 text-label text-a-mut" title={t("Gehört einem Plugin bzw. Claude.ai – nur lesen")}>{t("nur lesen")}</span>}
        </span>
      </span>
      <span className="truncate font-mono text-callout font-semibold text-a-ink">/{tile.key}</span>
      <span className="line-clamp-2 min-h-[34px] text-caption leading-[17px] text-a-mut">{tile.description ?? (tile.source === "builtin" ? t("In Claude Code eingebaut – bekannt aus der Nutzung.") : t("Ohne Beschreibung."))}</span>
      <Sparkline values={tile.daily} height={30} color={color} label={t("Aufrufe der letzten 30 Tage, heute {n}", { n: tile.daily.at(-1) ?? 0 })} />
      <span className={cn("truncate text-caption tabular-nums", usage.tone === "wait" ? "text-a-wait" : usage.tone === "mut" ? "text-a-mut" : "text-a-ink")}>{usage.text}</span>
      <span className="flex min-h-[22px] flex-wrap items-center gap-1.5">
        {tile.runningJob && (
          <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-label font-medium" style={{ color: "var(--a-claude)", background: tint("var(--a-claude)") }}>
            <span aria-hidden className="cc-pulse h-1.5 w-1.5 rounded-full" style={{ background: "var(--a-claude)" }} />
            {t("Opus arbeitet daran")}
          </span>
        )}
        {tile.openSuggestions > 0 && (
          <span className="rounded-full bg-a-wait/15 px-2 py-0.5 text-label font-medium text-a-wait">
            {tile.openSuggestions === 1 ? t("1 Vorschlag offen") : t("{n} Vorschläge offen", { n: tile.openSuggestions })}
          </span>
        )}
        {tile.lastImprovedAt && <span className="rounded-full bg-a-ok/12 px-2 py-0.5 text-label font-medium text-a-ok">{t("verbessert {when}", { when: relativeTime(tile.lastImprovedAt, now) })}</span>}
        {tile.missing && <span className="rounded-full bg-a-bad/12 px-2 py-0.5 text-label font-medium text-a-bad">{t("fehlt auf deinem Rechner")}</span>}
      </span>
    </button>
  );
}

function BridgeNote({ state, onRetry, busy }: { state: "offline" | "zu_alt"; onRetry: () => void; busy: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-a-wait/40 bg-a-wait/10 px-4 py-3 text-callout text-a-wait">
      <span>
        {state === "offline"
          ? t("Dein Rechner ist gerade nicht verbunden. Du siehst den zuletzt gelesenen Stand – Nutzungszahlen stimmen trotzdem.")
          : t("Die Brücke ist noch auf einem alten Stand und kennt die Skill-Bibliothek nicht. Nach dem nächsten Update liest sie die Skills.")}
      </span>
      <Button variant="warn" onClick={onRetry} disabled={busy}>
        {busy ? t("Prüfe …") : t("Noch einmal prüfen")}
      </Button>
    </div>
  );
}

export function SkillsView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: skillsKey, queryFn: fetchSkills, refetchInterval: 60_000 });
  const [source, setSource] = useState<SkillSource | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("uses");
  const [dialog, setDialog] = useState<JobDialogMode | null>(null);
  const sync = useMutation({ mutationFn: syncSkills, onSettled: () => void queryClient.invalidateQueries({ queryKey: skillsKey }) });
  const now = Date.now();

  const tiles = useMemo(() => q.data?.skills ?? [], [q.data]);
  const sources = useMemo(() => {
    const counts = new Map<SkillSource, number>();
    for (const tile of tiles) counts.set(tile.source, (counts.get(tile.source) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [tiles]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = tiles.filter((x) => (source === "all" || x.source === source) && (!needle || x.key.toLowerCase().includes(needle) || (x.description ?? "").toLowerCase().includes(needle)));
    const byRecent = (x: SkillTile) => (x.lastUsedAt ? Date.parse(x.lastUsedAt) : 0);
    return [...list].sort((a, b) => (sort === "name" ? a.key.localeCompare(b.key) : sort === "recent" ? byRecent(b) - byRecent(a) || a.key.localeCompare(b.key) : b.uses - a.uses || byRecent(b) - byRecent(a) || a.key.localeCompare(b.key)));
  }, [tiles, source, query, sort]);

  const daily = useMemo(() => {
    const out = new Array<number>(30).fill(0);
    for (const tile of tiles) tile.daily.forEach((v, i) => (out[i] = (out[i] ?? 0) + v));
    return out;
  }, [tiles]);
  const calls30 = daily.reduce((a, b) => a + b, 0);
  const openSuggestions = tiles.reduce((n, x) => n + x.openSuggestions, 0);
  const improved30 = tiles.filter((x) => x.lastImprovedAt && now - Date.parse(x.lastImprovedAt) < 30 * DAY_MS).length;
  const unused = tiles.filter((x) => x.uses === 0 && x.source !== "builtin").length;

  return (
    <PageShell gap="gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="font-display text-title font-semibold text-a-ink">Skills</h1>
          <p className="text-callout text-a-mut">{t("Deine Skill-Bibliothek: was es gibt, wie oft es läuft und was besser werden kann. Neue und bessere Skills schreibt immer Opus 5.5.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => sync.mutate()} disabled={sync.isPending} data-nyx="skills-sync">
            {sync.isPending ? t("Lese ein …") : t("Neu einlesen")}
          </Button>
          <Button variant="primary" onClick={() => setDialog({ kind: "create" })} data-nyx="skills-new">
            ＋ {t("Neuer Skill")}
          </Button>
        </div>
      </header>

      {q.data && q.data.bridge !== "online" && <BridgeNote state={q.data.bridge} onRetry={() => sync.mutate()} busy={sync.isPending} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard id="skills-count" label="Skills" value={q.data ? tiles.length : null} format={(n) => numberFmt.format(Math.round(n))} caption={unused > 0 ? t("{n} noch nie genutzt", { n: unused }) : t("alle schon genutzt")} />
        <StatCard id="skills-calls" label={t("Aufrufe · 30 Tage")} value={q.data ? calls30 : null} format={(n) => numberFmt.format(Math.round(n))} sparkline={daily} sparklineLabel={t("Skill-Aufrufe je Tag")} caption={t("aus den Session-Protokollen")} />
        <StatCard id="skills-suggestions" label={t("Vorschläge offen")} value={q.data ? openSuggestions : null} format={(n) => numberFmt.format(Math.round(n))} caption={openSuggestions > 0 ? t("Nyx hat etwas gefunden") : t("nichts offen")} captionTone={openSuggestions > 0 ? "wait" : undefined} />
        <StatCard id="skills-improved" label={t("Verbessert · 30 Tage")} value={q.data ? improved30 : null} format={(n) => numberFmt.format(Math.round(n))} caption={t("mit Opus 5.5")} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setSource("all")}
          aria-pressed={source === "all"}
          className={cn("rounded-full border px-2.5 py-1 text-caption transition-colors", source === "all" ? "border-a-acc bg-a-acc/15 text-a-ink" : "border-a-line text-a-mut hover:text-a-ink")}
        >
          {t("Alle")} <span className="tabular-nums">{tiles.length}</span>
        </button>
        {sources.map(([s, n]) => (
          <button
            key={s}
            type="button"
            onClick={() => setSource(source === s ? "all" : s)}
            aria-pressed={source === s}
            className="rounded-full border px-2.5 py-1 text-caption transition-colors"
            style={source === s ? { borderColor: SOURCE_COLOR[s], background: tint(SOURCE_COLOR[s], 18), color: SOURCE_COLOR[s] } : { borderColor: "var(--a-line)", color: SOURCE_COLOR[s] }}
          >
            {SKILL_SOURCE_LABEL[s]} <span className="tabular-nums opacity-80">{n}</span>
          </button>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Skill suchen …")}
            aria-label={t("Skill suchen")}
            className="h-(--a-ctl-h) w-[200px] rounded-lg border border-a-line bg-a-bg/60 px-2.5 text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc/60 focus:outline-none"
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("Sortieren")} className="h-(--a-ctl-h) rounded-lg border border-a-line bg-a-bg/60 px-2 text-callout text-a-ink">
            {(Object.keys(SORT_LABEL) as Sort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </select>
        </span>
      </div>

      {q.isPending ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-[190px] rounded-xl" />
          ))}
        </div>
      ) : q.isError ? (
        <div className="grid min-h-[160px] place-items-center gap-2 rounded-xl border border-a-line text-center text-callout text-a-mut">
          <span>{friendlyError(q.error, t("Die Skills ließen sich gerade nicht laden."))}</span>
          <Button onClick={() => void q.refetch()}>{t("Erneut versuchen")}</Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="grid min-h-[160px] place-items-center gap-2 rounded-xl border border-dashed border-a-line text-center text-callout text-a-mut">
          {tiles.length === 0 ? (
            <>
              <span>{t("Noch keine Skills gelesen. Sobald dein Rechner verbunden ist, erscheinen sie hier.")}</span>
              <Button variant="primary" onClick={() => setDialog({ kind: "create" })}>
                {t("Ersten Skill mit Opus 5.5 anlegen")}
              </Button>
            </>
          ) : (
            <span>{t("Kein Skill passt zu dieser Suche.")}</span>
          )}
        </div>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]" data-testid="skills-grid">
          {visible.map((x, i) => (
            <Tile key={x.key} tile={x} index={i} now={now} onOpen={() => navigate(`/skills/${encodeURIComponent(x.key)}`)} />
          ))}
        </div>
      )}

      {dialog && <SkillJobDialog mode={dialog} onClose={() => setDialog(null)} />}
    </PageShell>
  );
}
