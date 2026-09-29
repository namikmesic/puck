// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { initComposer, type ComposerTarget } from '../../src/renderer/composer';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(target: ComposerTarget) {
  document.body.innerHTML = `<form id="f"><textarea id="i"></textarea><button id="s" type="submit">Send</button><button id="x" type="button" class="hidden">Stop</button></form><p id="h" class="hidden"></p>`;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const els = { form: byId<HTMLFormElement>('f'), input: byId<HTMLTextAreaElement>('i'), send: byId<HTMLButtonElement>('s'), stop: byId<HTMLButtonElement>('x'), hint: byId('h') };
  const drafts = new Map<string, string>();
  const send = vi.fn(async () => ({ queued: target.running }));
  const interrupt = vi.fn(async () => undefined);
  const say = vi.fn();
  const c = initComposer({
    els,
    target: () => target,
    send,
    interrupt,
    draft: (id) => drafts.get(id) ?? '',
    saveDraft: (id, text) => void drafts.set(id, text),
    say,
  });
  c.refresh();
  const enter = () => els.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return { c, els, drafts, send, interrupt, say, enter };
}

const ready = { ready: true, placeholder: 'Message lead', reason: '' };

describe('composer', () => {
  it('sends on Enter and clears the draft', async () => {
    const t = { sessionId: 'ses_a', running: false, gate: ready, who: 'the orchestrator' };
    const { els, send, enter, drafts } = setup(t);
    els.input.value = 'hello';
    els.input.dispatchEvent(new Event('input'));
    expect(drafts.get('ses_a')).toBe('hello');
    enter();
    await flush();
    expect(send).toHaveBeenCalledWith('ses_a', 'hello');
    expect(els.input.value).toBe('');
    expect(drafts.get('ses_a')).toBe('');
  });

  it('queues while a turn runs, shows Stop, and interrupts', async () => {
    const t = { sessionId: 'ses_a', running: true, gate: ready, who: 'the orchestrator' };
    const { c, els, enter, interrupt } = setup(t);
    expect(els.send.disabled).toBe(false);
    expect(els.stop.classList.contains('hidden')).toBe(false);
    els.input.value = 'also this';
    enter();
    await flush();
    expect(els.hint.textContent).toBe('Queued — sends when the orchestrator finishes');
    els.stop.click();
    expect(interrupt).toHaveBeenCalledWith('ses_a');
    t.running = false;
    c.refresh();
    expect(els.hint.textContent).toBe('');
    expect(els.stop.classList.contains('hidden')).toBe(true);
  });

  it('is disabled with the reason while not ready', () => {
    const { els } = setup({ sessionId: 'ses_a', running: false, gate: { ready: false, placeholder: 'Connecting…', reason: 'Connecting…' }, who: 'x' });
    expect(els.input.disabled).toBe(true);
    expect(els.send.disabled).toBe(true);
    expect(els.input.placeholder).toBe('Connecting…');
  });

  it('switches drafts with the target session and restores text on failure', async () => {
    const t = { sessionId: 'ses_a', running: false, gate: ready, who: 'the worker' };
    const { c, els, drafts, send, say, enter } = setup(t);
    els.input.value = 'draft a';
    t.sessionId = 'ses_b';
    drafts.set('ses_b', 'draft b');
    c.refresh();
    expect(drafts.get('ses_a')).toBe('draft a');
    expect(els.input.value).toBe('draft b');
    send.mockRejectedValueOnce(new Error('not-ready'));
    enter();
    await flush();
    expect(els.input.value).toBe('draft b');
    expect(say).toHaveBeenLastCalledWith('not-ready');
  });
});
