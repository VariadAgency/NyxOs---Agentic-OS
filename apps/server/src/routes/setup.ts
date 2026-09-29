// Einrichtung (Onboarding): Stand lesen und Änderungen übernehmen. Die Brücke kennt den Rechner (Ordner, Hooks,
// Shell, Werkzeuge); der Server reicht per RPC `setup.state` / `setup.apply` durch.
//
// - GET  /api/setup   → SetupState (ohne Brücke: leerer Stand mit `bridgeOnline: false`)
// - POST /api/setup   → SetupApply übernehmen, Antwort: der neue SetupState
// - GET  /api/setup/browse?path=  → Unterordner eines Ordners (Ordner-Auswahl, RPC `setup.browse`, nur lesend)
import {
  BRIDGE_CAP_SETUP,
  BRIDGE_CAP_SETUP_BROWSE,
  SETUP_RPC_APPLY,
  SETUP_RPC_BROWSE,
  SETUP_RPC_STATE,
  SetupApplySchema,
  SetupBrowseRequestSchema,
  SetupBrowseResultSchema,
  SetupStateSchema,
  emptySetupState,
  setupOsOf,
  t,
  type SetupState,
} from "@nyxos/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";

export type SetupHub = Pick<BridgeHub, "online" | "supports" | "rpc">;

const STATE_TIMEOUT_MS = 20_000;
/** Übernehmen kann Hooks/Shell-Dateien schreiben und einen Vault anlegen — etwas mehr Zeit. */
const APPLY_TIMEOUT_MS = 30_000;
/** Ein Ordner wird aufgelistet (macOS-Freigabe hat eine eigene, kürzere Grenze in der Brücke). */
const BROWSE_TIMEOUT_MS = 15_000;

type ErrorStatus = 400 | 403 | 502 | 503 | 504;

function errorStatus(code: string | undefined): ErrorStatus {
  if (code === "setup_bad_request" || code === "setup_missing_folder") return 400;
  if (code === "setup_denied") return 403;
  if (code === "bridge_offline") return 503;
  if (code === "timeout") return 504;
  return 502;
}

export function registerSetupRoutes(app: Hono<AppEnv>, deps: { bridgeHub: SetupHub; platform?: string }): void {
  const hub = deps.bridgeHub;
  const offline = (): SetupState => emptySetupState(setupOsOf(deps.platform ?? process.platform));

  app.get("/api/setup", async (c) => {
    if (!hub.online || !hub.supports(BRIDGE_CAP_SETUP)) return c.json(offline());
    const res = await hub.rpc(SETUP_RPC_STATE, {}, STATE_TIMEOUT_MS);
    const parsed = res.ok ? SetupStateSchema.safeParse(res.result) : null;
    return c.json(parsed?.success ? parsed.data : offline());
  });

  app.get("/api/setup/browse", async (c) => {
    const path = c.req.query("path");
    const req = SetupBrowseRequestSchema.safeParse(path === undefined || path === "" ? {} : { path });
    if (!req.success) return c.json({ error: t("Ungültige Einstellungen"), code: "bad_request" }, 400);
    if (!hub.online) return c.json({ error: t("Die Brücke ist nicht verbunden. Sobald sie läuft, kannst du weitermachen."), code: "bridge_offline" }, 503);
    if (!hub.supports(BRIDGE_CAP_SETUP_BROWSE)) return c.json({ error: t("Die Ordner-Auswahl braucht eine neuere Brücke. Bitte NyxOS aktualisieren – oder den Pfad eintippen."), code: "bridge_outdated" }, 503);
    const res = await hub.rpc(SETUP_RPC_BROWSE, req.data, BROWSE_TIMEOUT_MS);
    if (!res.ok) return c.json({ error: res.error ?? t("Das hat gerade nicht geklappt. Bitte noch einmal versuchen."), code: res.code ?? "failed" }, errorStatus(res.code));
    const result = SetupBrowseResultSchema.safeParse(res.result);
    if (!result.success) return c.json({ error: t("Die Brücke hat eine unerwartete Antwort geschickt."), code: "bad_bridge_response" }, 502);
    return c.json(result.data);
  });

  app.post("/api/setup", async (c) => {
    const body = SetupApplySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: t("Ungültige Einstellungen"), code: "bad_request" }, 400);
    if (!hub.online) return c.json({ error: t("Die Brücke ist nicht verbunden. Sobald sie läuft, kannst du weitermachen."), code: "bridge_offline" }, 503);
    if (!hub.supports(BRIDGE_CAP_SETUP)) return c.json({ error: t("Die Brücke ist noch auf altem Stand. Bitte NyxOS aktualisieren."), code: "bridge_outdated" }, 503);
    const res = await hub.rpc(SETUP_RPC_APPLY, body.data, APPLY_TIMEOUT_MS);
    if (!res.ok) return c.json({ error: res.error ?? t("Das hat gerade nicht geklappt. Bitte noch einmal versuchen."), code: res.code ?? "failed" }, errorStatus(res.code));
    const state = SetupStateSchema.safeParse(res.result);
    if (!state.success) return c.json({ error: t("Die Brücke hat eine unerwartete Antwort geschickt."), code: "bad_bridge_response" }, 502);
    return c.json(state.data);
  });
}
