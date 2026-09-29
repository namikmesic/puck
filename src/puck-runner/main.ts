/**
 * puck-runner: the program a user installs on each machine that hosts
 * Puck environments. The tarball's scripts call this bundle with the
 * tarball's own Node runtime:
 *
 *   config.sh [options]          register this machine        → puck-runner config
 *   config.sh remove [options]   deregister it                → puck-runner config remove
 *   run.sh                       run the runner               → puck-runner run
 *   svc.sh <command>             run it as a service          → puck-runner svc
 *   bin/node bin/puck-runner.cjs version
 *
 * `--help` works everywhere without Docker, a server, or a configuration.
 */

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import pkg from '../../package.json';
import { configure, ConfigureError, currentPlatform, remove, type Io } from './configure';
import { realDocker, realSpawner } from './docker/client';
import { NotConfiguredError, readConfig, runnerPaths, runnerRoot } from './files';
import { createLogger } from './log';
import { LockError, run } from './runner';
import { defaultServiceDeps, Service, ServiceError } from './service';
import { realExec } from './update';
import * as fs from 'node:fs';

export const RUNNER_VERSION: string = pkg.version;

const HELP = {
  config: `Usage: ./config.sh --url <server> --token <registration token> [options]
       ./config.sh remove [--token <removal token>] [--keep-environments | --delete-environments]

Registers this machine with Puck as a runner that hosts your environments.
The runner connects out to the Puck server; nothing connects in.

Needs Docker Engine 24 or newer, usable by this user without sudo, and
outbound HTTPS to the Puck server. Membership in the docker group is
equivalent to root on this machine: prefer a dedicated user for the runner.

Options:
  --url <url>                 The Puck server, e.g. https://puck.example.com
  --token <token>             The registration token from Settings → Runners → Add runner (PRT_…)
  --token-file <file>         Read the token from a file instead of the command line
  --name <name>               Runner name (default: this machine's host name)
  --labels <a,b>              Extra labels, comma-separated
  --max-environments <n>      Most environments this machine may host (default: no limit)
  --unattended                Ask nothing; use the flags and the defaults
  --replace                   Replace a runner you registered under the same name
  --disableupdate             Do not update the runner automatically
  --local-socket <path>       Also listen on this unix socket for Puck on this machine
                              (the This Mac runner Puck installs uses it)
  --service-label <label>     LaunchAgent label (com.puck.runner.<name>); This Mac sets one per account
  --app-bundle-id <id>        The app the LaunchAgent belongs to (macOS background items); This Mac sets Puck's
  -h, --help                  Show this help

Remove options:
  --token <token>             The removal token from Settings → Runners → Remove (PRR_…);
                              without one, the runner signs the request with its own key
  --token-file <file>         Read the token from a file
  --keep-environments         Keep this machine's environments (delete them later with docker)
  --delete-environments       Delete this machine's environments, their volumes and images
  --unattended                Ask nothing (environments are kept unless told otherwise)
`,
  run: `Usage: ./run.sh

Runs the runner in this terminal until Ctrl+C. Environments keep running
when the runner stops; the next start finds them again. To run it in the
background, install it as a service with ./svc.sh.
`,
  svc: `Usage: ./svc.sh <command>

Commands:
  install [user]   Install the service (Linux: a systemd unit, run with sudo, for [user]
                   or the user who ran sudo; macOS: a LaunchAgent for you, without sudo)
  start            Start it (macOS: load the LaunchAgent and start it now)
  stop             Stop it (environments keep running)
  status           Show its status
  uninstall        Stop and remove it
`,
};

function readToken(value: string | undefined, file: string | undefined): string | undefined {
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return value?.trim();
}

function terminalIo(): Io & { close(): void } {
  const interactive = !!process.stdin.isTTY;
  let rl: ReturnType<typeof createInterface> | null = null;
  return {
    interactive,
    print: (line) => process.stdout.write(line + '\n'),
    ask: async (question, fallback) => {
      if (!interactive) return fallback;
      rl ??= createInterface({ input: process.stdin as unknown as NodeJS.ReadableStream, output: process.stdout });
      const answer = await rl.question(question);
      return answer.trim() === '' ? fallback : answer;
    },
    close: () => rl?.close(),
  };
}

async function config(argv: string[]): Promise<number> {
  const removing = argv[0] === 'remove';
  const { values } = parseArgs({
    args: removing ? argv.slice(1) : argv,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      'token-file': { type: 'string' },
      name: { type: 'string' },
      labels: { type: 'string' },
      'max-environments': { type: 'string' },
      unattended: { type: 'boolean' },
      replace: { type: 'boolean' },
      disableupdate: { type: 'boolean' },
      'local-socket': { type: 'string' },
      'service-label': { type: 'string' },
      'app-bundle-id': { type: 'string' },
      'keep-environments': { type: 'boolean' },
      'delete-environments': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP.config);
    return 0;
  }
  const platform = currentPlatform();
  if (!platform) throw new ConfigureError(`Runners run on Linux or macOS, x64 or arm64; this is ${process.platform}-${process.arch}.`);
  const paths = runnerPaths(runnerRoot());
  const io = terminalIo();
  const token = readToken(values.token, values['token-file']);
  try {
    if (removing) {
      if (values['keep-environments'] && values['delete-environments']) throw new ConfigureError('Pick one of --keep-environments and --delete-environments.');
      await remove(
        {
          token,
          environments: values['delete-environments'] ? 'delete' : values['keep-environments'] ? 'keep' : undefined,
          unattended: !!values.unattended,
        },
        {
          paths,
          docker: realDocker,
          io,
          service: (cfg) => defaultServiceDeps(paths, cfg, realExec, io.print),
        },
      );
      return 0;
    }
    if (!values.url || !token) throw new ConfigureError('Both --url and --token are needed. See ./config.sh --help');
    await configure(
      {
        url: values.url,
        token,
        name: values.name,
        labels: values.labels,
        maxEnvironments: values['max-environments'],
        unattended: !!values.unattended,
        replace: !!values.replace,
        disableUpdate: !!values.disableupdate,
        localSocket: values['local-socket'],
        serviceLabel: values['service-label'],
        appBundleId: values['app-bundle-id'],
      },
      { paths, docker: realDocker, io, version: RUNNER_VERSION, platform },
    );
    return 0;
  } finally {
    io.close();
  }
}

async function runCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } }, strict: true });
  if (values.help) {
    process.stdout.write(HELP.run);
    return 0;
  }
  const platform = currentPlatform();
  if (!platform) throw new ConfigureError(`Runners run on Linux or macOS, x64 or arm64; this is ${process.platform}-${process.arch}.`);
  const paths = runnerPaths(runnerRoot());
  const log = createLogger({ dir: paths.diag, mirror: !process.env.PUCK_RUNNER_SERVICE && !!process.stderr.isTTY });
  return run({
    paths,
    version: RUNNER_VERSION,
    platform,
    log,
    docker: realDocker,
    spawner: realSpawner,
    print: (line) => process.stdout.write(line + '\n'),
  });
}

async function svc(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP.svc);
    return command ? 0 : 2;
  }
  const paths = runnerPaths(runnerRoot());
  const print = (line: string): void => void process.stdout.write(line + '\n');
  const service = new Service(defaultServiceDeps(paths, readConfig(paths), realExec, print));
  switch (command) {
    case 'install':
      await service.install(rest[0]);
      return 0;
    case 'start':
      await service.start();
      return 0;
    case 'stop':
      await service.stop();
      return 0;
    case 'status':
      await service.status();
      return 0;
    case 'uninstall':
      await service.uninstall();
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n${HELP.svc}`);
      return 2;
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'config':
      return config(rest);
    case 'run':
      return runCommand(rest);
    case 'svc':
      return svc(rest);
    case 'version':
      process.stdout.write(`${RUNNER_VERSION}\n`);
      return 0;
    default:
      process.stderr.write('Usage: puck-runner <config|run|svc|version>. Use ./config.sh, ./run.sh or ./svc.sh.\n');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const known = err instanceof ConfigureError || err instanceof ServiceError || err instanceof NotConfiguredError || err instanceof LockError;
    const parse = err instanceof TypeError && (err as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS');
    process.stderr.write(`${known || parse ? (err as Error).message : err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
