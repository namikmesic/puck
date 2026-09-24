# Puck

A macOS desktop client for coding agents.
Puck gives Claude Code and Codex Slack-style, long-lived conversations, with each agent a contact in the sidebar.
Every turn executes inside a Docker container you configure.

## How it works

- **Agents** are named provider configurations: provider, model, system instructions, thinking level, a schema-driven options form, and an advanced JSON passthrough.
  The options form covers permission and sandbox modes, per-tool toggles, and limits, declared per provider and rendered generically.
  Each agent has one permanent conversation, persisted as a structured event log and replayed on launch.
  Clickable turn cards, tool calls, and sub-agent chats survive restarts.
- **Environments** are persistent Docker containers with a host directory mounted at `/workspace`.
  Puck installs the provider CLIs and SDKs into the container, deploys a small runner agent, and speaks NDJSON to it over `docker exec` stdio.
  The container is the safety boundary: agents run with full tool access inside it, and the workspace folder is the only host folder they reach.
- **Providers** implement one interface (`src/main/providers/`): descriptor metadata, OAuth, and container integration (packages, credential mirroring, environment).
  Sign-in happens in the system browser with a loopback callback, RFC 8252 style, and tokens are encrypted via the OS keychain.
  Adding a provider is one descriptor module, one registry entry, and one entry in the container runner's `PROVIDERS` table.

Turns stream live.
Text renders as markdown, tool calls collapse into a per-turn card that opens full-screen, and sub-agents get their own nested chats.
Claude's mid-turn questions render as answerable cards.

## Requirements

- A Mac with Apple silicon, running macOS 12 (Monterey) or later.
- [Docker](https://docs.docker.com/) running: Docker Desktop or colima.
- A Claude account, a ChatGPT account, or both.

## Install

Release 0.0.1 ships as a ZIP file with a checksum file beside it.
The distribution channel is still an open release decision (C-2), so the two files are handed over directly.

1. Put `Puck-darwin-arm64-0.0.1.zip` and `Puck-darwin-arm64-0.0.1.zip.sha256` in the same folder.
2. Verify the download in Terminal:

   ```bash
   shasum -a 256 -c Puck-darwin-arm64-0.0.1.zip.sha256
   ```

   The output must end with `OK`.
3. Double-click the ZIP.
   macOS extracts `Puck.app`.
4. Drag `Puck.app` into `/Applications`.

## First run

Release 0.0.1 is ad hoc signed and not notarized, because the Developer ID credentials are an open release decision (C-3).
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

Then, in the app:

1. **Settings → Providers**: connect Claude, ChatGPT, or both.
   The sign-in opens in your default browser, where your existing sessions live, and completes when the browser redirects back to Puck.
2. **Settings → Environments**: create an environment (base image or Dockerfile), choose its workspace folder, and start it.
   The first start installs the CLIs and SDKs into the container, which takes a few minutes.
3. Pick an agent in the sidebar and say hello.

## What the container can write

An environment runs agents as root with full tool access inside its container.
Read this before you choose a workspace folder.

- **The workspace folder is writable.**
  The folder you set as the workspace path is mounted read-write at `/workspace`.
  An agent can create, change, and delete any file in it, including hidden files and `.git`.
  Give an agent a folder you can afford to lose, or a checkout whose remote holds everything you need.
- **The container filesystem is writable.**
  An agent can install tools and change anything inside the container.
  Rebuild resets the container to its image.
- **The network is reachable.**
  The container has Docker's default network access, so an agent can download packages and call APIs.
- **Secrets and credentials are readable inside the container.**
  Environment secrets and the provider credential files that Puck copies in are visible to the agent.
- **Nothing else on your Mac is mounted.**
  Your home folder, `~/.claude`, `~/.codex`, and Puck's own data folder stay outside the container.

When you leave the workspace path empty, Puck uses `~/puck-workspaces/<environment id>`.
Release 0.0.1 keeps these container defaults (release decision C-6).

## Where Puck keeps its data

Everything Puck stores on your Mac is in one folder: `~/Library/Application Support/Puck`.
**Settings → Support** shows the exact path.

| Path | Holds |
| --- | --- |
| `puck-agents.json` | Agents: name, provider, model, system instructions, options |
| `puck-environments.json` | Environments: name, image, Dockerfile, workspace path, environment variables |
| `puck-resume.json` | Provider session ids, so a conversation continues after a restart |
| `puck-convos/<agent id>.json` | One conversation transcript per agent |
| `claude-oauth.bin`, `codex-oauth.bin` | Provider tokens, encrypted through the macOS Keychain |
| `env-secrets-<environment id>.bin` | Environment secrets, encrypted the same way |
| `logs/puck.log`, `logs/puck.log.1`, `logs/puck.log.2` | The diagnostic log: three files of at most 1 MiB each |
| `Cache`, `Local Storage`, and similar folders | Electron's own browser data |

Outside that folder, Puck creates:

- Docker containers named `puck-env-<environment id>`, labeled `puck=environment`.
- Docker images named `puck-img-<environment id>` for environments built from a Dockerfile.
- Workspace folders you chose, or `~/puck-workspaces/<environment id>` by default.

Puck keeps conversations and environments until you delete them (release decision C-8).
Delete asks for a second click before it acts.
Rebuild acts on the first click and resets the container, so stop and think before you click it.

## Sign out

**Settings → Providers → Disconnect** signs a provider out of Puck (release decision C-7):

- Puck deletes its own token file for that provider (`claude-oauth.bin` or `codex-oauth.bin`).
- Puck removes the credential file it copied into every running environment.
  A stopped environment is cleaned on its next start.
- A sign-in still in progress is canceled.

Disconnect does not sign you out of the provider in your browser.
It also leaves the provider CLI's own files in your home folder alone: `~/.claude/.credentials.json` and `~/.codex/auth.json`.
When those files exist, Puck copies them into an environment on every start.
Remove them too when you want a container with no credentials at all.

## Wipe everything

To remove every trace of Puck's configuration and conversations:

1. In Puck, open **Settings → Environments** and delete each environment.
   This removes its container, its image, and its secrets.
2. Quit Puck.
3. Delete the data folder:

   ```bash
   rm -rf ~/Library/Application\ Support/Puck
   ```

4. Optional: delete the workspace folders you no longer need, for example `~/puck-workspaces`.
5. Optional, when you skipped step 1: remove the containers and images by hand.

   ```bash
   docker rm -f $(docker ps -aq --filter label=puck=environment)
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
   The summary holds ids, names, versions, states, and key names, plus the data folder and workspace paths.
   It holds no tokens, secret values, environment-variable values, prompts, or transcripts.
3. Open an issue at <https://github.com/namikmesic/puck/issues>, describe what you did and what you expected, and attach the bundle.

## Update

Release 0.0.1 does not update itself (release decision C-9).
To move to a newer version:

1. Download the new ZIP and its checksum file, and verify the checksum as in **Install**.
2. Quit Puck.
3. Replace `/Applications/Puck.app` with the new one.
4. Approve the first launch again when the new build is still ad hoc signed.
5. In **Settings → Environments**, restart each running environment.
   The runner inside a container updates only when the environment restarts.

Your agents, environments, conversations, and sign-ins stay, because they live in the data folder and not in the app.
`CHANGELOG.md` lists what each version contains, and every release is tagged `v<version>`.

## Develop

Node 22, the major pinned in `.nvmrc`, is required (builds refuse any other).

```bash
npm install
npm start
```

```bash
npm run typecheck   # strict tsc
npm run lint
npm test            # vitest unit suites
npm run test:e2e    # boots the real app and smoke-checks the UI
npm run make        # the release ZIP and its checksum, see RELEASE.md
```

The container runner lives in `src/main/runner/runner.js`.
It is plain CommonJS, bundled as a raw string and docker-cp'd into environments on start.
Runner changes take effect on the next environment restart.

`RELEASE.md` covers versioning, the build target, signing and notarization, and the release checklist.

## License

MIT - see [LICENSE](LICENSE).
