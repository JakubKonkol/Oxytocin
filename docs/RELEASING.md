# Releasing Oxytocin

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed (or manually with
*Run workflow*). It packages Windows (NSIS), macOS (dmg + zip) and Linux (AppImage + deb), checks the Electron fuses,
runs a smoke test against each packaged app (on Windows after a silent install) and drafts a GitHub Release with the
matching `CHANGELOG.md` section.

## Checklist

1. Update `CHANGELOG.md` (a `## [x.y.z]` section) and `version` in `package.json`.
2. `npm run licenses:notices` and commit `THIRD_PARTY_NOTICES.md` if it changed.
3. `npm run check` and `npm run e2e` are green on `main`.
4. Tag and push: `git tag -a vX.Y.Z -m "Oxytocin X.Y.Z" && git push origin vX.Y.Z`.
5. Review the draft release and publish it. Publishing makes the update visible to installed apps (auto-update).

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
