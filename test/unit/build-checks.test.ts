import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { findAppArtifacts, findMakeArtifacts, nodeMajorMismatch } from '../../scripts/build-checks.mjs';
import { MIN_MACOS, RELEASE_TARGET } from '../../scripts/release.mjs';

const root = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('nodeMajorMismatch', () => {
  it('accepts the pinned major regardless of minor and patch', () => {
    expect(nodeMajorMismatch('22\n', 'v22.23.2')).toBeNull();
    expect(nodeMajorMismatch('v22.12.0', 'v22.1.0')).toBeNull();
  });

  it('names both versions when the major differs', () => {
    const message = nodeMajorMismatch('22\n', 'v26.7.0');
    expect(message).toContain('Node 22');
    expect(message).toContain('v26.7.0');
  });

  it('rejects a .nvmrc that does not pin a numeric version', () => {
    expect(nodeMajorMismatch('lts/jod\n', 'v22.23.2')).toMatch(/numeric/);
  });
});

describe('artifact checks', () => {
  const dirs: string[] = [];
  const outDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'puck-out-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('finds nothing in a missing or empty out directory', () => {
    const out = outDir();
    expect(findAppArtifacts(join(out, 'absent'), 'Puck', 0)).toEqual([]);
    expect(findAppArtifacts(out, 'Puck', 0)).toEqual([]);
    expect(findMakeArtifacts(out, 0)).toEqual([]);
  });

  it('finds a fresh macOS app bundle and rejects a stale one', () => {
    const out = outDir();
    const app = join(out, 'Puck-darwin-arm64', 'Puck.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    const written = statSync(app).mtimeMs;
    expect(findAppArtifacts(out, 'Puck', written)).toEqual([app]);
    expect(findAppArtifacts(out, 'Puck', written + 1)).toEqual([]);
  });

  it('ignores a target directory without the app inside it', () => {
    const out = outDir();
    mkdirSync(join(out, 'Puck-darwin-arm64'), { recursive: true });
    writeFileSync(join(out, 'Puck-darwin-arm64', 'LICENSE'), 'x');
    expect(findAppArtifacts(out, 'Puck', 0)).toEqual([]);
  });

  it('ignores directories that belong to another app name or platform', () => {
    const out = outDir();
    mkdirSync(join(out, 'Other-darwin-arm64', 'Other.app'), { recursive: true });
    mkdirSync(join(out, 'Puck-plan9-arm64', 'Puck.app'), { recursive: true });
    expect(findAppArtifacts(out, 'Puck', 0)).toEqual([]);
  });

  it('knows the Windows and Linux artifact names', () => {
    const out = outDir();
    mkdirSync(join(out, 'Puck-win32-x64'), { recursive: true });
    writeFileSync(join(out, 'Puck-win32-x64', 'Puck.exe'), 'x');
    mkdirSync(join(out, 'Puck-linux-x64'), { recursive: true });
    writeFileSync(join(out, 'Puck-linux-x64', 'Puck'), 'x');
    expect(findAppArtifacts(out, 'Puck', 0).sort()).toEqual([
      join(out, 'Puck-linux-x64', 'Puck'),
      join(out, 'Puck-win32-x64', 'Puck.exe'),
    ]);
  });

  it('finds fresh distributables under out/make and rejects stale ones', () => {
    const out = outDir();
    const zip = join(out, 'make', 'zip', 'darwin', 'arm64', 'Puck-darwin-arm64-0.0.1.zip');
    mkdirSync(join(zip, '..'), { recursive: true });
    writeFileSync(zip, 'x');
    const written = statSync(zip).mtimeMs;
    expect(findMakeArtifacts(out, written)).toEqual([zip]);
    expect(findMakeArtifacts(out, written + 1)).toEqual([]);
  });
});

describe('toolchain pin', () => {
  const pkg = JSON.parse(read('package.json')) as {
    engines: { node: string };
    scripts: Record<string, string>;
  };
  const major = (v: string) => v.trim().replace(/^[^\d]*/, '').split('.')[0];

  it('pins one Node major in .nvmrc and package.json engines', () => {
    expect(major(read('.nvmrc'))).toBe('22');
    expect(major(pkg.engines.node)).toBe('22');
  });

  it('installs from the lockfile on that Node in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('node-version-file: .nvmrc');
    expect(ci).not.toMatch(/node-version:/);
    expect(ci).toMatch(/run: npm ci\b/);
    expect(ci).not.toMatch(/npm install\b/);
  });

  it('routes package and make through the artifact-checking wrapper', () => {
    expect(pkg.scripts.package).toBe('node scripts/forge.mjs package');
    expect(pkg.scripts.make).toBe('node scripts/forge.mjs make');
  });
});

describe('runner trust mode and release signing', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const dockerfile = read('src/server/Dockerfile');
  const ci = read('.github/workflows/ci.yml');

  it('builds and packages the runner in an explicit trust mode', () => {
    expect(pkg.scripts['build:runner']).toMatch(/ scripts\/build-runner\.mjs --mode development$/);
    expect(pkg.scripts['package:runner']).toMatch(/ scripts\/package-runner\.mjs --mode development$/);
    expect(pkg.scripts['package:runner:release']).toMatch(/ scripts\/package-runner\.mjs --mode production$/);
  });

  it('packages the development server image in development mode, with the sources the packager imports', () => {
    const runs = dockerfile.split('\n').filter((line) => /\bnode .*scripts\/package-runner\.mjs/.test(line));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('scripts/package-runner.mjs --mode development ');
    expect(dockerfile).toContain('COPY scripts/build-runner.mjs scripts/package-runner.mjs scripts/runner-release.mjs scripts/ts-resolve.mjs scripts/');
    expect(dockerfile).toContain('COPY src/runner-release src/runner-release');
  });

  it('never packages production runners or signs in CI, and checks the packaged runner reports development trust', () => {
    expect(ci).not.toMatch(/--mode production|package:runner:release|runner-release(\.mjs)?( --)? sign|PUCK_RUNNER_RELEASE_PRIVATE_KEY/);
    expect(ci).toContain('npm run package:runner -- --targets macos-arm64');
    expect(ci).toContain(`./bin/node bin/puck-runner.cjs version --json | grep -F '"trustMode":"development"'`);
  });

  it('keeps private keys out of the repository', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END [A-Z ]*PRIVATE KEY-----/;
    const offenders = tracked.filter((file) => {
      try {
        return privateKey.test(readFileSync(join(root, file), 'latin1'));
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });
});

describe('local server (compose.yaml)', () => {
  const compose = parseYaml(read('compose.yaml')) as {
    services: Record<string, { build: { args?: Record<string, string> }; pull_policy?: string; environment?: Record<string, string> }>;
  };
  const service = compose.services['puck-server'];

  it('builds and runs the development server, which hosts the runner packages', () => {
    expect(service.build.args?.PUCK_DEVELOPMENT).toBe('true');
    expect(service.environment?.PUCK_DEVELOPMENT).toBe('true');
  });

  it('rebuilds the image on every up instead of reusing an older build', () => {
    expect(service.pull_policy).toBe('build');
  });
});

describe('release metadata', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const changelog = read('CHANGELOG.md');
  const readme = read('README.md');
  const release = read('RELEASE.md');
  const macosMajor = MIN_MACOS.split('.')[0];

  it('names the package version at the top of the changelog', () => {
    const top = /^## (\d+\.\d+\.\d+)/m.exec(changelog)?.[1];
    expect(top).toBe(pkg.version);
  });

  it('documents the minimum macOS and the target that the build enforces', () => {
    expect(readme).toContain(`macOS ${macosMajor} (`);
    expect(changelog).toContain(`macOS ${macosMajor} or later`);
    expect(release).toContain(`Minimum macOS ${MIN_MACOS}`);
    expect(RELEASE_TARGET).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(readme).toContain(`Puck-${RELEASE_TARGET.platform}-${RELEASE_TARGET.arch}-${pkg.version}.zip`);
  });

  it('ships the release icon that forge.config.ts points at', () => {
    expect(read('forge.config.ts')).toMatch(/icon: path\.resolve\(__dirname, 'assets', 'icon', 'puck'\)/);
    expect(statSync(join(root, 'assets', 'icon', 'puck.icns')).size).toBeGreaterThan(0);
    expect(read('assets/icon/puck.svg')).toContain('<svg');
  });

  it('keeps signing out of the repository: no identity or credential literal in the config', () => {
    const config = read('forge.config.ts');
    expect(config).toContain("import { signingPlan } from './scripts/release.mjs'");
    expect(config).not.toMatch(/Developer ID Application:/);
    expect(config).not.toMatch(/appleIdPassword|appleApiKey/);
  });
});
