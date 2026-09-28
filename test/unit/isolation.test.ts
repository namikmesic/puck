import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyIsolatedLaunch,
  ISOLATED_DIR_ENV,
  ISOLATED_ENV,
  MOCK_KEYCHAIN_SWITCH,
  type IsolationApp,
} from '../../src/main/isolation';

function fakeApp(): IsolationApp & { paths: Record<string, string>; switches: string[] } {
  const paths: Record<string, string> = {};
  const switches: string[] = [];
  return {
    paths,
    switches,
    setPath: (name, value) => {
      paths[name] = value;
    },
    commandLine: { appendSwitch: (name) => switches.push(name) },
  };
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('isolated launch', () => {
  it('leaves a normal launch untouched', () => {
    const app = fakeApp();
    expect(applyIsolatedLaunch(app, {})).toBeNull();
    expect(applyIsolatedLaunch(app, { [ISOLATED_ENV]: '0', [ISOLATED_DIR_ENV]: ' ' })).toBeNull();
    expect(app.paths).toEqual({});
    expect(app.switches).toEqual([]);
  });

  it('moves every data path into a fresh throwaway dir and switches to the mock keychain', () => {
    const home = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-iso-test-'));
    made.push(tmp);
    const app = fakeApp();
    const launch = applyIsolatedLaunch(app, { [ISOLATED_ENV]: '1', HOME: home }, tmp);
    expect(launch).not.toBeNull();
    const dataDir = launch?.dataDir ?? '';
    expect(path.dirname(dataDir)).toBe(tmp);
    expect(fs.statSync(dataDir).isDirectory()).toBe(true);
    expect(app.paths).toEqual({
      userData: dataDir,
      sessionData: dataDir,
      crashDumps: path.join(dataDir, 'Crashpad'),
    });
    expect(app.switches).toEqual([MOCK_KEYCHAIN_SWITCH]);
    expect(MOCK_KEYCHAIN_SWITCH).toBe('use-mock-keychain');
    // Isolation never replaces HOME.
    expect(process.env.HOME).toBe(home);
  });

  it('uses a caller-given dir as-is', () => {
    const given = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'puck-iso-test-')), 'data');
    made.push(path.dirname(given));
    const app = fakeApp();
    const launch = applyIsolatedLaunch(app, { [ISOLATED_DIR_ENV]: given });
    expect(launch).toEqual({ dataDir: given });
    expect(fs.statSync(given).isDirectory()).toBe(true);
    expect(app.paths.userData).toBe(given);
    expect(app.switches).toEqual([MOCK_KEYCHAIN_SWITCH]);
  });
});
