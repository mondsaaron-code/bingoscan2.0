import { searchEbayListings, type EbayListing } from '@/lib/ebay';
import {
  addScanEvent,
  appendMetrics,
  getManualMatchOverride,
  getScanById,
  incrementUsage,
  insertCandidate,
  insertResult,
  insertReviewOptions,
  markScanStatus,
  updateCandidate,
  upsertDedupeItem,
} from '@/lib/db';
import { shouldRejectTitle } from '@/lib/filters';
import { verifyCardMatchWithOpenAI, type MatchDecision } from '@/lib/openai';
import {
  getSportsCardsProProductById,
  hydrateSportsCardsProCandidates,
  searchSportsCardsProCandidates,
  type ScpCandidate,
} from '@/lib/scp';
import { identifyWithXimilar, type XimilarCardHints } from '@/lib/ximilar';
import type { SearchForm, ScanSummary } from '@/types/app';
import { normalizeLooseText } from '@/lib/utils';

const TARGET_RESULTS = 10;
const FETCH_PAGE_SIZE = 40;
const MAX_CANDIDATES_PER_TICK = 2;
const SCP_AUTO_MATCH_CONFIDENCE = 90;

export async function runScanWorkerTick(scanId: string): Promise<ScanSummary> {
  const scan = await getScanById(scanId);
  if (!scan) {
    throw new Error(`Scan ${scanId} not found`);
  }

  if (scan.status === 'cancelled' || scan.status === 'completed' || scan.status === 'failed') {
    return scan;
  }

  const currentResults = scan.metrics.dealsFound + scan.metrics.needsReview;
  if (currentResults >= TARGET_RESULTS) {
    await markScanStatus(scanId, 'completed', 'Reached target result count');
    await addScanEvent(scanId, 'info', 'publishing_results', 'Scan completed');
    return (await getScanById(scanId))!;
  }

  await markScanStatus(scanId, 'fetching_ebay', 'Fetching eBay listings');
  const offset = scan.metrics.candidatesFetched;
  const listings = await searchEbayListings(scan.filters, offset, FETCH_PAGE_SIZE);
  await incrementUsage('ebay', 1);
  await appendMetrics(scanId, { ebayCalls: 1, candidatesFetched: listings.length });
  await addScanEvent(scanId, 'info', 'fetching_ebay', `Fetched ${listings.length} eBay candidates`, `Offset ${offset}`);

  if (listings.length === 0) {
    await markScanStatus(scanId, 'completed', 'No more eBay listings returned');
    return (await getScanById(scanId))!;
  }

  let processed = 0;
  for (const listing of listings) {
    if (processed >= MAX_CANDIDATES_PER_TICK) break;

    const dedupeAllowed = await upsertDedupeItem(listing.itemId);
    if (!dedupeAllowed) {
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'filtering', `Skipped duplicate eBay item ${listing.itemId}`);
      continue;
    }

    const rejectionReason = shouldRejectTitle(listing.title, scan.filters);
    const candidateId = await insertCandidate(scanId, {
      ebay_item_id: listing.itemId,
      ebay_title: listing.title,
      ebay_url: listing.itemWebUrl,
      image_url: listing.imageUrl,
      purchase_price: listing.price,
      shipping_price: listing.shipping,
      total_purchase_price: listing.total,
      auction_ends_at: listing.auctionEndsAt,
      stage: 'fetched',
    });

    if (rejectionReason) {
      await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: rejectionReason });
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'filtering', rejectionReason, listing.title);
      processed += 1;
      continue;
    }

    try {
      await evaluateListing(scanId, candidateId, listing, scan.filters);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown candidate evaluation error';
      await updateCandidate(candidateId, { stage: 'error', rejection_reason: message });
      await addScanEvent(scanId, 'error', 'candidate_evaluation', message, listing.title);
    }
    processed += 1;

    const refreshed = await getScanById(scanId);
    if (!refreshed || refreshed.status === 'cancelled') {
      break;
    }
    if (refreshed.metrics.dealsFound + refreshed.metrics.needsReview >= TARGET_RESULTS) {
      await markScanStatus(scanId, 'completed', 'Reached target result count');
      break;
    }
  }

  return (await getScanById(scanId))!;
}

async function evaluateListing(scanId: string, candidateId: string, listing: EbayListing, filters: SearchForm): Promise<void> {
  await markScanStatus(scanId, 'matching_scp', 'Matching SportsCardsPro candidates');
  await updateCandidate(candidateId, { stage: 'matching_scp' });
  await appendMetrics(scanId, { candidatesEvaluated: 1 });

  const ximilarHints = await getXimilarHints(scanId, listing);

  const scpQuery = buildScpQuery(listing, filters, ximilarHints);
  const basicCandidates = await searchSportsCardsProCandidates(scpQuery);
  await incrementUsage('scp', 1);
  await appendMetrics(scanId, { scpCalls: 1 });

  if (basicCandidates.length === 0) {
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: 'No SportsCardsPro candidates found' });
    await addScanEvent(scanId, 'warning', 'matching_scp', 'No SCP candidates found', listing.title);
    return;
  }

  const rankedBaseCandidates = rankScpCandidatesLocally(listing.title, basicCandidates, ximilarHints).slice(0, 6);
  const hydration = await hydrateSportsCardsProCandidates(rankedBaseCandidates, 5);
  if (hydration.apiCalls > 0) {
    await incrementUsage('scp', hydration.apiCalls);
    await appendMetrics(scanId, { scpCalls: hydration.apiCalls });
  }

  let rankedCandidates = rankScpCandidatesLocally(listing.title, hydration.candidates, ximilarHints).slice(0, 5);

  const manualOverride = await getManualMatchOverride(listing.title);
  if (manualOverride) {
    let overrideCandidate = rankedCandidates.find((candidate) => candidate.productId === manualOverride.scpProductId) ?? null;
    let extraCalls = 0;
    if (!overrideCandidate) {
      overrideCandidate = await getSportsCardsProProductById(manualOverride.scpProductId);
      extraCalls = 1;
    }

    if (extraCalls > 0) {
      await incrementUsage('scp', extraCalls);
      await appendMetrics(scanId, { scpCalls: extraCalls });
    }

    if (overrideCandidate) {
      rankedCandidates = [overrideCandidate, ...rankedCandidates.filter((candidate) => candidate.productId !== overrideCandidate.productId)].slice(0, 5);
      const overrideDecision: MatchDecision = {
        exactMatch: true,
        confidence: 99,
        reasoning: `Applied manual override for matching fingerprint: ${manualOverride.scpProductName}`,
        chosenProductId: overrideCandidate.productId,
        topThreeProductIds: rankedCandidates.slice(0, 3).map((candidate) => candidate.productId),
        extractedAttributes: {},
      };
      await finalizeDecision(scanId, candidateId, listing, filters, rankedCandidates, overrideDecision, true);
      return;
    }
  }

  await markScanStatus(scanId, 'ai_verifying', 'Verifying exact match with OpenAI');
  const decision = await verifyCardMatchWithOpenAI(listing, rankedCandidates, ximilarHints);
  await incrementUsage('openai', 1);
  await appendMetrics(scanId, { openaiCalls: 1 });

  await finalizeDecision(scanId, candidateId, listing, filters, rankedCandidates, decision, false);
}

async function finalizeDecision(
  scanId: string,
  candidateId: string,
  listing: EbayListing,
  filters: SearchForm,
  rankedCandidates: ScpCandidate[],
  decision: Pick<MatchDecision, 'exactMatch' | 'confidence' | 'reasoning' | 'chosenProductId' | 'topThreeProductIds'>,
  cameFromOverride: boolean,
): Promise<void> {
  const chosen = rankedCandidates.find((candidate) => candidate.productId === decision.chosenProductId) ?? rankedCandidates[0] ?? null;

  if (!decision.exactMatch || decision.confidence < SCP_AUTO_MATCH_CONFIDENCE || !chosen) {
    const topThree = selectTopThreeCandidates(rankedCandidates, decision.topThreeProductIds);
    const resultId = await insertResultPayload(scanId, listing, null, decision, true);
    await insertReviewOptions(
      resultId,
      topThree.map((candidate, index) => reviewOptionPayload(candidate, index + 1, decision.confidence)),
    );
    await appendMetrics(scanId, { needsReview: 1 });
    await updateCandidate(candidateId, { stage: 'needs_review', ai_confidence: decision.confidence, ai_reasoning: decision.reasoning });
    await addScanEvent(scanId, 'warning', 'ai_verifying', 'Sent listing to Needs Review', `${listing.title}\n${decision.reasoning}`);
    return;
  }

  if (chosen.ungradedSell === null) {
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: 'Matched SCP card has no ungraded sell price' });
    await addScanEvent(scanId, 'warning', 'matching_scp', 'Matched SCP card had no ungraded sell price', chosen.productName);
    return;
  }

  const estimatedProfit = chosen.ungradedSell - listing.total;
  const estimatedMarginPct = listing.total > 0 ? (estimatedProfit / listing.total) * 100 : null;

  if (filters.minProfit && estimatedProfit < filters.minProfit) {
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: `Profit below threshold: ${estimatedProfit.toFixed(2)}` });
    return;
  }
  if (filters.minMarginPct && (estimatedMarginPct ?? 0) < filters.minMarginPct) {
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: `Margin below threshold: ${(estimatedMarginPct ?? 0).toFixed(2)}%` });
    return;
  }

  await insertResultPayload(scanId, listing, chosen, decision, false, estimatedProfit, estimatedMarginPct);
  await appendMetrics(scanId, { dealsFound: 1 });
  await updateCandidate(candidateId, {
    stage: 'accepted',
    ai_confidence: decision.confidence,
    ai_reasoning: decision.reasoning,
    scp_product_id: chosen.productId,
  });
  await addScanEvent(
    scanId,
    'info',
    cameFromOverride ? 'manual_override' : 'publishing_results',
    'Added deal result',
    `${listing.title}\nConfidence ${decision.confidence}`,
  );
}

async function getXimilarHints(scanId: string, listing: EbayListing): Promise<XimilarCardHints | null> {
  if (!shouldUseXimilar(listing.title, listing.imageUrl)) return null;
  try {
    const hints = await identifyWithXimilar([listing.imageUrl!].filter(Boolean));
    if (hints) {
      await incrementUsage('ximilar', 1);
      await appendMetrics(scanId, { ximilarCalls: 1 });
      await addScanEvent(scanId, 'info', 'matching_scp', 'Used Ximilar assist', hints.titleHints.slice(0, 5).join(' | '));
    }
    return hints;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ximilar identification failed';
    await addScanEvent(scanId, 'warning', 'matching_scp', 'Ximilar assist failed; continuing without it', message);
    return null;
  }
}

async function insertResultPayload(
  scanId: string,
  listing: EbayListing,
  candidate: ScpCandidate | null,
  decision: { confidence: number; reasoning: string },
  needsReview: boolean,
  estimatedProfit?: number | null,
  estimatedMarginPct?: number | null,
): Promise<string> {
  return insertResult({
    scan_id: scanId,
    ebay_item_id: listing.itemId,
    ebay_title: listing.title,
    ebay_url: listing.itemWebUrl,
    image_url: listing.imageUrl,
    purchase_price: listing.price,
    shipping_price: listing.shipping,
    total_purchase_price: listing.total,
    auction_ends_at: listing.auctionEndsAt,
    scp_product_id: candidate?.productId ?? null,
    scp_product_name: candidate?.productName ?? null,
    scp_link: candidate?.productUrl ?? null,
    scp_ungraded_sell: candidate?.ungradedSell ?? null,
    scp_grade_9: candidate?.grade9 ?? null,
    scp_psa_10: candidate?.psa10 ?? null,
    estimated_profit: estimatedProfit ?? null,
    estimated_margin_pct: estimatedMarginPct ?? null,
    ai_confidence: decision.confidence,
    needs_review: needsReview,
    reasoning: decision.reasoning,
  });
}

function reviewOptionPayload(candidate: ScpCandidate, rank: number, confidence: number | null): Record<string, unknown> {
  return {
    rank,
    scp_product_id: candidate.productId,
    scp_product_name: candidate.productName,
    scp_link: candidate.productUrl,
    scp_ungraded_sell: candidate.ungradedSell,
    scp_grade_9: candidate.grade9,
    scp_psa_10: candidate.psa10,
    confidence,
  };
}

function shouldUseXimilar(title: string, imageUrl: string | null): boolean {
  if (!imageUrl) return false;
  const lower = title.toLowerCase();
  return !/#[a-z0-9]+/.test(lower) || lower.includes('prizm') || lower.includes('mosaic') || lower.includes('optic');
}

function buildScpQuery(listing: EbayListing, filters: SearchForm, hints: XimilarCardHints | null): string {
  const seeds = [
    listing.title,
    filters.sport,
    filters.brand,
    filters.variant,
    filters.insert,
    filters.cardNumber ? `#${filters.cardNumber}` : null,
    filters.playerName,
    filters.team,
    filters.startYear ? String(filters.startYear) : null,
    filters.endYear && filters.endYear !== filters.startYear ? String(filters.endYear) : null,
    ...(hints?.titleHints ?? []),
  ]
    .filter(Boolean)
    .join(' ');

  const tokens = normalizeLooseText(seeds)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .slice(0, 16);
  return tokens.join(' ');
}

function rankScpCandidatesLocally(title: string, candidates: ScpCandidate[], hints: XimilarCardHints | null): ScpCandidate[] {
  const lower = normalizeLooseText(title);
  const hintText = normalizeLooseText((hints?.titleHints ?? []).join(' '));
  return [...candidates].sort((a, b) => scoreCandidate(lower, hintText, b) - scoreCandidate(lower, hintText, a));
}

function scoreCandidate(title: string, hintText: string, candidate: ScpCandidate): number {
  const product = normalizeLooseText(candidate.productName);
  const consoleName = normalizeLooseText(candidate.consoleName ?? '');
  let score = 0;

  for (const token of product.split(/\s+/)) {
    if (token.length > 2 && title.includes(token)) score += 4;
    if (token.length > 2 && hintText.includes(token)) score += 2;
  }

  for (const token of consoleName.split(/\s+/)) {
    if (token.length > 3 && title.includes(token)) score += 2;
  }

  const numberMatch = product.match(/#([a-z0-9-]+)/i);
  if (numberMatch && title.includes(numberMatch[0].toLowerCase())) score += 14;
  if (/\[[^\]]+\]/.test(candidate.productName)) score += 3;
  if (candidate.ungradedSell !== null) score += 2;
  if (candidate.grade9 !== null || candidate.psa10 !== null) score += 1;
  return score;
}

function selectTopThreeCandidates(candidates: ScpCandidate[], preferredIds: string[]): ScpCandidate[] {
  const ordered: ScpCandidate[] = [];
  for (const id of preferredIds) {
    const found = candidates.find((candidate) => candidate.productId === id);
    if (found && !ordered.some((candidate) => candidate.productId === found.productId)) {
      ordered.push(found);
    }
  }
  for (const candidate of candidates) {
    if (!ordered.some((item) => item.productId === candidate.productId)) {
      ordered.push(candidate);
    }
    if (ordered.length >= 3) break;
  }
  return ordered.slice(0, 3);
}
