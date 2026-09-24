# Releasing Puck

This guide is for the person who cuts a Puck release.
The install and update steps for users are in the README.

## Version and tag

- The version lives in `package.json` and `package-lock.json`, and the top entry of `CHANGELOG.md` repeats it.
- Each release is tagged `v<version>` on `main`, for example `v0.0.1`.
- Release 0.0.1 uses version `0.0.1` and tag `v0.0.1` (working assumption C-1).
- `test/unit/build-checks.test.ts` fails when the changelog entry and the package version disagree.

## Target

- macOS on Apple silicon only: platform `darwin`, architecture `arm64` (working assumption C-5).
- Minimum macOS 12.0 (Monterey), the floor that Electron 43 sets in its own `Info.plist`.
  `MIN_MACOS` in `scripts/release.mjs` holds that number, and the build fails when the packaged bundle disagrees.

## Build

Use Node 22, the major in `.nvmrc`, and run:

```bash
npm ci
npm run make
```

`npm run make` runs Electron Forge through `scripts/forge.mjs`, which does the following.

1. It prints one signing line before Forge starts: ad hoc, or the Developer ID and the notarization method.
2. It adds `--platform darwin --arch arm64` unless the call names a target.
3. It fails unless Forge wrote a fresh `out/Puck-darwin-arm64/Puck.app`.
4. It checks the bundle: the signature matches the request, `LSMinimumSystemVersion` is 12.0, and the icon bytes match `assets/icon/puck.icns`.
5. It requires the ZIP name `Puck-darwin-arm64-<version>.zip` and writes `Puck-darwin-arm64-<version>.zip.sha256` beside it.

The artifacts land in `out/make/zip/darwin/arm64/`.
Verify the checksum with:

```bash
cd out/make/zip/darwin/arm64 && shasum -a 256 -c Puck-darwin-arm64-0.0.1.zip.sha256
```

The pure helpers behind these steps are in `scripts/release.mjs`, and `test/unit/release.test.ts` covers them.

## Icon

The icon source is `assets/icon/puck.svg`, a flat puck in the emerald tones from `DESIGN.md`.
`scripts/make-icon.sh` renders it with `qlmanage`, `sips`, and `iconutil` into `assets/icon/puck.iconset` and `assets/icon/puck.icns`.
`forge.config.ts` points Packager at `assets/icon/puck`, and Packager writes the bytes over Electron's `electron.icns` inside the bundle.
To replace the artwork, edit the SVG, run the script, and commit all three.

## Signing and notarization (open call C-3)

Signing and notarization switch on only through environment variables.
Nothing is read from a file in the repository, and no credential is ever committed.
Without the variables the build is ad hoc signed and not notarized, and the wrapper says so in one line.

| Variable | Holds |
| --- | --- |
| `PUCK_SIGN_IDENTITY` | The Developer ID Application identity, for example `Developer ID Application: Name (TEAMID)` |
| `PUCK_NOTARIZE_APPLE_ID` | The Apple ID (email address) of the developer account |
| `PUCK_NOTARIZE_APPLE_PASSWORD` | An app-specific password for that Apple ID, not the account password |
| `PUCK_NOTARIZE_TEAM_ID` | The 10-character team id |
| `PUCK_NOTARIZE_API_KEY` | The path to an App Store Connect API key `.p8` file |
| `PUCK_NOTARIZE_API_KEY_ID` | The key id of that API key |
| `PUCK_NOTARIZE_API_ISSUER` | The issuer id (a UUID) of that API key |

The rules:

- `PUCK_SIGN_IDENTITY` alone signs the app with the hardened runtime and does not notarize.
- Add the three `APPLE` variables or the three `API` variables to notarize.
  Set one set, not both.
- A partial set, or notarization variables without an identity, fails the build before Forge starts and names the missing variables.
- A failed `codesign` fails the build.
  Packager alone would only warn and ship the unsigned app.
- After a notarized build, the wrapper checks that the ticket is stapled to the app.

What the captain provides for C-3:

1. A Developer ID Application certificate, installed with its private key in the login keychain of the build Mac.
2. The team id of the Apple Developer account.
3. One of two credential sets.
   Either an app-specific password for the Apple ID, created under Sign-In and Security on appleid.apple.com.
   Or an App Store Connect API key with the Developer role: the `.p8` file, its key id, and the issuer id.

Export the variables in the shell that runs `npm run make`, for example from a password manager.
Never write them into the repository.

## Distribution (open call C-2)

Until C-2 is decided, the artifact is a local ZIP plus its checksum file, handed over by the captain.
`forge.config.ts` has no publisher, and no workflow uploads anywhere.
`npm run publish` still calls `electron-forge publish` directly and is not part of the 0.0.1 flow.

## Updates (working assumption C-9)

Release 0.0.1 has no automatic updates.
Users replace `Puck.app` by hand, as the README describes.
Data stays in the app data folder, so a replacement keeps agents, environments, conversations, and sign-ins.

## Release checklist

1. Set the version with `npm version <version> --no-git-tag-version` and write the `CHANGELOG.md` entry.
2. Run `npm run typecheck && npm run lint && npm test`.
3. Run `npm run make`, with the signing variables set or, for an ad hoc build, without them.
   Say which one in the release notes.
4. Verify the checksum, open the app once, and check that Settings → Support shows the new version.
5. Commit, tag `v<version>`, and push the tag.
6. Hand over the ZIP together with its `.sha256` file.
