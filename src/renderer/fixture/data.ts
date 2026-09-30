/**
 * Seeded data for the fixture harness (see ./index.ts): one environment
 * with a ticket in every place of the three columns (seeded in protocol
 * 1's eight statuses and mapped with `upgradeV1Item`, the app's own
 * fallback mapping), a failed and a cancelled ticket behind the Done
 * filter, a question for the user, and a ticket with an older question
 * for the orchestrator and a newer one for the user; two repositories, a multi-day
 * orchestrator conversation with step cards, answered and open questions
 * and notices, and short worker threads. Times are relative to `now`, so
 * the day dividers read Today, Yesterday and earlier days whenever it
 * runs. Dev only; never part of a packaged build.
 */

import type { InstanceInfo } from '../../harness/bridge';
import type { Capacity, OpenAsk, PullView, SessionSummary, Snapshot, WorkItem, WorkItemV1 } from '../../harness/daemon-protocol';
import { upgradeV1Item } from '../../harness/workflow';
import type { TranscriptEntry } from '../../harness/transcript';
import type { AskQuestion, HarnessEvent } from '../../harness/types';

export type Scenario = 'full' | 'empty' | 'provisioning' | 'unreachable';

export const SCENARIOS: readonly Scenario[] = ['full', 'empty', 'provisioning', 'unreachable'];

export const ENV_ID = 'env_01K6FIXTURE000000000000000';
export const ENV2_ID = 'env_01K6FIXTURE000000000000001';
export const ORCH = 'ses_orch';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A time `days` before today at `hh:mm` local time, so day dividers stay stable. */
function at(now: number, days: number, hh: number, mm: number): number {
  const d = new Date(now - days * DAY);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

export interface FixtureWorld {
  instances: InstanceInfo[];
  snapshot: Snapshot;
  /** Transcripts by session id, oldest first. */
  transcripts: Map<string, TranscriptEntry[]>;
  pulls: Map<string, PullView>;
}

function instances(scenario: Scenario): InstanceInfo[] {
  const main: InstanceInfo = {
    id: ENV_ID,
    name: 'acme-launch',
    runnerId: 'rnr_buildbox',
    runnerName: 'build-box',
    local: false,
    status: 'active',
    repos: ['acme/web', 'acme/api'],
    current: true,
    attach: scenario === 'unreachable' ? 'unreachable' : 'attached',
    attachDetail: scenario === 'unreachable' ? 'runner offline since 2:14 PM' : '',
    daemon: { status: scenario === 'provisioning' ? 'provisioning' : 'ready' },
    op: null,
    lastSeq: null,
  };
  const other: InstanceInfo = {
    id: ENV2_ID,
    name: 'docs-site',
    runnerId: 'rnr_thismac',
    runnerName: 'This Mac',
    local: true,
    status: 'active',
    repos: ['acme/docs'],
    current: false,
    attach: null,
    attachDetail: '',
    daemon: { status: 'ready' },
    op: null,
    lastSeq: null,
  };
  return [main, other];
}

function item(over: Partial<WorkItemV1> & Pick<WorkItemV1, 'number' | 'title' | 'status'>, now: number): WorkItem {
  return upgradeV1Item({
    id: `itm_${String(over.number).padStart(2, '0')}`,
    body: '',
    agent: null,
    repo: null,
    createdBy: 'user',
    createdAt: now - 4 * DAY,
    updatedAt: now - 2 * HOUR,
    attempts: 0,
    sessionId: null,
    branch: null,
    worktree: null,
    base: null,
    result: null,
    pr: null,
    source: null,
    lastError: null,
    cancelReason: null,
    acceptNote: null,
    pendingAsk: null,
    ...over,
  });
}

function result(ins: number, del: number, files: number, commits: string[], summary: string, endedAt: number) {
  return {
    summary,
    commits: commits.map((subject, i) => ({ sha: `${(0xa1b2c3d + i * 7919).toString(16)}e9f0${i}`, subject })),
    diffStat: { files, insertions: ins, deletions: del, text: '' },
    uncommitted: [],
    interrupted: false,
    endedAt,
  };
}

function issue(repo: string, number: number, now: number) {
  return { kind: 'github-issue' as const, repo, number, url: `https://github.com/${repo}/issues/${number}`, updatedAt: now - DAY };
}

function items(now: number): WorkItem[] {
  const base = { branch: 'main', sha: 'f00dfeed1234567' };
  return [
    item({ number: 1, title: 'Set up CI caching for the web build', status: 'done', agent: 'implementer', repo: 'web', attempts: 1, sessionId: 'ses_w1', branch: 'puck/W-1-ci-cache', base, updatedAt: at(now, 2, 10, 5), acceptNote: 'Merged #41', pr: { number: 41, url: 'https://github.com/acme/web/pull/41', draft: false, lastPushedSha: 'c0ffee1', state: 'merged', checks: { sha: 'c0ffee1', state: 'success', failing: [] } }, result: result(56, 12, 3, ['ci: cache npm and the build output'], 'Cached `~/.npm` and `.next/cache` keyed on the lockfile.', at(now, 3, 16, 0)) }, now),
    item({ number: 2, title: 'Add rate limiting to the public API', status: 'review', agent: 'implementer', repo: 'api', createdBy: 'orchestrator', attempts: 1, sessionId: 'ses_w2', branch: 'puck/W-2-rate-limit', base, updatedAt: now - 70 * MIN, pr: { number: 44, url: 'https://github.com/acme/api/pull/44', draft: false, lastPushedSha: 'beefcaf', state: 'open', checks: { sha: 'beefcaf', state: 'success', failing: [] } }, result: result(214, 38, 7, ['feat: token bucket per API key', 'test: rate limit headers', 'docs: rate limits'], 'Added a token-bucket limiter per API key (**100 req/min**), `429` with `Retry-After`, and tests.', now - 72 * MIN) }, now),
    item({ number: 3, title: 'Fix login redirect loop on expired sessions', status: 'running', agent: 'implementer', repo: 'web', attempts: 2, sessionId: 'ses_w3', branch: 'puck/W-3-login-redirect', base, source: issue('acme/web', 128, now), updatedAt: now - 7 * MIN }, now),
    item({ number: 4, title: 'Migrate user settings to the new schema', status: 'needs-input', agent: 'implementer', repo: 'api', attempts: 1, sessionId: 'ses_w4', branch: 'puck/W-4-settings-schema', base, pendingAsk: { askId: 'ask_w4', routedTo: 'user' }, updatedAt: now - 22 * MIN }, now),
    item({ number: 5, title: 'Review the payment webhook retries', status: 'needs-input', agent: 'reviewer', repo: 'api', createdBy: 'orchestrator', attempts: 1, sessionId: 'ses_w5', branch: 'puck/W-5-webhook-review', base, pendingAsk: { askId: 'ask_w5', routedTo: 'orchestrator' }, updatedAt: now - 3 * MIN }, now),
    item({ number: 6, title: 'Dark mode for the dashboard', status: 'queued', agent: 'implementer', repo: 'web', updatedAt: at(now, 1, 15, 2) }, now),
    item({ number: 7, title: 'Paginate the audit log endpoint', status: 'queued', agent: 'implementer', repo: 'api', createdBy: 'orchestrator', updatedAt: at(now, 1, 15, 3) }, now),
    item({ number: 8, title: 'Audit third-party dependency licenses', status: 'queued', agent: 'reviewer', repo: 'web', updatedAt: at(now, 1, 15, 4) }, now),
    item({ number: 9, title: 'Onboarding checklist copy', status: 'backlog', repo: 'web', source: issue('acme/web', 131, now), body: 'From the launch review: the checklist copy is out of date.' }, now),
    item({ number: 10, title: 'Flaky test: checkout total rounding', status: 'backlog', createdBy: 'orchestrator' }, now),
    item({ number: 11, title: 'Upgrade the web app to React 19 and remove the deprecated lifecycle methods', status: 'backlog', repo: 'web' }, now),
    item({ number: 12, title: 'Highlight matches in search results', status: 'failed', agent: 'implementer', repo: 'web', attempts: 3, sessionId: 'ses_w12', branch: 'puck/W-12-search-highlight', base, lastError: 'Tests failed after 3 attempts: 2 failing in search.spec.ts (highlight wraps across tokens).', updatedAt: at(now, 1, 11, 20) }, now),
    item({ number: 13, title: 'Legacy CSV export', status: 'cancelled', repo: 'api', cancelReason: 'Superseded by W-11.', updatedAt: at(now, 1, 16, 45) }, now),
    item({ number: 14, title: 'Add a health check endpoint', status: 'done', agent: 'implementer', repo: 'api', attempts: 1, sessionId: 'ses_w14', acceptNote: 'Accepted by the orchestrator', updatedAt: at(now, 3, 17, 30), result: result(48, 2, 2, ['feat: GET /healthz'], 'Added `GET /healthz` with a database ping.', at(now, 3, 17, 20)) }, now),
    item({ number: 15, title: 'Cache avatar images at the edge', status: 'review', agent: 'implementer', repo: 'web', attempts: 2, sessionId: 'ses_w15', branch: 'puck/W-15-avatar-cache', base, updatedAt: now - 2 * HOUR, pr: { number: 47, url: 'https://github.com/acme/web/pull/47', draft: true, lastPushedSha: 'dec0de9', state: 'open', checks: { sha: 'dec0de9', state: 'failure', failing: [{ name: 'e2e (chromium)', url: 'https://github.com/acme/web/actions/runs/1', summary: 'avatar.spec.ts: expected 200, got 304' }] } }, result: result(88, 20, 4, ['perf: cache avatars for a day', 'fix: vary on accept'], 'Avatars now carry `Cache-Control: public, max-age=86400`.', now - 2 * HOUR - 5 * MIN) }, now),
    item({ number: 16, title: 'Retry flaky webhook deliveries', status: 'review', agent: 'implementer', repo: 'api', attempts: 1, sessionId: 'ses_w16', branch: 'puck/W-16-webhook-retry', base, updatedAt: now - 3 * HOUR, result: result(12, 3, 1, ['fix: back off webhook retries'], 'Exponential backoff with jitter, capped at 5 tries.', now - 3 * HOUR - 2 * MIN) }, now),
    mixed(item({ number: 17, title: 'Split the invoice PDF renderer into a worker', status: 'needs-input', agent: 'implementer', repo: 'api', attempts: 1, sessionId: 'ses_w17', branch: 'puck/W-17-invoice-worker', base, pendingAsk: { askId: 'ask_w17a', routedTo: 'orchestrator' }, updatedAt: now - 40 * MIN }, now), now),
  ];
}

/** An older question routed to the orchestrator and a newer one routed to the user: the card counts the user's. */
function mixed(it: WorkItem, now: number): WorkItem {
  const older = it.needsInput;
  if (!older) return it;
  const newer = { ...older, askId: 'ask_w17b', since: now - 12 * MIN };
  return {
    ...it,
    needsInput: { ...older, since: now - 40 * MIN },
    oldestUserAsk: { askId: newer.askId, kind: newer.kind, roundId: newer.roundId, stepId: newer.stepId, since: newer.since },
    openAsks: 2,
    userAsks: 1,
  };
}

const ORDER = [9, 11, 10, 6, 7, 8, 3, 4, 17, 5, 2, 15, 16, 1, 14, 12, 13];

function session(over: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'kind' | 'agent'>, now: number): SessionSummary {
  return {
    harness: 'claude-code',
    cwd: '/workspace',
    status: 'idle',
    turns: 1,
    lastTurnTokens: 18_400,
    costUsd: 0.31,
    createdAt: now - 4 * DAY,
    lastActiveAt: now - HOUR,
    queued: 0,
    ...over,
  };
}

const RATE_Q: AskQuestion[] = [
  {
    question: 'Which rate limit strategy should W-2 use?',
    header: 'Strategy',
    multiSelect: false,
    options: [
      { label: 'Token bucket per API key', description: 'Smooth bursts; one bucket per key in Redis.' },
      { label: 'Fixed window per IP', description: 'Simplest; bursts at window edges.' },
    ],
  },
];

const W7_Q: AskQuestion[] = [
  {
    question: 'Should W-7 wait until W-2 merges? Both touch the API middleware.',
    header: 'Ordering',
    multiSelect: false,
    options: [
      { label: 'Wait for W-2', description: 'Hold W-7 in Ready until the rate limiter merges.' },
      { label: 'Run in parallel', description: 'Start W-7 now and rebase later.' },
    ],
  },
];

const W4_Q: AskQuestion[] = [
  {
    question: 'The old settings rows have 3,120 null `theme` values. How should the migration fill them?',
    header: 'Migration',
    multiSelect: false,
    options: [
      { label: "Default to 'system'", description: 'Matches what the app shows today.' },
      { label: "Default to 'light'", description: 'Matches the old server default.' },
      { label: 'Leave them null', description: 'Handle null in the reader instead.' },
    ],
  },
];

const W17_ORCH_Q: AskQuestion[] = [
  {
    question: 'Should the worker queue live in the API process or its own service?',
    header: 'Design',
    multiSelect: false,
    options: [
      { label: 'In process', description: 'A bounded in-memory queue.' },
      { label: 'Own service', description: 'A separate deployment.' },
    ],
  },
];

const W17_USER_Q: AskQuestion[] = [
  {
    question: 'May the renderer drop support for the legacy invoice template?',
    header: 'Scope',
    multiSelect: false,
    options: [
      { label: 'Yes, drop it', description: 'Nobody has used it since March.' },
      { label: 'Keep it', description: 'Render it through the old path.' },
    ],
  },
];

const W5_Q: AskQuestion[] = [
  {
    question: 'Retries use a fixed 30s delay. Flag it as blocking, or as a follow-up?',
    header: 'Severity',
    multiSelect: false,
    options: [
      { label: 'Blocking', description: 'Request changes on the PR.' },
      { label: 'Follow-up', description: 'Approve and open an item.' },
    ],
  },
];

type Ev = HarnessEvent;
const text = (t: string, ts: number): Ev => ({ kind: 'text-delta', text: t, ts });
const tool = (id: string, name: string, summary: string, input: string, ts: number): Ev => ({ kind: 'tool-start', toolId: id, tool: name, summary, input, ts });
const done = (id: string, output: string, ts: number, ok = true): Ev => ({ kind: 'tool-end', toolId: id, ok, output, ts });
const end = (inputTokens: number, outputTokens: number, durationMs: number, costUsd: number, ts: number): Ev => ({ kind: 'turn-end', stats: { inputTokens, outputTokens, durationMs, costUsd }, ts });

function orchestratorLog(now: number, openAsk: boolean): TranscriptEntry[] {
  const d3 = (h: number, m: number) => at(now, 3, h, m);
  const d2 = (h: number, m: number) => at(now, 2, h, m);
  const d1 = (h: number, m: number) => at(now, 1, h, m);
  /** Today, `m` minutes ago. */
  const d0 = (m: number) => now - m * MIN;
  const log: TranscriptEntry[] = [
    { kind: 'user', author: 'user', ts: d3(9, 12), text: 'We need the web and API repos ready for the October launch. Can you turn the launch checklist in `docs/launch.md` into work items?' },
    {
      kind: 'turn',
      turnId: 'trn_01',
      ts: d3(9, 12),
      events: [
        text("I'll read the checklist and the open launch issues first.\n\n", d3(9, 12)),
        tool('t1', 'Read', 'docs/launch.md', '{"file_path":"docs/launch.md"}', d3(9, 12)),
        done('t1', '# Launch checklist\n- CI caching\n- Rate limiting\n- Login redirect bug\n- Health check', d3(9, 12)),
        tool('t2', 'Bash', 'gh issue list --repo acme/web --label launch', 'gh issue list --repo acme/web --label launch', d3(9, 13)),
        done('t2', '128  Login redirect loops after the session expires\n131  Onboarding checklist copy', d3(9, 13)),
        tool('t3', 'create_item', 'Set up CI caching for the web build', '{"title":"Set up CI caching for the web build"}', d3(9, 13)),
        done('t3', 'Created W-1', d3(9, 13)),
        tool('t4', 'create_item', 'Add rate limiting to the public API', '{"title":"Add rate limiting to the public API"}', d3(9, 13)),
        done('t4', 'Created W-2', d3(9, 13)),
        text(
          'The checklist has four engineering tasks. I created them and queued the first two:\n\n' +
            '| Item | Repo | Agent |\n| --- | --- | --- |\n| W-1 CI caching | web | implementer |\n| W-2 Rate limiting | api | implementer |\n| W-3 Login redirect loop | web | backlog |\n| W-14 Health check | api | backlog |\n\n' +
            'W-3 comes from issue #128, so its pull request will close it.',
          d3(9, 14),
        ),
        end(48_210, 2_310, 38_400, 0.2724, d3(9, 14)),
      ],
    },
    { kind: 'notice', ts: d3(16, 2), notices: [{ id: 'n1', kind: 'item.review', at: d3(16, 2), text: 'W-1 finished and is ready for review (+56 −12).', itemId: 'itm_01' }] },
    { kind: 'notice', ts: d2(10, 5), notices: [{ id: 'n2', kind: 'pr.merged', at: d2(10, 5), text: 'W-1 pull request #41 was merged.', itemId: 'itm_01' }, { id: 'n3', kind: 'item.review', at: d2(10, 5), text: 'W-14 finished and is ready for review (+48 −2).', itemId: 'itm_14' }] },
    { kind: 'user', author: 'user', ts: d2(10, 31), text: 'Nice. Keep W-2 going; accept W-14 if the health check pings the database.' },
    {
      kind: 'turn',
      turnId: 'trn_02',
      ts: d2(10, 31),
      events: [
        tool('t5', 'get_item', 'W-14', '{"item":"W-14"}', d2(10, 31)),
        done('t5', 'W-14 review: GET /healthz with a database ping', d2(10, 31)),
        tool('t6', 'accept_item', 'W-14', '{"item":"W-14"}', d2(10, 32)),
        done('t6', 'W-14 accepted', d2(10, 32)),
        { kind: 'ask', askId: 'ask_rate', questions: RATE_Q, answers: { 'Which rate limit strategy should W-2 use?': 'Token bucket per API key' }, ts: d2(10, 32) },
        text('Accepted W-14: `GET /healthz` runs `SELECT 1` against the primary.\n\nW-2 will use a token bucket per API key, as you chose.', d2(10, 34)),
        end(61_900, 1_840, 184_000, 0.4131, d2(10, 34)),
      ],
    },
    { kind: 'user', author: 'user', ts: d1(11, 2), text: 'Search highlighting keeps failing. What happened?' },
    {
      kind: 'turn',
      turnId: 'trn_03',
      ts: d1(11, 2),
      events: [
        tool('t7', 'get_item', 'W-12', '{"item":"W-12"}', d1(11, 2)),
        done('t7', 'failed after 3 attempts', d1(11, 2)),
        text(
          'W-12 failed after three attempts. The highlighter splits on whitespace, so a match that spans two tokens never closes its `<mark>`:\n\n' +
            '```ts\nexpect(highlight("log in", "login")).toBe("<mark>log in</mark>");\n// received: "<mark>log</mark> in"\n```\n\n' +
            'I would retry it with a note to match on the normalized string instead.',
          d1(11, 3),
        ),
        end(22_480, 950, 12_700, 0.0917, d1(11, 3)),
      ],
    },
    { kind: 'notice', ts: d1(15, 1), notices: [{ id: 'n4', kind: 'item.created', at: d1(15, 1), text: 'W-6, W-7 and W-8 were queued.' }] },
    { kind: 'user', author: 'user', ts: d1(16, 44), text: 'Cancel W-13, it is superseded by W-11. And please delete W-12.' },
    {
      kind: 'turn',
      turnId: 'trn_04',
      ts: d1(16, 44),
      events: [
        tool('t8', 'cancel_item', 'W-13', '{"item":"W-13","reason":"Superseded by W-11."}', d1(16, 45)),
        done('t8', 'W-13 cancelled', d1(16, 45)),
        text('Cancelled W-13; it stays on the Board under Closed. Deleting is yours to do: open W-12 on the Board and choose **Delete** from its menu.', d1(16, 45)),
        end(19_020, 410, 6_100, 0.0388, d1(16, 45)),
      ],
    },
    { kind: 'notice', ts: d0(104), notices: [{ id: 'n5', kind: 'item.needs-input', at: d0(104), text: 'W-4 needs input: how should the migration fill null themes?', itemId: 'itm_04' }, { id: 'n6', kind: 'pr.checks', at: d0(104), text: 'W-15 pull request #47: e2e (chromium) is failing.', itemId: 'itm_15' }] },
    { kind: 'user', author: 'user', ts: d0(14), text: "What's the status of the launch work?" },
  ];
  const lastEvents: Ev[] = [
    tool('t9', 'list_items', 'status: running, needs-input, review', '{}', d0(14)),
    done('t9', '7 items', d0(14)),
    tool('t10', 'Task', 'Summarize the open pull requests', 'Read PRs #44 and #47 and summarize reviewer feedback.', d0(14)),
    done('t10', 'PR #44 approved by @dana; PR #47 draft with failing e2e.', d0(13)),
    text(
      "Here's where the launch stands:\n\n" +
        '- **Finished, waiting on you to accept or merge:** W-2 (rate limiting, PR #44 approved), W-15 (avatar caching, e2e failing), W-16 (webhook retries).\n' +
        '- **In progress:** W-3 is on its second attempt at the login redirect loop.\n' +
        '- **Waiting on you:** W-4 asks how to fill null themes.\n' +
        '- **Todo:** W-6, W-7 and W-8 start as agents free up.\n\n',
      d0(13),
    ),
  ];
  if (openAsk) {
    lastEvents.push({ kind: 'ask', askId: 'ask_orch', questions: W7_Q, ts: d0(12) });
    log.push({ kind: 'turn', turnId: 'trn_05', ts: d0(14), events: lastEvents });
  } else {
    lastEvents.push(end(52_300, 1_900, 71_400, 0.3316, d0(12)));
    log.push({ kind: 'turn', turnId: 'trn_05', ts: d0(14), events: lastEvents });
  }
  return log;
}

function workerLog(now: number, task: string, events: Ev[], started: number): TranscriptEntry[] {
  return [
    { kind: 'user', author: 'orchestrator', ts: started, text: task },
    { kind: 'turn', turnId: `trn_${started}`, ts: started, events },
  ];
}

export function buildWorld(scenario: Scenario, now = Date.now()): FixtureWorld {
  const transcripts = new Map<string, TranscriptEntry[]>();
  const pulls = new Map<string, PullView>();
  const empty = scenario === 'empty';
  const all = empty ? [] : items(now);
  const byNumber = new Map(all.map((i) => [i.number, i]));
  const order = empty ? [] : ORDER.map((n) => byNumber.get(n)?.id).filter((id): id is string => !!id);

  const capacity: Capacity = empty
    ? { agents: { implementer: { running: 0, max: 2 }, reviewer: { running: 0, max: 1 } }, workers: { running: 0, max: 3 }, paused: false }
    : { agents: { implementer: { running: 2, max: 2 }, reviewer: { running: 1, max: 1 } }, workers: { running: 3, max: 3 }, paused: false };

  const orchestrator = session(
    empty
      ? { id: ORCH, kind: 'orchestrator', agent: 'lead', turns: 0, lastTurnTokens: 0, costUsd: 0, createdAt: now - 5 * MIN, lastActiveAt: now - 5 * MIN }
      : { id: ORCH, kind: 'orchestrator', agent: 'lead', status: 'running', turns: 42, lastTurnTokens: 52_300, costUsd: 12.4817, lastActiveAt: now - 2 * MIN },
    now,
  );
  const sessions: SessionSummary[] = [orchestrator];
  const asks: OpenAsk[] = [];
  const inflight: Snapshot['inflight'] = [];

  if (!empty) {
    transcripts.set(ORCH, orchestratorLog(now, true));
    sessions.push(
      session({ id: 'ses_old1', kind: 'orchestrator', agent: 'lead', status: 'closed', turns: 14, createdAt: now - 12 * DAY }, now),
      session({ id: 'ses_old2', kind: 'orchestrator', agent: 'lead', status: 'closed', turns: 31, createdAt: now - 8 * DAY }, now),
    );
    transcripts.set('ses_old1', [{ kind: 'user', author: 'user', ts: now - 12 * DAY, text: 'Hello from an earlier session.' }]);
    transcripts.set('ses_old2', [{ kind: 'user', author: 'user', ts: now - 8 * DAY, text: 'Another earlier session.' }]);

    const t3 = now - 7 * MIN;
    const w3: Ev[] = [
      text('Reproducing the loop with an expired session cookie first.\n\n', t3),
      tool('w3a', 'Read', 'src/auth/session.ts', '{"file_path":"src/auth/session.ts"}', t3 + 5_000),
      done('w3a', 'export function refresh() { … }', t3 + 5_400),
      tool('w3b', 'Bash', 'npm test -- auth/redirect.spec.ts', 'npm test -- auth/redirect.spec.ts', t3 + 40_000),
      done('w3b', '1 failing: redirects to /login again after refresh', t3 + 52_000, false),
      tool('w3c', 'Edit', 'src/auth/middleware.ts', '{"file_path":"src/auth/middleware.ts"}', t3 + 4 * MIN),
    ];
    const t4 = now - 22 * MIN;
    const w4: Ev[] = [
      tool('w4a', 'Bash', 'psql -c "select count(*) from settings where theme is null"', 'psql …', t4 + 20_000),
      done('w4a', ' count\n-------\n  3120', t4 + 21_000),
      text('Before I write the migration I need one decision.', t4 + 30_000),
      { kind: 'ask', askId: 'ask_w4', questions: W4_Q, ts: t4 + 31_000 },
    ];
    const t5 = now - 3 * MIN;
    const w5: Ev[] = [
      tool('w5a', 'Read', 'src/webhooks/retry.ts', '{"file_path":"src/webhooks/retry.ts"}', t5),
      done('w5a', 'const DELAY = 30_000', t5 + 800),
      { kind: 'ask', askId: 'ask_w5', questions: W5_Q, ts: t5 + 20_000 },
    ];
    transcripts.set('ses_w3', workerLog(now, 'W-3: Fix the login redirect loop on expired sessions (issue acme/web#128). The first attempt failed on the refresh path.', w3, t3));
    transcripts.set('ses_w4', workerLog(now, 'W-4: Migrate user settings to the new schema.', w4, t4));
    transcripts.set('ses_w5', workerLog(now, 'W-5: Review the payment webhook retries in PR #45.', w5, t5));
    for (const [id, n] of [['ses_w2', 2], ['ses_w15', 15], ['ses_w16', 16], ['ses_w1', 1], ['ses_w14', 14], ['ses_w12', 12]] as const) {
      const it = byNumber.get(n);
      if (!it) continue;
      const t = it.updatedAt - 20 * MIN;
      transcripts.set(id, workerLog(now, `W-${n}: ${it.title}.`, [
        tool(`${id}a`, 'Bash', 'npm test', 'npm test', t + MIN),
        done(`${id}a`, n === 12 ? '2 failing' : 'all tests passed', t + 3 * MIN, n !== 12),
        text(it.result?.summary ?? it.lastError ?? 'Done.', t + 4 * MIN),
        end(30_000, 1_200, 4 * MIN, 0.18, t + 4 * MIN),
      ], t));
    }
    const workerOf: [string, number, 'implementer' | 'reviewer', SessionSummary['status']][] = [
      ['ses_w3', 3, 'implementer', 'running'],
      ['ses_w4', 4, 'implementer', 'running'],
      ['ses_w5', 5, 'reviewer', 'running'],
      ['ses_w17', 17, 'implementer', 'running'],
      ['ses_w2', 2, 'implementer', 'idle'],
      ['ses_w15', 15, 'implementer', 'idle'],
      ['ses_w16', 16, 'implementer', 'idle'],
      ['ses_w1', 1, 'implementer', 'idle'],
      ['ses_w14', 14, 'implementer', 'idle'],
      ['ses_w12', 12, 'implementer', 'idle'],
    ];
    for (const [id, n, agent, status] of workerOf) {
      sessions.push(session({ id, kind: 'worker', agent, itemId: byNumber.get(n)?.id, status, harness: n === 5 ? 'codex' : 'claude-code', cwd: `/workspace/.worktrees/W-${n}` }, now));
    }
    const orchLog = transcripts.get(ORCH) ?? [];
    const orchTurn = orchLog[orchLog.length - 1];
    if (orchTurn?.kind === 'turn') inflight.push({ sessionId: ORCH, turnId: orchTurn.turnId, startedAt: orchTurn.ts, events: orchTurn.events });
    for (const [sessionId, events, started] of [['ses_w3', w3, t3], ['ses_w4', w4, t4], ['ses_w5', w5, t5]] as const) {
      inflight.push({ sessionId, turnId: `trn_${started}`, startedAt: started, events: [...events] });
    }
    asks.push(
      { sessionId: ORCH, turnId: 'trn_05', askId: 'ask_orch', questions: W7_Q, routedTo: 'user' },
      { sessionId: 'ses_w4', turnId: `trn_${t4}`, askId: 'ask_w4', questions: W4_Q, routedTo: 'user' },
      { sessionId: 'ses_w5', turnId: `trn_${t5}`, askId: 'ask_w5', questions: W5_Q, routedTo: 'orchestrator' },
      { sessionId: 'ses_w17', turnId: 'trn_w17', askId: 'ask_w17a', questions: W17_ORCH_Q, routedTo: 'orchestrator' },
      { sessionId: 'ses_w17', turnId: 'trn_w17', askId: 'ask_w17b', questions: W17_USER_Q, routedTo: 'user' },
    );

    pulls.set('itm_02', {
      number: 44,
      url: 'https://github.com/acme/api/pull/44',
      state: 'open',
      draft: false,
      checks: { sha: 'beefcaf', state: 'success', failing: [] },
      feedback: [
        { kind: 'review', author: 'dana', state: 'APPROVED', body: 'Looks good. Nice tests for the headers.', url: 'https://github.com/acme/api/pull/44#r1', at: now - HOUR, trusted: true },
        { kind: 'comment', author: 'drive-by', body: 'Could this also limit by IP?', url: 'https://github.com/acme/api/pull/44#c2', at: now - 30 * MIN, trusted: false },
      ],
      reviewRounds: { used: 1, max: 3 },
    });
    pulls.set('itm_15', {
      number: 47,
      url: 'https://github.com/acme/web/pull/47',
      state: 'open',
      draft: true,
      checks: { sha: 'dec0de9', state: 'failure', failing: [{ name: 'e2e (chromium)', url: 'https://github.com/acme/web/actions/runs/1', summary: 'avatar.spec.ts: expected 200, got 304' }] },
      feedback: [],
      reviewRounds: { used: 0, max: 3 },
    });
    pulls.set('itm_01', { number: 41, url: 'https://github.com/acme/web/pull/41', state: 'merged', draft: false, checks: { sha: 'c0ffee1', state: 'success', failing: [] }, feedback: [], reviewRounds: { used: 1, max: 3 } });
  } else {
    transcripts.set(ORCH, []);
  }

  const snapshot: Snapshot = {
    envId: ENV_ID,
    name: 'acme-launch',
    daemon: { version: '0.1.0', build: '207bdf1c0353', protocol: 2 },
    head: 1000,
    instance: {
      status: scenario === 'provisioning' ? 'provisioning' : 'ready',
      ...(scenario === 'provisioning' ? { stage: 'installing-sdks' as const, detail: 'npm install @anthropic-ai/claude-agent-sdk' } : {}),
      pin: { kind: 'tag', name: 'v1.4.0', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
      sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    },
    github: { state: 'ok', login: 'puck-app' },
    orchestratorSessionId: ORCH,
    sessions,
    items: all,
    order,
    capacity,
    inflight,
    asks,
    decisions: [],
    repos: [
      { github: 'acme/web', dir: 'web' },
      { github: 'acme/api', dir: 'api' },
    ],
  };
  return { instances: instances(scenario), snapshot, transcripts, pulls };
}
