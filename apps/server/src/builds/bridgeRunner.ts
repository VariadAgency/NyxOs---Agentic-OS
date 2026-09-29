// Build-Wächter — die Prüfung läuft auf dem Rechner, über die Brücke (RPC `run_build`).
// Warum nicht im Server-Container: die Arbeitsordner (Projektordner, Worktrees mit
// ungespeicherten Änderungen) und Xcode gibt es nur auf dem Rechner. `pnpm` ins Image zu legen hätte nichts
// geändert — Node meldet „spawn pnpm ENOENT“ auch dann, wenn nur der Mac-Ordner als `cwd` fehlt.
import { BRIDGE_CAP_RUN_BUILD, BUILD_TIMEOUT_MS, t, unavailableSentence, type RunBuildRequest, type RunBuildResult } from "@nyxos/shared";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import type { BuildJob, BuildRunner, BuildRunOutcome } from "./queue.js";

/** Der Server wartet etwas länger als die Brücke selbst (die bricht nach `BUILD_TIMEOUT_MS` ab). */
const RPC_GRACE_MS = 60_000;

type Hub = Pick<BridgeHub, "online" | "supports" | "rpc">;

export class BridgeBuildRunner implements BuildRunner {
  constructor(private readonly hub: Hub) {}

  async run(job: BuildJob): Promise<BuildRunOutcome> {
    if (!this.hub.online) return { exitCode: null, log: t("Brücke nicht verbunden"), unavailable: unavailableSentence("bridge_offline") };
    if (!this.hub.supports(BRIDGE_CAP_RUN_BUILD)) return { exitCode: null, log: t("Brücke meldet kein run_build"), unavailable: unavailableSentence("bridge_outdated") };
    const params: RunBuildRequest = { command: job.command, cwd: job.cwd, timeoutMs: BUILD_TIMEOUT_MS };
    const res = await this.hub.rpc("run_build", params, BUILD_TIMEOUT_MS + RPC_GRACE_MS);
    if (!res.ok) {
      // Verbindung weg oder keine Antwort: das ist kein Fehler im Code → nicht eingerichtet, nicht rot.
      return { exitCode: null, log: res.error ?? t("keine Antwort"), unavailable: unavailableSentence("bridge_offline") };
    }
    const result = res.result as RunBuildResult | undefined;
    if (!result || typeof result !== "object") return { exitCode: -1, log: t("Unerwartete Antwort der Brücke") };
    if (result.outcome === "unavailable") return { exitCode: null, log: result.log, unavailable: unavailableSentence(result.reason, result.tool) };
    return { exitCode: result.exitCode, log: result.log };
  }
}
