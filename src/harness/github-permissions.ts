/**
 * The App permissions an environment's installation tokens carry.
 *
 * Always contents and pull requests (write) and metadata (read). Issues
 * write while intake or the status comment is on, and read otherwise
 * (issues can always be imported by hand). Checks and commit statuses
 * (read) to watch CI. Actions write, because the orchestrator may re-run
 * failed jobs under either CI policy. Workflows (write) only when the
 * definition allows workflow edits. Without workflows, GitHub refuses any
 * push that changes `.github/workflows/`, so a prompt-injected agent cannot
 * add a workflow that runs with the repository's secrets.
 *
 * These four fields are the whole input. A definition update that changes
 * the resulting set has to be stored on the instance before the next mint.
 */

export interface GitHubTokenPolicies {
  intake: 'off' | 'label';
  statusComment: boolean;
  ci: 'notify' | 'fix';
  allowWorkflowEdits: boolean;
}

export const DEFAULT_TOKEN_POLICIES: GitHubTokenPolicies = {
  intake: 'off',
  statusComment: true,
  ci: 'notify',
  allowWorkflowEdits: false,
};

export type TokenPermission = 'read' | 'write';

export function permissionsFor(p: GitHubTokenPolicies): Record<string, TokenPermission> {
  const perms: Record<string, TokenPermission> = {
    contents: 'write',
    pull_requests: 'write',
    metadata: 'read',
    issues: p.intake === 'label' || p.statusComment ? 'write' : 'read',
    checks: 'read',
    statuses: 'read',
    actions: 'write',
  };
  if (p.allowWorkflowEdits) perms.workflows = 'write';
  return perms;
}

/** The permission-relevant slice of a definition's `policies.github`. */
export function tokenPoliciesFrom(github: GitHubTokenPolicies): GitHubTokenPolicies {
  return {
    intake: github.intake,
    statusComment: github.statusComment,
    ci: github.ci,
    allowWorkflowEdits: github.allowWorkflowEdits,
  };
}

/** True when two policy sets mint the same App permissions. */
export function sameTokenPermissions(a: GitHubTokenPolicies, b: GitHubTokenPolicies): boolean {
  const left = permissionsFor(a);
  const right = permissionsFor(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}
