/**
 * Command argument validators, one per protocol op. Nothing a client sends
 * reaches a handler unchecked: each validator returns typed args or throws
 * `invalid-args`. The table is keyed by Op, so a new op without a
 * validator fails to compile (and a unit test checks the table against
 * the protocol's op list).
 */

import {
  COMMAND_LIMITS,
  type ErrorCode,
  type GithubGrant,
  type ItemPosition,
  type Op,
  type OpArgs,
  type OpResult,
  type Pin,
} from '../harness/daemon-protocol';
import { REPO_RE } from '../harness/env-definition';
import { validPin } from '../harness/inbox';
import { MAX_GRANTS } from './credentials';

export class OpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Obj = Record<string, unknown>;

function bad(message: string): never {
  throw new OpError('invalid-args', message);
}

function obj(args: unknown): Obj {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) bad('Arguments must be an object.');
  return args as Obj;
}

const ID_RE = /^[a-z]{2,4}_[0-9A-Z]{26}$/;

function id(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !ID_RE.test(v)) bad(`${key} is not a valid id.`);
  return v;
}

function optId(o: Obj, key: string): string | undefined {
  return o[key] === undefined ? undefined : id(o, key);
}

function text(o: Obj, key: string, maxBytes: number, required: boolean): string | undefined {
  const v = o[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') bad(`${key} must be a string.`);
  if (Buffer.byteLength(v, 'utf8') > maxBytes) throw new OpError('limit', `${key} is longer than ${maxBytes} bytes.`);
  return v;
}

function int(o: Obj, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) bad(`${key} must be an integer from ${min} to ${max}.`);
  return v;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function position(v: unknown): ItemPosition {
  if (v === 'top' || v === 'bottom') return v;
  if (v && typeof v === 'object') {
    const p = v as Obj;
    if (typeof p.before === 'string' && ID_RE.test(p.before)) return { before: p.before };
    if (typeof p.after === 'string' && ID_RE.test(p.after)) return { after: p.after };
  }
  bad('position must be "top", "bottom", { before } or { after }.');
}

function answers(v: unknown): Record<string, string> | null {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad('answers must be an object or null.');
  const out: Record<string, string> = {};
  for (const [q, a] of Object.entries(v as Obj)) {
    if (typeof a !== 'string' || q.length > 2000 || a.length > 20_000) bad('answers must map question text to text.');
    out[q] = a;
  }
  return out;
}

const none = (args: unknown): Record<string, never> => {
  obj(args);
  return {};
};

const itemOnly = (args: unknown): { itemId: string } => ({ itemId: id(obj(args), 'itemId') });

export const VALIDATORS: { [O in Op]: (args: unknown) => OpArgs<O> } = {
  'snapshot.get': none,
  'session.history': (args) => {
    const o = obj(args);
    return {
      sessionId: id(o, 'sessionId'),
      before: int(o, 'before', 0, Number.MAX_SAFE_INTEGER),
      limit: int(o, 'limit', 1, COMMAND_LIMITS.historyMax),
    };
  },
  'chat.send': (args) => {
    const o = obj(args);
    const t = text(o, 'text', COMMAND_LIMITS.chatTextBytes, true) as string;
    if (!t.trim()) bad('text is empty.');
    return { sessionId: optId(o, 'sessionId'), text: t };
  },
  'session.interrupt': (args) => ({ sessionId: id(obj(args), 'sessionId') }),
  'ask.answer': (args) => {
    const o = obj(args);
    return { sessionId: id(o, 'sessionId'), askId: id(o, 'askId'), answers: answers(o.answers) };
  },
  'item.create': (args) => {
    const o = obj(args);
    const title = text(o, 'title', 200 * 4, true) as string;
    if (!title.trim() || title.length > 200) bad('title must be 1 to 200 characters.');
    const agent = o.agent === undefined ? undefined : text(o, 'agent', 64, true);
    if (agent !== undefined && !NAME_RE.test(agent)) bad('agent is not a valid name.');
    const repo = o.repo === undefined ? undefined : text(o, 'repo', 64, true);
    if (repo !== undefined && !NAME_RE.test(repo)) bad('repo is not a valid directory name.');
    return {
      title,
      body: text(o, 'body', 64 * 1024, false),
      agent,
      repo,
      position: o.position === undefined ? undefined : position(o.position),
    };
  },
  'item.update': (args) => {
    const o = obj(args);
    const title = text(o, 'title', 800, false);
    if (title !== undefined && (!title.trim() || title.length > 200)) bad('title must be 1 to 200 characters.');
    const repo = text(o, 'repo', 64, false);
    if (repo !== undefined && !NAME_RE.test(repo)) bad('repo is not a valid directory name.');
    return { itemId: id(o, 'itemId'), title, body: text(o, 'body', 64 * 1024, false), repo };
  },
  'item.move': (args) => {
    const o = obj(args);
    return { itemId: id(o, 'itemId'), position: position(o.position) };
  },
  'item.assign': (args) => {
    const o = obj(args);
    if (o.agent !== null && (typeof o.agent !== 'string' || !NAME_RE.test(o.agent))) bad('agent must be a name or null.');
    return { itemId: id(o, 'itemId'), agent: o.agent as string | null };
  },
  'item.cancel': itemOnly,
  'item.retry': itemOnly,
  'item.accept': itemOnly,
  'item.publish': itemOnly,
  'item.delete': itemOnly,
  'issue.import': (args) => {
    const o = obj(args);
    if (typeof o.repo !== 'string' || !REPO_RE.test(o.repo)) bad('repo must be owner/name.');
    const number = int(o, 'number', 1, 2_147_483_647);
    if (number === undefined) bad('number is required.');
    const agent = o.agent === undefined ? undefined : text(o, 'agent', 64, true);
    if (agent !== undefined && !NAME_RE.test(agent)) bad('agent is not a valid name.');
    return { repo: o.repo, number, agent, position: o.position === undefined ? undefined : position(o.position) };
  },
  'github.nudge': (args) => {
    const o = obj(args);
    if (typeof o.repo !== 'string' || !REPO_RE.test(o.repo)) bad('repo must be owner/name.');
    if (o.kind !== 'issue' && o.kind !== 'pull' && o.kind !== 'checks') bad('kind must be "issue", "pull" or "checks".');
    return { repo: o.repo, kind: o.kind, number: int(o, 'number', 1, 2_147_483_647) };
  },
  'definition.apply': (args) => {
    const o = obj(args);
    const pin: Pin | null = validPin(o.pin);
    if (!pin) bad('pin is not a valid pin.');
    if (!o.definition || typeof o.definition !== 'object') bad('definition must be an object.');
    return { definition: o.definition, pin };
  },
  'credentials.put': (args) => {
    const o = obj(args);
    if (!Array.isArray(o.harness)) bad('harness must be a list.');
    return {
      harness: o.harness.map((h: unknown) => {
        const e = obj(h);
        if (typeof e.id !== 'string' || !NAME_RE.test(e.id) || (typeof e.content !== 'string' && e.content !== null)) {
          bad('each harness credential needs an id and content (null removes it).');
        }
        return { id: e.id, content: e.content as string | null };
      }),
    };
  },
  'credentials.get': none,
  'github.put': (args) => {
    const o = obj(args);
    if (!Array.isArray(o.grants) || o.grants.length === 0 || o.grants.length > MAX_GRANTS) {
      bad(`grants must be a list of 1 to ${MAX_GRANTS} installation token grants.`);
    }
    return { grants: o.grants as GithubGrant[] };
  },
  'secrets.put': (args) => {
    const o = obj(args);
    if (!o.values || typeof o.values !== 'object' || Array.isArray(o.values)) bad('values must be an object.');
    return { values: o.values as Record<string, string> };
  },
  'scheduler.pause': none,
  'scheduler.resume': none,
  'daemon.upgrade': (args) => {
    const o = obj(args);
    if (o.mode !== 'drain' && o.mode !== 'now') bad('mode must be "drain" or "now".');
    return { mode: o.mode };
  },
  'logs.tail': (args) => {
    const o = obj(args);
    return { lines: int(o, 'lines', 1, COMMAND_LIMITS.logsTailMax) ?? 200 };
  },
};

export type Handlers = { [O in Op]: (args: OpArgs<O>) => Promise<OpResult<O>> | OpResult<O> };

/** Validate, then run the op's handler. Throws OpError for client-facing failures. */
export async function dispatch(handlers: Handlers, op: Op, args: unknown): Promise<unknown> {
  const validate = VALIDATORS[op] as (a: unknown) => unknown;
  const parsed = validate(args);
  const handler = handlers[op] as (a: unknown) => unknown;
  return handler(parsed);
}
