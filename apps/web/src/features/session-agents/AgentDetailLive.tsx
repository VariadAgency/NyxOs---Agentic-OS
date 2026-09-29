// One agent in detail — what it is doing right now (live steps, current one highlighted), figures, task, result,
// its chat (read only, the same rendering as the session chat) and manage.
import { agentElapsedMs, formatAgentElapsed, locale, t, tc, timeZone, type AgentStep, type LiveAgent } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ChatItem } from "../../components/sessions/ChatItem";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { useLiveTick } from "../../hooks/useLiveTick";
import { useTranscript } from "../../hooks/useSessionApi";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { Markdown } from "../../lib/markdown";
import { sessionHref } from "../git/meta";
import { AgentAvatar, StatusPill } from "./AgentRow";
import { useAgentToTask, useHideAgent, useNow, useSessionAgentLive } from "./api";
import { agentLabel, agentsPageHref, formatCostUsd, formatTokensShort, type SessionRef } from "./model";

const PROMPT_PREVIEW = 600;
const stepTime = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: timeZone() });

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="grid min-w-0 gap-0.5 rounded-xl border border-a-line bg-a-bg/40 px-3 py-2" title={hint}>
      <span className="font-mono text-label tracking-wide text-a-mut uppercase">{label}</span>
      <span data-testid={testId} className="truncate font-mono text-callout font-semibold tabular-nums text-a-ink">
        {value}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="font-mono text-label font-semibold tracking-wider text-a-mut uppercase">{children}</h3>;
}

function StepLine({ step }: { step: AgentStep }) {
  const mark = step.status === "ok" ? "✓" : step.status === "error" ? "✗" : null;
  return (
    <li
      data-testid={step.current ? "agent-step-current" : undefined}
      aria-current={step.current ? "step" : undefined}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 rounded-lg px-2 py-1.5",
        step.current ? "border border-a-ok/40 bg-a-ok/8" : "border border-transparent",
      )}
    >
      <span aria-hidden className={cn("mt-1 h-1.5 w-1.5 shrink-0 self-start rounded-full", step.current ? "cc-pulse bg-a-ok" : step.kind === "tool" ? "bg-a-line-strong" : "bg-a-mut/40")} />
      <span className="min-w-0">
        {step.kind === "tool" ? (
          <span className="block truncate font-mono text-caption">
            <span className="text-a-ink">{step.tool}</span>
            {step.label && <span className="text-a-mut"> · {step.label}</span>}
          </span>
        ) : (
          <span className={cn("line-clamp-2 text-caption", step.kind === "prompt" ? "text-a-mut italic" : "text-a-ink")}>{step.label}</span>
        )}
        {step.current && <span className="text-label text-a-ok">{t("macht er gerade")}</span>}
      </span>
      <span className="font-mono text-label whitespace-nowrap tabular-nums text-a-mut">
        {mark && <span className={cn("mr-1.5", step.status === "ok" ? "text-a-ok" : "text-a-bad")}>{mark}</span>}
        {stepTime(step.ts)}
      </span>
    </li>
  );
}

function AgentChat({ session, agent }: { session: SessionRef; agent: LiveAgent }) {
  // Codex teammates have their own transcript (own session), Claude sub-agents a side transcript of the session.
  const transcriptId = agent.tool === "codex" && agent.sessionKey ? agent.sessionKey : session.id;
  const liveTick = useLiveTick(transcriptId);
  const tr = useTranscript(transcriptId, { subagent: agent.tool === "codex" ? null : agent.id, liveTick });
  if (tr.isLoading && tr.items.length === 0) return <Skeleton className="h-24" />;
  if (tr.isError) return <p className="text-caption text-a-bad">{t("Der Verlauf konnte nicht geladen werden.")}</p>;
  if (tr.items.length === 0) return <p className="text-caption text-a-mut">{t("Noch kein Verlauf archiviert – die Schritte oben kommen live.")}</p>;
  return (
    <div className="cc-scroll grid max-h-[480px] gap-2 overflow-y-auto rounded-xl border border-a-line bg-a-bg/40 p-3" aria-label={t("Verlauf von {name}", { name: agentLabel(agent) })}>
      {tr.hasOlder && (
        <Button variant="ghost" onClick={tr.loadOlder} disabled={tr.loadingOlder} className="min-h-[44px] justify-self-start sm:min-h-0">
          {tr.loadingOlder ? t("Lädt …") : t("Ältere laden")}
        </Button>
      )}
      {tr.items.map((item) => (
        <ChatItem key={item.id} item={item} sessionId={transcriptId} />
      ))}
    </div>
  );
}

interface AgentDetailLiveProps {
  session: SessionRef;
  agentId: string;
  childKeys?: string[];
  onBack: () => void;
  /** In the popup: show the link "open in full screen". */
  inPopup?: boolean;
}

export function AgentDetailLive({ session, agentId, childKeys, onBack, inPopup }: AgentDetailLiveProps) {
  const q = useSessionAgentLive(session.id, agentId, childKeys);
  const running = q.data?.agent.status === "running";
  const now = useNow(running);
  const [fullPrompt, setFullPrompt] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const hide = useHideAgent(session.id);
  const toTask = useAgentToTask(session.id);
  const headRef = useRef<HTMLHeadingElement>(null);
  const loaded = q.data !== undefined;
  // Focus the heading as soon as the detail is there (the clicked row button has disappeared by then).
  useEffect(() => {
    if (loaded) headRef.current?.focus();
  }, [agentId, loaded]);

  const back = (
    <Button variant="ghost" onClick={onBack} className="min-h-[44px] justify-self-start px-2 sm:min-h-0">
      {t("← Alle Agenten")}
    </Button>
  );

  if (q.isPending) {
    return (
      <div className="grid gap-2" data-testid="agent-detail-live">
        {back}
        <Skeleton className="h-16" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid justify-items-start gap-2" data-testid="agent-detail-live">
        {back}
        <p className="text-caption text-a-bad">{t("Dieser Agent konnte nicht geladen werden.")}</p>
        <Button onClick={() => void q.refetch()} className="min-h-[44px] sm:min-h-0">
          {t("Erneut versuchen")}
        </Button>
      </div>
    );
  }

  const { agent, steps, prompt, result, hasTranscript, task, archived } = q.data;
  const label = agentLabel(agent);
  const cost = formatCostUsd(agent.costUsd);
  const shownPrompt = prompt && !fullPrompt && prompt.length > PROMPT_PREVIEW ? `${prompt.slice(0, PROMPT_PREVIEW)} …` : prompt;
  const tokenHint = agent.tokens
    ? t("Eingabe {input} · Ausgabe {output} · aus dem Zwischenspeicher gelesen {cacheRead} · in den Zwischenspeicher geschrieben {cacheCreation}", {
        input: agent.tokens.input.toLocaleString(locale()),
        output: agent.tokens.output.toLocaleString(locale()),
        cacheRead: agent.tokens.cacheRead.toLocaleString(locale()),
        cacheCreation: agent.tokens.cacheCreation.toLocaleString(locale()),
      })
    : t("Noch keine Token-Angabe (ältere Brücke oder Verlauf noch nicht ausgewertet).");

  return (
    <div data-testid="agent-detail-live" className="grid min-w-0 content-start gap-4">
      {back}
      <header className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
        <AgentAvatar agent={agent} size={44} />
        <div className="grid min-w-0 gap-1">
          <h2 ref={headRef} tabIndex={-1} className="truncate font-display text-headline font-semibold text-a-ink outline-none">
            {label}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill agent={agent} />
            {agent.type && agent.type !== label && <span className="rounded bg-a-p3 px-1.5 py-0.5 text-label text-a-mut">{agent.type}</span>}
            {agent.tool === "codex" && <span className="rounded bg-a-p3 px-1.5 py-0.5 text-label text-a-mut">Codex</span>}
          </div>
          {agent.task && <p className="text-caption text-a-mut">{agent.task}</p>}
        </div>
      </header>

      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 md:grid-cols-[repeat(4,minmax(0,1fr))]">
        <Stat label={t("Laufzeit")} value={formatAgentElapsed(agentElapsedMs(agent, now))} testId="agent-detail-elapsed" />
        <Stat label={t("Tokens")} value={agent.tokens ? formatTokensShort(agent.tokens.total) : "—"} hint={tokenHint} />
        <Stat label={t("Werkzeuge")} value={`${agent.toolCalls}×`} />
        <Stat label={cost ? t("Kosten ca.") : t("Modell")} value={cost ?? agent.model ?? "—"} hint={agent.model ?? undefined} />
      </div>

      <section aria-label={running ? t("Was er gerade macht") : t("Letzte Schritte")} className="grid gap-1.5">
        <SectionTitle>{running ? t("Was er gerade macht · neueste oben") : t("Letzte Schritte · neueste oben")}</SectionTitle>
        {steps.length === 0 ? (
          <p className="text-caption text-a-mut">{t("Noch keine Schritte bekannt.")}</p>
        ) : (
          <ol className="grid gap-0.5">
            {[...steps].reverse().map((s) => (
              <StepLine key={s.id} step={s} />
            ))}
          </ol>
        )}
      </section>

      {prompt && (
        <section aria-label={tc("agent", "Auftrag")} className="grid gap-1.5">
          <SectionTitle>{tc("agent", "Auftrag")}</SectionTitle>
          <div className="cc-scroll max-h-[360px] overflow-y-auto rounded-xl border border-a-line bg-a-bg/40 p-3 text-callout leading-relaxed text-a-ink">
            <Markdown text={shownPrompt ?? ""} />
          </div>
          {prompt.length > PROMPT_PREVIEW && (
            <Button variant="ghost" onClick={() => setFullPrompt((v) => !v)} className="min-h-[44px] justify-self-start sm:min-h-0">
              {fullPrompt ? t("Kürzer anzeigen") : t("Ganzen Auftrag zeigen")}
            </Button>
          )}
        </section>
      )}

      {result && (
        <section aria-label={t("Ergebnis")} className="grid gap-1.5">
          <SectionTitle>{t("Ergebnis")}</SectionTitle>
          <div className="cc-scroll max-h-[420px] overflow-y-auto rounded-xl border border-a-line bg-a-bg/40 p-3 text-callout leading-relaxed text-a-ink">
            <Markdown text={result} />
          </div>
        </section>
      )}

      <section aria-label={t("Verlauf")} className="grid gap-1.5">
        <SectionTitle>{t("Verlauf")}</SectionTitle>
        {showChat ? (
          <AgentChat session={session} agent={agent} />
        ) : (
          <Button onClick={() => setShowChat(true)} className="min-h-[44px] justify-self-start sm:min-h-0" disabled={!hasTranscript && agent.tool !== "codex"}>
            {hasTranscript || agent.tool === "codex" ? t("Verlauf anzeigen") : t("Verlauf noch nicht archiviert")}
          </Button>
        )}
      </section>

      <section aria-label={t("Verwalten")} className="grid gap-1.5">
        <SectionTitle>{t("Verwalten")}</SectionTitle>
        <div className="flex flex-wrap gap-2 [&>*]:min-h-[44px] sm:[&>*]:min-h-0">
          {task ? (
            <Link to={task.href} className="inline-flex items-center rounded-md border border-a-acc/40 bg-a-acc/10 px-2.5 py-1.5 text-caption text-a-acc hover:bg-a-acc/20">
              {t("Aufgabe öffnen →")}
            </Link>
          ) : (
            <Button onClick={() => toTask.mutate(agent.id)} disabled={toTask.isPending}>
              {toTask.isPending ? t("Übernimmt …") : t("In Aufgaben übernehmen")}
            </Button>
          )}
          {agent.sessionKey && (
            <Link to={sessionHref(agent.sessionKey)} className="inline-flex items-center rounded-md border border-a-line bg-a-p3 px-2.5 py-1.5 text-caption text-a-ink hover:bg-a-p2">
              {t("Eigene Session öffnen")}
            </Link>
          )}
          {inPopup && (
            <Link to={agentsPageHref(session, agent.id)} className="inline-flex items-center rounded-md border border-a-line bg-a-p3 px-2.5 py-1.5 text-caption text-a-ink hover:bg-a-p2">
              {t("Im Vollbild öffnen")}
            </Link>
          )}
          {!running &&
            archived &&
            (agent.hidden ? (
              <Button variant="ghost" onClick={() => hide.mutate({ agentId: agent.id, hidden: false })} disabled={hide.isPending}>
                {t("Wieder einblenden")}
              </Button>
            ) : confirmHide ? (
              <span role="group" aria-label={t("Ausblenden bestätigen")} className="inline-flex flex-wrap items-center gap-2 rounded-md border border-a-wait/35 bg-a-wait/8 px-2 py-1 text-caption text-a-ink [&_button]:min-h-[44px] sm:[&_button]:min-h-0">
                {t("Im Archiv ausblenden? (lässt sich wieder einblenden)")}
                <Button
                  variant="warn"
                  onClick={() => hide.mutate({ agentId: agent.id, hidden: true }, { onSuccess: () => setConfirmHide(false) })}
                  disabled={hide.isPending}
                >
                  {t("Ausblenden")}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmHide(false)}>
                  {t("Abbrechen")}
                </Button>
              </span>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmHide(true)}>
                {t("Ausblenden")}
              </Button>
            ))}
        </div>
        {toTask.isSuccess && (
          <p role="status" className="text-caption text-a-ok">
            {toTask.data.existing ? t("Steht schon in den Aufgaben.") : t("In die Aufgaben übernommen.")}{" "}
            <Link to={toTask.data.entry.href} className="inline-flex min-h-[44px] items-center underline sm:min-h-0">
              {t("Öffnen")}
            </Link>
          </p>
        )}
        {(toTask.isError || hide.isError) && <p className="text-caption text-a-bad">{friendlyError(toTask.error ?? hide.error, t("Das hat nicht geklappt. Bitte noch einmal versuchen."))}</p>}
        {running && <p className="text-caption text-a-mut">{t("Einen einzelnen Agenten kann man nicht anhalten – nur die ganze Session (Esc im Terminal).")}</p>}
      </section>
    </div>
  );
}
