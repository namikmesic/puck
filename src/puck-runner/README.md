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
| `_diag/runner.log` | The runner's log, three files of 1 MiB, redacted |
| `cache/daemon/` | Environment daemon bundles received from the app |

## How it works

- **One outbound connection.** The runner holds one WebSocket to the server and reports its status every 20 seconds: Docker's health and version, CPUs and memory, and the environments it hosts.
  Its access token comes from a short assertion signed with its key; the server keeps only the public half.
- **Encrypted channels.** The app reaches the runner through channels the server relays.
  Each channel's key exchange is signed with the runner's key, so the server forwards bytes it cannot read.
  A control channel carries commands (create, start, stop, rebuild, delete, list, logs); an attach channel pipes the app to one environment's daemon through `docker exec`.
- **Docker, by label.** Environments are containers labelled `puck=instance`, with two named volumes each.
  The runner never mounts a host directory or the Docker socket into them, and copies files in as a tar stream.
- **GitHub tokens.** The runner keeps each environment supplied with one-hour GitHub App installation tokens from the server, renewing them before they expire, so agents can push while your laptop is closed.
  No refresh token reaches the runner or the environment.
