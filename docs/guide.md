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

- **General** — sign-in (passkeys for other devices), the Nyx side bar, connection checks, access to AI
  accounts, models and providers, connectors, Telegram, context guard, session states, push notifications,
  usage goals, night mode and the **learning book**.
- **Nyx** — personality, profile, voice and what Nyx may do.
- **Info & Help** — version, language, automatic updates, where your data lives, links to this documentation.

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
