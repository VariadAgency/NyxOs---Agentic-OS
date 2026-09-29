# Troubleshooting

**Start here:** run

```bash
nyxos doctor
```

It checks Node.js, tmux, git, Claude Code, Codex, the server and the bridge, and prints a hint next to every
item that fails (`✗`). Claude Code and Codex are optional — a missing one is not an error.

`nyxos status` prints the version, whether the server is healthy, the bridge state and where your data is.

---

## Logs

| File | Written by |
|---|---|
| `~/.nyxos/logs/server.log` | the server (API, web app, Nyx) |
| `~/.nyxos/logs/bridge.log` | the bridge (file watcher, hooks, terminals) |
| `~/.nyxos/logs/voice.log` | the voice service, if [voice](guide.md#voice) is installed |

```bash
nyxos logs      # last 100 lines of both
nyxos logs -f   # follow live
```

Logs are rotated at 10 MB (the previous one is kept as `*.log.1`). Log lines are JSON; transcript contents and
secrets are never logged.

## The bridge is offline

The status bar in NyxOS shows the bridge state. When it says offline:

1. `nyxos restart` — restarts server and bridge.
2. `nyxos status` — is the `bridge` entry filled in, and does its `health` say `200`?
3. `nyxos logs` — look at the end of `bridge.log`.
4. Check the service directly:
   - macOS: `launchctl print gui/$(id -u)/app.nyxos.bridge`
   - Linux: `systemctl --user status nyxos-bridge.service`

The bridge buffers events while the server is away and sends them later, so nothing is lost during a restart.

## No sessions show up

- **Is the session inside one of your project folders?** If you chose project folders during onboarding,
  sessions outside them are ignored on purpose. Add the folder or clear the list in the settings.
- **Is the bridge running?** See above.
- **Hooks installed?** Without hooks NyxOS still finds sessions through its file watcher, just later. Re-run
  the setup step in the onboarding or check that `~/.claude/settings.json` / `~/.codex/hooks.json` contain
  `nyxos` entries.
- **Where do your tools write?** NyxOS reads `~/.claude/projects/` (Claude Code) and `~/.codex/sessions/`
  (Codex). If these folders do not exist, the tool has not been run yet on this account.
- `nyxos status` shows how many transcript files the bridge knows, how many it ignores and how many are
  archived.

The NyxOS hooks never block Claude Code or Codex: they finish within milliseconds, swallow their own errors
and buffer when the server is not reachable.

## Nyx does not answer

Nyx needs access to an AI model. Open **Settings → General** and look at the access and models sections — each
connection shows a test result in plain words.

| You use | Check |
|---|---|
| Claude account | Is `claude` installed and signed in? Run `claude` once in a terminal. |
| Codex | Is `codex` installed and signed in? |
| API key | Is the key still valid and does the account have credit? Save it again to re-test. |
| Ollama / LM Studio | Is it running on this computer (Ollama: port 11434, LM Studio: port 1234) and is a model loaded? |

**Installed `claude` or `codex` after NyxOS?** The background service remembers the `PATH` of the shell that
installed it. Open a new terminal (so `which claude` works) and run:

```bash
nyxos setup --no-open
```

This rewrites the service with your current `PATH` and restarts it.

In the demo (`nyxos demo`, or "Demo ansehen" in the onboarding) Nyx uses the Claude program of this computer if it
is signed in, otherwise it answers a few prepared questions. Nothing runs in the background there, and nothing can
be changed. The demo started from the onboarding keeps its log in `~/.nyxos/logs/demo.log`.

## "Sign-in expired" or "Not signed in"

Sign-in links are one-time and valid for 2 minutes. Get a fresh one:

```bash
nyxos open
```

It opens the browser already signed in. On a machine without a browser it prints the link instead. Every read
and write needs a sign-in, so other users of the same computer cannot see your sessions.

## Port 47800 is already in use

You normally never see this: on the first install NyxOS checks whether 47800 is free and otherwise takes the
next free port (47810, 47820, …). The port is saved in `~/.nyxos/nyxos.json`, so all later commands use it;
`nyxos status` shows the address. The demo takes the port two above (e.g. 47802) or any free one.

If another program later grabs the port, move NyxOS once:

```bash
NYXOS_PORT=47900 nyxos setup
```

## Linux: systemd user services are not available

On systems without a systemd user session (containers, some WSL setups, minimal servers) NyxOS falls back to
a **detached background process** automatically. Everything works, but it does not start by itself after a
reboot — run `nyxos restart` after logging in.

To get real services instead:

- make sure `systemctl --user status` works in your session,
- on WSL, enable systemd in `/etc/wsl.conf` (`[boot]` → `systemd=true`) and restart WSL,
- for servers without a desktop login, allow services to keep running: `loginctl enable-linger $USER`,

then run `nyxos setup --no-open`.

## tmux is missing

Without tmux, NyxOS works but shows no terminal and cannot start sessions for you.

```bash
brew install tmux          # macOS
sudo apt install tmux      # Debian / Ubuntu (dnf, pacman, zypper work the same way)
nyxos restart
```

## An update failed

`nyxos update` only switches to the new version after it downloaded completely and its SHA-256 sum matched. If
the new version does not start, go back:

```bash
nyxos update --version 0.1.0     # the version you had before
```

The last three versions stay in `~/.nyxos/app/versions/`. Without internet, install from a release file you
downloaded earlier: `nyxos update --from ./nyxos-0.1.0.tar.gz`.

"Checksum mismatch" means the download was damaged or incomplete — try again later. If GitHub is unreachable,
the automatic update check simply retries the next day.

## Voice does not start or does not install

```bash
nyxos voice status   # installed? running? models still downloading?
nyxos logs           # includes voice.log
```

- **"Not enough free disk space"** — voice needs about 2 GB free while installing (about 1 GB afterwards).
- **Download failed** — check the internet connection and press "Install voice" again; finished parts are kept.
- **"An ffmpeg with Opus is missing"** — rare; the pack brings its own ffmpeg. Install one (`brew install ffmpeg`
  or `sudo apt install ffmpeg`) and install voice again.
- **Linux**: needs x64 or arm64 with glibc 2.28 or newer; Alpine/musl is not supported.
- Start over: `nyxos voice remove`, then `nyxos voice install`.

## Full reset

Removes NyxOS and **all your NyxOS data** (sessions archive, tasks, settings, keys):

```bash
nyxos uninstall --purge
curl -fsSL https://raw.githubusercontent.com/OWNER/nyxos/main/install.sh | bash
```

Your Claude Code and Codex transcripts in `~/.claude` and `~/.codex` are not touched — NyxOS imports them again
after the reinstall.

## Still stuck?

Open an issue with the output of `nyxos doctor`, `nyxos status` and the relevant part of `nyxos logs` (remove
anything private first): <https://github.com/OWNER/nyxos/issues>.
