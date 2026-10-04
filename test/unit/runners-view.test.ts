// @vitest-environment jsdom
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentProviderInfo, PuckBridge, RunnerRegistration, RunnersState } from '../../src/harness/bridge';
import { RUNNER_PACKAGE_ENTRIES } from '../../src/harness/runner-releases';
import { assetFor, commandsFor, initRunnersView, runnerMeta, serverAddress, statusWord } from '../../src/renderer/settings/runners';
import { LOCAL_ID, RID, runnerRow, runnersInfo, runnersState } from './runners-fixtures';

// The package layout: its regular files, and those it marks executable.
const PACKAGE_FILES = RUNNER_PACKAGE_ENTRIES.filter((e) => e.type === 'file').map((e) => e.name);
const EXECUTABLES = RUNNER_PACKAGE_ENTRIES.filter((e) => e.type === 'file' && e.mode & 0o111).map((e) => e.name);

const shellDirs: string[] = [];
afterEach(() => {
  for (const dir of shellDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Functions run inside the generated heredoc's real POSIX shell, so failures
// exercise its errexit, traps, pipelines and filesystem publication.
const shellStubs = `
command() {
  [ "$1" = -v ] && [ "$2" != "$TEST_MISSING_TOOL" ]
}
curl() {
  printf '%s\\n' "$@" > "$TEST_ROOT/curl-args"
  pwd -P > "$TEST_ROOT/download-cwd"
  [ "$(stat -c %a . 2>/dev/null || stat -f %Lp .)" = 700 ] || return 1
  while [ "$#" -gt 0 ]; do
    case "$1" in --output) shift; printf 'download' > "$1" ;; esac
    shift
  done
  if [ "$TEST_FAILURE" = signal ]; then kill -TERM $$; fi
  [ "$TEST_FAILURE" != download ]
}
mv() {
  case "$1" in -n) destination=$3 ;; *) destination=$2 ;; esac
  if [ "$destination" = ./puck-runner ]; then
    [ "$TEST_FAILURE" != publish ] || return 1
    if [ "$TEST_FAILURE" = race ]; then
      mkdir "$TEST_ROOT/puck-runner"
      printf 'keep' > "$TEST_ROOT/puck-runner/existing"
    fi
  else
    [ "$TEST_FAILURE" != rename ] || return 1
  fi
  /bin/mv "$@"
}
check_hash() {
  printf '%s\\n' "$@" > "$TEST_ROOT/hash-args"
  cat > "$TEST_ROOT/hash-input"
  [ "$TEST_FAILURE" != checksum ]
}
sha256sum() { printf 'sha256sum' > "$TEST_ROOT/hash-tool"; check_hash "$@"; }
shasum() { printf 'shasum' > "$TEST_ROOT/hash-tool"; check_hash "$@"; }
tar() {
  printf '%s\\n' "$@" > "$TEST_ROOT/tar-args"
  pwd -P > "$TEST_ROOT/extract-cwd"
  [ -f "$2" ] && [ ! -f "$2.partial" ] || return 1
  printf 'partial' > config.sh
  if [ "$TEST_FAILURE" = tar ]; then return 2; fi
  mkdir bin
  for file in ${PACKAGE_FILES.filter((name) => name !== 'VERSION').join(' ')}; do
    [ "$file" != "$TEST_MISSING_FILE" ] || { rm -f "$file"; continue; }
    printf '%s\\n' '#!/bin/sh' 'pwd -P > "../invoked-cwd"' 'printf "%s\\n" "$@" > "../invoked-args"' > "$file"
    chmod +x "$file"
  done
  if [ "$TEST_MISSING_FILE" != VERSION ]; then printf '%s\\n' "$TEST_VERSION" > VERSION; fi
  if [ -n "$TEST_NOT_EXECUTABLE" ]; then chmod -x "$TEST_NOT_EXECUTABLE"; fi
  if [ "$TEST_FAILURE" = destination ]; then mkdir "$TEST_ROOT/puck-runner"; fi
}
sudo() { printf '%s\\n' "$@" >> "$TEST_ROOT/sudo-args"; "$@"; }
`;

function commandSandbox() {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.runner-commands-test-'));
  shellDirs.push(dir);
  const bin = path.join(dir, 'tools');
  fs.mkdirSync(bin);
  const stubs = path.join(dir, 'stubs.sh');
  fs.writeFileSync(stubs, shellStubs);
  // Inject the functions into the heredoc shell without changing its body.
  fs.writeFileSync(path.join(bin, 'sh'), '#!/bin/sh\n{ /bin/cat "$TEST_STUBS"; /bin/cat; } | /bin/sh "$@"\n', { mode: 0o755 });
  return {
    dir,
    read: (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8').trimEnd(),
    exists: (name: string): boolean => fs.existsSync(path.join(dir, name)),
    staging: (): string[] => fs.readdirSync(dir).filter((name) => name.startsWith('.puck-runner.')),
    execute: (block: string[], over: Record<string, string> = {}) => spawnSync('/bin/sh', [], {
      cwd: dir,
      input: `. "$TEST_STUBS"\n${block.join('\n')}\n`,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_ROOT: dir,
        TEST_STUBS: stubs,
        TEST_FAILURE: '',
        TEST_VERSION: '0.1.0',
        TEST_MISSING_TOOL: '',
        TEST_MISSING_FILE: '',
        TEST_NOT_EXECUTABLE: '',
        ...over,
      },
    }),
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = 1_800_000_000_000;

const registration = (over: Partial<RunnerRegistration> = {}): RunnerRegistration => ({
  id: 'reg_01J8Z3X0000000000000000000',
  token: 'PRT_abcdefghijklmnopqrstuvwxyz',
  expiresAt: NOW + 59 * 60_000,
  serverUrl: 'https://puck.example.com',
  version: '0.1.0',
  assets: [
    { os: 'linux', arch: 'x64', version: '0.1.0', file: 'puck-runner-linux-x64-0.1.0.tar.gz', url: 'https://puck.example.com/runner/0.1.0/puck-runner-linux-x64-0.1.0.tar.gz', sha256: 'a'.repeat(64), size: 1 },
    { os: 'macos', arch: 'arm64', version: '0.1.0', file: 'puck-runner-macos-arm64-0.1.0.tar.gz', url: 'https://puck.example.com/runner/0.1.0/puck-runner-macos-arm64-0.1.0.tar.gz', sha256: 'b'.repeat(64), size: 1 },
  ],
  ...over,
});

function mount(state: RunnersState = runnersState(), over: Partial<PuckBridge> = {}, status?: EnvironmentProviderInfo['status']) {
  const bridge = {
    runners: vi.fn(async () => state),
    runnerRegistrationToken: vi.fn(async () => registration()),
    runnerRegistrationCancel: vi.fn(async () => undefined),
    runnerRemovalToken: vi.fn(async () => ({ id: 'reg_x', token: 'PRR_x', expiresAt: NOW + 3_600_000, command: './config.sh remove --token PRR_x' })),
    runnerForceRemove: vi.fn(async () => runnersState({ runners: [] })),
    runnerUpdate: vi.fn(async () => state),
    runnerInstallLocal: vi.fn(async () => state),
    runnerUninstallLocal: vi.fn(async () => state),
    ...over,
  } as unknown as PuckBridge;
  const say = vi.fn();
  const copy = vi.fn(async () => undefined);
  const view = initRunnersView({ bridge, say, copy, now: () => NOW });
  const card = view.card({ ...runnersInfo(), runners: state, ...(status ? { status } : {}) });
  document.body.textContent = '';
  document.body.appendChild(card);
  return { bridge, say, copy, view, card };
}

const btn = (root: Element, text: string): HTMLButtonElement =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;
const row = (card: HTMLElement, id = RID): HTMLElement => card.querySelector(`[data-runner="${id}"]`) as HTMLElement;

describe('runner rows', () => {
  it('say Idle, Active or Offline with the platform, Docker version and capacity', () => {
    expect(statusWord(runnerRow())).toBe('Idle');
    expect(statusWord(runnerRow({ status: 'active', running: 2 }))).toBe('Active · 2 environments');
    expect(statusWord(runnerRow({ status: 'active', running: 1 }))).toBe('Active · 1 environment');
    expect(statusWord(runnerRow({ status: 'offline' }))).toBe('Offline');
    expect(runnerMeta(runnerRow())).toBe('Linux x64 · Docker 27.3.1 · 16 CPUs · 62.8 GB · gpu');
    expect(runnerMeta(runnerRow({ status: 'offline', lastSeenAt: Date.now() - 3 * 86_400_000 }))).toMatch(/^Linux x64 · last seen /);
  });

  it('list This Mac first with its tag, and show details on demand', async () => {
    const mac = runnerRow({ id: LOCAL_ID, name: 'This Mac (mbp)', os: 'macos', arch: 'arm64', labels: ['macos', 'arm64', 'local'], local: true });
    const { card } = mount(runnersState({ runners: [mac, runnerRow({ environments: [{ envId: 'env_1', definition: 'example', status: 'active' }] })] }));
    const names = [...card.querySelectorAll('.rn-name')].map((n) => n.textContent);
    expect(names).toEqual(['This Mac (mbp)', 'build-box']);
    expect(row(card, LOCAL_ID).textContent).toContain('This Mac');
    btn(row(card), 'Details').click();
    const facts = row(card).querySelector('.rn-details') as HTMLElement;
    expect(facts.textContent).toContain(RID);
    expect(facts.textContent).toContain('SHA256:q1w2e3');
    expect(facts.textContent).toContain('example');
  });

  it('warn about a changed key and a Docker problem', () => {
    const { card } = mount(runnersState({ runners: [runnerRow({ keyChanged: true }), runnerRow({ id: LOCAL_ID, name: 'b', docker: { ok: false, version: null, problem: 'daemon-down', ncpu: null, memTotal: null } })] }));
    expect(row(card).textContent).toMatch(/different key/);
    expect(row(card, LOCAL_ID).textContent).toMatch(/Docker problem on this runner: daemon-down/);
  });

  it('rename and relabel through the Puck server', async () => {
    const { card, bridge } = mount();
    btn(row(card), 'Rename').click();
    const input = row(card).querySelector('form.rn-edit input') as HTMLInputElement;
    expect(input.value).toBe('build-box');
    input.value = ' big-box ';
    (row(card).querySelector('form.rn-edit') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(bridge.runnerUpdate).toHaveBeenCalledWith(RID, { name: 'big-box' });

    btn(row(card), 'Labels').click();
    const labels = row(card).querySelector('form.rn-edit input') as HTMLInputElement;
    expect(labels.value).toBe('gpu');
    labels.value = 'gpu, fast';
    (row(card).querySelector('form.rn-edit') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(bridge.runnerUpdate).toHaveBeenCalledWith(RID, { labels: ['gpu', 'fast'] });
  });

  it('Remove shows the config.sh remove command, with an armed Force remove', async () => {
    const { card, bridge, copy } = mount();
    btn(row(card), 'Remove').click();
    await settle();
    expect(bridge.runnerRemovalToken).toHaveBeenCalledWith(RID);
    expect(row(card).querySelector('.rn-removal .pv-code')?.textContent).toBe('$ ./config.sh remove --token PRR_x');
    btn(row(card).querySelector('.rn-removal') as Element, 'Copy').click();
    await settle();
    expect(copy).toHaveBeenCalledWith('./config.sh remove --token PRR_x');
    const force = btn(row(card), 'Force remove');
    force.click();
    expect(bridge.runnerForceRemove).not.toHaveBeenCalled();
    force.click();
    await settle();
    expect(bridge.runnerForceRemove).toHaveBeenCalledWith(RID);
  });

  it('an offline runner offers Force remove; This Mac offers an armed uninstall', async () => {
    const mac = runnerRow({ id: LOCAL_ID, name: 'This Mac', local: true });
    const { card, bridge } = mount(runnersState({ runners: [mac, runnerRow({ status: 'offline' })] }));
    expect(btn(row(card), 'Remove')).toBeUndefined();
    expect(btn(row(card), 'Force remove')).toBeTruthy();
    const remove = btn(row(card, LOCAL_ID), 'Remove');
    remove.click();
    remove.click();
    await settle();
    expect(bridge.runnerUninstallLocal).toHaveBeenCalled();
    expect(btn(row(card, LOCAL_ID), 'Force remove')).toBeUndefined();
  });

  it('signed out: a note and no Add runner', () => {
    const { card } = mount(runnersState({ signedIn: false, runners: [] }));
    expect(card.textContent).toContain('Sign in to Puck with GitHub on the Providers page to add runners.');
    expect(btn(card, 'Add runner')).toBeUndefined();
  });

  it('refreshes the card header when a runner appears after an empty list', () => {
    const { card, view } = mount(runnersState({ runners: [] }), {}, { state: 'disconnected', detail: 'No runners yet' });
    expect(card.querySelector('.card-head .status')?.textContent).toBe('not set up');
    expect(card.querySelector('.card-sub')?.textContent).toBe('No runners yet');

    view.update(runnersState({ runners: [runnerRow()] }));
    expect(card.querySelector('.rn-name')?.textContent).toBe('build-box');
    expect(card.querySelector('.card-head .status')?.textContent).toBe('connected');
    expect(card.querySelector('.card-head .status')?.classList.contains('on')).toBe(true);
    expect(card.querySelector('.card-sub')?.textContent).toBe('1 runner, 1 online');

    view.update(runnersState({ runners: [] }));
    expect(card.querySelector('.rn-name')).toBeNull();
    expect(card.querySelector('.card-head .status')?.textContent).toBe('not set up');
    expect(card.querySelector('.card-sub')?.textContent).toBe('No runners yet');
  });
});

describe.each([
  { platform: 'Linux', index: 0, hash: 'sha256sum' },
  { platform: 'macOS', index: 1, hash: 'shasum' },
])('$platform copied commands', ({ index, hash }) => {
  const reg = registration();
  const asset = reg.assets[index];

  it.each(['https', 'http'])('installs with %s transport, then configures and runs from the completed directory', (scheme) => {
    const serverUrl = `${scheme}://puck.example.com:8765`;
    const url = `${serverUrl}/runner/package.tar.gz`;
    const c = commandsFor({ ...asset, url }, { ...reg, serverUrl });
    const sandbox = commandSandbox();
    const result = sandbox.execute([...c.download, 'pwd -P > caller-cwd']);
    expect(result.status, result.stderr).toBe(0);
    expect(sandbox.read('caller-cwd')).toBe(sandbox.dir);
    expect(sandbox.staging()).toEqual([]);
    expect(sandbox.read('puck-runner/VERSION')).toBe(asset.version);
    const stage = sandbox.read('download-cwd');
    expect(path.dirname(stage)).toBe(sandbox.dir);
    expect(sandbox.read('extract-cwd')).toBe(stage);
    expect(sandbox.read('hash-tool')).toBe(hash);
    expect(sandbox.read('hash-input')).toBe(`${asset.sha256}  ./${asset.file}.partial`);
    expect(sandbox.read('hash-args').split('\n')).toEqual(index === 0 ? ['-c', '--status'] : ['-a', '256', '-c', '--status']);
    expect(sandbox.read('tar-args').split('\n')).toEqual(['-xzf', `./${asset.file}`]);
    expect(sandbox.exists(`puck-runner/${asset.file}`)).toBe(true);
    expect(sandbox.exists(`puck-runner/${asset.file}.partial`)).toBe(false);
    const transport = scheme === 'https'
      ? ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https']
      : ['--fail', '--max-redirs', '0'];
    expect(sandbox.read('curl-args').split('\n')).toEqual([
      ...transport, '--globoff', '--connect-timeout', '30', '--max-time', '900', '--output', `./${asset.file}.partial`, '--', url,
    ]);
    expect(sandbox.execute([...c.configure, 'pwd -P > caller-cwd']).status).toBe(0);
    expect(sandbox.read('invoked-cwd')).toBe(path.join(sandbox.dir, 'puck-runner'));
    expect(sandbox.read('invoked-args').split('\n')).toEqual(['--url', serverUrl, '--token', reg.token]);
    expect(sandbox.read('caller-cwd')).toBe(sandbox.dir);
    for (const run of c.run) {
      expect(sandbox.execute([run, 'pwd -P > caller-cwd']).status).toBe(0);
      expect(sandbox.read('invoked-cwd')).toBe(path.join(sandbox.dir, 'puck-runner'));
      expect(sandbox.read('caller-cwd')).toBe(sandbox.dir);
    }
    expect(sandbox.read('invoked-args')).toBe('start');
    expect(sandbox.exists('sudo-args')).toBe(index === 0);
  });

  it.each(['https', 'http'])('treats hostile %s URLs, file names, versions and credentials as literal arguments', (scheme) => {
    const sandbox = commandSandbox();
    const serverUrl = `${scheme}://puck.example.com/a 'quote' and $(touch INJECTED)`;
    const token = `PRT_' "; touch INJECTED; # PUCK_RUNNER_INSTALL`;
    const file = `package 'quote'; touch INJECTED; #.tar.gz`;
    const version = `0.1.0 'quote' $(touch INJECTED)`;
    const url = `${scheme}://puck.example.com/a; printf INJECTED; #`;
    const c = commandsFor({ ...asset, file, version, url }, { serverUrl, token });
    const result = sandbox.execute(c.download, { TEST_VERSION: version });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('INJECTED');
    expect(sandbox.exists('INJECTED')).toBe(false);
    expect(sandbox.read('curl-args').split('\n').at(-1)).toBe(url);
    expect(sandbox.read('hash-input')).toBe(`${asset.sha256}  ./${file}.partial`);
    const configured = sandbox.execute(c.configure);
    expect(configured.status, configured.stderr).toBe(0);
    expect(configured.stdout).not.toContain('INJECTED');
    expect(sandbox.read('invoked-args').split('\n')).toEqual(['--url', serverUrl, '--token', token]);
    expect(sandbox.exists('INJECTED')).toBe(false);
  });

  it.each(['https', 'http'])('cleans staging after %s download, checksum, or partial extraction failures', (scheme) => {
    const serverUrl = `${scheme}://puck.example.com`;
    const c = commandsFor({ ...asset, url: `${serverUrl}/package.tar.gz` }, { ...reg, serverUrl });
    for (const failure of ['download', 'checksum', 'rename', 'tar', 'publish', 'signal']) {
      const sandbox = commandSandbox();
      const result = sandbox.execute(c.download, { TEST_FAILURE: failure });
      expect(result.status, `${failure}: ${result.stderr}`).not.toBe(0);
      expect(sandbox.exists('tar-args')).toBe(failure === 'tar' || failure === 'publish');
      expect(sandbox.exists('hash-tool')).toBe(failure !== 'download' && failure !== 'signal');
      expect(sandbox.exists('puck-runner')).toBe(false);
      expect(sandbox.staging()).toEqual([]);
    }
  });

  it('checks prerequisites before downloading or creating staging', () => {
    for (const missing of ['curl', hash, 'tar', 'mktemp', 'mv', 'rm', 'cat']) {
      const sandbox = commandSandbox();
      const result = sandbox.execute(commandsFor(asset, reg).download, { TEST_MISSING_TOOL: missing });
      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).toBe(`Missing prerequisite: ${missing}`);
      expect(sandbox.exists('curl-args')).toBe(false);
      expect(sandbox.exists('puck-runner')).toBe(false);
      expect(sandbox.staging()).toEqual([]);
    }
  });

  it.each(['directory', 'file', 'symlink'])('refuses an existing %s destination before downloading', (kind) => {
    const sandbox = commandSandbox();
    const dest = path.join(sandbox.dir, 'puck-runner');
    if (kind === 'directory') fs.mkdirSync(dest);
    else if (kind === 'file') fs.writeFileSync(dest, 'keep');
    else fs.symlinkSync('./absent', dest);
    const result = sandbox.execute(commandsFor(asset, reg).download);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).toBe('puck-runner already exists.');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(kind === 'symlink');
    if (kind === 'file') expect(sandbox.read('puck-runner')).toBe('keep');
    expect(sandbox.exists('curl-args')).toBe(false);
    expect(sandbox.staging()).toEqual([]);
  });

  it('refuses a destination that appears during extraction and cleans staging', () => {
    const sandbox = commandSandbox();
    const result = sandbox.execute(commandsFor(asset, reg).download, { TEST_FAILURE: 'destination' });
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).toBe('puck-runner already exists.');
    expect(fs.readdirSync(path.join(sandbox.dir, 'puck-runner'))).toEqual([]);
    expect(sandbox.staging()).toEqual([]);
  });

  it('preserves a destination that appears during publication and removes nested staging', () => {
    const sandbox = commandSandbox();
    const result = sandbox.execute(commandsFor(asset, reg).download, { TEST_FAILURE: 'race' });
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).toBe('puck-runner appeared during publication.');
    expect(fs.readdirSync(path.join(sandbox.dir, 'puck-runner'))).toEqual(['existing']);
    expect(sandbox.read('puck-runner/existing')).toBe('keep');
    expect(sandbox.staging()).toEqual([]);
  });

  it('checks the package against the layout table: every regular file, and the executable ones', () => {
    const download = commandsFor(asset, reg).download[0];
    expect(download).toContain(`for required in ${PACKAGE_FILES.map((name) => `'${name}'`).join(' ')}; do`);
    expect(download).toContain(`for executable in ${EXECUTABLES.map((name) => `'${name}'`).join(' ')}; do`);
    expect(EXECUTABLES).toEqual(['config.sh', 'run.sh', 'svc.sh', 'bin/node']);
  });

  it.each(PACKAGE_FILES)('never publishes a package missing %s', (missing) => {
    const sandbox = commandSandbox();
    const result = sandbox.execute(commandsFor(asset, reg).download, { TEST_MISSING_FILE: missing });
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).toBe(`Runner package is missing ${missing}.`);
    expect(sandbox.exists('puck-runner')).toBe(false);
    expect(sandbox.staging()).toEqual([]);
  });

  it.each(EXECUTABLES)('never publishes a package that cannot execute %s', (executable) => {
    const sandbox = commandSandbox();
    const result = sandbox.execute(commandsFor(asset, reg).download, { TEST_NOT_EXECUTABLE: executable });
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).toBe(`Runner package cannot execute ${executable}.`);
    expect(sandbox.exists('puck-runner')).toBe(false);
    expect(sandbox.staging()).toEqual([]);
  });

  it('never publishes a mismatched version', () => {
    const sandbox = commandSandbox();
    expect(sandbox.execute(commandsFor(asset, reg).download, { TEST_VERSION: 'different' }).status).not.toBe(0);
    expect(sandbox.exists('puck-runner')).toBe(false);
    expect(sandbox.staging()).toEqual([]);
  });

  it.each(['absent', 'wrong-version', 'non-executable'])('Configure and both Run choices reject an %s installation', (kind) => {
    const sandbox = commandSandbox();
    const c = commandsFor(asset, reg);
    if (kind !== 'absent') {
      expect(sandbox.execute(c.download).status).toBe(0);
      if (kind === 'wrong-version') fs.writeFileSync(path.join(sandbox.dir, 'puck-runner/VERSION'), 'different\n');
      else fs.chmodSync(path.join(sandbox.dir, 'puck-runner/config.sh'), 0o644);
    }
    for (const block of [...c.configure, ...c.run]) {
      const result = sandbox.execute([block]);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).toBe('Puck runner installation is incomplete or has a different version.');
      expect(sandbox.exists('invoked-cwd')).toBe(false);
    }
  });
});

describe('Add runner', () => {
  it.each(['file', 'url', 'sha256', 'version', 'serverUrl', 'token'])('rejects control characters in %s before producing commands', (field) => {
    const reg = registration();
    const asset = reg.assets[0];
    for (const control of ['\0', '\n', '\r', '\t', '\x1b', '\x7f', '\u0085']) {
      const value = `unsafe${control}value`;
      expect(() => commandsFor({ ...asset, [field]: value }, { ...reg, [field]: value })).toThrow('control characters');
    }
  });

  it.each(['../package.tar.gz', '/tmp/package.tar.gz', 'sub/package.tar.gz', 'back\\slash.tar.gz', '.', '..', ''])('rejects unsafe archive file name %s', (file) => {
    const reg = registration();
    expect(() => commandsFor({ ...reg.assets[0], file }, reg)).toThrow('file name');
  });

  it.each(['file:///tmp/package', 'ftp://puck.example.com/package', 'http://other.example.com/package', 'http://puck.example.com:9999/package', 'http://puck.example.com:8765\\@other.example.com/package'])('rejects unsupported download transport %s', (url) => {
    const reg = registration({ serverUrl: 'http://puck.example.com:8765' });
    expect(() => commandsFor({ ...reg.assets[0], url }, reg)).toThrow('require HTTPS or HTTP');
  });

  it('rejects a hostile checksum rather than constructing a checksum manifest', () => {
    const reg = registration();
    expect(() => commandsFor({ ...reg.assets[0], sha256: `'; touch INJECTED; #` }, reg)).toThrow('SHA-256 checksum');
  });

  it('shows a clear error with no copyable commands when installation input is rejected', async () => {
    const { card, bridge } = mount(runnersState(), { runnerRegistrationToken: vi.fn(async () => registration({ token: 'bad\ntoken' })) });
    btn(card, 'Add runner').click();
    await settle();
    const panel = card.querySelector('#rn-add') as HTMLElement;
    expect(panel.textContent).toContain('control characters');
    expect(panel.querySelector('.pv-code')).toBeNull();
    expect(panel.querySelector('#rn-add-status')?.textContent).toBe('');
    btn(panel, 'Close').click();
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the commands for the picked platform with the token expiry, then the runner coming online', async () => {
    const { card, bridge, view, copy } = mount();
    btn(card, 'Add runner').click();
    await settle();
    expect(bridge.runnerRegistrationToken).toHaveBeenCalledTimes(1);
    const panel = card.querySelector('#rn-add') as HTMLElement;
    expect(panel.classList.contains('hidden')).toBe(false);
    const codes = [...panel.querySelectorAll('.pv-code')].map((c) => c.textContent);
    expect(codes[0]).toBe(`$ ${commandsFor(registration().assets[0], registration()).download[0]}`);
    expect(codes[1]).toBe(`$ ${commandsFor(registration().assets[0], registration()).configure[0]}`);
    expect(panel.textContent).toContain('expires in 59 min');
    expect(panel.querySelector('#rn-add-status')?.textContent).toBe('◌ Waiting for a runner to register…');
    btn(panel.querySelector('.rn-block') as Element, 'Copy').click();
    await settle();
    expect(copy).toHaveBeenCalledWith(commandsFor(registration().assets[0], registration()).download[0]);

    btn(card.querySelector('#rn-add') as Element, 'macOS ARM64').click();
    expect(card.querySelector('#rn-add-commands')?.textContent).toContain('./svc.sh install && ./svc.sh start');

    // The runner registers and connects: pushed as a new row.
    const fresh = runnerRow({ id: 'rnr_01J8Z3X0000000000000000009', name: 'build-2' });
    view.update(runnersState({ runners: [runnerRow(), fresh] }));
    expect(card.querySelector('#rn-add-status')?.textContent).toBe('✓ build-2 is online · Linux x64 · Docker 27.3.1 · 16 CPUs · 62.8 GB · gpu');
    btn(card.querySelector('#rn-add') as Element, 'Done').click();
    expect(bridge.runnerRegistrationCancel).not.toHaveBeenCalled();
    expect(card.querySelector('#rn-add')?.classList.contains('hidden')).toBe(true);
  });

  it('marks the picked platform pressed in a segmented control', async () => {
    const { card } = mount();
    btn(card, 'Add runner').click();
    await settle();
    const pressed = (): string[] => [...card.querySelectorAll('#rn-add-os .seg-btn[aria-pressed="true"]')].map((b) => b.textContent ?? '');
    expect(card.querySelector('#rn-add-os')?.classList.contains('seg')).toBe(true);
    expect(pressed()).toEqual(['Linux x64']);
    btn(card.querySelector('#rn-add-os') as Element, 'This Mac').click();
    expect(pressed()).toEqual(['This Mac']);
    expect(btn(card, 'Add runner')).toBeUndefined();
  });

  it('a platform without a package says so, waits for nothing, and Close revokes the token', async () => {
    const { card, bridge } = mount();
    btn(card, 'Add runner').click();
    await settle();
    btn(card.querySelector('#rn-add') as Element, 'Linux ARM64').click();
    const panel = card.querySelector('#rn-add') as HTMLElement;
    const note = panel.querySelector('.rn-no-package')?.textContent ?? '';
    expect(note).toBe(
      'This Puck server has no runner package for Linux ARM64. With a package, this panel shows the commands to download it and to configure it with this server\'s address, https://puck.example.com, and a registration token.',
    );
    expect(note).not.toContain('development mode');
    expect(note).not.toContain('PUCK_RUNNER_DOWNLOADS');
    expect(panel.querySelector('.pv-code')).toBeNull();
    expect(panel.querySelector('#rn-add-status')?.textContent).toBe('');
    expect(btn(panel, 'Cancel')).toBeUndefined();
    // Another platform can still use the token, so it is kept until the panel closes.
    expect(bridge.runnerRegistrationCancel).not.toHaveBeenCalled();
    btn(panel, 'Close').click();
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledWith('reg_01J8Z3X0000000000000000000');
    expect(card.querySelector('#rn-add')?.classList.contains('hidden')).toBe(true);
  });

  it('a server with no packages at all has its token revoked at once', async () => {
    const { card, bridge } = mount(runnersState(), { runnerRegistrationToken: vi.fn(async () => registration({ version: null, assets: [] })) });
    btn(card, 'Add runner').click();
    await settle();
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledTimes(1);
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledWith('reg_01J8Z3X0000000000000000000');
    const panel = card.querySelector('#rn-add') as HTMLElement;
    expect(panel.querySelector('.rn-no-package')?.textContent).toBe(
      'This Puck server has no runner package for Linux x64. Runner downloads come only from a Puck server in development mode. With a package, this panel shows the commands to download it and to configure it with this server\'s address, https://puck.example.com, and a registration token.',
    );
    expect(panel.querySelector('#rn-add-status')?.textContent).toBe('');
    btn(panel, 'Close').click();
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledTimes(1);
  });

  it('names the server scheme and host, and warns that a loopback server is out of reach of another machine', async () => {
    const local = mount(runnersState(), { runnerRegistrationToken: vi.fn(async () => registration({ serverUrl: 'http://localhost:8765' })) });
    btn(local.card, 'Add runner').click();
    await settle();
    let panel = local.card.querySelector('#rn-add') as HTMLElement;
    expect(panel.textContent).toContain('outbound HTTP to localhost:8765.');
    expect(panel.textContent).not.toContain('HTTPS');
    const warn = panel.querySelector('#rn-add-unreachable')?.textContent ?? '';
    expect(warn).toMatch(/^A runner on another machine can't reach this Puck server at localhost:8765: on that machine, localhost is the machine itself\./);
    expect(warn.endsWith('(PUCK_SERVER_URL). This Mac still works as a runner.')).toBe(true);
    // The commands still show: the address may be reachable some other way.
    expect(panel.querySelectorAll('.pv-code')).toHaveLength(3);
    expect(panel.querySelector('#rn-add-status')?.textContent).toBe('◌ Waiting for a runner to register…');
    btn(panel, 'This Mac').click();
    expect(panel.querySelector('#rn-add-unreachable')).toBeNull();

    const hosted = mount();
    btn(hosted.card, 'Add runner').click();
    await settle();
    panel = hosted.card.querySelector('#rn-add') as HTMLElement;
    expect(panel.textContent).toContain('outbound HTTPS to puck.example.com.');
    expect(panel.querySelector('#rn-add-unreachable')).toBeNull();
  });

  it('claims This Mac still works on a loopback server only when it is installed or a macOS package is published', async () => {
    const linuxOnly = registration({ serverUrl: 'http://localhost:8765', assets: [registration().assets[0]] });
    const missing = mount(runnersState(), { runnerRegistrationToken: vi.fn(async () => linuxOnly) });
    btn(missing.card, 'Add runner').click();
    await settle();
    let warn = missing.card.querySelector('#rn-add-unreachable')?.textContent ?? '';
    expect(warn).toContain('PUCK_SERVER_URL');
    expect(warn.endsWith('(PUCK_SERVER_URL).')).toBe(true);
    expect(warn).not.toContain('This Mac still works as a runner.');

    const installed = mount(
      runnersState({ local: { supported: true, installed: true, runnerId: LOCAL_ID, busy: null, detail: '', error: null } }),
      { runnerRegistrationToken: vi.fn(async () => linuxOnly) },
    );
    btn(installed.card, 'Add runner').click();
    await settle();
    warn = installed.card.querySelector('#rn-add-unreachable')?.textContent ?? '';
    expect(warn.endsWith('This Mac still works as a runner.')).toBe(true);
  });

  it('reads the scheme, host and loopback from a server URL, and finds a platform package', () => {
    expect(serverAddress('http://localhost:8765')).toEqual({ scheme: 'HTTP', host: 'localhost:8765', loopback: true });
    expect(serverAddress('http://127.0.0.1:8080')).toEqual({ scheme: 'HTTP', host: '127.0.0.1:8080', loopback: true });
    expect(serverAddress('http://[::1]:8765')?.loopback).toBe(true);
    expect(serverAddress('http://puck.localhost')?.loopback).toBe(true);
    expect(serverAddress('https://puck.example.com')).toEqual({ scheme: 'HTTPS', host: 'puck.example.com', loopback: false });
    expect(serverAddress('http://192.168.1.20:8765')?.loopback).toBe(false);
    expect(serverAddress('http://127.example.com')?.loopback).toBe(false);
    expect(serverAddress('not a url')).toBeNull();
    const assets = registration().assets;
    expect(assetFor(assets, 'linux-x64')?.file).toBe('puck-runner-linux-x64-0.1.0.tar.gz');
    expect(assetFor(assets, 'linux-arm64')).toBeUndefined();
  });

  it('Cancel revokes the token, and closing Settings leaves it valid', async () => {
    const { card, bridge, view } = mount();
    btn(card, 'Add runner').click();
    await settle();
    btn(card.querySelector('#rn-add') as Element, 'Cancel').click();
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledWith('reg_01J8Z3X0000000000000000000');
    btn(card, 'Add runner').click();
    await settle();
    view.close();
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledTimes(1);
    expect(card.querySelector('#rn-add')?.classList.contains('hidden')).toBe(true);
  });

  it('an expired token offers a new one', async () => {
    const { card, bridge } = mount(runnersState(), { runnerRegistrationToken: vi.fn(async () => registration({ expiresAt: NOW - 1 })) });
    btn(card, 'Add runner').click();
    await settle();
    btn(card.querySelector('#rn-add') as Element, 'The token expired — get a new one').click();
    await settle();
    expect(bridge.runnerRegistrationToken).toHaveBeenCalledTimes(2);
  });

  it('This Mac installs the runner in one click', async () => {
    const installed = runnersState({ local: { supported: true, unsupported: null, installed: true, runnerId: LOCAL_ID, busy: null, detail: '', error: null } });
    const { card, bridge } = mount(runnersState(), { runnerInstallLocal: vi.fn(async () => installed) });
    btn(card, 'Add runner').click();
    await settle();
    btn(card.querySelector('#rn-add') as Element, 'This Mac').click();
    btn(card.querySelector('#rn-add') as Element, 'Set up This Mac').click();
    await settle();
    expect(bridge.runnerInstallLocal).toHaveBeenCalled();
    expect(bridge.runnerRegistrationCancel).not.toHaveBeenCalled();
    expect(card.querySelector('#rn-add')?.classList.contains('hidden')).toBe(true);
    expect(btn(card, 'Set up This Mac')).toBeUndefined();
  });

  it('shows install progress and failures for This Mac', async () => {
    const { card, say, view } = mount(runnersState(), { runnerInstallLocal: vi.fn(async () => Promise.reject(new Error('Docker is not running'))) });
    btn(card, 'Set up This Mac').click();
    await settle();
    expect(say).toHaveBeenCalledWith('Docker is not running');
    view.update(runnersState({ local: { supported: true, unsupported: null, installed: false, runnerId: null, busy: 'installing', detail: 'Downloading runner 0.1.0…', error: null } }));
    expect(card.textContent).toContain('This Mac: Downloading runner 0.1.0…');
    expect(btn(card, 'Setting up This Mac…').disabled).toBe(true);
  });
});
