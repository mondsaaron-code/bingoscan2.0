import { createSupabaseAdminClient } from '@/lib/supabase';
import { safeJsonParse } from '@/lib/utils';
import { getOpenAiTodayCostUsd } from '@/lib/openai-admin';
import type {
  DashboardSnapshot,
  Disposition,
  ReviewOption,
  ScanMetrics,
  ScanResultRow,
  ScanSummary,
  SearchForm,
  ScanStatus,
} from '@/types/app';

function getSupabase() {
  return createSupabaseAdminClient();
}

const ACTIVE_SCAN_STATUSES: ScanStatus[] = ['queued', 'fetching_ebay', 'filtering', 'matching_scp', 'ai_verifying', 'publishing_results'];

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
    const countField = level === 'warning' ? 'warning_count' : 'error_count';
    const { data: scanRow, error: scanError } = await supabase
      .from('scans')
      .select('warning_count, error_count')
      .eq('id', scanId)
      .single();
    if (scanError) throw scanError;

    const patch: { warning_count: number; error_count: number } = {
      warning_count: Number(scanRow.warning_count ?? 0),
      error_count: Number(scanRow.error_count ?? 0),
    };
    if (countField === 'warning_count') patch.warning_count += 1;
    if (countField === 'error_count') patch.error_count += 1;

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
  const { data: option, error } = await getSupabase().from('scan_review_options').select('*').eq('id', optionId).single();
  if (error) throw error;
  const { error: updateError } = await getSupabase()
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
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const activeScan = await getActiveScan();
  const latestScan = activeScan ?? (await getLatestScan());
  const scanId = latestScan?.id;

  let visibleResults: ScanResultRow[] = [];
  let needsReviewResults: ScanResultRow[] = [];
  let reviewOptionsByResultId: Record<string, ReviewOption[]> = {};
  let diagnostics: DashboardSnapshot['diagnostics'] = [];

  if (scanId) {
    const [{ data: resultRows, error: resultError }, { data: eventRows, error: eventError }] = await Promise.all([
      getSupabase().from('scan_results').select('*').eq('scan_id', scanId).is('disposition', null).order('created_at', { ascending: false }),
      getSupabase().from('scan_stage_events').select('*').eq('scan_id', scanId).order('created_at', { ascending: false }).limit(100),
    ]);

    if (resultError) throw resultError;
    if (eventError) throw eventError;

    const mapped = ((resultRows ?? []) as Array<Record<string, unknown>>).map(mapResult);
    visibleResults = mapped.filter((row) => !row.needsReview);
    needsReviewResults = mapped.filter((row) => row.needsReview);
    diagnostics = ((eventRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      level: row.level as 'info' | 'warning' | 'error',
      stage: String(row.stage),
      message: String(row.message),
      details: row.details ? String(row.details) : null,
      createdAt: String(row.created_at),
    }));

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
    usage,
  };
}

export async function incrementUsage(provider: 'ebay' | 'scp' | 'openai' | 'ximilar', count = 1, costUsd = 0): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await getSupabase().from('api_usage_daily').select('*').eq('usage_date', today).maybeSingle();
  if (error) throw error;
  const current = data ?? {
    usage_date: today,
    ebay_calls: 0,
    scp_calls: 0,
    openai_calls: 0,
    ximilar_calls: 0,
    openai_cost_usd: 0,
  };
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

async function getUsageSnapshot(): Promise<DashboardSnapshot['usage']> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await getSupabase().from('api_usage_daily').select('*').eq('usage_date', today).maybeSingle();
  if (error) throw error;
  const exactCost = await getOpenAiTodayCostUsd();
  return {
    openAiCostTodayUsd: exactCost ?? data?.openai_cost_usd ?? null,
    ebayCallsToday: data?.ebay_calls ?? 0,
    scpCallsToday: data?.scp_calls ?? 0,
    openAiCallsToday: data?.openai_calls ?? 0,
    ximilarCallsToday: data?.ximilar_calls ?? 0,
  };
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
