# Puck

A macOS desktop client for coding agents. Puck gives Claude Code and Codex
Slack-style, long-lived conversations — each agent is a contact in the
sidebar — while every turn executes inside a Docker container you configure.

Puck is becoming one TypeScript workspace that merges this desktop client with the
multi-agent swarm approach from gimbal, without external harnesses.
The repository holds two npm workspace packages: [`packages/desktop`](packages/desktop)
is the Electron app described below, and [`packages/swarm`](packages/swarm) is
gimbal, imported unchanged (see [NOTICE.md](NOTICE.md)).
The design specification (`data/puck-spec` in the Firstmate home) decides the
architecture that joins them; nothing in this repository wires the two together yet.

## Repository layout

- `package.json` - workspace root. `npm run check` runs typecheck, lint and tests
  for every package; `npm start` and `npm run test:e2e` forward to the desktop app.
- `packages/desktop` - the Electron app (forge + webpack). Its own
  `AGENTS.md` and `DESIGN.md` live next to it.
- `packages/swarm` - gimbal: channels, message router and store, coordinator,
  roles, human director, transcripts, knowledge protocol, vitest smoke test.
- `.github/workflows/ci.yml` - install, typecheck, lint, runner syntax, tests
  on Node 22.

## How it works

- **Agents** are named provider configurations: provider, model, system
  instructions, thinking level, a schema-driven options form (permission /
  sandbox modes, per-tool toggles, limits — declared per provider, rendered
  generically), and an advanced JSON passthrough. Each agent has one
  permanent conversation, persisted as a structured event log and replayed on
  launch — clickable turn cards, tool calls, and sub-agent chats survive
  restarts.
- **Environments** are persistent Docker containers with a host directory
  mounted at `/workspace`. Puck installs the provider CLIs + SDKs into the
  container, deploys a small runner agent, and speaks NDJSON to it over
  `docker exec` stdio. The container is the safety boundary: agents run with
  full tool access inside it, and nothing from the host is writable.
- **Providers** implement one interface (`src/main/providers/`): descriptor
  metadata, OAuth (sign-in windows in-app; tokens encrypted via the OS
  keychain), and container integration (packages, credential mirroring,
  environment). Adding a provider is one descriptor module, one registry
  entry, and one entry in the container runner's `PROVIDERS` table.

Turns stream live: text renders as markdown, tool calls collapse into a
per-turn card that opens full-screen, sub-agents get their own nested chats,
and Claude's mid-turn questions render as answerable cards.

## Prerequisites

- macOS with [Docker](https://docs.docker.com/) running (Docker Desktop or
  colima — bind-mount quirks are handled either way)
- Node 22+

## Run

```bash
npm install
npm start
```

Then, in the app:

1. **Settings → Providers** — connect Claude and/or ChatGPT (OAuth completes
   in an app window; no code pasting).
2. **Settings → Environments** — create an environment (base image or
   Dockerfile) and start it. First start installs the CLIs/SDKs.
3. Pick an agent in the sidebar and say hello.

## Develop

```bash
npm run typecheck   # strict tsc, every package
npm run lint
npm test            # vitest suites, every package
npm run check       # all three, what CI runs
npm run test:e2e    # boots the real app and smoke-checks the UI
```

To work on one package, run its scripts from its directory or with
`npm run <script> --workspace packages/desktop` (or `packages/swarm`).

The container runner lives in `packages/desktop/src/main/runner/runner.js` (plain CommonJS,
bundled as a raw string and docker-cp'd into environments on start). Runner
changes take effect on the next environment restart.

## License

MIT — see [LICENSE](LICENSE).
