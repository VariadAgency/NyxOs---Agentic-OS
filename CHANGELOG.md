# Changelog

All notable changes to NyxOS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-29

First public release.

### Added

- **Session detection** — every Claude Code and Codex session on your computer appears within about two
  seconds, through hooks and a file watcher in the background bridge.
- **Live sessions** — chat, terminal (tmux, usable from the browser), changed files with diffs, subagents,
  context usage and costs per session.
- **Transcript archive** with full-text search, verified by SHA-256.
- **Automatic sorting** of sessions into kinds and workstreams, learning from your corrections.
- **Tasks, bugs, ideas, audits and decisions** with stages, a six-point readiness check and a decisions
  inbox.
- **Approvals** — a guard hook pauses push, merge into main, deploy, migrations, deleting outside a worktree
  and closing sessions until you approve.
- **Git view** — uncommitted changes, branches, worktrees and commits across your projects.
- **Conflicts** — collision map of parallel sessions and path reservations.
- **Agents and skills** — catalog, usage statistics, history and improvement suggestions.
- **Usage** — tokens and costs per day, model and project, with goals.
- **Brain** — knowledge graph of sessions, tasks and an optional Obsidian vault, in 2D and 3D.
- **Files** — Finder-style browser with Markdown reader and code editor.
- **Nyx assistant** — morning briefing, evening recap, chat, UI control with confirmation cards, memory,
  learning book, night mode for approved autonomous runs, optional voice and Telegram.
- **AI access** — Claude account (via `claude`), Codex, Anthropic- or OpenAI-compatible API keys, local
  models with Ollama or LM Studio.
- **Local mode** — one process on `127.0.0.1` with embedded Postgres (PGlite) in `~/.nyxos/data`; no Docker.
- **Server mode** — optional Docker Compose setup in `infra/` with Postgres and optional voice, ntfy and
  Dozzle containers.
- **One-line installer** for macOS 13+ and Linux (x64, arm64) with its own Node.js runtime, launchd /
  systemd `--user` services and a detached fallback.
- **`nyxos` command** — `open`, `status`, `restart`, `stop`, `logs`, `doctor`, `update`, `demo`,
  `uninstall`, `version`.
- **Onboarding** — name and language, AI connection, short interview with Nyx, project folders, Obsidian
  vault, hooks and shell integration.
- **Demo mode** — `nyxos demo` with invented data on port 47802.
- **Updates** via GitHub Releases with SHA-256 verification, automatic-update switch and rollback.
- **German and English** interface.
- **Security** — loopback-only server, sign-in for reads and writes (cookie + CSRF), passkeys, machine
  token, encrypted secrets at rest.
- **Voice for the local install, with one click** — Settings → Nyx → Voice → "Install voice" (or
  `nyxos voice install|status|remove`) sets up speech recognition and speech output in German and English on this
  computer: a pinned [uv](https://github.com/astral-sh/uv) (SHA-256 checked) fetches a private Python 3.12 and
  hash-pinned packages (`infra/nyx-voice/requirements-local.txt`, incl. an ffmpeg with Opus from imageio-ffmpeg) —
  no admin rights, Homebrew or system Python. NyxOS runs the `nyx-voice` service as a child process on
  `127.0.0.1` (port `NYXOS_VOICE_PORT`, default server port + 3) with a fresh key per start, restarts it after a
  crash and stops it with NyxOS. Models (~0.7 GB) download on first start with a progress bar. New routes
  `GET /api/nyx/voice/pack`, `POST /api/nyx/voice/pack/install|remove` (local mode only). `nyxos doctor` reports
  the voice, `nyxos uninstall` removes it, the release ships `voice/` and `cli/voice.mjs`.
- **Voice follows the app language** — text without a clear language is spoken with the voice of the app language
  (`defaultLanguage` in `/speak`), short undecided transcripts count as the app language, and whisper.cpp gets an
  English hint prompt for English dictation.

- **Onboarding "Einrichten" in one click** — the setup step now finds your project folders on any machine: from the
  working folders of recent Claude Code and Codex sessions (mapped to their Git top level and the folder that holds
  the repos), plus a short, time-limited scan of the home folder. Suggestions show repo and session counts and the
  recommended ones are set up together with the hooks by one "Alles einrichten" button. A folder picker replaces
  typing paths (new `GET /api/setup/browse?path=`, bridge RPC `setup.browse`, capability `setup_browse`; older
  bridges get a clear hint). The tmux install hint follows the machine's package manager (brew, apt, dnf, yum,
  pacman, zypper, apk; macOS without Homebrew is explained), the step waits calmly while the background service
  connects, and the tmux shell integration is an explained opt-in. On macOS, reads below Documents, Desktop,
  Downloads, iCloud and external volumes never hang while the system permission dialog is open.

- **Try the demo from the onboarding** — "Demo ansehen" starts a demo instance with invented data next to your
  installation (`POST /api/demo/start`, port 47802, data in `~/.nyxos/demo`, log in `~/.nyxos/logs/demo.log`). It
  ends with NyxOS and after an hour without use.
- **Look-only demo** — in the demo every write answers `403 demo_readonly`, except browsing and talking to Nyx.
  Nyx uses your signed-in Claude program there (read-only tools) or prepared answers to suggested questions
  (`GET /api/demo/questions`). `/api/app/info` has `demoHomeUrl` and `demoEngine`.
- **English mode without German leftovers** — reviewed ~640 English texts (consistent terms: approval, workstream,
  job, thread, Credentials, Claude Code); English quotation marks in briefings, Telegram and settings; the Telegram
  bot menu uses `/new`, `/temporary`, `/help` in English (German names keep working); dictation transcribes in the
  app language; a briefing written before switching the language is rewritten; Nyx's slider stages and default
  personality are English; the du/Sie choice only shows in German; task history shows readable events; the spoken
  briefing reads "28.1M", "5 h" and "09/26" as words; `install.sh` errors are no longer prefixed "Fehler/Error".
- **"This computer" page in local mode (macOS and Linux)** — the Server tab of a local install now shows the real
  system (macOS version via SystemVersion.plist, Linux distribution from `/etc/os-release`), CPU and load via
  `os.cpus()`/`os.loadavg()` on macOS, memory the way Activity Monitor counts it (`vm_stat`), swap, network
  (`netstat -ibn`) and the disk of the NyxOS data folder. No container, Docker, Dozzle, deploy or "still missing"
  hints locally, rows macOS never reports are hidden, and the sidebar entry is called "Dieser Rechner". Server
  mode is unchanged.
- **Connections page made for the local install** — in local mode, `GET /api/connections`
  leaves out server-only checks (socket proxy, Dozzle, deploy log, Nyx token and worker, passkeys) and says so in
  local words ("bridge", "this computer"). Optional parts that are not set up (ntfy, Telegram, voice, Obsidian
  vault, task import) show "optional, not set up"; Codex is only checked when it is installed. "Nothing has
  arrived yet" with a healthy bridge is the new calm state `idle` ("waiting": arrives as soon as you start a
  Claude session) instead of a failure; what worked and stopped stays red. A missing Claude program shows once,
  with the install command. The report has `mode`, the summary counts `idle`. The overview no longer shows a
  yellow "project containers" line in local mode without Docker.
- **Free port by itself** — on the first install NyxOS uses 47800 unless another program already listens there;
  then it takes the next free port (47810, 47820, …) and remembers it. The demo takes the port two above, or any
  free one. The `ssh -L` hint only appears on machines without a screen.
- **Neutral wording for every computer** — texts say "computer"/"Rechner" and "bridge" instead of "Mac" and
  "Mac bridge"; the local sign-in section explains `nyxos open` instead of passkeys; English transcripts correct
  "Nix" to "Nyx" when Nyx is addressed.
- **Session controls in the session info** — a "Controls" section (side column and the phone sheet "⋯") shows the
  current model and switches it with one click; the list only contains models the session's tool accepts (Claude
  Code: Anthropic models via `/model <id>`). Effort levels (`/effort low|medium|high|xhigh|max|auto`) appear only
  when the model supports them (older Claude models have fewer or none). Commands always go through the delivery
  queue: if the session is busy, they go out at its next pause. Codex only switches models in its own picker, so
  NyxOS offers no switch there. New API `GET/POST /api/sessions/:id/controls` (also available to Nyx via `app_api`).
- **Brain: "Nyx explains"** — the detail card of a brain point (side sheet and the info card in the local graph)
  has a Nyx button at the top: a short summary of what the point is, what it stands for and its most important
  connections. Long paths and lines in the card now wrap instead of running out of it; on phones the card uses the
  full width.
- **Nyx summarizes a session** — a Nyx button in the session info (side column, collapsed rail and as an icon in
  the session head) asks Nyx for a detailed, structured summary of the session: goal · what was done (steps, changed
  files, commits, tests) · what is running · open points and questions for you · sensible next step. It stays as a
  collapsible card at the top of the chat (streams while Nyx writes, read aloud, copy, time), shows „3 new messages
  since the summary“ with „Create again“, and is stored per session (`GET/POST /api/sessions/:id/summary`, migration
  `0046_session_summaries`). Long histories are shortened to beginning + latest rounds plus a tool/file overview of the
  whole session; paths, commit ids and numbers that don't appear in the history are left out. Runs on your own Nyx
  model and budget – without a model you get an honest message instead. Nyx may create and read summaries itself.
- **Nyx knows NyxOS completely** — a map of the whole app is generated from the code (`scripts/nyxos-map.mjs`,
  also run by the server build): sidebar, every route, every settings section with sub-pages and spots, every
  `data-nyx` control per page, the API routes with their purpose and every database table with its columns. English
  names come from the dictionary, so the map also answers English questions. Nyx gets a short overview of all tabs
  in its prompt and a new tool `nyxos_karte` ("skills", "where do I set quiet hours", "which table stores
  notifications" → page, click path, controls, API, table), and never says something doesn't exist without asking
  the map. A test fails when a route, sidebar entry or settings section has no description or the map is stale.
- **Nyx always navigates with the cursor** — `ui_navigate` and reading the briefing no longer jump to a route: the
  cursor clicks the sidebar entry (on phones the bottom bar or "More"), then row, tile or sub-page step by step,
  following the click path from the map. Without a clickable way Nyx says so honestly instead of jumping.

- **Focus button** — at the bottom left of the side bar (on the phone in the „More“ drawer) and as the top row of
  Settings → Notifications: *Automatic* · *I'm away* · *Do not disturb*, each with one sentence, for 1 hour, until
  this evening / tomorrow morning (the user's time zone) or until turned off. *I'm away* counts as away even with
  NyxOS open (phone only), *Do not disturb* lets only approvals, crashes, failed deploys and urgent ones through to
  the phone and logs the rest as „Focus – silenced“. Expiry in the minute tick, live update to all windows, Nyx may
  set it through `app_api`. Messages Nyx held back to bundle are checked against the focus again before they go
  out. `GET/PUT /api/focus`, migration `0048_focus_state` (new table).
- **Feedback & support** — a quiet "Feedback & Unterstützen" button in the status line (under "All
  connections"), on the connections page, at the bottom of Settings and in ⌘K opens one sheet with three tabs:
  *report a bug* (what happened, steps, expected, optional e-mail, optional screenshot, and diagnostics with an
  exact preview — paths, host names, addresses, tokens and e-mail addresses removed), *idea for the developer*
  (title, description, how important) and *Buy me Tokens* (3/5/10/25 € or a free amount, once or monthly,
  optional name and message). Payment happens inside NyxOS in a sandboxed frame of the project website.
- `/api/support/*` on the server forwards to the support service set by `NYXOS_SUPPORT_URL` (or the setting in
  the sheet). Without an address, or while it cannot be reached, reports wait in an **outbox** and go out by
  themselves in the server's one-minute tick. The contract for the website is in `docs/support-api.md`.
- Nyx may open the sheet and prepare drafts (`PUT /api/support/draft`); sending needs your confirmation,
  donating and changing the address are never possible for Nyx.

- **Settings as overview + subpages** — `/settings` is a list with search (areas and single settings, in the
  chosen language), one subpage per area (`/settings/<area>`, „‹ Settings“ back, rarely needed parts behind
  „Advanced“), the Nyx settings in the same pattern (`/einstellungen/nyx/<area>`, new page „Access &
  approvals“). ⌘K knows every subpage. Local mode shows local texts (no passkeys under „Account & sign-in“).
  „Feedback & support“ and „Info & Help“ have their own rows under „Help & feedback“.
- **Phone** — bottom bar (Nyx · Sessions · Decisions · Overview · More), search button instead of ⌘K, safe-area
  margins (`viewport-fit=cover`), 44 px touch targets, 16 px inputs (no iOS zoom), dialogs as bottom sheets, the
  app follows the visible area when the keyboard is open, sessions as list → session, terminal key row (Esc, Tab,
  Ctrl, ^C, arrows, paste/copy with fallbacks for `http://`), text size A−/A+ and pinch zoom, touch gestures in the
  3D brain, PWA manifest with `id`.
- **Agents in the session chat** — a bar at the bottom of the chat (and below the terminal) shows the agents of
  the session live ("● 2 agents active · 1 done", colored dots). A click opens a popup in the chat window (a sheet
  on the phone) with the tabs *This run* and *Archive* (earlier runs, each with the message that started it):
  elapsed time (ticking), tokens and — when a price is stored — cost per agent. Open an agent to see what it is
  doing right now (latest steps, current one highlighted), its task, result and its read-only transcript; add it
  to your tasks or hide it in the archive. Full screen at `/sessions/…/agenten` (suggested from 6 active agents).
  Codex teammates (child sessions) appear with their nickname and can be opened as their own session. A single
  agent cannot be stopped (Claude Code has no interface for that) — the detail says so.
- `GET /api/sessions/:id/agents-live[/:agentId]`, `POST /api/sessions/:id/agents/:agentId/hide` and
  `…/task`; Nyx may use all of them directly (`app_api`, all reversible).
- **Notifications as one pipeline** — every occasion (single push and the away digest) goes through *when? →
  duplicate/minimum gap → text → Nyx checks/writes → quiet hours/bundling → channels*, and every decision is
  logged with a reason. New page **Settings → Notifications**: per occasion *Always / When away / Never*, „never
  notify about sub-agents“, styles *Short / With context / Detailed* with a live preview, own templates with
  placeholders, Nyx checks (send · leave out · bundle) and Nyx writes (through your own model, 8 s limit, numbers
  and names checked against the data), history with „Good“ / „Don't need it“ and rule suggestions, one quiet time
  for everything, phone setup with a QR code (`uqr`, MIT). Routes `/api/notifications/*` (Nyx may use them via
  `app_api`), migration `0043_notification_rules` (additive).
- **Operation & access** (Settings → „Betrieb & Zugriff“) — says honestly how NyxOS runs right now (on this
  computer with its port, or on your server; allowed addresses, bridge, sign-in for reading, reachable from the
  phone only after a real check or a real visit through that address). Three ways — *this computer*, *own
  server*, *rented server / provider* — and three phone ways — *Tailscale* (recommended), *Cloudflare Tunnel*,
  *own domain* — each with short facts and a form that turns into ready commands to copy (the real `nyxos`,
  `install.sh`, `infra/` and bridge commands; every value shell-quoted). „Check“ calls only `<address>/health`
  with a time limit and SSRF protection. In local mode „this computer“ is the current way, and the phone gets a
  one-time sign-in link (`NYXOS_NO_BROWSER=1 nyxos open`) for the allowed address. The profile is stored in the
  new table `hosting_profile` (migration 0045); a Cloudflare tunnel token can be kept in the encrypted secret
  store. „Nyx hilft“ opens Nyx with the filled-in form (never the secrets); Nyx may read, check and save the
  form, never touch the secrets.

### Changed

- **"Compact context" moved** from the session header into the session info (Controls) – it now exists in one
  place only and uses the context guard's delivery path.
- Voice: the default German voice is now Thorsten (clear, Piper „high“), Jürgen is the second choice; the other
  Thorsten variants (low, medium, emphatic) are no longer loaded or offered for import. The local voice pack
  loads Thorsten „high“ (about 50 MB more).
- **Settings, tidier:** „Connections“ and „Telegram“ are own subpages (under „Operation & access“ and
  „Notifications“), as are „How written?“ and „Nyx checks & writes“. Search and ⌘K jump to the exact spot and open
  collapsed blocks on the way; names rank before keywords. The notification history shows 5 entries first („Show
  older“), rare occasions sit under „More occasions“, the info lines of the way cards are collapsed. Touch targets
  ≥ 44 px, select lists thumb-high in Safari.
- **Phone:** the session chat gives most of the height to the conversation (one-line header, actions in „⋯“,
  one-line composer, collapsible queue); the agent bar hides while the keyboard is open; touch targets ≥ 44 px
  outside Settings too.
- Models show readable names instead of IDs (the ID stays in the tooltip). The server page at 1024 px no longer
  stretches cards.

- Old settings links (`/settings#push`, `#verbindungen`, `#zugaenge`, `#telegram`, `/einstellungen/haiku`,
  `/einstellungen/ideen-links`, `/einstellungen/nyx#stimme` …) redirect to the new subpages; the status line
  links to Settings → Operation & access.
- HTML pages now send `frame-src 'self'` plus the origin of the support service in their
  `Content-Security-Policy`.
- Database: migration `0042_support` adds the tables `support_outbox` and `support_settings` (additive).
- Database: migration `0044_session_agent_marks` adds the table `session_agent_marks` and a partial index
  `session_events_agent_idx` on sub-agent events (additive). In server mode with a large `session_events` table,
  create the index first with `CREATE INDEX CONCURRENTLY` (the migration line is then a no-op).
- Bridge: the transcript parser attaches `usage`/`msgId`/`model` to the first event of every sub-agent answer
  (live tokens per agent) and the final report of `SubagentHandback` as text; the `SubagentStop` hook passes the
  agent id as `subagentId`. Update the bridge to see live tokens; until then they come from the archive (delayed).
- The former panels „Push“ and „When I'm away“ are replaced by the notifications page; their old switches still
  work (a kind switched off stays *Never*). Notification names no longer show the raw prompt or „Session from …“,
  channel names say „computer“/„phone“ instead of a device brand.

### Fixed

- **Terminal sessions on Linux with older tmux** — tmux up to 3.3 (Debian 12, Ubuntu 22.04) prints tabs in its
  output as `_`, so the bridge found no terminal session at all there (no live terminal, no "resume"/"take over"
  protection). It now separates the fields with `|`.
- **Installer finds the latest version without the GitHub API** — it reads the version from the release's
  `SHA256SUMS` behind the "latest" download link, which has no request limit (the API allows only 60 requests per
  hour and address without sign-in, which shared addresses in offices or mobile networks use up). The API stays as
  fallback. If both fail, the clear message "Could not find the latest version" now appears instead of a bare
  curl error.
- The context guard no longer sends the same notice two or three times in the same second (ticker and ingest
  raced; the mark is now claimed atomically before sending).
- Sub-agents of a session (rows with `parent_id`, e.g. Codex workers) no longer trigger „waiting“, „done“ or
  context-guard notifications or Telegram questions (setting, on by default).
- A Nyx run that was given up while still queued (e.g. a notification sent on after 8 s) no longer starts later.
- Quiet hours and the night window use your wall clock (the time zone set in NyxOS, else the computer's) instead of
  the process time zone – in server mode the container runs in UTC and shifted them by one or two hours.
- While you're away, usage warnings, crashes and approvals (without a Telegram card) reach the phone at once again
  instead of waiting up to 15 minutes in the digest. A waiting session Telegram already asks about is no longer also
  a digest line.
- Sessions an agent starts in its own worktree (`…/.claude/worktrees/agent-<id>`) count as sub-agents.
- Nyx can no longer filter out approvals and crashes (like urgent ones, while „important always gets through“ is on).

### Security

- Pages may only be framed by NyxOS itself (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`), plus
  `nosniff` and `Referrer-Policy: same-origin` on every answer.
- `GET /api/app/info` without sign-in no longer shows the data folder (home path) or your name.
- `POST /api/server/deploys` needs the machine token (`Authorization: Bearer …`) or a sign-in.
- Nyx asks before it starts an autonomous task (`POST /api/entries/:id/start`, or a session with `auftrag`),
  writes a file on your computer (`POST /api/finder/write`) or changes the setup (`POST /api/setup`).
- `install.sh` makes `~/.nyxos` private (0700) and downloads over HTTPS only; installer and `nyxos update` refuse
  the placeholder repository; `nyxos update` never goes back to an older release unless you ask with
  `--version`, and downloads time out after 10 minutes.
- Rewriting `~/.claude/settings.json` keeps its file mode (a 0600 file stays 0600, the backup too).
- Background services only keep absolute folders from `PATH`.
- `nyxos uninstall` needs `nyxos.json` or `app/current` as proof of an installation (a `data/` folder is not enough).
- Telegram's plain-text fallback keeps link previews off.
- GitHub Actions are pinned to commit SHAs (Dependabot keeps them current); release builds use no dependency
  cache. `scripts/check-clean.sh` checks for secret-shaped strings; personal words go in the git-ignored
  `.check-clean.local`.
- Nyx-written notifications with a link or address that is not in the session data fall back to the template text
  (session texts are foreign input).
- The health check of „Operation & access“ connects only to the address it checked (pinned DNS lookup, closes DNS
  rebinding).

[Unreleased]: https://github.com/VariadAgency/NyxOs---Agentic-OS/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/VariadAgency/NyxOs---Agentic-OS/releases/tag/v0.1.0
