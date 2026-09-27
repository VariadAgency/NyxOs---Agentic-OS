# Architecture

NyxOS is a TypeScript monorepo (pnpm workspaces) with four apps and one shared package. This page explains how
they fit together.

## Components

| Component | Path | Role | Main technology |
|---|---|---|---|
| **Server** | `apps/server` | HTTP + WebSocket API, serves the web app, stores everything, runs Nyx, the scheduler and Telegram | Node 24, Hono, Drizzle ORM, PGlite / Postgres 17, zod |
| **Web app** | `apps/web` | The interface in the browser | React, Vite, Tailwind, TanStack Query, xterm.js, CodeMirror, three.js / force-graph |
| **Bridge** | `apps/bridge` | Background service on your computer: watches transcripts, receives hooks, runs tmux terminals, reads git, forwards everything to the server | Node, chokidar, `node:sqlite` buffer, tmux |
| **CLI** | `apps/cli` | The `nyxos` command: install, start/stop, update, demo, uninstall | Plain Node (built-ins only, no dependencies) |
| **Shared** | `packages/shared` | Types and zod schemas shared by all apps, transcript parsers, usage prices, the i18n layer | TypeScript, zod |

Other parts of the repository:

| Path | Content |
|---|---|
| `install.sh` | The one-line installer (downloads Node.js and a release, then calls `nyxos install`) |
| `infra/` | Docker Compose setup for server mode, plus the optional `nyx-voice` container (Python) |
| `scripts/` | Packaging (`package.mjs`), repository checks (`check-clean.sh`), `set-repo.sh`, dev helpers, lint rules |
| `.github/workflows/` | CI (typecheck, lint, tests, package on macOS + Ubuntu) and the release pipeline |

## Data flow

```
 ~/.claude/projects/*.jsonl ─┐
 ~/.codex/sessions/*.jsonl  ─┤ file watcher (chokidar)
 Claude Code / Codex hooks  ─┤ hook script → spool folder (never blocks the tool)
 git repositories           ─┤
 Obsidian vault (read-only) ─┘
                             ▼
                     ┌───────────────┐   POST /ingest/*  (Bearer machine token)
                     │    bridge     │ ─────────────────────────────────────────┐
                     │ buffer.sqlite │ ◀──── WebSocket /bridge (commands: ──────┐│
                     └───────────────┘       terminal, start session, files)  ││
                             │ tmux -L nyxos                                  ││
                             ▼                                                ▼│
                       your sessions                                 ┌─────────┴───────┐
                                                                     │     server      │
                     browser ◀── WebSocket /live (live updates) ──── │  Hono + Drizzle │
                             ─── HTTP /api/* (cookie + CSRF) ──────▶ │  PGlite/Postgres│
                             ◀── WebSocket /terminal/:id ─────────── │  archive/       │
                                                                     └─────────────────┘
```

1. **Detection.** Hooks fire the moment a session starts, calls a tool or stops. The hook script only drops the
   event into a spool folder and exits, so Claude Code and Codex are never slowed down. In parallel, the file
   watcher notices new transcript lines. Either way, a new session appears within about two seconds.
2. **Buffering.** The bridge parses events and keeps an outbox in `buffer.sqlite`. If the server is not
   reachable, events wait there and are sent later.
3. **Ingest.** The server stores sessions, messages, files and usage, archives complete transcripts (verified
   by SHA-256), sorts sessions into kinds and workstreams, and pushes changes to open browsers over `/live`.
4. **Commands back.** Over the `/bridge` WebSocket the server asks the bridge to open terminals, start
   sessions, list files or transcribe audio — only inside the configured project folders.
5. **Nyx.** The server's scheduler runs briefings, recaps and background checks; the chat runs on demand. Nyx
   works through tools on the same API the web app uses, and through the `/live` channel it can operate the UI.

## Local mode vs. server mode

| | Local mode (default) | Server mode (optional) |
|---|---|---|
| Entry point | `apps/server/src/local.ts` | `apps/server/src/main.ts` |
| Database | PGlite (Postgres compiled to WebAssembly) in `~/.nyxos/data/db` | Postgres 17 container |
| Listens on | `127.0.0.1:47800` | `0.0.0.0:8080` inside the container, published only on `127.0.0.1` of the host |
| Started by | launchd / systemd `--user` / detached process, via `nyxos` | Docker Compose (`infra/`) |
| Bridge connects | directly to `127.0.0.1` | through an SSH tunnel or Tailscale |
| Sign-in | one-time link from `nyxos open` | passkeys (set up with a one-time code) |
| Updates | `nyxos update` / automatic | pull and rebuild the containers |
| Extras | — | optional voice, ntfy push and Dozzle log containers |

Both modes run the same `createApp()` from `apps/server/src/app.ts`; only storage and startup differ. See
[server mode](server-mode.md).

## Database and migrations

- The schema lives in `apps/server/src/db/schema.ts` (Drizzle).
- Migrations are plain SQL files in `apps/server/drizzle/`, numbered in order, with the journal in
  `apps/server/drizzle/meta/`. Create a new one with `pnpm --filter @nyxos/server db:generate` after changing
  the schema.
- Migrations are **additive**: add tables and columns, never drop or rename in place, so an older version can
  still start after a rollback.
- In local mode the server applies pending migrations on every start before it listens.
- `/health` runs real checks (database answers, schema is up to date, archive folder is writable), not just "ok".

## Internationalization

German is the source language. Every UI text is written in German and wrapped in `t()` from
`@nyxos/shared`; the German text itself is the key. English dictionaries in
`packages/shared/src/i18n/en/*.ts` map it to English; a missing key falls back to German. The language is a
setting stored in the database (`lang`), applied by the server at start and by the web app on load. Details:
[translations](translations.md).

## Update mechanism

1. The server (`apps/server/src/app-info/updates.ts`) asks the GitHub Releases API once a day for the latest
   version of the repository named in `package.json` → `nyxos.repo`.
2. If a newer version exists and **automatic updates** are on (Settings → Info & Help), the server starts
   `nyxos update` in the background; otherwise it shows a notice with an install button.
3. `nyxos update` downloads `nyxos-<version>.tar.gz` and `SHA256SUMS`, verifies the sum, unpacks into
   `~/.nyxos/app/versions/<version>`, atomically switches the `current` symlink, rewrites the service
   definition and restarts the server. Only when `/health` answers is the bridge re-registered.
4. The last three versions are kept; `nyxos update --version <old>` rolls back.

Before the placeholder repository `OWNER/nyxos` is replaced (see [releasing](releasing.md)), no update check
runs.

## Security model

| Measure | Details |
|---|---|
| Loopback only | The local server binds to `127.0.0.1`. A host allow-list rejects requests whose `Host` header is not `127.0.0.1` / `localhost` (DNS rebinding protection); extra hosts must be listed in `NYXOS_ALLOWED_HOSTS`. |
| Sign-in for reads and writes | Every `/api` request and the `/live` channel need a session cookie (`SameSite=Strict`, `HttpOnly`). Writes also need a CSRF token. The local sign-in link is one-time and valid for 2 minutes. |
| Origin checks | WebSockets require `Origin` to match `Host` exactly, so another page on `localhost` cannot listen in. |
| Machine token | The bridge and the CLI authenticate with a random token in `~/.nyxos/data/bridge-token` (mode 0600). The server stores only its hash. |
| Secrets at rest | API keys, Telegram and other tokens are encrypted with AES-256-GCM. The key is `~/.nyxos/data/secrets.key` (0600). The API only ever returns "set" plus the last four characters. |
| Nyx guard rails | Risky actions (delete, merge, push, deploy, migration, closing a session, approvals) need a confirmation card the user clicks. Sign-in, passkeys and keys are not reachable through Nyx's tools. Text from outside (transcripts, web pages, Telegram) is fenced and treated as data, never as instructions. |
| Approval hook | A guard hook in Claude Code / Codex pauses commands on the approval list and waits for your decision in NyxOS. |
| Private URLs | In server mode, fetches to private network addresses are blocked unless explicitly allowed. |
| Hooks are additive | NyxOS appends to `~/.claude/settings.json` and `~/.codex/hooks.json` after a backup and removes only its own entries on uninstall. |

## `~/.nyxos` layout

```
~/.nyxos/
├── app/
│   ├── versions/<version>/   unpacked releases (last 3 kept)
│   │   ├── bin/nyxos         shell wrapper for the command
│   │   ├── cli/nyxos.mjs     the nyxos command
│   │   ├── server/           dist/ (bundled server), drizzle/ (migrations), web/ (built web app)
│   │   └── bridge/bridge.js  bundled bridge
│   └── current -> versions/<version>
├── runtime/node/             Node.js 24 used by NyxOS
├── bin/nyxos                 symlink to the command (on your PATH)
├── data/
│   ├── db/                   PGlite database
│   ├── archive/              archived transcripts
│   ├── secrets.key           0600
│   └── bridge-token          0600
├── bridge/                   config.json, buffer.sqlite, spool/, shell/, tmux.conf, hook script
├── logs/                     server.log, bridge.log
├── demo/                     data of `nyxos demo`
├── nyxos.json                install-time settings (port)
└── server.pid                only in detached mode
```

Services: `~/Library/LaunchAgents/app.nyxos.server.plist` and `app.nyxos.bridge.plist` on macOS;
`~/.config/systemd/user/nyxos-server.service` and `nyxos-bridge.service` on Linux.

## Repository layout

```
apps/
  server/     src/local.ts (local mode) · src/main.ts (server mode) · src/app.ts (all routes)
              src/db/ (schema) · src/nyx/ (assistant) · src/routes/ · drizzle/ (migrations) · test/
  web/        src/App.tsx · src/nav.ts (sidebar) · src/features/<area>/ · src/components/ · test/ · e2e/
  bridge/     src/main.ts (run | install | uninstall | status | …) · src/daemon.ts · src/guard/ (approval hook)
              src/terminal/ (tmux) · src/vault/ (Obsidian) · test/
  cli/        nyxos.mjs · bin/nyxos · test/
packages/
  shared/     src/*.ts (types, schemas) · src/parse/ (Claude/Codex transcripts) · src/i18n/
infra/        docker-compose.yml · Dockerfile · Dockerfile.agent · nyx-voice/
scripts/      package.mjs · check-clean.sh · set-repo.sh · dev.mjs · lint/ · test/
docs/         this documentation
```
