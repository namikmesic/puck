# Working on Puck

Guidance for coding agents (and humans) contributing to this repo.

## Checks that must stay green

```bash
npm run typecheck && npm run lint && npm test
```

Lint is at **zero problems** - keep it there.
CI runs these plus the definitions schema drift check (`npm run schema`, then `git diff --exit-code`), `npm run build:server`, `npm run build:daemon` then `node .webpack/daemon/puckd.js version`, `npm run build:runner` and the macOS runner tarball's `config.sh --help`, `npm run test:docker` on the Linux `daemon-docker` job, `npm run package`, and a `docker compose up` of the server image.

## Things that bite

- **Builds run on Node 22 only**, the major pinned in `.nvmrc` and mirrored by `engines` in `package.json`.
  CI reads `.nvmrc`.
  `npm run package` and `npm run make` go through `scripts/forge.mjs`.
  The wrapper refuses other Node majors and fails when Forge exits 0 without a fresh app bundle under `out/`.
  Forge has done exactly that on a newer Node.
  CI installs with `npm ci`, so regenerate a drifted lockfile with the pinned Node's npm (`npm install --package-lock-only`).
  `test/unit/build-checks.test.ts` keeps the pin, the CI workflow, and the scripts in agreement.
- **The environment daemon** (`puckd`, `src/daemon/main.ts`) runs as each environment container's main process and drives the harnesses in it.
  `npm run build:daemon` writes the one-file bundle `.webpack/daemon/puckd.js`; the SDKs stay external and load from the container's pinned packages.
  The app embeds the bundle as a string (`src/main/daemon-source.ts`, the `raw-daemon` alias) and hands it to runners; a changed daemon reaches an environment only through the explicit daemon update, never silently.
  Its client protocol is `src/harness/daemon-protocol.ts`, whose header says when `PROTOCOL_VERSION` bumps.
  It may import only `src/harness` and itself, and `src/main` and `src/renderer` never import it (`.eslintrc.json`).
- **IPC channels** live in one table: `src/harness/channels.ts` (`CHANNELS`).
  `preload.ts` and `src/index.ts` both import it.
  The `satisfies` clause keeps it total over `PuckBridge`, and `test/unit/channels.test.ts` asserts main registers a handler for every entry.
  Adding a bridge method = bridge type + CHANNELS entry + preload line + handler.
  Push channels from main to the renderer (`RUNNER_EVENT_CHANNEL`, `INSTANCE_EVENT_CHANNEL`, `DAEMON_EVENT_CHANNEL`, `FLUSH_CHANNEL`, `FLUSHED_CHANNEL`) sit outside the table.
  The `satisfies` clause excludes their bridge methods by name.
- **Environment readiness is the daemon's state, not Docker liveness.**
  An environment is ready only when its daemon reports `instance.status` ready over an attached connection.
  `composerGate` in `src/renderer/instance-progress.ts` reads the app's operation, the attach state, and the daemon's status, in that order.
  Reserve "is Docker running?" for a failed Docker health check on the runner, never for a slow pull or run.
- **The app never runs `docker`.**
  Every Docker operation is on a runner (`src/puck-runner/docker/`), argv only, with `TIMEOUTS` in `ops.ts` as the one table.
  Docker CLI discovery (`discovery.ts`) exists because launchd and Finder launches do not inherit the shell PATH: configured path (`PUCK_DOCKER_BIN`), well-known install locations, inherited PATH, login-shell probe, and the not-found error lists what was searched.
- **Provider packages are pinned** (`PinnedPackage` in `src/harness/providers/index.ts`).
  The daemon's provisioning (`src/harness/provisioning.ts`) checks the installed versions read-only, installs the exact pins only on drift, and verifies the result on every boot; any drift fails provisioning.
  Bump a pin only together with what that `PinnedPackage` comment names.
  colima does not share host temp dirs either, so scripts reach containers as `sh -lc` arguments.
- **Provider ids** (`claude-code`, `codex`) are persisted in user stores - never rename them.
- **Release mechanics** live in `scripts/forge.mjs` (the wrapper) and `scripts/release.mjs` (pure helpers, tested).
  Signing and notarization switch on only through the `PUCK_SIGN_*` and `PUCK_NOTARIZE_*` variables listed in `RELEASE.md`, never through a committed file.
  The wrapper prints the signing state, forces darwin/arm64, checks signature, minimum macOS, and icon bytes, and writes a `.sha256` beside the ZIP.
  `MIN_MACOS` in `scripts/release.mjs` must match the Electron `Info.plist`, and the changelog's top version must match `package.json` (`build-checks.test.ts`).
  The icon source is `assets/icon/puck.svg`, and `scripts/make-icon.sh` regenerates the iconset and `.icns`.
- **Diagnostic log** (`src/main/log.ts`): `log.info/warn/error` append to `userData/logs/puck.log`, rotated at 1 MiB, three files.
  Log ids, names, states, and timings.
  Never log prompts, transcripts, tokens, or secret values, even though every line is redacted.
  The support bundle (`src/main/support.ts`) ships those files plus a summary of key NAMES only, through `support:export`.
- **Quit is a drain** (`src/main/shutdown.ts`).
  The first `before-quit` is held while the renderer flushes and every queued store write settles.
  The renderer acknowledges over `FLUSH_CHANNEL` (its drafts already live in `localStorage`); then the instance replay cursor is flushed and `jsonstore.flushWrites` awaits the queued writes.
  Then quit re-issues, bounded by a timeout.
  Anything that must survive quit goes through `jsonstore` in main; everything about the work itself lives in the daemon.
- **Secrets** (`src/main/secrets.ts`) have one backend, Electron safeStorage.
  `saveSecret` throws `SecureStorageUnavailableError` when the keychain cannot encrypt.
  There is no plaintext fallback, and a file that does not decrypt reads as absent.
  The Settings copy in `index.html` states this behavior.
- **Persisted stores** live in Electron `userData`: `puck-providers.json`, `puck-runners.json`, `puck-instances.json`, `puck-defs-cache/`, and encrypted `*.bin` secrets (`puck-session.bin`, `claude-oauth.bin`, `codex-oauth.bin`).
  Migrate, don't break: new fields get `??` defaults at load, and legacy keys are dual-read, never rewritten in place.
  Stores of the 0.0.1 chat app (`puck-agents.json`, `puck-environments.json`, `puck-resume.json`, `puck-convos*`, `env-secrets-*.bin`) are ignored, never read or deleted.
  Everything about the work (backlog, sessions, transcripts, events) lives in the daemon's stores under `/puck/state`, with a `formatVersion` and ordered migrations on boot; the same rule applies there.
  See `src/harness/transcript.ts` for the transcript format and its append-only rule.
  Tickets and their workflows live in the append-only delivery journal (`src/daemon/delivery/journal.ts`); those migrations never rewrite it.
- **Per-agent provider options** are schema-driven.
  Adding one is a single `ProviderOption` descriptor in the provider module (`configOptions`).
  An agent definition's `options:` are checked strictly against that schema (`checkSettings` in `src/harness/options.ts`), and the generated JSON Schema follows it.
  Only options needing cross-key coupling get a line in the provider's `compileSettings`.
  A test asserts every overridden option reaches the compiled output.
  Values are sparse (only overrides are compiled), and the daemon's adapters encode the defaults.
- **Driving the running app for verification**: launch with `npm run start:isolated -- -- --remote-debugging-port=9222` (throwaway data dir, mock keychain, never replace HOME) and attach playwright-core over CDP.
  Never call `page.setViewportSize` on the live app.
  The emulation override outlives the script and breaks the real window's layout.
  Use `Emulation.setDeviceMetricsOverride` inside try/finally with `clearDeviceMetricsOverride` instead.
- **Provider logins** for harnesses run in the system browser (RFC 8252).
  GitHub sign-in is the Puck server's web flow (`src/main/server/session.ts`); the server holds the App's identity and client secret and the app keeps only its Puck session - never add GitHub App credentials to the app (the install link comes from the server's `GET /v1/me`).
  The authorize URL goes through `shell.openExternal`.
  The redirect lands on the shared loopback listener `src/main/providers/loopback.ts` (127.0.0.1 only, one request, state check, timeout).
  Claude binds an ephemeral port (`http://localhost:<port>/callback`, the shape Claude Code registers).
  Codex uses its registered fixed port 1455.
  There is no embedded sign-in window or cookie partition - logout only clears Puck's own token store.
  Logout is a fence, implemented by `createOAuthAccount` in `src/main/providers/oauth.ts`.
  It advances an epoch, so an exchange or refresh already in flight drops its result (`LogoutFence`).
  Adoption of container credentials requires a signed-in account.
  Sign-out removes the credential from the attached environment and marks every other one for removal on its next attach (`onHarnessLogout` in `src/main/instances/index.ts`).
  Any new path that writes tokens asynchronously must take a fence first.
- **colima** does not share `$HOME` with containers, so credential files reach containers via `docker cp` only.
  Host dirs are deliberately not mounted (sandbox escape via CLI hook files).

## Adding a provider - checklist

1. Pure descriptor `src/harness/providers/<id>.ts` (models, thinking levels, `configOptions` schema, `compileSettings`, capabilities, pinned CLI/SDK packages, container env, credential path) and host half `src/main/providers/<id>.ts` (auth and the credential mirror).
2. OAuth module (transport and token mapping).
   Shared PKCE and token-store helpers live in `oauth.ts`.
3. Registry entry in `src/main/providers/index.ts`.
4. Daemon side: an adapter under `src/daemon/harness/` that translates SDK events into `HarnessEvent`s, registered from `createAdapters`.
5. Run the suite.
   `provider-settings.test.ts` checks compiled options, and `providers.test.ts` checks the pins against the daemon's type devDependencies.

## Terminology

The glossary is `CONTEXT.md`: one canonical word per concept, with the words to avoid.
Use its terms in code comments, UI copy, tool descriptions, prompts, and docs.
Persisted ids, store keys, and protocol names keep their historical spellings (`docs/adr/0001-product-renames-keep-persisted-names.md`).

## Layout

- `src/index.ts` - main process: window hardening, IPC handler registration, and quit drain wiring.
  Ids, pins, specs, and daemon calls are validated in `src/main/ipcguard.ts`.
- `src/harness/` - contracts shared by the renderer, main, and the environment daemon, plus the pure definition library.
  Keep this directory free of node/electron imports.
  `bridge.ts` holds the types and `PuckBridge`, `channels.ts` the IPC channel table, `types.ts` the `HarnessEvent` wire protocol.
  `options.ts` holds the provider option schema.
  `providers/` holds the pure harness descriptors and `github/` the shared GitHub client.
  `definitions/` holds agent and environment definitions: YAML parse, validation, resolution, JSON Schema, and update-class diff.
  `provisioning.ts` is the container package plan, `daemon-protocol.ts` the puckd protocol, and `transcript.ts` transcript format v2.
- `src/daemon/` - puckd. Entry `main.ts`; the app embeds its bundle through `src/main/daemon-source.ts`.
- `src/puck-runner/` - the host runner. Contract: `src/puck-runner/README.md`.
- `src/main/providers/` - the provider kinds (`types.ts`) and the registry (`index.ts`).
  The header comments say what a new provider needs.
- `src/main/config-repo.ts` - the Puck home at a pinned ref: tree and file fetch, tag, branch and commit pins, the SHA cache, and `definitionRefs` / `definitionsAt`.
- `src/main/home.ts` - connect or initialize that home (`src/main/home-starter.ts` is what initialize commits). The stored key stays `configRepo`.
- `src/main/instances/` - environments: the start flow, the daemon client (attach, replay from the cursor), credential sync, updates.
- `src/main/runners/` and `src/main/server/` - the user's runners (This Mac's install, control channels) and the Puck server (session, API, the app's socket).
- `src/main/shutdown.ts` - the quit drain (`installQuitDrain`) and the renderer flush request (`flushRenderers`).
- `src/renderer.ts` - the window: DOM lookups, the nav applier, keyboard shortcuts, boot.
  Navigation is the pure state machine in `src/renderer/view-nav.ts` (`navTransition`, `escapeTarget`).
  Element ids follow prefixes: `tb-*` top bar, `oc-*` orchestrator chat, `bd-*` board, `wd-*` work detail (the item sheet), `sf-*` start flow, `fr-*` first run, `sm-*` settings modal, `sec-*` settings sections, `pv-*` provider cards, `rn-*` runners.
  Settings sections are `providers`, `runners`, and `support` (`SettingsSection` in `view-nav.ts`).
- `src/styles/` - one stylesheet per surface (`shell`, `settings`, `work`, `flows`, `chat`, `overlays`).
  The import order in `renderer.ts` preserves the cascade.
- `src/renderer/` - extracted, unit-tested modules; each module's header is its contract.
  The house style: context/elements in, controller out, no `getElementById` inside, jsdom tests.
  `instance-store.ts` is the client projection of daemon state, `instance-sync.ts` keeps it current, and `session-view.ts` renders sessions through `chat-view.ts`.

## Roadmap (deliberately deferred)

- A prepared base image that bakes in the pinned provider packages, replacing the per-start `npm install`.
  The pins in `src/harness/provisioning.ts` are what it would install.
- Ask-answer encoding (keyed by question text, lossy) redesign.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `namikmesic/puck` (the `github` remote, not `origin`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows.
Point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
