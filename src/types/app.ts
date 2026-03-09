export type ListingMode = 'buy_now' | 'auction';
export type CardConditionMode = 'raw' | 'graded' | 'any';
export type ScanStatus =
  | 'queued'
  | 'fetching_ebay'
  | 'filtering'
  | 'matching_scp'
  | 'ai_verifying'
  | 'publishing_results'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type Disposition = 'purchased' | 'suppress_90_days' | 'bad_logic' | 'not_profitable';
export type ProviderName = 'ebay' | 'scp' | 'openai' | 'ximilar';

export type SearchForm = {
  sport: string;
  startYear?: number | null;
  endYear?: number | null;
  brand?: string;
  variant?: string;
  insert?: string;
  cardNumber?: string;
  numberedOutOf?: string;
  playerName?: string;
  position?: string;
  team?: string;
  rookie?: boolean;
  autographed?: boolean;
  memorabilia?: boolean;
  numberedCard?: boolean;
  conditionMode: CardConditionMode;
  listingMode: ListingMode;
  auctionHours?: number | null;
  maxPurchasePrice?: number | null;
  minProfit?: number | null;
  minMarginPct?: number | null;
};

export type ScanMetrics = {
  candidatesFetched: number;
  candidatesFilteredOut: number;
  candidatesEvaluated: number;
  dealsFound: number;
  needsReview: number;
  ebayCalls: number;
  scpCalls: number;
  openaiCalls: number;
  ximilarCalls: number;
};

export type ScanResultRow = {
  id: string;
  scanId: string;
  ebayItemId: string;
  imageUrl: string | null;
  ebayTitle: string;
  ebayUrl: string;
  purchasePrice: number;
  shippingPrice: number;
  totalPurchasePrice: number;
  scpProductId: string | null;
  scpProductName: string | null;
  scpLink: string | null;
  scpUngradedSell: number | null;
  scpGrade9: number | null;
  scpPsa10: number | null;
  estimatedProfit: number | null;
  estimatedMarginPct: number | null;
  aiConfidence: number | null;
  needsReview: boolean;
  auctionEndsAt: string | null;
  sellerUsername: string | null;
  sellerFeedbackPercentage: number | null;
  sellerFeedbackScore: number | null;
  listingQualityScore: number | null;
  createdAt: string;
  disposition: Disposition | null;
  reasoning: string | null;
};

export type ReviewOption = {
  id: string;
  resultId: string;
  rank: number;
  scpProductId: string;
  scpProductName: string;
  scpLink: string | null;
  scpUngradedSell: number | null;
  scpGrade9: number | null;
  scpPsa10: number | null;
  confidence: number | null;
};

export type ScanSummary = {
  id: string;
  status: ScanStatus;
  filters: SearchForm;
  startedAt: string;
  finishedAt: string | null;
  metrics: ScanMetrics;
  stageMessage: string | null;
  warningCount: number;
  errorCount: number;
};

export type ScpCacheEntry = {
  id: string;
  cacheKey: string;
  consoleName: string;
  sourceConsoleUrl: string | null;
  storagePath: string | null;
  downloadedAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
};

export type ProviderLimitStatus = {
  provider: ProviderName;
  used: number;
  limit: number | null;
  remaining: number | null;
  isNearLimit: boolean;
  isExceeded: boolean;
};

export type ScpCacheTracker = {
  totalFiles: number;
  recentUploads: number;
  updatedRecently: number;
  staleFiles: number;
  errorCount: number;
  lastUpdatedAt: string | null;
  lastCheckAt: string | null;
  lastCheckStatus: 'ok' | 'warning' | 'error' | null;
  lastCheckMessage: string | null;
};

export type DashboardSnapshot = {
  activeScan: ScanSummary | null;
  latestScan: ScanSummary | null;
  visibleResults: ScanResultRow[];
  needsReviewResults: ScanResultRow[];
  reviewOptionsByResultId: Record<string, ReviewOption[]>;
  diagnostics: Array<{
    id: string;
    level: 'info' | 'warning' | 'error';
    stage: string;
    message: string;
    details: string | null;
    createdAt: string;
  }>;
  diagnosticsSummary: {
    topRejectionReasons: Array<{ reason: string; count: number }>;
    stageTimings: Array<{ stage: string; seconds: number; eventCount: number }>;
  };
  scpCaches: ScpCacheEntry[];
  scpCacheTracker: ScpCacheTracker;
  usage: {
    openAiCostTodayUsd: number | null;
    ebayCallsToday: number;
    scpCallsToday: number;
    openAiCallsToday: number;
    ximilarCallsToday: number;
    providerLimits: ProviderLimitStatus[];
  };
};
