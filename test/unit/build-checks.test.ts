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

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (current) words.push(current);
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\') current += command[++i] ?? '';
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      const next = command[++i];
      if (next === undefined || next === '\n') continue;
      current += next;
      continue;
    }
    if (ch === '#' && current === '') break;
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return words;
}

function splitOutsideQuotes(input: string, separator: (index: number, source: string) => number): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    const size = separator(i, input);
    if (size > 0) {
      parts.push(input.slice(start, i));
      i += size - 1;
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function shellPipelines(script: string): string[][][] {
  const statements = splitOutsideQuotes(script, (i, source) => {
    const two = source.slice(i, i + 2);
    if (two === '&&' || two === '||') return 2;
    if (source[i] === ';' || source[i] === '\n') return 1;
    return 0;
  });
  const pipelines: string[][][] = [];
  for (const statement of statements) {
    const pipe = splitOutsideQuotes(statement, (i, source) => (source[i] === '|' && source[i + 1] !== '|' ? 1 : 0))
      .map((segment) => shellWords(segment))
      .filter((argv) => argv.length > 0);
    if (pipe.length) pipelines.push(pipe);
  }
  return pipelines;
}

function optionValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === name) return argv[i + 1];
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
  }
  return undefined;
}

function invokes(argv: string[], script: string): boolean {
  return argv.some((token) => token === script || token.endsWith(`/${script}`));
}

function npmScript(argv: string[]): string | undefined {
  const run = argv.indexOf('run');
  if (run < 0 || !argv.slice(0, run).includes('npm')) return undefined;
  let i = run + 1;
  if (argv[i] === '--') i++;
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') return undefined;
    if (!token.startsWith('-')) return token;
  }
  return undefined;
}

function commandMode(command: string, entry: string): string | undefined {
  const argv = shellWords(command);
  return invokes(argv, entry) ? optionValue(argv, '--mode') : undefined;
}

function dockerfileInstructions(source: string): { name: string; args: string }[] {
  const instructions: { name: string; args: string }[] = [];
  let pending = '';
  let continued = false;
  for (const raw of source.split(/\r?\n/)) {
    if (!continued && /^\s*(#|$)/.test(raw)) continue;
    const escape = raw.endsWith('\\');
    pending += escape ? raw.slice(0, -1) : raw;
    if (escape) {
      continued = true;
      continue;
    }
    continued = false;
    const text = pending.trim();
    pending = '';
    const match = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(text);
    if (match) instructions.push({ name: match[1].toUpperCase(), args: match[2].trim() });
  }
  return instructions;
}

function isProductionPackaging(argv: string[]): boolean {
  const script = npmScript(argv);
  if (script === 'package:runner:release') return true;
  const packagesRunner = script === 'package:runner' || script === 'build:runner' || invokes(argv, 'package-runner.mjs') || invokes(argv, 'build-runner.mjs');
  return packagesRunner && optionValue(argv, '--mode') === 'production';
}

function isReleaseSigning(argv: string[]): boolean {
  const script = npmScript(argv);
  if (script === 'runner-release') return argv.slice(argv.indexOf(script) + 1).includes('sign');
  return invokes(argv, 'runner-release.mjs') && argv.includes('sign');
}

function mentions(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => mentions(item, needle));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => key.includes(needle) || mentions(item, needle));
  }
  return false;
}

function isRunnerVersionProbe(argv: string[]): boolean {
  return argv.includes('version') && argv.includes('--json') && argv.some((token) => token.includes('puck-runner'));
}

function assertsDevelopmentTrust(argv: string[]): boolean {
  return argv.some((arg) => arg.includes('trustMode') && arg.includes('development') && !arg.includes('production'));
}

describe('runner trust mode and release signing', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const dockerfile = read('src/server/Dockerfile');
  const workflow = parseYaml(read('.github/workflows/ci.yml')) as { jobs?: Record<string, { steps?: { name?: string; run?: unknown }[] }> };
  const jobs = Object.values(workflow.jobs ?? {});
  const steps = jobs.flatMap((job) => job.steps ?? []);

  it('builds and packages the runner in an explicit trust mode', () => {
    expect(commandMode(pkg.scripts['build:runner'], 'build-runner.mjs')).toBe('development');
    expect(commandMode(pkg.scripts['package:runner'], 'package-runner.mjs')).toBe('development');
    expect(commandMode(pkg.scripts['package:runner:release'], 'package-runner.mjs')).toBe('production');
  });

  it('packages the development server image in development mode', () => {
    const runs = dockerfileInstructions(dockerfile)
      .filter((instruction) => instruction.name === 'RUN')
      .map((instruction) => shellWords(instruction.args))
      .filter((argv) => invokes(argv, 'package-runner.mjs'));
    expect(runs).toHaveLength(1);
    expect(optionValue(runs[0], '--mode')).toBe('development');
  });

  it('never packages production runners or signs in CI, and checks the packaged runner reports development trust', () => {
    const commands = steps.flatMap((step) => (typeof step.run === 'string' ? shellPipelines(step.run).flat() : []));
    expect(commands.filter(isProductionPackaging)).toEqual([]);
    expect(commands.filter(isReleaseSigning)).toEqual([]);
    expect(mentions(workflow, 'PUCK_RUNNER_RELEASE_PRIVATE_KEY')).toBe(false);

    const tarball = steps.filter((step) => typeof step.name === 'string' && step.name.includes('macOS') && step.name.toLowerCase().includes('tarball'));
    expect(tarball).toHaveLength(1);
    const script = tarball[0].run;
    if (typeof script !== 'string') throw new Error('expected the macOS runner tarball step to have a run script');
    const pipelines = shellPipelines(script);
    expect(pipelines.flat().filter((argv) => npmScript(argv) === 'package:runner')).toHaveLength(1);
    expect(pipelines.some((pipe) => pipe.some(isRunnerVersionProbe) && pipe.some(assertsDevelopmentTrust))).toBe(true);
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
