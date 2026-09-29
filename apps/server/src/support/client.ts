// Forwarding to the support service of the project website (contract: docs/support-api.md).
// Time limit, size limit on the answer, no redirects (a POST must reach exactly the configured address) and the
// usual check against addresses in the internal network (net/safeFetch.ts).
import { SUPPORT_LIMITS, t } from "@nyxos/shared";
import { assertPublicUrl, UnsafeUrlError, type HostResolver } from "../net/safeFetch.js";
import { isLoopbackHost } from "./config.js";

export type SupportEndpoint = "v1/bug" | "v1/idea" | "v1/donate/session";

export type ForwardResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; retry: boolean; error: string; status: number | null; retryAfterMs: number | null };

export interface ForwardOptions {
  fetch: typeof fetch;
  version: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  allowPrivate: boolean;
  resolve?: HostResolver;
}

/** Statuses after which the same request may work later (the report keeps waiting). */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error("too-large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 24 * 3600) * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 24 * 3600 * 1000)) : null;
}

/** Plain-text message from the service's error body `{ error: { code, message } }` (or `{ error: "…" }`). */
function serviceMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  const msg = typeof err === "string" ? err : err && typeof err === "object" ? (err as { message?: unknown }).message : null;
  return typeof msg === "string" && msg.trim() ? clip(msg.trim(), 300) : null;
}

export async function forwardToSupport(base: URL, endpoint: SupportEndpoint, payload: unknown, o: ForwardOptions): Promise<ForwardResult> {
  const url = new URL(endpoint, base);
  try {
    await assertPublicUrl(url, { allowPrivate: o.allowPrivate && isLoopbackHost(url.hostname), resolve: o.resolve });
  } catch (e) {
    return { ok: false, retry: true, status: null, retryAfterMs: null, error: e instanceof UnsafeUrlError ? e.message : t("Die Adresse der Meldestelle ist ungültig.") };
  }
  let res: Response;
  try {
    res = await o.fetch(url.toString(), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": `NyxOS/${o.version}`,
        ...(o.idempotencyKey ? { "idempotency-key": o.idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(o.timeoutMs ?? SUPPORT_LIMITS.timeoutMs),
    });
  } catch (e) {
    const timeout = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      retry: true,
      status: null,
      retryAfterMs: null,
      error: timeout ? t("Die Meldestelle hat nicht rechtzeitig geantwortet.") : t("Die Meldestelle ist gerade nicht erreichbar."),
    };
  }
  let text: string;
  try {
    text = await readLimited(res, SUPPORT_LIMITS.responseBytes);
  } catch {
    return { ok: false, retry: false, status: res.status, retryAfterMs: null, error: t("Die Antwort der Meldestelle war zu groß.") };
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = null;
  }
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, retry: false, status: res.status, retryAfterMs: null, error: t("Die Meldestelle leitet weiter – bitte ihre genaue Adresse eintragen.") };
  }
  if (res.ok) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, retry: true, status: res.status, retryAfterMs: null, error: t("Die Meldestelle hat unverständlich geantwortet.") };
    return { ok: true, status: res.status, body: body as Record<string, unknown> };
  }
  const retry = RETRY_STATUS.has(res.status);
  const fromService = serviceMessage(body);
  const error =
    fromService ??
    (res.status === 413
      ? t("Die Meldung ist der Meldestelle zu groß (z. B. das Bildschirmfoto).")
      : res.status === 429
        ? t("Die Meldestelle bittet, etwas später zu senden.")
        : retry
          ? t("Die Meldestelle hat gerade ein Problem.")
          : t("Die Meldestelle hat die Meldung abgelehnt (Fehler {status}).", { status: res.status }));
  return { ok: false, retry, status: res.status, retryAfterMs: retry ? retryAfterMs(res) : null, error };
}
