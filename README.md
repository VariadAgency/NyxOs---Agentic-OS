<p align="center">
  <img src="docs/images/overview.png" alt="NyxOS overview with sessions, usage and the assistant Nyx" width="880">
</p>

<h1 align="center">NyxOS</h1>

<p align="center">
  <strong>Mission control for your Claude Code and Codex sessions — local, private, in your browser.</strong>
</p>

<p align="center">
  <a href="https://github.com/VariadAgency/NyxOs---Agentic-OS/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/VariadAgency/NyxOs---Agentic-OS/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/VariadAgency/NyxOs---Agentic-OS/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/VariadAgency/NyxOs---Agentic-OS"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="macOS and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey">
</p>

<p align="center"><a href="README.de.md">Deutsche Version</a></p>

NyxOS finds every Claude Code and Codex session on your computer within about two seconds and shows them
live: chat, terminal, changed files and subagents. It archives transcripts, sorts sessions into kinds and
workstreams, and keeps tasks, bugs, ideas, audits and decisions next to the work that produces them. Git,
conflicts between parallel sessions, token usage and costs are one click away. The built-in assistant **Nyx**
briefs you in the morning, recaps the day in the evening, answers questions — by text or by voice — and can
operate the interface for you, while push, merge, deploy and delete always stay with you.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/VariadAgency/NyxOs---Agentic-OS/main/install.sh | bash
```

That's all. About a minute later your browser opens and a five-step setup guides you through the rest — no
Node.js, Docker or admin rights needed. Want to look around first? Click **See the demo** on the welcome
screen: the whole app with invented data, and you can already talk to Nyx.

<p align="center">
  <img src="docs/images/sessions.png" alt="A live Claude Code session in NyxOS" width="49%">
  <img src="docs/images/nyx.jpg" alt="Nyx, the built-in assistant" width="49%">
</p>

## Features

- **Sessions** — every Claude Code and Codex session, live: chat, terminal (tmux), changed files, subagents, full transcript archive
- **Sorting** — sessions are grouped into kinds (coding, audit, planning, …) and workstreams automatically; NyxOS learns from your corrections
- **Tasks, bugs, ideas, audits, decisions** — with a readiness check before work starts and a decisions inbox
- **Git** — uncommitted changes, branches, worktrees and commits across your projects
- **Conflicts** — see when two sessions write to the same file, and reserve paths
- **Agents & skills** — your Claude Code agents and skills, how often they are used, suggestions to improve them
- **Usage** — tokens and costs per day, model and project, with goals
- **Brain** — a knowledge graph of sessions, tasks and (optionally) your Obsidian vault
- **Nyx** — briefing, recap, chat, voice in German and English (runs on your computer, installed with one click), optional Telegram, a learning book of rules, night mode
- **Local first** — one process on `127.0.0.1` with an embedded Postgres; no Docker, no cloud account
- **German and English** interface

## Requirements

| | |
|---|---|
| Operating system | macOS 13 or newer, or Linux (any distribution; systemd recommended) |
| Processor | x64 or arm64 (Apple Silicon and Intel) |
| Recommended | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) — the tools NyxOS watches |
| Installed for you | Node.js (private copy) and `tmux` (terminal view) |

## Your data stays on your computer

- NyxOS listens only on `127.0.0.1` and keeps everything in `~/.nyxos/data`. There is no account, no
  telemetry and no NyxOS cloud.
- **Nyx** talks to the AI *you* connect: your Claude subscription (through the `claude` command), an API key,
  or a fully local model with Ollama or LM Studio.
- **Updates**: once a day NyxOS asks GitHub whether a new release exists. Nothing about you is sent.
- **Voice** (optional): speech recognition and speech run on your computer. Nothing is uploaded. Install it with
  one click in Settings → Nyx → Voice (or `nyxos voice install`), see [Voice](docs/guide.md#voice).
- Telegram, push notifications or ElevenLabs are only contacted if you set them up yourself.

More in [SECURITY.md](SECURITY.md) and [Architecture](docs/architecture.md#security-model).

## What the installer does

1. downloads Node.js 24 into `~/.nyxos/runtime` (your system Node is not touched) and checks its SHA-256 sum,
2. installs `tmux` if it is missing (Homebrew, apt, dnf, pacman or zypper),
3. downloads the latest release, checks its SHA-256 sum and unpacks it into `~/.nyxos/app`,
4. picks a free port (47800 unless that is taken) and sets up the background services
   (launchd on macOS, systemd `--user` on Linux),
5. opens NyxOS in your browser with a one-time sign-in link.

On a server without a screen it prints the link together with the `ssh -L` command to open it from your
laptop. Open a new terminal window afterwards so the `nyxos` command is found.

## First steps

The onboarding takes a few minutes:

1. **Name and language** — how Nyx should address you, German or English. Or first **See the demo**.
2. **Connect an AI** — your Claude account (through the `claude` command), Codex, an Anthropic- or
   OpenAI-compatible API key, or a local model with Ollama or LM Studio. You can skip this and add it later.
3. **Short interview** — Nyx asks a few questions and suggests a personality.
4. **Your setup** — NyxOS finds your project folders by itself (where you already worked with Claude or
   Codex); pick them with one click. Optionally your Obsidian vault, and the hooks that let NyxOS see new
   sessions instantly.
5. **Dashboard** — your personalized start page.

Now start a Claude Code or Codex session in one of your project folders. It shows up under **Sessions**
within about two seconds. More in [Getting started](docs/getting-started.md).

## Try the demo

Click **See the demo** in the onboarding, or run:

```bash
nyxos demo
```

It starts a second, separate instance with invented sessions, tasks and usage. Your real data is not touched.
Every start uses fresh demo data (`--keep` keeps the last state). Stop it with Ctrl+C.

## Everyday commands

| Command | What it does |
|---|---|
| `nyxos open` | Open NyxOS in the browser (signed in) |
| `nyxos status` | State of server and bridge |
| `nyxos restart` / `nyxos stop` | Restart or stop server and bridge |
| `nyxos logs [-f]` | Show the logs (`-f` follows them) |
| `nyxos doctor` | Check requirements and give hints |
| `nyxos update` | Update to the latest release |
| `nyxos demo [--keep]` | Start the demo with invented data |
| `nyxos voice install \| status \| remove` | Voice: listening and speaking, local (optional, about 1 GB) |
| `nyxos uninstall [--purge]` | Remove NyxOS (`--purge` also deletes your data) |
| `nyxos version` | Show the installed version |

## Update

NyxOS checks GitHub Releases once a day. With **Settings → Info & Help → automatic updates** switched on (the
default), new versions install themselves; otherwise you see a notice. By hand:

```bash
nyxos update                               # latest release
nyxos update --version 0.1.0               # a specific version (also for going back)
nyxos update --from ./nyxos-0.1.0.tar.gz   # from a downloaded release file
```

Every download is checked against its SHA-256 sum. The last three versions stay in `~/.nyxos/app/versions`.

## Uninstall

```bash
nyxos uninstall           # removes services, hooks, PATH entry and the app; keeps ~/.nyxos/data
nyxos uninstall --purge   # removes everything, including your data
```

NyxOS's hooks are removed from `~/.claude/settings.json` and `~/.codex/hooks.json`; your other entries stay.

## How it works

```
 Claude Code / Codex sessions             your browser
 (~/.claude, ~/.codex, tmux)              http://127.0.0.1:47800
          │                                      ▲
          │ hooks + file watcher                 │ HTTP + WebSocket (sign-in cookie)
          ▼                                      │
 ┌──────────────────┐   machine token   ┌────────┴──────────────────────┐
 │  bridge          │ ────────────────▶ │  server (one Node process)    │
 │  (background     │ ◀──────────────── │  API · web app · Nyx          │
 │   service)       │   commands        │  PGlite (Postgres) in         │
 └──────────────────┘                   │  ~/.nyxos/data                │
                                        └───────────────────────────────┘
```

- The **bridge** watches your session files, receives hook events, runs terminals in tmux and forwards
  everything to the server. If the server is briefly away, it buffers.
- The **server** stores sessions, tasks and settings in an embedded Postgres (PGlite), serves the web app and
  runs Nyx. It only listens on `127.0.0.1`.
- The **`nyxos` command** installs, starts, updates and removes everything.

Details: [Architecture](docs/architecture.md).

## Server mode (optional)

Prefer to run NyxOS on your own server? `infra/` contains a Docker Compose setup with Postgres and optional
containers for voice, push notifications (ntfy) and container logs (Dozzle). The bridge on your computer
connects through an SSH tunnel or Tailscale. See [Server mode](docs/server-mode.md).

## Language

The interface is available in **German** and **English**. Switch under **Settings → Info & Help**. The
`nyxos` command and the installer follow your system language. Want to add a language? See
[Translations](docs/translations.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, onboarding, first session, where data lives |
| [Guide](docs/guide.md) | A tour of every tab and of Nyx |
| [Troubleshooting](docs/troubleshooting.md) | When something does not work |
| [Configuration](docs/configuration.md) | Environment variables |
| [Architecture](docs/architecture.md) | Components, data flow, security model |
| [Server mode](docs/server-mode.md) | Running NyxOS with Docker Compose |
| [Translations](docs/translations.md) | How i18n works, adding a language |
| [Releasing](docs/releasing.md) | For maintainers |

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). Please report security issues privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 NyxOS contributors. Third-party notices: [NOTICE](NOTICE).
