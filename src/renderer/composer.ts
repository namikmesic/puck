/**
 * A session composer (the orchestrator chat, and work detail's follow-ups).
 *
 * Enter sends and Shift+Enter breaks the line. While a turn runs, Send
 * stays enabled and the message queues behind it ("Queued — sends when …
 * finishes"), and Stop interrupts. While the environment is not ready the
 * composer is disabled and says why. The draft follows the target session.
 * Context and elements in, controller out.
 */

import type { ComposerGate } from './instance-progress';
import { errText } from './util';

export interface ComposerElements {
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  hint: HTMLElement;
}

export interface ComposerTarget {
  sessionId: string | null;
  running: boolean;
  gate: ComposerGate;
  /** Who a queued message waits for ("the orchestrator", "the worker"). */
  who: string;
}

export interface ComposerContext {
  els: ComposerElements;
  target(): ComposerTarget;
  send(sessionId: string, text: string): Promise<{ queued: boolean }>;
  interrupt(sessionId: string): Promise<void>;
  draft(sessionId: string): string;
  saveDraft(sessionId: string, text: string): void;
  say(text: string): void;
}

export function initComposer(ctx: ComposerContext) {
  const { els } = ctx;
  let shownFor: string | null = null;

  function hint(text: string): void {
    els.hint.textContent = text;
    els.hint.classList.toggle('hidden', !text);
  }

  function refresh(): void {
    const t = ctx.target();
    if (t.sessionId !== shownFor) {
      if (shownFor) ctx.saveDraft(shownFor, els.input.value);
      shownFor = t.sessionId;
      els.input.value = t.sessionId ? ctx.draft(t.sessionId) : '';
      hint('');
    }
    const open = t.gate.ready && !!t.sessionId;
    els.input.disabled = !open;
    els.input.placeholder = t.gate.placeholder;
    els.send.disabled = !open;
    els.send.title = open ? (t.running ? 'Queue this message' : 'Send') : t.gate.reason;
    els.stop.classList.toggle('hidden', !(open && t.running));
    if (!t.running && els.hint.textContent?.startsWith('Queued')) hint('');
  }

  async function submit(): Promise<void> {
    const t = ctx.target();
    const text = els.input.value.trim();
    if (!text || !t.sessionId) return;
    if (!t.gate.ready) {
      ctx.say(t.gate.reason);
      return;
    }
    const sessionId = t.sessionId;
    els.input.value = '';
    ctx.saveDraft(sessionId, '');
    ctx.say('');
    try {
      const res = await ctx.send(sessionId, text);
      if (res.queued && ctx.target().sessionId === sessionId) hint(`Queued — sends when ${t.who} finishes`);
    } catch (err) {
      if (ctx.target().sessionId === sessionId && !els.input.value) els.input.value = text;
      ctx.saveDraft(sessionId, text);
      ctx.say(errText(err));
    }
  }

  els.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submit();
  });
  els.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void submit();
    }
  });
  els.input.addEventListener('input', () => {
    if (shownFor) ctx.saveDraft(shownFor, els.input.value);
  });
  els.stop.addEventListener('click', () => {
    const t = ctx.target();
    if (!t.sessionId) return;
    void ctx.interrupt(t.sessionId).catch((err: unknown) => ctx.say(errText(err)));
  });

  return {
    refresh,
    focus(): void {
      if (!els.input.disabled) els.input.focus();
    },
  };
}

export type Composer = ReturnType<typeof initComposer>;
