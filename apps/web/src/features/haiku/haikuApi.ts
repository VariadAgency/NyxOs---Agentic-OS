// Fetch-Helfer für Haiku, Inbox, Freigaben und Ideen-Links (Vertrag: packages/shared/src/haiku.ts,
// approvals.ts). Alle schreibenden Aufrufe laufen über `request()` bzw. `authFetch` — der
// CSRF-Kopf und „Bitte anmelden“ stecken dort an EINER Stelle (auch für den NDJSON-Strom).
import type {
  Approval,
  BriefingSpeech,
  DecisionRefKind,
  DecisionSummary,
  HaikuCall,
  HaikuChatRequest,
  HaikuErrorCode,
  HaikuMessage,
  HaikuReport,
  HaikuSelftest,
  HaikuSettingsPatch,
  HaikuStatus,
  HaikuStreamEvent,
  HaikuThread,
  HaikuThreadObsidianResult,
  HaikuThreadTaskResult,
  IdeaLink,
  IdeaLinkCreate,
  IdeaLinkCreated,
  InboxAnswer,
  InboxItem,
  LightDay,
  OpenQuestionCounts,
} from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { readAnswerLength } from "./answerLength";
import { authFetch, LoginRequiredError } from "../terminal/authClient";

export class HaikuApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** Rückfall-Text, wenn der Server keinen eigenen Hinweis schickt. */
export function serverStatusMessage(status: number): string {
  return t("Server antwortet mit {status}", { status });
}

async function errorFrom(res: Response): Promise<HaikuApiError> {
  let code: string | null = null;
  let message = serverStatusMessage(res.status);
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown; message?: unknown };
    if (typeof body.code === "string") code = body.code;
    else if (typeof body.error === "string" && /^[a-z_]+$/.test(body.error)) code = body.error;
    if (typeof body.message === "string") message = body.message;
    else if (typeof body.error === "string") message = body.error;
  } catch {
    // Kein JSON — Status reicht.
  }
  return new HaikuApiError(message, res.status, code);
}

async function request<T>(url: string, init?: { method: "POST" | "PATCH" | "DELETE"; body: unknown }): Promise<T> {
  // Schreibend über `authFetch` (Token, 401 → „Bitte anmelden" + Wiederholung).
  const res = init ? await authFetch(url, { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }) : await fetch(url);
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

export const getJson = <T>(url: string): Promise<T> => request<T>(url);
export const postJson = <T>(url: string, body: unknown): Promise<T> => request<T>(url, { method: "POST", body });
export const patchJson = <T>(url: string, body: unknown): Promise<T> => request<T>(url, { method: "PATCH", body });

// ───────────── Chat (NDJSON) ─────────────

/** Zerlegt einen Byte-Strom in NDJSON-Zeilen; eine Zeile darf über mehrere Stücke verteilt ankommen. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (value: unknown) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onLine(JSON.parse(trimmed));
    } catch {
      // Kaputte Zeile überspringen statt den ganzen Strom abzubrechen.
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    emit(buffer);
  } finally {
    reader.releaseLock();
  }
}

/** `POST /api/haiku/chat` → ruft `onEvent` je NDJSON-Zeile. HTTP-Fehler vor dem Strom → ein `error`-Ereignis.
 * Die gemerkte Längen-Wahl (Auto · Kurz · Normal · Ausführlich) geht mit jeder Anfrage mit – getippt wie gesprochen. */
export async function streamHaikuChat(req: HaikuChatRequest, onEvent: (event: HaikuStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  const body: HaikuChatRequest = { ...req, length: req.length ?? readAnswerLength() };
  try {
    res = await authFetch("/api/haiku/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e instanceof LoginRequiredError) {
      onEvent({ type: "error", code: "auth", message: e.message });
      return;
    }
    throw e;
  }
  if (!res.ok) {
    const err = await errorFrom(res);
    onEvent({ type: "error", code: toErrorCode(err.code, res.status), message: err.message });
    return;
  }
  if (!res.body) {
    onEvent({ type: "error", code: "engine", message: t("Leere Antwort vom Server") });
    return;
  }
  await readNdjson(res.body, (value) => onEvent(value as HaikuStreamEvent), signal);
}

const ERROR_CODES: readonly HaikuErrorCode[] = ["disabled", "not_ready", "budget", "timeout", "engine", "busy", "rate_limit", "invalid"];

function toErrorCode(code: string | null, status: number): HaikuErrorCode {
  if (code && (ERROR_CODES as readonly string[]).includes(code)) return code as HaikuErrorCode;
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "invalid";
  if (status === 504) return "timeout";
  return "engine";
}

// ───────────── Haiku ─────────────

export const fetchThreads = () => getJson<{ threads: HaikuThread[] }>("/api/haiku/threads").then((b) => b.threads);
export const fetchThread = (id: number) => getJson<{ thread: HaikuThread; messages: HaikuMessage[] }>(`/api/haiku/threads/${id}`);
/** Faden temporär machen bzw. behalten. */
export const patchThread = (id: number, patch: { temporary: boolean }) => patchJson<{ thread: HaikuThread }>(`/api/haiku/threads/${id}`, patch).then((b) => b.thread);
// Menü „⋯“ am Faden.
export const fetchArchivedThreads = () => getJson<{ threads: HaikuThread[] }>("/api/haiku/threads?archived=1").then((b) => b.threads);
export const setThreadArchived = (id: number, archived: boolean) => patchJson<{ thread: HaikuThread }>(`/api/haiku/threads/${id}`, { archived }).then((b) => b.thread);
export const deleteThread = (id: number) => request<{ deleted: number }>(`/api/haiku/threads/${id}`, { method: "DELETE", body: {} });
export const summarizeThread = (id: number) => postJson<{ message: HaikuMessage }>(`/api/haiku/threads/${id}/summary`, {}).then((b) => b.message);
/** `existing` = aus diesem Faden gab es schon eine Aufgabe (dann ohne neue Karte). */
export const threadToTask = (id: number) => postJson<HaikuThreadTaskResult | { entry: HaikuThreadTaskResult["entry"]; existing: true }>(`/api/haiku/threads/${id}/task`, {});
export const threadToObsidian = (id: number) => postJson<HaikuThreadObsidianResult>(`/api/haiku/threads/${id}/obsidian`, {});
export const fetchHaikuStatus = () => getJson<HaikuStatus>("/api/haiku/status");
export const patchHaikuSettings = (patch: HaikuSettingsPatch) => patchJson<HaikuStatus>("/api/haiku/settings", patch);
/** „Motor testen“ – echte Frage „Wer bist du?“ durch dieselbe Laufzeit wie das Panel. */
export const runHaikuSelftest = () => postJson<HaikuSelftest>("/api/haiku/selftest", {});
export const fetchHaikuCalls = (limit = 50) => getJson<{ calls: HaikuCall[] }>(`/api/haiku/calls?limit=${limit}`).then((b) => b.calls);
export const fetchReport = (kind: HaikuReport["kind"]) => getJson<{ report: HaikuReport | null }>(`/api/haiku/report?kind=${kind}`).then((b) => b.report);
export const createReport = (kind: HaikuReport["kind"]) => postJson<{ report: HaikuReport }>("/api/haiku/report", { kind }).then((b) => b.report);
/** Sprechfassung eines gespeicherten Berichts (Sätze mit Abschnitt + Stelle auf der Seite). */
export const fetchBriefingSpeech = (reportId: number) => getJson<{ speech: BriefingSpeech }>(`/api/briefing/${reportId}/speech`).then((b) => b.speech);
export const fetchLightDay = () => getJson<LightDay>("/api/haiku/light-day");
export const releaseAll = (ids: string[]) => postJson<{ released: number }>("/api/haiku/release-all", { ids });

// ───────────── Inbox + Freigaben ─────────────

export const fetchInbox = (status: "open" | "all") => getJson<{ items: InboxItem[] }>(`/api/inbox?status=${status}`).then((b) => b.items);
export const answerInbox = (id: number, answer: InboxAnswer) => postJson<{ item: InboxItem }>(`/api/inbox/${id}/answer`, answer).then((b) => b.item);
export const dismissInbox = (id: number) => postJson<{ item: InboxItem }>(`/api/inbox/${id}/dismiss`, {}).then((b) => b.item);
/** EINE Zahl „offene Fragen“ (Freigaben + Entscheidungs-Karten + Konflikt-Fragen), vom Server-Schnappschuss. */
export const fetchOpenQuestions = () => getJson<OpenQuestionCounts>("/api/open-questions");
export const fetchApprovals = (status: "pending" | "all") => getJson<{ approvals: Approval[] }>(`/api/approvals?status=${status}`).then((b) => b.approvals);
/** Nyx-Einschätzung (drei Teile) zu einer Entscheidung; `fresh` = neu fragen statt aus dem Speicher. */
export const fetchDecisionSummary = (kind: DecisionRefKind, id: number, fresh = false) =>
  postJson<{ summary: DecisionSummary }>(`/api/${kind === "approval" ? "approvals" : "inbox"}/${id}/nyx-summary`, fresh ? { fresh: true } : {}).then((b) => b.summary);
export const decideApproval = (id: number, decision: "approve" | "deny") =>
  postJson<{ approval: Approval }>(`/api/approvals/${id}/decide`, { decision }).then((b) => b.approval);

// ───────────── Ideen-Links ─────────────

export const fetchIdeaLinks = () => getJson<{ links: IdeaLink[] }>("/api/idealinks").then((b) => b.links);
export const createIdeaLink = (body: IdeaLinkCreate) => postJson<IdeaLinkCreated>("/api/idealinks", body);
export const revokeIdeaLink = (id: number) => postJson<{ link: IdeaLink }>(`/api/idealinks/${id}/revoke`, {}).then((b) => b.link);
