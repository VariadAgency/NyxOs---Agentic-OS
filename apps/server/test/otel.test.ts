import { describe, expect, it } from "vitest";
import { extractOtelUsageRows } from "../src/usage/otel.js";
import { setup } from "./helpers.js";

/** Beispiel-Nutzlast wie ein echter OTLP/HTTP-JSON-Export von Claude Code
 * (`claude_code.token.usage`, s. code.claude.com/docs/en/monitoring-usage). */
function samplePayload(
  overrides: Partial<{ type: string; model: string; sessionId: string; value: number; timeUnixNano: string; aggregationTemporality: number; attributes: { key: string; value: { stringValue: string } }[] }> = {},
) {
  const { type = "input", model = "claude-opus-5", sessionId = "abc-123", value = 42, timeUnixNano = "1790000000000000000", aggregationTemporality = 1 } = overrides;
  const attributes =
    overrides.attributes ??
    [
      { key: "type", value: { stringValue: type } },
      { key: "model", value: { stringValue: model } },
      { key: "session.id", value: { stringValue: sessionId } },
    ];
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  aggregationTemporality,
                  dataPoints: [
                    {
                      attributes,
                      timeUnixNano,
                      asInt: value,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("extractOtelUsageRows", () => {
  it("liest input/output/cacheRead/cacheCreation aus mehreren Datenpunkten derselben Session/Zeit zusammen", () => {
    const merged = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      { attributes: [{ key: "type", value: { stringValue: "input" } }, { key: "model", value: { stringValue: "claude-opus-5" } }, { key: "session.id", value: { stringValue: "s1" } }], timeUnixNano: "1790000000000000000", asInt: 100 },
                      { attributes: [{ key: "type", value: { stringValue: "output" } }, { key: "model", value: { stringValue: "claude-opus-5" } }, { key: "session.id", value: { stringValue: "s1" } }], timeUnixNano: "1790000000000000000", asInt: 20 },
                      { attributes: [{ key: "type", value: { stringValue: "cacheRead" } }, { key: "model", value: { stringValue: "claude-opus-5" } }, { key: "session.id", value: { stringValue: "s1" } }], timeUnixNano: "1790000000000000000", asInt: 5000 },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const rows = extractOtelUsageRows(merged);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "claude", model: "claude-opus-5", project: "projekt", sessionKey: "claude:s1", input: 100, output: 20, cacheRead: 5000, cacheCreation5m: 0 });
  });

  it("ignoriert andere Metriken und kumulative Zähler ohne Vorwert", () => {
    const other = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "claude_code.cost.usage", sum: { dataPoints: [] } }] }] }] };
    expect(extractOtelUsageRows(other)).toEqual([]);

    const cumulative = samplePayload({ aggregationTemporality: 2 });
    expect(extractOtelUsageRows(cumulative)).toEqual([]);
  });

  it("verwirft Datenpunkte ohne session.id oder type", () => {
    const p = samplePayload({ attributes: [{ key: "model", value: { stringValue: "claude-opus-5" } }] });
    expect(extractOtelUsageRows(p)).toEqual([]);
  });
});

describe("POST /ingest/otel/v1/metrics", () => {
  // dasselbe Maschinen-Token wie `/ingest/usage`, nicht die Passkey-Sitzung.
  it("Brücke mit Token → 2xx, ohne Token → 401", async () => {
    const { post } = await setup();
    expect((await post("/ingest/otel/v1/metrics", samplePayload(), {})).status).toBe(401);
    expect((await post("/ingest/otel/v1/metrics", samplePayload(), { authorization: "Bearer falsch" })).status).toBe(401);
    expect((await post("/ingest/otel/v1/metrics", samplePayload())).status).toBe(200);
  });

  it("nimmt einen OTLP-Export an und die Zahlen tauchen in usage_daily auf", async () => {
    const { post, app } = await setup();
    const res = await post("/ingest/otel/v1/metrics", samplePayload({ type: "input", value: 472 }));
    expect(res.status).toBe(200);
    const daily = (await (await app.request("/api/usage/daily?range=all")).json()) as { days: { inputTokens: number; model: string }[] };
    expect(daily.days.some((d) => d.model === "claude-opus-5" && d.inputTokens === 472)).toBe(true);
  });
});
