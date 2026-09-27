/** Scripted fetch, clock and sleep for the GitHub client tests. */

import type { GitHubDeps } from '../../src/harness/github';

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Scripted = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/**
 * A fake GitHub: responses are served in order (or by a handler), every
 * request is recorded, and time only moves when the code under test sleeps.
 */
export function fakeGitHub(script: Scripted[] | ((req: Recorded) => Scripted)) {
  const requests: Recorded[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const queue = Array.isArray(script) ? [...script] : null;
  const deps: GitHubDeps = {
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      sleeps.push(ms);
      clock += ms;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const req: Recorded = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: { ...(init?.headers as Record<string, string>) },
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      requests.push(req);
      const next = queue ? queue.shift() : (script as (r: Recorded) => Scripted)(req);
      if (!next) throw new Error(`unscripted request ${req.method} ${req.url}`);
      if (next instanceof Error) throw next;
      const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
      return new Response(text, { status: next.status ?? 200, headers: next.headers });
    }) as typeof fetch,
  };
  return {
    deps,
    requests,
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

export const form = (req: Recorded): Record<string, string> => Object.fromEntries(new URLSearchParams(req.body ?? ''));
