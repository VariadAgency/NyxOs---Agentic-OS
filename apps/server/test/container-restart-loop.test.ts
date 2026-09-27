// Neustart-Schleifen: „Gestört“ sprang früher zwischen 1 und 2. Ein Container in einer
// Neustart-Schleife (openclaw-atlas-gateway, 20 499 Neustarts) zählte nur, wenn Docker ihn im Moment
// der Messung als „restarting“ meldete — lief er gerade 4 Sekunden, galt er als gesund.
import { describe, expect, it } from "vitest";
import { isRestartLoop } from "@nyxos/shared";
import { DockerProxyClient, DockerSnapshotCache } from "../src/server/docker.js";
import { defaultFakeContainers, FAKE_NOW, fakeDocker, type FakeContainer } from "./fixtures/fakeDocker.js";

const ago = (s: number) => new Date(FAKE_NOW - s * 1000).toISOString();

function flappingGateway(over: Partial<FakeContainer>): FakeContainer {
  const base = defaultFakeContainers().find((c) => c.name === "openclaw-atlas-gateway");
  if (!base) throw new Error("Fixture fehlt");
  return { ...base, ...over };
}

describe("Neustart-Schleife zählt immer als gestört", () => {
  it("reine Regel: restarting, oder viele Neustarts und gerade eben neu gestartet/beendet", () => {
    expect(isRestartLoop({ state: "restarting", restartCount: 1, startedAt: null, finishedAt: null }, FAKE_NOW)).toBe(true);
    // läuft gerade 5 s, letzter Absturz vor 60 s, 20 499 Neustarts → Schleife
    expect(isRestartLoop({ state: "running", restartCount: 20_499, startedAt: ago(5), finishedAt: ago(60) }, FAKE_NOW)).toBe(true);
    // läuft seit Wochen, zwei alte Neustarts → keine Schleife
    expect(isRestartLoop({ state: "running", restartCount: 2, startedAt: ago(30 * 86_400), finishedAt: ago(30 * 86_400 + 10) }, FAKE_NOW)).toBe(false);
    // viele Neustarts, aber seit Stunden stabil → keine Schleife mehr
    expect(isRestartLoop({ state: "running", restartCount: 500, startedAt: ago(5 * 3600), finishedAt: ago(5 * 3600 + 3) }, FAKE_NOW)).toBe(false);
    // gestoppt bleibt gestoppt
    expect(isRestartLoop({ state: "exited", restartCount: 40, startedAt: ago(7200), finishedAt: ago(7000) }, FAKE_NOW)).toBe(false);
  });

  it("dieselbe Antwort, egal ob Docker den Container gerade als laufend oder als neu startend meldet", async () => {
    const results: boolean[] = [];
    const variants: Partial<FakeContainer>[] = [
      { state: "restarting", status: "Restarting (1) 20 seconds ago", startedAt: ago(40), finishedAt: ago(20), restartCount: 20_499 },
      { state: "running", status: "Up 3 seconds", startedAt: ago(3), finishedAt: ago(50), restartCount: 20_500 },
    ];
    for (const over of variants) {
      const containers = [...defaultFakeContainers().filter((c) => c.name !== "openclaw-atlas-gateway"), flappingGateway(over)];
      const cache = new DockerSnapshotCache(new DockerProxyClient("http://proxy", fakeDocker({ containers }).fetch), { now: () => FAKE_NOW });
      const snap = await cache.get();
      const gw = snap.containers.find((c) => c.name === "openclaw-atlas-gateway");
      results.push(gw?.restartLoop ?? false);
      expect(snap.containers.filter((c) => c.restartLoop).map((c) => c.name)).toEqual(["openclaw-atlas-gateway"]);
    }
    expect(results).toEqual([true, true]);
  });

  it("Neustart-Zähler steigt zwischen zwei Messungen → Schleife, auch wenn die Zeiten alt aussehen", async () => {
    let now = FAKE_NOW;
    const gw = flappingGateway({ state: "running", status: "Up 20 minutes", restartCount: 10, startedAt: ago(20 * 60), finishedAt: ago(20 * 60 + 5) });
    const cache = new DockerSnapshotCache(new DockerProxyClient("http://proxy", fakeDocker({ containers: [gw] }).fetch), { ttlMs: 10_000, now: () => now });
    expect((await cache.get()).containers[0]?.restartLoop).toBe(false);
    now += 11_000;
    gw.restartCount = 11;
    gw.startedAt = new Date(now - 30 * 60_000).toISOString();
    gw.finishedAt = new Date(now - 30 * 60_000).toISOString();
    expect((await cache.get()).containers[0]?.restartLoop).toBe(true);
  });
});
