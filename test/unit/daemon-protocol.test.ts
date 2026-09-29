import { describe, expect, it } from 'vitest';
import {
  OPS,
  PROTOCOL_VERSION,
  RENDERER_OPS,
  daemonCommandFrom,
  isKnownEvent,
  isOp,
  protocolSupported,
} from '../../src/harness/daemon-protocol';
import { VALIDATORS, OpError, dispatch, type Handlers } from '../../src/daemon/ops';

describe('daemon protocol', () => {
  it('declares version 1 and supports N and N-1 only', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(protocolSupported(1)).toBe(true);
    expect(protocolSupported(0)).toBe(false);
    expect(protocolSupported(2)).toBe(false);
    expect(protocolSupported('1')).toBe(false);
  });

  it('the op table is total: every op has a daemon-side validator, and nothing else does', () => {
    expect(Object.keys(VALIDATORS).sort()).toEqual([...OPS].sort());
    expect(OPS).toHaveLength(25);
    for (const op of OPS) expect(isOp(op)).toBe(true);
    expect(isOp('toString')).toBe(false);
    expect(isOp('item.explode')).toBe(false);
  });

  it('the renderer allowlist is exactly the non-privileged ops', () => {
    expect([...RENDERER_OPS].sort()).toEqual(
      [
        'ask.answer',
        'chat.send',
        'item.accept',
        'item.assign',
        'item.cancel',
        'item.create',
        'item.delete',
        'item.move',
        'item.publish',
        'item.retry',
        'item.update',
        'issue.import',
        'logs.tail',
        'scheduler.pause',
        'scheduler.resume',
        'session.history',
        'session.interrupt',
        'snapshot.get',
      ].sort(),
    );
    for (const op of ['credentials.put', 'credentials.get', 'github.put', 'github.nudge', 'secrets.put', 'definition.apply', 'daemon.upgrade', 'nope']) {
      expect(() => daemonCommandFrom(op, {})).toThrow(/not allowed/);
    }
    expect(daemonCommandFrom('chat.send', { text: 'hi' })).toEqual({ op: 'chat.send', args: { text: 'hi' } });
  });

  it('clients skip unknown event kinds instead of failing', () => {
    expect(isKnownEvent({ kind: 'turn.start', sessionId: 's', turnId: 't' })).toBe(true);
    expect(isKnownEvent({ kind: 'something.new', x: 1 })).toBe(false);
    expect(isKnownEvent(null)).toBe(false);
    expect(isKnownEvent({ kind: 'constructor' })).toBe(false);
  });
});

describe('daemon command validation', () => {
  const ses = 'ses_01J0000000000000000000000A';
  const invalid = (op: keyof typeof VALIDATORS, args: unknown) => {
    try {
      VALIDATORS[op](args);
    } catch (err) {
      return (err as OpError).code;
    }
    return 'ok';
  };

  it('accepts well-formed args and rejects malformed ones', () => {
    expect(VALIDATORS['chat.send']({ text: 'hi' })).toEqual({ sessionId: undefined, text: 'hi' });
    expect(invalid('chat.send', { text: '   ' })).toBe('invalid-args');
    expect(invalid('chat.send', { text: 'x'.repeat(100 * 1024 + 1) })).toBe('limit');
    expect(invalid('chat.send', { text: 'hi', sessionId: '../../etc' })).toBe('invalid-args');
    expect(VALIDATORS['session.history']({ sessionId: ses, limit: 200 })).toMatchObject({ limit: 200 });
    expect(invalid('session.history', { sessionId: ses, limit: 201 })).toBe('invalid-args');
    expect(VALIDATORS['ask.answer']({ sessionId: ses, askId: 'ask_01J0000000000000000000000A', answers: null })).toMatchObject({
      answers: null,
    });
    expect(invalid('ask.answer', { sessionId: ses, askId: 'ask_01J0000000000000000000000A', answers: { q: 1 } })).toBe('invalid-args');
    expect(invalid('item.create', { title: '' })).toBe('invalid-args');
    expect(VALIDATORS['item.create']({ title: 'Fix it', position: 'top' })).toMatchObject({ title: 'Fix it', position: 'top' });
    expect(invalid('item.move', { itemId: 'itm_01J0000000000000000000000A', position: 'middle' })).toBe('invalid-args');
    expect(invalid('daemon.upgrade', { mode: 'later' })).toBe('invalid-args');
    expect(VALIDATORS['logs.tail']({})).toEqual({ lines: 200 });
    expect(invalid('logs.tail', { lines: 2001 })).toBe('invalid-args');
    expect(invalid('credentials.put', { harness: [{ id: '../x', content: '{}' }] })).toBe('invalid-args');
    expect(invalid('credentials.put', { harness: [{ id: 'codex', content: 42 }] })).toBe('invalid-args');
    expect(VALIDATORS['credentials.put']({ harness: [{ id: 'codex', content: null }] })).toEqual({ harness: [{ id: 'codex', content: null }] });
    expect(invalid('definition.apply', { definition: {}, pin: { kind: 'tag', name: 'v1', sha: 'nothex' } })).toBe('invalid-args');
    expect(invalid('snapshot.get', 'x')).toBe('invalid-args');
  });

  it('dispatch validates before a handler runs', async () => {
    const seen: unknown[] = [];
    const handlers = Object.fromEntries(OPS.map((op) => [op, (args: unknown) => seen.push(args) && {}])) as unknown as Handlers;
    await expect(dispatch(handlers, 'chat.send', { text: '' })).rejects.toBeInstanceOf(OpError);
    expect(seen).toEqual([]);
    await dispatch(handlers, 'chat.send', { text: 'go' });
    expect(seen).toEqual([{ sessionId: undefined, text: 'go' }]);
  });
});
