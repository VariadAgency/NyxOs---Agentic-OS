# Releasing

This page is for maintainers. A release is a GitHub Release with two files: `nyxos-<version>.tar.gz` and
`SHA256SUMS`. The installer, `nyxos update` and the in-app update check all read from there.

## Before the very first push

The repository ships with the placeholder `OWNER/nyxos` in the installer, the docs, `package.json`
(`nyxos.repo`) and `packages/shared/src/app-settings.ts`. Replace it once with your real GitHub repository:

```bash
scripts/set-repo.sh your-account/nyxos
```

The script replaces the placeholder in every tracked file and lists what it changed. Until then, the update
check stays off.

## Versioning

NyxOS uses [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **PATCH** — fixes only.
- **MINOR** — new features, new (additive) database migrations.
- **MAJOR** — anything that needs manual steps from users.

The version lives in the root `package.json` (`"version"`). The release package, the server's version display
and the update check all read it from there.

## Making a release

1. **Update `CHANGELOG.md`.** Move the entries under `## [Unreleased]` into a new section
   `## [X.Y.Z] - YYYY-MM-DD`. The release notes on GitHub are taken from exactly this section.
2. **Bump the version** in the root `package.json` to `X.Y.Z`.
3. **Check locally:**

   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck && pnpm lint && pnpm test
   pnpm package                 # builds dist/nyxos-X.Y.Z.tar.gz and dist/SHA256SUMS
   bash scripts/check-clean.sh  # no personal data or secrets in the repository
   ```

   Do not test-install the package on a machine that already runs NyxOS: the service names are fixed, so a
   second install replaces the first one's services. The release workflow installs it on fresh machines
   for you (see below); for a manual check use a virtual machine and
   `NYXOS_TARBALL=/path/to/nyxos-X.Y.Z.tar.gz bash install.sh`.
4. **Commit, tag and push:**

   ```bash
   git commit -am "Release X.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

## What the release workflow does

Pushing a tag `v*` starts `.github/workflows/release.yml`:

| Job | What happens |
|---|---|
| **build** | Checks that the tag matches `package.json` (`vX.Y.Z` = `X.Y.Z`), runs the tests, builds the package with `pnpm package` and keeps `dist/nyxos-*.tar.gz` + `dist/SHA256SUMS`. |
| **install-test** | On fresh **macOS** and **Ubuntu** runners, installs the package with `install.sh` exactly like a new user — without the runner's Node.js — then runs `scripts/test/smoke-installed.sh` (server, bridge and onboarding API must answer). |
| **publish** | Only if both install tests pass: extracts the `CHANGELOG.md` section of this version as release notes and publishes the GitHub Release with the two files. |

If a job fails, nothing is published. Fix the problem, delete the tag (`git tag -d vX.Y.Z` and
`git push origin :refs/tags/vX.Y.Z`), and tag again.

## What the package contains

`scripts/package.mjs` builds server, web app and bridge, then assembles `dist/nyxos-X.Y.Z/`:

```
nyxos-X.Y.Z/
├── package.json        name, version, license, nyxos.repo
├── README.md · LICENSE · NOTICE · CHANGELOG.md
├── bin/nyxos           shell wrapper
├── cli/nyxos.mjs       the nyxos command
├── server/             dist/ (bundled server), drizzle/ (migrations), web/ (built web app),
│                       node_modules/@electric-sql/pglite (WebAssembly, loaded at runtime)
└── bridge/bridge.js    bundled bridge
```

It contains only JavaScript, the web app and WebAssembly, so one package runs on macOS and Linux, x64 and
arm64. The installer brings the Node.js runtime.

## After the release

- The in-app update check picks up the new version within a day; users with automatic updates get it
  installed.
- Add a fresh `## [Unreleased]` section to `CHANGELOG.md`.
