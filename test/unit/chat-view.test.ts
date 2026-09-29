// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities } from '../../src/harness/bridge';
import { initChatView, noticeTone, refRuns, type ChatView, type ChatViewContext, type Session } from '../../src/renderer/chat-view';

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Sub-agent chats the view spawned, the way the session view keeps them. */
function childStore() {
  let nextId = 1;
  const sessions: Session[] = [];
  const freshSession = (): Session => ({
    id: nextId++,
    title: 'Untitled session',
    thread: document.createElement('ol'),
    usage: 0,
    turns: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    running: false,
    turnId: null,
    unread: null,
    tools: new Map(),
    agents: new Map(),
  });
  return {
    sessions,
    freshSession,
    spawnChild(parent: Session): Session {
      const child = freshSession();
      child.parentSessionId = parent.id;
      child.turns = 1;
      child.running = true;
      child.tools = parent.tools;
      sessions.push(child);
      return child;
    },
    dropChildren(parent: Session): void {
      for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].parentSessionId === parent.id) sessions.splice(i, 1);
    },
  };
}

interface Harness {
  view: ChatView;
  store: ReturnType<typeof childStore>;
  ctx: {
    rosterChanged: ReturnType<typeof vi.fn>;
    answerAsk: ReturnType<typeof vi.fn>;
    openSession: ReturnType<typeof vi.fn>;
  };
  session: Session;
}

function makeHarness(capabilities?: ProviderCapabilities): Harness {
  const store = childStore();
  const rosterChanged = vi.fn();
  const answerAsk = vi.fn(async () => undefined);
  const openSession = vi.fn();
  const overlayStage = document.createElement('div');
  const ctx: ChatViewContext = {
    userName: 'You',
    scrollChat: () => undefined,
    answerAsk,
    toast: () => undefined,
    rosterChanged,
    isCurrent: () => false,
    openSession,
    spawnChild: store.spawnChild,
    capabilities: () => capabilities,
    pruneChildren: store.dropChildren,
    overlay: {
      body: document.createElement('div'),
      crumb: document.createElement('span'),
      title: document.createElement('span'),
      stage: overlayStage,
      backButton: document.createElement('button'),
    },
  };
  const view: ChatView = initChatView(ctx);
  const session = store.freshSession();
  session.title = 'Claude';
  return { view, store, ctx: { rosterChanged, answerAsk, openSession }, session };
}

const T0 = new Date('2026-08-18T10:00:00').getTime(); // local midday — no midnight edge

describe('message grouping (Slack rules)', () => {
  it('groups rapid same-author messages under one header', () => {
    const { view, session } = makeHarness();
    view.addUserMessage(session, 'first', 'You', T0);
    view.addUserMessage(session, 'second', 'You', T0 + 60_000);
    expect(session.thread.querySelectorAll('.msg-row')).toHaveLength(1);
    expect(session.thread.querySelectorAll('.row-body')).toHaveLength(2);
  });

  it('breaks the group after a 5-minute gap', () => {
    const { view, session } = makeHarness();
    view.addUserMessage(session, 'first', 'You', T0);
    view.addUserMessage(session, 'later', 'You', T0 + 301_000);
    expect(session.thread.querySelectorAll('.msg-row')).toHaveLength(2);
  });

  it('caps a sliding group at 15 minutes from its start', () => {
    const { view, session } = makeHarness();
    for (let i = 0; i <= 4; i++) {
      view.addUserMessage(session, `m${i}`, 'You', T0 + i * 4 * 60_000); // 4-min slides
    }
    // 0,4,8,12 group (each gap <5m, all within 15m of start); 16m breaks.
    expect(session.thread.querySelectorAll('.msg-row')).toHaveLength(2);
  });

  it('never groups across midnight', () => {
    const { view, session } = makeHarness();
    const beforeMidnight = new Date('2026-08-18T23:59:00').getTime();
    view.addUserMessage(session, 'late', 'You', beforeMidnight);
    view.addUserMessage(session, 'early', 'You', beforeMidnight + 120_000);
    expect(session.thread.querySelectorAll('.msg-row')).toHaveLength(2);
    expect(session.thread.querySelectorAll('.day-divider')).toHaveLength(2);
  });

  it('different authors never group', () => {
    const { view, session } = makeHarness();
    view.addUserMessage(session, 'hi', 'You', T0);
    view.addUserMessage(session, 'reply', 'Claude', T0 + 1000);
    expect(session.thread.querySelectorAll('.msg-row')).toHaveLength(2);
    expect(session.thread.querySelector('.msg-row.agent')).toBeTruthy();
  });
});

describe('streaming turn', () => {
  it('renders appended text as markdown after the frame flush', async () => {
    const { view, session } = makeHarness();
    const turn = view.addAssistantTurn(session, 't1', T0);
    turn.appendText('Hello **world**');
    await nextFrame();
    const prose = session.thread.querySelector('.prose');
    expect(prose?.textContent).toContain('Hello world');
    expect(prose?.querySelector('strong')?.textContent).toBe('world');
  });
});

describe('sub-agent spawn and settle', () => {
  it('spawns a child chat behind the seam and lands the report on end', async () => {
    const { view, store, session, ctx } = makeHarness();
    const turn = view.addAssistantTurn(session, 't1', T0);
    turn.startTool('task-1', 'Agent', 'Review the diff', 'look closely', undefined, true, T0);
    expect(store.sessions).toHaveLength(1);
    const child = store.sessions[0];
    expect(child.title).toBe('Review the diff');
    expect(child.parentSessionId).toBe(session.id);
    expect(session.thread.querySelector('.agent-link')).toBeTruthy();
    expect(ctx.rosterChanged).toHaveBeenCalled();

    turn.endTool('task-1', true, 'All good.', T0 + 5000);
    expect(child.running).toBe(false);
    expect(child.unread).toBe('done'); // isCurrent() is false in this harness
    await nextFrame(); // the landed report streams through the markdown committer
    expect(child.thread.textContent).toContain('All good.');
  });
});

const FULL_TRANSCRIPT: ProviderCapabilities = {
  supportsAsk: true,
  subAgents: true,
  streamsTokens: true,
  reportsCost: true,
  subAgentTranscript: true,
};

describe('sub-agent cards follow the provider capabilities', () => {
  it('notes lifecycle-only children and links to their status', async () => {
    const { view, store, session } = makeHarness({ ...FULL_TRANSCRIPT, subAgentTranscript: false });
    const turn = view.addAssistantTurn(session, 't1', T0);
    turn.startTool('item_0', 'Agent', 'draft a plan', 'draft a plan', undefined, true, T0);

    const child = store.sessions[0];
    expect(child.title).toBe('draft a plan');
    const note = child.thread.querySelector('.thread-note');
    expect(note?.textContent).toContain('Lifecycle only');
    expect(note?.textContent).toContain('final status');
    // The note follows the prompt row (the child's own turn comes after it).
    expect(note?.previousElementSibling?.classList.contains('msg-row')).toBe(true);
    expect(child.thread.querySelectorAll('.msg-row')).toHaveLength(2);
    expect(session.thread.querySelector('.agent-link-open')?.textContent).toBe('Open status →');

    // Lifecycle text streams into the child chat; the terminal wait settles the card.
    turn.appendText('Started as Codex thread `thread-child` (running).\n\n', 'item_0');
    turn.endTool('item_0', true, 'completed', T0 + 5000);
    await nextFrame();
    expect(child.thread.textContent).toContain('thread-child');
    expect(child.running).toBe(false);
    expect(session.thread.querySelector('.agent-link .tool-status')?.classList.contains('ok')).toBe(true);
  });

  it('keeps the plain chat link when the provider streams the child transcript', () => {
    const { view, store, session } = makeHarness(FULL_TRANSCRIPT);
    const turn = view.addAssistantTurn(session, 't1', T0);
    turn.startTool('task-1', 'Agent', 'Review the diff', 'look closely', undefined, true, T0);
    expect(store.sessions[0].thread.querySelector('.thread-note')).toBeNull();
    expect(session.thread.querySelector('.agent-link-open')?.textContent).toBe('Open chat →');
  });

  it('treats an unknown provider as full-transcript (no note)', () => {
    const { view, store, session } = makeHarness();
    const turn = view.addAssistantTurn(session, 't1', T0);
    turn.startTool('task-1', 'Agent', 'Review the diff', 'look closely', undefined, true, T0);
    expect(store.sessions[0].thread.querySelector('.thread-note')).toBeNull();
  });
});

describe('environment additions', () => {
  it('renders notice rows authored by Puck, with the Puck mark, toned by kind', () => {
    const { view, session } = makeHarness();
    view.addNotice(session, [
      { kind: 'item.review', text: 'W-12 is ready for review · +120 −30' },
      { kind: 'item.failed', text: 'W-3 failed: tests' },
    ], T0);
    const row = session.thread.querySelector('.msg-row.notice') as HTMLElement;
    expect(row.querySelector('.row-author')?.textContent).toBe('Puck');
    expect(row.querySelector('.row-avatar.puck')?.textContent).toBe('P');
    const lines = [...row.querySelectorAll('.notice-line')];
    expect(lines.map((l) => l.querySelector('.notice-dot')?.className)).toEqual(['notice-dot tone-ok', 'notice-dot tone-bad']);
    // Without an openRef hook the references stay text.
    expect(row.querySelector('.ref-chip')).toBeNull();
    expect(lines[0]?.textContent).toBe('W-12 is ready for review · +120 −30');
  });

  it('turns W-n references in notices and messages into chips, leaving code alone', () => {
    const openRef = vi.fn();
    const base = makeHarness();
    const ctx: ChatViewContext = {
      userName: 'You',
      scrollChat: () => undefined,
      answerAsk: async () => undefined,
      toast: () => undefined,
      rosterChanged: () => undefined,
      isCurrent: () => false,
      openSession: () => undefined,
      spawnChild: base.store.spawnChild,
      capabilities: () => undefined,
      pruneChildren: base.store.dropChildren,
      openRef,
      describeRef: (ref) => (ref === 'W-7' ? 'W-7 · Paginate the audit log · done' : null),
      overlay: {
        body: document.createElement('div'),
        crumb: document.createElement('span'),
        title: document.createElement('span'),
        stage: document.createElement('div'),
        backButton: document.createElement('button'),
      },
    };
    const view = initChatView(ctx);
    view.addNotice(base.session, [{ kind: 'pr.merged', text: 'W-7 PR #45 merged; W-7 is done' }], T0);
    const links = [...base.session.thread.querySelectorAll<HTMLButtonElement>('.ref-chip')];
    expect(links.map((l) => l.textContent)).toEqual(['W-7', 'W-7']);
    expect(links[0]?.title).toBe('W-7 · Paginate the audit log · done');
    links[0]?.click();
    expect(openRef).toHaveBeenCalledWith('W-7');
    view.addUserMessage(base.session, 'Retry W-3, and compare `W-4` with [W-5](https://example.com)', 'You', T0 + 60_000);
    const row = base.session.thread.lastElementChild as HTMLElement;
    expect([...row.querySelectorAll('.ref-chip')].map((c) => c.textContent)).toEqual(['W-3']);
    expect(row.querySelector('code')?.textContent).toBe('W-4');
  });

  it('shows other authors as agent rows', () => {
    const { view, session } = makeHarness();
    view.addUserMessage(session, 'Please also run lint', 'lead', T0, 'agent');
    const row = session.thread.querySelector('.msg-row') as HTMLElement;
    expect(row.classList.contains('agent')).toBe(true);
    expect(row.querySelector('.row-author')?.textContent).toBe('lead');
  });

  it('splits text into W-n runs', () => {
    expect(refRuns('see W-1 and W-22.')).toEqual([
      { text: 'see ', ref: false },
      { text: 'W-1', ref: true },
      { text: ' and ', ref: false },
      { text: 'W-22', ref: true },
      { text: '.', ref: false },
    ]);
    expect(noticeTone('item.needs-input')).toBe('ask');
    expect(noticeTone('issue.commented')).toBe('info');
  });
});
