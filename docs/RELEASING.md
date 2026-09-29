# Releasing Oxytocin

**To release: *Actions → Release → Run workflow*, enter the version (e.g. `0.3.2`) and run it on `main`.** The
workflow (`.github/workflows/release.yml`) then does everything:

1. Bumps `version` in `package.json` and `package-lock.json` (and the README release badge), renames the `## [Unreleased]` heading of
   `CHANGELOG.md` to `## [x.y.z] - YYYY-MM-DD` and pushes the commit `chore(release): x.y.z` to `main`
   (`.github/scripts/prepare-release.sh`). It refuses a version that is not newer, an existing tag or an empty
   `[Unreleased]` section. When `package.json` already has the version (bumped by hand), it releases `main` as it is.
2. Per platform runs the full test suite (`full-tests.yml`: typecheck, lint, unit and integration tests, plus E2E on
   Windows and Linux), packages the app (`package.yml`: Windows NSIS, macOS dmg + zip, Linux AppImage + deb), checks
   that the update manifests point at the packages (`scripts/verify-update-manifests.ts`), checks the Electron fuses
   and smoke-tests each packaged app (on Windows after a silent install).
3. Tags the release commit `vx.y.z` and **publishes** the GitHub Release with the matching `CHANGELOG.md` section.

The tag is only created at the end, so a failed run leaves no tag behind: fix the problem and run the workflow again
with the same version. *Run workflow* without a version is a dry run (tests and packages, no commit, no release).
Pushing a `vx.y.z` tag by hand also works for a commit whose `package.json` already has that version.

**Windows is the primary platform.** Its tests gate its package and its package gates the release. Linux and macOS
are tested and packaged in parallel; their packages are attached when they succeed, but a failure there never blocks
the release. Re-run their failed jobs from the Actions page later: that re-runs the release job, which adds the
missing packages to the existing release.

Pushes to `main` and pull requests only run the fast checks in `ci.yml` on Windows (typecheck, lint, licenses, unit
tests). Start *Actions → Full tests → Run workflow* by hand to run the full suite without releasing (all platforms,
Windows only, or Linux + macOS). E2E tests are retried up to twice on CI; retried tests are reported as flaky.

## Before releasing

- `CHANGELOG.md` has a `## [Unreleased]` section at the top describing the changes.
- `npm run licenses:notices` and commit `THIRD_PARTY_NOTICES.md` if dependencies changed.
- Publishing makes the update visible to installed apps (auto-update). A release created by hand for the same tag
  beforehand is kept; the workflow adds or replaces its packages.

## Code signing and notarization

Without the secrets below the packages are **unsigned**: Windows SmartScreen and macOS Gatekeeper warn on first
start. Add the secrets under *Settings → Secrets and variables → Actions*; the workflow picks them up automatically
(`scripts/lib/signing.ts` decides what to do and logs it).

### Windows — Azure Trusted Signing (recommended)

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | App registration with the *Trusted Signing Certificate Profile Signer* role |
| `AZURE_SIGN_ENDPOINT` | e.g. `https://weu.codesigning.azure.net` |
| `AZURE_SIGN_ACCOUNT` | Trusted Signing account name |
| `AZURE_SIGN_PROFILE` | Certificate profile name |
| `AZURE_SIGN_PUBLISHER` | Publisher name, exactly as in the certificate subject (CN) |

### Windows — PFX certificate (OV/EV)

| Secret | Value |
|---|---|
| `WIN_CSC_LINK` | Base64 of the `.pfx` (or an https URL to it) |
| `WIN_CSC_KEY_PASSWORD` | Its password |

### macOS — Developer ID and notarization

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64 of the *Developer ID Application* certificate exported as `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Its password |
| `APPLE_API_KEY_P8` | Contents of the App Store Connect API key (`AuthKey_XXXX.p8`) |
| `APPLE_API_KEY_ID` | The key id |
| `APPLE_API_ISSUER` | The issuer id |

The app is signed with the hardened runtime and `resources/build/entitlements.mac.plist` (JIT and unsigned executable
memory for V8; library validation off for the native modules). With the API key it is notarized and stapled; the
workflow then checks `codesign --verify`, `stapler validate` and `spctl --assess`.

## Electron fuses

`electron-builder.yml` flips these fuses on every package (checked by `scripts/verify-fuses.ts`): no
`ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect` arguments, embedded asar integrity validation, app loaded
only from `app.asar`, cookie encryption, no extra `file://` privileges. As a consequence the packaged smoke test
(`tests/smoke`) drives the app over the Chrome DevTools Protocol (`--remote-debugging-port`) instead of Playwright's
Electron launcher, and `OXYTOCIN_INSPECT_HOSTS=1` only works in development builds.

## Auto-update

Installed apps update from GitHub Releases through `electron-updater` (`publish` in `electron-builder.yml`). The
workflow uploads `latest.yml` / `latest-mac.yml` / `latest-linux.yml` and the `.blockmap` files next to the packages;
**keep them in the release**, they are what the apps read. Installed apps see a release as soon as it is published.
Package names must not contain spaces: GitHub turns them into dots on upload while `latest.yml` keeps dashes, so the
apps would download a file that does not exist (the 0.5.1 Windows installer). The packaging job fails on that.

- **Channels:** the `updates.channel` setting is `latest` (stable releases) or `beta` (also GitHub pre-releases). A
  version with a pre-release suffix (`0.3.0-beta.1`) is published as a pre-release and only offered on `beta`.
- **Behaviour:** a check 15 s after start and every 6 hours (`updates.checkAutomatically`), download in the
  background, install when the user quits or clicks *Install now* (after the same running-process confirmation as
  quitting). Clicking the status bar entry during a download shows its progress; once downloaded it offers *Install
  now* or *On restart*, and a failed download offers *Retry*. Oxytocin never restarts by itself.
- **Platforms:** Windows (NSIS) and macOS (zip; signed builds only, Squirrel.Mac requires a signature) update
  themselves; on Linux only the AppImage does — `deb` installs are updated through the package manager.
- **Checking a release:** install the previous version, let the workflow publish the new release and use *Check for
  Updates…* in the app menu; `logs/main.log` in the user data folder shows the `[updates]` entries.
