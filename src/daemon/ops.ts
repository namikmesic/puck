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
  type RecordKind,
  PAGE_LIMITS,
} from '../harness/daemon-protocol';
import { REFERENCE_TEXT_BYTES } from '../harness/references';
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

function links(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 20) bad('links must be a list of at most 20 links.');
  return v.map((l: unknown) => {
    if (typeof l !== 'string' || !l.trim()) bad('each link must be text.');
    if (Buffer.byteLength(l, 'utf8') > REFERENCE_TEXT_BYTES) throw new OpError('limit', `A link is longer than ${REFERENCE_TEXT_BYTES} bytes.`);
    return l;
  });
}

const RECORD_KINDS: readonly RecordKind[] = ['rounds', 'steps', 'reviews', 'findings', 'decisions', 'trail', 'audits'];

export const VALIDATORS: { [O in Op]: (args: unknown) => OpArgs<O> } = {
  'snapshot.get': none,
  'snapshot.part': (args) => ({ cursor: text(obj(args), 'cursor', 64, true) as string }),
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
      links: links(o.links),
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
  'item.accept': (args) => {
    const o = obj(args);
    const reason = text(o, 'reason', 4 * 1024, false);
    return { itemId: id(o, 'itemId'), ...(reason !== undefined && reason.trim() ? { reason } : {}) };
  },
  'item.link': (args) => {
    const o = obj(args);
    const ref = text(o, 'ref', REFERENCE_TEXT_BYTES, true) as string;
    if (!ref.trim()) bad('ref is empty.');
    return { itemId: id(o, 'itemId'), ref };
  },
  'item.unlink': (args) => {
    const o = obj(args);
    return { itemId: id(o, 'itemId'), referenceId: id(o, 'referenceId') };
  },
  'item.workflow': (args) => {
    const o = obj(args);
    return { itemId: id(o, 'itemId'), round: int(o, 'round', 1, 1_000_000) };
  },
  'item.records': (args) => {
    const o = obj(args);
    if (typeof o.kind !== 'string' || !RECORD_KINDS.includes(o.kind as RecordKind)) bad(`kind must be one of ${RECORD_KINDS.join(', ')}.`);
    if (o.status !== undefined && (!Array.isArray(o.status) || o.status.some((s) => typeof s !== 'string' || s.length > 32))) bad('status must be a list of statuses.');
    return {
      itemId: id(o, 'itemId'),
      kind: o.kind as RecordKind,
      round: int(o, 'round', 1, 1_000_000),
      findingId: optId(o, 'findingId'),
      status: o.status as string[] | undefined,
      cursor: text(o, 'cursor', 128, false),
      limit: int(o, 'limit', 1, PAGE_LIMITS.recordsLimit),
    };
  },
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
  'issue.search': (args) => {
    const o = obj(args);
    const query = text(o, 'query', 256, true) as string;
    const repo = text(o, 'repo', 140, false);
    if (repo !== undefined && !REPO_RE.test(repo) && !NAME_RE.test(repo)) bad('repo must be owner/name or a directory name.');
    if (o.state !== undefined && o.state !== 'open' && o.state !== 'closed' && o.state !== 'all') bad('state must be "open", "closed" or "all".');
    return { query, repo, state: o.state as 'open' | 'closed' | 'all' | undefined };
  },
  'item.pr': itemOnly,
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

/** What a handler knows about the connection its command came on. */
export interface HandlerContext {
  protocol: number;
}

export type Handlers = { [O in Op]: (args: OpArgs<O>, ctx: HandlerContext) => Promise<OpResult<O>> | OpResult<O> };

/** Validate, then run the op's handler. Throws OpError for client-facing failures. */
export async function dispatch(handlers: Handlers, op: Op, args: unknown, ctx: HandlerContext = { protocol: 2 }): Promise<unknown> {
  const validate = VALIDATORS[op] as (a: unknown) => unknown;
  const parsed = validate(args);
  const handler = handlers[op] as (a: unknown, c: HandlerContext) => unknown;
  return handler(parsed, ctx);
}
