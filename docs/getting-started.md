# Getting started

This page takes you from zero to your first live session in NyxOS.

## 1. Check the requirements

- **macOS 13+** or **Linux with systemd** (x64 or arm64).
- `curl` (or `wget`) and `tar` — present on almost every system.
- Optional but recommended: **Claude Code** and/or **Codex**. NyxOS watches the sessions of these tools; without
  them there is nothing to show yet (try `nyxos demo` instead).
- Optional: `git` for the git views. `tmux` is installed for you.

## 2. Install

```bash
curl -fsSL https://raw.githubusercontent.com/VariadAgency/NyxOs---Agentic-OS/main/install.sh | bash
```

What happens, step by step:

| Step | Details |
|---|---|
| Node.js | Node.js 24 is downloaded into `~/.nyxos/runtime/node` and checked against the official SHA-256 sums. Your system Node (if any) stays untouched. |
| tmux | Installed with Homebrew (macOS) or apt / dnf / pacman / zypper (Linux). On Linux your system may ask for your password. If it fails, NyxOS still works — just without the terminal view. |
| Release | The latest NyxOS release is downloaded from GitHub, its SHA-256 sum is checked, and it is unpacked into `~/.nyxos/app/versions/<version>`. |
| Services | The server and the bridge are registered as background services: launchd agents on macOS, systemd `--user` units on Linux. Where neither is available (containers, WSL), the server runs as a detached background process. |
| Command | `~/.nyxos/bin` is added to your `PATH` in `~/.zshrc` / `~/.bashrc` (a marked block that `nyxos uninstall` removes again). |
| Browser | Your browser opens with a **one-time sign-in link** (valid for 2 minutes). |

Installer options (environment variables, e.g. `curl … | NYXOS_NO_BROWSER=1 bash`):

| Variable | Effect |
|---|---|
| `NYXOS_HOME` | Install somewhere other than `~/.nyxos` |
| `NYXOS_VERSION` | Install a specific version instead of the latest |
| `NYXOS_TARBALL` | Install from a local release file (offline, testing) |
| `NYXOS_PORT` | Use another port than 47800 |
| `NYXOS_NO_BROWSER=1` | Do not open the browser; the sign-in link is printed instead |
| `NYXOS_SKIP_TMUX=1` | Do not install tmux |

> **Installing on a machine without a browser?** Use `NYXOS_NO_BROWSER=1`, then on your own computer run
> `ssh -L 47800:127.0.0.1:47800 <that-machine>` and open the printed link.

## 3. Onboarding

The first page in the browser is the onboarding wizard.

1. **Name and language.** How NyxOS and Nyx should address you, and whether the interface is German or
   English. You can change both later under **Settings → Info & Help**.
2. **Connect an AI.** Nyx needs a model to talk. Pick what you have:
   - **Claude account** — if the `claude` command is installed and signed in, NyxOS uses it.
   - **Codex** — if the `codex` command is installed and signed in.
   - **API key** — Anthropic, OpenAI or any OpenAI-compatible provider (for example OpenRouter). Keys are
     stored encrypted on your computer.
   - **Local model** — Ollama or LM Studio running on your computer.

   NyxOS tests the connection and shows the result in plain words. You can skip this step; everything except
   Nyx works without an AI.
3. **Short interview.** Nyx asks a few questions about how you work and suggests a personality (tone,
   directness, how proactive it is). Adjust it later under **Settings → Nyx**.
4. **Your setup.** One button — **Set everything up** — takes the recommended folders and installs the hooks.
   - **Project folders** — NyxOS finds them by itself: it looks where you already worked with Claude Code or
     Codex (the working folders in `~/.claude` and `~/.codex`) and does a short scan of your home folder for
     git repositories. Each suggestion shows how many projects and sessions it holds; tick what you want, or
     pick any folder with **Choose folder …**. Leave it empty to track every session.
     These folders are also the boundary in which NyxOS may start sessions, run builds and show files.
   - **Obsidian vault** (optional) — read-only; notes and their links appear in the **Brain**.
   - **Hooks and shell integration** — see below.
5. **Dashboard.** Nyx writes your first briefing and you land on your personalized start page.

### What "hooks and shell integration" change

NyxOS asks before changing anything outside `~/.nyxos`:

| File | Change |
|---|---|
| `~/.claude/settings.json` | NyxOS hook entries are **appended** (a timestamped backup is made first). Your existing hooks stay. |
| `~/.codex/hooks.json` | Same for Codex. |
| `~/.zshrc` / `~/.bashrc` | A three-line marked block that loads NyxOS's shell functions: `claude` and `codex` started inside your project folders then run in tmux (on a separate `nyxos` socket), so NyxOS can show and control their terminal. Set `NYXOS_TMUX=0` to switch this off for one shell. |

`nyxos uninstall` removes all of it again. Without hooks, NyxOS still finds sessions through its file watcher —
just a bit later.

## 4. Your first session

```bash
cd ~/code/my-project     # one of your project folders
claude                   # or: codex
```

Within about two seconds the session appears under **Sessions**. Click it to see:

- the **chat** as it happens, including tool calls,
- the **terminal** (when started through the shell integration) — you can type into it from the browser,
- **changed files** with diffs,
- **subagents** the session started.

When the session ends, NyxOS archives its transcript and sorts it into a kind (coding, audit, planning, …)
and a workstream. If a guess is wrong, correct it — NyxOS remembers the rule.

## 5. Where your data lives

Everything NyxOS stores is in `~/.nyxos` (or `NYXOS_HOME`):

| Path | Content |
|---|---|
| `data/db/` | The database (PGlite, an embedded Postgres) |
| `data/archive/` | Archived session transcripts |
| `data/secrets.key` | Key for encrypted secrets such as API keys (file mode 0600) |
| `data/bridge-token` | Machine token the bridge and the `nyxos` command use (0600) |
| `bridge/` | Bridge configuration, send buffer, hook script, shell functions, tmux config |
| `logs/` | `server.log`, `bridge.log` (rotated at 10 MB) |
| `app/versions/`, `app/current` | Installed releases and the active one |
| `runtime/node/` | NyxOS's own Node.js |
| `demo/` | Data of the demo instance |
| `nyxos.json` | Settings chosen at install time (for example the port) |

NyxOS never uploads your data anywhere. Only the AI provider you choose receives the text Nyx sends it.

## Next

- [Guide](guide.md) — what every tab does.
- [Troubleshooting](troubleshooting.md) — if something is off.
- `nyxos doctor` — checks Node.js, tmux, git, Claude Code, Codex, server and bridge in one go.
