// Server-Befehle `nyx.ui` im Browser annehmen – nie mehr still verwerfen.
//
// Früher ignorierte ein Fenster im Hintergrund den Befehl stumm, und ein Fehler beim Ausführen verschluckte die
// Antwort. Nyx wartete dann 12 s und sagte nur „wahrscheinlich im Hintergrund“. Jetzt:
// - Jedes Fenster bestätigt sofort (`nyx.ui.ack`: angekommen, sichtbar ja/nein). Der Server weiß so, woran es liegt.
// - Sichtbare Fenster führen gleich aus. Hintergrund-Fenster legen den Befehl kurz zurück; ist kein sichtbares Fenster
//   da, bittet der Server genau eines davon (`nyx.ui.run`) – es führt dann ohne Cursor-Animation aus.
// - Jeder Fehler wird zur ehrlichen Antwort statt zum Schweigen.
import { NyxUiCommandSchema, t, type NyxUiCommand } from "@nyxos/shared";
import type { ExecResult } from "./uiExecutor";

export interface UiRemoteDeps {
  tabId: string;
  visible(): boolean;
  route(): string;
  /** Antwort an den Server (angemeldeter Weg `POST /api/nyx/ui/reply`). */
  post(body: Record<string, unknown>): void;
  run(steps: NyxUiCommand[], opts: { background: boolean }): Promise<ExecResult>;
}

/** So lange hält ein Hintergrund-Fenster einen Befehl bereit (der Server entscheidet nach < 1 s). */
const PARK_MS = 20_000;

export const BACKGROUND_NOTE = t("NyxOS war im Hintergrund – dort ist es jetzt erledigt.");

/** Eindeutige Kennung dieses Fensters (nur für die Zuteilung von `nyx.ui.run`). */
export function newTabId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "").slice(0, 16);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return t("Fehler im Browser: {msg}", { msg }).slice(0, 480);
}

export function createUiRemote(deps: UiRemoteDeps) {
  const parked = new Map<string, { cmd: NyxUiCommand; at: number }>();

  const execute = (requestId: string | null, cmd: NyxUiCommand, background: boolean) => {
    const reply = (body: Record<string, unknown>) => {
      if (requestId) deps.post({ requestId, ...body });
    };
    let run: Promise<ExecResult>;
    try {
      run = deps.run([cmd], { background });
    } catch (e) {
      run = Promise.reject(e);
    }
    void run.then(
      (r) => {
        if (r.screen) reply({ type: "nyx.ui.screen", ...r.screen });
        else reply({ type: "nyx.ui.result", ok: r.ok, risky: r.risky, detail: background && r.ok && cmd.action !== "highlight" ? (r.detail ? `${r.detail} (${BACKGROUND_NOTE})` : BACKGROUND_NOTE) : r.detail, route: r.route });
      },
      (e: unknown) => reply({ type: "nyx.ui.result", ok: false, detail: errorText(e), route: deps.route() }),
    );
  };

  return {
    handle(msg: { type: string; [k: string]: unknown }): void {
      if (msg.type === "nyx.ui.run") {
        if (msg.tabId !== deps.tabId || typeof msg.requestId !== "string") return;
        const p = parked.get(msg.requestId);
        parked.delete(msg.requestId);
        if (p) execute(msg.requestId, p.cmd, !deps.visible());
        return;
      }
      if (msg.type !== "nyx.ui") return;
      const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
      const visible = deps.visible();
      if (requestId) deps.post({ type: "nyx.ui.ack", requestId, tabId: deps.tabId, visible, route: deps.route().slice(0, 500) });
      const parsed = NyxUiCommandSchema.safeParse(msg);
      if (!parsed.success) {
        if (visible && requestId) deps.post({ requestId, type: "nyx.ui.result", ok: false, detail: t("Diesen Befehl kenne ich nicht.") });
        return;
      }
      if (visible) {
        execute(requestId, parsed.data, false);
        return;
      }
      if (!requestId) return;
      const now = Date.now();
      for (const [id, p] of parked) if (now - p.at > PARK_MS) parked.delete(id);
      parked.set(requestId, { cmd: parsed.data, at: now });
    },
  };
}
