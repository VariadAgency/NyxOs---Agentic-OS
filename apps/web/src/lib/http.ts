// Kleine Fetch-Helfer, gemeinsam für `lib/api.ts` (Sessions) und die Feature-Module
// (`features/usage/api.ts`, `features/agents/api.ts`) — herausgelöst aus `lib/api.ts`, damit sie
// keine Kopie der gleichen drei Funktionen anlegen muss (eine Quelle der Wahrheit).
//
// `postJson`/`patchJson` schreiben unter `/api/*` — die Passkey-Anmeldung
// (`terminal/auth.ts` `needsAuth`) verlangt dafür denselben CSRF-Kopf wie `lib/api.ts`s
// `writeJson`. Ohne den Kopf schlägt jede schreibende Anfrage (z. B. `PATCH /api/usage/prices/:id`)
// mit 403 fehl. Beides läuft über `authFetch` (Token, 401 → „Bitte anmelden" + Wiederholung).
import { t } from "@nyxos/shared";
import { authFetch } from "../features/terminal/authClient";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as T;
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as T;
}
