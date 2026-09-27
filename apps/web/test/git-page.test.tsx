// Git-Seite — leere Zustände (nie „Noch kein Git-Stand“, nie Technik-Text), getrennte
// Abschnitte (App-Repo, Worktrees, NyxOS sehen unterschiedlich aus), Klick → Großansicht.
import type { GitCommitDetail, GitCommitRow, GitDashboard, GitWorktreeCard } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCountUpMemory } from "../src/components/charts/StatCard";
import { Git } from "../src/features/git/Git";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  resetCountUpMemory();
});

const NOW = new Date().toISOString();

function commit(over: Partial<GitCommitRow> & Pick<GitCommitRow, "sha" | "subject">): GitCommitRow {
  return {
    repoId: "app",
    repoLabel: "App-Repo",
    kind: "app",
    branch: "main",
    authorName: "Alex",
    committedAt: NOW,
    parents: 1,
    filesChanged: 1,
    insertions: 3,
    deletions: 1,
    attribution: { confidence: "keine", session: null, reason: "Keine Session hat zu dieser Zeit in diesem Ordner gearbeitet — vermutlich von Hand gemacht." },
    ...over,
  };
}

const SESSION = { key: "claude:s1", title: "Push-Dienst bauen", tool: "claude", state: "running", lastActivityAt: NOW, cwd: "/home/dev/project/.worktrees/notifications" };

function card(over: Partial<GitWorktreeCard> = {}): GitWorktreeCard {
  return {
    repoId: "worktree:notifications",
    label: "notifications",
    path: "/home/dev/project/.worktrees/notifications",
    parentRepoId: "app",
    branch: "feat/notification-service",
    headSha: "wt2",
    ahead: 16,
    behind: 2,
    mainBranch: "main",
    uncommitted: { total: 5, groups: { code: 4, doku: 1, projekt: 0, verschoben: 0 }, files: [] },
    lastActivityAt: NOW,
    sessions: { open: [SESSION], recent: [], total: 1 },
    probe: { status: "clean", conflictFiles: [] },
    lastCommit: commit({ sha: "wt2", subject: "feat: push-test", branch: "feat/notification-service" }),
    catchup: null,
    ...over,
  };
}

const EMPTY: GitDashboard = {
  scan: { state: "never", progress: null, lastScanAt: null, bridge: { state: "online", reason: null } },
  kpis: { commitsToday: 0, commits7d: 0, commitsPrev7d: 0, commits30d: 0, openBranches: 0, worktrees: 0, uncommittedFiles: 0, uncommittedPlaces: 0, uncommitted: { files: 0, places: 0, repoFiles: 0, repoPlaces: 0, worktreeFiles: 0, worktreePlaces: 0 } },
  heatmap: [],
  merges: [],
  actions: [],
  app: null,
  appWorktrees: [],
  nyxos: null,
  nyxosWorktrees: [],
  others: [],
};

function section(kind: "app" | "nyxos", label: string, root: string) {
  return {
    repoId: kind,
    label,
    kind,
    root,
    currentBranch: "main",
    headSha: "h",
    mainBranch: "main",
    scannedAt: NOW,
    lastActivityAt: NOW,
    uncommitted: { total: 2, groups: { code: 1, doku: 1, projekt: 0, verschoben: 0 }, files: [{ path: "a.swift", statusCode: ".M", group: "code" as const }] },
    branches: [{ name: "feat/notification-service", ahead: 16, behind: 2, isCurrent: false, lastCommitAt: NOW, upstream: null, probe: { status: "conflict" as const, conflictFiles: ["backend/push.go"], checkedAt: NOW }, checkedOutAt: "/x" }],
    commits30d: 12,
    commitsPerDay: Array.from({ length: 30 }, (_, i) => i % 3),
    recentCommits: [commit({ sha: `${kind}-c1`, subject: kind === "app" ? "fix: Abstand" : "feat: Git-Seite neu", repoId: kind, kind })],
    tags: [],
  };
}

const FULL: GitDashboard = {
  scan: { state: "idle", progress: null, lastScanAt: NOW, bridge: { state: "online", reason: null } },
  kpis: { commitsToday: 5, commits7d: 21, commitsPrev7d: 14, commits30d: 88, openBranches: 3, worktrees: 2, uncommittedFiles: 631, uncommittedPlaces: 3, uncommitted: { files: 631, places: 3, repoFiles: 600, repoPlaces: 1, worktreeFiles: 31, worktreePlaces: 2 } },
  heatmap: Array.from({ length: 84 }, (_, i) => ({ day: new Date(Date.now() - (83 - i) * 86_400_000).toISOString().slice(0, 10), app: i % 4, nyxos: i % 2, other: 0 })),
  merges: [commit({ sha: "merge1", subject: "Merge feat/x in main", parents: 2, attribution: { confidence: "sicher", session: SESSION, reason: "Diese Session hat um 12:00 „git merge“ ausgeführt." } })],
  actions: [
    { id: "a1", at: NOW, kind: "push", label: "Push", detail: "update by push", repoId: "app", repoLabel: "App-Repo", repoKind: "app", where: "/home/dev/project", sha: "merge1", who: { type: "session", session: SESSION, confidence: "sicher" } },
    { id: "a2", at: NOW, kind: "probe-merge", label: "Probe-Merge von NyxOS", detail: "1 von 3 Zweigen hätten Konflikte", repoId: "app", repoLabel: "App-Repo", repoKind: "app", where: "/home/dev/project", sha: null, who: { type: "nyxos", session: null, confidence: null } },
  ],
  app: section("app", "App-Repo", "/home/dev/project"),
  appWorktrees: [card()],
  nyxos: section("nyxos", "NyxOS", "/home/dev/NyxOS"),
  nyxosWorktrees: [card({ repoId: "worktree:nyxos:agent-x", label: "agent-x", path: "/z/.claude/worktrees/agent-x", parentRepoId: "nyxos", branch: "worktree-agent-x", ahead: 1, behind: 0, sessions: { open: [], recent: [], total: 0 } })],
  others: [],
};

const DETAIL: GitCommitDetail = {
  ...commit({ sha: "merge1", subject: "Merge feat/x in main", parents: 2, attribution: { confidence: "sicher", session: SESSION, reason: "Diese Session hat um 12:00 „git merge“ in diesem Ordner ausgeführt." } }),
  files: [
    { path: "backend/push.go", add: 120, del: 4 },
    { path: "ios/Icon.png", add: null, del: null },
  ],
  filesTruncated: false,
  worktreePath: "/home/dev/project",
};

function stub(dashboard: GitDashboard | "pending") {
  const impl = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/git/dashboard")) return dashboard === "pending" ? new Promise<Response>(() => {}) : jsonResponse(dashboard);
    if (url.startsWith("/api/git/commit/")) return jsonResponse(DETAIL);
    return Promise.reject(new Error(`kein Stub für ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function renderGit(path = "/git") {
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <Git />
    </MemoryRouter>,
  );
}

const TECH = /pnpm|tmux|ENOENT|CSRF|Noch kein Git-Stand|misst sofort/i;

describe("Git-Seite — leere Zustände", () => {
  it("lädt: Skelette mit fester Höhe, kein Text-Platzhalter", () => {
    stub("pending");
    renderGit();
    const skeletons = screen.getAllByTestId("git-skeleton");
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
    for (const s of skeletons) expect(s.className).toMatch(/h-\[/);
    expect(document.body.textContent ?? "").not.toMatch(TECH);
  });

  it("Brücke online, noch nie gescannt: „Brücke scannt gerade …“ mit Fortschritt", async () => {
    stub({ ...EMPTY, scan: { ...EMPTY.scan, state: "scanning", progress: { phase: "scanning", done: 3, total: 12, current: "App-Repo", startedAt: NOW, finishedAt: null } } });
    renderGit();
    expect(await screen.findByText(/Brücke scannt gerade/)).toBeTruthy();
    expect(screen.getByText(/3 von 12/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    expect(document.body.textContent ?? "").not.toMatch(TECH);
  });

  it("Brücke offline: ein erklärender Satz mit Knopf, kein Technik-Text", async () => {
    stub({ ...EMPTY, scan: { ...EMPTY.scan, bridge: { state: "offline", reason: "Rechner schläft oder ist offline" } } });
    renderGit();
    expect(await screen.findByText(/Brücke ist gerade nicht verbunden/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Verbindungen prüfen/ }).getAttribute("href")).toBe("/settings#verbindungen");
    expect(document.body.textContent ?? "").not.toMatch(TECH);
  });
});

describe("Git-Seite mit Daten", () => {
  it("Kennzahlen, Heatmap, Merges, Aktions-Log und drei sichtbar verschiedene Abschnitte", async () => {
    stub(FULL);
    renderGit();
    await screen.findByText("Merge feat/x in main");
    // Kennzahlen
    const kpis = screen.getByTestId("git-kpis");
    for (const label of ["Commits heute", "7 Tage", "Commits 30 Tage", "Offene Zweige", "Worktrees", "Ungesichert"]) expect(within(kpis).getByText(label)).toBeTruthy();
    // „Ungesichert“ mit derselben Kontextzeile wie der Überblick (Repos · Worktrees).
    expect(within(kpis).getByText("600 in Repos · 31 in Worktrees")).toBeTruthy();
    // Heatmap 12 Wochen
    expect(screen.getAllByTestId("heat-cell")).toHaveLength(84);
    // Aktions-Log mit wer/was
    const log = screen.getByTestId("git-actions");
    expect(within(log).getAllByText("Push")).toHaveLength(2); // Filter-Knopf + Eintrag
    expect(within(log).getByText("update by push")).toBeTruthy();
    expect(within(log).getByText("Push-Dienst bauen")).toBeTruthy();
    expect(within(log).getByText("Probe-Merge von NyxOS")).toBeTruthy();
    // Abschnitte: eigene Kennzeichnung + eigene Farbe
    const app = screen.getByTestId("section-app");
    const wts = screen.getByTestId("section-worktrees");
    const zen = screen.getByTestId("section-nyxos");
    const colors = [app, wts, zen].map((s) => s.getAttribute("data-color"));
    expect(new Set(colors).size).toBe(3);
    expect(within(app).getByText("feat/notification-service")).toBeTruthy();
    expect(within(wts).getByText("notifications")).toBeTruthy();
    expect(within(wts).getByText("+16")).toBeTruthy();
    expect(within(wts).getByText("−2")).toBeTruthy();
    expect(within(wts).getByText("Push-Dienst bauen")).toBeTruthy();
    expect(within(zen).getByText("agent-x")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(TECH);
  });

  it("Klick auf einen Commit öffnet die Großansicht mit Dateien (+/−) und der Session samt Sicherheit", async () => {
    stub(FULL);
    renderGit();
    await userEvent.click(await screen.findByText("Merge feat/x in main"));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("backend/push.go")).toBeTruthy());
    expect(within(dialog).getByText("+120")).toBeTruthy();
    expect(within(dialog).getByText(/Binärdatei/)).toBeTruthy();
    expect(within(dialog).getByText("sicher")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /Push-Dienst bauen/ }).getAttribute("href")).toBe("/sessions/_/_/claude%3As1");
  });
});

describe("„Ungesichert“ auf der Git-Seite", () => {
  it("älterer Server ohne `kpis.uncommitted`: Seite steht, Zahl und Ordner-Zeile aus den alten Feldern", async () => {
    const oldKpis: GitDashboard["kpis"] = { ...FULL.kpis };
    delete oldKpis.uncommitted;
    stub({ ...FULL, kpis: oldKpis });
    renderGit();
    await screen.findByText("Merge feat/x in main");
    const tile = screen.getByTestId("git-kpis").querySelector('[data-metric="git-uncommitted"]') as HTMLElement;
    expect(tile).toBeTruthy();
    expect(within(tile).getByText("Dateien in 3 Ordnern")).toBeTruthy();
  });

  it("Farbe rot wie im Überblick; lange Kontextzeile bricht um statt abgeschnitten zu werden", async () => {
    stub(FULL);
    renderGit();
    await screen.findByText("Merge feat/x in main");
    const tile = screen.getByTestId("git-kpis").querySelector('[data-metric="git-uncommitted"]') as HTMLElement;
    expect(tile.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("bad");
    const caption = within(tile).getByText("600 in Repos · 31 in Worktrees").parentElement as HTMLElement;
    expect(caption.className).not.toMatch(/\btruncate\b/);
  });
});
