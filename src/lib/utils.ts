export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function toCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

export function toPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return `${value.toFixed(1)}%`;
}

export function formatRelativeTime(dateValue: string | null | undefined): string {
  if (!dateValue) return '—';
  const target = new Date(dateValue).getTime();
  if (!Number.isFinite(target)) return '—';

  const diffMs = target - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const absMinutes = Math.abs(diffMinutes);

  if (absMinutes < 1) return diffMs >= 0 ? 'less than a minute' : 'just ended';
  if (absMinutes < 60) return diffMs >= 0 ? `${absMinutes}m left` : `${absMinutes}m ago`;

  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  if (absMinutes < 24 * 60) {
    return diffMs >= 0 ? `${hours}h ${minutes}m left` : `${hours}h ${minutes}m ago`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return diffMs >= 0 ? `${days}d ${remHours}h left` : `${days}d ${remHours}h ago`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const cleaned = input.replace(/[$,]/g, '').trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}
