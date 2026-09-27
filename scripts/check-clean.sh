#!/usr/bin/env bash
# Fails if a tracked file contains something that looks like a real secret (API keys, tokens, private keys).
#
# Personal words (your name, your server, your company) do not belong in this public script: put them in the
# git-ignored file `.check-clean.local` (one extended regular expression per line, `#` starts a comment) or in
# the environment variable NYXOS_CHECK_CLEAN_EXTRA (a single regular expression). Both are added to the check.
set -euo pipefail
cd "$(dirname "$0")/.."

patterns=(
  'sk-ant-(api|oat|admin)[0-9]{2}-[A-Za-z0-9_-]{30,}'   # Anthropic
  'sk-(proj-|svcacct-)?[A-Za-z0-9]{40,}'                # OpenAI
  '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}'             # GitHub tokens
  'github_pat_[A-Za-z0-9_]{50,}'                        # GitHub fine-grained tokens
  'xox[abprs]-[A-Za-z0-9-]{20,}'                        # Slack
  'AKIA[0-9A-Z]{16}'                                    # AWS access key id
  'AIza[0-9A-Za-z_-]{35}'                               # Google API key
  '[0-9]{8,10}:AA[A-Za-z0-9_-]{33}'                     # Telegram bot token
  'BEGIN (RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[^"]{20}'  # private keys (with key material)
)
PATTERN="$(IFS='|'; echo "${patterns[*]}")"

extra=()
if [ -f .check-clean.local ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$line" ] && extra+=("$line")
  done < .check-clean.local
fi
[ -n "${NYXOS_CHECK_CLEAN_EXTRA:-}" ] && extra+=("$NYXOS_CHECK_CLEAN_EXTRA")
if [ "${#extra[@]}" -gt 0 ]; then PATTERN="$PATTERN|$(IFS='|'; echo "${extra[*]}")"; fi

# This script is left out: its own patterns would match themselves. Test fakes that say what they are
# ("fake", "geheim", "example", counting sequences) are fine.
PLACEHOLDER='fake|geheim|example|dummy|placeholder|AAAAAAAAAA|abcdefghij|AbCdEfGh|0123456789ab'
hits="$(git ls-files -z -- . ':!scripts/check-clean.sh' | xargs -0 grep -InEi -e "$PATTERN" -- 2>/dev/null | grep -Eiv "$PLACEHOLDER" || true)"
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "check-clean: found the matches above" >&2
  exit 1
fi
echo "check-clean: nothing found (${#extra[@]} local pattern(s))"
