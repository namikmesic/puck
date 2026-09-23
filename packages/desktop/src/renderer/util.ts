/** Small shared renderer utilities: canonical JSON, buttons, segmented
 *  radiogroups, error text, and the icon strings used from more than one place. */

import { el } from './dom';

/** Canonical JSON (sorted keys) so equal payloads compare equal in any edit order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Monotonic request token: rapid async re-entries must not land stale content. */
export function latestToken(): { next(): number; isCurrent(token: number): boolean } {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (token) => token === seq,
  };
}

/** A non-submitting button — the composer is a form, so the type matters. */
export function button(className: string, text?: string): HTMLButtonElement {
  const btn = el('button', className, text);
  btn.type = 'button';
  return btn;
}

/** Builds a segmented radiogroup into `host`; exactly one segment is pressed. */
export function buildSeg(
  host: HTMLElement,
  entries: ReadonlyArray<{ value: string; label: string }>,
  selected: string,
  onPick: (value: string) => void,
): HTMLButtonElement[] {
  host.textContent = '';
  const buttons = entries.map(({ value, label }) => {
    const btn = button('seg-btn', label);
    btn.setAttribute('aria-pressed', String(value === selected));
    btn.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === btn));
      onPick(value);
    });
    host.appendChild(btn);
    return btn;
  });
  return buttons;
}

export const SEND_ICON = '<svg viewBox="0 0 24 24"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>';
export const STOP_ICON = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>';
