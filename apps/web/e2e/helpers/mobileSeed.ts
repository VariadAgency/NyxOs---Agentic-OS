// Sample sessions for the phone checks on an empty server (PGlite). Goes through the bridge route of the server
// (`/ingest/events` with the machine token, see helpers/localStack.ts) – the same ids on every run, so idempotent.
import type { APIRequestContext } from "@playwright/test";
import { bridgeToken } from "./localStack";

/** A made-up project folder (nothing is read from it). */
export const MOBILE_CWD = "/home/demo/projects/handy-test";

/** Die Session, die „in NyxOS läuft“ (tmux-Name gesetzt) – an ihr hängt die Terminal-Prüfung. */
export const MOBILE_LIVE = { sessionId: "5e5a0000-0000-4000-8000-00000000a001", tmux: "zc-claude-m5live01", title: "Handy-Ansicht bauen" };

const SESSIONS = [
  MOBILE_LIVE,
  { sessionId: "5e5a0000-0000-4000-8000-00000000a002", tmux: null, title: "Mitteilungen aufräumen" },
  { sessionId: "5e5a0000-0000-4000-8000-00000000a003", tmux: null, title: "Einstellungen als Liste mit Unterseiten und einer sehr langen Überschrift, die umbrechen muss" },
];

const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 };

export async function seedMobileSessions(request: APIRequestContext, api: string): Promise<void> {
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const items: unknown[] = [];
  SESSIONS.forEach((s, i) => {
    items.push({
      type: "summary",
      summary: {
        tool: "claude", sessionId: s.sessionId, parentSessionId: null, cwd: MOBILE_CWD, title: s.title, titleSource: "custom",
        startedAt: iso(3_600_000 + i * 60_000), lastActivityAt: iso(i * 120_000), models: ["claude-opus-5-5"], tokens: zero, toolCalls: {},
        // A very long path (> 140 characters) – so `layout-regression.spec.ts` also has something to measure here.
        filesWritten: [`${MOBILE_CWD}/apps/web/src/components/MobileTabBar.tsx`, `/tmp/handy-test/5e5a0000-0000-4000-8000-000000000000/ein-sehr-tief-verschachtelter-ordner/noch-ein-ordner/und-noch-tiefer/sehr-langer-dateiname-${i}.json`], filesRead: [], subagents: [], gitBranch: "handy-test", cliVersion: null,
        eventCount: 2, parseErrors: 0, limits: null,
      },
    });
    items.push({ type: "event", event: { id: `${s.sessionId}:p`, tool: "claude", sessionId: s.sessionId, ts: iso(3_000_000), kind: "prompt", source: "file", data: { text: `Bitte ${s.title.toLowerCase()} – so, dass es auf dem Handy gut aussieht.` } } });
    items.push({ type: "event", event: { id: `${s.sessionId}:a`, tool: "claude", sessionId: s.sessionId, ts: iso(2_900_000), kind: "assistant", source: "file", data: { text: "Ich schaue mir zuerst die Seitenleiste und die Kopfzeile an und baue dann eine untere Leiste mit fünf Einträgen." } } });
    items.push({ type: "state", state: { tool: "claude", sessionId: s.sessionId, running: i === 0, observedAt: iso(0) } });
    if (s.tmux) items.push({ type: "terminal", terminal: { tool: "claude", sessionId: s.sessionId, tmuxName: s.tmux, attachable: true, screenWaiting: null, observedAt: iso(0) } });
  });
  const res = await request.post(`${api}/ingest/events`, { headers: { authorization: `Bearer ${bridgeToken()}`, "content-type": "application/json" }, data: { items } });
  if (!res.ok()) throw new Error(`Seed fehlgeschlagen: ${res.status()} ${await res.text()}`);
}
