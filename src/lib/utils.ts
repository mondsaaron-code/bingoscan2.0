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

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function tokenizeLoose(value: string): string[] {
  return compactWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9#/\[\]\- ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeTitleFingerprint(value: string): string {
  const stopWords = new Set(['the', 'and', 'with', 'for', 'card', 'sports', 'trading']);
  return tokenizeLoose(value)
    .filter((token) => !stopWords.has(token))
    .slice(0, 18)
    .join(' ');
}

export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const cleaned = input.replace(/[$,]/g, '').trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatDurationSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const totalSeconds = Math.max(0, Math.round(value));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function toTitleLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function scoreListingPriority(args: {
  title: string;
  subtitle?: string | null;
  price: number;
  shipping?: number | null;
  imageUrl?: string | null;
  auctionEndsAt?: string | null;
  condition?: string | null;
  filters: {
    sport?: string;
    playerName?: string;
    brand?: string;
    variant?: string;
    insert?: string;
    cardNumber?: string;
    team?: string;
    rookie?: boolean;
    autographed?: boolean;
    memorabilia?: boolean;
    numberedCard?: boolean;
    conditionMode?: 'raw' | 'graded' | 'any';
    listingMode?: 'buy_now' | 'auction';
    maxPurchasePrice?: number | null;
  };
}): number {
  const text = compactWhitespace(`${args.title} ${args.subtitle ?? ''}`.toLowerCase());
  let score = 18;

  const weightedTerms: Array<[string | null | undefined, number]> = [
    [args.filters.sport, 8],
    [args.filters.playerName, 16],
    [args.filters.brand, 10],
    [args.filters.variant, 8],
    [args.filters.insert, 8],
    [args.filters.team, 6],
  ];

  for (const [term, weight] of weightedTerms) {
    const normalized = compactWhitespace((term ?? '').toLowerCase());
    if (normalized && text.includes(normalized)) score += weight;
  }

  if (args.filters.cardNumber) {
    const normalizedCard = args.filters.cardNumber.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (normalizedCard && new RegExp(`#?${escapeForRegex(normalizedCard)}\\b`, 'i').test(text.replace(/[^a-z0-9#]+/g, ' '))) {
      score += 14;
    }
  }

  if (args.filters.rookie && /\brookie\b|\brc\b/i.test(text)) score += 7;
  if (args.filters.autographed && /\bauto(graph)?\b|signed/i.test(text)) score += 9;
  if (args.filters.memorabilia && /memorabilia|patch|relic|jersey/i.test(text)) score += 9;
  if (args.filters.numberedCard && /\/\d{2,4}\b|numbered/i.test(text)) score += 7;

  if (args.imageUrl) score += 5;

  const total = args.price + (args.shipping ?? 0);
  if (args.filters.maxPurchasePrice && args.filters.maxPurchasePrice > 0) {
    const ratio = total / args.filters.maxPurchasePrice;
    if (ratio <= 0.45) score += 10;
    else if (ratio <= 0.7) score += 7;
    else if (ratio <= 0.9) score += 4;
    else if (ratio > 1.05) score -= 8;
  } else if (total <= 30) {
    score += 4;
  }

  if (args.filters.listingMode === 'auction' && args.auctionEndsAt) {
    const diffHours = (new Date(args.auctionEndsAt).getTime() - Date.now()) / 3_600_000;
    if (Number.isFinite(diffHours) && diffHours > 0) {
      if (diffHours <= 1) score += 8;
      else if (diffHours <= 2) score += 6;
      else if (diffHours <= 4) score += 3;
    }
  }

  const normalizedCondition = (args.condition ?? '').toLowerCase();
  if (args.filters.conditionMode === 'raw' && /psa|bgs|sgc|cgc|graded|slab/i.test(normalizedCondition)) score -= 18;
  if (args.filters.conditionMode === 'graded' && normalizedCondition && !/psa|bgs|sgc|cgc|graded|slab/i.test(normalizedCondition)) score -= 10;

  if (/lot|bundle|team set|mystery|hot pack|break/i.test(text)) score -= 20;
  if (text.split(/\s+/).length < 4) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function scoreDealOpportunity(args: {
  estimatedProfit?: number | null;
  estimatedMarginPct?: number | null;
  aiConfidence?: number | null;
  scpUngradedSell?: number | null;
  scpGrade9?: number | null;
  scpPsa10?: number | null;
  totalPurchasePrice: number;
  needsReview?: boolean;
  auctionEndsAt?: string | null;
}): number {
  let score = 0;
  const profit = args.estimatedProfit ?? null;
  const margin = args.estimatedMarginPct ?? null;
  const confidence = args.aiConfidence ?? null;
  const grade9Upside = args.scpGrade9 !== null && args.scpGrade9 !== undefined ? args.scpGrade9 - args.totalPurchasePrice : null;
  const psa10Upside = args.scpPsa10 !== null && args.scpPsa10 !== undefined ? args.scpPsa10 - args.totalPurchasePrice : null;

  if (profit !== null) {
    if (profit >= 150) score += 28;
    else if (profit >= 75) score += 20;
    else if (profit >= 35) score += 14;
    else if (profit >= 15) score += 8;
    else score += Math.max(-10, profit / 4);
  }

  if (margin !== null) {
    if (margin >= 120) score += 28;
    else if (margin >= 80) score += 20;
    else if (margin >= 50) score += 14;
    else if (margin >= 25) score += 8;
    else score += Math.max(-8, margin / 5);
  }

  if (confidence !== null) score += Math.max(0, Math.min(20, (confidence - 70) * 0.65));
  if (grade9Upside !== null && grade9Upside > 20) score += Math.min(10, grade9Upside / 20);
  if (psa10Upside !== null && psa10Upside > 40) score += Math.min(16, psa10Upside / 25);
  if (args.needsReview) score -= 10;

  if (args.auctionEndsAt) {
    const diffHours = (new Date(args.auctionEndsAt).getTime() - Date.now()) / 3_600_000;
    if (Number.isFinite(diffHours) && diffHours > 0) {
      if (diffHours <= 1) score += 4;
      else if (diffHours <= 3) score += 2;
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
