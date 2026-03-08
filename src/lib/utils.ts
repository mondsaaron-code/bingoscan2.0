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

export type ProviderFailure = {
  provider: 'ebay' | 'scp' | 'openai' | 'ximilar';
  category: 'rate_limit' | 'timeout' | 'upstream' | 'network' | 'auth' | 'config' | 'validation' | 'unknown';
  status: number | null;
  recoverable: boolean;
  message: string;
  raw: string;
};

export function classifyProviderFailure(
  provider: ProviderFailure['provider'],
  error: unknown,
): ProviderFailure {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const statusMatch = raw.match(/\((\d{3})\)/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const lower = raw.toLowerCase();

  let category: ProviderFailure['category'] = 'unknown';
  let recoverable = false;

  if (/429|rate limit|too many requests/.test(lower) || status === 429) {
    category = 'rate_limit';
    recoverable = true;
  } else if (/timeout|timed out|etimedout|aborted/.test(lower) || status === 408 || status === 504) {
    category = 'timeout';
    recoverable = true;
  } else if (/network|fetch failed|econnreset|enotfound|eai_again|socket hang up/.test(lower)) {
    category = 'network';
    recoverable = true;
  } else if (status !== null && [500, 502, 503, 504].includes(status)) {
    category = 'upstream';
    recoverable = true;
  } else if (/401|403|unauthorized|forbidden|invalid api key|missing required environment variable/.test(lower) || status === 401 || status === 403) {
    category = /missing required environment variable/.test(lower) ? 'config' : 'auth';
    recoverable = false;
  } else if (/400|404|422|invalid|schema|zod/.test(lower) || status === 400 || status === 404 || status === 422) {
    category = 'validation';
    recoverable = false;
  }

  return {
    provider,
    category,
    status,
    recoverable,
    message: compactWhitespace(raw.replace(/\s+/g, ' ')).slice(0, 500),
    raw,
  };
}

export function formatProviderFailure(failure: ProviderFailure): string {
  const statusPart = failure.status ? ` (${failure.status})` : '';
  const categoryLabel = failure.category.replace(/_/g, ' ');
  return `${failure.provider.toUpperCase()} ${categoryLabel}${statusPart}: ${failure.message}`;
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


export function scoreSellerListingQuality(args: {
  sellerFeedbackPercentage?: number | null;
  sellerFeedbackScore?: number | null;
  imageCount?: number | null;
  description?: string | null;
  aspectMap?: Record<string, string[]> | null;
  condition?: string | null;
}): { score: number; summary: string; signals: string[] } {
  let score = 50;
  const signals: string[] = [];

  const feedbackPct = args.sellerFeedbackPercentage ?? null;
  if (feedbackPct !== null) {
    if (feedbackPct >= 99.8) score += 18;
    else if (feedbackPct >= 99.3) score += 14;
    else if (feedbackPct >= 98.8) score += 10;
    else if (feedbackPct >= 98) score += 4;
    else if (feedbackPct < 97) score -= 18;
    else if (feedbackPct < 98) score -= 10;
    signals.push(`seller ${feedbackPct.toFixed(1)}%`);
  } else {
    score -= 4;
  }

  const feedbackScore = args.sellerFeedbackScore ?? null;
  if (feedbackScore !== null) {
    if (feedbackScore >= 5000) score += 12;
    else if (feedbackScore >= 1000) score += 8;
    else if (feedbackScore >= 250) score += 4;
    else if (feedbackScore < 25) score -= 8;
    else if (feedbackScore < 100) score -= 4;
    signals.push(`${Math.round(feedbackScore)} fb`);
  }

  const imageCount = Math.max(0, Math.round(args.imageCount ?? 0));
  if (imageCount >= 5) score += 10;
  else if (imageCount >= 3) score += 6;
  else if (imageCount >= 2) score += 2;
  else if (imageCount === 1) score -= 4;
  else score -= 12;
  if (imageCount > 0) signals.push(`${imageCount} photo${imageCount === 1 ? '' : 's'}`);

  const aspectCount = Object.values(args.aspectMap ?? {}).reduce((sum, values) => sum + values.length, 0);
  if (aspectCount >= 8) score += 10;
  else if (aspectCount >= 5) score += 6;
  else if (aspectCount >= 3) score += 2;
  else if (aspectCount === 0) score -= 6;
  if (aspectCount > 0) signals.push(`${aspectCount} specifics`);

  const descriptionLength = compactWhitespace(args.description ?? '').length;
  if (descriptionLength >= 350) score += 6;
  else if (descriptionLength >= 120) score += 3;
  else if (descriptionLength === 0) score -= 6;
  if (descriptionLength >= 40) signals.push('has description');

  const condition = (args.condition ?? '').toLowerCase();
  if (/near mint|excellent|ungraded|raw|psa|bgs|sgc|cgc|graded/.test(condition)) {
    score += 2;
  }

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: normalizedScore,
    summary: `Listing ${normalizedScore}/100${signals.length ? ` • ${signals.join(' • ')}` : ''}`,
    signals,
  };
}

export function determineGradingLane(args: {
  totalPurchasePrice: number;
  scpUngradedSell?: number | null;
  scpGrade9?: number | null;
  scpPsa10?: number | null;
}): { label: string; detail: string } {
  const rawProfit = args.scpUngradedSell !== null && args.scpUngradedSell !== undefined ? args.scpUngradedSell - args.totalPurchasePrice : null;
  const grade9Upside = args.scpGrade9 !== null && args.scpGrade9 !== undefined ? args.scpGrade9 - args.totalPurchasePrice : null;
  const psa10Upside = args.scpPsa10 !== null && args.scpPsa10 !== undefined ? args.scpPsa10 - args.totalPurchasePrice : null;

  if ((psa10Upside ?? -9999) >= 150 && (grade9Upside ?? -9999) >= 35) {
    return { label: 'Strong grading lane', detail: `PSA 10 upside ${toCurrency(psa10Upside)} with PSA 9 floor ${toCurrency(grade9Upside)}` };
  }
  if ((psa10Upside ?? -9999) >= 90) {
    return { label: 'PSA 10 swing', detail: `PSA 10 upside ${toCurrency(psa10Upside)}` };
  }
  if ((grade9Upside ?? -9999) >= 35) {
    return { label: 'PSA 9 live', detail: `PSA 9 upside ${toCurrency(grade9Upside)}` };
  }
  if ((rawProfit ?? -9999) >= 25) {
    return { label: 'Raw flip', detail: `Ungraded spread ${toCurrency(rawProfit)}` };
  }
  if ((rawProfit ?? -9999) > 0 || (psa10Upside ?? -9999) > 25) {
    return { label: 'Speculative', detail: 'Needs cleaner grade edge' };
  }
  return { label: 'Low grading edge', detail: 'Little grading upside today' };
}

export function shouldRejectLowTrustListing(args: {
  score: number;
  sellerFeedbackPercentage?: number | null;
  sellerFeedbackScore?: number | null;
  imageCount?: number | null;
  aspectCount?: number | null;
  description?: string | null;
  title: string;
  subtitle?: string | null;
  filters?: {
    playerName?: string;
    cardNumber?: string;
    autographed?: boolean;
    memorabilia?: boolean;
  };
}): string | null {
  const imageCount = Math.max(0, Math.round(args.imageCount ?? 0));
  const aspectCount = Math.max(0, Math.round(args.aspectCount ?? 0));
  const descriptionLength = compactWhitespace(args.description ?? '').length;
  const sellerPct = args.sellerFeedbackPercentage ?? null;
  const sellerScore = args.sellerFeedbackScore ?? null;
  const text = compactWhitespace(`${args.title} ${args.subtitle ?? ''}`.toLowerCase());
  const ambiguousTitle = text.split(/\s+/).length < 7 || !/\b(19|20)\d{2}\b/.test(text);
  const playerRequested = compactWhitespace((args.filters?.playerName ?? '').toLowerCase());
  const playerMissing = Boolean(playerRequested) && !text.includes(playerRequested);
  const cardRequested = compactWhitespace((args.filters?.cardNumber ?? '').toLowerCase()).replace(/[^a-z0-9]+/g, '');
  const cardMissing = Boolean(cardRequested) && !text.replace(/[^a-z0-9#]+/g, '').includes(cardRequested);
  const premiumFlags = Boolean(args.filters?.autographed || args.filters?.memorabilia);

  if (args.score <= 18) {
    return 'Low-trust listing: seller and listing quality are too weak';
  }
  if ((sellerPct !== null && sellerPct < 96.5) && (sellerScore !== null && sellerScore < 50) && args.score < 35) {
    return `Low-trust seller: ${sellerPct.toFixed(1)}% feedback with limited history`;
  }
  if (imageCount <= 1 && aspectCount <= 1 && descriptionLength < 40 && args.score < 42) {
    return 'Low-trust listing: too little evidence (photos/specifics/description)';
  }
  if ((playerMissing || cardMissing || ambiguousTitle || premiumFlags) && imageCount <= 1 && aspectCount <= 2 && args.score < 48) {
    return 'Low-trust listing: not enough evidence for this card type';
  }
  return null;
}

export function shouldSkipWeakTail(args: {
  currentResults: number;
  dealsFound: number;
  listingPriorityScore: number;
}): string | null {
  if (args.currentResults >= 9 && args.dealsFound >= 6 && args.listingPriorityScore < 52) {
    return 'Skipped weak-tail candidate because the scan already has a strong queue';
  }
  if (args.currentResults >= 8 && args.dealsFound >= 5 && args.listingPriorityScore < 42) {
    return 'Skipped weak-tail candidate because the scan already has enough stronger listings queued';
  }
  return null;
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
  const gradingLane = determineGradingLane({
    totalPurchasePrice: args.totalPurchasePrice,
    scpUngradedSell: args.scpUngradedSell,
    scpGrade9: args.scpGrade9,
    scpPsa10: args.scpPsa10,
  });

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
  if (gradingLane.label === 'Strong grading lane') score += 8;
  else if (gradingLane.label === 'PSA 10 swing') score += 5;
  else if (gradingLane.label === 'PSA 9 live') score += 3;
  else if (gradingLane.label === 'Low grading edge') score -= 4;
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


type DealDiversityKeys = {
  exactFamily: string;
  cluster: string;
};

const DIVERSITY_STOP_WORDS = new Set([
  'the', 'and', 'with', 'for', 'card', 'cards', 'trading', 'sports',
  'raw', 'graded', 'slab', 'slabbed', 'mint', 'gem', 'psa', 'bgs', 'sgc', 'cgc', 'authentic',
  'silver', 'green', 'blue', 'red', 'purple', 'orange', 'gold', 'pink', 'black', 'white', 'bronze', 'sepia', 'negative',
  'refractor', 'wave', 'mojo', 'disco', 'shimmer', 'sparkle', 'pulsar', 'laser', 'ice', 'cracked', 'reactive', 'fluorescent',
  'checkerboard', 'snake', 'snakeskin', 'zebra', 'tiger', 'peacock', 'nebula', 'parallel',
  'listing', 'seller', 'ebay', 'look', 'minty', 'clean', 'nice', 'great', 'rare', 'ssp', 'sp', 'casehit', 'case', 'hit',
]);

export function buildDealDiversityKeys(args: { ebayTitle: string; scpProductName?: string | null }): DealDiversityKeys {
  const source = compactWhitespace(`${args.scpProductName ?? ''} ${args.ebayTitle}`);
  const tokens = tokenizeLoose(source)
    .map((token) => token.replace(/[\[\]]/g, ''))
    .filter(Boolean);

  const year = tokens.find((token) => /^(19|20)\d{2}$/.test(token)) ?? '';
  const filtered = tokens.filter((token) => {
    if (DIVERSITY_STOP_WORDS.has(token)) return false;
    if (/^(psa|bgs|sgc|cgc)\d{0,2}$/i.test(token)) return false;
    if (/^\/?\d{2,4}$/.test(token) && !/^(19|20)\d{2}$/.test(token) && !token.startsWith('#')) return false;
    if (token.length <= 1) return false;
    return true;
  });

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of filtered) {
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }

  const cardNumber = unique.find((token) => token.startsWith('#')) ?? '';
  const core = unique.filter((token) => token !== year && token !== cardNumber);
  const exact = compactWhitespace([year, ...core.slice(0, 8), cardNumber].filter(Boolean).join(' '));
  const clusterCore = core.filter((token) => !token.startsWith('#') && !/\d/.test(token));
  const cluster = compactWhitespace([year, ...clusterCore.slice(0, 5)].filter(Boolean).join(' '));
  const fallback = normalizeTitleFingerprint(args.scpProductName || args.ebayTitle);

  return {
    exactFamily: exact || fallback,
    cluster: cluster || exact || fallback,
  };
}

export function summarizeDealReasons(args: {
  estimatedProfit?: number | null;
  estimatedMarginPct?: number | null;
  aiConfidence?: number | null;
  scpUngradedSell?: number | null;
  scpGrade9?: number | null;
  scpPsa10?: number | null;
  totalPurchasePrice: number;
  auctionEndsAt?: string | null;
  needsReview?: boolean;
}): string {
  const parts: string[] = [];
  const profit = args.estimatedProfit ?? null;
  const margin = args.estimatedMarginPct ?? null;
  const confidence = args.aiConfidence ?? null;
  const grade9Upside = args.scpGrade9 !== null && args.scpGrade9 !== undefined ? args.scpGrade9 - args.totalPurchasePrice : null;
  const psa10Upside = args.scpPsa10 !== null && args.scpPsa10 !== undefined ? args.scpPsa10 - args.totalPurchasePrice : null;
  const gradingLane = determineGradingLane({
    totalPurchasePrice: args.totalPurchasePrice,
    scpUngradedSell: args.scpUngradedSell,
    scpGrade9: args.scpGrade9,
    scpPsa10: args.scpPsa10,
  });

  if (profit !== null) {
    parts.push(`${profit >= 0 ? 'Spread' : 'Gap'} ${toCurrency(profit)}`);
  }
  if (margin !== null) {
    parts.push(`Margin ${toPct(margin)}`);
  }
  if (confidence !== null) {
    parts.push(`AI ${Math.round(confidence)}%`);
  }
  if (grade9Upside !== null && grade9Upside > 0) {
    parts.push(`PSA 9 upside ${toCurrency(grade9Upside)}`);
  }
  if (psa10Upside !== null && psa10Upside > 0) {
    parts.push(`PSA 10 upside ${toCurrency(psa10Upside)}`);
  }
  if (gradingLane.label !== 'Low grading edge') {
    parts.push(`${gradingLane.label}`);
  }
  if (args.auctionEndsAt) {
    const relative = formatRelativeTime(args.auctionEndsAt);
    if (relative !== '—') {
      parts.push(`Auction ${relative}`);
    }
  }
  if (args.needsReview) {
    parts.push('Manual review needed');
  }
  return parts.join(' • ');
}


const TITLE_MEMORY_STOP_WORDS = new Set([
  'the', 'and', 'with', 'for', 'card', 'cards', 'trading', 'sports', 'ebay', 'seller', 'look', 'nice', 'great', 'rare',
  'rookie', 'rc', 'auto', 'autograph', 'signed', 'patch', 'relic', 'jersey', 'raw', 'graded', 'psa', 'bgs', 'sgc', 'cgc',
]);

export type TitleOutcomeMemoryRow = {
  ebayTitle: string;
  disposition: 'purchased' | 'suppress_90_days' | 'bad_logic';
};

export type TitleOutcomeMemory = {
  exact: Map<string, number>;
  tokenWeights: Map<string, number>;
};

export type FamilyOutcomeMemoryRow = {
  ebayTitle: string;
  scpProductName?: string | null;
  disposition: 'purchased' | 'suppress_90_days' | 'bad_logic';
};

export type FamilyOutcomeMemory = {
  exact: Map<string, number>;
  cluster: Map<string, number>;
};

export type ReviewResolutionMemoryRow = {
  ebayTitle: string;
  selectedProductId: string;
  selectedProductName: string;
  optionProductId: string;
  optionProductName: string;
  chosen: boolean;
};

export type ReviewResolutionMemory = {
  globalProduct: Map<string, number>;
  familyProduct: Map<string, Map<string, number>>;
  familyToken: Map<string, Map<string, number>>;
};

export type AuctionOutcomeMemoryRow = {
  ebayTitle: string;
  scpProductName?: string | null;
  auctionEndsAt?: string | null;
  totalPurchasePrice: number;
  disposition: 'purchased' | 'suppress_90_days' | 'bad_logic';
};

export type AuctionOutcomeMemory = {
  globalBand: Map<string, number>;
  familyBand: Map<string, Map<string, number>>;
};

export type PriceBandOutcomeMemoryRow = {
  ebayTitle: string;
  scpProductName?: string | null;
  totalPurchasePrice: number;
  estimatedProfit?: number | null;
  estimatedMarginPct?: number | null;
  disposition: 'purchased' | 'suppress_90_days' | 'bad_logic';
};

export type PriceBandOutcomeMemory = {
  globalBand: Map<string, number>;
  familyBand: Map<string, Map<string, number>>;
};

export type SellerOutcomeSummary = {
  sellerUsername: string;
  total: number;
  purchased: number;
  suppress: number;
  badLogic: number;
  score: number;
  label: string;
  detail: string;
};

export function normalizeSellerUsername(value: string | null | undefined): string | null {
  const cleaned = compactWhitespace(value ?? '').toLowerCase();
  return cleaned || null;
}

export function buildTitleOutcomeMemory(rows: TitleOutcomeMemoryRow[]): TitleOutcomeMemory {
  const exact = new Map<string, number>();
  const tokenWeights = new Map<string, number>();

  for (const row of rows) {
    const fingerprint = normalizeTitleFingerprint(row.ebayTitle);
    if (!fingerprint) continue;

    const exactWeight = row.disposition === 'purchased' ? 7 : row.disposition === 'bad_logic' ? -10 : -4;
    exact.set(fingerprint, (exact.get(fingerprint) ?? 0) + exactWeight);

    const tokenWeight = row.disposition === 'purchased' ? 1.6 : row.disposition === 'bad_logic' ? -2.4 : -0.8;
    const tokens = new Set(
      tokenizeLoose(row.ebayTitle)
        .map((token) => token.replace(/[\[\]]/g, ''))
        .filter((token) => token.length > 2)
        .filter((token) => !TITLE_MEMORY_STOP_WORDS.has(token))
    );

    for (const token of tokens) {
      if (/^(19|20)\d{2}$/.test(token)) continue;
      tokenWeights.set(token, (tokenWeights.get(token) ?? 0) + tokenWeight);
    }
  }

  return { exact, tokenWeights };
}

export function scoreListingAgainstTitleMemory(title: string, memory: TitleOutcomeMemory | null | undefined): { score: number; reason: string | null } {
  if (!memory) return { score: 0, reason: null };
  const fingerprint = normalizeTitleFingerprint(title);
  if (!fingerprint) return { score: 0, reason: null };

  const exactScore = memory.exact.get(fingerprint) ?? 0;
  const tokens = new Set(
    tokenizeLoose(title)
      .map((token) => token.replace(/[\[\]]/g, ''))
      .filter((token) => token.length > 2)
      .filter((token) => !TITLE_MEMORY_STOP_WORDS.has(token))
  );
  let tokenScore = 0;
  for (const token of tokens) {
    tokenScore += memory.tokenWeights.get(token) ?? 0;
  }

  const total = exactScore + Math.max(-8, Math.min(8, tokenScore));
  if (total <= -10) return { score: Math.round(total), reason: 'historical bad-logic pattern penalty' };
  if (total <= -5) return { score: Math.round(total), reason: 'weak historical title pattern' };
  if (total >= 8) return { score: Math.round(total), reason: 'historical good title pattern boost' };
  if (total >= 4) return { score: Math.round(total), reason: 'historically decent title pattern' };
  return { score: Math.round(total), reason: null };
}

export function buildFamilyOutcomeMemory(rows: FamilyOutcomeMemoryRow[]): FamilyOutcomeMemory {
  const exact = new Map<string, number>();
  const cluster = new Map<string, number>();

  for (const row of rows) {
    const keys = buildDealDiversityKeys({
      ebayTitle: row.ebayTitle,
      scpProductName: row.scpProductName ?? null,
    });
    if (!keys.exactFamily && !keys.cluster) continue;

    const exactWeight = row.disposition === 'purchased' ? 5 : row.disposition === 'bad_logic' ? -8 : -3;
    const clusterWeight = row.disposition === 'purchased' ? 2 : row.disposition === 'bad_logic' ? -3 : -1;

    if (keys.exactFamily) exact.set(keys.exactFamily, (exact.get(keys.exactFamily) ?? 0) + exactWeight);
    if (keys.cluster) cluster.set(keys.cluster, (cluster.get(keys.cluster) ?? 0) + clusterWeight);
  }

  return { exact, cluster };
}

export function scoreListingAgainstFamilyMemory(
  args: { ebayTitle: string; scpProductName?: string | null },
  memory: FamilyOutcomeMemory | null | undefined,
): { score: number; reason: string | null; exactFamily: string | null; cluster: string | null } {
  const keys = buildDealDiversityKeys(args);
  if (!memory) {
    return { score: 0, reason: null, exactFamily: keys.exactFamily || null, cluster: keys.cluster || null };
  }

  const exactScore = keys.exactFamily ? (memory.exact.get(keys.exactFamily) ?? 0) : 0;
  const clusterScore = keys.cluster ? (memory.cluster.get(keys.cluster) ?? 0) : 0;
  const total = Math.max(-14, Math.min(14, exactScore + clusterScore));

  if (total <= -10) {
    return { score: Math.round(total), reason: 'historically noisy set/parallel family', exactFamily: keys.exactFamily || null, cluster: keys.cluster || null };
  }
  if (total <= -5) {
    return { score: Math.round(total), reason: 'mixed set/parallel family history', exactFamily: keys.exactFamily || null, cluster: keys.cluster || null };
  }
  if (total >= 8) {
    return { score: Math.round(total), reason: 'historically productive set/parallel family', exactFamily: keys.exactFamily || null, cluster: keys.cluster || null };
  }
  if (total >= 4) {
    return { score: Math.round(total), reason: 'decent set/parallel family history', exactFamily: keys.exactFamily || null, cluster: keys.cluster || null };
  }
  return { score: Math.round(total), reason: null, exactFamily: keys.exactFamily || null, cluster: keys.cluster || null };
}

export function buildReviewResolutionMemory(rows: ReviewResolutionMemoryRow[]): ReviewResolutionMemory {
  const globalProduct = new Map<string, number>();
  const familyProduct = new Map<string, Map<string, number>>();
  const familyToken = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const keys = buildDealDiversityKeys({
      ebayTitle: row.ebayTitle,
      scpProductName: row.selectedProductName ?? row.optionProductName,
    });
    const familyKey = keys.cluster || keys.exactFamily || normalizeTitleFingerprint(row.ebayTitle);
    if (!familyKey) continue;

    const productWeight = row.chosen ? 7 : -5;
    const tokenWeight = row.chosen ? 1.6 : -1.3;

    globalProduct.set(row.optionProductId, (globalProduct.get(row.optionProductId) ?? 0) + (row.chosen ? 3 : -2));

    if (!familyProduct.has(familyKey)) familyProduct.set(familyKey, new Map());
    const familyProducts = familyProduct.get(familyKey)!;
    familyProducts.set(row.optionProductId, (familyProducts.get(row.optionProductId) ?? 0) + productWeight);

    const diffTokens = new Set(
      tokenizeLoose(row.optionProductName)
        .map((token) => token.replace(/[\[\]]/g, ''))
        .filter((token) => token.length > 2)
        .filter((token) => !TITLE_MEMORY_STOP_WORDS.has(token))
    );

    if (!familyToken.has(familyKey)) familyToken.set(familyKey, new Map());
    const tokenMap = familyToken.get(familyKey)!;
    for (const token of diffTokens) {
      tokenMap.set(token, (tokenMap.get(token) ?? 0) + tokenWeight);
    }
  }

  return { globalProduct, familyProduct, familyToken };
}

export function scoreScpCandidateAgainstReviewMemory(
  args: { ebayTitle: string; candidateProductId: string; candidateProductName: string },
  memory: ReviewResolutionMemory | null | undefined,
): { score: number; reason: string | null; familyKey: string | null } {
  const familyKey = buildDealDiversityKeys({
    ebayTitle: args.ebayTitle,
    scpProductName: args.candidateProductName,
  }).cluster || normalizeTitleFingerprint(args.ebayTitle);

  if (!memory || !familyKey) {
    return { score: 0, reason: null, familyKey: familyKey || null };
  }

  const familyProductScore = memory.familyProduct.get(familyKey)?.get(args.candidateProductId) ?? 0;
  const globalProductScore = memory.globalProduct.get(args.candidateProductId) ?? 0;

  let tokenScore = 0;
  const tokenMap = memory.familyToken.get(familyKey);
  if (tokenMap) {
    for (const token of new Set(tokenizeLoose(args.candidateProductName).map((value) => value.replace(/[\[\]]/g, '')).filter((value) => value.length > 2))) {
      tokenScore += tokenMap.get(token) ?? 0;
    }
  }

  const total = Math.max(-16, Math.min(16, familyProductScore + globalProductScore + Math.max(-5, Math.min(5, tokenScore))));
  if (total <= -10) {
    return { score: Math.round(total), reason: 'historically rejected lookalike SCP option', familyKey };
  }
  if (total <= -5) {
    return { score: Math.round(total), reason: 'weak manual-review history for this SCP option family', familyKey };
  }
  if (total >= 10) {
    return { score: Math.round(total), reason: 'historically selected SCP option family', familyKey };
  }
  if (total >= 5) {
    return { score: Math.round(total), reason: 'positive manual-review signal for this SCP option family', familyKey };
  }
  return { score: Math.round(total), reason: null, familyKey };
}

function getAuctionUrgencyBand(auctionEndsAt: string | null | undefined): string {
  if (!auctionEndsAt) return 'buy_now';
  const diffHours = (new Date(auctionEndsAt).getTime() - Date.now()) / 3_600_000;
  if (!Number.isFinite(diffHours) || diffHours <= 0) return 'auction_end';
  if (diffHours <= 1) return 'auction_1h';
  if (diffHours <= 2) return 'auction_2h';
  if (diffHours <= 4) return 'auction_4h';
  if (diffHours <= 6) return 'auction_6h';
  return 'auction_later';
}

function getPriceBand(totalPurchasePrice: number): string {
  if (totalPurchasePrice < 10) return 'under_10';
  if (totalPurchasePrice < 25) return '10_25';
  if (totalPurchasePrice < 50) return '25_50';
  if (totalPurchasePrice < 100) return '50_100';
  return '100_plus';
}

export function buildAuctionOutcomeMemory(rows: AuctionOutcomeMemoryRow[]): AuctionOutcomeMemory {
  const globalBand = new Map<string, number>();
  const familyBand = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const keys = buildDealDiversityKeys({ ebayTitle: row.ebayTitle, scpProductName: row.scpProductName ?? null });
    const familyKey = keys.cluster || keys.exactFamily || normalizeTitleFingerprint(row.ebayTitle);
    const band = getAuctionUrgencyBand(row.auctionEndsAt);
    const baseWeight = row.disposition === 'purchased' ? 5 : row.disposition === 'bad_logic' ? -7 : -2;
    globalBand.set(band, (globalBand.get(band) ?? 0) + Math.max(-4, Math.min(4, baseWeight - (band === 'buy_now' ? 0 : 1))));
    if (!familyKey) continue;
    if (!familyBand.has(familyKey)) familyBand.set(familyKey, new Map());
    const bandMap = familyBand.get(familyKey)!;
    bandMap.set(band, (bandMap.get(band) ?? 0) + baseWeight);
  }

  return { globalBand, familyBand };
}

export function scoreListingAgainstAuctionMemory(
  args: { ebayTitle: string; scpProductName?: string | null; auctionEndsAt?: string | null },
  memory: AuctionOutcomeMemory | null | undefined,
): { score: number; reason: string | null; band: string; familyKey: string | null } {
  const keys = buildDealDiversityKeys(args);
  const band = getAuctionUrgencyBand(args.auctionEndsAt);
  const familyKey = keys.cluster || keys.exactFamily || normalizeTitleFingerprint(args.ebayTitle);
  if (!memory) return { score: 0, reason: null, band, familyKey: familyKey || null };

  const globalScore = memory.globalBand.get(band) ?? 0;
  const familyScore = familyKey ? (memory.familyBand.get(familyKey)?.get(band) ?? 0) : 0;
  const total = Math.max(-12, Math.min(12, globalScore + familyScore));
  if (total <= -8) return { score: Math.round(total), reason: 'historically weak auction timing pattern', band, familyKey: familyKey || null };
  if (total <= -4) return { score: Math.round(total), reason: 'mixed auction timing history', band, familyKey: familyKey || null };
  if (total >= 7) return { score: Math.round(total), reason: 'historically productive auction timing', band, familyKey: familyKey || null };
  if (total >= 4) return { score: Math.round(total), reason: 'decent auction timing history', band, familyKey: familyKey || null };
  return { score: Math.round(total), reason: null, band, familyKey: familyKey || null };
}

export function buildPriceBandOutcomeMemory(rows: PriceBandOutcomeMemoryRow[]): PriceBandOutcomeMemory {
  const globalBand = new Map<string, number>();
  const familyBand = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const keys = buildDealDiversityKeys({ ebayTitle: row.ebayTitle, scpProductName: row.scpProductName ?? null });
    const familyKey = keys.cluster || keys.exactFamily || normalizeTitleFingerprint(row.ebayTitle);
    const band = getPriceBand(row.totalPurchasePrice);
    const qualityBonus = row.disposition === 'purchased'
      ? ((row.estimatedMarginPct ?? 0) >= 60 ? 2 : (row.estimatedProfit ?? 0) >= 25 ? 1 : 0)
      : 0;
    const baseWeight = row.disposition === 'purchased' ? 4 + qualityBonus : row.disposition === 'bad_logic' ? -6 : -2;
    globalBand.set(band, (globalBand.get(band) ?? 0) + Math.max(-4, Math.min(4, baseWeight)));
    if (!familyKey) continue;
    if (!familyBand.has(familyKey)) familyBand.set(familyKey, new Map());
    const bandMap = familyBand.get(familyKey)!;
    bandMap.set(band, (bandMap.get(band) ?? 0) + baseWeight);
  }

  return { globalBand, familyBand };
}

export function scoreListingAgainstPriceBandMemory(
  args: { ebayTitle: string; scpProductName?: string | null; totalPurchasePrice: number },
  memory: PriceBandOutcomeMemory | null | undefined,
): { score: number; reason: string | null; band: string; familyKey: string | null } {
  const keys = buildDealDiversityKeys(args);
  const band = getPriceBand(args.totalPurchasePrice);
  const familyKey = keys.cluster || keys.exactFamily || normalizeTitleFingerprint(args.ebayTitle);
  if (!memory) return { score: 0, reason: null, band, familyKey: familyKey || null };

  const globalScore = memory.globalBand.get(band) ?? 0;
  const familyScore = familyKey ? (memory.familyBand.get(familyKey)?.get(band) ?? 0) : 0;
  const total = Math.max(-12, Math.min(12, globalScore + familyScore));
  if (total <= -8) return { score: Math.round(total), reason: 'historically weak price band', band, familyKey: familyKey || null };
  if (total <= -4) return { score: Math.round(total), reason: 'mixed price-band history', band, familyKey: familyKey || null };
  if (total >= 7) return { score: Math.round(total), reason: 'historically productive price band', band, familyKey: familyKey || null };
  if (total >= 4) return { score: Math.round(total), reason: 'decent price-band history', band, familyKey: familyKey || null };
  return { score: Math.round(total), reason: null, band, familyKey: familyKey || null };
}

export function summarizeSellerOutcomeMemory(args: {
  sellerUsername: string;
  purchased: number;
  suppress: number;
  badLogic: number;
}): SellerOutcomeSummary {
  const total = args.purchased + args.suppress + args.badLogic;
  const score = args.purchased * 4 - args.badLogic * 5 - args.suppress * 1.5;
  let label = 'No seller history';
  let detail = 'First tracked listing from this seller';

  if (total >= 1) {
    if (args.purchased >= 2 && score >= 6) {
      label = 'Strong seller history';
      detail = `${args.purchased}/${total} prior outcomes were purchased`;
    } else if (args.badLogic >= 2 && score <= -7) {
      label = 'Weak seller history';
      detail = `${args.badLogic}/${total} prior outcomes were bad logic`;
    } else if (args.suppress >= 3 && args.purchased === 0 && score <= -5) {
      label = 'Soft seller fade';
      detail = `${args.suppress}/${total} prior outcomes were suppressed`;
    } else {
      label = 'Mixed seller history';
      detail = `${args.purchased} purchased • ${args.suppress} suppressed • ${args.badLogic} bad logic`;
    }
  }

  return {
    sellerUsername: args.sellerUsername,
    total,
    purchased: args.purchased,
    suppress: args.suppress,
    badLogic: args.badLogic,
    score: Math.round(score),
    label,
    detail,
  };
}

export function tokenSimilarity(left: string, right: string): number {
  const leftSet = new Set(tokenizeLoose(left).filter((token) => token.length > 2));
  const rightSet = new Set(tokenizeLoose(right).filter((token) => token.length > 2));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union ? intersection / union : 0;
}


const PLAYER_MEMORY_STOP_WORDS = new Set([
  'panini', 'topps', 'bowman', 'upper', 'deck', 'donruss', 'fleer', 'score', 'leaf', 'finest', 'chrome', 'optic', 'prizm', 'mosaic', 'select', 'contenders',
  'absolute', 'prestige', 'playoff', 'heritage', 'stadium', 'club', 'archives', 'donruss', 'elite', 'origins', 'obsidian', 'phoenix', 'revolution',
  'rookie', 'rc', 'auto', 'autograph', 'signed', 'patch', 'relic', 'jersey', 'memorabilia', 'graded', 'raw', 'psa', 'bgs', 'sgc', 'cgc',
  'silver', 'green', 'blue', 'red', 'purple', 'orange', 'gold', 'pink', 'black', 'white', 'bronze', 'sepia', 'negative', 'wave', 'mojo', 'disco', 'shimmer',
  'sparkle', 'pulsar', 'laser', 'ice', 'cracked', 'reactive', 'fluorescent', 'checkerboard', 'zebra', 'tiger', 'peacock', 'nebula', 'parallel',
  'football', 'baseball', 'basketball', 'hockey', 'cards', 'card', 'trading', 'sports', 'set', 'insert', 'variation', 'var', 'ssp', 'sp', 'casehit', 'case', 'hit',
  'mint', 'gem', 'serial', 'numbered', 'out', 'of', 'holo', 'refractor', 'rainbow', 'scope', 'velocity', 'choice', 'premier', 'ticket', 'downtown', 'kaboom',
])

export type PlayerOutcomeMemoryRow = {
  ebayTitle: string;
  scpProductName?: string | null;
  disposition: 'purchased' | 'suppress_90_days' | 'bad_logic';
};

export type PlayerOutcomeMemory = {
  player: Map<string, number>;
};

function normalizePlayerNameKey(value: string | null | undefined): string | null {
  const tokens = tokenizeLoose(value ?? '')
    .map((token) => token.replace(/[^a-z'-]+/g, ''))
    .filter((token) => token.length >= 2)
    .filter((token) => !PLAYER_MEMORY_STOP_WORDS.has(token));
  if (tokens.length === 0) return null;
  return tokens.slice(0, 2).join(' ');
}

export function inferPlayerKey(args: { ebayTitle: string; scpProductName?: string | null; requestedPlayerName?: string | null }): string | null {
  const requested = normalizePlayerNameKey(args.requestedPlayerName ?? null);
  if (requested) return requested;

  const source = compactWhitespace(`${args.scpProductName ?? ''} ${args.ebayTitle}`);
  const tokens = tokenizeLoose(source)
    .map((token) => token.replace(/[^a-z'-]+/g, ''))
    .filter((token) => token.length >= 2)
    .filter((token) => !PLAYER_MEMORY_STOP_WORDS.has(token))
    .filter((token) => !/^(19|20)\d{2}$/.test(token));

  const unique: string[] = [];
  for (const token of tokens) {
    if (!unique.includes(token)) unique.push(token);
  }
  if (unique.length >= 2) return `${unique[0]} ${unique[1]}`;
  return unique[0] ?? null;
}

export function buildPlayerOutcomeMemory(rows: PlayerOutcomeMemoryRow[]): PlayerOutcomeMemory {
  const player = new Map<string, number>();
  for (const row of rows) {
    const playerKey = inferPlayerKey({ ebayTitle: row.ebayTitle, scpProductName: row.scpProductName ?? null });
    if (!playerKey) continue;
    const weight = row.disposition === 'purchased' ? 5 : row.disposition === 'bad_logic' ? -7 : -2;
    player.set(playerKey, (player.get(playerKey) ?? 0) + weight);
  }
  return { player };
}

export function scoreListingAgainstPlayerMemory(
  args: { ebayTitle: string; scpProductName?: string | null; requestedPlayerName?: string | null },
  memory: PlayerOutcomeMemory | null | undefined,
): { score: number; reason: string | null; playerKey: string | null } {
  const playerKey = inferPlayerKey(args);
  if (!playerKey || !memory) return { score: 0, reason: null, playerKey };
  const total = Math.max(-12, Math.min(12, memory.player.get(playerKey) ?? 0));
  if (total <= -8) return { score: total, reason: 'historically weak player pocket', playerKey };
  if (total <= -4) return { score: total, reason: 'mixed player history', playerKey };
  if (total >= 7) return { score: total, reason: 'historically productive player pocket', playerKey };
  if (total >= 4) return { score: total, reason: 'decent player history', playerKey };
  return { score: total, reason: null, playerKey };
}

export type CardNumberOutcomeMemoryRow = {
  ebayTitle: string;
  scpProductName?: string | null;
  disposition: 'purchased' | 'suppress_90_days' | 'bad_logic';
};

export type CardNumberOutcomeMemory = {
  globalCategory: Map<string, number>;
  familyCategory: Map<string, Map<string, number>>;
};

export function extractCardNumberEvidenceToken(value: string | null | undefined): string | null {
  const input = compactWhitespace(value ?? '').toLowerCase();
  if (!input) return null;
  const hashMatch = input.match(/#\s*([a-z0-9-]{1,8})\b/i)?.[1];
  if (hashMatch && !/^(19|20)\d{2}$/.test(hashMatch)) return hashMatch.toLowerCase();

  for (const token of tokenizeLoose(input)) {
    const normalized = token.replace(/^#/, '').replace(/[^a-z0-9-]/g, '');
    if (!normalized || normalized.length > 8) continue;
    if (/^(19|20)\d{2}$/.test(normalized)) continue;
    if (!/\d/.test(normalized)) continue;
    if (/^\d{2,4}$/.test(normalized) && input.includes(`/${normalized}`)) continue;
    return normalized.toLowerCase();
  }
  return null;
}

function getCardNumberEvidenceCategory(args: { ebayTitle: string; scpProductName?: string | null }): { category: string; listingToken: string | null; productToken: string | null; familyKey: string | null } {
  const listingToken = extractCardNumberEvidenceToken(args.ebayTitle);
  const productToken = extractCardNumberEvidenceToken(args.scpProductName ?? null);
  const familyKey = buildDealDiversityKeys({ ebayTitle: args.ebayTitle, scpProductName: args.scpProductName ?? null }).cluster || normalizeTitleFingerprint(args.ebayTitle);
  let category = 'missing';
  if (listingToken && productToken) {
    category = listingToken === productToken ? 'match' : 'mismatch';
  } else if (listingToken) {
    category = 'listing_only';
  } else if (productToken) {
    category = 'candidate_only';
  }
  return { category, listingToken, productToken, familyKey };
}

export function buildCardNumberOutcomeMemory(rows: CardNumberOutcomeMemoryRow[]): CardNumberOutcomeMemory {
  const globalCategory = new Map<string, number>();
  const familyCategory = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const evidence = getCardNumberEvidenceCategory({ ebayTitle: row.ebayTitle, scpProductName: row.scpProductName ?? null });
    const weight = row.disposition === 'purchased' ? 4 : row.disposition === 'bad_logic' ? -6 : -2;
    globalCategory.set(evidence.category, (globalCategory.get(evidence.category) ?? 0) + weight);
    if (!evidence.familyKey) continue;
    if (!familyCategory.has(evidence.familyKey)) familyCategory.set(evidence.familyKey, new Map());
    const familyMap = familyCategory.get(evidence.familyKey)!;
    familyMap.set(evidence.category, (familyMap.get(evidence.category) ?? 0) + weight);
  }
  return { globalCategory, familyCategory };
}

export function scoreScpCandidateAgainstCardNumberMemory(
  args: { ebayTitle: string; scpProductName?: string | null; requestedCardNumber?: string | null },
  memory: CardNumberOutcomeMemory | null | undefined,
): { score: number; reason: string | null; category: string; listingToken: string | null; productToken: string | null; requestedToken: string | null; familyKey: string | null } {
  const evidence = getCardNumberEvidenceCategory(args);
  const requestedToken = extractCardNumberEvidenceToken(args.requestedCardNumber ?? null);
  let total = 0;
  if (memory) {
    total += memory.globalCategory.get(evidence.category) ?? 0;
    total += evidence.familyKey ? (memory.familyCategory.get(evidence.familyKey)?.get(evidence.category) ?? 0) : 0;
  }

  if (requestedToken) {
    if (evidence.productToken && evidence.productToken === requestedToken) total += 5;
    else if (evidence.productToken && evidence.productToken !== requestedToken) total -= 8;
    if (evidence.listingToken && evidence.listingToken === requestedToken) total += 3;
    else if (evidence.listingToken && evidence.listingToken !== requestedToken) total -= 6;
  }

  total = Math.max(-16, Math.min(16, total));
  if (total <= -10) return { ...evidence, requestedToken, score: total, reason: 'historically weak card-number evidence' };
  if (total <= -5) return { ...evidence, requestedToken, score: total, reason: 'mixed card-number evidence history' };
  if (total >= 10) return { ...evidence, requestedToken, score: total, reason: 'historically strong card-number evidence' };
  if (total >= 5) return { ...evidence, requestedToken, score: total, reason: 'decent card-number evidence' };
  return { ...evidence, requestedToken, score: total, reason: null };
}
