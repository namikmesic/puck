# Working on Puck

Guidance for coding agents (and humans) contributing to this repo.

## Checks that must stay green

```bash
npm run typecheck && npm run lint && npm test
```

Lint is at **zero problems** - keep it there.
CI runs these plus `node --check src/main/runner/runner.js` and `npm run package`.

## Things that bite

- **Builds run on Node 22 only**, the major pinned in `.nvmrc` and mirrored by `engines` in `package.json`.
  CI reads `.nvmrc`.
  `npm run package` and `npm run make` go through `scripts/forge.mjs`.
  The wrapper refuses other Node majors and fails when Forge exits 0 without a fresh app bundle under `out/`.
  Forge has done exactly that on a newer Node.
  CI installs with `npm ci`, so regenerate a drifted lockfile with the pinned Node's npm (`npm install --package-lock-only`).
  `test/unit/build-checks.test.ts` keeps the pin, the CI workflow, and the scripts in agreement.
- **The container runner** (`src/main/runner/runner.js`) is plain CommonJS deployed INTO Docker containers.
  It cannot import host code, and changes only take effect after an environment restart or rebuild from Settings.
  Its `PROVIDERS` table mirrors the host registry.
  `test/unit/runner-source.test.ts` enforces the sync from the live registry, so a new provider without a runner entry fails the suite.
  The wire contract (opcodes and protocol revision) is declared twice: `WIRE` in `src/main/runner.ts` and `OP`/`RV` at the top of runner.js.
  The same test asserts they match.
  Bump the revision whenever the turn-request wire format grows.
- **IPC channels** live in one table: `src/harness/channels.ts` (`CHANNELS`).
  `preload.ts` and `src/index.ts` both import it.
  The `satisfies` clause keeps it total over `PuckBridge`, and `test/unit/channels.test.ts` asserts main registers a handler for every entry.
  Adding a bridge method = bridge type + CHANNELS entry + preload line + handler.
  Push channels from main to the renderer (`EVENT_CHANNEL`, `ENV_EVENT_CHANNEL`, `FLUSH_CHANNEL`, `FLUSHED_CHANNEL`) sit outside the table.
  The `satisfies` clause excludes their bridge methods by name.
- **Environment readiness is Puck state, not Docker liveness.**
  `EnvLifecycle` (`src/harness/bridge.ts`) has the states stopped, starting, ready, stopping, and failed.
  The reducer and its invariants live in `src/main/env-lifecycle.ts`: `ready` is reachable only through the `probing-runner` stage, after the runner handshake.
  `environments.ts` owns the state and streams every stage through `onLifecycle`, and `backend.ts` gates turns on `lifecycle(id).status === 'ready'`.
  A container found running at boot is re-provisioned through the normal start before it is trusted.
  Credential purge and push still follow Docker liveness, because the file must land wherever a container exists.
  Labels and messages shared by both processes live in `src/harness/lifecycle.ts`.
  Reserve "is Docker running?" for a failed `dockerHealth()` check, never for a slow pull or run.
- **Docker CLI discovery** (`src/main/docker-discovery.ts`): Finder launches do not inherit the shell PATH.
  The binary is resolved in this order: configured path (`PUCK_DOCKER_BIN`), well-known install locations, inherited PATH, login-shell probe.
  The not-found error lists what was searched.
  Everything goes through `docker-client.ts` (argv, timeouts, abort signal, line streaming), and `TIMEOUTS` in `environments.ts` is the one table.
- **Provider packages are pinned** (`PinnedPackage` in `src/main/providers/types.ts`).
  `provisioning.ts` checks the installed versions read-only, installs the exact pins only on drift, and verifies the result on every start.
  With auto-install on, any drift fails the start, and with it off only a missing SDK fails.
  Bump a pin deliberately, together with any runner.js adaptation.
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
  The renderer flush runs over `FLUSH_CHANNEL` into `session-store.flushPending`, which saves debounced conversations and the composer draft.
  `jsonstore.flushWrites` awaits the queued writes.
  Then quit re-issues, bounded by a timeout.
  Anything that must survive quit goes through `jsonstore` in main or the session store's `persist` in the renderer.
- **Secrets** (`src/main/secrets.ts`) have one backend, Electron safeStorage.
  `saveSecret` throws `SecureStorageUnavailableError` when the keychain cannot encrypt.
  There is no plaintext fallback, and a file that does not decrypt reads as absent.
  The Settings copy in `index.html` states this behavior.
- **Persisted stores** live in Electron `userData`.
  Migrate, don't break: new fields get `??` defaults at load, and legacy keys are dual-read, never rewritten in place.
  Layout: `puck-agents.json`, `puck-environments.json`, `puck-resume.json`, `puck-convos/<agentId>.json` (one file per agent), and encrypted `*.bin` secrets.
  Resume ids are keyed `agentId@envId`, scoped to the environment because a rebuilt container loses its transcripts.
  A legacy single-blob `puck-convos.json` is still read.
  Conversation files carry a format version `v`.
  See `ConversationData` in `src/harness/bridge.ts` for the persisted event dialect and its append-only rule.
- **Per-agent provider options** are schema-driven.
  Adding one is a single `ProviderOption` descriptor in the provider module (`configOptions`).
  The editor UI, validation, persistence, and wire transport all follow the schema (`src/harness/options.ts`).
  Only options needing cross-key coupling get a line in the provider's `compileSettings`.
  A test asserts every overridden option reaches the compiled output.
  Values are sparse (only user overrides are stored and compiled), and the runner base encodes the defaults.
- **Driving the running app for verification**: launch with `npm start -- -- --remote-debugging-port=9222` and attach playwright-core over CDP.
  Never call `page.setViewportSize` on the live app.
  The emulation override outlives the script and breaks the real window's layout.
  Use `Emulation.setDeviceMetricsOverride` inside try/finally with `clearDeviceMetricsOverride` instead.
- **Provider logins** run in the system browser (RFC 8252).
  The authorize URL goes through `shell.openExternal`.
  The redirect lands on the shared loopback listener `src/main/providers/loopback.ts` (127.0.0.1 only, one request, state check, timeout).
  Claude binds an ephemeral port (`http://localhost:<port>/callback`, the shape Claude Code registers).
  Codex uses its registered fixed port 1455.
  There is no embedded sign-in window or cookie partition - logout only clears Puck's own token store.
  Logout is a fence, implemented by `createOAuthAccount` in `src/main/providers/oauth.ts`.
  It advances an epoch, so an exchange or refresh already in flight drops its result (`LogoutFence`).
  Adoption of container credentials requires a signed-in account.
  `environments.purgeCredentials` removes the mirrored file from running containers, and a stopped container is cleaned on its next start.
  Any new path that writes tokens asynchronously must take a fence first.
- **colima** does not share `$HOME` with containers, so credential files reach containers via `docker cp` only.
  Host dirs are deliberately not mounted (sandbox escape via CLI hook files).

## Adding a provider - checklist

1. Descriptor module `src/main/providers/<id>.ts`: models, thinking levels, `configOptions` schema, `compileSettings`, capabilities, auth, and container integration (CLI/SDK packages, credential paths, forwarded env).
2. OAuth module (transport and token mapping).
   Shared PKCE and token-store helpers live in `oauth.ts`.
3. Registry entry in `src/main/providers/index.ts`.
4. Runner side: `PROVIDERS` entry and `run<Name>` function in `src/main/runner/runner.js`.
   It is untyped JS, so keep it thin and translate SDK events into `HarnessEvent`s.
5. Run the suite.
   `runner-source.test.ts` and `provider-settings.test.ts` are registry-derived and will point at anything missed.

## Terminology

- *Agent* = a named provider configuration (`AgentConfig`).
  The Task-tool sub-agents inside a chat are "sub-agents", and the container-side process is "the runner".
- `AgentConfig.options` = sparse schema-option overrides.
  `TurnRequest.settings` = the *compiled* SDK fragment, whose wire field names are frozen until the next protocol-revision bump.
  The app's Settings modal is UI-level and unrelated.
  On disk, pre-rename records carry `settings`/`thinking` keys, dual-read at load and written back with the new names.
- `AgentConfig.effort` compiles to Claude's `effort` / Codex's `model_reasoning_effort`.
  The `thinking` *event kind* is the UI indicator.

## Layout

- `src/index.ts` - main process: window hardening, IPC handler registration, and quit drain wiring.
  Ids, strings, and configs are validated in `src/main/ipcguard.ts`.
  The conversation payload codec lives with its format in `src/main/conversations.ts`: strict `fromIpc` on save, lenient `normalize` on load, one shared field assembly.
- `src/harness/` - the renderer↔main contract.
  Keep this directory free of node/electron imports.
  `bridge.ts` holds the types and `PuckBridge`, `channels.ts` the IPC channel table, `types.ts` the `HarnessEvent` wire protocol.
  `options.ts` holds the provider option schema and `ipc.ts` the `IpcHarness`.
- `src/main/providers/` - the Provider interface and registry.
  See its README header comment for what a new provider needs.
- `src/main/backend.ts` - turn orchestration: active agent × environment, resume-id map, stale-resume retry state machine.
- `src/main/environments.ts` - Puck lifecycle state, Docker lifecycle, bootstrap, credential and secret injection, credential purge on logout (all registry-driven, no provider names).
- `src/main/runner.ts` - docker-exec stdio bridge (handshake, watchdog, stderr diagnostics, `WIRE` contract).
- `src/main/shutdown.ts` - the quit drain (`installQuitDrain`) and the renderer flush request (`flushRenderers`).
- `src/renderer.ts` - the wiring layer: DOM lookups, nav applier and settings modal, composer/turn loop, settings card grids, shortcuts, boot.
  `nav()` is the single entry point for navigation.
  Element ids follow prefixes: `a-*` agent editor, `d-*` environment editor, `sec-*` settings sections, `aed-*` agent-editor cards, `sm-*` settings modal.
  Settings sections are `agents`, `providers`, `envs`, and `support` (`SettingsSection` in `nav.ts`).
- `src/styles/` - one stylesheet per surface (`shell`, `settings`, `editors`, `chat`, `overlays`).
  The import order in `renderer.ts` preserves the cascade.
- `src/renderer/` - extracted, unit-tested modules.
  The house style (proven by `options.ts`): context/elements in, controller out, no `getElementById` inside, jsdom tests.
  - `session-store.ts` - the Session model: conversations, sub-agent children, spawn/teardown, rename sync, debounced persistence, the quit flush.
  - `chat-view.ts` - message rows, Slack grouping, streaming turns (markdown committer, tool cards, sub-agents behind a `spawnChild` seam), replay (`REPLAY_WINDOW`), full-turn overlay.
  - `ask-card.ts` - the mid-turn question card (live and replay variants, submit hook rejects to re-arm).
  - `roster.ts` - the sidebar list: agent rows, unread/running dots, nested sub-agent chats, rAF-coalesced `render()`.
  - `palette.ts` - the Cmd+K palette: agent switcher and history search.
  - `settings/agent-editor.ts` - segmented pickers, dirty tracking, section rail and scroll-spy, epoch-guarded async population, save.
  - `settings/env-editor.ts` - the environment detail page: config form, env-var/secret kv lists, header with the shared op rail, save.
  - `settings/cards.ts` and `settings/env-rail.ts` - card-grid kit and the ONE environment op ladder (list cards and detail header share it).
  - `env-progress.ts` - lifecycle presentation: status chip, "stage · elapsed" line, and composer gate text.
    Its tracker merges pushed lifecycle events and runs the elapsed-time ticker.
  - `settings/support.ts` - the Support section: version, data paths, and the support-bundle export button.
  - `nav.ts` - pure nav state machine (`navTransition`, `escapeTarget`).
  - `options.ts`, `util.ts`, `dom.ts`, `format.ts`, `markdown.ts`.

## Roadmap (deliberately deferred)

- Runner as a typed per-provider adapter bundle (retires the hand-synced `PROVIDERS` table structurally).
- A prepared base image that bakes in the pinned provider packages, replacing the per-start `npm install`.
  The pins in `provisioning.ts` are what it would install.
- Wire envelope `{op, req}` at the next protocol-revision bump.
- Ask-answer encoding (keyed by question text, lossy) redesign.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows.
Point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
