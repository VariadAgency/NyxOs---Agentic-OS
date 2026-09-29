## What and why

<!-- What does this change, and which problem does it solve? Link the issue: "Closes #123". -->

## How to test

<!-- Steps a reviewer can follow. For UI changes: screenshots from `nyxos demo` (never real data). -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass
- [ ] `bash scripts/check-clean.sh` passes — no personal data, real transcripts or secrets
- [ ] Fixes start with a test that failed before the fix
- [ ] New UI texts are German in `t()` with English added to `packages/shared/src/i18n/en/`
- [ ] Database changes are additive migrations (`pnpm --filter @nyxos/server db:generate`)
- [ ] Adopted third-party code or patterns are listed in `NOTICE`
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` (if users notice the change)
- [ ] Docs updated (if behaviour, commands or settings changed)
