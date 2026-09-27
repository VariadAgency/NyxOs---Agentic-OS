# Contributing to NyxOS

Thanks for helping! This guide gets you from a fresh clone to a pull request.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through
[SECURITY.md](SECURITY.md), not public issues.

## What you need

- **Node.js 24** or newer
- **pnpm** — the version is pinned in `package.json`; `corepack enable` installs it for you
- **git**, and **tmux** if you work on terminals
- macOS or Linux (Windows only through WSL)

## Setup

```bash
git clone https://github.com/OWNER/nyxos.git
cd nyxos
corepack enable
pnpm install
```

## Everyday commands

All run from the repository root:

| Command | What it does |
|---|---|
| `pnpm typecheck` | TypeScript in every package (strict mode) |
| `pnpm lint` | ESLint over the whole repository |
| `pnpm test` | All Vitest projects (shared, server, bridge, web, cli, scripts) |
| `pnpm test apps/server/test/categorize.test.ts` | Only matching test files |
| `pnpm build` | Build every package |
| `pnpm package` | Build and pack the release file into `dist/` |
| `pnpm --filter @nyxos/web e2e` | Playwright end-to-end tests of the web app |
| `bash scripts/check-clean.sh` | Make sure no secrets are in the repository; add your own words (name, server) to the git-ignored `.check-clean.local`, one regex per line |

CI runs `typecheck`, `lint`, `test`, `package` and `check-clean.sh` on macOS and Ubuntu for every pull request.

## Running NyxOS from source

The server runs in local mode with its embedded Postgres (PGlite). Use a throw-away data folder so you never
touch a real installation.

**1. Server** (terminal 1):

```bash
NYXOS_HOME=/tmp/nyxos-dev PORT=47890 pnpm exec tsx apps/server/src/local.ts
```

It creates `/tmp/nyxos-dev/data` (database, keys, archive), applies all migrations and listens on
`127.0.0.1:47890`.

**2. Web app with hot reload** (terminal 2):

```bash
pnpm --filter @nyxos/web dev --host 127.0.0.1
```

Vite proxies `/api`, `/health` and `/live` to `http://127.0.0.1:47890` (set `NYXOS_API` to use another
address).

**3. Sign in** (terminal 3):

```bash
NYXOS_HOME=/tmp/nyxos-dev NYXOS_PORT=47890 node apps/cli/nyxos.mjs open
```

This opens a one-time sign-in link on port 47890. Then open the Vite address, `http://127.0.0.1:5173` — the
sign-in cookie belongs to the host `127.0.0.1`, so it works on both ports.

**Serving the built web app instead:** `pnpm --filter @nyxos/web build`, then start the server with
`WEB_DIR=$PWD/apps/web/dist` and use `http://127.0.0.1:47890` directly.

**With live sessions:** `pnpm dev` starts a development server together with a *separate* bridge instance
that reads your real Claude Code / Codex transcripts. It uses its own data folder (`.probe/`, ignored by git)
and its own tmux socket, and never changes an installed NyxOS or your hooks.

Start over at any time with `rm -rf /tmp/nyxos-dev`.

## Project structure

See [docs/architecture.md](docs/architecture.md). In short:

```
apps/server     API, Nyx, database (Hono, Drizzle, PGlite/Postgres)
apps/web        interface (React, Vite, Tailwind, TanStack Query)
apps/bridge     background service on the user's computer (hooks, file watcher, tmux)
apps/cli        the nyxos command (plain Node, no dependencies)
packages/shared types, zod schemas, parsers, i18n — shared by all apps
infra/          Docker Compose for server mode, voice container
```

## Conventions

**Code**

- TypeScript `strict`. No `any` without a reason, no non-null assertions (`!`) — the linter enforces it.
- Contracts between server, web and bridge live in `packages/shared` as zod schemas plus types. Change the
  schema there, not a copy.
- Code, identifiers and comments in English.
- Database changes: edit `apps/server/src/db/schema.ts`, then `pnpm --filter @nyxos/server db:generate`.
  Migrations are **additive only** (new tables/columns; no drops or renames), so a rollback keeps working.
- Hooks must never slow down or block Claude Code / Codex: finish fast, swallow errors, buffer instead of
  failing.
- `apps/cli/nyxos.mjs` uses Node built-ins only — it runs straight from the release without `node_modules`.

**User interface**

- Every user-facing text is written in **German and wrapped in `t()`**, with the English translation added
  to `packages/shared/src/i18n/en/<area>.ts` in the same pull request. See
  [docs/translations.md](docs/translations.md).
- Font sizes come from the type scale in `apps/web/src/app.css` (`text-title` … `text-label`); fixed sizes like
  `text-[12px]` fail the lint. `node scripts/lint/typography.mjs --apply` fixes most of them.
- Pages read from top to bottom and scroll; cards open into a large view; related items link to each other.
- Risky actions (delete, merge, push, deploy, migration) always need an explicit confirmation by the user.

**Tests**

- **Fixes start with a failing test.** Write a test that shows the bug, see it fail, then fix it.
- New features come with tests for their logic; UI behaviour that matters gets a component or e2e test.
- Tests work in temporary folders — never with the real `~/.claude`, `~/.codex`, shell files or `~/.nyxos`.

**No personal data**

- Never commit real names, e-mail addresses, home paths, host names, IPs, tokens or real transcripts — not in
  code, tests, fixtures or screenshots.
- Need a transcript as test data? Shrink and scrub it with `node scripts/make-fixture.mjs <source.jsonl> <target.jsonl>`
  and read the result before committing.
- Screenshots come from `nyxos demo` only.
- `bash scripts/check-clean.sh` must pass.

**Third-party code**

- Only code under permissive licenses (MIT, BSD, ISC, Apache-2.0). No code from AGPL or GPL projects.
- If you adopt code or a notable pattern, name the project, URL, copyright, license and the files in
  [NOTICE](NOTICE), and add a short source comment at the top of the file.

## Pull requests

1. Open an issue first for larger changes, so we can agree on the approach.
2. Create a branch, keep the change focused, and write clear commit messages (imperative, e.g. "Add usage
   goals to briefing").
3. Run `pnpm typecheck && pnpm lint && pnpm test && bash scripts/check-clean.sh`.
4. Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) if users will notice the change.
5. Fill in the pull request template. Screenshots (from `nyxos demo`) help for UI changes.

A maintainer reviews every pull request. Merging, releasing and deploying are done by maintainers.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
