// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { AskQuestion } from '../../src/harness/types';
import { askCard, askReplayCard, setAskAnswered } from '../../src/renderer/ask-card';

const single: AskQuestion[] = [
  {
    question: 'Deploy now?',
    header: 'Deploy',
    options: [{ label: 'Yes' }, { label: 'No', description: 'wait for CI' }],
  } as AskQuestion,
];

const multi: AskQuestion[] = [
  { question: 'Which files?', multiSelect: true, options: [{ label: 'a.ts' }, { label: 'b.ts' }] },
  { question: 'Confirm?', options: [{ label: 'OK' }] },
] as AskQuestion[];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const option = (card: HTMLElement, label: string): HTMLButtonElement => {
  const btn = [...card.querySelectorAll<HTMLButtonElement>('.ask-option')].find(
    (b) => b.querySelector('.ask-option-label')?.textContent === label,
  );
  if (!btn) throw new Error(`option ${label} missing`);
  return btn;
};

describe('askCard', () => {
  it('a lone single-select question submits instantly on click', async () => {
    const submit = vi.fn(() => Promise.resolve());
    const card = askCard(single, { submit });
    option(card, 'Yes').click();
    await tick();
    expect(submit).toHaveBeenCalledWith({ 'Deploy now?': 'Yes' });
    expect(card.classList.contains('answered')).toBe(true); // frozen
  });

  it('multi-question cards collect picks and gate the footer button', async () => {
    const submit = vi.fn(() => Promise.resolve());
    const card = askCard(multi, { submit });
    const send = card.querySelector('.btn-primary') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    option(card, 'a.ts').click();
    option(card, 'b.ts').click();
    expect(send.disabled).toBe(true); // second question unanswered
    option(card, 'OK').click();
    expect(send.disabled).toBe(false);
    send.click();
    await tick();
    expect(submit).toHaveBeenCalledWith({ 'Which files?': 'a.ts, b.ts', 'Confirm?': 'OK' });
  });

  it('free text beats option picks and Enter submits when complete', async () => {
    const submit = vi.fn(() => Promise.resolve());
    const card = askCard(multi, { submit });
    option(card, 'OK').click();
    const [filesInput] = [...card.querySelectorAll<HTMLInputElement>('.ask-other')];
    filesInput.value = 'everything';
    filesInput.dispatchEvent(new Event('input'));
    filesInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    expect(submit).toHaveBeenCalledWith({ 'Which files?': 'everything', 'Confirm?': 'OK' });
  });

  it('dismiss submits null', async () => {
    const submit = vi.fn(() => Promise.resolve());
    const card = askCard(single, { submit });
    (card.querySelector('.btn-ghost') as HTMLButtonElement).click();
    await tick();
    expect(submit).toHaveBeenCalledWith(null);
  });

  it('re-arms when delivery rejects, then accepts a retry', async () => {
    const submit = vi
      .fn<(a: Record<string, string> | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValueOnce(undefined);
    const card = askCard(single, { submit });
    option(card, 'Yes').click();
    await tick();
    expect(card.classList.contains('answered')).toBe(false); // re-armed
    option(card, 'Yes').click();
    await tick();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(card.classList.contains('answered')).toBe(true);
  });

  it('ignores double submits', async () => {
    let resolveFirst!: () => void;
    const submit = vi.fn(() => new Promise<void>((resolve) => (resolveFirst = resolve)));
    const card = askCard(multi, { submit });
    option(card, 'a.ts').click();
    option(card, 'OK').click();
    const send = card.querySelector('.btn-primary') as HTMLButtonElement;
    send.click();
    send.click();
    resolveFirst();
    await tick();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('askReplayCard', () => {
  it('marks the chosen options selected and disables everything', () => {
    const card = askReplayCard(single, { 'Deploy now?': 'Yes' });
    expect(card.classList.contains('answered')).toBe(true);
    expect(option(card, 'Yes').classList.contains('selected')).toBe(true);
    expect(option(card, 'Yes').disabled).toBe(true);
    expect(option(card, 'No').classList.contains('selected')).toBe(false);
  });

  it('renders free-text answers that match no option', () => {
    const card = askReplayCard(single, { 'Deploy now?': 'only staging' });
    expect(card.querySelector('.ask-free')?.textContent).toBe('only staging');
  });

  it('labels dismissed questions', () => {
    const card = askReplayCard(single, null);
    expect(card.querySelector('.ask-dismissed')?.textContent).toContain('Dismissed');
  });
});

describe('setAskAnswered', () => {
  it('freezes and re-arms every control', () => {
    const card = askCard(single, { submit: () => Promise.resolve() });
    setAskAnswered(card, true);
    expect([...card.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
    setAskAnswered(card, false);
    expect([...card.querySelectorAll('button')].some((b) => b.disabled)).toBe(false);
  });
});
