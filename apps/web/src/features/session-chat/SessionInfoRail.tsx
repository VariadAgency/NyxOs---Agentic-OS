// Vollbild-Chat: Die Infos rechts klappen zu einem dünnen Balken zusammen — Symbole mit
// Mini-Werten (Modell, Kontext, Tokens, Werkzeuge, Sub-Agenten, Dateien, Dauer, Prüfung). Ein Klick
// irgendwo auf den Balken klappt die volle Spalte wieder auf. Der Zustand wird gemerkt (localStorage).
import type { ReactNode } from "react";
import { formatTokensCompact, locale, t } from "@nyxos/shared";
import type { Session, SessionDetail } from "../../lib/api";
import { duration } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useTooltip } from "../../components/ui/Tooltip";
import { currentModel, shortModel } from "./model";
import { useSessionAudits } from "./api";
import { SummaryButton } from "./SessionSummary";
import { IconAgents, IconAudit, IconChip, IconClock, IconFiles, IconPanelOpen, IconTokens, IconWrench } from "./icons";

const COLLAPSE_KEY = "nyxos.session.infoCollapsed";

export function readInfoCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeInfoCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  } catch {
    // Speicher gesperrt — dann gilt es nur bis zum Neuladen.
  }
}

/** Dieselbe Schreibweise wie überall („3,9 Mrd.“, „1,2 Mio.“, „12.345“) — aus `@nyxos/shared`. */
export function compactNumber(n: number): string {
  return formatTokensCompact(n);
}

function Stat({ icon, value, label, tone }: { icon: ReactNode; value: ReactNode; label: string; tone?: string }) {
  const tip = useTooltip(label);
  return (
    <div className="grid justify-items-center gap-0.5 px-0.5 py-1.5 text-center" {...tip.triggerProps}>
      <span className={cn("text-a-mut", tone)}>{icon}</span>
      <span /* typo-keep: Wert in der 48-px-Leiste */ className="max-w-full font-mono text-[9.5px] leading-tight break-words text-a-ink">{value}</span>
      <span className="sr-only">{label}</span>
      {tip.tooltip}
    </div>
  );
}

/** „haiku-4-5“ → „haiku“ / „4-5“ in zwei Zeilen (passt in den 48-px-Balken, bricht nie mitten im Namen). */
function ModelLines({ model }: { model: string }) {
  const i = model.indexOf("-");
  if (i < 0) return <>{model}</>;
  return (
    <>
      {model.slice(0, i)}
      <br />
      {model.slice(i + 1)}
    </>
  );
}

function MiniRing({ pct }: { pct: number | null }) {
  const color = pct === null ? "var(--a-dim)" : pct >= 80 ? "var(--a-bad)" : pct >= 60 ? "var(--a-wait)" : "var(--a-ok)";
  return (
    <span className="grid h-6 w-6 place-items-center rounded-full" style={{ background: `conic-gradient(${color} ${(pct ?? 0) * 3.6}deg, var(--a-p3) 0deg)` }}>
      <span /* typo-keep: Zahl im 18-px-Ring */ className="grid h-[18px] w-[18px] place-items-center rounded-full bg-a-p font-mono text-[8.5px] text-a-ink">{pct ?? "–"}</span>
    </span>
  );
}

export function SessionInfoRail({ session, detail, onExpand, onSummary }: { session: Session; detail: SessionDetail | undefined; onExpand: () => void; onSummary?: () => void }) {
  const audits = useSessionAudits(session.id);
  const audit = audits.data?.audits[0];
  const model = currentModel(session);
  const written = detail?.files.filter((f) => f.mode === "write").length ?? 0;
  const toolCalls = Object.values(session.toolCalls ?? {}).reduce((a, b) => a + b, 0);
  const running = session.status === "running";
  const auditTone = !audit ? "text-a-mut" : audit.status === "running" ? "text-a-acc" : audit.status === "error" ? "text-a-wait" : "text-a-done";

  return (
    <aside data-testid="session-info-rail" aria-label={t("Session-Infos (eingeklappt)")} className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-a-line bg-a-p">
      <button
        type="button"
        onClick={onExpand}
        aria-label={t("Infos ausklappen")}
        title={t("Infos ausklappen")}
        className="grid h-10 shrink-0 place-items-center border-b border-a-line text-a-mut transition-colors hover:bg-a-p2 hover:text-a-acc"
      >
        <IconPanelOpen size={16} />
      </button>
      {/* Auch eingeklappt erreichbar – eigener Knopf, nicht Teil der Aufklapp-Fläche. */}
      <div className="grid shrink-0 place-items-center border-b border-a-line py-1.5">
        <SummaryButton sessionId={session.id} variant="icon" onTriggered={onSummary} className="border-0" />
      </div>
      {/* Der ganze Balken ist Klickfläche zum Aufklappen (Tastatur: der Knopf oben). */}
      <div role="presentation" onClick={onExpand} className="cc-scroll grid min-h-0 flex-1 cursor-pointer content-start divide-y divide-a-line overflow-y-auto hover:bg-a-p2/40">
        <Stat icon={<IconChip size={15} />} value={model ? <ModelLines model={shortModel(model)} /> : "–"} label={`${t("Modell: {model}", { model: model ?? t("unbekannt") })}${session.models.length > 1 ? ` ${t("(in dieser Session: {models})", { models: session.models.join(", ") })}` : ""}`} tone="text-[var(--a-claude)]" />
        <Stat icon={<MiniRing pct={session.contextPct} />} value={session.contextPct === null ? "–" : `${session.contextPct} %`} label={session.contextPct === null ? t("Kontext: unbekannt") : t("Kontext {pct} % voll", { pct: session.contextPct })} />
        <Stat icon={<IconTokens size={15} />} value={compactNumber(session.tokensTotal)} label={t("{n} Tokens", { n: new Intl.NumberFormat(locale()).format(session.tokensTotal) })} tone="text-a-violet" />
        <Stat icon={<IconWrench size={15} />} value={compactNumber(toolCalls)} label={t("{n} Werkzeug-Aufrufe", { n: toolCalls })} tone="text-a-indigo" />
        <Stat icon={<IconAgents size={15} />} value={session.subagents.length} label={t("{n} Sub-Agenten", { n: session.subagents.length })} tone="text-a-conf" />
        <Stat icon={<IconFiles size={15} />} value={written} label={t("{n} Dateien geschrieben", { n: written })} tone="text-a-lime" />
        <Stat icon={<IconClock size={15} />} value={duration(session.startedAt, running ? null : session.endedAt)} label={running ? t("Läuft seit") : t("Dauer")} tone="text-a-done" />
        <Stat
          icon={<IconAudit size={15} />}
          value={!audit ? "–" : audit.status === "running" ? t("läuft") : audit.status === "error" ? "!" : (audit.result?.offen.length ?? 0)}
          label={!audit ? t("Noch keine Prüfung") : audit.status === "running" ? t("Nyx prüft gerade") : audit.status === "error" ? t("Prüfung nicht fertig geworden") : t("Prüfung: {n} Punkte offen", { n: audit.result?.offen.length ?? 0 })}
          tone={auditTone}
        />
      </div>
    </aside>
  );
}
