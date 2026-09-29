#!/usr/bin/env bash
# NyxOS installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/VariadAgency/NyxOs---Agentic-OS/main/install.sh | bash
#
# What it does (no admin rights needed except for installing tmux via the system package manager):
#   1. downloads Node.js 24 into ~/.nyxos/runtime (does not touch a system Node)
#   2. installs tmux if it is missing (Homebrew on macOS, apt/dnf/pacman/zypper on Linux)
#   3. downloads the latest NyxOS release, checks its SHA-256 sum and unpacks it into ~/.nyxos/app
#   4. sets up the background services (launchd on macOS, systemd --user on Linux)
#   5. opens NyxOS in the browser, where the onboarding starts
#
# Options (environment variables):
#   NYXOS_HOME=~/.nyxos         where everything goes
#   NYXOS_VERSION=0.1.0         install a specific version instead of the latest
#   NYXOS_TARBALL=/path/x.tgz   install from a local release file (offline, testing)
#   NYXOS_NO_BROWSER=1          do not open the browser (prints the sign-in link)
#   NYXOS_SKIP_TMUX=1           do not install tmux
set -euo pipefail

# Everything runs inside main(), called on the last line: with `curl | bash` a download that breaks off
# half-way then runs nothing (instead of half a script), and commands that read stdin cannot eat the script.
main() {
REPO="${NYXOS_REPO:-VariadAgency/NyxOs---Agentic-OS}"
NODE_MAJOR=24
NYXOS_HOME="${NYXOS_HOME:-$HOME/.nyxos}"
export NYXOS_HOME

if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'; else BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""; fi
case "${LANG:-}${LC_ALL:-}" in de*|*de_*) DE=1 ;; *) DE=0 ;; esac
say() { if [ "$DE" = 1 ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$(say "$1" "$2")"; }
fail() { printf '%s%s%s %s\n' "$RED" "$(say "Fehler:" "Error:")" "$RESET" "$(say "$1" "$2")" >&2; exit 1; }

# ─── system ──────────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) NODE_OS=darwin ;;
  Linux) NODE_OS=linux ;;
  *) fail "NyxOS läuft auf macOS und Linux, nicht auf $OS." "NyxOS runs on macOS and Linux, not on $OS." ;;
esac
case "$ARCH" in
  arm64|aarch64) NODE_ARCH=arm64 ;;
  x86_64|amd64) NODE_ARCH=x64 ;;
  *) fail "Prozessor $ARCH wird nicht unterstützt." "CPU architecture $ARCH is not supported." ;;
esac

need() { command -v "$1" >/dev/null 2>&1; }
need tar || fail "tar fehlt." "tar is missing."
if need curl; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"; }
  fetch_text() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$1"; }
elif need wget; then
  fetch() { wget -q --https-only -O "$2" "$1"; }
  fetch_text() { wget -q --https-only -O - "$1"; }
else
  fail "curl oder wget wird benötigt." "curl or wget is required."
fi
if need sha256sum; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif need shasum; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else fail "sha256sum oder shasum fehlt." "sha256sum or shasum is missing."; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Transcripts, logs and keys live here: only this user may open the folder (also on shared Linux machines).
mkdir -p "$NYXOS_HOME"
chmod 700 "$NYXOS_HOME"

printf '\n%sNyxOS%s %s\n\n' "$BOLD" "$RESET" "$(say "wird installiert" "is being installed")"

# ─── 1. Node.js ──────────────────────────────────────────────────────────────
NODE_DIR="$NYXOS_HOME/runtime/node"
NODE="$NODE_DIR/bin/node"
if [ -x "$NODE" ] && "$NODE" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $NODE_MAJOR ? 0 : 1)" 2>/dev/null; then
  step "Node.js ist schon da ($("$NODE" -v))" "Node.js already present ($("$NODE" -v))"
else
  step "Lade Node.js $NODE_MAJOR (nur für NyxOS, ~45 MB) …" "Downloading Node.js $NODE_MAJOR (only for NyxOS, ~45 MB) …"
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  fetch_text "$BASE/SHASUMS256.txt" > "$TMP/SHASUMS256.txt"
  FILE="$(grep -oE "node-v[0-9.]+-${NODE_OS}-${NODE_ARCH}\.tar\.gz" "$TMP/SHASUMS256.txt" | head -n1)"
  [ -n "$FILE" ] || fail "Keine passende Node.js-Version gefunden." "No matching Node.js build found."
  fetch "$BASE/$FILE" "$TMP/$FILE"
  EXPECTED="$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
  [ "$(sha256 "$TMP/$FILE")" = "$EXPECTED" ] || fail "Prüfsumme von Node.js stimmt nicht." "Node.js checksum mismatch."
  rm -rf "$NODE_DIR.new" && mkdir -p "$NODE_DIR.new"
  tar -xzf "$TMP/$FILE" -C "$NODE_DIR.new" --strip-components=1
  rm -rf "$NODE_DIR" && mv "$NODE_DIR.new" "$NODE_DIR"
fi

# ─── 2. tmux (and a git check) ───────────────────────────────────────────────
install_pkg() {
  local pkg="$1"
  if [ "$NODE_OS" = darwin ]; then
    if need brew; then brew install "$pkg" >/dev/null && return 0; fi
    return 1
  fi
  local SUDO=""
  if [ "$(id -u)" != 0 ]; then need sudo || return 1; SUDO="sudo"; fi
  if need apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$pkg" >/dev/null
  elif need dnf; then $SUDO dnf install -y -q "$pkg"
  elif need pacman; then $SUDO pacman -S --noconfirm --needed "$pkg" >/dev/null
  elif need zypper; then $SUDO zypper --non-interactive install "$pkg" >/dev/null
  else return 1; fi
}

if ! need tmux && [ "${NYXOS_SKIP_TMUX:-0}" != 1 ]; then
  step "Installiere tmux (für die Terminals in NyxOS) …" "Installing tmux (for the terminals in NyxOS) …"
  if [ "$NODE_OS" = linux ] && [ "$(id -u)" != 0 ]; then say "   Dafür fragt das System evtl. nach deinem Passwort." "   Your system may ask for your password."; fi
  install_pkg tmux || say "   ${DIM}tmux konnte nicht installiert werden – NyxOS läuft trotzdem, nur ohne Terminal-Ansicht. Später: $( [ "$NODE_OS" = darwin ] && echo 'brew install tmux' || echo 'sudo apt install tmux')${RESET}" "   ${DIM}Could not install tmux – NyxOS still works, just without the terminal view. Later: $( [ "$NODE_OS" = darwin ] && echo 'brew install tmux' || echo 'sudo apt install tmux')${RESET}"
fi
if ! need git; then
  say "   ${DIM}Hinweis: git fehlt. Für Git-Ansichten später installieren ($( [ "$NODE_OS" = darwin ] && echo 'xcode-select --install' || echo 'sudo apt install git')).${RESET}" "   ${DIM}Note: git is missing. Install it for the git views ($( [ "$NODE_OS" = darwin ] && echo 'xcode-select --install' || echo 'sudo apt install git')).${RESET}"
fi

# ─── 3. NyxOS release ────────────────────────────────────────────────────────
if [ -n "${NYXOS_TARBALL:-}" ]; then
  TARBALL="$NYXOS_TARBALL"
  [ -f "$TARBALL" ] || fail "Datei $TARBALL fehlt." "File $TARBALL not found."
  step "Installiere aus $TARBALL" "Installing from $TARBALL"
else
  case "$REPO" in
    OWNER/*|*[!A-Za-z0-9_./-]*) fail "Kein gültiges Repository ($REPO) — NYXOS_REPO setzen." "No valid repository ($REPO) — set NYXOS_REPO." ;;
  esac
  VERSION="${NYXOS_VERSION:-}"
  if [ -z "$VERSION" ]; then
    # First without the GitHub API (only 60 requests per hour and address without sign-in — shared addresses in
    # offices, universities or mobile networks run out): the "latest" download link always points to the newest
    # release, and its checksum file names the package together with its version. The API is the fallback.
    # `|| true`: a failed lookup must reach the clear message below instead of ending the script via `set -e`.
    VERSION="$(fetch_text "https://github.com/$REPO/releases/latest/download/SHA256SUMS" 2>/dev/null | grep -oE 'nyxos-[0-9][0-9A-Za-z.+-]*\.tar\.gz' | head -n1 | sed -E 's/^nyxos-(.*)\.tar\.gz$/\1/' || true)"
    [ -n "$VERSION" ] || VERSION="$(fetch_text "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep -oE '"tag_name": *"v?[^"]+"' | head -n1 | sed -E 's/.*"v?([^"]+)"$/\1/' || true)"
    [ -n "$VERSION" ] || fail "Neueste Version nicht gefunden (GitHub erreichbar?)." "Could not find the latest version (is GitHub reachable?)."
  fi
  case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) fail "Ungültige Version: $VERSION" "Invalid version: $VERSION" ;;
  esac
  case "$VERSION" in *[!0-9A-Za-z.+-]*|*..*) fail "Ungültige Version: $VERSION" "Invalid version: $VERSION" ;; esac
  step "Lade NyxOS $VERSION …" "Downloading NyxOS $VERSION …"
  NAME="nyxos-$VERSION.tar.gz"
  URL="https://github.com/$REPO/releases/download/v$VERSION"
  fetch "$URL/$NAME" "$TMP/$NAME"
  fetch "$URL/SHA256SUMS" "$TMP/SHA256SUMS"
  EXPECTED="$(grep " $NAME\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$EXPECTED" ] && [ "$(sha256 "$TMP/$NAME")" = "$EXPECTED" ] || fail "Prüfsumme von NyxOS stimmt nicht." "NyxOS checksum mismatch."
  TARBALL="$TMP/$NAME"
fi

mkdir -p "$TMP/peek"
tar -xzf "$TARBALL" -C "$TMP/peek"
CLI="$(ls -d "$TMP"/peek/nyxos-*/cli/nyxos.mjs 2>/dev/null | head -n1)"
[ -n "$CLI" ] || fail "Das Paket ist unvollständig." "The package is incomplete."

# ─── 4 + 5. services, bridge, browser ────────────────────────────────────────
step "Richte Hintergrunddienste ein …" "Setting up background services …"
NYXOS_NODE="$NODE" "$NODE" "$CLI" install --from "$TARBALL"

printf '\n%s✓%s %s\n' "$GREEN" "$RESET" "$(say "NyxOS ist installiert. Im Browser geht es mit der Einrichtung weiter." "NyxOS is installed. Continue with the setup in your browser.")"
say "  Befehl: nyxos  (in einem neuen Terminal-Fenster; Hilfe: nyxos help)" "  Command: nyxos  (in a new terminal window; help: nyxos help)"
say "  Wieder öffnen: nyxos open   ·   Entfernen: nyxos uninstall" "  Open again: nyxos open   ·   Remove: nyxos uninstall"
}

main "$@"
