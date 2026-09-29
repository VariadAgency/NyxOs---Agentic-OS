// Server-SSH · Terminal zu einem eigenen Server im Server-Tab.
//
// Die Brücke startet eine tmux-Session `zc-ssh-<kurz>` mit dem FESTEN Befehl `ssh -t <host>`; der Host
// kommt nur aus `NYXOS_SERVER_SSH_HOST` (z. B. ein Host-Alias aus ~/.ssh/config). Ohne Einstellung ist die
// Funktion aus (`configured: false`). Hier gibt es nur Starten/Status/Trennen — nie einen Befehl oder Host
// aus der Anfrage. Der Browser dockt über denselben Kanal-Weg an wie bei Claude-Sessions.
//
// - `GET  /api/server/ssh`          läuft eine? Brücke da? (immer nur mit Anmeldung, s. needsAuth)
// - `POST /api/server/ssh/start`    starten oder die laufende wiederverwenden (`{ cols?, rows? }`, sonst nichts)
// - `POST /api/server/ssh/stop`     „Trennen“ (`{ confirm: true }`), beendet die tmux-Session
// - `WS   /terminal/ssh/:name`      Browser-Terminal, nur `zc-ssh-*`
import { BRIDGE_CAP_SERVER_SSH, serverSshHost, SSH_TMUX_NAME_RE, SshStartRequestSchema, t, type SshStartRpc, type SshStartResult, type SshStatusResult, type SshStopResult } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { bridgeTerminalSocket, sameOriginOnly, terminalQuery } from "./terminal.js";

export interface ServerSshDeps {
  bridgeHub: BridgeHub;
  upgradeWebSocket: UpgradeWebSocket<unknown>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Umgebung mit `NYXOS_SERVER_SSH_HOST` (Standard: `process.env`). */
  env?: Record<string, string | undefined>;
}

/** Sätze für den Nutzer (nie „tmux“, nie „RPC“). */
export const SSH_TEXT = {
  bridgeOffline: "Der Rechner ist gerade nicht verbunden. Das Terminal zum Server läuft über die Brücke – sobald sie wieder da ist, klappt es.",
  bridgeOutdated: "Die Brücke ist noch auf einem älteren Stand und kennt das Server-Terminal nicht. Sie muss einmal neu eingerichtet werden.",
  notRunning: "Das Terminal zum Server ist gerade nicht offen.",
  failed: "Das Terminal zum Server ließ sich nicht öffnen. Bitte gleich noch einmal versuchen.",
  notConfigured: "Kein SSH-Host eingerichtet. Mit NYXOS_SERVER_SSH_HOST öffnet sich hier eine Shell auf dem Server.",
} as const;

const StopBodySchema = z.object({ confirm: z.literal(true) }).strict();

type Unavailable = { code: "not_configured" | "bridge_offline" | "bridge_outdated"; error: string };

const notConfigured = (): Unavailable => ({ code: "not_configured", error: t(SSH_TEXT.notConfigured) });

function unavailable(bridgeHub: BridgeHub, host: string | null): Unavailable | null {
  if (!host) return notConfigured();
  if (!bridgeHub.online) return { code: "bridge_offline", error: t(SSH_TEXT.bridgeOffline) };
  if (!bridgeHub.supports(BRIDGE_CAP_SERVER_SSH)) return { code: "bridge_outdated", error: t(SSH_TEXT.bridgeOutdated) };
  return null;
}

async function readBody(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text().catch(() => "");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function registerServerSshRoutes(app: Hono<AppEnv>, deps: ServerSshDeps): void {
  const { bridgeHub, upgradeWebSocket, log } = deps;
  const host = serverSshHost(deps.env ?? process.env);

  app.get("/api/server/ssh", async (c) => {
    const off = unavailable(bridgeHub, host);
    if (off) return c.json({ bridgeOnline: bridgeHub.online, supported: false, running: false, tmuxName: null, code: off.code, message: off.error, host, configured: host !== null });
    const r = await bridgeHub.rpc("ssh_status", {});
    const st = r.ok ? (r.result as SshStatusResult) : null;
    const tmuxName = st?.tmuxName && SSH_TMUX_NAME_RE.test(st.tmuxName) ? st.tmuxName : null;
    return c.json({ bridgeOnline: true, supported: true, running: !!tmuxName, tmuxName, code: r.ok ? null : (r.code ?? "failed"), message: r.ok ? null : t(SSH_TEXT.failed), host, configured: true });
  });

  app.post("/api/server/ssh/start", async (c) => {
    // Streng: nur Feldgröße. Ein Befehl, Host oder sonst ein Feld → 400, die Brücke wird gar nicht gefragt.
    const parsed = SshStartRequestSchema.safeParse(await readBody(c));
    if (!parsed.success) return c.json({ error: t("Ungültige Angaben"), issues: parsed.error.issues.slice(0, 5) }, 400);
    if (!host) return c.json(notConfigured(), 404);
    const off = unavailable(bridgeHub, host);
    if (off) return c.json(off, 503);
    const r = await bridgeHub.rpc("ssh_start", { ...parsed.data, host } satisfies SshStartRpc);
    if (!r.ok) return c.json({ error: r.code === "tmux_missing" ? t("Auf dem Rechner fehlt das Terminal-Werkzeug von NyxOS. Die Brücke muss neu eingerichtet werden.") : t(SSH_TEXT.failed), code: r.code ?? "failed" }, r.code === "timeout" ? 504 : 502);
    const started = r.result as Partial<SshStartResult> | undefined;
    // Nie einen anderen Namen an den Browser geben (der Kanal dockt nur an `zc-ssh-*` an).
    if (!started?.tmuxName || !SSH_TMUX_NAME_RE.test(started.tmuxName)) return c.json({ error: t(SSH_TEXT.failed), code: "failed" }, 502);
    log("server-ssh-start", { tmuxName: started.tmuxName, reused: !!started.reused });
    return c.json({ tmuxName: started.tmuxName, reused: !!started.reused } satisfies SshStartResult);
  });

  app.post("/api/server/ssh/stop", async (c) => {
    const body = StopBodySchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: t("Bestätigung fehlt") }, 400);
    if (!host) return c.json(notConfigured(), 404);
    const off = unavailable(bridgeHub, host);
    if (off) return c.json(off, 503);
    const r = await bridgeHub.rpc("ssh_stop", {});
    if (!r.ok) return c.json({ error: t(SSH_TEXT.failed), code: r.code ?? "failed" }, r.code === "timeout" ? 504 : 502);
    const out = r.result as SshStopResult;
    log("server-ssh-stop", { stopped: out.stopped });
    return c.json({ stopped: out.stopped } satisfies SshStopResult);
  });

  app.get(
    "/terminal/ssh/:name",
    sameOriginOnly,
    upgradeWebSocket((c) => {
      const name = c.req.param("name") ?? "";
      return bridgeTerminalSocket(bridgeHub, terminalQuery(c), async () =>
        SSH_TMUX_NAME_RE.test(name) ? { tmuxName: name } : { status: "not_attachable", msg: t(SSH_TEXT.notRunning) },
      );
    }),
  );
}
