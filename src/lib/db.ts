import { createSupabaseAdminClient } from '@/lib/supabase';
import { getOpenAiTodayCostUsd } from '@/lib/openai-admin';
import { compactWhitespace, normalizeSellerUsername, normalizeTitleFingerprint, safeJsonParse, slugify, summarizeSellerOutcomeMemory, tokenizeLoose } from '@/lib/utils';
import type {
  DashboardSnapshot,
  Disposition,
  ProviderLimitStatus,
  ProviderName,
  ReviewOption,
  ScanMetrics,
  ScanResultRow,
  ScanSummary,
  ScpCacheEntry,
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
  return value.match(/(19|20)\d{2}/)?.[0] ?? null;
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

export async function updateCandidate(candidateId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabase().from('scan_candidates').update(patch).eq('id', candidateId);
  if (error) throw error;
}

export async function insertResult(payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await getSupabase().from('scan_results').insert(payload).select('id').single();
  if (error) throw error;
  return String(data.id);
}

export async function insertReviewOptions(resultId: string, options: Array<Record<string, unknown>>): Promise<void> {
  if (options.length === 0) return;
  const { error } = await getSupabase().from('scan_review_options').insert(options.map((option) => ({ ...option, result_id: resultId })));
  if (error) throw error;
}

export async function setDisposition(resultIds: string[], disposition: Disposition): Promise<void> {
  const { error } = await getSupabase().from('scan_results').update({ disposition }).in('id', resultIds);
  if (error) throw error;
  const rows = resultIds.map((id) => ({ scan_result_id: id, disposition }));
  const { error: dispositionError } = await getSupabase().from('result_dispositions').insert(rows);
  if (dispositionError) throw dispositionError;
}

export async function resolveReview(resultId: string, optionId: string): Promise<void> {
  const supabase = getSupabase();
  const [{ data: option, error: optionError }, { data: resultRow, error: resultError }] = await Promise.all([
    supabase.from('scan_review_options').select('*').eq('id', optionId).single(),
    supabase.from('scan_results').select('ebay_title').eq('id', resultId).single(),
  ]);
  if (optionError) throw optionError;
  if (resultError) throw resultError;

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
    })
    .eq('id', resultId);
  if (updateError) throw updateError;

  if (resultRow?.ebay_title) {
    await saveManualMatchOverride(String(resultRow.ebay_title), String(option.scp_product_id), String(option.scp_product_name));
  }
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
    else if (disposition === 'suppress_90_days') suppress += 1;
    else if (disposition === 'bad_logic') badLogic += 1;
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

export async function listScpCaches(limit = 12): Promise<ScpCacheEntry[]> {
  const { data, error } = await getSupabase()
    .from('scp_set_cache_index')
    .select('id,cache_key,console_name,source_console_url,storage_path,downloaded_at,updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapScpCacheEntry);
}

export async function findScpCacheMatches(hints: string[], limit = 3): Promise<ScpCacheEntry[]> {
  const cleanedHints = hints.map((value) => value.trim()).filter(Boolean);
  if (cleanedHints.length === 0) return [];

  const { data, error } = await getSupabase()
    .from('scp_set_cache_index')
    .select('id,cache_key,console_name,source_console_url,storage_path,downloaded_at,updated_at')
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

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
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
  const scpCaches = await listScpCaches();

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
    visibleResults = mapped.filter((row) => !row.needsReview);
    needsReviewResults = mapped.filter((row) => row.needsReview);

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

    if (needsReviewResults.length > 0) {
      const { data: options, error: optionsError } = await getSupabase()
        .from('scan_review_options')
        .select('*')
        .in('result_id', needsReviewResults.map((row) => row.id))
        .order('rank', { ascending: true });
      if (optionsError) throw optionsError;
      reviewOptionsByResultId = ((options ?? []) as Array<Record<string, unknown>>).reduce<Record<string, ReviewOption[]>>((acc, row) => {
        const option = mapReviewOption(row);
        acc[option.resultId] ||= [];
        acc[option.resultId].push(option);
        return acc;
      }, {});
    }
  }

  const usage = await getUsageSnapshot();
  return {
    activeScan,
    latestScan,
    visibleResults,
    needsReviewResults,
    reviewOptionsByResultId,
    diagnostics,
    diagnosticsSummary,
    scpCaches,
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
    needsReview: Boolean(row.needs_review),
    auctionEndsAt: row.auction_ends_at ? String(row.auction_ends_at) : null,
    sellerUsername: row.seller_username ? String(row.seller_username) : null,
    sellerFeedbackPercentage: row.seller_feedback_percentage === null ? null : Number(row.seller_feedback_percentage),
    sellerFeedbackScore: row.seller_feedback_score === null ? null : Number(row.seller_feedback_score),
    listingQualityScore: row.listing_quality_score === null ? null : Number(row.listing_quality_score),
    createdAt: String(row.created_at),
    disposition: (row.disposition as Disposition | null) ?? null,
    reasoning: row.reasoning ? String(row.reasoning) : null,
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
  };
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
