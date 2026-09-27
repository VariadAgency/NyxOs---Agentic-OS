// Durchreiche zum Finder-Dienst der Brücke (RPC `finder`, s. apps/bridge/src/finder/fs.ts).
// Übersetzt Brücken-Zustände und -Fehler in HTTP-Status + einen einfachen deutschen Satz — nie Technik.
import { BRIDGE_CAP_FINDER, FINDER_ERR, t, type FinderRequest } from "@nyxos/shared";
import type { BridgeHub } from "../terminal/bridgeHub.js";

export type FinderHub = Pick<BridgeHub, "online" | "supports" | "rpc">;

export type FinderOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409 | 413 | 415 | 502 | 503 | 504; error: string; code: string };

/** Sätze für die Oberfläche (AGENT-REGELN: sagen, was los ist und was der Nutzer tun kann). Getter: der Text folgt der App-Sprache beim Zugriff. */
export const FINDER_TEXT = {
  get offline(): string {
    return t("Der Rechner ist gerade nicht verbunden. Sobald die Brücke wieder läuft, sind die Dateien wieder da.");
  },
  get outdated(): string {
    return t("Die Brücke ist noch auf altem Stand und kennt die Dateien-Ansicht nicht. Nach dem nächsten Update der Brücke geht es.");
  },
  get timeout(): string {
    return t("Der Rechner antwortet gerade zu langsam. Bitte gleich noch einmal versuchen.");
  },
  get badPath(): string {
    return t("Dieser Ort ist in der Dateien-Ansicht nicht erlaubt.");
  },
  get failed(): string {
    return t("Das hat gerade nicht geklappt. Bitte noch einmal versuchen.");
  },
  get notText(): string {
    return t("Das ist keine Textdatei. Du kannst sie herunterladen.");
  },
  get tooLarge(): string {
    return t("Die Datei ist zu groß für den Editor. Du kannst sie herunterladen.");
  },
};

const STATUS_BY_CODE: Record<string, 400 | 403 | 404 | 409 | 413 | 503> = {
  [FINDER_ERR.badPath]: 400,
  [FINDER_ERR.notAFile]: 400,
  [FINDER_ERR.notFound]: 404,
  [FINDER_ERR.noThumb]: 404,
  [FINDER_ERR.secret]: 403,
  [FINDER_ERR.readOnly]: 403,
  [FINDER_ERR.conflict]: 409,
  [FINDER_ERR.tooLarge]: 413,
  // macOS fragt am Mac, ob die Brücke den Ordner lesen darf — vorübergehend, die Oberfläche versucht es weiter.
  [FINDER_ERR.macosPermission]: 503,
};

/** Die Brücke schreibt ihre Fehler schon als einfache Sätze (finder/fs.ts) — nur bekannte Codes durchlassen. */
export async function finderCall<T>(hub: FinderHub, req: FinderRequest, timeoutMs = 20_000): Promise<FinderOutcome<T>> {
  if (!hub.online) return { ok: false, status: 503, error: FINDER_TEXT.offline, code: "bridge_offline" };
  if (!hub.supports(BRIDGE_CAP_FINDER)) return { ok: false, status: 503, error: FINDER_TEXT.outdated, code: "bridge_outdated" };
  const res = await hub.rpc("finder", req, timeoutMs);
  if (res.ok) return { ok: true, value: res.result as T };
  if (res.code === "bridge_offline") return { ok: false, status: 503, error: FINDER_TEXT.offline, code: "bridge_offline" };
  if (res.code === "timeout") return { ok: false, status: 504, error: FINDER_TEXT.timeout, code: "timeout" };
  const status = res.code ? STATUS_BY_CODE[res.code] : undefined;
  if (status && res.code) return { ok: false, status, error: res.error && res.error.length < 200 ? res.error : FINDER_TEXT.failed, code: res.code };
  return { ok: false, status: 502, error: FINDER_TEXT.failed, code: "failed" };
}
