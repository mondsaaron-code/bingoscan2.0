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
