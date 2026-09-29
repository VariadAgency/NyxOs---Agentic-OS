# Guide

A short tour of NyxOS, tab by tab, in the order of the sidebar. Every page reads from top to bottom, every
card can be opened into a large view, and related items link to each other (a task to its sessions, a session
to its commits, and so on).

Press **⌘K / Ctrl+K** anywhere to open the command palette and jump to any page, session or task.

---

## Nyx

The full-screen home of the assistant: an animated network that reacts while Nyx listens, thinks and speaks,
with voice input and a panel on the right for **chat**, **context** (what Nyx is looking at), **images**,
**memory** (what Nyx has learned about you), **tasks** and **settings**.

Nyx is also always one click away in the side bar on every page. See [Nyx in detail](#nyx-in-detail) below.

## Briefing

Nyx's morning briefing and evening recap as a readable report: a key message, what changed, what needs you,
and figures such as active sessions, commits, open tasks, usage and conflicts, with small charts. All numbers
come from your data; Nyx only writes the text around them. You can ask for a fresh briefing at any time.

## Decisions

Your inbox for everything that waits on you:

- **Decisions** — open questions from tasks, audits and sessions, with Nyx's summary and suggested answer.
- **Approvals** — when a session wants to do something on the approval list (git push, merge into main,
  deploy, database migration, deleting outside a worktree, closing a session for good), NyxOS's guard hook
  pauses it and asks here. An approval always covers exactly one command.

The number next to the sidebar entry shows how many items are open.

## Overview

The dashboard: tiles with trends (sessions, commits, tasks, usage), **critical sessions** (stuck, waiting
for input, running out of context), what happened **since your last visit**, and what needs you.

## Sessions

Every Claude Code and Codex session, live and archived. Filter by state (for example running or idle),
kind, workstream, project or tool, and search the full text of all transcripts.

Open a session for its **chat**, **terminal** (tmux; type into it from the browser), **changed files** with
diffs, **subagents**, and panels such as costs and context usage. From here you can also start a new session
in a project folder, continue one or hand it to Nyx.

Sessions are sorted automatically into a **kind** (coding, audit, planning, ideas, research, server,
unsorted) and a **workstream**. Correct a guess and NyxOS writes a rule into the learning book.

### Agents in a session

When a session starts subagents (Claude Code) or teammates (Codex child sessions such as "Locke: …"), a bar
appears at the bottom of its chat and below its terminal: "● 2 agents active · 1 done", one colored dot per
agent. It updates live.

- **Click the bar** for a popup in the chat window (a sheet from the bottom on the phone). *This run* lists the
  active agents and the ones that finished since your last message to the session; *Archive* lists earlier runs,
  each with the time and the message that started it. Every row shows the elapsed time (ticking), tokens and —
  when a price is stored for the model — the cost. Esc or a click outside closes it.
- **Click an agent** to see what it is doing right now (latest steps, newest on top, the current one marked),
  its task, its result when done, and its transcript (read only). *Add to tasks* creates a task with task and
  result (a second click shows the same task). Agents from earlier runs can be **hidden** in the archive and shown
  again at any time; nothing is deleted. A Codex teammate can be opened as its own session.
- **Full screen**: the *Full screen* button in the popup (suggested from six active agents on) opens
  `/sessions/<kind>/<workstream>/<session>/agenten`, with "← Back to the chat".
- A **run** is one round of the session: it starts with a message you send. An agent belongs to the run of the
  last message before it started; running agents are always shown on top.
- **Status**: *running* (the session is alive, no report yet, not silent for too long), *done* (report, final
  answer, verdict or the `SubagentStop` hook) or *no result*.
- **Tokens** come live from the transcript of each subagent (`~/.claude/projects/<project>/<session>/subagents/`,
  the same path on macOS and Linux). Older runs without live numbers use the archive evaluation; "—" means no
  number is known yet.
- A single agent **cannot be stopped** — Claude Code has no interface for that. Esc in the terminal stops the
  whole session's current round.

## Brain

A knowledge graph of your work: sessions, subagents, workstreams, tasks and — if connected — the notes of your
Obsidian vault with their links. Switch between 2D and 3D, zoom from the big picture down to a single node,
and click a node to open it.

## Tasks

Tasks, bugs, audits, questions and problems in one place, grouped by project and stage:
**planned → ready → running → review → done**.

Only the **readiness check** moves a task to **ready** — never a person or an agent by hand. It checks six
points: goal and acceptance criteria are written down, the affected file area is known, no decision is still
open, predecessor tasks are accepted, no conflict with running sessions, and the budget fits. Ready tasks can
be started as a session with one click — or picked up by the night mode.

## Agents

Your Claude Code agents with their tools, model and recent runs, as tiles. Shows which agents are busy and
links to the skills library.

## Skills

Your Claude Code skills as a library: content, usage (how often, how often it failed or was cancelled),
history with a diff view, and files. NyxOS suggests improvements from usage signals — it never changes a skill
on its own; you approve every change. Pin a skill to keep it out of suggestions.

## Conflicts

A collision map: which sessions read and write which files right now. When two live sessions change the same
file, NyxOS flags it. **Reservations** let you claim a path (for example `src/auth/**`) for one session so
others are warned.

## Git

For every repository in your project folders: **uncommitted changes**, **branches**, **worktrees** (including
which session works in which), **commits** with a heatmap, and how far each branch is ahead or behind.

## Server

The machine NyxOS runs on: load, memory, disks, uptime and open ports, plus a read-only file browser and a
terminal. In [server mode](server-mode.md) you also see Docker containers and their live logs (Dozzle).

## Usage

Tokens and costs of Claude Code and Codex per day, week, model and project, compared with the previous period.
Set **goals** (for example a weekly budget) and see how you are doing. Prices follow the public price lists of
the providers.

## Ideas

A lightweight inbox for ideas with its own stages: **inbox → in clarification → concept ready**. Nyx can help
sharpen an idea; when it is ready, move it into **Tasks** with one click.

## Audits

Audit reports from your sessions (code reviews, security checks, …) as entries with findings, severity and
status, with a detail view and links to the sessions and tasks they came from.

## Files

A Finder-style browser for your project folders: a tree, a Markdown reader, and a code editor with syntax
highlighting for quick edits.

## Settings

Settings is a calm list like the iPhone settings: a search field on top, below one column of areas, each with a
one-line summary or state („3 of 14 set up“, „All connected“). A tap opens the area's own page with „‹ Settings“
to go back; rarely needed things sit behind **Advanced**.

- **General** — *Account & sign-in* (in local mode only „signed in / sign out“; passkeys and setup codes for more
  devices in server mode) · *Notifications* (when, how written, Nyx, channels, history, Telegram) · *Sessions* (states, context
  guard, throwaway chats) · *Usage & night mode* · *Learned rules* · *Idea links* · *Models & connectors* ·
  *Operation & access* (where NyxOS runs and how to reach it from the phone, see below; every connection,
  actually checked) · *Credentials & keys* · *Info & Help* ·
  *Feedback & support*.
- **Nyx** — an overview with a preview „How Nyx talks“, then *Personality*, *About you*, *Voice*, *Companion*,
  *Access & approvals* (what Nyx does directly, only after your „Run“, never) and *Engine & usage*.
- **Info & Help** — version, language, automatic updates, where your data lives, links to this documentation.

The search finds areas and single settings in your language („quiet hours“, „passkey“, „voice“) and jumps right
to the spot: `/` focuses it, ↑/↓ choose, Enter opens. ⌘K knows every settings page too. Old links such as
`/settings#push` or `/einstellungen/haiku` still work and lead to the new page.

### Notifications

Every notification – a session waiting for you, a session done or crashed, an approval, a red build, a failed
deploy, the context guard, a usage warning, a finished night run, a new bug, a finished task – goes through one
chain, and the page **Settings → Notifications** asks four questions from top to bottom:

- **When?** Per occasion *Always* · *When away* (no active NyxOS window for a few minutes) · *Never*.
  *Never notify about sub-agents* (on by default) keeps helpers a session starts itself (e.g. Codex workers) quiet –
  only the main session is reported. Approvals, crashes and build errors always come.
- **How written?** *Short* · *With context* (default) · *Detailed*, with a live preview „How it arrives“. The name
  is the session title or the workstream, never the raw prompt. Own templates per occasion with placeholders
  (`{session}`, `{baustelle}`, `{was}`, `{wann}`, `{details}`) sit under *Advanced*.
- **Nyx** can check every notification first (send · leave out · bundle with the next one, with a short reason;
  „What matters to me“ and your feedback are part of the check) and can write the text from the session's last
  steps – numbers and names only from the data, otherwise the template stays. Both use your own model (Models &
  connectors), count towards Nyx' budget and give up after 8 seconds; urgent ones (deploy failed) always get
  through. Without a model the page says so and notifications go out without Nyx.
- **Channels** – your computer (through the bridge), the browser, the phone (ntfy app) and Telegram, with a test
  button. While you're away the phone gets one digest instead of every single message; urgent ones, approvals,
  crashes and usage warnings come at once.

**Focus.** A small button at the bottom left of the side bar (on the phone at the bottom of the „More“ drawer) and
the top row of this page set how NyxOS reaches you right now: *Automatic* (as above), *I'm away* (counts as away
even with NyxOS open – computer and browser stay silent, the phone gets the digest, urgent ones at once, Telegram
questions) or *Do not disturb* (nothing on computer and browser; on the phone only approvals, crashes, a failed
deploy and urgent ones – everything else is in the history as „Focus – silenced“). Choose *1 hour*, *until this
evening* (19:00; from 18:00 *until tomorrow morning*, 08:00) or *until I turn it off*, on your wall clock; after
that NyxOS switches back to *Automatic* by itself. Nyx can set it too („I'm away until 6 pm“).

The **history** shows the last 50 notifications with what happened and why (sent, quiet hours, left out by Nyx,
sub-agent, duplicate, minimum gap, focus …). „Good“ / „Don't need it“ teach Nyx; after two „Don't need it“ for the same
occasion NyxOS suggests a stricter rule („Context guard only when I'm away?“). *Advanced* holds quiet hours (one
for everything, on your wall clock – the time zone set in NyxOS, else your computer's), „session waiting“ delay, minimum gap per session, merging, away detection, own templates, the
phone setup (server address, secret topic, QR code) and the click address.

### Operation & access

Settings → *Operation & access* starts with **how NyxOS runs right now**, as the server reports it: on this
computer (with its port) or on your server, the allowed addresses, whether the bridge is connected, whether
reading needs a sign-in, and whether your phone reaches NyxOS — „reachable“ only after a successful check or a
real visit through that address, always with the time.

Below are the **three ways** NyxOS can run — *On this computer* (the local mode `nyxos` sets up; there it is the
current way, with `nyxos status`/`doctor` and the autostart switches of the real services), *Own server* and
*Rented server / provider* (Docker Compose from `infra/`, see [server mode](server-mode.md)) — and the **three
phone ways**: *Tailscale* (recommended, nothing public), *Cloudflare Tunnel* and *Own domain with HTTPS*. Each
card shows what you need, whether it runs all the time, the cost and the security, and a form. From the form you
get ready commands to copy (every value is quoted, tokens are never part of a command) and a **Check** button
that calls only `<address>/health`. In local mode the phone signs in with a one-time link: the Tailscale recipe
prints it with `NYXOS_NO_BROWSER=1 nyxos open` for your tailnet address (valid 2 minutes, once).
**Nyx hilft** opens Nyx with the filled-in form and the current state (never secrets); Nyx may read, check and
save the form, but never touch the tunnel token.

## On the phone

Below 768 px NyxOS works like an iPhone app: a **bottom bar** with Nyx · Sessions · Decisions (with a counter) ·
Overview · More (all other areas), a **search button** in the header instead of ⌘K, and dialogs that slide up
from the bottom. Sessions open as list → session with „‹ Sessions“; the terminal gets a **key row** above the
phone keyboard (Esc, Tab, ⇧Tab, Ctrl – locks for the next key –, ^C, arrows that repeat while held, /, Enter,
Paste, Copy, show keyboard), text size via A−/A+ or two-finger zoom. Copy and paste also work over plain
`http://` in your home network (fallbacks when the clipboard API is blocked). „Add to Home Screen“ gives an app
without browser bars; notch and home bar stay free.

## Feedback & support

The heart under "All connections" in the status line (also on the connections page, as its own area at the
bottom of Settings — Settings → Feedback & support — and in ⌘K: "Fehler melden", "Idee schicken", "Buy me Tokens") opens one sheet:

- **Report a bug** — what happened, what you did before, what you expected, an e-mail address if you want an
  answer, and optionally a screenshot (choose a file or paste it, at most 2 MB). "Attach diagnostics" adds the
  version, the mode, your system and browser, the area of the page and the last error lines; "Exactly this is
  sent along" shows the object before you send. Paths, names, addresses and keys are already removed.
- **Idea for the developer** — title, description and how important it is to you.
- **Buy me Tokens** — donate once or monthly to keep NyxOS alive. You pay inside NyxOS on a secured page of the
  project website.

While the project's support service is not set up yet (or cannot be reached), reports wait in the outbox ("2
reports are waiting …") and go out by themselves later. Nyx can open the sheet and prepare a draft, but only you
can send it.

---

## Nyx in detail

| What | How it works |
|---|---|
| **Briefing & recap** | In the morning Nyx summarizes where things stand and what needs you; in the evening what got done. Times are configurable. |
| **Chat** | Ask anything about your sessions, tasks, git or usage. Nyx looks things up itself instead of guessing and links what it refers to. |
| **Voice** (optional) | Talk to Nyx and hear the answer, in German and English. Runs on your computer after a one-click install (see [Voice](#voice) below); in server mode it is the optional voice container ([server mode](server-mode.md#voice)). ElevenLabs is an optional extra. |
| **Operates the UI** | Nyx can navigate, open items, fill fields and click for you — you see it happen. |
| **Confirmation cards** | Risky actions (delete, merge, push, deploy, migration, closing a session, answering an approval) are never clicked by Nyx. It points at the button and shows a card; you confirm. |
| **Learning book** | Rules NyxOS learned from your corrections — sorting, reservations, conflicts, approvals — each with where it came from and how often it applied. Switch rules off or delete them. |
| **Memory & profile** | A small, visible memory of facts about you and your projects. You can read and edit everything Nyx remembers. |
| **Night mode** | Within a time window (default 23:00–07:00) and a budget, Nyx works through tasks you approved as ready — one session at a time — and reports in the morning briefing. Push, merge, deploy and delete still wait for you. |
| **Telegram** (optional) | Pair your Telegram account with a one-time code to chat with Nyx, get notifications and answer approvals on the go. |

What Nyx can never do: see or change your sign-in, passkeys, tokens or API keys; approve its own actions; or
bypass the approval list.

---

## Voice

*(Stimme)* Nyx can listen to you and answer out loud — in **German and English**. Everything runs on your
computer; your voice is never uploaded. Voice is optional and not installed at first.

**Install:** Settings → Nyx → Voice → **Install voice**. That's it. (Same thing in the terminal:
`nyxos voice install`. The onboarding offers the same button.) It takes one to three minutes, then the voice
starts by itself and downloads its speech models once (about 0.7 GB). A progress bar shows each step. No admin
password, no Homebrew, no Python of your own is needed.

**Use:** hold the microphone button (or the space bar) and talk. Nyx answers in the language you speak; German
sentences get a German voice, English sentences an English one. If a short answer has no clear language, the
app language decides. You can listen to each voice and set the speed in Settings → Nyx → Voice.

**What gets installed** (all inside `~/.nyxos`, about 1 GB on disk):

| Where | What |
|---|---|
| `runtime/uv/` | [uv](https://github.com/astral-sh/uv), a small installer (fixed version, SHA-256 checked) |
| `voice/python/`, `voice/venv/` | a private Python 3.12 and the speech packages (every file SHA-256 pinned), incl. its own ffmpeg |
| `voice/models/` | speech recognition (NVIDIA Parakeet, 0.5 GB) and two voices: Thorsten (German) and Linda (English) |
| `logs/voice.log` | what the voice service writes |

The voice service runs next to NyxOS, only on `127.0.0.1`, with a fresh key on every start, and stops with
NyxOS. If it crashes, NyxOS starts it again.

**Check or remove:** `nyxos voice status` shows whether it runs; `nyxos doctor` lists it too. **Remove voice**
in the settings (or `nyxos voice remove`) deletes models, Python and packages. `nyxos uninstall` removes it as
well.

**Works on** macOS (Apple Silicon and Intel) and Linux x64/arm64 with glibc 2.28 or newer (e.g. Ubuntu 20.04+,
Debian 11+). Not on Alpine/musl. More voices (only ones with a checked free license) can be added in Settings →
Nyx → Voice → Import voice.
