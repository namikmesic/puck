/** Pure formatting helpers shared across the renderer: one clock, one currency, one duration style. */

import { formatElapsed } from '../harness/lifecycle';

/** "8:42 PM" (no leading zero; the locale decides 12- or 24-hour). */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Second-precision clock for tool calls (several often share a minute): "8:42:05 PM". */
export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** "999", "41.2k", "1.3M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(1))}M`;
  return n >= 1000 ? `${parseFloat((n / 1000).toFixed(1))}k` : `${n}`;
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money, always to the cent: "$0.27", "$1,204.50"; a spend under half a cent reads "<$0.01". */
export function fmtUsd(n: number): string {
  if (n > 0 && n < 0.005) return '<$0.01';
  return USD.format(n);
}

/**
 * Durations in the same style as the running clocks: "0.4s" and "4.2s"
 * under ten seconds (tool calls), then "12s", "1m 05s", "1h 03m".
 */
export function fmtDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

export function relTime(ts: number, now = Date.now()): string {
  const delta = now - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The calendar day a timestamp falls on, as a stable key ("2026-9-29"). */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Day-divider label: "Today", "Yesterday", "Friday, September 26" (with the year when it is not this one). */
export function dayLabel(ts: number, now = Date.now()): string {
  if (dayKey(ts) === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Yesterday';
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "1st", "2nd", "3rd", "11th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
