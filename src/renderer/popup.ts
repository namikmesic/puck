/**
 * Menus and popovers anchored to a control: the board's card menu, the
 * agent picker, the chat's session details and the environment status.
 *
 * - One popup at a time, placed under its anchor (above it when there is
 *   no room), in document.body so a scrolling column never clips it.
 * - Menus: ↑/↓, Home and End move between items, Enter and Space run
 *   one, Esc closes and returns focus to the anchor, Tab closes. An entry
 *   with `confirm` arms on the first click (its label becomes the confirm
 *   text for three seconds) and runs on the second.
 * - Popovers hold arbitrary content (role dialog) and close on Esc, a
 *   click outside, or `closePopup()`.
 *
 * No DOM lookups; the caller passes the anchor.
 */

import { el } from './dom';
import { button } from './util';

export interface MenuEntry {
  label: string;
  /** Secondary text on the right ("⌘N", "back to Backlog"). */
  hint?: string;
  danger?: boolean;
  /** Arm on the first click with this label; run on the second. */
  confirm?: string;
  /** Starts a new group (a hairline above it). */
  group?: boolean;
  /** For tests and styling: `data-action`. */
  action?: string;
  run(): void | Promise<void>;
}

interface Open {
  box: HTMLElement;
  anchor: HTMLElement | null;
  onClose?: () => void;
  cleanup: () => void;
}

let current: Open | null = null;

/** Close the open menu or popover; true when one was open. */
export function closePopup(focusAnchor = false): boolean {
  const open = current;
  if (!open) return false;
  current = null;
  open.cleanup();
  open.box.remove();
  open.anchor?.setAttribute('aria-expanded', 'false');
  open.onClose?.();
  if (focusAnchor) open.anchor?.focus();
  return true;
}

export function popupOpen(): boolean {
  return current !== null;
}

/** The anchor of the open popup, so a second click on it closes instead of reopening. */
export function popupAnchor(): HTMLElement | null {
  return current?.anchor ?? null;
}

function place(box: HTMLElement, rect: { left: number; right: number; top: number; bottom: number }, align: 'start' | 'end'): void {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  let left = align === 'end' ? rect.right - w : rect.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  let top = rect.bottom + 6;
  if (top + h > vh - 8 && rect.top - h - 6 >= 8) top = rect.top - h - 6;
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(Math.max(8, top))}px`;
}

function mount(box: HTMLElement, anchor: HTMLElement | null, at: { left: number; right: number; top: number; bottom: number } | null, align: 'start' | 'end', onClose?: () => void): void {
  closePopup();
  document.body.appendChild(box);
  const rect = at ?? anchor?.getBoundingClientRect() ?? { left: 0, right: 0, top: 0, bottom: 0 };
  place(box, rect, align);
  anchor?.setAttribute('aria-expanded', 'true');
  const outside = (ev: Event): void => {
    const t = ev.target as Node;
    if (box.contains(t) || anchor?.contains(t)) return;
    closePopup();
  };
  const reflow = (): void => {
    closePopup();
  };
  document.addEventListener('mousedown', outside, true);
  window.addEventListener('resize', reflow);
  current = {
    box,
    anchor,
    onClose,
    cleanup: () => {
      document.removeEventListener('mousedown', outside, true);
      window.removeEventListener('resize', reflow);
    },
  };
}

export interface MenuOptions {
  /** The menu's accessible name ("Actions for W-12"). */
  label: string;
  align?: 'start' | 'end';
  /** Place at this rectangle instead of under the anchor (a drop point). */
  at?: { left: number; right: number; top: number; bottom: number };
  /** A heading line inside the menu ("Assign W-9 to"). */
  title?: string;
  onClose?(): void;
}

export function openMenu(anchor: HTMLElement | null, entries: readonly MenuEntry[], opts: MenuOptions): HTMLElement {
  const box = el('div', 'menu');
  box.setAttribute('role', 'menu');
  box.setAttribute('aria-label', opts.label);
  if (opts.title) box.appendChild(el('div', 'menu-title', opts.title));
  const items: HTMLButtonElement[] = [];
  for (const entry of entries) {
    if (entry.group && items.length) box.appendChild(el('div', 'menu-sep'));
    const b = button(`menu-item${entry.danger ? ' danger' : ''}`);
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    if (entry.action) b.dataset.action = entry.action;
    const label = el('span', 'menu-label', entry.label);
    b.appendChild(label);
    if (entry.hint) b.appendChild(el('span', 'menu-hint', entry.hint));
    let armed: ReturnType<typeof setTimeout> | null = null;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (entry.confirm && !armed) {
        label.textContent = entry.confirm;
        b.classList.add('armed');
        armed = setTimeout(() => {
          armed = null;
          label.textContent = entry.label;
          b.classList.remove('armed');
        }, 3000);
        return;
      }
      if (armed) clearTimeout(armed);
      closePopup(true);
      void entry.run();
    });
    items.push(b);
    box.appendChild(b);
  }
  box.addEventListener('keydown', (ev) => {
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number): void => items[(i + items.length) % items.length]?.focus();
    if (ev.key === 'ArrowDown') go(at + 1);
    else if (ev.key === 'ArrowUp') go(at < 0 ? items.length - 1 : at - 1);
    else if (ev.key === 'Home') go(0);
    else if (ev.key === 'End') go(items.length - 1);
    else if (ev.key === 'Escape') closePopup(true);
    else if (ev.key === 'Tab') {
      closePopup();
      return;
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  mount(box, anchor, opts.at ?? null, opts.align ?? 'end', opts.onClose);
  items[0]?.focus();
  return box;
}

export interface PopoverOptions {
  label: string;
  align?: 'start' | 'end';
  className?: string;
  onClose?(): void;
}

/** A non-modal panel under `anchor`; focus moves into it (its first control, else the panel). */
export function openPopover(anchor: HTMLElement, content: HTMLElement, opts: PopoverOptions): HTMLElement {
  const box = el('div', `popover${opts.className ? ` ${opts.className}` : ''}`);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', opts.label);
  box.tabIndex = -1;
  box.appendChild(content);
  box.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    closePopup(true);
  });
  mount(box, anchor, null, opts.align ?? 'start', opts.onClose);
  const first = box.querySelector<HTMLElement>('input, select, textarea, button');
  (first ?? box).focus();
  return box;
}
