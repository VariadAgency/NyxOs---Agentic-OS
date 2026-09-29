// Demo mode: git state of the invented "Atlas" repos — repos, worktrees, branches, 60 days of
// commits (attributed to the demo sessions where one made them), open changes, probe merges.
import type { BuiltSession } from "./build-sessions.js";
import { REPOS, WORKTREES, worktreePath, type RepoKey } from "./sessions.js";
import type { Lang } from "@nyxos/shared";
import { hex, l, pick, rng } from "./text.js";

export const AUTHOR = "Alex Rivera";
const TEAMMATE = "Sam Okoro";

/** Git repo ids: the web app is the main repo ("app" — worktree cards hang off it). */
export const REPO_ID: Record<RepoKey, string> = { web: "app", api: REPOS.api.id, mobile: REPOS.mobile.id, infra: REPOS.infra.id };
export const worktreeRepoId = (slug: string) => `worktree:${slug}`;

export interface DemoGitRepo {
  id: string;
  label: string;
  kind: "app" | "worktree" | "other";
  root: string;
  currentBranch: string;
  parentId: string | null;
  mainBranch: string;
}

export interface DemoCommit {
  repoId: string;
  sha: string;
  at: string;
  subject: string;
  branch: string;
  author: string;
  parentCount: number;
  files: { path: string; add: number; del: number }[];
  sessionKey: string | null;
}

export interface DemoGit {
  repos: DemoGitRepo[];
  commits: DemoCommit[];
  branches: { repoId: string; name: string; ahead: number; behind: number; isCurrent: boolean; lastCommitAt: string | null; upstream: string | null; aheadShas: string[] }[];
  uncommitted: { repoId: string; path: string; statusCode: string; group: "code" | "doku" | "projekt" | "verschoben"; fromPath?: string }[];
  worktrees: { repoId: string; path: string; branch: string; headSha: string | null }[];
  probes: { repoId: string; branch: string; status: "clean" | "conflict"; conflictFiles: string[]; checkedAt: string }[];
  catchups: { repoId: string; worktreePath: string; branch: string; outcome: "merged" | "nachzieh-session" | "skipped-dirty"; before: string; after: string | null; detail: string; at: string }[];
  actions: { id: string; repoId: string; worktreePath: string; ref: string; at: string; action: string; subject: string; newSha: string | null }[];
}

const POOL: Record<RepoKey, { subject: string; files: string[] }[]> = {
  web: [
    { subject: "fix: cart badge shows stale count after removing items", files: ["src/components/CartBadge.tsx"] },
    { subject: "feat: sticky filter bar on category pages", files: ["src/app/c/[slug]/Filters.tsx", "src/styles/filters.css"] },
    { subject: "chore: bump next and eslint config", files: ["package.json", "pnpm-lock.yaml"] },
    { subject: "refactor: move price formatting into lib/format", files: ["src/lib/format.ts", "src/components/Price.tsx"] },
    { subject: "test: product page renders without reviews", files: ["src/app/products/[slug]/page.test.tsx"] },
    { subject: "fix: focus ring hidden on dark header", files: ["src/styles/tokens.css"] },
    { subject: "feat: empty state for wishlist", files: ["src/app/wishlist/Empty.tsx"] },
    { subject: "perf: prefetch category links on hover", files: ["src/components/Nav.tsx"] },
    { subject: "docs: explain image loader options", files: ["docs/images.md"] },
  ],
  api: [
    { subject: "fix: order totals ignore free shipping threshold", files: ["src/pricing/calculate.ts"] },
    { subject: "feat: pagination cursor for /orders", files: ["src/routes/orders.ts", "src/lib/cursor.ts"] },
    { subject: "chore: log request ids in error responses", files: ["src/middleware/errors.ts"] },
    { subject: "test: contract tests for /users", files: ["test/contract/users.test.ts"] },
    { subject: "refactor: split auth routes", files: ["src/auth/routes.ts", "src/auth/session.ts"] },
    { subject: "feat: merchant stats endpoint", files: ["src/routes/stats.ts"] },
    { subject: "fix: timezone of daily report", files: ["src/jobs/dailyReport.ts"] },
  ],
  mobile: [
    { subject: "fix: map pin tap area too small", files: ["app/(tabs)/map.tsx"] },
    { subject: "feat: pull to refresh on orders", files: ["app/(tabs)/orders.tsx"] },
    { subject: "chore: upgrade expo sdk", files: ["package.json", "app.json"] },
    { subject: "test: offline banner appears without network", files: ["src/sync/banner.test.tsx"] },
    { subject: "fix: android back button closes checkout", files: ["app/checkout/_layout.tsx"] },
  ],
  infra: [
    { subject: "chore: rotate staging certificates", files: ["staging/caddy/Caddyfile"] },
    { subject: "feat: nightly database backup to object storage", files: ["scripts/backup.sh"] },
    { subject: "fix: healthcheck interval for api container", files: ["prod/compose.yml"] },
  ],
};

const ART_PREFIX: Record<string, string> = { coding: "feat", audit: "docs", server: "chore", recherche: "docs", planung: "docs" };

function commitSubject(s: BuiltSession): string {
  const base = (s.spec.title?.en ?? s.spec.turns[0]?.user.en ?? "update").replace(/^[A-Za-z ]+:\s*/, "");
  const art = /audit|review/i.test(s.spec.title?.en ?? "") ? "audit" : /deploy|backup|server/i.test(s.spec.title?.en ?? s.spec.turns[0]?.user.en ?? "") ? "server" : "coding";
  return `${ART_PREFIX[art] ?? "feat"}: ${base.charAt(0).toLowerCase()}${base.slice(1)}`.slice(0, 72);
}

export function buildGit(now: number, sessions: BuiltSession[], lang: Lang): DemoGit {
  const rand = rng(20260926);
  const iso = (t: number) => new Date(t).toISOString();
  const sha = (seed: string) => hex(`git:${seed}`, 40);
  const repos: DemoGitRepo[] = [
    ...(Object.keys(REPOS) as RepoKey[]).map((k) => ({
      id: REPO_ID[k],
      label: REPOS[k].label,
      kind: (k === "web" ? "app" : "other") as DemoGitRepo["kind"],
      root: REPOS[k].root,
      currentBranch: "main",
      parentId: null,
      mainBranch: "main",
    })),
    ...WORKTREES.map((w) => ({ id: worktreeRepoId(w.slug), label: w.label, kind: "worktree" as const, root: worktreePath(w), currentBranch: w.branch, parentId: REPO_ID[w.repo], mainBranch: "main" })),
  ];

  const commits: DemoCommit[] = [];
  // 1) Commits made by the demo sessions (at their end, in their repo or worktree).
  for (const s of sessions) {
    if (s.summary.filesWritten.length === 0 || s.spec.state === "running" || s.spec.state === "crashed" || s.spec.state === "idle") continue;
    const repoId = s.spec.worktree ? worktreeRepoId(s.spec.worktree) : REPO_ID[s.spec.repo];
    const at = Date.parse(s.transcript.lastTs) - 60_000;
    commits.push({
      repoId,
      sha: sha(`session:${s.key}`),
      at: iso(at),
      subject: commitSubject(s),
      branch: s.branch,
      author: AUTHOR,
      parentCount: 1,
      files: s.summary.filesWritten.map((p, i) => ({ path: p.startsWith(`${s.cwd}/`) ? p.slice(s.cwd.length + 1) : p, add: 12 + ((i * 37) % 140), del: (i * 11) % 30 })),
      sessionKey: s.key,
    });
  }
  // 2) Everyday commits on main over the last 60 days (weekdays busier), plus merges of finished branches.
  for (let d = 60; d >= 0; d--) {
    const day = new Date(now - d * 86_400_000);
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    for (const k of Object.keys(REPOS) as RepoKey[]) {
      const weight = k === "web" ? 3.2 : k === "api" ? 2.4 : k === "mobile" ? 1.6 : 0.6;
      const n = Math.floor(rand() * (weekend ? weight * 0.3 : weight));
      for (let i = 0; i < n; i++) {
        const pool = POOL[k];
        const pickC = pool[Math.floor(rand() * pool.length)] ?? pool[0];
        if (!pickC) continue;
        const hour = 8 + Math.floor(rand() * 10);
        const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour - 2, Math.floor(rand() * 60));
        if (at > now - 20 * 60_000) continue;
        commits.push({
          repoId: REPO_ID[k],
          sha: sha(`${k}:${d}:${i}`),
          at: iso(at),
          subject: pickC.subject,
          branch: "main",
          author: rand() < 0.7 ? AUTHOR : TEAMMATE,
          parentCount: 1,
          files: pickC.files.map((p) => ({ path: p, add: 3 + Math.floor(rand() * 90), del: Math.floor(rand() * 40) })),
          sessionKey: null,
        });
      }
    }
  }
  const merges: [RepoKey, string, number][] = [
    ["web", "feat/search-rework-v1", 12],
    ["web", "feat/dark-mode", 10],
    ["api", "feat/idempotency-keys", 2],
    ["web", "feat/onboarding-3-steps", 21],
    ["mobile", "feat/push-notifications", 24],
    ["api", "feat/webhook-retries", 0.3],
  ];
  for (const [k, branch, days] of merges) {
    commits.push({ repoId: REPO_ID[k], sha: sha(`merge:${branch}`), at: iso(now - days * 86_400_000 - 3_600_000), subject: `Merge branch '${branch}'`, branch: "main", author: AUTHOR, parentCount: 2, files: [], sessionKey: null });
  }
  // 3) Recent commits on the feature branches of the worktrees (ahead of main).
  const featureCommits: Record<string, string[]> = {
    "checkout-v2": ["feat: coupon field in cart", "test: coupon validation edge cases", "feat: checkout step bar", "fix: address form validates on blur"],
    "search-rework": ["feat: typo tolerant index", "feat: synonyms for product names", "fix: ranking of exact matches"],
    passkeys: ["feat: passkey registration endpoints", "feat: migration 0043 passkeys table"],
    "offline-sync": ["feat: last-write-wins merge for wishlists", "feat: persistent order queue", "feat: exponential backoff"],
  };
  const aheadShas = new Map<string, string[]>();
  for (const w of WORKTREES) {
    const list = featureCommits[w.slug] ?? [];
    const shas: string[] = [];
    list.forEach((subject, i) => {
      const at = now - (list.length - i) * (w.slug === "search-rework" ? 2 * 86_400_000 : 7 * 3_600_000) - 50 * 60_000;
      const c: DemoCommit = { repoId: worktreeRepoId(w.slug), sha: sha(`${w.slug}:${i}`), at: iso(at), subject, branch: w.branch, author: AUTHOR, parentCount: 1, files: [{ path: `src/${w.slug}.ts`, add: 20 + i * 13, del: i * 4 }], sessionKey: null };
      commits.push(c);
      shas.push(c.sha);
    });
    aheadShas.set(w.slug, shas);
  }
  commits.sort((a, b) => (a.at < b.at ? -1 : 1));

  const headOf = (repoId: string, branch: string) => [...commits].reverse().find((c) => c.repoId === repoId && c.branch === branch)?.sha ?? null;
  const lastAt = (repoId: string, branch: string) => [...commits].reverse().find((c) => c.repoId === repoId && c.branch === branch)?.at ?? null;

  const branches: DemoGit["branches"] = [];
  for (const k of Object.keys(REPOS) as RepoKey[]) {
    const id = REPO_ID[k];
    branches.push({ repoId: id, name: "main", ahead: 0, behind: 0, isCurrent: true, lastCommitAt: lastAt(id, "main"), upstream: "origin/main", aheadShas: [] });
  }
  const behind: Record<string, number> = { "checkout-v2": 3, "search-rework": 11, passkeys: 1, "offline-sync": 4 };
  for (const w of WORKTREES) {
    const shas = aheadShas.get(w.slug) ?? [];
    const row = { name: w.branch, ahead: shas.length, behind: behind[w.slug] ?? 0, lastCommitAt: lastAt(worktreeRepoId(w.slug), w.branch), upstream: `origin/${w.branch}`, aheadShas: shas };
    branches.push({ repoId: worktreeRepoId(w.slug), ...row, isCurrent: true });
    branches.push({ repoId: REPO_ID[w.repo], ...row, isCurrent: false });
  }
  branches.push({ repoId: REPO_ID.web, name: "fix/footer-contrast", ahead: 1, behind: 6, isCurrent: false, lastCommitAt: new Date(now - 2 * 86_400_000).toISOString(), upstream: null, aheadShas: [] });

  const web = REPOS.web.root;
  const uncommitted: DemoGit["uncommitted"] = [
    { repoId: REPO_ID.web, path: "src/lib/images.ts", statusCode: ".M", group: "code" },
    { repoId: REPO_ID.web, path: "src/app/products/[slug]/page.tsx", statusCode: ".M", group: "code" },
    { repoId: REPO_ID.web, path: "src/components/ProductImage.tsx", statusCode: "??", group: "code" },
    { repoId: REPO_ID.web, path: "src/app/page.tsx", statusCode: ".M", group: "code" },
    { repoId: REPO_ID.web, path: "next.config.mjs", statusCode: ".M", group: "projekt" },
    { repoId: worktreeRepoId("checkout-v2"), path: "src/app/checkout/StepBar.tsx", statusCode: "A.", group: "code" },
    { repoId: worktreeRepoId("checkout-v2"), path: "src/app/checkout/AddressForm.test.tsx", statusCode: ".M", group: "code" },
    { repoId: worktreeRepoId("offline-sync"), path: "src/api/client.ts", statusCode: ".M", group: "code" },
    { repoId: worktreeRepoId("passkeys"), path: "src/auth/passkeys.ts", statusCode: ".M", group: "code" },
    { repoId: REPO_ID.api, path: "docs/audits/2026-api-rate-limits.md", statusCode: "??", group: "doku" },
    { repoId: REPO_ID.mobile, path: "app/(tabs)/map.tsx", statusCode: ".M", group: "code" },
    { repoId: REPO_ID.infra, path: "docs/runbook.md", statusCode: "R.", group: "verschoben", fromPath: "RUNBOOK.md" },
  ];

  const worktrees: DemoGit["worktrees"] = [
    ...(Object.keys(REPOS) as RepoKey[]).map((k) => ({ repoId: REPO_ID[k], path: REPOS[k].root, branch: "main", headSha: headOf(REPO_ID[k], "main") })),
    ...WORKTREES.map((w) => ({ repoId: REPO_ID[w.repo], path: worktreePath(w), branch: w.branch, headSha: headOf(worktreeRepoId(w.slug), w.branch) })),
  ];

  const probes: DemoGit["probes"] = [
    { repoId: REPO_ID.web, branch: "feat/checkout-v2", status: "clean", conflictFiles: [], checkedAt: new Date(now - 4 * 60_000).toISOString() },
    { repoId: REPO_ID.web, branch: "feat/search-rework", status: "conflict", conflictFiles: ["src/lib/api.ts", "src/search/index.ts"], checkedAt: new Date(now - 4 * 60_000).toISOString() },
    { repoId: REPO_ID.api, branch: "feat/passkey-login", status: "clean", conflictFiles: [], checkedAt: new Date(now - 6 * 60_000).toISOString() },
    { repoId: REPO_ID.mobile, branch: "feat/offline-sync", status: "clean", conflictFiles: [], checkedAt: new Date(now - 6 * 60_000).toISOString() },
  ];

  const wtPath = (slug: string) => {
    const w = WORKTREES.find((x) => x.slug === slug);
    return w ? worktreePath(w) : web;
  };
  const catchups: DemoGit["catchups"] = [
    { repoId: REPO_ID.web, worktreePath: wtPath("checkout-v2"), branch: "feat/checkout-v2", outcome: "merged", before: sha("c-before-1"), after: sha("c-after-1"), detail: pick(l("main nachgezogen (3 Commits, ohne Konflikt)", "caught up with main (3 commits, no conflict)"), lang), at: new Date(now - 26 * 3_600_000).toISOString() },
    { repoId: REPO_ID.web, worktreePath: wtPath("search-rework"), branch: "feat/search-rework", outcome: "nachzieh-session", before: sha("c-before-2"), after: null, detail: pick(l("Konflikt in src/lib/api.ts – Nachzieh-Session vorgeschlagen", "Conflict in src/lib/api.ts – catch-up session suggested"), lang), at: new Date(now - 5 * 3_600_000).toISOString() },
    { repoId: REPO_ID.mobile, worktreePath: wtPath("offline-sync"), branch: "feat/offline-sync", outcome: "skipped-dirty", before: sha("c-before-3"), after: null, detail: pick(l("Ungesicherte Änderungen – nicht nachgezogen", "Uncommitted changes – not caught up"), lang), at: new Date(now - 3 * 3_600_000).toISOString() },
  ];

  const actions: DemoGit["actions"] = [];
  const act = (repoId: string, where: string, min: number, action: string, subject: string, newSha: string | null) =>
    actions.push({ id: `demo-action-${actions.length}`, repoId, worktreePath: where, ref: action === "push" ? "refs/remotes/origin/main" : "HEAD", at: new Date(now - min * 60_000).toISOString(), action, subject, newSha });
  act(REPO_ID.api, REPOS.api.root, 7 * 60, "push", "update by push", headOf(REPO_ID.api, "main"));
  act(REPO_ID.api, REPOS.api.root, 7 * 60 + 20, "merge", "merge feat/webhook-retries: Fast-forward", sha("merge:feat/webhook-retries"));
  act(REPO_ID.web, web, 3 * 60, "pull", "pull: Fast-forward", headOf(REPO_ID.web, "main"));
  act(worktreeRepoId("checkout-v2"), wtPath("checkout-v2"), 95, "checkout", "checkout: moving from main to feat/checkout-v2", null);
  act(worktreeRepoId("passkeys"), wtPath("passkeys"), 3 * 60, "worktree", "worktree add .worktrees/passkeys", null);
  act(REPO_ID.web, web, 26 * 60, "merge", "merge main into feat/checkout-v2", sha("c-after-1"));
  act(REPO_ID.mobile, REPOS.mobile.root, 30 * 60, "push", "update by push", headOf(REPO_ID.mobile, "main"));
  act(REPO_ID.web, web, 2 * 24 * 60, "reset", "reset: moving to HEAD~1", null);
  act(REPO_ID.infra, REPOS.infra.root, 6 * 60, "commit", "commit: deploy staging v2.3.0-rc2", headOf(REPO_ID.infra, "main"));

  return { repos, commits, branches, uncommitted, worktrees, probes, catchups, actions };
}
