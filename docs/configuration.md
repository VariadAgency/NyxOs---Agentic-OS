# Configuration

Most settings live in the interface (**Settings**) and are stored in the database. Environment variables are
for installation, server mode and development. You rarely need them in local mode.

★ marks the variables most people will ever touch.

## Where to set them

| Situation | How |
|---|---|
| Installer | Before `bash`: `curl -fsSL …/install.sh \| NYXOS_PORT=47900 bash` |
| `nyxos` command | In front of the command: `NYXOS_PORT=47900 nyxos setup` |
| Local server service | Written into the service by `nyxos setup` / `nyxos update` (launchd plist or systemd unit). To add your own, edit `~/Library/LaunchAgents/app.nyxos.server.plist` or `~/.config/systemd/user/nyxos-server.service`, then `nyxos restart`. `nyxos update` rewrites these files. |
| Server mode | `.env` next to the compose file (see [server mode](server-mode.md)) or `environment:` in `infra/docker-compose.yml` |
| Development | In front of the command, see [CONTRIBUTING.md](../CONTRIBUTING.md) |

## Installation and `nyxos` command

| Variable | Default | Meaning |
|---|---|---|
| ★ `NYXOS_HOME` | `~/.nyxos` | Folder for everything NyxOS stores (app, runtime, data, logs). |
| ★ `NYXOS_PORT` | `47800` | Port of the local server. Saved in `~/.nyxos/nyxos.json` by `nyxos setup`; the environment wins. |
| `NYXOS_VERSION` | latest | Installer: install this version. (Server: overrides the displayed version.) |
| `NYXOS_TARBALL` | — | Installer: install from this local release file instead of downloading. |
| `NYXOS_NO_BROWSER` | — | `1` = never open a browser; print the sign-in link instead. |
| `NYXOS_SKIP_TMUX` | — | `1` = the installer does not install tmux. |
| `NYXOS_REPO` | from `package.json` | GitHub repository (`owner/name`) for downloads and updates. |
| `NYXOS_NODE` | `~/.nyxos/runtime/node/bin/node` | Node.js binary used by the command and services. |
| `NYXOS_LANG` | system language | Language of the command and installer: `de…` = German, anything else = English. Falls back to `LC_ALL`, `LC_MESSAGES`, `LANG`. |
| `NYXOS_DEMO_PORT` | server port + 2 (`47802`) | Preferred port of the demo (`nyxos demo` and "See the demo" in the onboarding). If it is taken, the demo uses another free port. |

## Local server

Set automatically by the service; listed for completeness.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `47800` (demo: `47802`) | Listening port (always on `127.0.0.1`). |
| `NYXOS_DATA_DIR` | `$NYXOS_HOME/data` | Database, archive and key files. |
| `NYXOS_DEMO` | — | `1` = demo instance with invented data: look-only (every write except browsing and the Nyx chat answers `403 demo_readonly`), no background AI runs, no Telegram, no update checks. |
| `NYXOS_DEMO_NYX` | auto | Nyx in the demo: `ai` = the signed-in Claude program of this computer (read-only tools), `scripted` = prepared answers. Default: `ai` if `claude auth status` reports a sign-in, else `scripted`. |
| `NYXOS_DEMO_HOME_URL` | — | Demo started from the onboarding: the user's own installation ("Jetzt einrichten" goes back there). Unset for `nyxos demo`. |
| `NYXOS_DEMO_IDLE_MINUTES` / `NYXOS_DEMO_PARENT_PID` | — | Set by the local instance for its demo: quit after this many idle minutes / when that process is gone. |
| `NYXOS_CLI` | `$NYXOS_HOME/bin/nyxos` | Path of the `nyxos` command, used to install updates. |
| `NYXOS_MIGRATIONS_DIR` | next to the server | Folder with the SQL migrations. |
| `WEB_DIR` | next to the server | Folder with the built web app. |
| `NYXOS_SECRETS_KEY` | from `data/secrets.key` | 32-byte key (base64) for encrypted secrets. Generated on first start in local mode. |
| `NYXOS_AUTH_READS` | `1` | `1` = reading also requires sign-in. Keep it on. |
| `NYXOS_ALLOW_PRIVATE_URLS` | `1` | `1` = the server may call addresses on your own machine/network (needed for Ollama, LM Studio and the bridge). |
| `NYXOS_HAIKU_SCHEDULER` | on | `0` = no scheduled Nyx runs (briefing, recap, background checks). |

## Server mode

| Variable | Default | Meaning |
|---|---|---|
| ★ `DATABASE_URL` | — (required) | Postgres connection, e.g. `postgres://nyxos:…@db:5432/nyxos`. |
| ★ `NYXOS_SECRETS_KEY` | — | 32 random bytes, base64 (`openssl rand -base64 32`). Required to store API keys and tokens. Keep a copy: without it, stored secrets cannot be read. |
| `ARCHIVE_DIR` | `/archive` | Transcript archive (a volume). |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listening address inside the container. |
| ★ `NYXOS_ALLOWED_HOSTS` | — | Extra host names allowed in the `Host` header, comma-separated (e.g. your Tailscale name, with and without port). Requires `NYXOS_AUTH_READS=1`, otherwise the server refuses to start. |
| ★ `NYXOS_AUTH_READS` | — | Set to `1` in server mode. |
| `NYXOS_ALLOW_PRIVATE_URLS` | off | `1` = allow the server to fetch private network addresses. |
| `NYXOS_HAIKU_REMOTE` | `0` | `1` = Nyx's Claude runs happen in the separate `agent` container. |
| `NYXOS_HAIKU_TOKEN_SET` | — | `1` = a Claude token is configured for the agent container (only for the status display). |
| `NYXOS_WORKER_TOKEN` | — | Shared secret between the API and the `agent` container. |
| `NYXOS_SELF_URL` | `http://127.0.0.1:$PORT` | Address under which Nyx's tools reach the API. |
| `NYXOS_DOCKER_PROXY_URL` | `http://socket-proxy:2375` | Read-only Docker socket proxy for the Server tab. |
| `NYXOS_DOZZLE_INTERNAL_URL` / `NYXOS_DOZZLE_URL` | — | Internal Dozzle address / link shown in the UI (Dozzle is served behind NyxOS's sign-in). |
| `NTFY_BASE_URL` | `http://127.0.0.1:2586` | ntfy server for push notifications. |
| `NTFY_PUBLIC_URL` | — | ntfy address as your phone reaches it (e.g. via Tailscale). |
| `NTFY_TOKEN` | — | Access token for ntfy, if required. |
| `NYXOS_NYX_VOICE_URL` | — | Address of the `nyx-voice` container, e.g. `http://nyx-voice:8090`. |
| `NYXOS_HOSTFS_ROOTS` | — | Read-only folders for the Server tab's file browser: `id:containerPath:hostPath`, comma-separated. |
| `NYXOS_HOST_OS_RELEASE`, `NYXOS_HOST_HOSTNAME`, `NYXOS_HOST_SYS` | `/etc/os-release`, —, `/sys` | Where the container finds host information. |
| `NYXOS_HOST_PROBE_HOST` | — | A host name the Server tab checks for reachability. |
| `NYXOS_SERVER_SSH_HOST` | — | SSH host (e.g. an alias from `~/.ssh/config`) for the Server tab's shell. |
| `NYXOS_REVISION`, `NYXOS_REVISION_FILE` | — | Revision shown for the running build. |

## Nyx and AI access

Usually configured in **Settings**; these variables override or pre-set it.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Path of the Claude Code command Nyx uses. |
| `NYXOS_HAIKU_MODEL` | `haiku` | Model Nyx uses through the `claude` command. |
| `NYXOS_HAIKU_HOME` | temp folder | Separate home folder for Nyx's `claude` runs. |
| `NYXOS_HAIKU_CONCURRENCY` | `1` | Parallel Nyx runs. |
| `NYXOS_HAIKU_CHAT_THINKING` | on | `0` = no extended thinking in chat replies (faster). |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Token from `claude setup-token`, for headless servers. |
| `ANTHROPIC_API_KEY` | — | Anthropic API key picked up by the `claude` command. |
| `NYXOS_HAIKU_API_KEY`, `NYXOS_HAIKU_API_BASE_URL`, `NYXOS_HAIKU_API_MODEL` | — | Fallback engine: an Anthropic-compatible Messages API reached with an API key (off without a key). |
| `NYXOS_HAIKU_API_PRICE_IN`, `NYXOS_HAIKU_API_PRICE_OUT` | `0` | Price per million input/output tokens for that API (usage display). |
| `NYXOS_WORKER_MODEL` | `claude-opus-5-5` | Model for sessions Nyx starts to work on tasks. |
| `NYXOS_CRITIC_MODEL` | `sonnet` | Model for the independent review of that work. |
| `NYXOS_PROJECT_ROOT` | — | Main project folder for tasks Nyx starts. |
| `NYXOS_DECISIONS_ROOT` | `NYXOS_PROJECT_ROOT` | Folder where decision files are written. |
| `NYXOS_IMPORT_ROOT` | — | Folder from which task, audit and idea files may be imported. |
| `NYXOS_TELEGRAM_MINIAPP_URL` | — | Public HTTPS address of the Telegram mini app, if you use one. |
| `NYXOS_IDEALINK_BASE_URL`, `NYXOS_IDEALINK_HOSTS` | request origin, — | Public base address and extra allowed hosts for shareable idea links. |

## Voice

| Variable | Default | Meaning |
|---|---|---|
| `WHISPER_BIN` | `/opt/homebrew/bin/whisper-cli` | whisper.cpp binary for speech recognition. |
| `WHISPER_MODEL_PATH` | — | whisper.cpp model file. |
| `WHISPER_PROMPT` | built-in | Initial prompt that helps whisper with technical terms. |
| `FFMPEG_BIN` | `/opt/homebrew/bin/ffmpeg` | ffmpeg for audio conversion. |

| `NYXOS_VOICE_PORT` | server port + 3 (`47803`) | Local mode: preferred port of the voice pack's service (always on `127.0.0.1`). If it is taken, a free one is used. |

The `nyx-voice` container has its own `NYX_*` variables — see [server mode](server-mode.md#voice). The local
voice pack ([Voice](guide.md#voice)) sets them itself; it needs no configuration.

## Bridge and shell

| Variable | Default | Meaning |
|---|---|---|
| `NYXOS_TMUX` | `1` | `0` in a shell = `claude` / `codex` start without tmux (no terminal view in NyxOS). |
| `NYXOS_GIT_CATCHUP_APPLY` | off | `1` = the bridge may apply clean catch-up merges of idle worktrees automatically. Off by default: it only suggests them. |
| `NYXOS_SERVER_URL`, `NYXOS_MACHINE_TOKEN` | from bridge config | Override server address and token for the guard hook. |
| `XDG_CONFIG_HOME` | `~/.config` | Linux: where systemd user units are written. |

Variables such as `NYXOS_BRIDGE_CONFIG`, `NYXOS_MCP_SESSION_KEY`, `NYXOS_HAIKU_RUN_TOKEN`, `NYXOS_API_URL`,
`NYXOS_TMUX_NAME`, `NYXOS_WORKTREE` and `NYXOS_AUFTRAG` are set internally for child processes. Do not set
them yourself.

## Development and tests

| Variable | Used by | Meaning |
|---|---|---|
| `NYXOS_API` | Vite dev server | Proxy target for `/api`, `/health`, `/live` (default `http://127.0.0.1:47890`). |
| `PGLITE_DIR`, `ARCHIVE_DIR` | `apps/server/src/dev.ts` | Database and archive folder of the development server. |
| `PROBE_PORT`, `PROBE_TMUX_SOCKET` | `pnpm dev` | Port and tmux socket of the development stack. |
| `NYXOS_CONTEXT_GUARD_TEST_PCT` | server | Fakes a context usage percentage to test the context guard. |
| `NYXOS_DIGEST_MIN_INTERVAL_MS` | server | Minimum interval between session digests. |
