# Server mode

By default NyxOS runs entirely on your computer (local mode). **Server mode** runs the server part on a machine
of your own — a home server or a rented VPS — with Docker Compose. Your computer keeps only the bridge, which
connects to the server through an SSH tunnel or Tailscale.

Choose server mode if you want NyxOS to keep running (briefings, night mode, Telegram) while your laptop
sleeps, or to open it from several devices. Otherwise local mode is simpler.

```
 your computer                                  your server (Docker Compose, infra/)
 ┌─────────────────────┐   SSH tunnel or       ┌──────────────────────────────────────────────┐
 │ bridge              │   Tailscale           │ api (server + web app)  ── Postgres 17       │
 │ (hooks, watcher,    │ ────────────────────▶ │  │                                            │
 │  tmux terminals)    │                       │  ├─ agent      (optional: Nyx's Claude runs)  │
 └─────────────────────┘                       │  ├─ nyx-voice  (optional: speech in/out)      │
 browser ── http://127.0.0.1:47801 (tunnel) ─▶ │  ├─ ntfy       (optional: push to your phone) │
                                               │  └─ socket-proxy + dozzle (optional: logs)    │
                                               └──────────────────────────────────────────────┘
```

## What you need

- A Linux server with Docker and Docker Compose v2, about 1 GB RAM for NyxOS itself (6 GB more if you run the
  voice container).
- SSH access with a key, or Tailscale on both machines.
- NyxOS installed on your computer (for the bridge): see [getting started](getting-started.md).

Nothing in `infra/` publishes a port to the internet. The API is bound to `127.0.0.1` on the server; you reach
it through the tunnel or Tailscale.

## 1. Configure

On the server:

```bash
git clone https://github.com/VariadAgency/NyxOs---Agentic-OS.git
cd nyxos
cp infra/.env.example infra/.env
chmod 600 infra/.env
```

Fill in `infra/.env`. The example file explains every entry; the important ones:

| Variable | What to put in |
|---|---|
| Database password | A long random password (`openssl rand -base64 24`). |
| `NYXOS_SECRETS_KEY` | `openssl rand -base64 32`. **Back it up** — without it, stored API keys and tokens cannot be read. |
| `NYXOS_AUTH_READS` | `1` (keep it). |
| `NYXOS_ALLOWED_HOSTS` | Only for Tailscale: your server's Tailscale name, e.g. `nyxos.example-tailnet.ts.net`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional, for the `agent` container: run `claude setup-token` on a machine with Claude Code and paste the token. |
| `NYXOS_WORKER_TOKEN` | Optional, for the `agent` container: `openssl rand -hex 32`. |
| `NTFY_PUBLIC_URL` | Optional: the ntfy address as your phone reaches it (e.g. via Tailscale). |

All variables are listed in [configuration](configuration.md#server-mode).

## 2. Start

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

This builds the `api` image (server and web app in one container) and starts it with its database. Check it:

```bash
docker compose -f infra/docker-compose.yml ps
curl -s http://127.0.0.1:47800/health     # on the server
```

`/health` answers `200` only when the database answers, the schema is current and the archive volume is
writable.

## 3. Sign in with a passkey

Server mode signs you in with **passkeys** (Touch ID, Face ID, Windows Hello, a security key or your phone).

```bash
docker compose -f infra/docker-compose.yml exec api node dist/cli.js passkey-setup
```

This prints a one-time setup code (valid for 15 minutes). Open NyxOS in the browser (next step); the sign-in dialog
asks for the code and then creates the passkey. Repeat for every further device.

Lost your device? `node dist/cli.js passkey-reset` removes all passkeys and sessions; then set up a new one.

> Passkeys need a secure context: `http://127.0.0.1` (through the SSH tunnel) or HTTPS (for example with
> `tailscale serve`). A plain `http://` address on your network does not work.

## 4. Connect the bridge

The bridge on your computer needs a **machine token** from the server:

```bash
# on the server — prints the token once
docker compose -f infra/docker-compose.yml exec api node dist/cli.js add-machine my-laptop
```

On your computer, save it to a file only you can read:

```bash
umask 077 && pbpaste > ~/.nyxos/server-token    # macOS; on Linux paste into the file with an editor
```

Then point the bridge at the server. The local server is not needed any more — switch it off first:

```bash
# macOS
launchctl bootout gui/$(id -u)/app.nyxos.server
# Linux
systemctl --user disable --now nyxos-server.service
```

### Option A: SSH tunnel

You need an SSH host alias with key login in `~/.ssh/config` (here `my-server`). The bridge keeps the tunnel
open itself and reconnects when it drops:

```bash
~/.nyxos/runtime/node/bin/node ~/.nyxos/app/current/bridge/bridge.js install \
  --server-url http://127.0.0.1:47801 \
  --token-file ~/.nyxos/server-token \
  --tunnel-host my-server \
  --local-port 47801 --remote-port 47800
```

Open NyxOS at **<http://127.0.0.1:47801>**.

> Use SSH connection sharing (`ControlMaster auto`, `ControlPersist`) in `~/.ssh/config`. Many parallel SSH
> logins can make fail2ban-style protection on the server block your IP.

### Option B: Tailscale

Make the API reachable in your tailnet with HTTPS, for example on the server:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:47800
```

Set `NYXOS_ALLOWED_HOSTS=<server>.<tailnet>.ts.net` and `NYXOS_AUTH_READS=1` in `.env`, restart the stack, then
on your computer:

```bash
~/.nyxos/runtime/node/bin/node ~/.nyxos/app/current/bridge/bridge.js install \
  --server-url https://<server>.<tailnet>.ts.net \
  --token-file ~/.nyxos/server-token
```

Open NyxOS at `https://<server>.<tailnet>.ts.net`.

### Reaching NyxOS from your phone

**Settings → Operation & access** builds the commands for you: fill in your server's Tailscale name (or a
Cloudflare Tunnel host name, or your own domain) and copy the steps — `tailscale serve`, `NYXOS_ALLOWED_HOSTS` +
`NYXOS_AUTH_READS=1` in `infra/.env` (with a backup copy), restart, then a passkey for the new address (Settings →
Account & sign-in → „Create code“, a passkey only works for the address it was created at). „Check“ asks
`<address>/health` from the server; a Tailscale name the server itself cannot resolve shows „not confirmed yet“
until you open the address on your phone — that visit is the proof NyxOS remembers.

The same works in **local mode**: `tailscale serve --bg --https=443 http://127.0.0.1:<port>` on your computer,
the address added to `NYXOS_ALLOWED_HOSTS` of the local service (macOS: the launchd plist, rewritten by
`nyxos update`; Linux: a systemd drop-in next to `nyxos-server.service`), `nyxos restart`, and a one-time
sign-in link for the phone from `NYXOS_NO_BROWSER=1 nyxos open` with `http://127.0.0.1:<port>` replaced by your
tailnet address (local mode has no passkeys).

> `nyxos update` and `nyxos setup` configure the bridge for local mode again. In server mode, update the
> server with Git + Docker Compose (below) and re-run the bridge `install` command after updating NyxOS on your
> computer.

## Optional containers

### Agent (Nyx's Claude runs)

The `api` image has no `claude` command. For Nyx to use your Claude account on the server, start the `agent`
container — it runs the official Claude Code CLI, has no database access and no Docker socket, and only talks
to the API over the internal network:

```bash
docker compose -f infra/docker-compose.yml --profile agent up -d --build
```

It needs `CLAUDE_CODE_OAUTH_TOKEN` and `NYXOS_WORKER_TOKEN` in `.env`. Without it, use an API key or another
provider under **Settings → General** instead.

### Voice

The `nyx-voice` container (Python, CPU only) turns speech into text (NVIDIA Parakeet) and text into speech
(Kyutai Pocket TTS and Piper voices through sherpa-onnx), in German and English. It has no host port; only the
API talks to it.

```bash
docker compose -f infra/docker-compose.yml --profile voice up -d --build nyx-voice
```

The first start downloads about 1.7 GB of models into a volume (never into the image). Plan for up to 4 CPU
cores and 6 GB RAM. Useful settings in `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `NYX_TTS_VOICES` | all | Which voices to load (fewer voices = less RAM). |
| `NYX_TTS_DEFAULT` | first in the list | German default voice. |
| `NYX_TTS_DEFAULT_EN` | `pocket-en-george` | English default voice. |
| `NYX_LANGUAGE` | `auto` | Recognition language: `auto`, `de` or `en`. |
| `NYX_LEXICON` | `all` | Pronunciation dictionary: `all`, `piper` or `off`. |
| `NYX_MAX_DEFAULT_RTF` | `0.4` | If the default voice is slower than this real-time factor, a faster voice takes over. |
| `NYX_POCKET_DECODE_STEPS` | code default | `1` = faster, slightly rougher Pocket voice. |

Model licenses are listed in [NOTICE](../NOTICE).

### Push notifications (ntfy)

A small [ntfy](https://ntfy.sh) server lets NyxOS send approvals, finished night runs and briefings to your
phone. Access is token-protected (`deny-all` by default). Set `NTFY_PUBLIC_URL` to the address your phone
reaches (Tailscale), then subscribe under **Settings → Notifications → Advanced → Set up the phone** (server
address and secret topic to copy, or a QR code to scan with the phone camera). iOS delivery goes through the
ntfy.sh upstream; your messages stay on your server. When and how the phone is notified (per occasion, style,
Nyx checks/writes, quiet hours) is set on the same page – see the [guide](guide.md#notifications).

### Container logs (Dozzle)

`socket-proxy` gives read-only access to the Docker API (no exec, no start/stop, no file access), and
[Dozzle](https://dozzle.dev) shows live container logs. Dozzle has no port of its own — NyxOS serves it under
`/dozzle/` behind its own sign-in. Both appear in the **Server** tab.

Don't need ntfy or Dozzle? Remove their services (and the matching `NTFY_*` / `NYXOS_DOZZLE_*` /
`NYXOS_DOCKER_PROXY_URL` lines) from your copy of `infra/docker-compose.yml`.

## Updating

```bash
git pull
docker compose -f infra/docker-compose.yml up -d --build
```

Back up the database before larger updates (`docker compose … exec <database service> pg_dump …`) — NyxOS's
migrations are additive, so an older image still runs against a newer schema. The API container applies new
migrations from `apps/server/drizzle/` itself when it starts; `/health` reports the `schema` check.

## Hardening checklist

- Keep the published API port on `127.0.0.1`; never expose `47800` publicly.
- Keep `NYXOS_AUTH_READS=1`. The server refuses to start with `NYXOS_ALLOWED_HOSTS` but without it.
- `.env` mode `600`; back up `NYXOS_SECRETS_KEY` somewhere safe.
- Containers run read-only, without capabilities and with `no-new-privileges`; keep it that way when you edit
  the compose file.
- Give the NyxOS database role rights on the NyxOS database only.
