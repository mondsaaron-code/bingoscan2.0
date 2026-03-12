import { createSupabaseAdminClient } from '@/lib/supabase';
import { getOpenAiTodayCostUsd } from '@/lib/openai-admin';
import { compactWhitespace, normalizeSellerUsername, normalizeTitleFingerprint, safeJsonParse, slugify, summarizeSellerOutcomeMemory, tokenizeLoose } from '@/lib/utils';
import type {
  DashboardSnapshot,
  Disposition,
  ReviewLearningSnapshot,
  ProviderLimitStatus,
  ProviderName,
  ReviewOption,
  ScanMetrics,
  ScanResultRow,
  ScanSummary,
  ScpCacheEntry,
  ScpCacheTracker,
  SearchForm,
  ScanStatus,
} from '@/types/app';

function getSupabase() {
  return createSupabaseAdminClient();
}

const ACTIVE_SCAN_STATUSES: ScanStatus[] = ['queued', 'fetching_ebay', 'filtering', 'matching_scp', 'ai_verifying', 'publishing_results'];


const PROVIDER_LIMIT_ENV: Record<ProviderName, string> = {
  ebay: 'EBAY_DAILY_CALL_LIMIT',
  scp: 'SCP_DAILY_CALL_LIMIT',
  openai: 'OPENAI_DAILY_CALL_LIMIT',
  ximilar: 'XIMILAR_DAILY_CALL_LIMIT',
};

type BadLogicMemoryRow = {
  ebayTitle: string;
  fingerprint: string;
  createdAt: string;
  reasoning: string | null;
};

type TitleOutcomeMemoryDbRow = {
  ebayTitle: string;
  disposition: Disposition;
};

type FamilyOutcomeMemoryDbRow = {
  ebayTitle: string;
  scpProductName: string | null;
  disposition: Disposition;
};

type ReviewResolutionMemoryDbRow = {
  ebayTitle: string;
  selectedProductId: string;
  selectedProductName: string;
  optionProductId: string;
  optionProductName: string;
  chosen: boolean;
};

type AuctionOutcomeMemoryDbRow = {
  ebayTitle: string;
  scpProductName: string | null;
  auctionEndsAt: string | null;
  totalPurchasePrice: number;
  disposition: Disposition;
};

type PriceBandOutcomeMemoryDbRow = {
  ebayTitle: string;
  scpProductName: string | null;
  totalPurchasePrice: number;
  estimatedProfit: number | null;
  estimatedMarginPct: number | null;
  disposition: Disposition;
};

type PlayerOutcomeMemoryDbRow = {
  ebayTitle: string;
  scpProductName: string | null;
  disposition: Disposition;
};

type CardNumberOutcomeMemoryDbRow = {
  ebayTitle: string;
  scpProductName: string | null;
  disposition: Disposition;
};

type ScpCacheRefreshRun = {
  id: string;
  trigger: 'login_auto' | 'manual_check' | 'upload';
  status: 'ok' | 'warning' | 'error';
  totalFiles: number;
  recentUploads: number;
  updatedRecently: number;
  staleFiles: number;
  errorCount: number;
  lastUpdatedAt: string | null;
  message: string | null;
  createdAt: string;
};

export type SellerOutcomeMemory = {
  sellerUsername: string;
  total: number;
  purchased: number;
  suppress: number;
  badLogic: number;
  score: number;
  label: string;
  detail: string;
};

type UsageRow = {
  usage_date: string;
  ebay_calls: number;
  scp_calls: number;
  openai_calls: number;
  ximilar_calls: number;
  openai_cost_usd: number;
};

function getProviderLimit(provider: ProviderName): number | null {
  const raw = process.env[PROVIDER_LIMIT_ENV[provider]];
  if (!raw) return provider === 'ebay' ? 4500 : null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function emptyUsageRow(today: string): UsageRow {
  return {
    usage_date: today,
    ebay_calls: 0,
    scp_calls: 0,
    openai_calls: 0,
    ximilar_calls: 0,
    openai_cost_usd: 0,
  };
}

function getProviderUsedCount(row: Partial<UsageRow> | null | undefined, provider: ProviderName): number {
  if (!row) return 0;
  if (provider === 'ebay') return Number(row.ebay_calls ?? 0);
  if (provider === 'scp') return Number(row.scp_calls ?? 0);
  if (provider === 'openai') return Number(row.openai_calls ?? 0);
  return Number(row.ximilar_calls ?? 0);
}

function buildProviderLimitStatuses(row: Partial<UsageRow> | null | undefined): ProviderLimitStatus[] {
  return (['ebay', 'scp', 'openai', 'ximilar'] as ProviderName[]).map((provider) => {
    const used = getProviderUsedCount(row, provider);
    const limit = getProviderLimit(provider);
    const remaining = limit === null ? null : Math.max(0, limit - used);
    const isExceeded = limit !== null && used >= limit;
    const isNearLimit = limit !== null && !isExceeded && used >= Math.floor(limit * 0.85);
    return {
      provider,
      used,
      limit,
      remaining,
      isNearLimit,
      isExceeded,
    } satisfies ProviderLimitStatus;
  });
}

function scoreScpCacheEntry(entry: ScpCacheEntry, hints: string[]): number {
  const entryAliases = [entry.consoleName, entry.cacheKey.replace(/\.csv$/i, ''), entry.sourceConsoleUrl ?? ''].filter(Boolean);
  const haystack = entryAliases.join(' ').toLowerCase();
  const normalizedEntryAliases = entryAliases.map(normalizeScpCacheAlias).filter(Boolean);
  const entryYear = extractYearToken(haystack);
  let score = 0;
  const tokenSet = new Set<string>();

  for (const hint of hints) {
    for (const token of tokenizeLoose(hint)) {
      if (token.length > 2) tokenSet.add(token);
    }
  }

  for (const token of tokenSet) {
    if (haystack.includes(token)) score += /^\d{4}$/.test(token) ? 10 : 4;
  }

  for (const hint of hints) {
    const normalizedHint = normalizeScpCacheAlias(hint);
    if (!normalizedHint) continue;
    if (normalizedEntryAliases.includes(normalizedHint)) {
      score += 34;
      continue;
    }
    for (const alias of normalizedEntryAliases) {
      if (!alias) continue;
      if (alias.includes(normalizedHint) || normalizedHint.includes(alias)) {
        score += 18;
      }
      const overlap = countSharedTokens(alias, normalizedHint);
      if (overlap >= 4) score += 14;
      else if (overlap >= 3) score += 9;
      else if (overlap >= 2) score += 5;
    }

    const hintYear = extractYearToken(hint);
    if (entryYear && hintYear && entryYear === hintYear) score += 8;
    if (entryYear && hintYear && entryYear !== hintYear) score -= 10;
  }

  const joinedHints = hints.join(' ').toLowerCase();
  if (joinedHints && haystack.includes(joinedHints)) score += 16;
  if (entry.consoleName && hints.some((hint) => slugify(hint) === slugify(entry.consoleName))) score += 20;
  if (entry.sourceConsoleUrl && hints.some((hint) => entry.sourceConsoleUrl?.toLowerCase().includes(slugify(hint)))) score += 6;
  return score;
}

function normalizeScpCacheAlias(value: string): string {
  const stop = new Set(['sports', 'trading', 'card', 'cards', 'set', 'sets', 'the', 'and', 'edition']);
  return tokenizeLoose(compactWhitespace(value)
    .replace(/https?:\/\/[^/]+\//gi, ' ')
    .replace(/\.csv$/i, ' ')
    .replace(/[-_/]+/g, ' '))
    .filter((token) => token.length > 1 && !stop.has(token))
    .join(' ');
}

function extractYearToken(value: string): string | null {
  return value.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
}

function countSharedTokens(left: string, right: string): number {
  const leftTokens = new Set(tokenizeLoose(left).filter((token) => token.length > 2));
  let count = 0;
  for (const token of tokenizeLoose(right)) {
    if (token.length > 2 && leftTokens.has(token)) count += 1;
  }
  return count;
}

export async function getActiveScan(): Promise<ScanSummary | null> {
  const { data, error } = await getSupabase()
    .from('scans')
    .select('*')
    .in('status', ACTIVE_SCAN_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapScan(data) : null;
}

export async function getLatestScan(): Promise<ScanSummary | null> {
  const { data, error } = await getSupabase().from('scans').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? mapScan(data) : null;
}

export async function getEbaySearchPageCount(scanId: string): Promise<number> {
  const { count, error } = await getSupabase()
    .from('scan_stage_events')
    .select('id', { count: 'exact', head: true })
    .eq('scan_id', scanId)
    .eq('stage', 'fetching_ebay')
    .ilike('message', 'Fetched % eBay candidates');
  if (error) throw error;
  return count ?? 0;
}

export async function createScan(filters: SearchForm): Promise<ScanSummary> {
  const { data, error } = await getSupabase()
    .from('scans')
    .insert({
      filters,
      status: 'queued',
      stage_message: 'Queued',
      metrics: defaultMetrics(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapScan(data);
}

export async function markScanStatus(scanId: string, status: ScanStatus, stageMessage: string): Promise<void> {
  const patch: Record<string, unknown> = { status, stage_message: stageMessage };
  if (['completed', 'cancelled', 'failed'].includes(status)) {
    patch.finished_at = new Date().toISOString();
  }
  const { error } = await getSupabase().from('scans').update(patch).eq('id', scanId);
  if (error) throw error;
}

export async function appendMetrics(scanId: string, partial: Partial<ScanMetrics>): Promise<void> {
  const { data, error } = await getSupabase().from('scans').select('metrics').eq('id', scanId).single();
  if (error) throw error;
  const current = safeJsonParse<ScanMetrics>(data.metrics, defaultMetrics());
  const next = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    const typedKey = key as keyof ScanMetrics;
    next[typedKey] = (next[typedKey] ?? 0) + (value ?? 0);
  }
  const { error: updateError } = await getSupabase().from('scans').update({ metrics: next }).eq('id', scanId);
  if (updateError) throw updateError;
}

export async function addScanEvent(
  scanId: string,
  level: 'info' | 'warning' | 'error',
  stage: string,
  message: string,
  details?: string | null,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('scan_stage_events').insert({
    scan_id: scanId,
    level,
    stage,
    message,
    details: details ?? null,
  });
  if (error) throw error;

  if (level !== 'info') {
    const { data: scanRow, error: scanError } = await supabase.from('scans').select('warning_count, error_count').eq('id', scanId).single();
    if (scanError) throw scanError;

    const patch = {
      warning_count: Number(scanRow.warning_count ?? 0),
      error_count: Number(scanRow.error_count ?? 0),
    };
    if (level === 'warning') patch.warning_count += 1;
    if (level === 'error') patch.error_count += 1;

    const { error: updateError } = await supabase.from('scans').update(patch).eq('id', scanId);
    if (updateError) throw updateError;
  }
}

export async function getRecentStageEvents(
  scanId: string,
  limit = 12,
): Promise<Array<{ level: 'info' | 'warning' | 'error'; stage: string; message: string; details: string | null; createdAt: string }>> {
  const { data, error } = await getSupabase()
    .from('scan_stage_events')
    .select('level,stage,message,details,created_at')
    .eq('scan_id', scanId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    level: row.level as 'info' | 'warning' | 'error',
    stage: String(row.stage),
    message: String(row.message),
    details: row.details ? String(row.details) : null,
    createdAt: String(row.created_at),
  }));
}

export async function getScanById(scanId: string): Promise<ScanSummary | null> {
  const { data, error } = await getSupabase().from('scans').select('*').eq('id', scanId).maybeSingle();
  if (error) throw error;
  return data ? mapScan(data) : null;
}

export async function upsertDedupeItem(ebayItemId: string): Promise<boolean> {
  const now = Date.now();
  const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const { data: existing, error: existingError } = await getSupabase()
    .from('ebay_item_dedupe')
    .select('ebay_item_id, expires_at')
    .eq('ebay_item_id', ebayItemId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && new Date(existing.expires_at).getTime() > now) {
    return false;
  }
  const { error } = await getSupabase().from('ebay_item_dedupe').upsert({ ebay_item_id: ebayItemId, expires_at: expiresAt });
  if (error) throw error;
  return true;
}

export async function insertCandidate(scanId: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await getSupabase().from('scan_candidates').insert({ scan_id: scanId, ...payload }).select('id').single();
  if (error) throw error;
  return String(data.id);
}

function isSchemaDriftError(error: unknown, columns: string[]): boolean {
  const message = typeof error === 'object' && error !== null
    ? `${String((error as { message?: unknown }).message ?? '')} ${String((error as { details?: unknown }).details ?? '')} ${String((error as { hint?: unknown }).hint ?? '')}`.toLowerCase()
    : String(error ?? '').toLowerCase();
  return columns.some((column) => message.includes(column.toLowerCase()));
}

function omitColumns<T extends Record<string, unknown>>(row: T, columns: string[]): T {
  const next = { ...row };
  for (const column of columns) delete next[column];
  return next;
}

export async function updateCandidate(candidateId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabase().from('scan_candidates').update(patch).eq('id', candidateId);
  if (error) throw error;
}

export async function insertResult(payload: Record<string, unknown>): Promise<string> {
  const firstAttempt = await getSupabase().from('scan_results').insert(payload).select('id').single();
  if (!firstAttempt.error) return String(firstAttempt.data.id);

  const driftColumns = ['ai_chosen_product_id', 'ai_top_three_product_ids', 'review_reason'];
  if (!isSchemaDriftError(firstAttempt.error, driftColumns)) throw firstAttempt.error;

  const fallbackPayload = omitColumns(payload, driftColumns);
  const secondAttempt = await getSupabase().from('scan_results').insert(fallbackPayload).select('id').single();
  if (secondAttempt.error) throw secondAttempt.error;
  return String(secondAttempt.data.id);
}

export async function insertReviewOptions(resultId: string, options: Array<Record<string, unknown>>): Promise<void> {
  if (options.length === 0) return;
  const rows = options.map((option) => ({ ...option, result_id: resultId }));
  const firstAttempt = await getSupabase().from('scan_review_options').insert(rows);
  if (!firstAttempt.error) return;

  const driftColumns = ['candidate_source', 'match_score', 'positive_signals', 'negative_signals', 'ai_preferred'];
  if (!isSchemaDriftError(firstAttempt.error, driftColumns)) throw firstAttempt.error;

  const fallbackRows = rows.map((row) => omitColumns(row, driftColumns));
  const secondAttempt = await getSupabase().from('scan_review_options').insert(fallbackRows);
  if (secondAttempt.error) throw secondAttempt.error;
}

export async function setDisposition(resultIds: string[], disposition: Disposition): Promise<void> {
  const { error } = await getSupabase().from('scan_results').update({ disposition }).in('id', resultIds);
  if (error) throw error;
  const rows = resultIds.map((id) => ({ scan_result_id: id, disposition }));
  const { error: dispositionError } = await getSupabase().from('result_dispositions').insert(rows);
  if (dispositionError) throw dispositionError;
}

function passesThresholdsForFilters(filters: SearchForm, estimatedProfit: number | null, estimatedMarginPct: number | null): boolean {
  if (estimatedProfit === null) return false;
  if (estimatedProfit <= 0) return false;
  if (filters.minProfit && estimatedProfit < filters.minProfit) return false;
  if (filters.minMarginPct && (estimatedMarginPct ?? 0) < filters.minMarginPct) return false;
  return true;
}

export async function resolveReview(resultId: string, optionId: string): Promise<{ disposition: Disposition | null; matchedProductName: string; tracked: true; selectedRank: number | null; selectedIsAiTop1: boolean; selectedInAiTop3: boolean }> {
  const supabase = getSupabase();
  const [{ data: option, error: optionError }, { data: resultRow, error: resultError }] = await Promise.all([
    supabase.from('scan_review_options').select('*').eq('id', optionId).single(),
    supabase.from('scan_results').select('*').eq('id', resultId).single(),
  ]);
  if (optionError) throw optionError;
  if (resultError) throw resultError;

  const { data: scanRow, error: scanError } = await supabase
    .from('scans')
    .select('filters')
    .eq('id', String(resultRow.scan_id))
    .single();
  if (scanError) throw scanError;

  const filters = safeJsonParse<SearchForm>(scanRow?.filters, { sport: 'Football', conditionMode: 'raw', listingMode: 'buy_now' });
  const totalPurchasePrice = Number(resultRow.total_purchase_price ?? 0);
  const scpUngradedSell = option.scp_ungraded_sell === null ? null : Number(option.scp_ungraded_sell);
  const estimatedProfit = scpUngradedSell === null ? null : scpUngradedSell - totalPurchasePrice;
  const estimatedMarginPct = scpUngradedSell !== null && totalPurchasePrice > 0 && estimatedProfit !== null
    ? (estimatedProfit / totalPurchasePrice) * 100
    : null;
  const profitable = passesThresholdsForFilters(filters, estimatedProfit, estimatedMarginPct);
  const disposition: Disposition | null = profitable ? null : 'not_enough_profit';
  const aiTopThreeProductIds = safeJsonParse<string[]>(resultRow?.ai_top_three_product_ids, []).map(String).slice(0, 3);
  const aiChosenProductId = resultRow?.ai_chosen_product_id ? String(resultRow.ai_chosen_product_id) : null;
  const selectedProductId = String(option.scp_product_id);
  const selectedRank = Number.isFinite(Number(option.rank)) ? Number(option.rank) : null;
  const selectedIsAiTop1 = Boolean(aiChosenProductId && selectedProductId === aiChosenProductId);
  const selectedInAiTop3 = aiTopThreeProductIds.includes(selectedProductId);

  const { error: updateError } = await supabase
    .from('scan_results')
    .update({
      needs_review: false,
      scp_product_id: option.scp_product_id,
      scp_product_name: option.scp_product_name,
      scp_link: option.scp_link,
      scp_ungraded_sell: option.scp_ungraded_sell,
      scp_grade_9: option.scp_grade_9,
      scp_psa_10: option.scp_psa_10,
      estimated_profit: estimatedProfit,
      estimated_margin_pct: estimatedMarginPct,
      disposition,
    })
    .eq('id', resultId);
  if (updateError) throw updateError;

  if (disposition) {
    const { error: dispositionError } = await supabase.from('result_dispositions').insert({
      scan_result_id: resultId,
      disposition,
    });
    if (dispositionError) throw dispositionError;
  }

  try {
    const { error: feedbackError } = await supabase.from('review_resolution_events').insert({
      scan_result_id: resultId,
      scan_id: resultRow.scan_id,
      selected_option_id: optionId,
      selected_rank: selectedRank,
      ai_chosen_product_id: aiChosenProductId,
      ai_top_three_product_ids: aiTopThreeProductIds,
      selected_product_id: selectedProductId,
      selected_product_name: option.scp_product_name,
      review_reason: resultRow.review_reason ?? null,
      selected_profitable: profitable,
      selected_in_ai_top3: selectedInAiTop3,
      selected_is_ai_top1: selectedIsAiTop1,
    });
    if (feedbackError) {
      // Keep the user-facing review action working even if the learning table has not been added yet.
    }
  } catch {
    // Ignore learning-table drift so manual review resolution still succeeds.
  }

  if (resultRow?.ebay_title) {
    await saveManualMatchOverride(String(resultRow.ebay_title), String(option.scp_product_id), String(option.scp_product_name));
  }

  return {
    disposition,
    matchedProductName: String(option.scp_product_name),
    tracked: true,
    selectedRank,
    selectedIsAiTop1,
    selectedInAiTop3,
  };
}

export async function getScanResultMemory(scanId: string): Promise<Array<{ ebayTitle: string; scpProductName: string | null; needsReview: boolean }>> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('ebay_title, scp_product_name, needs_review')
    .eq('scan_id', scanId)
    .is('disposition', null)
    .order('created_at', { ascending: false })
    .limit(150);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    ebayTitle: String(row.ebay_title ?? ''),
    scpProductName: row.scp_product_name ? String(row.scp_product_name) : null,
    needsReview: Boolean(row.needs_review),
  }));
}

export async function getNeedsReviewQueueFloor(scanId: string, limit = 20): Promise<{ count: number; floorProfit: number | null }> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('estimated_profit')
    .eq('scan_id', scanId)
    .eq('needs_review', true)
    .is('disposition', null)
    .gt('estimated_profit', 0)
    .order('estimated_profit', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const profits = ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => row.estimated_profit === null ? null : Number(row.estimated_profit))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    count: profits.length,
    floorProfit: profits.length >= limit ? profits[profits.length - 1] : null,
  };
}

export async function getRecentBadLogicPatterns(limit = 250): Promise<BadLogicMemoryRow[]> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('ebay_title, reasoning, created_at')
    .eq('disposition', 'bad_logic')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    ebayTitle: String(row.ebay_title ?? ''),
    fingerprint: normalizeTitleFingerprint(String(row.ebay_title ?? '')),
    createdAt: String(row.created_at ?? ''),
    reasoning: row.reasoning ? String(row.reasoning) : null,
  }));
}


export async function getRecentTitleOutcomeMemory(limit = 400): Promise<TitleOutcomeMemoryDbRow[]> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('ebay_title, disposition')
    .not('disposition', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.ebay_title && row.disposition)
    .map((row) => ({
      ebayTitle: String(row.ebay_title),
      disposition: row.disposition as Disposition,
    }));
}

export async function getRecentFamilyOutcomeMemory(limit = 500): Promise<FamilyOutcomeMemoryDbRow[]> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('ebay_title, scp_product_name, disposition')
    .not('disposition', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.ebay_title && row.disposition)
    .map((row) => ({
      ebayTitle: String(row.ebay_title),
      scpProductName: row.scp_product_name ? String(row.scp_product_name) : null,
      disposition: row.disposition as Disposition,
    }));
}


export async function getRecentReviewResolutionMemory(limit = 120): Promise<ReviewResolutionMemoryDbRow[]> {
  const supabase = getSupabase();
  const { data: results, error: resultsError } = await supabase
    .from('scan_results')
    .select('id, ebay_title, scp_product_id, scp_product_name, needs_review')
    .eq('needs_review', false)
    .not('scp_product_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (resultsError) throw resultsError;

  const resultRows = ((results ?? []) as Array<Record<string, unknown>>).filter((row) => row.id && row.ebay_title && row.scp_product_id && row.scp_product_name);
  if (resultRows.length === 0) return [];

  const resultIds = resultRows.map((row) => String(row.id));
  const { data: options, error: optionsError } = await supabase
    .from('scan_review_options')
    .select('result_id, scp_product_id, scp_product_name')
    .in('result_id', resultIds);
  if (optionsError) throw optionsError;

  const optionsByResultId = new Map<string, Array<Record<string, unknown>>>();
  for (const option of (options ?? []) as Array<Record<string, unknown>>) {
    const resultId = String(option.result_id ?? '');
    if (!resultId) continue;
    if (!optionsByResultId.has(resultId)) optionsByResultId.set(resultId, []);
    optionsByResultId.get(resultId)!.push(option);
  }

  const memoryRows: ReviewResolutionMemoryDbRow[] = [];
  for (const row of resultRows) {
    const resultId = String(row.id);
    const resultOptions = optionsByResultId.get(resultId) ?? [];
    if (resultOptions.length === 0) continue;

    const selectedProductId = String(row.scp_product_id);
    const selectedProductName = String(row.scp_product_name);
    const ebayTitle = String(row.ebay_title);

    for (const option of resultOptions) {
      const optionProductId = String(option.scp_product_id ?? '');
      const optionProductName = String(option.scp_product_name ?? '');
      if (!optionProductId || !optionProductName) continue;
      memoryRows.push({
        ebayTitle,
        selectedProductId,
        selectedProductName,
        optionProductId,
        optionProductName,
        chosen: optionProductId === selectedProductId,
      });
    }
  }

  return memoryRows;
}

export async function getRecentAuctionOutcomeMemory(limit = 400): Promise<AuctionOutcomeMemoryDbRow[]> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('ebay_title, scp_product_name, auction_ends_at, total_purchase_price, disposition')
    .not('disposition', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.ebay_title && row.disposition && row.total_purchase_price !== null && row.total_purchase_price !== undefined)
    .map((row) => ({
      ebayTitle: String(row.ebay_title),
      scpProductName: row.scp_product_name ? String(row.scp_product_name) : null,
      auctionEndsAt: row.auction_ends_at ? String(row.auction_ends_at) : null,
      totalPurchasePrice: Number(row.total_purchase_price),
      disposition: row.disposition as Disposition,
    }));
}

export async function getRecentPriceBandOutcomeMemory(limit = 500): Promise<PriceBandOutcomeMemoryDbRow[]> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('ebay_title, scp_product_name, total_purchase_price, estimated_profit, estimated_margin_pct, disposition')
    .not('disposition', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.ebay_title && row.disposition && row.total_purchase_price !== null && row.total_purchase_price !== undefined)
    .map((row) => ({
      ebayTitle: String(row.ebay_title),
      scpProductName: row.scp_product_name ? String(row.scp_product_name) : null,
      totalPurchasePrice: Number(row.total_purchase_price),
      estimatedProfit: row.estimated_profit === null || row.estimated_profit === undefined ? null : Number(row.estimated_profit),
      estimatedMarginPct: row.estimated_margin_pct === null || row.estimated_margin_pct === undefined ? null : Number(row.estimated_margin_pct),
      disposition: row.disposition as Disposition,
    }));
}

export async function getRecentPlayerOutcomeMemory(limit = 500): Promise<PlayerOutcomeMemoryDbRow[]> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('ebay_title, scp_product_name, disposition')
    .not('disposition', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.ebay_title && row.disposition)
    .map((row) => ({
      ebayTitle: String(row.ebay_title),
      scpProductName: row.scp_product_name ? String(row.scp_product_name) : null,
      disposition: row.disposition as Disposition,
    }));
}

export async function getRecentCardNumberOutcomeMemory(limit = 500): Promise<CardNumberOutcomeMemoryDbRow[]> {
  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('ebay_title, scp_product_name, disposition')
    .not('disposition', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.ebay_title && row.disposition)
    .map((row) => ({
      ebayTitle: String(row.ebay_title),
      scpProductName: row.scp_product_name ? String(row.scp_product_name) : null,
      disposition: row.disposition as Disposition,
    }));
}

export async function getSellerOutcomeMemory(sellerUsername: string, limit = 120): Promise<SellerOutcomeMemory | null> {
  const normalizedSeller = normalizeSellerUsername(sellerUsername);
  if (!normalizedSeller) return null;

  const { data, error } = await getSupabase()
    .from('scan_results')
    .select('seller_username, disposition')
    .eq('seller_username', normalizedSeller)
    .not('disposition', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((row) => row.disposition);
  if (rows.length === 0) return null;

  let purchased = 0;
  let suppress = 0;
  let badLogic = 0;
  for (const row of rows) {
    const disposition = row.disposition as Disposition;
    if (disposition === 'purchased') purchased += 1;
    else if (disposition === 'suppress_90_days' || disposition === 'not_profitable' || disposition === 'not_enough_profit' || disposition === 'price_changed' || disposition === 'already_reviewed_duplicate') suppress += 1;
    else if (disposition === 'bad_logic' || disposition === 'bad_scp_options' || disposition === 'does_not_match_query' || disposition === 'multi_card_or_set_builder' || disposition === 'wrong_player_or_wrong_card' || disposition === 'parallel_or_variant_unclear' || disposition === 'non_card_or_memorabilia') badLogic += 1;
  }

  return summarizeSellerOutcomeMemory({
    sellerUsername: normalizedSeller,
    purchased,
    suppress,
    badLogic,
  });
}

export async function getManualMatchOverride(
  ebayTitle: string,
): Promise<{ scpProductId: string; scpProductName: string } | null> {
  const fingerprint = normalizeTitleFingerprint(ebayTitle);
  const { data, error } = await getSupabase()
    .from('manual_match_overrides')
    .select('scp_product_id, scp_product_name')
    .eq('ebay_title_fingerprint', fingerprint)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    scpProductId: String(data.scp_product_id),
    scpProductName: String(data.scp_product_name),
  };
}

export async function saveManualMatchOverride(ebayTitle: string, scpProductId: string, scpProductName: string): Promise<void> {
  const fingerprint = normalizeTitleFingerprint(ebayTitle);
  const supabase = getSupabase();
  const { error: deleteError } = await supabase.from('manual_match_overrides').delete().eq('ebay_title_fingerprint', fingerprint);
  if (deleteError) throw deleteError;

  const { error: insertError } = await supabase.from('manual_match_overrides').insert({
    ebay_title_fingerprint: fingerprint,
    scp_product_id: scpProductId,
    scp_product_name: scpProductName,
  });
  if (insertError) throw insertError;
}

export async function getScpCacheCsvText(consoleName: string): Promise<string | null> {
  const cacheKey = `${slugify(consoleName)}.csv`;
  const { data: indexRow, error: indexError } = await getSupabase()
    .from('scp_set_cache_index')
    .select('storage_path')
    .eq('cache_key', cacheKey)
    .maybeSingle();
  if (indexError) throw indexError;
  if (indexRow?.storage_path) {
    return getScpCacheCsvTextByStoragePath(String(indexRow.storage_path));
  }

  const fuzzy = await findScpCacheMatches([consoleName], 1);
  if (fuzzy[0]?.storagePath) {
    return getScpCacheCsvTextByStoragePath(fuzzy[0].storagePath);
  }

  return null;
}

export async function getScpCacheCsvTextByStoragePath(storagePath: string): Promise<string | null> {
  if (!storagePath) return null;
  const { data, error } = await getSupabase().storage.from('scp-csv-cache').download(storagePath);
  if (error || !data) return null;
  return await data.text();
}

export async function listScpCaches(limit = 10): Promise<ScpCacheEntry[]> {
  const { data, error } = await getSupabase()
    .from('scp_set_cache_index')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(Math.max(limit, 10));
  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map(mapScpCacheEntry)
    .slice(0, limit);
}

type ScpCacheStorageObject = {
  path: string;
  createdAt: string | null;
  updatedAt: string | null;
};

async function listAllScpCacheStorageObjects(): Promise<ScpCacheStorageObject[]> {
  const bucket = getSupabase().storage.from('scp-csv-cache');
  const prefixes = ['', 'sets'];
  const pageSize = 100;
  const byPath = new Map<string, ScpCacheStorageObject>();

  for (const prefix of prefixes) {
    let offset = 0;
    while (true) {
      const { data, error } = await bucket.list(prefix, {
        limit: pageSize,
        offset,
        sortBy: { column: 'updated_at', order: 'desc' },
      });
      if (error) throw error;

      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const row of rows) {
        const name = row.name ? String(row.name).trim() : '';
        if (!name || !name.toLowerCase().endsWith('.csv')) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        byPath.set(path, {
          path,
          createdAt: row.created_at ? String(row.created_at) : null,
          updatedAt: row.updated_at ? String(row.updated_at) : null,
        });
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }
  }

  return [...byPath.values()];
}


async function listAllScpCacheStorageObjectsSafe(): Promise<ScpCacheStorageObject[]> {
  try {
    return await listAllScpCacheStorageObjects();
  } catch {
    return [];
  }
}

function toTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function chooseLatestTimestamp(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = toTimeMs(value);
    if (ms === null) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = value ?? null;
    }
  }
  return best;
}


async function getLatestScpCacheRefreshRunSafe(): Promise<{ status: string | null; message: string | null; created_at: string | null } | null> {
  try {
    const { data, error } = await getSupabase()
      .from('scp_cache_refresh_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return null;
    return data ? {
      status: data.status ? String(data.status) : null,
      message: data.message ? String(data.message) : null,
      created_at: data.created_at ? String(data.created_at) : null,
    } : null;
  } catch {
    return null;
  }
}

async function getScpCacheRefreshErrorRunsSafe(): Promise<Array<{ error_count: number; status: string | null }>> {
  try {
    const { data, error } = await getSupabase()
      .from('scp_cache_refresh_runs')
      .select('*')
      .gte('created_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
    if (error) return [];
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      error_count: Number(row.error_count ?? 0),
      status: row.status ? String(row.status) : null,
    }));
  } catch {
    return [];
  }
}

async function createScpCacheRefreshRun(payload: {
  trigger: 'login_auto' | 'manual_check' | 'upload';
  status: 'ok' | 'warning' | 'error';
  totalFiles: number;
  recentUploads: number;
  updatedRecently: number;
  staleFiles: number;
  errorCount: number;
  lastUpdatedAt: string | null;
  message: string | null;
}): Promise<void> {
  const { error } = await getSupabase().from('scp_cache_refresh_runs').insert({
    trigger: payload.trigger,
    status: payload.status,
    total_files: payload.totalFiles,
    recent_uploads: payload.recentUploads,
    updated_recently: payload.updatedRecently,
    stale_files: payload.staleFiles,
    error_count: payload.errorCount,
    last_updated_at: payload.lastUpdatedAt,
    message: payload.message,
  });
  if (error) throw error;
}

async function calculateScpCacheTrackerSummary(): Promise<ScpCacheTracker> {
  const supabase = getSupabase();
  const [{ data: caches, error: cacheError }, lastRun, errorRuns] = await Promise.all([
    supabase.from('scp_set_cache_index').select('*').order('updated_at', { ascending: false }).limit(1000),
    getLatestScpCacheRefreshRunSafe(),
    getScpCacheRefreshErrorRunsSafe(),
  ]);
  if (cacheError) throw cacheError;

  const cacheRows = (caches ?? []) as Array<Record<string, unknown>>;
  const trackerRowsByPath = new Map<string, { createdAt: string | null; freshnessSource: string | null }>();

  for (const row of cacheRows) {
    const cacheKey = row.cache_key ? String(row.cache_key) : '';
    const storagePath = row.storage_path ? String(row.storage_path) : cacheKey ? `sets/${cacheKey}` : '';
    const rowKey = storagePath || cacheKey || String(row.id ?? '');
    if (!rowKey) continue;
    trackerRowsByPath.set(rowKey, {
      createdAt: row.created_at ? String(row.created_at) : null,
      freshnessSource: chooseLatestTimestamp(
        row.updated_at ? String(row.updated_at) : null,
        row.downloaded_at ? String(row.downloaded_at) : null,
        row.created_at ? String(row.created_at) : null,
      ),
    });
  }

  const trackerRows = [...trackerRowsByPath.values()];

  const now = Date.now();
  const recentUploadCutoff = now - 14 * 24 * 60 * 60 * 1000;
  const updatedCutoff = now - 24 * 60 * 60 * 1000;
  const totalFiles = trackerRows.length;
  let recentUploads = 0;
  let updatedRecently = 0;
  let staleFiles = 0;
  let lastUpdatedAt: string | null = null;

  for (const row of trackerRows) {
    const createdAtMs = toTimeMs(row.createdAt);
    if (createdAtMs !== null && createdAtMs >= recentUploadCutoff) recentUploads += 1;

    const freshnessMs = toTimeMs(row.freshnessSource);
    if (freshnessMs !== null && freshnessMs >= updatedCutoff) updatedRecently += 1;
    else staleFiles += 1;

    lastUpdatedAt = chooseLatestTimestamp(lastUpdatedAt, row.freshnessSource);
  }

  const errorCount = ((errorRuns ?? []) as Array<Record<string, unknown>>).reduce(
    (sum, row) => sum + Number(row.error_count ?? (row.status === 'error' ? 1 : 0)),
    0,
  );
  return {
    totalFiles,
    recentUploads,
    updatedRecently,
    staleFiles,
    errorCount,
    lastUpdatedAt,
    lastCheckAt: lastRun?.created_at ? String(lastRun.created_at) : null,
    lastCheckStatus: lastRun?.status ? (String(lastRun.status) as 'ok' | 'warning' | 'error') : null,
    lastCheckMessage: lastRun?.message ? String(lastRun.message) : null,
  } satisfies ScpCacheTracker;
}

export async function runScpCacheFreshnessCheck(trigger: 'login_auto' | 'manual_check' | 'upload', options?: { force?: boolean; message?: string | null; errorCount?: number }): Promise<ScpCacheTracker> {
  const force = Boolean(options?.force);
  if (trigger === 'login_auto' && !force) {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const { data: existing, error } = await getSupabase()
        .from('scp_cache_refresh_runs')
        .select('id')
        .eq('trigger', 'login_auto')
        .gte('created_at', startOfDay.toISOString())
        .limit(1)
        .maybeSingle();
      if (!error && existing) return calculateScpCacheTrackerSummary();
    } catch {
      // ignore missing/older refresh-run schema and continue with a direct summary
    }
  }

  const summary = await calculateScpCacheTrackerSummary();
  const status: 'ok' | 'warning' | 'error' = (options?.errorCount ?? 0) > 0
    ? 'error'
    : summary.staleFiles > 0
      ? 'warning'
      : 'ok';
  const message = options?.message ?? (summary.staleFiles > 0
    ? `${summary.staleFiles} CSV cache file${summary.staleFiles === 1 ? '' : 's'} look stale (older than 24 hours). Manual SCP download/upload is still required for refreshes.`
    : summary.totalFiles > 0
      ? 'All tracked CSV cache files look fresh within the last 24 hours.'
      : 'No SCP CSV cache files have been uploaded yet.');

  try {
    await createScpCacheRefreshRun({
      trigger,
      status,
      totalFiles: summary.totalFiles,
      recentUploads: summary.recentUploads,
      updatedRecently: summary.updatedRecently,
      staleFiles: summary.staleFiles,
      errorCount: options?.errorCount ?? 0,
      lastUpdatedAt: summary.lastUpdatedAt,
      message,
    });
  } catch {
    // older deployments may not have the refresh-run table yet; the summary still remains useful
  }

  return {
    ...summary,
    lastCheckAt: new Date().toISOString(),
    lastCheckStatus: status,
    lastCheckMessage: message,
    errorCount: summary.errorCount + (options?.errorCount ?? 0),
  };
}

export async function findScpCacheMatches(hints: string[], limit = 3): Promise<ScpCacheEntry[]> {
  const cleanedHints = hints.map((value) => value.trim()).filter(Boolean);
  if (cleanedHints.length === 0) return [];

  const { data, error } = await getSupabase()
    .from('scp_set_cache_index')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map(mapScpCacheEntry)
    .map((entry) => ({ entry, score: scoreScpCacheEntry(entry, cleanedHints) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (b.entry.updatedAt ?? '').localeCompare(a.entry.updatedAt ?? ''))
    .slice(0, limit)
    .map((row) => row.entry);
}

export async function upsertScpCacheCsv(consoleName: string, csvText: string, sourceConsoleUrl?: string | null): Promise<string> {
  const cacheKey = `${slugify(consoleName)}.csv`;
  const storagePath = `sets/${cacheKey}`;
  const { error: uploadError } = await getSupabase().storage.from('scp-csv-cache').upload(storagePath, csvText, {
    upsert: true,
    contentType: 'text/csv; charset=utf-8',
  });
  if (uploadError) throw uploadError;

  const { error: indexError } = await getSupabase().from('scp_set_cache_index').upsert({
    cache_key: cacheKey,
    console_name: consoleName,
    source_console_url: sourceConsoleUrl ?? null,
    storage_path: storagePath,
    downloaded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (indexError) throw indexError;
  return storagePath;
}


async function getReviewLearningSnapshot(): Promise<ReviewLearningSnapshot> {
  try {
    const { data, error } = await getSupabase()
      .from('review_resolution_events')
      .select('selected_is_ai_top1, selected_in_ai_top3, selected_profitable, review_reason')
      .order('created_at', { ascending: false })
      .limit(250);
    if (error) throw error;

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const totalResolved = rows.length;
    const top1Chosen = rows.filter((row) => Boolean(row.selected_is_ai_top1)).length;
    const top3Chosen = rows.filter((row) => Boolean(row.selected_in_ai_top3)).length;
    const profitableSelections = rows.filter((row) => Boolean(row.selected_profitable)).length;
    const notProfitableSelections = totalResolved - profitableSelections;
    const reasonCounts = new Map<string, number>();

    for (const row of rows) {
      const reason = row.review_reason ? String(row.review_reason).trim() : '';
      if (!reason) continue;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }

    return {
      totalResolved,
      top1Chosen,
      top3Chosen,
      top1RatePct: totalResolved > 0 ? Math.round((top1Chosen / totalResolved) * 100) : null,
      top3RatePct: totalResolved > 0 ? Math.round((top3Chosen / totalResolved) * 100) : null,
      profitableSelections,
      notProfitableSelections,
      recentReasons: [...reasonCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count })),
    } satisfies ReviewLearningSnapshot;
  } catch {
    return {
      totalResolved: 0,
      top1Chosen: 0,
      top3Chosen: 0,
      top1RatePct: null,
      top3RatePct: null,
      profitableSelections: 0,
      notProfitableSelections: 0,
      recentReasons: [],
    } satisfies ReviewLearningSnapshot;
  }
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  let scpCaches: ScpCacheEntry[] = [];
  let scpCacheTracker: ScpCacheTracker = {
    totalFiles: 0,
    recentUploads: 0,
    updatedRecently: 0,
    staleFiles: 0,
    errorCount: 0,
    lastUpdatedAt: null,
    lastCheckAt: null,
    lastCheckStatus: null,
    lastCheckMessage: null,
  };

  try {
    await runScpCacheFreshnessCheck('login_auto');
  } catch {
    // Cache freshness issues should not block the live dashboard or worker loop.
  }

  try {
    scpCaches = await listScpCaches();
  } catch {
    // Fall back to an empty cache library so scans can still run.
  }

  try {
    scpCacheTracker = await calculateScpCacheTrackerSummary();
  } catch {
    // Fall back to the default tracker snapshot so scans can still run.
  }

  const activeScan = await getActiveScan();
  const latestScan = activeScan ?? (await getLatestScan());
  const scanId = latestScan?.id;

  let visibleResults: ScanResultRow[] = [];
  let needsReviewResults: ScanResultRow[] = [];
  let reviewOptionsByResultId: Record<string, ReviewOption[]> = {};
  let diagnostics: DashboardSnapshot['diagnostics'] = [];
  let diagnosticsSummary: DashboardSnapshot['diagnosticsSummary'] = {
    topRejectionReasons: [],
    stageTimings: [],
  };

  if (scanId && latestScan) {
    const [
      { data: resultRows, error: resultError },
      { data: eventRows, error: eventError },
      { data: candidateRows, error: candidateError },
    ] = await Promise.all([
      getSupabase().from('scan_results').select('*').eq('scan_id', scanId).is('disposition', null).order('created_at', { ascending: false }),
      getSupabase().from('scan_stage_events').select('*').eq('scan_id', scanId).order('created_at', { ascending: true }).limit(250),
      getSupabase().from('scan_candidates').select('stage,rejection_reason,created_at').eq('scan_id', scanId).order('created_at', { ascending: false }).limit(500),
    ]);

    if (resultError) throw resultError;
    if (eventError) throw eventError;
    if (candidateError) throw candidateError;

    const mapped = ((resultRows ?? []) as Array<Record<string, unknown>>).map(mapResult);
    const surfacedReviewDealIds = new Set(
      mapped
        .filter((row) => row.needsReview && (row.estimatedProfit ?? Number.NEGATIVE_INFINITY) > 0)
        .sort((a, b) => (b.estimatedProfit ?? Number.NEGATIVE_INFINITY) - (a.estimatedProfit ?? Number.NEGATIVE_INFINITY) || (b.aiConfidence ?? 0) - (a.aiConfidence ?? 0) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 25)
        .map((row) => row.id),
    );

    visibleResults = mapped
      .filter((row) => !row.needsReview || surfacedReviewDealIds.has(row.id))
      .sort((a, b) => {
        const left = (a.estimatedProfit ?? Number.NEGATIVE_INFINITY);
        const right = (b.estimatedProfit ?? Number.NEGATIVE_INFINITY);
        if (left !== right) return right - left;
        const confA = a.aiConfidence ?? 0;
        const confB = b.aiConfidence ?? 0;
        if (confA !== confB) return confB - confA;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, 50);

    needsReviewResults = mapped
      .filter((row) => row.needsReview && !surfacedReviewDealIds.has(row.id) && (row.estimatedProfit ?? Number.NEGATIVE_INFINITY) > 0)
      .sort((a, b) => (b.estimatedProfit ?? Number.NEGATIVE_INFINITY) - (a.estimatedProfit ?? Number.NEGATIVE_INFINITY) || (b.aiConfidence ?? 0) - (a.aiConfidence ?? 0) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);

    const reviewOptionResultIds = Array.from(new Set(
      [...visibleResults, ...needsReviewResults]
        .filter((row) => row.needsReview)
        .map((row) => row.id),
    ));

    if (reviewOptionResultIds.length > 0) {
      const { data: options, error: optionsError } = await getSupabase()
        .from('scan_review_options')
        .select('*')
        .in('result_id', reviewOptionResultIds)
        .order('rank', { ascending: true });
      if (optionsError) throw optionsError;
      reviewOptionsByResultId = ((options ?? []) as Array<Record<string, unknown>>).reduce<Record<string, ReviewOption[]>>((acc, row) => {
        const option = mapReviewOption(row);
        acc[option.resultId] ||= [];
        acc[option.resultId].push(option);
        return acc;
      }, {});

      const adjustedVisibleResults = visibleResults
        .map((row) => row.needsReview ? applyDisplayedReviewOption(row, reviewOptionsByResultId[row.id] ?? []) : row);
      const demotedVisibleReviewRows = adjustedVisibleResults.filter((row) => row.needsReview && !shouldSurfaceReviewRowAsDeal(row, reviewOptionsByResultId[row.id] ?? []));
      visibleResults = adjustedVisibleResults.filter((row) => !row.needsReview || shouldSurfaceReviewRowAsDeal(row, reviewOptionsByResultId[row.id] ?? []));

      needsReviewResults = [...needsReviewResults.map((row) => applyDisplayedReviewOption(row, reviewOptionsByResultId[row.id] ?? [])), ...demotedVisibleReviewRows]
        .filter((row, index, arr) => arr.findIndex((candidate) => candidate.id === row.id) === index)
        .sort((a, b) => (b.estimatedProfit ?? Number.NEGATIVE_INFINITY) - (a.estimatedProfit ?? Number.NEGATIVE_INFINITY) || (b.aiConfidence ?? 0) - (a.aiConfidence ?? 0) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20);
    }

    const mappedEvents = ((eventRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      level: row.level as 'info' | 'warning' | 'error',
      stage: String(row.stage),
      message: String(row.message),
      details: row.details ? String(row.details) : null,
      createdAt: String(row.created_at),
    }));

    diagnostics = [...mappedEvents].reverse();
    diagnosticsSummary = {
      topRejectionReasons: buildTopRejectionReasons((candidateRows ?? []) as Array<Record<string, unknown>>),
      stageTimings: buildStageTimings(latestScan, mappedEvents),
    };

  }

  const [usage, reviewLearning] = await Promise.all([getUsageSnapshot(), getReviewLearningSnapshot()]);
  return {
    activeScan,
    latestScan,
    visibleResults,
    needsReviewResults,
    reviewOptionsByResultId,
    diagnostics,
    diagnosticsSummary,
    scpCaches,
    scpCacheTracker,
    reviewLearning,
    usage,
  };
}

export async function incrementUsage(provider: ProviderName, count = 1, costUsd = 0): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await getSupabase().from('api_usage_daily').select('*').eq('usage_date', today).maybeSingle();
  if (error) throw error;
  const current = (data as UsageRow | null) ?? emptyUsageRow(today);
  const patch = { ...current };
  if (provider === 'ebay') patch.ebay_calls += count;
  if (provider === 'scp') patch.scp_calls += count;
  if (provider === 'openai') {
    patch.openai_calls += count;
    patch.openai_cost_usd += costUsd;
  }
  if (provider === 'ximilar') patch.ximilar_calls += count;
  const { error: upsertError } = await getSupabase().from('api_usage_daily').upsert(patch);
  if (upsertError) throw upsertError;
}

export async function getUsageSnapshot(): Promise<DashboardSnapshot['usage']> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await getSupabase().from('api_usage_daily').select('*').eq('usage_date', today).maybeSingle();
  if (error) throw error;
  const usageRow = (data as UsageRow | null) ?? emptyUsageRow(today);
  const exactCost = await getOpenAiTodayCostUsd();
  return {
    openAiCostTodayUsd: exactCost ?? usageRow.openai_cost_usd ?? null,
    ebayCallsToday: usageRow.ebay_calls ?? 0,
    scpCallsToday: usageRow.scp_calls ?? 0,
    openAiCallsToday: usageRow.openai_calls ?? 0,
    ximilarCallsToday: usageRow.ximilar_calls ?? 0,
    providerLimits: buildProviderLimitStatuses(usageRow),
  };
}


export async function getExceededUsageLimits(): Promise<ProviderLimitStatus[]> {
  const usage = await getUsageSnapshot();
  return usage.providerLimits.filter((row) => row.isExceeded);
}

function mapScan(row: Record<string, unknown>): ScanSummary {
  return {
    id: String(row.id),
    status: row.status as ScanStatus,
    filters: safeJsonParse<SearchForm>(row.filters, { sport: 'Football', conditionMode: 'raw', listingMode: 'buy_now' }),
    startedAt: String(row.created_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    metrics: safeJsonParse<ScanMetrics>(row.metrics, defaultMetrics()),
    stageMessage: row.stage_message ? String(row.stage_message) : null,
    warningCount: Number(row.warning_count ?? 0),
    errorCount: Number(row.error_count ?? 0),
  };
}

function mapResult(row: Record<string, unknown>): ScanResultRow {
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    ebayItemId: String(row.ebay_item_id),
    imageUrl: row.image_url ? String(row.image_url) : null,
    ebayTitle: String(row.ebay_title),
    ebayUrl: String(row.ebay_url),
    purchasePrice: Number(row.purchase_price ?? 0),
    shippingPrice: Number(row.shipping_price ?? 0),
    totalPurchasePrice: Number(row.total_purchase_price ?? 0),
    scpProductId: row.scp_product_id ? String(row.scp_product_id) : null,
    scpProductName: row.scp_product_name ? String(row.scp_product_name) : null,
    scpLink: row.scp_link ? String(row.scp_link) : null,
    scpUngradedSell: row.scp_ungraded_sell === null ? null : Number(row.scp_ungraded_sell),
    scpGrade9: row.scp_grade_9 === null ? null : Number(row.scp_grade_9),
    scpPsa10: row.scp_psa_10 === null ? null : Number(row.scp_psa_10),
    estimatedProfit: row.estimated_profit === null ? null : Number(row.estimated_profit),
    estimatedMarginPct: row.estimated_margin_pct === null ? null : Number(row.estimated_margin_pct),
    aiConfidence: row.ai_confidence === null ? null : Number(row.ai_confidence),
    aiChosenProductId: row.ai_chosen_product_id ? String(row.ai_chosen_product_id) : null,
    aiTopThreeProductIds: safeJsonParse<string[]>(row.ai_top_three_product_ids, []).map(String).slice(0, 3),
    needsReview: Boolean(row.needs_review),
    auctionEndsAt: row.auction_ends_at ? String(row.auction_ends_at) : null,
    sellerUsername: row.seller_username ? String(row.seller_username) : null,
    sellerFeedbackPercentage: row.seller_feedback_percentage === null ? null : Number(row.seller_feedback_percentage),
    sellerFeedbackScore: row.seller_feedback_score === null ? null : Number(row.seller_feedback_score),
    listingQualityScore: row.listing_quality_score === null ? null : Number(row.listing_quality_score),
    createdAt: String(row.created_at),
    disposition: (row.disposition as Disposition | null) ?? null,
    reasoning: row.reasoning ? String(row.reasoning) : null,
    reviewReason: row.review_reason ? String(row.review_reason) : null,
  };
}

function mapReviewOption(row: Record<string, unknown>): ReviewOption {
  return {
    id: String(row.id),
    resultId: String(row.result_id),
    rank: Number(row.rank),
    scpProductId: String(row.scp_product_id),
    scpProductName: String(row.scp_product_name),
    scpLink: row.scp_link ? String(row.scp_link) : null,
    scpUngradedSell: row.scp_ungraded_sell === null ? null : Number(row.scp_ungraded_sell),
    scpGrade9: row.scp_grade_9 === null ? null : Number(row.scp_grade_9),
    scpPsa10: row.scp_psa_10 === null ? null : Number(row.scp_psa_10),
    confidence: row.confidence === null ? null : Number(row.confidence),
    candidateSource: row.candidate_source ? String(row.candidate_source) : null,
    matchScore: row.match_score === null ? null : Number(row.match_score),
    positiveSignals: safeJsonParse<string[]>(row.positive_signals, []).map(String).slice(0, 5),
    negativeSignals: safeJsonParse<string[]>(row.negative_signals, []).map(String).slice(0, 5),
    aiPreferred: Boolean(row.ai_preferred),
  };
}


function pickDisplayedReviewOption(options: ReviewOption[], totalPurchasePrice: number): ReviewOption | null {
  return [...options]
    .sort((a, b) => scoreDisplayedReviewOption(b, totalPurchasePrice) - scoreDisplayedReviewOption(a, totalPurchasePrice) || a.rank - b.rank)
    [0] ?? null;
}

function scoreDisplayedReviewOption(option: ReviewOption, totalPurchasePrice: number): number {
  const profit = option.scpUngradedSell !== null ? option.scpUngradedSell - totalPurchasePrice : Number.NEGATIVE_INFINITY;
  const hardMismatchPenalty = option.negativeSignals.filter((signal) => /mismatch/i.test(signal)).length * 10;
  return (
    (option.aiPreferred ? 18 : 0)
    + (option.matchScore ?? 0)
    + ((option.confidence ?? 0) / 6)
    + Math.max(-20, Math.min(16, profit))
    - hardMismatchPenalty
    - ((option.rank - 1) * 2)
  );
}

function applyDisplayedReviewOption(row: ScanResultRow, options: ReviewOption[]): ScanResultRow {
  const displayOption = pickDisplayedReviewOption(options, row.totalPurchasePrice);
  if (!displayOption) return row;
  const estimatedProfit = displayOption.scpUngradedSell !== null ? displayOption.scpUngradedSell - row.totalPurchasePrice : null;
  const estimatedMarginPct = displayOption.scpUngradedSell !== null && row.totalPurchasePrice > 0
    ? ((displayOption.scpUngradedSell - row.totalPurchasePrice) / row.totalPurchasePrice) * 100
    : null;
  return {
    ...row,
    scpProductId: displayOption.scpProductId,
    scpProductName: displayOption.scpProductName,
    scpLink: displayOption.scpLink,
    scpUngradedSell: displayOption.scpUngradedSell,
    scpGrade9: displayOption.scpGrade9,
    scpPsa10: displayOption.scpPsa10,
    estimatedProfit,
    estimatedMarginPct,
  };
}

function shouldSurfaceReviewRowAsDeal(row: ScanResultRow, options: ReviewOption[]): boolean {
  const displayOption = pickDisplayedReviewOption(options, row.totalPurchasePrice);
  if (!displayOption) return false;
  const profit = displayOption.scpUngradedSell !== null ? displayOption.scpUngradedSell - row.totalPurchasePrice : Number.NEGATIVE_INFINITY;
  const hardMismatches = displayOption.negativeSignals.filter((signal) => /mismatch/i.test(signal)).length;
  const matchScore = displayOption.matchScore ?? 0;
  const confidence = displayOption.confidence ?? row.aiConfidence ?? 0;
  return profit > 0 && ((displayOption.aiPreferred && matchScore >= 18 && hardMismatches <= 1) || (matchScore >= 28 && confidence >= 60 && hardMismatches === 0));
}



function mapScpCacheEntry(row: Record<string, unknown>): ScpCacheEntry {
  return {
    id: String(row.id),
    cacheKey: String(row.cache_key ?? ''),
    consoleName: String(row.console_name ?? ''),
    sourceConsoleUrl: row.source_console_url ? String(row.source_console_url) : null,
    storagePath: row.storage_path ? String(row.storage_path) : null,
    downloadedAt: row.downloaded_at ? String(row.downloaded_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
    createdAt: row.created_at ? String(row.created_at) : null,
  };
}

function buildTopRejectionReasons(rows: Array<Record<string, unknown>>): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = row.rejection_reason ? String(row.rejection_reason).trim() : '';
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([reason, count]) => ({ reason, count }));
}

function buildStageTimings(
  scan: ScanSummary,
  events: DashboardSnapshot['diagnostics'],
): Array<{ stage: string; seconds: number; eventCount: number }> {
  if (events.length === 0) return [];

  const stageStarts: Array<{ stage: string; startedAt: string }> = [];
  const eventCounts = new Map<string, number>();

  for (const event of events) {
    eventCounts.set(event.stage, (eventCounts.get(event.stage) ?? 0) + 1);
    if (!stageStarts.some((item) => item.stage === event.stage)) {
      stageStarts.push({ stage: event.stage, startedAt: event.createdAt });
    }
  }

  const endBoundary = scan.finishedAt ?? new Date().toISOString();
  return stageStarts.map((item, index) => {
    const startedAt = new Date(item.startedAt).getTime();
    const nextStart = stageStarts[index + 1] ? new Date(stageStarts[index + 1].startedAt).getTime() : new Date(endBoundary).getTime();
    const seconds = Math.max(1, Math.round((nextStart - startedAt) / 1000));
    return {
      stage: item.stage,
      seconds,
      eventCount: eventCounts.get(item.stage) ?? 0,
    };
  });
}

function defaultMetrics(): ScanMetrics {
  return {
    candidatesFetched: 0,
    candidatesFilteredOut: 0,
    candidatesEvaluated: 0,
    dealsFound: 0,
    needsReview: 0,
    ebayCalls: 0,
    scpCalls: 0,
    openaiCalls: 0,
    ximilarCalls: 0,
  };
}
