// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ConversationData } from '../../src/harness/bridge';
import { initChatView, type ChatView, type ChatViewContext } from '../../src/renderer/chat-view';
import { createSessionStore, type Session, type SessionStore } from '../../src/renderer/session-store';
import fixture from '../fixtures/convo-v1.json';

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

interface Harness {
  view: ChatView;
  store: SessionStore;
  ctx: {
    rosterChanged: ReturnType<typeof vi.fn>;
    answerAsk: ReturnType<typeof vi.fn>;
    schedulePersist: ReturnType<typeof vi.fn>;
    openSession: ReturnType<typeof vi.fn>;
  };
  session: Session;
}

function makeHarness(): Harness {
  const store = createSessionStore({
    interrupt: () => undefined,
    save: async () => undefined,
    onSaveError: () => undefined,
    currentDraft: () => '',
  });
  const rosterChanged = vi.fn();
  const answerAsk = vi.fn(async () => undefined);
  const schedulePersist = vi.fn();
  const openSession = vi.fn();
  const overlayStage = document.createElement('div');
  const ctx: ChatViewContext = {
    userName: 'You',
    scrollChat: () => undefined,
    answerAsk,
    toast: () => undefined,
    schedulePersist,
    rosterChanged,
    isCurrent: () => false,
    openSession,
    spawnChild: store.spawnChild,
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
  session.agentId = 'agent-x'; // conversations keep their title
  session.title = 'Claude';
  return { view, store, ctx: { rosterChanged, answerAsk, schedulePersist, openSession }, session };
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

describe('replay of persisted logs', () => {
  it('rebuilds rows, tool cards, and answered asks from the v1 fixture', () => {
    const { view, session } = makeHarness();
    const data = fixture as unknown as ConversationData;
    view.replayLog(session, data.log);

    expect(session.thread.querySelector('.msg-row.user .prose')?.textContent).toContain(
      'Run the tests please',
    );
    const tool = session.thread.querySelector('details.tool');
    expect(tool?.querySelector('.tool-name')?.textContent).toBe('Bash');
    expect(tool?.querySelector('.tool-output')?.textContent).toBe('10 passed');
    const ask = session.thread.querySelector('.ask.answered');
    expect(ask?.querySelector('.ask-question')?.textContent).toBe('Ship it?');
    expect(ask?.querySelector('.ask-option.selected')?.textContent).toContain('Yes');
    // The unknown "mystery-future-event" kind was skipped without throwing,
    // and the turn settled with its stats line.
    expect(session.thread.querySelector('.turn-stats')?.textContent).toContain('1.2k in');
  });

  it('windows long logs behind a "show earlier" affordance', () => {
    const { view, session } = makeHarness();
    const log = Array.from({ length: 160 }, (_, i) => ({
      kind: 'user' as const,
      text: `message ${i}`,
      author: 'user',
      ts: T0 + i * 600_000, // spaced out — no grouping
    }));
    view.replayLog(session, log);
    const loader = session.thread.querySelector('.load-earlier button');
    expect(loader?.textContent).toBe('Show 10 earlier messages');
    expect(session.thread.textContent).not.toContain('message 0');
    (loader as HTMLButtonElement).click();
    expect(session.thread.textContent).toContain('message 0');
    expect(session.thread.querySelector('.load-earlier')).toBeNull();
  });
});
