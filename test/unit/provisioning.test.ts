import { describe, expect, it } from 'vitest';
import {
  bootstrapPlan,
  describePinFailure,
  expectedPackages,
  parseInstalledVersions,
  pinnedSpec,
  SDK_PREFIX,
  verifyPins,
  verifyScript,
  type ExpectedPackage,
} from '../../src/harness/provisioning';
import { harnessDescriptors as providers, type HarnessDescriptor } from '../../src/harness/providers';

function providerStub(packages: HarnessDescriptor['packages']): HarnessDescriptor {
  return { packages } as HarnessDescriptor;
}

describe('bootstrapPlan (pinned installs)', () => {
  it('checks every pinned version read-only and installs the exact pins separately', () => {
    const plan = bootstrapPlan(providers);
    expect(plan.map((s) => s.kind)).toEqual(['clis', 'sdks']);
    const [clis, sdks] = plan;
    // CLIs: resolved against the global npm root, installed with -g.
    expect(clis.check).toContain('root="$(npm root -g)"');
    expect(clis.check).not.toContain('npm install');
    for (const pkg of providers.flatMap((p) => p.packages.cli)) {
      expect(clis.check).toContain(`[ "$(v "$root/${pkg.name}")" = "${pkg.version}" ]`);
    }
    expect(clis.install).toBe(
      'npm install -g ' + providers.flatMap((p) => p.packages.cli).map(pinnedSpec).join(' '),
    );
    // SDKs: under /opt/puck for the runner's require().
    expect(sdks.check).not.toContain('npm install');
    for (const pkg of providers.flatMap((p) => p.packages.sdk)) {
      expect(sdks.check).toContain(`[ "$(v "${SDK_PREFIX}/node_modules/${pkg.name}")" = "${pkg.version}" ]`);
    }
    expect(sdks.install).toBe(
      `npm install --prefix ${SDK_PREFIX} ` +
        providers.flatMap((p) => p.packages.sdk).map(pinnedSpec).join(' '),
    );
    // Every installed spec carries an exact version.
    for (const spec of [clis.install, sdks.install].flatMap((s) => s.split(' ').filter((w) => w.startsWith('@')))) {
      expect(spec).toMatch(/^@[^@]+@\d+\.\d+\.\d+$/);
    }
  });

  it('stays valid shell for a CLI-less (API-key-only) provider', () => {
    const plan = bootstrapPlan([
      providerStub({
        cliBin: '',
        cli: [],
        sdk: [{ name: '@x/sdk', version: '1.2.3' }],
      }),
    ]);
    // No CLI step at all — never a dangling `npm install -g `.
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('sdks');
    expect(plan[0].install).toBe(`npm install --prefix ${SDK_PREFIX} @x/sdk@1.2.3`);
    expect(plan[0].check).toContain('@x/sdk');
  });

  it('produces nothing for an empty registry', () => {
    expect(bootstrapPlan([])).toEqual([]);
  });
});

describe('version verification', () => {
  const expected: ExpectedPackage[] = [
    { name: '@a/cli', version: '1.0.0', kind: 'cli' },
    { name: '@a/sdk', version: '2.0.0', kind: 'sdk' },
  ];

  it('expectedPackages lists every registry pin with its kind', () => {
    const all = expectedPackages(providers);
    expect(all.filter((p) => p.kind === 'cli').map((p) => p.name)).toEqual(
      providers.flatMap((p) => p.packages.cli.map((c) => c.name)),
    );
    expect(all.filter((p) => p.kind === 'sdk').map((p) => p.name)).toEqual(
      providers.flatMap((p) => p.packages.sdk.map((c) => c.name)),
    );
  });

  it('verifyScript prints one "<name> <version|missing>" line per package, read-only', () => {
    const script = verifyScript(expected);
    expect(script).toContain('echo "@a/cli $(v "$root/@a/cli")"');
    expect(script).toContain(`echo "@a/sdk $(v "${SDK_PREFIX}/node_modules/@a/sdk")"`);
    expect(script).not.toContain('npm install');
  });

  it('parseInstalledVersions maps names to versions and "missing" to null', () => {
    const parsed = parseInstalledVersions('@a/cli 1.0.0\n@a/sdk missing\n\n');
    expect(parsed.get('@a/cli')).toBe('1.0.0');
    expect(parsed.get('@a/sdk')).toBeNull();
  });

  it('fails on any drift or absence', () => {
    const report = verifyPins(
      expected,
      new Map([
        ['@a/cli', '0.9.0'],
        ['@a/sdk', null],
      ]),
    );
    expect(report.errors).toEqual([
      '@a/cli is 0.9.0 globally, expected 1.0.0',
      `@a/sdk is not installed under ${SDK_PREFIX}, expected 2.0.0`,
    ]);
    expect(describePinFailure(report)).toMatch(/verification failed: @a\/cli is 0\.9\.0/);
  });

  it('an exact match produces no errors', () => {
    const report = verifyPins(
      expected,
      new Map([
        ['@a/cli', '1.0.0'],
        ['@a/sdk', '2.0.0'],
      ]),
    );
    expect(report).toEqual({ errors: [] });
  });
});
