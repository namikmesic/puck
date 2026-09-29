# Puck runner

The Puck runner is the program you install on a machine that hosts your Puck environments.
It registers with the Puck server the way a GitHub self-hosted runner registers with GitHub, connects out to the server (it opens no ports), and runs Docker on its machine for your environments.

## Requirements

- Linux x64, Linux ARM64, or macOS on Apple silicon.
- Docker Engine 24 or newer that the runner's user can use without sudo (Docker Desktop or colima on macOS).
- Outbound HTTPS to the Puck server.

The runner brings its own Node runtime (`bin/node`); nothing else needs installing.

Membership in the `docker` group is equivalent to root on that machine, and whoever has root there can read everything its environments hold, including their short-lived GitHub tokens.
Use a dedicated user for the runner where you can (`sudo ./svc.sh install puck-runner`).

## Install

In Puck, open Settings → Runners → Add runner, pick the platform, and copy the commands it shows.
They look like this:

```bash
mkdir puck-runner && cd puck-runner
curl -fLo puck-runner-linux-x64-0.1.0.tar.gz https://<server>/runner/0.1.0/puck-runner-linux-x64-0.1.0.tar.gz
echo "<sha256>  puck-runner-linux-x64-0.1.0.tar.gz" | shasum -a 256 -c
tar xzf ./puck-runner-linux-x64-0.1.0.tar.gz
./config.sh --url https://<server> --token PRT_…
```

`config.sh` checks Docker, asks for a name (the host name by default), extra labels, and the most environments this machine may host, generates the runner's key pair, and registers.
The registration token lasts one hour and may register several runners within that hour.
Scripted installs can answer everything with flags: `--unattended --name build-box --labels gpu --max-environments 4`, and `--token-file` keeps the token out of the command line.
`./config.sh --help` lists every option.

## Run

```bash
./run.sh                                          # in this terminal, until Ctrl+C
sudo ./svc.sh install && sudo ./svc.sh start      # Linux: a systemd service
./svc.sh install && ./svc.sh start                # macOS: a LaunchAgent, no sudo
```

`./svc.sh status`, `stop` and `uninstall` manage the service.
Stopping, restarting or updating the runner never stops an environment: containers keep running under Docker, and the runner finds them again by their labels when it starts.

## Update

The runner updates itself when the Puck server publishes a newer release, checking on every connect and every six hours.
It downloads the tarball for its platform from the server, checks it against the published sha256, and restarts into it; the previous version is kept in `_update/previous/`.
Configure with `--disableupdate` to update by hand instead; a server that requires a newer version then refuses the runner until you do.

## Remove

In Puck, Settings → Runners → Remove shows the command:

```bash
./config.sh remove --token PRR_…
```

If this machine hosts environments, it asks whether to keep them (delete them later with `docker`) or delete them now; `--keep-environments` and `--delete-environments` answer for scripts.
It then uninstalls the service, deregisters the runner, and deletes its key and registration files.
Without `--token`, the runner signs the removal with its own key.
A runner removed from Settings while its machine was offline stops with exit status 78 when it comes back; run `./config.sh remove` there to clean up.

## Files

| Path | What |
| --- | --- |
| `config.sh`, `run.sh`, `svc.sh`, `VERSION`, `bin/` | The release: scripts, the Node runtime, the runner |
| `.runner` | Registration: runner id, name, server URL, labels (0644) |
| `.credentials`, `.runner_key` | The runner's Ed25519 key and its fingerprint (0600) |
| `.service` | The installed service unit, if any |
| `puck-runner` | The LaunchAgent's program on macOS, written by `./svc.sh install`; it runs `run.sh`, and macOS lists the background item under its name |
| `_diag/runner.log` | The runner's log, three files of 1 MiB, redacted |
| `cache/daemon/` | Environment daemon bundles received from the app |

## How it works

- **One outbound connection.** The runner holds one WebSocket to the server and reports its status every 20 seconds: Docker's health and version, CPUs and memory, and the environments it hosts.
  Its access token comes from a short assertion signed with its key; the server keeps only the public half.
- **Encrypted channels.** The app reaches the runner through channels the server relays.
  Each channel's key exchange is signed with the runner's key, so the server forwards bytes it cannot read.
  A control channel carries commands (create, start, stop, rebuild, delete, list, logs); an attach channel pipes the app to one environment's daemon through `docker exec`.
- **This Mac.** Puck can set up the Mac it runs on as a runner in one click (Settings → Runners): it downloads this same tarball from the server, runs `./config.sh` with `--local-socket` and `--app-bundle-id` (so the LaunchAgent names Puck as its app), and installs and starts the LaunchAgent.
  An isolated launch (`npm run start:isolated`) refuses: the LaunchAgent would outlive its temporary data folder.
  With `--local-socket <path>` the runner also listens on that unix socket (0600), and the app on the same machine opens its channels there, unencrypted and without the server; file permissions are the authentication.
- **Docker, by label.** Environments are containers labelled `puck=instance`, with two named volumes each.
  The runner never mounts a host directory or the Docker socket into them, and copies files in as a tar stream.
- **GitHub tokens.** The runner keeps each environment supplied with one-hour GitHub App installation tokens from the server, renewing them before they expire, so agents can push while your laptop is closed.
  No refresh token reaches the runner or the environment.

## Design notes

For contributors; the code's module headers carry the detail.

- **One bundle, thin scripts.** `config.sh`, `run.sh` and `svc.sh` only call `bin/puck-runner.cjs` with the bundled Node, so the Docker argv, the service units and their `systemctl`/`launchctl` calls are unit-tested TypeScript. `npm run build:runner` bundles `ws` and allows only Node built-ins; `npm run package:runner` writes the three tarballs, their `.sha256` files and `SHA256SUMS` in the layout the server's `PUCK_RUNNER_DOWNLOADS` serves. macOS is `macos` in file names, as the server names it.
- **Pinned runtime.** The Node release and the sha256 of each platform's archive are pinned in `scripts/package-runner.mjs`; a download that does not match is refused. Archives come from the runner's own ustar writer (`tar.ts`) with fixed owners and modes and the commit time, so the same commit packs to the same bytes.
- **Exit codes are the service contract.** 0 stopped, 3 updated (run.sh starts the new version), 78 removed from Puck (systemd's `RestartPreventExitStatus`; run.sh reports it as a clean exit under launchd, which has no such setting).
- **The channel stream is shared.** `src/channel/stream.ts` (encryption, framing and credit for one channel) is written for both ends, and the runner and the app both use it. Credit returns only once the consumer took the bytes, so a slow `docker exec` stdin holds the app back rather than filling the runner's memory. An end must install a channel in the same tick its `accept` or `open` is handled: the first data frame can arrive in the same socket read.
- **GitHub tokens never touch argv or disk on the host.** The first grants go into the copy-in tar at create; later ones go over a short `docker exec … attach` connection as `github.put`. The daemon holds one grant per repository owner and `git-askpass` picks by owner.
- **Machine scope.** Environments are the machine's `puck=instance` containers: status, rediscovery and `config.sh remove` all see every one of them, including environments kept by an earlier registration on the same machine; removal names them before asking.
- **Serial per environment.** Control operations on one environment run one at a time. Self-update's drain is in `control.ts`.
- **Not built yet.** Key rotation (`--rotate-key`) needs a server endpoint that signs the new key with the old one; `HTTPS_PROXY` is not honoured yet.
