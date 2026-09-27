// Entscheidungs-Inbox: alle offenen Fragen an einem Ort. Antwort → ENTSCHEIDUNGEN.md der
// betroffenen Baustelle (Commit in deren Repo, OHNE Push) und direkt an die wartende Session.
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { HaikuSource, InboxAnswer, InboxItem, InboxKind, InboxOption } from "@nyxos/shared";
import { quote, t } from "@nyxos/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { inboxItems } from "../db/schema.js";

const execFileP = promisify(execFile);

export const ESCALATIONS = ["produkt", "datenverlust", "budget", "build_rot", "fremder_bereich"] as const;
export type Escalation = (typeof ESCALATIONS)[number];

type Row = typeof inboxItems.$inferSelect;

export function toInboxItem(r: Row): InboxItem {
  return {
    id: r.id,
    kind: r.kind as InboxKind,
    title: r.title,
    body: r.body,
    options: (r.options ?? []) as InboxOption[],
    status: r.status as InboxItem["status"],
    answer: (r.answer ?? null) as InboxItem["answer"],
    sessionKey: r.sessionKey,
    entryId: r.entryId,
    baustelle: r.baustelle,
    decisionFile: r.decisionFile,
    sources: (r.sources ?? []) as HaikuSource[],
    createdBy: r.createdBy as InboxItem["createdBy"],
    estimateMinutes: r.estimateMinutes,
    yesNo: r.yesNo,
    escalation: r.escalation,
    delivery: (r.delivery ?? null) as InboxItem["delivery"],
    createdAt: r.createdAt,
    answeredAt: r.answeredAt,
  };
}

export const YES_NO: InboxOption[] = [
  { id: "ja", label: "Ja" },
  { id: "nein", label: "Nein" },
];
export const PLAN_OPTIONS: InboxOption[] = [
  { id: "freigeben", label: "Freigeben" },
  { id: "aendern", label: "Ändern" },
];

export interface NewInboxItem {
  kind: InboxKind;
  title: string;
  body?: string | null;
  options?: InboxOption[];
  sessionKey?: string | null;
  entryId?: number | null;
  baustelle?: string | null;
  decisionFile?: string | null;
  sources?: HaikuSource[];
  createdBy: InboxItem["createdBy"];
  estimateMinutes?: number;
  escalation?: Escalation | null;
  /** Gleiche offene Frage nicht doppelt anlegen. */
  fingerprint?: string | null;
}

export async function createInboxItem(db: Db, item: NewInboxItem): Promise<{ item: InboxItem; created: boolean }> {
  if (item.fingerprint) {
    const [existing] = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.fingerprint, item.fingerprint), eq(inboxItems.status, "open")))
      .limit(1);
    if (existing) return { item: toInboxItem(existing), created: false };
  }
  // feste Knöpfe („Ja“, „Freigeben“ …) in der App-Sprache ablegen; fremde Texte bleiben, wie sie sind.
  const options = (item.options ?? []).map((o) => ({ ...o, label: t(o.label) }));
  const yesNo = options.length === 2 && options.every((o) => o.id === "ja" || o.id === "nein");
  const [row] = await db
    .insert(inboxItems)
    .values({
      kind: item.kind,
      title: item.title.slice(0, 300),
      body: item.body ?? null,
      options,
      sessionKey: item.sessionKey ?? null,
      entryId: item.entryId ?? null,
      baustelle: item.baustelle ?? null,
      decisionFile: item.decisionFile ?? null,
      sources: item.sources ?? [],
      createdBy: item.createdBy,
      estimateMinutes: item.estimateMinutes ?? (yesNo ? 1 : 3),
      yesNo,
      escalation: item.escalation ?? null,
      fingerprint: item.fingerprint ?? null,
    })
    .returning();
  return { item: toInboxItem(row as Row), created: true };
}

export async function listInbox(db: Db, status: "open" | "all"): Promise<InboxItem[]> {
  const rows = await db
    .select()
    .from(inboxItems)
    .where(status === "open" ? eq(inboxItems.status, "open") : sql`true`)
    .orderBy(desc(inboxItems.createdAt))
    .limit(300);
  return rows.map(toInboxItem);
}

export async function getInboxItem(db: Db, id: number): Promise<InboxItem | null> {
  const [row] = await db.select().from(inboxItems).where(eq(inboxItems.id, id)).limit(1);
  return row ? toInboxItem(row) : null;
}

/** Text, der in ENTSCHEIDUNGEN.md bzw. in die Session geht. */
export function answerText(item: InboxItem, answer: InboxAnswer): string {
  const opt = answer.optionId ? item.options.find((o) => o.id === answer.optionId) : undefined;
  const parts = [opt?.label, answer.text?.trim()].filter((x): x is string => !!x && x.length > 0);
  return parts.join(" – ");
}

export interface DeliveryDeps {
  /** Schreibt Text in die wartende Session (P3 `send_text` über die Brücke). null = nicht verfügbar. */
  sendToSession: ((sessionKey: string, text: string) => Promise<"sent" | "queued" | "skipped" | "failed">) | null;
  /** Wurzel, unter der ENTSCHEIDUNGEN.md liegen darf (Sicherheitsgrenze, der Projektordner). */
  decisionsRoot: string | null;
  now?: () => Date;
  /** Zusatz-Wirkung einer Antwort (z. B. Sortier-Vorschlag annehmen); Rückgabe = Hinweis-Text. */
  onAnswered?: (item: InboxItem & { fingerprint: string | null }, answer: InboxAnswer) => Promise<string | null>;
}

/** Hängt eine Entscheidung an ENTSCHEIDUNGEN.md an und committet NUR diese Datei (kein Push). */
export async function recordDecision(root: string, file: string, entry: string): Promise<{ commit: string | null; note: string | null }> {
  const abs = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith("..") || isAbsolute(rel) || !abs.endsWith("ENTSCHEIDUNGEN.md")) return { commit: null, note: t("Pfad außerhalb des erlaubten Bereichs") };
  await mkdir(dirname(abs), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(abs, "utf8");
  } catch {
    await writeFile(abs, "# Entscheidungen\n\nVom Nutzer beantwortet (über die Entscheidungs-Inbox der NyxOS).\n", "utf8");
  }
  await appendFile(abs, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}\n${entry}\n`, "utf8");
  try {
    // realpath: macOS-Temp-Ordner (/var → /private/var), sonst passt der Pfad nicht zum git-Toplevel.
    const cwd = await realpath(dirname(abs));
    const { stdout: top } = await execFileP("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const repo = await realpath(top.trim());
    const inRepo = relative(repo, join(cwd, basename(abs)));
    await execFileP("git", ["-C", repo, "add", "--", inRepo]);
    await execFileP("git", ["-C", repo, "commit", "-q", "-m", "Entscheidung aus der NyxOS-Inbox", "--", inRepo], { env: { ...process.env, GIT_AUTHOR_NAME: "NyxOS", GIT_COMMITTER_NAME: "NyxOS", GIT_AUTHOR_EMAIL: "nyxos@localhost", GIT_COMMITTER_EMAIL: "nyxos@localhost" } });
    const { stdout: sha } = await execFileP("git", ["-C", repo, "rev-parse", "--short", "HEAD"]);
    return { commit: sha.trim(), note: null };
  } catch (e) {
    return { commit: null, note: t("eingetragen, aber kein Commit: {error}", { error: e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e) }) };
  }
}

/** Fingerabdruck eines Sortier-Vorschlags von Nyx: „sort:<session>:<art>“ (s. auftrag.ts `suggestSorting`). */
const SORT_FINGERPRINT = /^sort:(.+):([a-z_]+)$/;
export function parseSortFingerprint(fingerprint: string | null | undefined): { sessionKey: string; art: string } | null {
  const m = SORT_FINGERPRINT.exec(fingerprint ?? "");
  return m?.[1] && m[2] ? { sessionKey: m[1], art: m[2] } : null;
}

/**
 * nur ECHTE Sortier-Vorschläge – von Nyx angelegt, genaues Format, und die Session im
 * Fingerabdruck ist die Session des Eintrags. Ein bloßes „sort:“-Präfix reicht nicht (sonst verschluckt eine
 * falsch gebaute Karte die Antwort an eine Session).
 */
export function isSortSuggestion(item: Pick<InboxItem, "createdBy" | "sessionKey">, fingerprint: string | null | undefined): boolean {
  const p = parseSortFingerprint(fingerprint);
  return p !== null && item.createdBy === "haiku" && p.sessionKey === item.sessionKey;
}

export async function answerInboxItem(db: Db, id: number, answer: InboxAnswer, deps: DeliveryDeps): Promise<{ item: InboxItem } | { error: "not_found" | "not_open" }> {
  const item = await getInboxItem(db, id);
  if (!item) return { error: "not_found" };
  if (item.status !== "open") return { error: "not_open" };
  if (answer.optionId && !item.options.some((o) => o.id === answer.optionId)) return { error: "not_open" };
  const now = (deps.now ?? (() => new Date()))();
  const text = answerText(item, answer);
  // Atomar schließen, damit zwei gleichzeitige Antworten nicht doppelt liefern.
  const [claimed] = await db
    .update(inboxItems)
    .set({ status: "answered", answer: { optionId: answer.optionId ?? null, text: answer.text ?? null }, answeredAt: now.toISOString() })
    .where(and(eq(inboxItems.id, id), eq(inboxItems.status, "open")))
    .returning({ id: inboxItems.id });
  if (!claimed) return { error: "not_open" };

  let decisionCommit: string | null = null;
  let note: string | null = null;
  if (item.kind !== "plan" && item.decisionFile && deps.decisionsRoot) {
    const day = now.toISOString().slice(0, 10);
    const entry = `## ${day} · ${item.title}\n\n**Antwort:** ${text}${item.sessionKey ? `\n\nFrage kam aus Session \`${item.sessionKey}\`.` : ""}`;
    const r = await recordDecision(deps.decisionsRoot, item.decisionFile, entry);
    decisionCommit = r.commit;
    note = r.note;
  }
  const [raw] = await db.select({ fp: inboxItems.fingerprint }).from(inboxItems).where(eq(inboxItems.id, id)).limit(1);
  const fingerprint = raw?.fp ?? null;
  let toSession: "sent" | "queued" | "skipped" | "failed" | null = null;
  // Sortier-Vorschläge („sort:<session>:<art>“) betreffen nur die Ablage in NyxOS – die Session hat
  // nichts gefragt und kann mit „Sortier-Vorschlag … – Ja“ nichts anfangen. Also nichts schicken, nur sortieren.
  if (item.sessionKey && deps.sendToSession && item.kind !== "plan" && !isSortSuggestion(item, fingerprint)) {
    // HB: Hat NICHT die Session gefragt (z. B. Haikus Freigabe-Karte), kennt sie die Frage nicht —
    // ein nacktes „Freigeben“ wäre mehrdeutig. Dann geht die Frage mit.
    const said = item.createdBy === "session" ? text : `${quote(item.title)} – ${text}`;
    toSession = await deps.sendToSession(item.sessionKey, t("Antwort vom Nutzer (Entscheidungs-Inbox): {answer}", { answer: said })).catch(() => "failed" as const);
  }
  if (deps.onAnswered) {
    const extra = await deps.onAnswered({ ...item, fingerprint }, answer).catch((e: unknown) => t("Fehler: {error}", { error: String(e) }));
    if (extra) note = note ? `${note}; ${extra}` : extra;
  }
  const delivery = { toSession, decisionCommit, note };
  const [row] = await db.update(inboxItems).set({ delivery }).where(eq(inboxItems.id, id)).returning();
  return { item: toInboxItem(row as Row) };
}

export async function dismissInboxItem(db: Db, id: number): Promise<InboxItem | null> {
  const [row] = await db.update(inboxItems).set({ status: "dismissed", answeredAt: new Date().toISOString() }).where(and(eq(inboxItems.id, id), eq(inboxItems.status, "open"))).returning();
  return row ? toInboxItem(row) : null;
}
