// Agenten-Kachel. Klein: Name, Art, Urteil, Tokens, Dauer, Werkzeuge, Dateien. Klick → die
// Kachel wächst in der Seite (animiert, kein neuer Tab) und zeigt Auftrag, Ergebnis, Tokens im
// Einzelnen, Werkzeuge je Anzahl und geänderte Dateien. Daten aus dem Sub-Agent-Verlauf (Server).
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { formatTokensCompact, locale, t, type AgentTokens, type AgentVerdict, type SessionAgentDetail, type SessionAgentSummary } from "@nyxos/shared";
import { formatDurationMs } from "../agents/format";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Markdown } from "../../lib/markdown";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { useSessionAgent } from "./api";
import { FileChanges } from "./FileChanges";
import { DiffStat, FilePath } from "./FilePath";

const fullFmt = new Intl.NumberFormat(locale());

const VERDICT: Record<AgentVerdict, { label: string; cls: string }> = {
  PASS: { label: "PASS", cls: "bg-a-ok/12 text-a-ok" },
  PASS_WITH_NOTES: { label: t("mit Hinweisen"), cls: "bg-a-wait/12 text-a-wait" },
  BLOCK: { label: "BLOCK", cls: "bg-a-bad/12 text-a-bad" },
};

function VerdictPill({ verdict }: { verdict: AgentVerdict | null }) {
  if (!verdict) return null;
  const v = VERDICT[verdict];
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-label font-medium", v.cls)}>{v.label}</span>;
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1" title={title}>
      <span className="text-a-mut">{label}</span>
      <span className="font-mono text-a-ink tabular-nums">{value}</span>
    </span>
  );
}

/** Langer Text, eingeklappt auf ein paar Zeilen, mit „Ganzen … zeigen". */
function Collapsible({ text, showLabel, hideLabel, markdown = false, testId }: { text: string; showLabel: string; hideLabel: string; markdown?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 7;
  return (
    <div data-testid={testId}>
      <div className={cn("relative text-caption leading-relaxed text-a-ink", !open && long && "max-h-[8.5rem] overflow-hidden")}>
        {markdown ? <Markdown text={text} /> : <p className="whitespace-pre-wrap break-words">{text}</p>}
        {!open && long && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-a-p2 to-transparent" />}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-caption font-medium text-a-acc hover:underline" aria-expanded={open}>
          {open ? hideLabel : showLabel}
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h6 className="font-mono text-label font-semibold uppercase tracking-wide text-a-mut">{title}</h6>
      {children}
    </section>
  );
}

function TokenTable({ tokens }: { tokens: AgentTokens }) {
  const rows: [string, number][] = [
    [t("Eingabe"), tokens.input],
    [t("Ausgabe"), tokens.output],
    [t("Cache gelesen"), tokens.cacheRead],
    [t("Cache geschrieben"), tokens.cacheCreation],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-caption" data-testid="agent-tokens">
      {rows.map(([label, n]) => (
        <div key={label} className="contents">
          <dt className="text-a-mut">{label}</dt>
          <dd className="font-mono tabular-nums text-a-ink">{fullFmt.format(n)}</dd>
        </div>
      ))}
      <dt className="font-semibold text-a-ink">{t("Gesamt")}</dt>
      <dd className="font-mono font-semibold tabular-nums text-a-ink">{fullFmt.format(tokens.total)}</dd>
    </dl>
  );
}

export function AgentDetailBody({ sessionId, agentId, sessionHref }: { sessionId: string; agentId: string; sessionHref: string | null }) {
  const q = useSessionAgent(sessionId, agentId);
  const [openFile, setOpenFile] = useState<string | null>(null);
  if (q.isPending) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="flex items-center gap-2 text-caption">
        <span className="text-a-bad">{t("Die Details dieses Agenten konnten nicht geladen werden.")}</span>
        <Button variant="ghost" onClick={() => q.refetch()}>
          {t("Erneut versuchen")}
        </Button>
      </div>
    );
  }
  const a: SessionAgentDetail = q.data;
  if (!a.hasTranscript) {
    return <p className="text-caption text-a-mut">{t("Für diesen Agenten liegt noch kein Verlauf vor — meist läuft er gerade erst an. Die Details erscheinen, sobald die Brücke seinen Verlauf nachgereicht hat.")}</p>;
  }
  return (
    <div className="grid gap-4">
      <Section title={t("Aufgabe")}>{a.prompt ? <Collapsible text={a.prompt} showLabel={t("Ganzen Auftrag zeigen")} hideLabel={t("Auftrag einklappen")} testId="agent-prompt" /> : <p className="text-caption text-a-mut">{t("Kein Auftrag im Verlauf gefunden.")}</p>}</Section>
      <Section title={t("Ergebnis")}>
        {a.result ? <Collapsible text={a.result} showLabel={t("Ganzes Ergebnis zeigen")} hideLabel={t("Ergebnis einklappen")} markdown testId="agent-result" /> : <p className="text-caption text-a-mut">{t("Noch keine Antwort — der Agent arbeitet noch oder wurde abgebrochen.")}</p>}
      </Section>
      <div className="grid gap-4 sm:grid-cols-2">
        <Section title={t("Tokens")}>{a.tokens ? <TokenTable tokens={a.tokens} /> : <p className="text-caption text-a-mut">{t("Keine Angabe im Verlauf.")}</p>}</Section>
        <Section title={t("Zeit")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-caption">
            <dt className="text-a-mut">{t("Dauer")}</dt>
            <dd className="font-mono text-a-ink">{formatDurationMs(a.durationMs)}</dd>
            <dt className="text-a-mut">{t("Start")}</dt>
            <dd className="text-a-ink">{formatDateTime(a.startedAt)}</dd>
            <dt className="text-a-mut">{t("Ende")}</dt>
            <dd className="text-a-ink">{formatDateTime(a.endedAt)}</dd>
            {a.model && (
              <>
                <dt className="text-a-mut">{t("Modell")}</dt>
                <dd className="font-mono text-a-ink">{a.model}</dd>
              </>
            )}
          </dl>
        </Section>
      </div>
      <Section title={t("Werkzeuge ({n})", { n: a.toolCalls })}>
        {a.tools.length === 0 ? (
          <p className="text-caption text-a-mut">{t("Keine Werkzeuge benutzt.")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5" data-testid="agent-tools">
            {a.tools.map((tool) => (
              <span key={tool.name} className="inline-flex items-baseline gap-1 rounded-md border border-a-line bg-a-p3 px-1.5 py-0.5 text-label">
                <span className="text-a-ink">{tool.name}</span>
                <span className="font-mono text-a-acc">{tool.count}</span>
              </span>
            ))}
            {a.toolErrors > 0 && <span className="rounded-md bg-a-bad/12 px-1.5 py-0.5 text-label text-a-bad">{t("{n} fehlgeschlagen", { n: a.toolErrors })}</span>}
          </div>
        )}
      </Section>
      <Section title={t("Geänderte Dateien ({n})", { n: a.files.length })}>
        {a.files.length === 0 ? (
          <p className="text-caption text-a-mut">{t("Dieser Agent hat keine Datei geändert.")}</p>
        ) : (
          <ul className="grid gap-0.5 text-caption">
            {a.files.map((f) => (
              <li key={f.path} className={cn("rounded", openFile === f.path && "bg-a-p3")}>
                <button type="button" onClick={() => setOpenFile(openFile === f.path ? null : f.path)} className="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-a-p3" aria-expanded={openFile === f.path}>
                  <FilePath path={f.path} className="flex-1" />
                  <DiffStat added={f.added} removed={f.removed} edits={f.edits} />
                </button>
                {openFile === f.path && (
                  <div className="px-1.5 pb-2">
                    {/* Codex: die Änderungen liegen bei der Kind-Session; Claude: nur die dieses Agenten. */}
                    <FileChanges sessionId={a.sessionKey ?? sessionId} path={f.path} agent={a.sessionKey ? null : a.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {sessionHref && (
        <div>
          <Link to={sessionHref} className="text-caption font-medium text-a-acc hover:underline">
            {t("Verlauf dieses Agenten als eigene Session öffnen →")}
          </Link>
        </div>
      )}
    </div>
  );
}

export function AgentTile({
  sessionId,
  agent,
  open,
  onToggle,
  sessionHref = null,
}: {
  sessionId: string;
  agent: SessionAgentSummary;
  open: boolean;
  onToggle: () => void;
  sessionHref?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [open]);
  const title = agent.name ?? (agent.type ? t("Agent ({type})", { type: agent.type }) : t("Sub-Agent ohne Namen"));
  return (
    <div
      ref={ref}
      data-testid="agent-tile"
      data-open={open || undefined}
      className={cn(
        "min-w-0 rounded-lg border bg-a-p2 transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none",
        open ? "border-a-acc/60 shadow-[0_0_0_1px_var(--a-acc),0_8px_24px_-12px_rgba(0,0,0,0.6)]" : "border-a-line hover:border-a-mut/50",
      )}
    >
      <button type="button" onClick={onToggle} aria-expanded={open} className="grid w-full min-w-0 gap-1 px-3 py-2 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", agent.tool === "codex" ? "bg-[var(--a-codex)]" : "bg-[var(--a-claude)]")} />
          <span className="min-w-0 flex-1 truncate text-caption font-medium text-a-ink">{title}</span>
          {agent.type && agent.name && <span className="shrink-0 rounded border border-a-line px-1.5 font-mono text-label text-a-mut">{agent.type}</span>}
          <VerdictPill verdict={agent.verdict} />
          <span aria-hidden="true" className={cn("shrink-0 text-a-mut transition-transform duration-200 motion-reduce:transition-none", open && "rotate-90")}>
            ▸
          </span>
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 pl-4 text-label">
          {agent.tokens ? <Metric label={t("Tokens")} value={formatTokensCompact(agent.tokens.total)} title={t("{n} Tokens", { n: fullFmt.format(agent.tokens.total) })} /> : <Metric label={t("Tokens")} value="—" />}
          <Metric label={t("Dauer")} value={formatDurationMs(agent.durationMs)} />
          <Metric label={t("Werkzeuge")} value={String(agent.toolCalls)} />
          <Metric label={t("Dateien")} value={String(agent.filesWritten)} />
          {!agent.hasTranscript && <span className="text-a-wait">{t("Verlauf folgt")}</span>}
        </span>
      </button>
      {/* Wachsen per `grid-template-rows` 0fr → 1fr: echte Höhen-Animation ohne feste Maße. */}
      <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">{open && <div className="border-t border-a-line px-3 py-3">{<AgentDetailBody sessionId={sessionId} agentId={agent.id} sessionHref={sessionHref} />}</div>}</div>
      </div>
    </div>
  );
}
