// Verbindungs-Prüfung: führt alle Prüfungen PARALLEL aus, jede mit eigenem Zeitlimit.
// Eine hängende oder werfende Quelle wird zu `fail` mit Ursache — nie zu einer hängenden Antwort
// oder einem 500 für die ganze Seite.
import { CONNECTION_STATES, getLang, t, type AppMode, type ConnectionCheck, type ConnectionGroup, type ConnectionState, type ConnectionsReport } from "@nyxos/shared";

/** Standard-Zeitlimit je Prüfung. Einzelne Prüfungen dürfen kürzer/länger (`timeoutMs`). */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 4000;

export interface CheckOutcome {
  state: ConnectionState;
  result?: string;
  cause?: string;
  fix?: string;
  command?: string;
  /** Gilt hier gerade nicht (z. B. kein Vault eingerichtet, Codex nicht installiert) → erscheint nicht im Bericht. */
  hidden?: boolean;
}

export interface CheckDef<C> {
  id: string;
  group: ConnectionGroup;
  label: string;
  expected: string;
  /** In welchen Betriebsarten die Prüfung gilt (fehlt = in beiden). Reine Server-Technik (Socket-Proxy,
   * Dozzle, Deploy-Protokoll, Token im Container, Passkeys über einen Namen) gibt es lokal nicht. */
  modes?: readonly AppMode[];
  /** Andere Worte im lokalen Modus (kein Server, keine Brücke über einen Tunnel). */
  local?: { label?: string; expected?: string };
  timeoutMs?: number;
  /** Was hilft, wenn die Prüfung wirft oder ins Zeitlimit läuft. */
  fix?: string;
  command?: string;
  run: (ctx: C) => Promise<CheckOutcome>;
}

class CheckTimeoutError extends Error {}

function seconds(ms: number): string {
  const s = (ms / 1000).toFixed(1);
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${getLang() === "de" ? s.replace(".", ",") : s} s`;
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 300 ? `${msg.slice(0, 300)} …` : msg;
}

/** Die Prüfungen, die in dieser Betriebsart gelten — mit den Worten dieser Betriebsart. */
export function checksForMode<C>(defs: CheckDef<C>[], mode: AppMode): CheckDef<C>[] {
  return defs.filter((d) => !d.modes || d.modes.includes(mode)).map((d) => (mode === "local" && d.local ? { ...d, label: d.local.label ?? d.label, expected: d.local.expected ?? d.expected } : d));
}

export async function runCheck<C>(def: CheckDef<C>, ctx: C, defaultTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS): Promise<ConnectionCheck | null> {
  const timeoutMs = def.timeoutMs ?? defaultTimeoutMs;
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  let outcome: CheckOutcome;
  try {
    outcome = await Promise.race([
      def.run(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError()), timeoutMs);
      }),
    ]);
  } catch (e) {
    outcome =
      e instanceof CheckTimeoutError
        ? { state: "fail", cause: t("Keine Antwort innerhalb von {seconds} (Zeitlimit).", { seconds: seconds(timeoutMs) }), fix: def.fix, command: def.command }
        : { state: "fail", cause: t("Prüfung fehlgeschlagen: {error}", { error: errorText(e) }), fix: def.fix, command: def.command };
  } finally {
    clearTimeout(timer);
  }
  if (outcome.hidden) return null;
  const check: ConnectionCheck = {
    id: def.id,
    group: def.group,
    // Labels, Erwartungen und feste Hinweise stehen deutsch in den Definitionen und werden erst hier übersetzt
    // (die Sprache kann sich zur Laufzeit ändern); schon übersetzte Texte bleiben unverändert.
    label: t(def.label),
    expected: t(def.expected),
    ok: outcome.state === "ok" || outcome.state === "warn" || outcome.state === "idle",
    state: outcome.state,
    ms: Math.round(performance.now() - start),
  };
  if (outcome.result) check.result = t(outcome.result);
  if (outcome.state !== "ok") {
    if (outcome.cause) check.cause = t(outcome.cause);
    if (outcome.fix) check.fix = t(outcome.fix);
    if (outcome.command) check.command = outcome.command;
  }
  return check;
}

export function summarize(checks: ConnectionCheck[]): Record<ConnectionState, number> {
  const summary = Object.fromEntries(CONNECTION_STATES.map((s) => [s, 0])) as Record<ConnectionState, number>;
  for (const c of checks) summary[c.state]++;
  return summary;
}

export async function runConnectionChecks<C>(defs: CheckDef<C>[], ctx: C, opts: { timeoutMs?: number; now?: () => number } = {}): Promise<Omit<ConnectionsReport, "cached">> {
  const start = performance.now();
  const checkedAt = new Date((opts.now ?? Date.now)()).toISOString();
  const checks = (await Promise.all(defs.map((d) => runCheck(d, ctx, opts.timeoutMs)))).filter((c): c is ConnectionCheck => c !== null);
  return { checkedAt, ms: Math.round(performance.now() - start), summary: summarize(checks), checks };
}
