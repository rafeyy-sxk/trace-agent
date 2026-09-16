/** Small formatters shared by every view. Pure, so they are unit-testable. */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return '—';
  if (count < 10_000) return count.toLocaleString('en-US');
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function formatClock(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—';
  return new Date(epochMs).toLocaleTimeString('en-GB', { hour12: false });
}

/** Relative offset from the run start, which is what a trace reader wants. */
export function formatOffset(epochMs: number, startedAt: number): string {
  const delta = epochMs - startedAt;
  if (!Number.isFinite(delta)) return '—';
  return `+${(delta / 1000).toFixed(2)}s`;
}

export function truncateMiddle(text: string, max = 72): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

export function prettyJson(value: unknown, maxChars = 20_000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [${text.length - maxChars} more characters]` : text;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
