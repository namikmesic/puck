/**
 * Shared vocabulary for environment lifecycle presentation: the compact
 * elapsed time the status line and the board both show.
 * Pure: no node, no electron, no DOM.
 */

/** Compact elapsed time: "8s", "1m 05s", "12m 40s", "1h 03m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
