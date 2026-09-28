# Changelog

Notable changes to Puck, newest first.
Versions follow `MAJOR.MINOR.PATCH`, and every release is tagged `v<version>` on `main`.
`RELEASE.md` describes how a release is built.

## Unreleased

- GitHub sign-in works through the registered "Puck Agents" GitHub App: a default build offers device-flow sign-in and links to <https://github.com/apps/puck-agents/installations/new>; `PUCK_GITHUB_CLIENT_ID` and `PUCK_GITHUB_APP_SLUG` still point a development build at a test app.
- Providers come in three kinds with one registry: harnesses (Claude Code, Codex), environments (Local Docker, Docker over SSH with a health check that names the SSH problem), and GitHub, signed in through the device flow, with its config repo chosen in **Settings → Providers**; host CLI login files and host environment variables no longer reach containers.
- GitHub sign-in is the device flow through the Puck GitHub App only: the personal access token option is gone from Settings, repositories come from the app's installations, and a token saved by an earlier build is discarded, so GitHub reads as signed out until you sign in again.
- Every provider now reports one status (connected, disconnected, pending or error, with a detail line), and an environment target's health check returns its detail and Docker server version under the same names Settings shows.

## 0.0.1 - unreleased

The first public build of Puck: macOS on Apple silicon, macOS 12 or later.

### What the build contains

- A desktop client for coding agents, with Claude Code and Codex as providers.
- One long-lived, Slack-style conversation per agent, stored as a structured event log and replayed on launch.
- Docker environments: persistent containers with one host folder mounted at `/workspace`.
- Provider sign-in in the system browser with a loopback callback.
  Tokens are encrypted through the macOS Keychain, and Puck refuses to store them in plaintext.
- Disconnect removes Puck's own tokens and the credential copies in running environments.
- Streaming turns with markdown, tool cards, sub-agent chats, and answerable question cards.
- A diagnostic log in the app data folder, bounded to three files of 1 MiB.
- A support-bundle export in Settings → Support: the logs plus a sanitized configuration summary.
- An application icon.

### Known limitations

- Codex sub-agents show their lifecycle only (spawned, running, finished), not their transcript.
- The build is ad hoc signed and not notarized until Developer ID credentials exist (open call C-3).
  macOS asks for a one-time approval in System Settings on first launch.
- There are no automatic updates.
  Replace `Puck.app` by hand, as the README describes.
- The distribution channel is not decided (open call C-2).
  The artifact is a local ZIP with a SHA-256 checksum file beside it.
- Environments run agents as root with full tool access inside the container.
  The mounted workspace folder is writable from the container.
- Delete asks for a second click, but rebuild acts on the first click.
