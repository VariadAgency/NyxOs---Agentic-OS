// Reiter „Kontext“ (Durchsichtigkeit): was Nyx gerade
// im Kopf hat (Regeln, Gedächtnis, Werkzeuge, Verlauf), wie groß der Kontext der letzten Antwort war, was jede
// Antwort gekostet hat, ob Nyx sich im Kreis dreht (gleicher Werkzeug-Aufruf mehrfach) und die gemessenen Zeiten
// der Stimme (letztes Wort → erster Ton).
import { getLang, locale, nyxToolStatus, t, tc } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../../../../lib/cn";
import { formatUsd } from "../../../haiku/ui";
import { fetchCall, fetchMemory, fetchTools, type CallDetail } from "../nyxTabApi";
import type { ConvMessage } from "../useNyxConversation";
import type { VoiceTiming } from "../useNyxVoiceLoop";

/** Kontextfenster des Standard-Modells (Haiku) — nur für den Balken. */
const CONTEXT_WINDOW = 200_000;
/** Gleicher Aufruf mit gleichen Eingaben so oft = Schleife (OpenJarvis `loop_guard`: ab 3). */
const LOOP_REPEATS = 3;

export function loopWarning(tools: CallDetail["tools"]): string | null {
  if (!tools) return null;
  const count = new Map<string, number>();
  for (const tool of tools) {
    const k = `${tool.name}|${JSON.stringify(tool.args ?? null)}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  for (const [k, n] of count) if (n >= LOOP_REPEATS) return t("Nyx hat „{tool}“ {n}-mal gleich aufgerufen – er hat sich wohl im Kreis gedreht.", { tool: k.split("|")[0], n });
  return null;
}

function ms(v: number | null): string {
  return v === null ? "–" : `${(v / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

function Row({ label, value, hint, color }: { label: string; value: string; hint?: string; color: string }) {
  return (
    <li className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-2 text-caption">
      <span className="h-2.5 w-2.5 self-center rounded-sm" style={{ background: color }} />
      <span className="min-w-0 text-a-ink">
        {label}
        {hint && <span className="block text-caption text-a-mut">{hint}</span>}
      </span>
      <span className="font-mono text-caption text-a-ink">{value}</span>
    </li>
  );
}

export function ContextPanel({ messages, timings }: { messages: ConvMessage[]; timings: VoiceTiming[] }) {
  const tools = useQuery({ queryKey: ["nyx", "tools"], queryFn: fetchTools, staleTime: 60_000 });
  const memory = useQuery({ queryKey: ["nyx", "memory"], queryFn: fetchMemory, staleTime: 15_000 });
  const answers = messages.filter((m) => m.role === "assistant" && !m.streaming);
  const rounds = messages.filter((m) => m.role === "user").length;
  const lastCallId = [...answers].reverse().find((m) => m.callId)?.callId ?? null;
  const call = useQuery({ queryKey: ["nyx", "call", lastCallId], queryFn: () => fetchCall(lastCallId as number), enabled: lastCallId !== null, staleTime: 60_000 });
  const ctxTokens = call.data?.call.contextTokens ?? null;
  const loop = loopWarning(call.data?.tools ?? null);
  const withCost = answers.filter((m) => m.usage);
  const total = withCost.reduce((s, m) => s + (m.usage?.costUsd ?? 0), 0);

  return (
    <div className="cc-scroll grid h-full content-start gap-4 overflow-y-auto p-3" data-nyx="nyx-kontext">
      <section className="grid gap-2">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Was Nyx gerade weiß")}</h3>
        <ul className="grid gap-2 rounded-xl border border-a-line bg-a-p2 p-3">
          <Row color="var(--a-acc)" label={t("Regeln für Nyx")} hint={t("Wer er ist, wie er antwortet, was nur du freigibst")} value={t("fest")} />
          <Row
            color="var(--a-temp)"
            label={t("Gedächtnis")}
            hint={memory.data === null ? t("kommt mit dem Nyx-Kern") : undefined}
            value={memory.data === null ? t("noch keins") : memory.data ? (memory.data.length === 1 ? t("1 Erinnerung") : t("{n} Erinnerungen", { n: memory.data.length })) : "…"}
          />
          <Row color="var(--a-wait)" label={t("Werkzeuge")} hint={t("Jedes Werkzeug kostet in jeder Antwort etwas Kontext")} value={tools.data ? String(tools.data.length) : "…"} />
          <Row
            color="var(--a-done)"
            label={t("Verlauf")}
            hint={t("Mit geht: die erste Frage, die letzten 3 Runden ganz, davor nur die Fragen")}
            value={rounds === 1 ? t("1 Runde") : t("{n} Runden", { n: rounds })}
          />
        </ul>
        {tools.data && tools.data.length > 0 && (
          <details className="rounded-lg border border-a-line bg-a-p2 px-3 py-2 text-caption">
            <summary className="cursor-pointer text-a-ink">{t("Alle Werkzeuge ansehen")}</summary>
            <ul className="mt-2 grid gap-1.5">
              {tools.data.map((tool) => (
                <li key={tool.name} className="grid gap-0.5">
                  <span className="font-mono text-caption text-a-claude">{tool.name}</span>
                  {/* The description is written for the model in German; English shows the short plain-words label. */}
                  <span className="text-caption text-a-mut">{getLang() === "de" ? tool.description : nyxToolStatus(tool.name)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="grid gap-2">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Letzte Antwort")}</h3>
        {lastCallId === null ? (
          <div className="text-caption text-a-mut">{t("Noch keine Antwort in diesem Gespräch.")}</div>
        ) : (
          <div className="grid gap-2 rounded-xl border border-a-line bg-a-p2 p-3 text-caption">
            <div className="flex items-baseline justify-between">
              <span className="text-a-ink">{t("Kontext")}</span>
              <span className="font-mono text-a-ink">{ctxTokens !== null ? t("{n} Tokens", { n: ctxTokens.toLocaleString(locale()) }) : "–"}</span>
            </div>
            {ctxTokens !== null && (
              <div className="h-2 overflow-hidden rounded-full bg-a-p3" aria-hidden="true">
                <div className="h-full rounded-full bg-a-acc" style={{ width: `${Math.min(100, (ctxTokens / CONTEXT_WINDOW) * 100)}%` }} />
              </div>
            )}
            {call.data && (
              <div className="font-mono text-label text-a-mut">
                {call.data.call.model ?? t("Modell unbekannt")} · {t("rein {n}", { n: call.data.call.inputTokens.toLocaleString(locale()) })} · {t("raus {n}", { n: call.data.call.outputTokens.toLocaleString(locale()) })} ·{" "}
                {formatUsd(call.data.call.costUsd)}
              </div>
            )}
            {call.data?.tools && call.data.tools.length > 0 && (
              <ul className="grid gap-1">
                {call.data.tools.map((tool, i) => (
                  <li key={`${tool.name}-${i}`} className="flex items-center gap-2 font-mono text-label">
                    <span className={tool.ok ? "text-a-ok" : "text-a-bad"}>{tool.ok ? "✓" : "✕"}</span>
                    <span className="text-a-claude">{tool.name}</span>
                    <span className="text-a-mut">{tool.ms} ms</span>
                    <span className="ml-auto text-a-mut">{t("{n} Tokens Ergebnis", { n: Math.round(tool.resultChars / 4).toLocaleString(locale()) })}</span>
                  </li>
                ))}
              </ul>
            )}
            {loop && (
              <div role="alert" className="rounded-lg border border-a-wait/40 bg-a-wait/10 px-2.5 py-1.5 text-caption text-a-wait">
                {loop}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="grid gap-2">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Kosten je Antwort")}</h3>
        {withCost.length === 0 ? (
          <div className="text-caption text-a-mut">{t("Kommt mit der ersten Antwort.")}</div>
        ) : (
          <div className="grid gap-1.5 rounded-xl border border-a-line bg-a-p2 p-3">
            {withCost
              .slice(-10)
              .reverse()
              .map((m) => (
                <div key={m.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-3 text-caption">
                  <span className="min-w-0 truncate text-a-ink">{m.text.slice(0, 80) || t("(leer)")}</span>
                  <span className="font-mono text-a-mut">{ms(m.usage?.durationMs ?? null)}</span>
                  <span className="font-mono text-a-ink">{formatUsd(m.usage?.costUsd ?? 0)}</span>
                </div>
              ))}
            <div className="mt-1 flex justify-between border-t border-a-line pt-1.5 font-mono text-caption">
              <span className="text-a-mut">{t("Summe dieses Gesprächs (Gegenwert, Max-Plan zahlt nicht je Aufruf)")}</span>
              <span className="text-a-ink">{formatUsd(total)}</span>
            </div>
          </div>
        )}
      </section>

      <section className="grid gap-2">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Stimme – gemessene Zeiten")}</h3>
        {timings.length === 0 ? (
          <div className="text-caption text-a-mut">{t("Sprich mit Nyx – dann steht hier, wie schnell er war.")}</div>
        ) : (
          <table className="w-full text-left font-mono text-caption" data-nyx="nyx-zeiten">
            <thead className="text-a-mut">
              <tr>
                <th className="font-normal">{tc("nyx", "Erkennen")}</th>
                <th className="font-normal">{t("Erstes Wort")}</th>
                <th className="font-normal">{t("Stimme")}</th>
                <th className="font-normal">{t("Gesamt")}</th>
              </tr>
            </thead>
            <tbody>
              {timings.slice(0, 8).map((tm) => (
                <tr key={tm.at} className="text-a-ink">
                  <td>{ms(tm.sttMs)}</td>
                  <td>{ms(tm.llmFirstMs)}</td>
                  <td>{ms(tm.ttsFirstMs)}</td>
                  <td className={cn(tm.totalMs !== null && tm.totalMs <= 2500 ? "text-a-ok" : "text-a-wait")}>{ms(tm.totalMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-caption text-a-mut">{t("Gesamt = vom letzten Wort, das du sagst, bis Nyx' erster Ton. Ziel: höchstens 2,5 s.")}</p>
      </section>
    </div>
  );
}
