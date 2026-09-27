// Einstellungen → „Verbindungen“. Zeigt jede Verbindung von NyxOS, so wie der Server sie
// gerade echt geprüft hat: gruppiert, bunt nach Zustand, mit Antwortzeit, Ursache und Lösung. Punkte,
// die nur du lösen kannst, zeigen einen fertigen Befehl zum Kopieren. Erreichbar über die
// Statuszeile unten links (`/settings#verbindungen`).
import { CONNECTION_GROUPS, locale, t, timeZone, type ConnectionCheck, type ConnectionState, type ConnectionsReport } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { ConnectionsError, useConnections, useRecheckConnections } from "./useConnections";

export const CONNECTIONS_ANCHOR = "verbindungen";

// `idle` = nichts kaputt, es kam nur noch nichts an (frische Installation) — ruhig grau, nie rot oder gelb.
const STATE_LABEL: Record<ConnectionState, string> = { ok: t("läuft"), warn: t("Achtung"), fail: t("gestört"), user: t("nur du"), idle: t("wartet") };
const STATE_DOT: Record<ConnectionState, string> = { ok: "bg-a-ok", warn: "bg-a-wait", fail: "bg-a-bad", user: "bg-a-conf", idle: "bg-a-idle" };
const STATE_TEXT: Record<ConnectionState, string> = { ok: "text-a-ok", warn: "text-a-wait", fail: "text-a-bad", user: "text-a-conf", idle: "text-a-mut" };
const STATE_PILL: Record<ConnectionState, string> = {
  ok: "border-a-ok/40 bg-a-ok/10 text-a-ok",
  warn: "border-a-wait/40 bg-a-wait/10 text-a-wait",
  fail: "border-a-bad/40 bg-a-bad/10 text-a-bad",
  user: "border-a-conf/40 bg-a-conf/10 text-a-conf",
  idle: "border-a-line bg-a-p2 text-a-mut",
};
/** Zustände, die Aufmerksamkeit brauchen (`idle` und `ok` nicht). */
const NEEDS_ATTENTION: ReadonlySet<ConnectionState> = new Set(["user", "fail", "warn"]);
/** Gruppen bunt unterscheidbar (nie grau) und bewusst NICHT in den Zustandsfarben (grün/gelb/rot/pink),
 * damit ein Gruppen-Punkt nie wie ein Zustand aussieht. Reihenfolge wie `CONNECTION_GROUPS`. */
const GROUP_ACCENT: Record<string, string> = {
  server: "bg-a-acc",
  bruecke: "bg-a-done",
  haiku: "bg-a-violet",
  quellen: "bg-a-acc2",
  betrieb: "bg-a-lime",
  zugang: "bg-a-indigo",
};
const SEVERITY: Record<ConnectionState, number> = { user: 0, fail: 1, warn: 2, idle: 3, ok: 4 };

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: timeZone() });
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-a-line bg-a-bg px-2 py-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-caption text-a-ink">{command}</code>
      <Button variant="ghost" className="shrink-0" onClick={() => void copy()} aria-label={t("Befehl kopieren: {command}", { command })}>
        {copied ? t("Kopiert") : t("Kopieren")}
      </Button>
    </div>
  );
}

function CheckRow({ check }: { check: ConnectionCheck }) {
  const problem = check.state !== "ok";
  return (
    <li className="grid gap-1.5 rounded-md px-2 py-2 hover:bg-a-p2" data-state={check.state} aria-label={`${check.label}: ${STATE_LABEL[check.state]}`}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5">
        <span className={cn("mt-0.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-label font-medium", STATE_PILL[check.state])}>
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", STATE_DOT[check.state])} />
          {STATE_LABEL[check.state]}
        </span>
        <div className="min-w-0">
          <div className="text-callout text-a-ink">{check.label}</div>
          <div className="text-caption text-a-mut">
            {t("erwartet: {value}", { value: check.expected })}
            {check.result ? <span className="text-a-ink/80"> · {check.result}</span> : null}
          </div>
        </div>
        <span className="font-mono text-label text-a-mut" title={t("Antwortzeit")}>
          {check.ms} ms
        </span>
      </div>
      {problem && (check.cause || check.fix || check.command) && (
        <div className="ml-0 grid gap-1.5 border-l-2 border-a-line pl-3 sm:ml-[4.5rem]">
          {check.cause && <p className={cn("text-caption", STATE_TEXT[check.state])}>{check.cause}</p>}
          {check.fix && (
            <p className="text-caption text-a-ink">
              <span className="text-a-mut">{t("Was hilft:")} </span>
              {check.fix}
            </p>
          )}
          {check.command && <CopyCommand command={check.command} />}
        </div>
      )}
    </li>
  );
}

function Summary({ report, onRecheck, rechecking }: { report: ConnectionsReport; onRecheck: () => void; rechecking: boolean }) {
  const s = report.summary;
  // „wartet“ nur, wenn es solche Punkte gibt (ältere Server kennen den Zustand nicht).
  const pills: { state: ConnectionState; n: number }[] = (["user", "fail", "warn", "idle", "ok"] as const).map((state) => ({ state, n: s[state] ?? 0 })).filter((p) => p.state !== "idle" || p.n > 0);
  return (
    <Card className="grid gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {pills.map(({ state, n }) => (
          <span key={state} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-medium", STATE_PILL[state], n === 0 && "opacity-50")}>
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", STATE_DOT[state])} />
            {n} {STATE_LABEL[state]}
          </span>
        ))}
        <span className="ml-auto" />
        <Button variant="primary" className="min-w-[7.5rem]" onClick={onRecheck} disabled={rechecking} aria-busy={rechecking}>
          {rechecking ? t("Prüfe …") : t("Jetzt prüfen")}
        </Button>
      </div>
      <p className="text-caption text-a-mut">
        {t("Geprüft um {time} · {n} Verbindungen in {ms} ms", { time: clockTime(report.checkedAt), n: report.checks.length, ms: report.ms })}
        {report.cached ? ` · ${t("gerade erst geprüft, dieser Stand gilt noch")}` : ""}
      </p>
    </Card>
  );
}

export function ConnectionsPanel() {
  const { data, isLoading, isError, error, refetch } = useConnections();
  const local = data?.mode === "local";
  const recheck = useRecheckConnections();
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);

  // Sprung aus der Statuszeile (`/settings#verbindungen`): hinscrollen, sobald der Abschnitt steht.
  useEffect(() => {
    if (location.hash === `#${CONNECTIONS_ANCHOR}`) ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [location.hash, data]);

  const notDeployed = isError && error instanceof ConnectionsError && error.status === 404;

  return (
    <section id={CONNECTIONS_ANCHOR} ref={ref} className="grid scroll-mt-4 gap-2">
      <SectionTitle>{t("Verbindungen")}</SectionTitle>
      <p className="text-callout text-a-mut">
        {local
          ? t("Jede Verbindung von NyxOS auf diesem Rechner, echt geprüft — mit Antwortzeit. Ist etwas gestört, steht darunter, warum und was hilft. „Nur du“ heißt: Das kannst nur du lösen, der Befehl steht zum Kopieren bereit. „Wartet“ heißt: Nichts ist kaputt, es kam nur noch nichts an.")
          : t("Jede Verbindung von NyxOS, vom Server echt geprüft — mit Antwortzeit. Ist etwas gestört, steht darunter, warum und was hilft. „Nur du“ heißt: Das kannst nur du lösen, der Befehl steht zum Kopieren bereit.")}
      </p>

      {isLoading && <Skeleton className="h-40 w-full" />}
      {isError && (
        <Card className="grid gap-2 p-3">
          <p className="text-callout text-a-wait">
            {notDeployed ? t("Die Verbindungs-Prüfung ist auf dem Server noch nicht eingespielt — sie kommt mit dem nächsten Deploy.") : t("Der Server hat auf die Prüfung nicht geantwortet. Ist die Verbindung zum Server gerade weg?")}
          </p>
          <Button className="w-fit" onClick={() => void refetch()}>
            {t("Erneut versuchen")}
          </Button>
        </Card>
      )}

      {data && (
        <>
          <Summary report={data} onRecheck={() => recheck.mutate()} rechecking={recheck.isPending} />
          {recheck.isError && <p className="text-caption text-a-bad">{t("Neue Prüfung hat nicht geklappt — der Stand darunter ist der letzte bekannte.")}</p>}
          {CONNECTION_GROUPS.map((g) => {
            const checks = data.checks.filter((c) => c.group === g.id).sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state]);
            if (checks.length === 0) return null;
            const bad = checks.filter((c) => NEEDS_ATTENTION.has(c.state)).length;
            const label = t(local ? g.localLabel : g.label);
            return (
              <Card key={g.id} className="grid gap-1 p-2" aria-label={label}>
                <h3 className="flex items-center gap-2 px-2 pb-1 pt-1 text-callout font-medium text-a-ink">
                  <span className={cn("inline-block h-2 w-2 rounded-full", GROUP_ACCENT[g.id] ?? "bg-a-acc")} />
                  {label}
                  <span className="text-caption font-normal text-a-mut">{bad === 0 ? t("alles in Ordnung") : t("{bad} von {n} brauchen Aufmerksamkeit", { bad, n: checks.length })}</span>
                </h3>
                <ul className="grid gap-0.5">
                  {checks.map((c) => (
                    <CheckRow key={c.id} check={c} />
                  ))}
                </ul>
              </Card>
            );
          })}
        </>
      )}
    </section>
  );
}
