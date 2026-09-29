// „Offene Fragen“ überall dieselbe Zahl — auch mit gemischten Fällen (lebende/tote/Test-Sessions,
// abgelaufene Freigaben), und Test-Sessions erzeugen keine Konflikt-Fragen (dieselbe Regel wie `countedSession`).
import { formatTokensCompact, type ConflictsSummary, type OverviewSnapshot } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { approvals, sessionFiles, sessions } from "../src/db/schema.js";
import { createInboxItem } from "../src/haiku/inbox.js";
import { validateStatement } from "../src/haiku/report.js";
import { setup } from "./helpers.js";

type App = Awaited<ReturnType<typeof setup>>;

const ROOT = "/Users/alex/projects/tools/NyxOS/apps";
const DAY = 24 * 3600_000;

const alive = { status: "running", state: "running", turnOpen: true, lastActivityAt: new Date().toISOString() } as const;
const waiting = { ...alive, state: "waiting", turnOpen: false } as const;
const idle = { ...alive, state: "idle" } as const;
const ended = { status: "ended", state: null, turnOpen: false, lastActivityAt: new Date(Date.now() - 3 * DAY).toISOString() } as const;
const crashed = { status: "ended", state: "crashed", turnOpen: true, lastActivityAt: new Date(Date.now() - 3600_000).toISOString() } as const;

async function makeSession(t: App, id: string, extra: Partial<typeof sessions.$inferInsert>) {
  const [tool, sessionId] = id.split(":") as [string, string];
  await t.db.insert(sessions).values({ id, tool, sessionId, title: id, ...extra });
}

async function writes(t: App, sessionKey: string, paths: string[]) {
  await t.db.insert(sessionFiles).values(paths.map((path) => ({ sessionKey, path, mode: "write" })));
}

async function json<T>(t: App, path: string): Promise<T> {
  const res = await t.app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

/** 3 Konflikt-Fragen (3 Ordner, je 2 lebende Schreiber, teils mit toten/abgestürzten Mitschreibern),
 * dazu Rückblick-Fälle, die NICHT zählen dürfen: nur Tote, eine Lebende + eine Tote, eine Echte + eine Test-Session. */
async function seedMixed(t: App) {
  await makeSession(t, "claude:a", alive);
  await makeSession(t, "claude:b", waiting);
  await makeSession(t, "codex:c", idle);
  await makeSession(t, "codex:tot", ended);
  await makeSession(t, "claude:crash", crashed);
  await makeSession(t, "claude:probe", { ...alive, temporarySince: new Date().toISOString(), temporaryReason: "probe_folder" });
  await makeSession(t, "claude:selbst", { ...alive, temporarySince: new Date().toISOString(), temporaryReason: "selftest" });
  // Frage 1: a + b (+ tot) in web/
  await writes(t, "claude:a", [`${ROOT}/web/x.ts`]);
  await writes(t, "claude:b", [`${ROOT}/web/x.ts`]);
  await writes(t, "codex:tot", [`${ROOT}/web/x.ts`]);
  // Frage 2: a + c (+ abgestürzt) in server/
  await writes(t, "claude:a", [`${ROOT}/server/y.ts`]);
  await writes(t, "codex:c", [`${ROOT}/server/y.ts`]);
  await writes(t, "claude:crash", [`${ROOT}/server/y.ts`]);
  // Frage 3: b + c in shared/
  await writes(t, "claude:b", [`${ROOT}/shared/z.ts`]);
  await writes(t, "codex:c", [`${ROOT}/shared/z.ts`]);
  // Keine Frage: nur Tote, eine Lebende + eine Tote, Echte + Test-Session, zwei Test-Sessions.
  await writes(t, "codex:tot", [`${ROOT}/alt/q.ts`]);
  await writes(t, "claude:crash", [`${ROOT}/alt/q.ts`]);
  await writes(t, "claude:a", [`${ROOT}/mix/r.ts`]);
  await writes(t, "codex:tot", [`${ROOT}/mix/r.ts`]);
  await writes(t, "claude:a", [`${ROOT}/probe/s.ts`]);
  await writes(t, "claude:probe", [`${ROOT}/probe/s.ts`]);
  await writes(t, "claude:probe", [`${ROOT}/tests/u.ts`]);
  await writes(t, "claude:selbst", [`${ROOT}/tests/u.ts`]);

  // 1 offene Freigabe + 1 längst abgelaufene (noch „pending“ in der Zeile, bis jemand die Liste lädt).
  await t.db.insert(approvals).values({ rule: "git_push", reason: "Push ist Alex vorbehalten", tool: "Bash", command: "git push", commandHash: "h1", sessionKey: "claude:a" });
  await t.db.insert(approvals).values({
    rule: "deploy",
    reason: "Deploy ist Alex vorbehalten",
    tool: "Bash",
    command: "deploy.sh",
    commandHash: "h2",
    sessionKey: "claude:b",
    createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
  });
  // 2 offene Entscheidungs-Karten.
  await createInboxItem(t.db, { kind: "frage", title: "Darf T-01 umbenennen?", options: [{ id: "ja", label: "Ja" }], createdBy: "session", sessionKey: "claude:a" });
  await createInboxItem(t.db, { kind: "plan", title: "Heute Nacht A02", body: "startklar", options: [{ id: "freigeben", label: "Freigeben" }], createdBy: "haiku" });
}

type OQ = { approvals: number; inbox: number; conflicts: number; total: number };

describe("eine Zahl „offene Fragen“ mit gemischten Fällen", () => {
  it("Überblick-Kachel = Leisten-Zähler (/api/open-questions) = Entscheidungen-Listen + Konflikte-Kopf", async () => {
    const t = await setup();
    await seedMixed(t);

    // Reihenfolge wie im Alltag: erst Überblick und Leiste, DANACH erst die Entscheidungen-Seite
    // (die Freigabe-Liste räumt abgelaufene Anfragen weg — vorher dürfen sie auch nicht zählen).
    const o = await json<OverviewSnapshot>(t, "/api/overview");
    const oq = await json<OQ>(t, "/api/open-questions");
    const s = await json<ConflictsSummary>(t, "/api/conflicts/summary");
    const pending = (await json<{ approvals: unknown[] }>(t, "/api/approvals?status=pending")).approvals.length;
    const inbox = (await json<{ items: unknown[] }>(t, "/api/inbox?status=open")).items.length;

    expect(oq).toEqual({ approvals: 1, inbox: 2, conflicts: 3, sorting: 0, total: 6 });
    expect(o.openQuestions).toEqual(oq);
    expect(o.metrics.find((m) => m.key === "open_questions")?.value).toBe(6);
    expect(s.totals.openDecisions).toBe(3);
    expect(s.decisions.filter((d) => d.status === "open")).toHaveLength(3);
    // Entscheidungen-Kopf rechnet Freigaben + Karten + Konflikt-Fragen zusammen.
    expect(pending + inbox + s.totals.openDecisions).toBe(oq.total);
    // Nach dem Laden der Liste bleibt die Zahl gleich.
    expect(await json<OQ>(t, "/api/open-questions")).toEqual(oq);
  });

  it("Test-Sessions (Auto-Regel) schreiben nie einen Konflikt — weder mit echten noch untereinander", async () => {
    const t = await setup();
    await seedMixed(t);
    const s = await json<ConflictsSummary>(t, "/api/conflicts/summary");
    const involved = new Set(s.decisions.flatMap((d) => d.sessions.map((x) => x.sessionKey)));
    expect(involved.has("claude:probe")).toBe(false);
    expect(involved.has("claude:selbst")).toBe(false);
    expect(s.totals.conflicts).toBe(3);
  });

  it("bewusst temporär gestartete Sessions („manual“) zählen wie echte", async () => {
    const t = await setup();
    await makeSession(t, "claude:echt", alive);
    await makeSession(t, "claude:manuell", { ...alive, temporarySince: new Date().toISOString(), temporaryReason: "manual" });
    await writes(t, "claude:echt", [`${ROOT}/web/m.ts`]);
    await writes(t, "claude:manuell", [`${ROOT}/web/m.ts`]);
    const s = await json<ConflictsSummary>(t, "/api/conflicts/summary");
    expect(s.totals.openDecisions).toBe(1);
  });
});

describe("Zahlenprüfung hält das gemeinsame Token-Format aus", () => {
  it("„3,9 Mrd.“, „1 Mio.“ und „123.456“ aus formatTokensCompact werden erkannt, falsche Größenordnung nicht", async () => {
    const fact = (text: string) => [{ id: "f1", section: "Nutzung", text, sources: [] }];
    for (const n of [3_874_200_000, 1_000_000, 123_456, 999, 2_500_000_000_000]) {
      const amount = formatTokensCompact(n);
      const text = `Alle heute aktiven Sessions zusammen: ${amount} Tokens seit ihrem Start (nicht nur heute).`;
      // Haiku schreibt mit normalem Leerzeichen statt des geschützten aus Intl.
      expect(validateStatement(`Heute ${amount.replace(/\s/g, " ")} Tokens.`, ["f1"], fact(text)).ok, amount).toBe(true);
    }
    const mrd = `Alle zusammen: ${formatTokensCompact(3_874_200_000)} Tokens.`;
    expect(validateStatement("Heute 3,9 Mio. Tokens.", ["f1"], fact(mrd)).ok).toBe(false);
    expect(validateStatement("Heute 3,9 Tokens.", ["f1"], fact(mrd)).ok).toBe(false);
  });
});
