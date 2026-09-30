import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

// The import boundaries .eslintrc.json enforces around the runner-release
// verifier: shared by the server, the app's main process and the runner;
// never in the renderer, the preload, the daemon or the pure harness.

const root = join(__dirname, '..', '..');
const eslint = new ESLint({ cwd: root });

/** Boundary errors for `source` as if it were the file at `file`. */
async function boundaryErrors(file: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: join(root, file) });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'import/no-nodejs-modules').map((m) => m.message);
}

describe('runner-release import boundary', () => {
  it('lets the server, the main process and the runner import the verifier', async () => {
    for (const [file, from] of [
      ['src/server/x.ts', '../runner-release/verify'],
      ['src/main/runners/x.ts', '../../runner-release/verify'],
      ['src/index.ts', './runner-release/verify'],
      ['src/puck-runner/x.ts', '../runner-release/verify'],
    ]) {
      expect(await boundaryErrors(file, `import { verifyRunnerRelease } from '${from}';\nexport const v = verifyRunnerRelease;\n`), file).toEqual([]);
    }
  });

  it('keeps it out of the renderer, the preload, the daemon and the harness', async () => {
    for (const [file, from] of [
      ['src/renderer/x.ts', '../runner-release/verify'],
      ['src/renderer.ts', './runner-release/verify'],
      ['src/preload.ts', './runner-release/trust'],
      ['src/daemon/x.ts', '../runner-release/verify'],
      ['src/harness/x.ts', '../runner-release/trust'],
    ]) {
      expect(await boundaryErrors(file, `import * as r from '${from}';\nexport const v = r;\n`), file).toHaveLength(1);
    }
  });

  it('lets the verifier import only the harness, itself and node:crypto', async () => {
    const file = 'src/runner-release/x.ts';
    expect(await boundaryErrors(file, "import { createHash } from 'node:crypto';\nimport { readRunnerRelease } from '../harness/runner-releases';\nimport { RELEASE_KEYS } from './trust';\nexport const v = [createHash, readRunnerRelease, RELEASE_KEYS];\n")).toEqual([]);
    for (const from of ['node:fs', 'fs', 'electron', '../channel/wire', '../main/log', '../server/http', '../puck-runner/tar', '../daemon/main', '../renderer/format']) {
      expect(await boundaryErrors(file, `import * as m from '${from}';\nexport const v = m;\n`), from).not.toEqual([]);
    }
  });

  it('still keeps runner and daemon code out of the main process', async () => {
    expect(await boundaryErrors('src/main/x.ts', "import * as m from '../puck-runner/tar';\nexport const v = m;\n")).toHaveLength(1);
    expect(await boundaryErrors('src/index.ts', "import * as m from './daemon/main';\nexport const v = m;\n")).toHaveLength(1);
  });
});
