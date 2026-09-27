// OTel-Empfänger: nimmt einen OTLP/HTTP-JSON
// Metrik-Export von Claude Code entgegen (`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
// `OTEL_METRICS_EXPORTER=otlp`, Endpunkt `.../ingest/otel/v1/metrics`). Gebaut und LOKAL getestet
// (s. `apps/server/test/otel.test.ts`), aber NICHT eingeschaltet (das Setzen der
// `CLAUDE_CODE_ENABLE_TELEMETRY`-Umgebungsvariablen ist ein Deploy-Schritt, s. BETRIEB.md).
// Metrik-Namen/Attribute laut offizieller Doku (code.claude.com/docs/en/monitoring-usage, Stand
// 25.09.2026): `claude_code.token.usage` (Counter, Attribute `type` ∈
// input/output/cacheRead/cacheCreation, `model`, Standard-Attribut `session.id`). Codex hat (Stand
// P6) keine dokumentierte OTel-Export-Option — dieser Empfänger deckt nur Claude Code ab; der
// Bestand-Scan (`usage-scan.ts`) bleibt für Codex die einzige Quelle.
import { USAGE_UNKNOWN_PROJECT, type UsageIngestRow } from "@nyxos/shared";
import { inArray } from "drizzle-orm";
import { projectOf } from "../categorize.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";

interface OtlpAttr {
  key: string;
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number };
}
interface OtlpDataPoint {
  attributes?: OtlpAttr[];
  timeUnixNano?: string | number;
  asInt?: string | number;
  asDouble?: number;
}
interface OtlpMetric {
  name: string;
  sum?: { dataPoints?: OtlpDataPoint[]; aggregationTemporality?: number };
}
interface OtlpExportRequest {
  resourceMetrics?: { scopeMetrics?: { metrics?: OtlpMetric[] }[] }[];
}

function attr(dp: OtlpDataPoint, key: string): string | null {
  const a = dp.attributes?.find((x) => x.key === key);
  if (!a?.value) return null;
  if (typeof a.value.stringValue === "string") return a.value.stringValue;
  if (a.value.intValue !== undefined) return String(a.value.intValue);
  if (a.value.doubleValue !== undefined) return String(a.value.doubleValue);
  return null;
}

function numOf(dp: OtlpDataPoint): number {
  if (dp.asInt !== undefined) return Number(dp.asInt);
  if (dp.asDouble !== undefined) return dp.asDouble;
  return 0;
}

function tsOf(dp: OtlpDataPoint): string {
  const nano = dp.timeUnixNano;
  if (nano === undefined) return new Date().toISOString();
  const ms = Math.round(Number(nano) / 1_000_000);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

/**
 * `claude_code.token.usage`-Datenpunkte → eine `UsageIngestRow` je (Session, Modell, Zeitpunkt).
 * `aggregationTemporality`: 1 = delta (der gemeldete Wert ist bereits "seit dem letzten Export" —
 * genau das, was wir wollen), 2 = cumulative (bräuchte einen gespeicherten Vorwert je Session/
 * Modell, um daraus ein Delta zu bilden — ohne diesen Zustand hier NICHT unterstützt, die Zeile
 * wird dann übersprungen; s. BERICHT "offene Punkte"). Ohne das Feld wird `delta` angenommen
 * (Standard-Exporter-Verhalten laut Doku).
 */
export function extractOtelUsageRows(body: OtlpExportRequest): UsageIngestRow[] {
  const rows = new Map<string, UsageIngestRow>();
  for (const rm of body.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        if (m.name !== "claude_code.token.usage" || !m.sum) continue;
        if (m.sum.aggregationTemporality === 2) continue; // kumulativ ohne Vorwert — s. Kommentar
        for (const dp of m.sum.dataPoints ?? []) {
          const type = attr(dp, "type");
          const model = attr(dp, "model");
          const sessionId = attr(dp, "session.id");
          if (!type || !sessionId) continue;
          const ts = tsOf(dp);
          const key = `${sessionId}|${model ?? ""}|${ts}`;
          const row =
            rows.get(key) ??
            ({
              ts,
              tool: "claude",
              model,
              project: USAGE_UNKNOWN_PROJECT, // OTel läuft nur für erfasste Sessions; den Projektnamen setzt die Route nach
              sessionKey: `claude:${sessionId}`,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheCreation5m: 0,
              cacheCreation1h: 0,
              reasoning: 0,
              sourceId: null, // OTel-Metrik hat keine Nachrichten-ID (kein Bezug zu message.id)
            } satisfies UsageIngestRow);
          const n = numOf(dp);
          if (type === "input") row.input += n;
          else if (type === "output") row.output += n;
          else if (type === "cacheRead") row.cacheRead += n;
          else if (type === "cacheCreation") row.cacheCreation5m += n;
          rows.set(key, row);
        }
      }
    }
  }
  return [...rows.values()];
}

/** OTel kennt nur die Session-ID: den Projektnamen (Ordnername des Repos) aus dem Arbeitsordner der
 * bekannten Session nachtragen. Unbekannte Sessions behalten `USAGE_UNKNOWN_PROJECT`. */
export async function withSessionProjects(db: Db, rows: UsageIngestRow[]): Promise<UsageIngestRow[]> {
  const keys = [...new Set(rows.map((r) => r.sessionKey).filter((k): k is string => !!k))];
  if (keys.length === 0) return rows;
  const found = await db.select({ id: sessions.id, cwd: sessions.cwd }).from(sessions).where(inArray(sessions.id, keys));
  const nameOf = new Map(found.map((r) => [r.id, projectOf(r.cwd)?.name ?? null]));
  return rows.map((r) => {
    const name = r.sessionKey ? nameOf.get(r.sessionKey) : null;
    return name ? { ...r, project: name } : r;
  });
}
