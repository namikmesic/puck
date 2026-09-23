/**
 * The command palette (Cmd+K): jump to an agent by name, or full-text search
 * across conversation histories. Builds its own overlay into document.body;
 * everything app-owned (the roster, conversations, navigation) arrives
 * through `PaletteContext`, which is what makes it jsdom-testable.
 */

import type { AgentInfo, ConversationEntry } from '../harness/bridge';
import { el } from './dom';
import { button } from './util';

export interface PaletteContext {
  agents(): AgentInfo[];
  /** The persisted/pending log for an agent's conversation, if any. */
  logOf(agentId: string): ConversationEntry[] | undefined;
  providerLabel(providerId: string): string;
  openConversation(agentId: string): void;
}

export function initPalette(ctx: PaletteContext) {
  let palette: HTMLElement | null = null;

  function close(): void {
    palette?.remove();
    palette = null;
  }

  const entryText = (entry: ConversationEntry): string =>
    entry.kind === 'user'
      ? entry.text
      : entry.events
          .filter((e) => e.kind === 'text-delta')
          .map((e) => (e.kind === 'text-delta' ? e.text : ''))
          .join(' ');

  function open(): void {
    close();
    palette = el('div', 'palette-overlay');
    const box = el('div', 'palette');
    const input = document.createElement('input');
    input.className = 'palette-input';
    input.placeholder = 'Jump to an agent or search messages…';
    const list = el('div', 'palette-list');
    box.append(input, list);
    palette.appendChild(box);
    palette.addEventListener('click', (e) => {
      if (e.target === palette) close();
    });
    document.body.appendChild(palette);

    // Flattened, lowercased once per palette open (the first time a query
    // needs it) — not on every keystroke.
    let index: { info: AgentInfo; entries: { text: string; lower: string }[] }[] | null = null;
    const getIndex = () =>
      (index ??= ctx.agents().map((info) => ({
        info,
        entries: (ctx.logOf(info.id) ?? []).map((entry) => {
          const text = entryText(entry);
          return { text, lower: text.toLowerCase() };
        }),
      })));

    const refresh = (): void => {
      const q = input.value.trim().toLowerCase();
      list.textContent = '';
      const items: { label: string; sub: string; go: () => void }[] = [];
      for (const info of ctx.agents()) {
        if (!q || info.name.toLowerCase().includes(q)) {
          items.push({
            label: info.name,
            sub: ctx.providerLabel(info.provider),
            go: () => ctx.openConversation(info.id),
          });
        }
      }
      if (q.length >= 2) {
        for (const { info, entries } of getIndex()) {
          for (const { text, lower } of entries) {
            const idx = lower.indexOf(q);
            if (idx === -1) continue;
            const snippet = text
              .slice(Math.max(0, idx - 24), idx + q.length + 40)
              .split(/\s+/)
              .join(' ');
            items.push({
              label: `“…${snippet}…”`,
              sub: `in ${info.name}`,
              go: () => ctx.openConversation(info.id),
            });
            break; // one hit per conversation keeps the list scannable
          }
        }
      }
      for (const item of items.slice(0, 12)) {
        const row = button('palette-item');
        row.append(el('span', 'palette-label', item.label), el('span', 'palette-sub', item.sub));
        row.addEventListener('click', () => {
          close();
          item.go();
        });
        list.appendChild(row);
      }
    };

    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter') (list.firstElementChild as HTMLElement | null)?.click();
      else if (e.key === 'ArrowDown') {
        (list.firstElementChild as HTMLElement | null)?.focus();
        e.preventDefault();
      }
    });
    list.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (e.key === 'ArrowDown') {
        (target.nextElementSibling as HTMLElement | null)?.focus();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        ((target.previousElementSibling as HTMLElement | null) ?? input).focus();
        e.preventDefault();
      } else if (e.key === 'Escape') close();
    });
    refresh();
    input.focus();
  }

  return {
    open,
    close,
    toggle(): void {
      if (palette) close();
      else open();
    },
    isOpen: (): boolean => palette !== null,
  };
}

export type Palette = ReturnType<typeof initPalette>;
