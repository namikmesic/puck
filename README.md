# Puck

A macOS desktop app that orchestrates coding agents.
You open one environment, talk to its orchestrator, and it works a prioritized backlog by handing items to Claude Code and Codex workers that run in parallel, each on its own git branch.
Environments run in Docker on your runners: this Mac, or any machine you register.

## How it works

- **Definitions live in Git.**
  Agents (`kind: Agent`) and environments (`kind: Environment`) are YAML files in your Puck home: one GitHub repository that holds all your definitions.
  Git is the only way to change them: you commit to the Puck home, and the app never edits a definition; wherever it shows one, **Edit on GitHub** opens its file.
  You start an environment from a definition pinned to a tag, a branch, or a commit, and Puck offers an update when the pin moves.
  `docs/examples/config-repo/` is the starter Puck home, with the JSON Schema that validates it.
- **One orchestrator per environment.**
  Each environment has a single long-lived orchestrator session (Claude Code).
  You tell it what you want; it creates backlog items, assigns them to the environment's agents, answers their questions or passes them to you, and reacts when their work lands.
- **Backlog, workers, branches, pull requests.**
  Every work item runs in its own git worktree and `puck/W-<n>-…` branch inside the environment.
  Its result is commits, a diff stat, and a summary; publishing pushes the branch and opens or updates a draft pull request.
  When an environment opts in, issues carrying its intake label become items; pull requests close their issues, and CI results and review feedback reach the orchestrator.
- **Work continues with the app closed.**
  Inside each environment's container a daemon, `puckd`, owns everything: provisioning, sessions, the backlog, the scheduler, transcripts, and publishing.
  The app is a client that attaches to it and replays what it missed.
- **Runners host environments.**
  A runner is `puck-runner` installed on a machine with Docker: this Mac (one click in **Settings → Runners**), or any Linux machine you register with **Add runner**, which shows copy-paste commands like GitHub's self-hosted runners.
  The app reaches a runner through the Puck server's end-to-end encrypted relay, and this Mac's runner over a local socket; see `src/puck-runner/README.md`.
  The app itself never runs `docker`.
- **The Puck server** holds your Puck account (you sign in with GitHub in the system browser), your runners, the index of your environments, and the Puck GitHub App's secrets.
  It gives each environment one-hour GitHub App installation tokens for its repositories, so agents can push and open pull requests while your laptop is closed.
  For now you run it yourself with Docker Compose (**Run the Puck server locally**).
- **Harness sign-in** for Claude Code and Codex happens in the system browser with a loopback callback, RFC 8252 style.
  Tokens are encrypted via the OS keychain, and Puck keeps the environments' copies in sync.

The window shows one environment at a time, in two views you switch between (⌘1 and ⌘2): Chat, the conversation with the orchestrator, and Board, the work items in one column per stage from Backlog to Done.
An item's detail opens in a side sheet over either view.
Turns stream live: text renders as markdown, tool calls collapse into a per-turn card, sub-agents get their own nested chats, and questions render as answerable cards.

## Requirements

- A Mac with Apple silicon, running macOS 12 (Monterey) or later.
- A Puck account through GitHub, and a runner:
  - a GitHub account, with the Puck GitHub App installed on the accounts that own your repositories, and a Puck home holding your definitions (Puck can initialize one for you);
  - a Puck server to sign in to, which for now you run locally (**Run the Puck server locally**);
  - a runner: this Mac with [Docker](https://docs.docker.com/) running (Docker Desktop or colima), or a Linux x64 or ARM64 machine with Docker Engine 24 or newer.
- A Claude account for the orchestrator; a ChatGPT account too if your agents use Codex.

## Install

Release 0.1.0 ships as a ZIP file with a checksum file beside it.
The distribution channel is still an open release decision (C-2), so the two files are handed over directly.

1. Put `Puck-darwin-arm64-0.1.0.zip` and `Puck-darwin-arm64-0.1.0.zip.sha256` in the same folder.
2. Verify the download in Terminal:

   ```bash
   shasum -a 256 -c Puck-darwin-arm64-0.1.0.zip.sha256
   ```

   The output must end with `OK`.
3. Double-click the ZIP.
   macOS extracts `Puck.app`.
4. Drag `Puck.app` into `/Applications`.

## First run

Release 0.1.0 is ad hoc signed and not notarized, because the Developer ID credentials are an open release decision (C-3).
macOS blocks the first launch with a message that Puck could not be verified.
Approve it once:

1. Double-click `Puck.app`, then click **Done** on the warning.
2. Open **System Settings → Privacy & Security**, scroll to the Security section, and click **Open Anyway** next to the Puck message.
3. Confirm with your password or Touch ID.
   Puck opens, and later launches need no approval.

The Terminal alternative removes the quarantine flag instead:

```bash
xattr -d com.apple.quarantine /Applications/Puck.app
```

Then Puck walks you through six steps, each also reachable later from Settings:

1. **Sign in with GitHub.**
   The sign-in opens in your default browser and goes through the Puck server; the app keeps only its Puck session.
2. **Install Puck on an account**: the GitHub App, on the accounts that own the repositories your environments use.
3. **Connect your Puck home.**
   Connect a repository that already holds your definitions, or initialize a new home: create an empty repository on GitHub (Puck opens GitHub's page with `puck-home` and private visibility filled in), pick it and the repository your first environment works on, and Puck commits the starter home into it as one commit tagged `v1.0.0`.
   Puck refuses to connect a repository without `agents/` or `environments/` at its root, and to initialize one that already has files.
4. **Connect Claude Code.**
   The orchestrator needs it; connect ChatGPT as well in **Settings → Providers** if your agents use Codex.
5. **Set up a runner**: **This Mac** in one click, or **Add runner** for another machine.
6. **Start an environment**: pick a definition at a tag, branch, or commit, and a runner.
   The first start pulls or builds the image and installs the harness CLIs into the container, which takes a few minutes.

Then tell the orchestrator what you want done.

## What agents can reach

Every environment is a container on a runner, and the container is the safety boundary.

- **No host folders.**
  Nothing from the runner machine is mounted: no home folder, no workspace folder, no Docker socket.
  Files reach the container as a tar stream.
- **Two volumes per environment.**
  `puck-<id>-ws` holds the repositories at `/workspace`, cloned inside the container; `puck-<id>-data` holds the daemon's state at `/puck`.
  Rebuild recreates the container and keeps both, so all work survives it.
- **Agents run as the unprivileged `puck` user** (uid 10001), with full tool access inside the container and Docker's default network access, so they can install packages and call APIs.
- **Agents can read** the harness credential files (Claude Code, Codex) and the environment's secrets, because the CLIs and their tools need them.
- **Agents cannot read** the GitHub token or the daemon's state and transcripts.
  The daemon runs as root and does all git pushes and GitHub calls itself; pushes are limited to `puck/*` branches, and the token is a one-hour installation token scoped to the environment's repositories.
- **A runner is trusted with its environments.**
  Whoever is root on a runner machine, or in its `docker` group, can read everything its environments hold, including their short-lived GitHub tokens.
  Register runners only on machines you control; `src/puck-runner/README.md` covers running the runner as a dedicated user.

## Where Puck keeps its data

Everything the app stores on your Mac is in one folder: `~/Library/Application Support/Puck`.
**Settings → Support** shows the exact path.

| Path | Holds |
| --- | --- |
| `puck-providers.json` | Provider settings: the Puck home (stored as `configRepo`) |
| `puck-session.bin` | Your Puck session (signed in with GitHub), encrypted through the macOS Keychain |
| `puck-instances.json` | Per environment: the last event seen (for replay), its definition pin, and the environment on screen |
| `puck-runners.json` | Runner key fingerprints first seen, and the This Mac runner's location |
| `r/<eight hex digits>/` | The This Mac runner for one Puck account: its release, registration, key, local socket and logs |
| `puck-defs-cache/<commit>.json` | Cached Puck home files for one commit; safe to delete |
| `claude-oauth.bin`, `codex-oauth.bin` | Harness tokens, encrypted through the macOS Keychain |
| `logs/puck.log`, `logs/puck.log.1`, `logs/puck.log.2` | The diagnostic log: three files of at most 1 MiB each |
| `Cache`, `Local Storage`, and similar folders | Electron's own browser data, including composer drafts |

Everything about the work itself (backlog, sessions, transcripts, events, secrets) lives in the environment's `puck-<id>-data` volume on its runner.
Both volumes can be backed up with standard Docker tooling.

Outside that folder, this Mac's runner creates:

- A LaunchAgent at `~/Library/LaunchAgents/com.puck.runner.<eight hex digits>.plist` when This Mac is set up as a runner. The same eight digits name its `r/` directory.
- For each environment it hosts: a container `puck-<environment id>` labeled `puck=instance`, the volumes `puck-<environment id>-data` and `puck-<environment id>-ws`, and `puck-img-<environment id>` when the definition builds a Dockerfile.

Puck keeps environments until you delete them (release decision C-8).
Delete asks for a second click before it acts.

### Data from Puck 0.0.1

Puck 0.1.0 does not read or migrate anything the 0.0.1 build stored: agents, environments, conversations, and resume ids are ignored and never deleted.
Your Claude and Codex sign-ins carry over.
To clean up by hand, quit Puck and remove the old files and containers:

```bash
cd ~/Library/Application\ Support/Puck
rm -rf puck-agents.json puck-environments.json puck-resume.json puck-convos puck-convos.json env-secrets-*.bin
docker rm -f $(docker ps -aq --filter label=puck=environment)
```

The old build's workspace folders (by default `~/puck-workspaces`) are yours to keep or delete.

## Sign out

**Settings → Providers → Disconnect** signs a harness out of Puck (release decision C-7):

- Puck deletes its own token file for that provider (`claude-oauth.bin` or `codex-oauth.bin`).
- Puck removes the credential file from the environment on screen, and from every other environment the next time you open it.
- A sign-in still in progress is canceled.

Disconnect does not sign you out of the provider in your browser.
It also leaves the provider CLI's own files in your home folder alone: `~/.claude/.credentials.json` and `~/.codex/auth.json`.
Puck never copies those files into an environment, and host environment variables such as `ANTHROPIC_API_KEY` do not reach containers either.
To give an environment an API key, declare it as a secret in its definition and enter the value when you start it.

**Sign out of Puck** in the GitHub card ends your Puck session on the server.
Your environments keep running on their runners.

## Wipe everything

To remove every trace of Puck:

1. In Puck, delete each environment from the environment switcher.
   This removes its container, both volumes, and its image on the runner.
2. If This Mac is a runner, remove it under **Settings → Runners**.
   That uninstalls the LaunchAgent and keeps the containers it created. A runner on another machine is unchanged; `src/puck-runner/README.md` covers removing it there.
3. Quit Puck.
4. Delete the data folder:

   ```bash
   rm -rf ~/Library/Application\ Support/Puck
   ```

5. Optional, for environments you did not delete in step 1, or that This Mac kept: remove them by hand.

   ```bash
   docker rm -f $(docker ps -aq --filter label=puck=instance)
   docker volume rm $(docker volume ls -q --filter label=puck=instance)
   docker image ls --format '{{.Repository}}' | grep '^puck-img-' | xargs docker rmi
   ```

## Remove Puck

Move `/Applications/Puck.app` to the Trash.
The data folder stays, so a later install continues where you left off.
Follow **Wipe everything** when you want the data gone too.

## Get support

Puck keeps a diagnostic log on your Mac and sends nothing anywhere by itself.
When something goes wrong:

1. Open **Settings → Support** and click **Export support bundle…**.
2. Save the ZIP where the dialog suggests, or anywhere else.
   Inside are `README.txt`, `summary.json`, and a `logs/` folder.
   The summary holds ids, names, versions, and states of your providers, runners, and environments, plus the data folder path.
   It holds no tokens, secret values, environment-variable values, prompts, or transcripts.
3. Open an issue at <https://github.com/namikmesic/puck/issues>, describe what you did and what you expected, and attach the bundle.

## Update

Release 0.1.0 does not update itself (release decision C-9).
To move to a newer version:

1. Download the new ZIP and its checksum file, and verify the checksum as in **Install**.
2. Quit Puck.
   Your environments keep working on their runners.
3. Replace `/Applications/Puck.app` with the new one.
4. Approve the first launch again when the new build is still ad hoc signed.
5. When the new build carries a newer environment daemon, the top bar offers **Daemon update** for each environment: after running turns finish, or at once.

Runners update themselves from the Puck server (`src/puck-runner/README.md`).
Your sign-ins stay, because they live in the data folder and not in the app.
`CHANGELOG.md` lists what each version contains, and every release is tagged `v<version>`.

## Develop

Node 22, the major pinned in `.nvmrc`, is required (builds refuse any other).

```bash
npm install
npm start
```

`npm start` uses your real app data folder and macOS Keychain.
For any automated test or live check, launch isolated instead:

```bash
npm run start:isolated                                   # a fresh data folder under the OS temp dir
PUCK_ISOLATED_DIR=/path/to/dir npm run start:isolated    # a data folder you choose (and remove)
npm run start:isolated -- -- --remote-debugging-port=9222  # attach playwright-core over CDP
```

Isolated mode (`PUCK_ISOLATED=1`) keeps every app data path in that folder, encrypts secrets with Electron's mock keychain so macOS is never asked, and opens the window without taking focus.
Setting up This Mac is refused in that launch; `src/puck-runner/README.md` says why.
With `PUCK_ISOLATED_BROWSER=off` as well, signing in to Puck does not open the system browser; the check completes the sign-in from the page URL the bridge returns.
Never replace `HOME` to isolate Puck: macOS then finds no keychain and pops up a "Reset To Defaults" dialog on the desktop.

```bash
npm run typecheck     # strict tsc
npm run lint
npm test              # vitest unit suites
npm run test:e2e      # boots the real app isolated and smoke-checks the UI
npm run schema        # regenerates both committed puck.schema.json copies (CI fails on drift)
npm run build:server  # the Puck server as one file, .webpack/server/puck-server.js
npm run build:daemon  # the environment daemon, .webpack/daemon/puckd.js
npm run build:runner  # puck-runner bundle; see src/puck-runner/README.md
npm run package:runner
npm run test:docker   # real containers, runners and a server; needs a Docker engine
npm run make          # the release ZIP and its checksum, see RELEASE.md
```

The environment daemon, `puckd` (`src/daemon/`), is a second webpack build that the app embeds as a string (`src/main/daemon-source.ts`) and hands to runners; a daemon change reaches an environment through **Daemon update**.

`RELEASE.md` covers versioning, the build target, signing and notarization, and the release checklist.

## Run the Puck server locally

The Puck server (`src/server/`) is the backend that runners register with and that holds GitHub sign-in.
The app signs in to it and reaches runners through it, at `http://localhost:8765` unless `PUCK_SERVER_URL` says otherwise.
There is no public deployment yet: run it on your own machine with Docker Compose.

```bash
docker compose up -d --wait              # (re)builds the puck-server image, waits until healthy
curl http://localhost:8765/healthz       # {"ok":true,...}
docker compose down                      # stop; add -v to also delete the store volume
```

`up` rebuilds the image every time, from the build cache when nothing changed, so it always runs the server of your checkout.
This is a development server (`PUCK_DEVELOPMENT=true`): its image carries that version's runner packages for Linux x64, Linux ARM64 and macOS on Apple silicon, and the server offers them at `GET /v1/runner/releases`, so **This Mac** and the Add runner dialog work out of the box.
The first build downloads the three pinned Node runtimes the packages bundle and checks their sha256.
A server outside development mode hosts no runner packages.

Its store lives on the `puck-server-data` volume, and it listens on `127.0.0.1:8765` only (`PUCK_SERVER_LOCAL_PORT` changes the port).
Without configuration it starts with GitHub disabled.
To enable GitHub sign-in, copy `src/server/puck-server.env.example` to `puck-server.env` (git-ignored) and fill in your GitHub App's id, client id, client secret and private key.
`src/server/README.md` lists every setting, the endpoints, and how secrets reach the container.

A runner on another machine must reach the server at the URL it registers with. On that machine `localhost` is the machine itself, so set `PUCK_SERVER_URL` to an address it can reach before registering it. This Mac works as a runner on the local server when it is already installed, or when the server publishes a macOS ARM64 package.

## License

MIT - see [LICENSE](LICENSE).
