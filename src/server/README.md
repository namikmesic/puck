# Puck server

The hosted backend for Puck.
It signs users in with GitHub, keeps the registry of runners (machines users register to host their environments), keeps the index of environments and the repositories each may touch, mints short-lived GitHub installation tokens for them, and relays end-to-end encrypted channels between the app and runners.
It runs no agents and stores no transcripts, definitions, harness credentials, or environment secrets.

Runners (`puck-runner`, `src/puck-runner/`) register with it and connect to it; the app does not talk to it yet, and its client comes later.

## Run it

Locally, with Docker Compose from the repository root (see the root README):

```bash
docker compose up -d --wait
curl http://localhost:8765/healthz
```

As a plain image:

```bash
docker build -f src/server/Dockerfile -t puck-server .
docker run -p 8080:8080 -v puck-server-data:/data -e PUCK_SERVER_URL=https://puck.example.com puck-server
```

The image's health check uses `--start-interval`, which needs Docker Engine 25 or newer, and `compose.yaml` marks its env file optional, which needs Compose 2.24 or newer.

Without Docker: `npm run build:server && node .webpack/server/puck-server.js`.
The bundle needs only Node 22 (it uses the built-in `node:sqlite`).
`node puck-server.js health` probes a running server and exits 0 when it is healthy; the image's health check uses it.

## Configure it

Everything comes from the environment; nothing secret is in the image.
Each secret can be given as `NAME` or as `NAME_FILE`, a path to a file holding it, for secret stores and mounted secrets.

| Variable | Meaning |
| --- | --- |
| `PUCK_SERVER_URL` | Public base URL. Apps and runners use it, the GitHub callback is built from it, and runner assertions must name it. |
| `PUCK_SERVER_HOST`, `PUCK_SERVER_PORT` | Listen address (default `127.0.0.1:8080`; the image listens on `0.0.0.0:8080`). |
| `PUCK_SERVER_DB` | SQLite file (the image uses `/data/puck-server.db`). |
| `PUCK_SERVER_TOKEN_KEY[_FILE]` | 32 random bytes, base64. Encrypts users' GitHub tokens at rest. Required when GitHub sign-in is on. |
| `PUCK_GITHUB_APP_ID`, `PUCK_GITHUB_CLIENT_ID` | The GitHub App's id and OAuth client id. |
| `PUCK_GITHUB_APP_SLUG` | Optional. When set, the server can link to the App's install page. |
| `PUCK_GITHUB_CLIENT_SECRET[_FILE]` | The App's client secret, for the web-flow code exchange. |
| `PUCK_GITHUB_PRIVATE_KEY[_FILE]` | The App's private key: PEM, or PEM base64-encoded on one line. Signs App JWTs. |
| `PUCK_GITHUB_API_URL`, `PUCK_GITHUB_WEB_URL` | GitHub endpoints (default github.com). Optional. |
| `PUCK_RUNNER_DOWNLOADS` | Directory of runner tarballs, `<version>/puck-runner-<os>-<arch>-<version>.tar.gz`: the layout `npm run package:runner` writes under `out/puck-runner/`. |
| `PUCK_RUNNER_MIN_VERSION` | Runners older than this are refused. |

GitHub sign-in needs the App id, client id, client secret, and private key together, plus `PUCK_SERVER_TOKEN_KEY`. With none of those four App settings the server still starts, and GitHub routes answer 503 `github-not-configured`. Setting some of them but not all four, or setting all four without the token key, stops the server at start. The App slug and the GitHub endpoint URLs are optional.
The GitHub App needs `<PUCK_SERVER_URL>/v1/auth/github/callback` as a callback URL, set on GitHub by the App's owner.

With Compose, put the settings in `puck-server.env` at the repository root (start from `puck-server.env.example`).
Compose reads that file on the host, so it works whatever your Docker VM shares; the values do become the container's environment, which is acceptable on your own machine.
A hosted deployment should prefer the `_FILE` forms.

## API

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /healthz` | anyone | liveness, version, whether GitHub is configured |
| `POST /v1/auth/github/start` | app | GitHub authorize URL for a loopback redirect and a PKCE challenge |
| `GET /v1/auth/github/callback` | browser | code exchange, then a redirect to the app's loopback with a one-time code |
| `POST /v1/auth/token` | app | `authorization_code` (with the PKCE verifier) or `refresh_token`: a 15-minute access token and a rotating 30-day refresh token |
| `POST /v1/auth/logout`, `GET /v1/me` | session | sign out; who am I |
| `GET /v1/github/token` | session | the user's current GitHub access token (never the refresh token) |
| `GET /v1/audit` | session | the user's audit events |
| `POST /v1/runners/registration-token`, `POST /v1/runners/removal-token` | session | one-hour tokens for `config.sh`; `DELETE .../:id` revokes |
| `POST /v1/runners/register` | registration token | register a runner with its Ed25519 public key |
| `POST /v1/runners/token` | runner key | a signed assertion for a one-hour runner access token |
| `POST /v1/runners/remove` | removal token or runner key | deregister, keeping or deleting its environments |
| `GET /v1/runners`, `GET`/`PATCH`/`DELETE /v1/runners/:id` | session | list with status; rename and relabel; force remove |
| `POST /v1/instances`, `GET /v1/instances[/:envId]`, `PUT /v1/instances/:envId/grant`, `DELETE /v1/instances/:envId` | session | the environment index and its repository grants |
| `PUT /v1/instances/:envId/policies` | session | replace an environment's GitHub token permissions without re-checking repositories |
| `POST /v1/runners/instances/:envId/github-token` | runner token | installation tokens for an environment on that runner |
| `GET /v1/runner/releases`, `GET /runner/:version/:file` | anyone | runner downloads and their sha256 |
| `WS /v1/runners/connect`, `WS /v1/app/connect` | runner token, session | status, push events, and relay channels (`src/channel/wire.ts`) |

## Design notes

- **One store module.** `store.ts` is an async interface with a SQLite implementation on Node's built-in `node:sqlite`, so a Postgres implementation can replace it without touching callers. Every bearer secret is stored as its sha256 and shown once. GitHub user tokens are sealed with AES-256-GCM under the token key before they reach the store.
- **Fake time.** Every expiry reads an injected clock (`clock.ts`), and the tests drive the whole server with a fake one.
- **Push access, not read access.** Before recording a grant, and again when a grant is more than ten minutes old at mint time, the server checks the owner's own push permission on each repository with the owner's GitHub token. Installation tokens can write, so read access would let the App write where the user cannot. A repository the owner lost drops out of the grant.
- **Scoped mints.** One installation token per installation, limited with `repository_ids` and the environment's permission subset (`src/harness/github-permissions.ts`): contents and pull requests (write) and metadata always; issues write while intake or the status comment is on, and read otherwise; checks and statuses (read); actions (write), so failed jobs can be re-run under either CI policy; workflows (write) only when the definition allows workflow edits. Each mint is audited without its value.
- **A relay that cannot read.** Channels are end-to-end encrypted between the app and the runner (`src/channel/e2e.ts`: X25519, Ed25519-signed handshake, HKDF, ChaCha20-Poly1305). The server routes by channel number and may not import that module (lint enforces it). It rewrites only the channel number, because two apps can share a runner; the runner signs the app's own number, which the server forwards beside its own.
- **Flow control the server enforces.** Each channel direction has a 256 KiB credit window. A sender that overruns it, or a receiver that returns credit it was not owed, loses the channel, so the server holds at most one window per direction however slow a reader is.
- **Status from frames.** A runner is Offline 60 s after its last frame, Active while it reports a running environment, Idle otherwise. Nothing removes an offline runner automatically.
- **One process.** Channels meet in one server process. Scaling out later needs runner-affinity routing between nodes.
