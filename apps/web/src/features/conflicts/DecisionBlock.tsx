// „Was muss ich entscheiden?“ — ganz oben auf der Konflikte-Seite. Je Konflikt ein Satz in
// einfacher Sprache und große Knöpfe, die wirklich etwas tun (Reservierung, Hinweis über tmux,
// Esc über die Brücke, Ignorieren als eigener Zustand). Was nicht geht, sagt der Knopf ehrlich.
import { friendlyError } from "../../lib/friendlyError";
import { isDecisionReservation, t, type ConflictDecision, type ConflictsSummary } from "@nyxos/shared";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { AskNyxButton } from "../../components/nyx/AskNyxButton";
import { useDismissDecision, usePauseSessions, usePreferSession, useReleaseReservation, useReopenDecision, useReserveDecision } from "../../hooks/useConflicts";
import { sessionColor } from "./collisionGroups";
import { decidedLabel, decisionFacts, decisionRisk, decisionSentence, pauseAvailability, reasonText, sessionLetter, sessionName, SEVERITY_CLASS, SEVERITY_LABEL } from "./decisionText";

/** Wie viele offene Fragen sofort sichtbar sind — der Rest ist einen Klick entfernt. */
const OPEN_PREVIEW = 5;

type Feedback = { tone: "ok" | "warn" | "bad"; text: string };

const BIG = "inline-flex min-h-11 items-center justify-center rounded-lg border px-4 py-2 text-callout font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const BIG_PRIMARY = `${BIG} border-a-acc bg-a-acc/15 text-a-acc hover:bg-a-acc/25`;
const BIG_DEFAULT = `${BIG} border-a-line bg-a-p2 text-a-ink hover:bg-a-p3`;
const BIG_QUIET = `${BIG} border-transparent bg-transparent text-a-mut hover:bg-a-p2 hover:text-a-ink`;

function letterOf(d: ConflictDecision, sessionKey: string): string {
  const i = d.sessions.findIndex((s) => s.sessionKey === sessionKey);
  return i >= 0 ? sessionLetter(i) : "?";
}

function errorText(e: unknown): string {
  return friendlyError(e, t("Das hat nicht geklappt."));
}

function SessionLegend({ d }: { d: ConflictDecision }) {
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5">
      {d.sessions.map((s, i) => (
        <li key={s.sessionKey} className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-a-line bg-a-p2 py-0.5 pl-1 pr-2.5 text-caption" title={sessionName(s)}>
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-label font-semibold text-a-on-primary" style={{ backgroundColor: sessionColor(s.sessionKey) }}>
            {sessionLetter(i)}
          </span>
          <span className="min-w-0 truncate text-a-ink">{sessionName(s)}</span>
          <span className="shrink-0 text-a-mut">· {s.inNyxOS ? t("läuft in NyxOS") : t("Terminal-Programm")}</span>
        </li>
      ))}
    </ul>
  );
}

function DecisionCard({ d, bridgeOnline, onFeedback, onOpenPath }: { d: ConflictDecision; bridgeOnline: boolean; onFeedback: (f: Feedback) => void; onOpenPath: (path: string) => void }) {
  const prefer = usePreferSession();
  const reserve = useReserveDecision();
  const pause = usePauseSessions();
  const dismiss = useDismissDecision();
  const busy = prefer.isPending || reserve.isPending || pause.isPending || dismiss.isPending;
  const pauseInfo = pauseAvailability(d, bridgeOnline);
  const noArea = d.kind === "together" && !d.areaGlob;

  async function onPrefer(sessionKey: string) {
    const letter = letterOf(d, sessionKey);
    try {
      const r = await prefer.mutateAsync({ key: d.key, sessionKey });
      const notes = r.notified.map((n) =>
        n.sent ? t("{letter} hat einen Hinweis bekommen.", { letter: letterOf(d, n.sessionKey) }) : t("{letter} bekam keinen Hinweis: {reason}.", { letter: letterOf(d, n.sessionKey), reason: reasonText(n.reason) }),
      );
      onFeedback({ tone: r.notified.every((n) => n.sent) ? "ok" : "warn", text: `${t("{letter} hat jetzt Vorrang (Bereich reserviert).", { letter })} ${notes.join(" ")}` });
    } catch (e) {
      onFeedback({ tone: "bad", text: errorText(e) });
    }
  }

  async function onReserve() {
    try {
      await reserve.mutateAsync(d.key);
      onFeedback({ tone: "ok", text: t("Bereich reserviert – neue Aufträge starten dort erst, wenn du ihn wieder freigibst.") });
    } catch (e) {
      onFeedback({ tone: "bad", text: errorText(e) });
    }
  }

  async function onPause() {
    try {
      const r = await pause.mutateAsync(pauseInfo.sessionKeys);
      const parts = r.results.map((x) =>
        x.paused ? t("{letter} ist angehalten.", { letter: letterOf(d, x.sessionKey) }) : t("{letter} wurde nicht angehalten: {reason}.", { letter: letterOf(d, x.sessionKey), reason: reasonText(x.reason) }),
      );
      onFeedback({ tone: r.results.every((x) => x.paused) ? "ok" : "warn", text: parts.join(" ") });
    } catch (e) {
      onFeedback({ tone: "bad", text: errorText(e) });
    }
  }

  async function onDismiss(status: "ignored" | "done") {
    try {
      await dismiss.mutateAsync({ key: d.key, status });
      onFeedback({ tone: "ok", text: status === "ignored" ? t("Ignoriert – steht jetzt unten unter „Schon entschieden“.") : t("Als erledigt markiert.") });
    } catch (e) {
      onFeedback({ tone: "bad", text: errorText(e) });
    }
  }

  return (
    <li data-testid="decision" data-key={d.key} className="grid min-w-0 gap-3 rounded-xl border border-a-conf/35 bg-a-p p-4">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-caption", SEVERITY_CLASS[d.severity])}>{SEVERITY_LABEL[d.severity]}</span>
        <p className="min-w-0 flex-1 text-headline leading-snug text-a-ink [overflow-wrap:anywhere]">{decisionSentence(d)}</p>
      </div>
      <SessionLegend d={d} />
      <p className="text-callout text-a-mut [overflow-wrap:anywhere]">{decisionRisk(d)}</p>
      {/* Nyx erklärt diesen Konflikt kurz und liest es vor. */}
      <AskNyxButton question={t("Erklär mir kurz diesen Konflikt zwischen meinen Sessions und was ich am besten tue.")} facts={decisionFacts(d)} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
        <span className="text-a-mut">{t("Vergleichen:")}</span>
        {d.samplePaths.map((p) => (
          <button key={p} type="button" onClick={() => onOpenPath(p)} title={p} className="min-w-0 max-w-full truncate rounded-md px-1.5 py-0.5 font-mono text-a-acc hover:bg-a-p2 hover:underline">
            {p.split("/").pop()}
          </button>
        ))}
        {d.fileCount > d.samplePaths.length && <span className="text-a-mut">{t("+{n} weitere unten in der Liste", { n: d.fileCount - d.samplePaths.length })}</span>}
      </div>
      {/* Konflikt-Entscheidungen (zuerst/reservieren/pausieren/ignorieren) trifft nur der Mensch – wie app_api (Bestätigung). */}
      <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label={t("Entscheidung")} data-nyx-risk="">
        {d.kind === "together" &&
          d.sessions.map((s, i) => (
            <button
              key={s.sessionKey}
              type="button"
              disabled={busy || noArea}
              onClick={() => void onPrefer(s.sessionKey)}
              className={BIG_PRIMARY}
              title={
                d.areaGlob
                  ? t("{name} darf weitermachen: {area} wird für {letter} reserviert, die anderen bekommen einen Hinweis (wenn sie in NyxOS laufen und gerade warten).", { name: sessionName(s), area: d.areaGlob, letter: sessionLetter(i) })
                  : t("{name} darf weitermachen: der Bereich wird für {letter} reserviert, die anderen bekommen einen Hinweis (wenn sie in NyxOS laufen und gerade warten).", { name: sessionName(s), letter: sessionLetter(i) })
              }
            >
              {t("{letter} zuerst", { letter: sessionLetter(i) })}
            </button>
          ))}
        {d.kind === "together" && (
          <button type="button" disabled={busy || noArea} onClick={() => void onReserve()} className={BIG_DEFAULT} title={d.areaGlob ? t("Sperrt {area}: neue Aufträge starten dort erst, wenn du ihn freigibst.", { area: d.areaGlob }) : t("Sperrt den Bereich: neue Aufträge starten dort erst, wenn du ihn freigibst.")}>
            {t("Bereich reservieren")}
          </button>
        )}
        <button type="button" disabled={busy || !pauseInfo.enabled} onClick={() => void onPause()} className={BIG_DEFAULT} title={pauseInfo.hint ?? undefined}>
          {pauseInfo.label}
        </button>
        <button type="button" disabled={busy} onClick={() => void onDismiss("ignored")} className={BIG_QUIET} title={t("Kein Problem – nicht mehr oben anzeigen.")}>
          {t("Ignorieren")}
        </button>
      </div>
      {d.kind === "together" || (pauseInfo.hint && !pauseInfo.enabled) || (pauseInfo.enabled && pauseInfo.sessionKeys.length < d.sessions.length) ? (
        <ul className="grid min-w-0 gap-0.5 text-caption text-a-mut">
          {d.kind === "together" && d.areaGlob && (
            <li className="min-w-0 [overflow-wrap:anywhere]">
              {t("Reservieren sperrt:")} <span className="font-mono">{d.areaGlob}</span>
            </li>
          )}
          {noArea && <li>{t("Reservieren geht hier nicht: die Dateien liegen zu verstreut oder würden ein ganzes Repo sperren.")}</li>}
          {pauseInfo.hint && (!pauseInfo.enabled || pauseInfo.sessionKeys.length < d.sessions.length) && <li>{pauseInfo.hint}</li>}
        </ul>
      ) : null}
    </li>
  );
}

function DecidedRow({ d }: { d: ConflictDecision }) {
  const reopen = useReopenDecision();
  const release = useReleaseReservation();
  const [error, setError] = useState<string | null>(null);
  const busy = reopen.isPending || release.isPending;
  // Nur eine hier (über eine Entscheidung) entstandene Reservierung darf hier wieder weg —
  // eine fremde (z. B. eines laufenden Auftrags) bleibt unangetastet, mit Hinweis wem sie gehört.
  const foreign = d.status === "reserved" && d.reservation && !isDecisionReservation(d.reservation.label) ? d.reservation : null;
  const undo = async () => {
    setError(null);
    try {
      if (d.status === "reserved" && d.reservation) await release.mutateAsync(d.reservation.id);
      else await reopen.mutateAsync(d.key);
    } catch {
      setError(t("Das hat nicht geklappt – bitte gleich nochmal versuchen."));
    }
  };
  return (
    <li className="grid min-w-0 gap-1 rounded-md px-2 py-1.5 text-callout hover:bg-a-p2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="shrink-0 rounded-full border border-a-line px-2 py-0.5 text-caption text-a-mut">{decidedLabel(d)}</span>
        <span className="min-w-0 flex-1 text-a-ink [overflow-wrap:anywhere]">{decisionSentence(d)}</span>
        {foreign ? (
          <a href="#reservierungen" className="min-w-0 shrink text-caption text-a-mut hover:text-a-ink [overflow-wrap:anywhere]">
            {t("reserviert durch „{label}“", { label: foreign.label })} ↓
          </a>
        ) : (
          <button type="button" disabled={busy} onClick={() => void undo()} className="shrink-0 rounded-md px-2 py-1 text-caption text-a-mut hover:bg-a-p3 hover:text-a-ink disabled:opacity-40">
            {d.status === "reserved" ? t("Reservierung aufheben") : t("Wieder öffnen")}
          </button>
        )}
      </div>
      {error && <p className="text-caption text-a-bad">{error}</p>}
    </li>
  );
}

export function DecisionBlock({ summary, onOpenPath }: { summary: ConflictsSummary; onOpenPath: (path: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const [showDecided, setShowDecided] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const open = summary.decisions.filter((d) => d.status === "open");
  const decided = summary.decisions.filter((d) => d.status !== "open");
  const visible = showAll ? open : open.slice(0, OPEN_PREVIEW);

  return (
    <section aria-labelledby="entscheiden" className="grid min-w-0 gap-3">
      <div className="grid gap-1">
        <h2 id="entscheiden" className="font-display text-title2 font-medium text-a-ink">
          {t("Was muss ich entscheiden?")}
        </h2>
        <p className="text-callout text-a-mut">
          {open.length === 0
            ? t("Gerade nichts – keine zwei laufenden Sessions ändern dieselben Dateien.")
            : open.length === 1
              ? t("1 Konflikt-Frage – nur zwischen Sessions, die gerade laufen. Die wichtigste steht oben. Sie zählen auch bei „Entscheidungen“ mit.")
              : t("{n} Konflikt-Fragen – nur zwischen Sessions, die gerade laufen. Die wichtigste steht oben. Sie zählen auch bei „Entscheidungen“ mit.", { n: open.length })}
          {summary.totals.past > 0 && (
            <span className="block text-caption">
              {summary.totals.past === 1
                ? t("1 Datei haben beendete Sessions gemeinsam geändert – das ist nur noch Rückblick (unten in der Kollisionskarte), keine Frage.")
                : t("{n} Dateien haben beendete Sessions gemeinsam geändert – das ist nur noch Rückblick (unten in der Kollisionskarte), keine Frage.", { n: summary.totals.past })}
            </span>
          )}
        </p>
      </div>

      {feedback && (
        <div role="status" className={cn("flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-callout", feedback.tone === "ok" ? "border-a-ok/40 bg-a-ok/10 text-a-ok" : feedback.tone === "warn" ? "border-a-wait/40 bg-a-wait/10 text-a-wait" : "border-a-bad/40 bg-a-bad/10 text-a-bad")}>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)} className="shrink-0 rounded px-1.5 text-a-mut hover:text-a-ink" aria-label={t("Meldung schließen")}>
            ✕
          </button>
        </div>
      )}

      {visible.length > 0 && (
        <ul className="grid gap-3">
          {visible.map((d) => (
            <DecisionCard key={d.key} d={d} bridgeOnline={summary.bridgeOnline} onFeedback={setFeedback} onOpenPath={onOpenPath} />
          ))}
        </ul>
      )}
      {open.length > OPEN_PREVIEW && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="justify-self-start rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
          {showAll ? t("Nur die wichtigsten zeigen") : t("Alle {n} Konflikt-Fragen zeigen", { n: open.length })}
        </button>
      )}

      {decided.length > 0 && (
        <div className="grid gap-1 rounded-lg border border-a-line">
          <button type="button" aria-expanded={showDecided} onClick={() => setShowDecided((v) => !v)} className="flex items-center gap-2 px-3 py-2 text-left text-caption text-a-mut hover:text-a-ink">
            <span className={cn("transition-transform", showDecided && "rotate-90")}>›</span>
            {t("Schon entschieden ({n})", { n: decided.length })}
          </button>
          {showDecided && (
            <ul className="grid gap-0.5 border-t border-a-line p-1.5">
              {decided.map((d) => (
                <DecidedRow key={d.key} d={d} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
