/**
 * The command palette (⌘K): switch environment, jump to a work item by
 * `W-n` or title, search the orchestrator's conversation, and run
 * commands (New item, Start environment, Settings, and the scheduler's
 * Pause or Resume). Builds its own overlay into document.body; everything
 * app-owned arrives through the context.
 */

import type { InstanceInfo } from '../harness/bridge';
import type { WorkItem } from '../harness/daemon-protocol';
import { el } from './dom';
import { button } from './util';

export interface PaletteCommand {
  label: string;
  hint?: string;
  run(): void;
}

export interface CommandPaletteContext {
  instances(): InstanceInfo[];
  currentEnv(): string | null;
  items(): WorkItem[];
  /** The orchestrator's messages as loaded on screen, oldest first. */
  history(): string[];
  commands(): PaletteCommand[];
  openEnv(envId: string): void;
  openItem(itemId: string): void;
  openHistory(): void;
}

interface Row {
  label: string;
  sub: string;
  go(): void;
}

export function paletteRows(ctx: CommandPaletteContext, query: string): Row[] {
  const q = query.trim().toLowerCase();
  const rows: Row[] = [];
  const num = /^w-?(\d{1,9})$/i.exec(q);
  for (const item of ctx.items()) {
    const hit = num ? item.number === Number(num[1]) : q.length > 0 && (`w-${item.number}`.startsWith(q) || item.title.toLowerCase().includes(q));
    if (hit) rows.push({ label: `W-${item.number} ${item.title}`, sub: item.status, go: () => ctx.openItem(item.id) });
  }
  for (const cmd of ctx.commands()) {
    if (!q || cmd.label.toLowerCase().includes(q)) rows.push({ label: cmd.label, sub: cmd.hint ?? 'command', go: cmd.run });
  }
  for (const info of ctx.instances()) {
    if (info.id === ctx.currentEnv()) continue;
    if (!q || info.name.toLowerCase().includes(q)) rows.push({ label: `Switch to ${info.name}`, sub: info.runnerName, go: () => ctx.openEnv(info.id) });
  }
  if (q.length >= 2) {
    let hits = 0;
    for (const text of [...ctx.history()].reverse()) {
      const lower = text.toLowerCase();
      const at = lower.indexOf(q);
      if (at < 0) continue;
      const snippet = text.slice(Math.max(0, at - 24), at + q.length + 40).split(/\s+/).join(' ');
      rows.push({ label: `“…${snippet}…”`, sub: 'in the orchestrator chat', go: () => ctx.openHistory() });
      if (++hits >= 5) break;
    }
  }
  return rows.slice(0, 14);
}

export function initCommandPalette(ctx: CommandPaletteContext) {
  let overlay: HTMLElement | null = null;

  function close(): boolean {
    if (!overlay) return false;
    overlay.remove();
    overlay = null;
    return true;
  }

  function open(): void {
    close();
    overlay = el('div', 'palette-overlay');
    const box = el('div', 'palette');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Command palette');
    const input = el('input', 'palette-input');
    input.placeholder = 'Jump to W-12, switch environment, search the chat, or run a command…';
    input.setAttribute('aria-label', 'Search');
    const list = el('div', 'palette-list');
    box.append(input, list);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);

    const refresh = (): void => {
      list.textContent = '';
      for (const row of paletteRows(ctx, input.value)) {
        const b = button('palette-item');
        b.append(el('span', 'palette-label', row.label), el('span', 'palette-sub', row.sub));
        b.addEventListener('click', () => {
          close();
          row.go();
        });
        list.appendChild(b);
      }
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter') (list.firstElementChild as HTMLElement | null)?.click();
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
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    refresh();
    input.focus();
  }

  return {
    open,
    close,
    toggle(): void {
      if (overlay) close();
      else open();
    },
    isOpen: (): boolean => overlay !== null,
  };
}

export type CommandPalette = ReturnType<typeof initCommandPalette>;
