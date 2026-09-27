// Interner Anmelde-Weg für `app_api`: Nyx ruft die App im selben Prozess auf (`app.fetch(request)`). Statt eines
// Tokens (das irgendwo stehen müsste) merkt sich der Server die Request-OBJEKTE, die er selbst gebaut hat. Hono reicht
// genau dieses Objekt als `c.req.raw` durch; übers Netz entsteht immer ein neues Objekt – kein Kopf, kein Cookie und
// kein Wert kann es fälschen. Nichts davon landet je auf der Platte oder im Log.
import { AsyncLocalStorage } from "node:async_hooks";
import type { NyxChannel } from "@nyxos/shared";
import type { ToolContext } from "../../haiku/tools.js";

const internal = new WeakSet<Request>();

/** Markiert eine selbst gebaute Anfrage als „vom Nutzer über Nyx“ (nur im Prozess erreichbar). */
export function markInternalRequest(req: Request): Request {
  internal.add(req);
  return req;
}

export function isInternalRequest(req: Request): boolean {
  return internal.has(req);
}

/**
 * Läuft gerade ein `app_api`-Aufruf? Wege, die selbst ein Modell fragen (z. B. „Nyx fragen“ an einer Entscheidung),
 * warten dann NICHT in der Nyx-Warteschlange – dort steht die Runde, die gerade auf genau diesen Aufruf wartet
 * (sonst Verklemmung bis zur Zeitgrenze). S. `HaikuRuntime.acquire`.
 */
export const appApiScope = new AsyncLocalStorage<{ via: "app_api" }>();

export function insideAppApi(): boolean {
  return appApiScope.getStore()?.via === "app_api";
}

/** Kanäle, über die der Nutzer selbst mit Nyx spricht. */
export const OWNER_CHANNELS: readonly NyxChannel[] = ["web", "voice", "telegram"];

/**
 * Kommt diese Runde vom Nutzer selbst (Chat über Web/Stimme/Telegram)? Kanal und Art setzt nur der SERVER
 * (`runNyxTurn` → Laufzeit-Grant), nie das Modell. Automatische Läufe (geplante Aufgaben, Verdichtung, Prüfungen,
 * Knöpfe ohne Kanal) sind es nicht – dort dürfen Werkzeuge nur lesen (app_api GET, ui_read_screen).
 */
export function isOwnerTurn(ctx: Pick<ToolContext, "kind" | "channel">): boolean {
  return ctx.kind === "chat" && !!ctx.channel && OWNER_CHANNELS.includes(ctx.channel);
}
