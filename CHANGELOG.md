# Changelog

All notable changes to NyxOS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-27

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

[Unreleased]: https://github.com/OWNER/nyxos/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/nyxos/releases/tag/v0.1.0
