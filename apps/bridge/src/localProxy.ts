// Lokale Modelle (Ollama, LM Studio) für den Server erreichbar machen (RPC `http_proxy_local`).
// Sicherheitsgrenze ist HIER, in der Brücke: nur 127.0.0.1, nur Ports aus der Erlaubnisliste (Standard: Ollama
// 11434, LM Studio 1234; weitere über `localModelPorts` in der Brücken-Konfiguration), nur GET/POST, Antwort
// höchstens 8 MB. Kein Weiterleiten auf andere Rechner, keine Umleitungen.
import { LOCAL_PROXY_DEFAULT_PORTS, LOCAL_PROXY_MAX_BYTES, LocalProxyRequestSchema, t, type LocalProxyResult } from "@nyxos/shared";

export class LocalProxyError extends Error {
  constructor(
    message: string,
    readonly code: "port_not_allowed" | "unreachable" | "too_large" | "failed",
  ) {
    super(message);
  }
}

/** Kopfzeilen, die nie weitergereicht werden (Host/Verbindung setzt fetch selbst, Cookies gehören nicht zu Modellen). */
const DROP_HEADERS = new Set(["host", "connection", "content-length", "cookie", "transfer-encoding", "accept-encoding"]);

export function allowedPorts(extra: readonly number[] | null | undefined): Set<number> {
  return new Set([...LOCAL_PROXY_DEFAULT_PORTS, ...(extra ?? []).filter((p) => Number.isInteger(p) && p > 0 && p < 65536)]);
}

export async function httpProxyLocal(params: unknown, opts: { ports: Set<number>; fetchImpl?: typeof fetch }): Promise<LocalProxyResult> {
  const req = LocalProxyRequestSchema.parse(params);
  if (!opts.ports.has(req.port)) throw new LocalProxyError(t("Port {port} ist nicht freigegeben", { port: req.port }), "port_not_allowed");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`http://127.0.0.1:${req.port}${req.path}`, {
      method: req.method,
      headers,
      body: req.method === "POST" ? (req.body ?? "") : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
    });
  } catch {
    throw new LocalProxyError(t("Dort antwortet nichts"), "unreachable");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > LOCAL_PROXY_MAX_BYTES) throw new LocalProxyError(t("Antwort zu groß"), "too_large");
  return { status: res.status, contentType: res.headers.get("content-type"), body: buf.toString("utf8") };
}
