# AGENTS.md — guidance for AI coding agents

NyxOS is an open-source TypeScript monorepo (pnpm workspaces): a local "operating system" for Claude Code and
Codex sessions with the assistant Nyx. Read `docs/architecture.md` before larger changes. Human contributor
rules are in `CONTRIBUTING.md`; this file is the short version for agents. (`CLAUDE.md` has the same content.)

## Structure

| Path | What |
|---|---|
| `apps/server` | API + Nyx. `src/local.ts` (local mode, PGlite), `src/main.ts` (server mode, Postgres), `src/app.ts` (all routes), `src/db/schema.ts`, `drizzle/` (SQL migrations), `test/` |
| `apps/web` | React + Vite + Tailwind interface. `src/nav.ts` (sidebar), `src/features/<area>/`, `test/`, `e2e/` (Playwright) |
| `apps/bridge` | Background service: hooks, file watcher, tmux terminals, git, Obsidian vault. `src/main.ts` |
| `apps/cli` | The `nyxos` command, `nyxos.mjs` — Node built-ins only, no dependencies |
| `packages/shared` | zod schemas + types shared by all apps, transcript parsers, i18n (`src/i18n/`) |
| `infra/` | Docker Compose for server mode, `nyx-voice` container (Python) |
| `scripts/` | `package.mjs`, `check-clean.sh`, `set-repo.sh`, `dev.mjs`, lint rules |
| `install.sh` | The one-line installer |

## Commands

```bash
pnpm install
pnpm typecheck                     # strict TypeScript, all packages
pnpm lint                          # ESLint (includes the font-size rule for apps/web)
pnpm test                          # all Vitest projects
pnpm test <path-or-pattern>        # a subset
pnpm package                       # release file in dist/
bash scripts/check-clean.sh        # no personal data / secrets
pnpm --filter @nyxos/server db:generate   # new migration after editing schema.ts
```

Run from source: `NYXOS_HOME=/tmp/nyxos-dev PORT=47890 pnpm exec tsx apps/server/src/local.ts`, then
`pnpm --filter @nyxos/web dev --host 127.0.0.1`, then sign in with
`NYXOS_HOME=/tmp/nyxos-dev NYXOS_PORT=47890 node apps/cli/nyxos.mjs open`.

## Rules

1. **Tests first for fixes.** Write a failing test, then fix. Run `pnpm typecheck && pnpm lint && pnpm test`
   before you say you are done. A green build does not prove a feature is wired up — check the real path.
2. **Never touch the user's real environment in tests or scripts:** no writes to `~/.claude`, `~/.codex`,
   shell start files, `~/.nyxos`, launchd or systemd. Use temporary folders and `NYXOS_HOME`.
3. **No personal data.** No real names, e-mail addresses, home paths, hosts, IPs, tokens or real transcripts in
   code, tests, fixtures, docs or screenshots. `scripts/check-clean.sh` must pass.
4. **UI text is German source text in `t()`** from `@nyxos/shared`, with the English entry added to
   `packages/shared/src/i18n/en/<area>.ts`. Code, identifiers and comments are English.
5. **TypeScript strict**, no non-null assertions, contracts as zod schemas in `packages/shared`.
6. **Migrations are additive** (new tables/columns only). Never edit a migration that was already released.
7. **Hooks must never block** Claude Code or Codex: fast, errors swallowed, buffer instead of fail.
8. **Security stays on:** loopback binding, host allow-list, sign-in + CSRF, machine token, encrypted secrets.
   Nyx never gets tools that reach sign-in, passkeys or keys; risky actions need a user confirmation.
9. **Approvals stay with the user:** do not push, merge into main, tag, release, deploy or delete on your own.
10. **Third-party code:** permissive licenses only (MIT, BSD, ISC, Apache-2.0), never AGPL/GPL. Name adopted
    code or patterns in `NOTICE` and in a header comment.
11. **Keep `apps/cli/nyxos.mjs` dependency-free** — it runs from the release without `node_modules`.
12. **Docs:** if behaviour, commands, settings or environment variables change, update `docs/` and
    `CHANGELOG.md` (`## [Unreleased]`).
