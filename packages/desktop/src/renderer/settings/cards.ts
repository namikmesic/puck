/** Shared kit for the settings card grids (agents / providers / envs). */

import { asButton, el } from '../dom';

export function loadingInto(container: HTMLElement): void {
  container.setAttribute('aria-busy', 'true');
  if (!container.children.length) container.appendChild(el('div', 'cards-loading', 'Loading…'));
}

/** Card shell: head with title (+active badge) and an optional right slot. */
export function cardShell(opts: {
  title: string;
  active?: boolean;
  headRight?: HTMLElement | string;
  clickable?: { label: string; onOpen(): void };
}): HTMLElement {
  const card = el('div', opts.clickable ? 'card clickable' : 'card');
  if (opts.clickable) {
    asButton(card, opts.clickable.label);
    card.addEventListener('click', opts.clickable.onOpen);
  }
  const head = el('div', 'card-head');
  const title = el('span', 'card-title', opts.title);
  if (opts.active) title.appendChild(el('span', 'badge-active', 'active'));
  head.appendChild(title);
  if (typeof opts.headRight === 'string') head.appendChild(el('span', 'card-tag', opts.headRight));
  else if (opts.headRight) head.appendChild(opts.headRight);
  card.appendChild(head);
  return card;
}

/** The dashed "+ New X" creator card every grid ends with. */
export function addCard(label: string, onCreate: () => void | Promise<void>): HTMLElement {
  const add = el('div', 'card add', label);
  asButton(add);
  add.addEventListener('click', () => void onCreate());
  return add;
}
