# Changelog

Notable changes to Puck, newest first.
Versions follow `MAJOR.MINOR.PATCH`, and every release is tagged `v<version>` on `main`.
`RELEASE.md` describes how a release is built.

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
