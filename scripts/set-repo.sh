#!/usr/bin/env bash
# Sets the GitHub repository ("owner/name") that the installer, the update check and the docs use.
#   scripts/set-repo.sh my-account/nyxos
set -euo pipefail
repo="${1:-}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "usage: scripts/set-repo.sh <owner>/<name>" >&2; exit 2; }
cd "$(dirname "$0")/.."
files=$(git ls-files | xargs grep -Il 'OWNER/nyxos' || true)
[ -n "$files" ] || { echo "nothing to replace (already set?)"; exit 0; }
for f in $files; do perl -pi -e "s#OWNER/nyxos#${repo}#g" "$f"; done
echo "Repository set to ${repo} in:"; echo "$files" | sed 's/^/  /'
