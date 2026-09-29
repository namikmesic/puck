/**
 * The starter Puck home: the files Puck commits when it initializes a new
 * home. They are the example home in docs/examples/config-repo/, the single
 * source, imported as text; test/unit/home-starter.test.ts fails when a
 * file there is missing from STARTER_FILES or differs from it.
 *
 * The one environment is the example's, pointed at a repository the user
 * picked: its name and directory follow that repository's name, and its
 * branch is that repository's default branch.
 */

import implementer from '../../docs/examples/config-repo/agents/implementer.yaml?raw';
import lead from '../../docs/examples/config-repo/agents/lead.yaml?raw';
import reviewer from '../../docs/examples/config-repo/agents/reviewer.yaml?raw';
import example from '../../docs/examples/config-repo/environments/example.yaml?raw';
import validate from '../../docs/examples/config-repo/.github/workflows/validate.yml?raw';
import leadPrompt from '../../docs/examples/config-repo/prompts/lead.md?raw';
import reviewerPrompt from '../../docs/examples/config-repo/prompts/reviewer.md?raw';
import schema from '../../docs/examples/config-repo/puck.schema.json?raw';
import readme from '../../docs/examples/config-repo/README.md?raw';
import { NAME_RE } from '../harness/definitions/types';

/** Every file of the example home by repository path. */
export const STARTER_FILES: Readonly<Record<string, string>> = {
  '.github/workflows/validate.yml': validate,
  'README.md': readme,
  'agents/implementer.yaml': implementer,
  'agents/lead.yaml': lead,
  'agents/reviewer.yaml': reviewer,
  'environments/example.yaml': example,
  'prompts/lead.md': leadPrompt,
  'prompts/reviewer.md': reviewerPrompt,
  'puck.schema.json': schema,
};

const EXAMPLE_ENV = 'environments/example.yaml';

/** The repository the starter environment works on. */
export interface StarterRepo {
  fullName: string;
  defaultBranch: string;
}

/** A definition name from a repository name: lowercase letters, digits and dashes; `fallback` when nothing is left. */
export function nameFrom(repoName: string, fallback: string): string {
  const name = repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return NAME_RE.test(name) ? name : fallback;
}

/** Replaces the one match of `pattern`; `next` gets its groups. A function, so a `$` in a repository's text stays literal. */
function replaceOnce(text: string, pattern: RegExp, next: (...groups: string[]) => string): string {
  const m = pattern.exec(text);
  if (!m) throw new Error(`The example environment no longer matches ${pattern}; update home-starter.ts.`);
  return text.slice(0, m.index) + next(...m.slice(1)) + text.slice(m.index + m[0].length);
}

/** The starter environment's file name and text, pointed at `repo`. */
export function starterEnvironment(repo: StarterRepo): { path: string; text: string } {
  const repoName = repo.fullName.split('/')[1] ?? '';
  const name = nameFrom(repoName, 'example');
  const dir = nameFrom(repoName, 'app');
  let text = STARTER_FILES[EXAMPLE_ENV];
  text = replaceOnce(text, /^name: example$/m, () => `name: ${name}`);
  text = replaceOnce(text, /^ *# Replace with a repository your GitHub sign-in can reach\.\n/m, () => '');
  text = replaceOnce(text, /^( *- github: )your-org\/your-app$/m, (lead) => lead + JSON.stringify(repo.fullName));
  text = replaceOnce(text, /^( *dir: )app( +# cloned to \/workspace\/)app$/m, (lead, mid) => lead + dir + mid + dir);
  text = replaceOnce(text, /^( *branch: )main( +#.*)$/m, (lead, tail) => lead + JSON.stringify(repo.defaultBranch) + tail);
  return { path: `environments/${name}.yaml`, text };
}

/** The files of a new Puck home whose one environment works on `repo`. */
export function starterFiles(repo: StarterRepo): Record<string, string> {
  const files: Record<string, string> = { ...STARTER_FILES };
  delete files[EXAMPLE_ENV];
  const env = starterEnvironment(repo);
  files[env.path] = env.text;
  return files;
}
