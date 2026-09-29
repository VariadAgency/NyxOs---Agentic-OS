# Security policy

NyxOS sees your AI sessions, transcripts, code and API keys, so we take security reports seriously.

## Supported versions

Only the **latest release** gets security fixes. NyxOS updates itself (Settings → Info & Help → automatic
updates) or with `nyxos update`.

| Version | Supported |
|---|---|
| latest 0.x release | ✅ |
| older releases | ❌ — please update |

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:

1. Go to <https://github.com/VariadAgency/NyxOs---Agentic-OS/security/advisories/new>
   (repository → **Security** → **Report a vulnerability**).
2. Describe the problem, the affected version (`nyxos version`), how to reproduce it and what an attacker could
   achieve. A proof of concept helps.
3. Do not include real secrets or private transcripts — use made-up data.

What happens next:

- We confirm receipt within **5 days**.
- We assess the report and keep you updated in the advisory.
- We aim to ship a fix within **30 days** for serious issues, then publish the advisory. We credit you unless
  you prefer to stay anonymous.

## Scope

In scope:

- the server, web app, bridge and `nyxos` command in this repository,
- `install.sh` and the update mechanism (download, checksum, switch),
- the Docker Compose setup in `infra/`,
- anything that lets another local user, a website in your browser, a malicious transcript or a prompt
  injection read your data, run commands or bypass the approval list.

Out of scope:

- vulnerabilities in Claude Code, Codex, AI providers or other third-party software (report them upstream),
- attacks that require an attacker who already has your user account or root on your computer,
- running NyxOS with protections deliberately switched off (for example `NYXOS_ALLOWED_HOSTS` exposed to
  the internet without a reverse proxy and TLS).

## How NyxOS protects your data

| Measure | What it means |
|---|---|
| **Local only** | In local mode the server listens on `127.0.0.1` only. Nothing is reachable from the network. |
| **Host allow-list** | Requests with a foreign `Host` header are rejected (protection against DNS rebinding). |
| **Sign-in for everything** | Reading and writing both need a sign-in cookie (`HttpOnly`, `SameSite=Strict`); writes also need a CSRF token. Other users of the same computer cannot read your sessions. |
| **One-time sign-in links** | `nyxos open` creates a link that works once and expires after 2 minutes. |
| **Passkeys** | Other devices and server mode use passkeys (WebAuthn) set up with a one-time code. |
| **Machine token** | The bridge and the CLI use a random token stored in a file only you can read (mode 0600); the server keeps only its hash. |
| **Encrypted secrets** | API keys and tokens are encrypted with AES-256-GCM; the key is `~/.nyxos/data/secrets.key` (0600). The interface only ever shows the last four characters. |
| **No secrets in logs** | Logs contain events and errors, never transcript content, keys or tokens. |
| **Verified updates** | Releases and the Node.js runtime are checked against SHA-256 sums before they are used. |
| **Nyx's limits** | Risky actions need a confirmation card you click. Sign-in, passkeys and keys are not reachable through Nyx's tools. External text (transcripts, web pages, Telegram) is fenced as data, never followed as instructions. |
| **Approvals** | A guard hook stops push, merge into main, deploy, migrations, deleting outside a worktree and closing sessions until you approve that exact command. |
| **Additive hooks** | NyxOS only appends to `~/.claude/settings.json` and `~/.codex/hooks.json`, makes a backup first, and removes only its own entries. |
| **No telemetry** | NyxOS sends nothing home. Network traffic goes only to the AI provider you configured, GitHub (update check) and services you enable yourself (Telegram, push). |
| **No framing** | Only NyxOS itself may show its pages in a frame, so another page cannot trick you into clicking NyxOS buttons. |
| **Private folder** | The installer makes `~/.nyxos` readable only for you (0700). |

## Threat model in plain words

**What NyxOS can do on your computer.** It reads the transcripts of your Claude Code and Codex sessions, starts
and types into sessions in tmux, opens a terminal in the browser, reads and writes text files in your project
folders, runs git and build commands there, adds hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`,
and updates itself from GitHub. Anyone who controls NyxOS can therefore run commands as you.

**Who it keeps out.**

- *Websites in your browser:* the server only listens on `127.0.0.1`, rejects foreign host names (DNS
  rebinding), sends no CORS headers, needs a `SameSite=Strict` cookie plus a CSRF token for every change, and
  the terminal and live channels only accept the exact NyxOS origin. Pages cannot be framed.
- *Other programs and users on the network:* nothing is reachable from outside your computer in local mode.
- *Other user accounts on the same computer:* reading needs the sign-in too, and the keys and the machine token
  sit in files only your account can read.
- *Text from outside* (transcripts, web pages, Telegram, idea links): Nyx treats it as data. Actions that run
  code on their own (an autonomous task), write files on your computer, change the setup, delete things or
  decide approvals wait for your click on a confirmation card. Sign-in, passkeys and keys are out of Nyx's reach.

**What it does not protect against.**

- *Programs running under your own account* — including your AI sessions. They can read `~/.nyxos` like you
  can. The approval guard is a safety net against mistakes of an agent, not a wall against code that is
  determined to get around it.
- *A compromised release.* Updates are checked against the SHA-256 sums published with the same GitHub release.
  That catches broken downloads, not a release published by someone who took over the repository. If you want
  to review every update first, switch off automatic updates (Settings → Info & Help).
- *Server mode exposed without care.* Put it behind SSH or a private network such as Tailscale, with
  `NYXOS_AUTH_READS=1`; never publish its port to the internet.
