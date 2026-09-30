/**
 * Small status glyphs, as inline SVG: one per board column (the ticket's
 * status, in the style of an issue tracker's status icons) and the pull
 * request mark. Colors come from the stylesheet (`currentColor`).
 */

import type { ColumnId } from './board-model';

export const COLUMN_ICON: Record<ColumnId, string> = {
  todo: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke-dasharray="2.4 2.2" /></svg>',
  progress: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path class="fill" d="M8 4a4 4 0 0 1 0 8Z" /></svg>',
  done: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="solid" cx="8" cy="8" r="6.5" /><path class="tick" d="m5.3 8.2 1.8 1.8 3.6-3.8" /></svg>',
};

const PR = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="12.5" r="1.5" /><path d="M4.5 5v6M11.5 11V7.5a2 2 0 0 0-2-2H7.5M9 4 7.5 5.5 9 7" /></svg>';

/** A glyph element for inline use (`pr`). */
export function statusIcon(kind: 'pr'): HTMLElement {
  const span = document.createElement('span');
  span.className = `glyph glyph-${kind}`;
  span.innerHTML = kind === 'pr' ? PR : '';
  return span;
}
