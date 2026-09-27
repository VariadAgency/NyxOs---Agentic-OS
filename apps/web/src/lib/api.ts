// Typen und Fetch-Helfer für die NyxOS-API (Pfade unter /api).
import { t } from "@nyxos/shared";
import { authFetch } from "../features/terminal/authClient";
// EINE `ApiError`-Klasse (aus `lib/http.ts`) – vorher gab es hier eine zweite gleichnamige,
// `instanceof` gegen die andere war nie wahr (roter Chat-Fehler bei 404).
import { ApiError } from "./http";
import type { CatchupRecord, ChangesResponse, CollisionEntry, ConflictsSnapshot, ContainerLogs, GitBranchDetail, GitCommitDetail, GitCommitRow, GitDashboard, GitWorktreeDetail, LearnedRule, OverviewSnapshot, RepoSnapshot, Reservation, SearchAllResponse, ServerSnapshot, TemporaryReason } from "@nyxos/shared";

export interface Baustelle {
  slug: string;
  label: string;
}

export interface CategoryReason {
  stage: string;
  detail: string;
  ruleId: number | null;
}

/** Zustand aus `computeSessionState` — `null` bei sauber beendeten Sessions ohne Zustand. */
export type SessionState = "running" | "waiting" | "idle" | "crashed" | "closed" | null;

/** Mirror von `packages/shared/src/events.ts` `SubagentInfoSchema` — Form von `sessions.subagents`. */
export interface SubagentInfo {
  id: string;
  name: string | null;
  type: string | null;
}

export interface Session {
  id: string;
  tool: "claude" | "codex";
  sessionId: string;
  machineId: string | null;
  parentId: string | null;
  title: string | null;
  titleSource: string | null;
  status: "running" | "ended";
  cwd: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  endedAt: string | null;
  models: string[];
  /** Modell der zuletzt gesehenen Antwort (das AKTUELLE Modell, `models` ist die Reihenfolge des ersten Auftretens). */
  lastUsageModel?: string | null;
  tokens: Record<string, number>;
  tokensTotal: number;
  toolCalls: Record<string, number>;
  subagents: SubagentInfo[];
  limits: unknown;
  parsedEventCount: number;
  eventCount: number;
  parseErrors: number;
  state: SessionState;
  closedAt: string | null;
  closedBy: string | null;
  categoryRuleId: number | null;
  categoryManual: boolean;
  /** Art laut `categorize()` — s. `lib/arts.ts` für Reihenfolge/Label. */
  art: string;
  baustelle: Baustelle | null;
  reason: CategoryReason[];
  /** tmux-Session auf dem Rechner (`zc-<werkzeug>-<id>`), null = nicht in tmux. */
  tmuxName?: string | null;
  /** Terminal kann aus der Web-App geöffnet werden. */
  attachable?: boolean;
  /** „nyxos" = aus der Web-App gestartet (Standard „Nur ansehen" aus). */
  startedVia?: string | null;
  /** Anteil der letzten Antwort am Kontextfenster des Modells, 0–100+.
   * `null` = unbekannt (Modell ohne hinterlegtes Kontextfenster) — nie geschätzt anzeigen. */
  contextPct: number | null;
  contextWindow: number | null;
  contextWindowSource: string | null;
  /** Temporär seit (null = normale Session), Grund und wann sie archiviert wird. */
  temporarySince?: string | null;
  temporaryReason?: TemporaryReason | null;
  temporaryExpiresAt?: string | null;
  /** Im Archiv seit (null = sichtbar). Nur über den direkten Link bzw. das Archiv erreichbar. */
  archivedAt?: string | null;
}

export interface Machine {
  id: string;
  name: string;
  lastSeenAt: string | null;
}

export interface HealthResult {
  ok: boolean;
  checks?: Record<string, unknown>;
}

export interface CategoryCount {
  art: string;
  count: number;
  baustellen: { slug: string | null; label: string; count: number }[];
}

export interface SessionFile {
  sessionKey: string;
  path: string;
  mode: "read" | "write";
  firstSeenAt: string;
}

export interface ArchiveFile {
  tool: "claude" | "codex";
  path: string;
  sha256: string;
  size: number;
  sessionKey: string;
  updatedAt: string;
}

export interface SessionEventRow {
  id: string;
  sessionKey: string;
  ts: string;
  kind: string;
  source: string;
  data: unknown;
  receivedAt: string;
}

export interface SessionDetail {
  session: Session;
  files: SessionFile[];
  archive: ArchiveFile[];
  events: SessionEventRow[];
}

/** Welche Dimension eine `sort_rules`-Zeile setzt ("getrennte Dimensionen"). */
export type RuleDimension = "art" | "baustelle";

export interface SortRuleRow {
  id: number;
  dimension: RuleDimension;
  condition: unknown;
  targetArt: string | null;
  targetBaustelleSlug: string | null;
  targetBaustelleLabel: string | null;
  origin: string;
  active: boolean;
  createdAt: string;
}

/** Body für `assign`/`assign/preview`: nur Felder mitschicken, die korrigiert werden sollen — ein
 * fehlendes Feld heißt "diese Dimension nicht anfassen", nicht "auf leer setzen". */
export interface AssignTarget {
  art?: string;
  baustelle?: Baustelle | null;
}

export interface AssignResult {
  rules: SortRuleRow[];
  resorted: string[];
  /** Dimensionen ohne tragfähige Bedingung (oder `asRule = false`) — nur diese Session wurde zugeordnet. */
  manualOnly: RuleDimension[];
}

export interface AssignPreviewDimension {
  condition: { text: string; structured: unknown } | null;
  /** Nur gesetzt, wenn `condition === null`: erklärt, warum keine Regel möglich ist. */
  reason: string | null;
}

export interface AssignPreviewAffected {
  sessionId: string;
  title: string | null;
  fromArt: string;
  toArt: string;
  fromBaustelle: Baustelle | null;
  toBaustelle: Baustelle | null;
}

export interface AssignPreview {
  art: AssignPreviewDimension | null;
  baustelle: AssignPreviewDimension | null;
  affected: AssignPreviewAffected[];
  affectedCount: number;
}


async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as T;
}

/** Schreibende Anfragen über `authFetch` — Token immer dabei, bei 401 „Bitte anmelden" und
 * danach Wiederholung, bei veraltetem Token einmal still erneuern. */
export async function writeJson<T>(method: "POST" | "PATCH", url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // kein JSON
    }
    throw new ApiError(detail || t("Server antwortet mit {status}", { status: res.status }), res.status);
  }
  return (await res.json()) as T;
}

const postJson = <T>(url: string, body: unknown) => writeJson<T>("POST", url, body);
const patchJson = <T>(url: string, body: unknown) => writeJson<T>("PATCH", url, body);

// DELETE ist auch eine schreibende Anfrage (`needsAuth` in `terminal/auth.ts`
// schützt jede nicht-GET/HEAD-Anfrage unter /api/*) — braucht denselben CSRF-Kopf wie `writeJson`.
async function deleteJson<T>(url: string): Promise<T> {
  const res = await authFetch(url, { method: "DELETE" });
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as T;
}

/** `/health` meldet eine Störung mit 503 UND Befund `{ ok: false, checks }` — den Befund durchreichen, damit die
 * Statuszeile „Server meldet eine Störung“ sagen kann, statt nur „liefert Fehler“. */
export async function fetchHealth(): Promise<HealthResult> {
  const res = await fetch("/health");
  if (res.status === 503) {
    const body = (await res.json().catch(() => null)) as HealthResult | null;
    if (body && body.ok === false) return body;
  }
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as HealthResult;
}

export const fetchMachines = (): Promise<Machine[]> => getJson<Machine[]>("/api/machines");

/** Zustand der Brücke, fertig gerechnet vom Server (Server-Uhr, s. server/src/bridge/presence.ts). */
export type BridgeState = "online" | "reconnecting" | "offline";

export interface BridgePresence {
  state: BridgeState;
  /** Grund bei „verbindet neu"/„offline" (deutsch, für die Anzeige). */
  reason: string | null;
  /** Seit wann dieser Zustand gilt (Server-Uhr). */
  since: string;
  heartbeatAgeMs: number | null;
  channelOpen: boolean;
  machine: { id: string; name: string } | null;
  /** Server-Zeit der Antwort — „seit …" wird relativ dazu gerechnet, nie gegen die Browser-Uhr. */
  serverNow: string;
}

export interface BridgeHistoryItem {
  at: string;
  state: BridgeState;
  reason: string | null;
  /** `null` = läuft noch. */
  durationMs: number | null;
}

export const fetchBridgePresence = (): Promise<BridgePresence> => getJson<BridgePresence>("/api/bridge/presence");

export const fetchBridgeHistory = (hours = 24): Promise<BridgeHistoryItem[]> =>
  getJson<{ events: BridgeHistoryItem[] }>(`/api/bridge/presence/history?hours=${hours}`).then((b) => b.events);

export const fetchSessions = (): Promise<Session[]> =>
  getJson<{ sessions: Session[] }>("/api/sessions?limit=2000").then((body) => body.sessions);

export const fetchCategories = (): Promise<CategoryCount[]> =>
  getJson<{ categories: CategoryCount[] }>("/api/categories").then((body) => body.categories);

export const fetchSessionDetail = (id: string): Promise<SessionDetail> => getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);

/** `asRule` default `true` — nur mit `false` explizit "nur diese Session, nie eine Regel". */
export function assignSession(id: string, target: AssignTarget, asRule = true): Promise<AssignResult> {
  return postJson<AssignResult>(`/api/sessions/${encodeURIComponent(id)}/assign`, { ...target, asRule });
}

/** Wie `assignSession`, schreibt aber nichts — zeigt die Bedingung + wie viele andere Sessions sich ändern würden. */
export function previewAssign(id: string, target: AssignTarget): Promise<AssignPreview> {
  return postJson<AssignPreview>(`/api/sessions/${encodeURIComponent(id)}/assign/preview`, target);
}

/** Rückgängig für eine `assignSession` (Toast-Knopf): schaltet die angelegten Regeln ab und hebt die
 * Sperre für die übergebenen Dimensionen wieder auf. */
export function unassignSession(id: string, ruleIds: number[], dims: RuleDimension[]): Promise<{ ok: true; resorted: string[] }> {
  return postJson<{ ok: true; resorted: string[] }>(`/api/sessions/${encodeURIComponent(id)}/unassign`, { ruleIds, dims });
}

export const fetchSortRules = (): Promise<{ rules: SortRuleRow[] }> => getJson<{ rules: SortRuleRow[] }>("/api/sort-rules");

export function setSortRuleActive(id: number, active: boolean): Promise<{ ok: true; resorted: string[] }> {
  return patchJson<{ ok: true; resorted: string[] }>(`/api/sort-rules/${id}`, { active });
}

export function closeSession(id: string, by = "user"): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/close`, { by });
}

export function reopenSession(id: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/reopen`, {});
}

// ---- Chat-Verlauf (mit `around`/`anchorIndex`) ----

export type TranscriptRole = "user" | "assistant" | "tool" | "subagent" | "system";

export interface TranscriptTool {
  name: string;
  target?: string | null;
  status?: "ok" | "error";
}

export interface TranscriptSubagent {
  id: string;
  title?: string | null;
  count: number;
}

export interface TranscriptItem {
  id: string;
  ts: string;
  role: TranscriptRole;
  text?: string;
  tool?: TranscriptTool;
  subagent?: TranscriptSubagent;
  /** Nur bei `role: "system"`: `true` = reine Plumbing-Meta (Anhänge,
   * generische System-Zeilen) — die UI blendet sie standardmäßig ein-/ausklappbar aus. */
  internal?: boolean;
  /** Bilder, die der Nutzer mit dieser Eingabe geschickt hat (Vorschau über `/attachments/…`). */
  images?: { n: number; mediaType: string; bytes: number }[];
  thinking: false;
}

export interface TranscriptResponse {
  items: TranscriptItem[];
  nextCursor: string | null;
  prevCursor: string | null;
  total?: number;
  archivedAt: string | null;
  sha256: string | null;
  /** Nur bei `around`-Abfrage gesetzt (Such-Sprung): Index des Treffers in `items`. */
  anchorIndex?: number;
}

export interface TranscriptQuery {
  cursor?: string | null;
  limit?: number;
  direction?: "forward" | "backward";
  subagent?: string | null;
  around?: number | null;
}

export function fetchTranscript(id: string, query: TranscriptQuery = {}, signal?: AbortSignal): Promise<TranscriptResponse> {
  const params = new URLSearchParams();
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.direction) params.set("direction", query.direction);
  if (query.subagent) params.set("subagent", query.subagent);
  if (query.around !== undefined && query.around !== null) params.set("around", String(query.around));
  const qs = params.toString();
  return getJson<TranscriptResponse>(`/api/sessions/${encodeURIComponent(id)}/transcript${qs ? `?${qs}` : ""}`, signal);
}

// ---- Suche (GET /api/search?q=&limit=) ----

export interface SearchHit {
  sessionKey: string;
  sessionId: string;
  tool: "claude" | "codex";
  title: string | null;
  art: string;
  baustelle: Baustelle | null;
  state: SessionState;
  closed: boolean;
  field: "title" | "prompt" | "file" | "chat";
  /** HTML mit serverseitig escaptem `<mark>…</mark>` um den Treffer — einzige erlaubte Stelle für dangerouslySetInnerHTML. */
  snippet: string;
  position: number | null;
}

export interface SearchResponse {
  hits: SearchHit[];
  tookMs: number;
}

export function searchSessions(q: string, limit = 20): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return getJson<SearchResponse>(`/api/search?${params.toString()}`);
}

/** ⌘K sucht alles (gruppiert, je Gruppe höchstens 5 Treffer). */
export function searchEverything(q: string, signal?: AbortSignal): Promise<SearchAllResponse> {
  return getJson<SearchAllResponse>(`/api/search/all?${new URLSearchParams({ q }).toString()}`, signal);
}

// ---- Bezüge (GET /api/sessions/:id/related) ----

export interface RelatedSameFile {
  sessionKey: string;
  sessionId: string;
  title: string | null;
  tool: "claude" | "codex";
  state: SessionState;
  art: string;
  baustelle: Baustelle | null;
  /** Höchstens 5 Beispielpfade — `sharedCount` trägt die echte Gesamtzahl. */
  sharedFiles: string[];
  sharedCount: number;
}

export interface RelatedResponse {
  parent: Session | null;
  children: Session[];
  /** Sessions mit mindestens einer gemeinsam geschriebenen Datei, nach `sharedCount` absteigend, max. 20. */
  sameFiles: RelatedSameFile[];
}

export const fetchRelatedSessions = (id: string): Promise<RelatedResponse> => getJson<RelatedResponse>(`/api/sessions/${encodeURIComponent(id)}/related`);

// ---- Überblick, Git, Konflikte, Server, Lernbuch ----

export const fetchOverview = (): Promise<OverviewSnapshot> => getJson<OverviewSnapshot>("/api/overview");
/** Was seit `since` passiert ist (ISO, „8h“, „7d“, „gestern“; Standard 24 Std). */
export const fetchChanges = (since: string): Promise<ChangesResponse> => getJson<ChangesResponse>(`/api/changes?since=${encodeURIComponent(since)}`);

export const fetchGit = (): Promise<{ repos: RepoSnapshot[] }> => getJson<{ repos: RepoSnapshot[] }>("/api/git");

export const fetchGitCatchups = (repoId?: string): Promise<{ catchups: CatchupRecord[] }> =>
  getJson<{ catchups: CatchupRecord[] }>(`/api/git/catchups${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ""}`);

// ---- neue Git-Seite ----
export const fetchGitDashboard = (): Promise<GitDashboard> => getJson<GitDashboard>("/api/git/dashboard");
export const fetchGitCommit = (repoId: string, sha: string): Promise<GitCommitDetail> =>
  getJson<GitCommitDetail>(`/api/git/commit/${encodeURIComponent(repoId)}/${encodeURIComponent(sha)}`);
export const fetchGitBranch = (repoId: string, name: string): Promise<GitBranchDetail> =>
  getJson<GitBranchDetail>(`/api/git/branch/${encodeURIComponent(repoId)}?name=${encodeURIComponent(name)}`);
export const fetchGitWorktree = (repoId: string): Promise<GitWorktreeDetail> => getJson<GitWorktreeDetail>(`/api/git/worktree/${encodeURIComponent(repoId)}`);
export const fetchGitDay = (day: string): Promise<{ commits: GitCommitRow[] }> => getJson<{ commits: GitCommitRow[] }>(`/api/git/commits?day=${encodeURIComponent(day)}`);

export const fetchConflicts = (): Promise<ConflictsSnapshot & { collisionMap: CollisionEntry[] }> => getJson("/api/conflicts");

export const fetchReservations = (): Promise<{ reservations: Reservation[] }> => getJson<{ reservations: Reservation[] }>("/api/reservations");

/** Anders als `postJson`: wirft NICHT bei 409 (überlappende Reservierung) — der Aufrufer
 * unterscheidet über `"reservation" in result`, um die Begründung anzuzeigen statt nur "Fehler". */
export async function createReservation(input: { pathGlob: string; label: string; untilMinutes?: number | null }): Promise<{ reservation: Reservation } | { error: string; conflictingReservation: Reservation | null }> {
  const res = await authFetch("/api/reservations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = (await res.json()) as { reservation: Reservation } | { error: string; conflictingReservation: Reservation | null };
  if (!res.ok && !("error" in body)) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return body;
}

export function deleteReservation(id: number): Promise<{ ok: true }> {
  return deleteJson<{ ok: true }>(`/api/reservations/${id}`);
}

export const fetchServer = (): Promise<ServerSnapshot> => getJson<ServerSnapshot>("/api/server");

/** Letzte Zeilen eines Containers. Nur mit Anmeldung (Logs können Zugangsdaten enthalten) —
 * `authFetch` öffnet bei 401 „Bitte anmelden“ und fragt danach noch einmal. */
export async function fetchContainerLogs(id: string, tail = 200): Promise<ContainerLogs> {
  const res = await authFetch(`/api/server/containers/${encodeURIComponent(id)}/logs?tail=${tail}`);
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    throw new ApiError(detail ?? t("Die Logs sind gerade nicht lesbar."), res.status);
  }
  return (await res.json()) as ContainerLogs;
}

export const fetchRules = (): Promise<{ rules: LearnedRule[] }> => getJson<{ rules: LearnedRule[] }>("/api/rules");

export function setRuleActive(id: number, active: boolean): Promise<{ ok: true }> {
  return patchJson<{ ok: true }>(`/api/rules/${id}`, { active });
}

export { ApiError };
