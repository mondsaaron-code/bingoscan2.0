import { searchEbayListings, type EbayListing } from '@/lib/ebay';
import {
  addScanEvent,
  appendMetrics,
  getManualMatchOverride,
  getScanById,
  getScpCacheCsvText,
  incrementUsage,
  insertCandidate,
  insertResult,
  insertReviewOptions,
  markScanStatus,
  updateCandidate,
  upsertDedupeItem,
} from '@/lib/db';
import { shouldRejectTitle } from '@/lib/filters';
import { verifyCardMatchWithOpenAI } from '@/lib/openai';
import {
  getSportsCardsProProduct,
  hydrateSportsCardsProCandidates,
  searchScpCsvCandidates,
  searchSportsCardsProCandidates,
  type ScpCandidate,
} from '@/lib/scp';
import { identifyWithXimilar } from '@/lib/ximilar';
import { compactWhitespace, tokenizeLoose } from '@/lib/utils';
import type { SearchForm, ScanSummary } from '@/types/app';

const TARGET_RESULTS = 10;
const FETCH_PAGE_SIZE = 40;
const MAX_CANDIDATES_PER_TICK = 4;
const AUTO_ACCEPT_CONFIDENCE = 90;

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

  const override = await getManualMatchOverride(listing.title);
  if (override) {
    await addScanEvent(scanId, 'info', 'matching_scp', 'Applied saved manual override', `${listing.title} -> ${override.scpProductName}`);
  }

  const ximilarHints = shouldUseXimilar(listing.title, listing.imageUrl) ? await identifyWithXimilar([listing.imageUrl!].filter(Boolean)) : null;
  if (ximilarHints) {
    await incrementUsage('ximilar', ximilarHints.callCount);
    await appendMetrics(scanId, { ximilarCalls: ximilarHints.callCount });
  }

  const scpQuery = buildScpQuery(listing.title, ximilarHints?.titleHints ?? []);
  const baseCandidates = await searchSportsCardsProCandidates(scpQuery);
  await incrementUsage('scp', 1);
  await appendMetrics(scanId, { scpCalls: 1 });

  if (baseCandidates.length === 0 && !override) {
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: 'No SportsCardsPro candidates found' });
    await addScanEvent(scanId, 'warning', 'matching_scp', 'No SCP candidates found', listing.title);
    return;
  }

  let candidatePool = [...baseCandidates];
  const hydratedBase = await hydrateSportsCardsProCandidates(rankScpCandidatesLocally(listing.title, baseCandidates).slice(0, 5).map((row) => row.productId));
  if (hydratedBase.length > 0) {
    await incrementUsage('scp', hydratedBase.length);
    await appendMetrics(scanId, { scpCalls: hydratedBase.length });
    candidatePool = mergeCandidates(candidatePool, hydratedBase);
  }

  const likelyConsole = hydratedBase[0]?.consoleName ?? candidatePool[0]?.consoleName ?? null;
  if (likelyConsole) {
    const cachedCsv = await getScpCacheCsvText(likelyConsole);
    if (cachedCsv) {
      const cacheCandidates = searchScpCsvCandidates(cachedCsv, scpQuery, 12);
      candidatePool = mergeCandidates(candidatePool, cacheCandidates);
      await addScanEvent(scanId, 'info', 'matching_scp', 'Loaded SCP set cache', likelyConsole);
    }
  }

  if (override) {
    const overrideCandidate = candidatePool.find((row) => row.productId === override.scpProductId) ?? (await getSportsCardsProProduct(override.scpProductId));
    if (overrideCandidate) {
      if (!candidatePool.some((row) => row.productId === overrideCandidate.productId)) {
        candidatePool = mergeCandidates(candidatePool, [overrideCandidate]);
      }
      const estimatedProfit = (overrideCandidate.ungradedSell ?? 0) - listing.total;
      const estimatedMarginPct = overrideCandidate.ungradedSell ? (estimatedProfit / listing.total) * 100 : null;
      if (passesThresholds(filters, estimatedProfit, estimatedMarginPct)) {
        await insertResultPayload(
          scanId,
          listing,
          overrideCandidate,
          {
            exactMatch: true,
            confidence: 99,
            reasoning: 'Used saved manual override for a previously reviewed listing pattern.',
            chosenProductId: overrideCandidate.productId,
            topThreeProductIds: [overrideCandidate.productId],
            extractedAttributes: {},
          },
          false,
          estimatedProfit,
          estimatedMarginPct,
        );
        await appendMetrics(scanId, { dealsFound: 1 });
        await updateCandidate(candidateId, {
          stage: 'accepted',
          ai_confidence: 99,
          ai_reasoning: 'Used saved manual override',
          scp_product_id: overrideCandidate.productId,
        });
        return;
      }
    }
  }

  await markScanStatus(scanId, 'ai_verifying', 'Verifying exact match with OpenAI');
  const rankedCandidates = rankScpCandidatesLocally(listing.title, candidatePool).slice(0, 5);
  const decision = await verifyCardMatchWithOpenAI(listing, rankedCandidates, { ximilarHints: ximilarHints?.titleHints ?? [] });
  await incrementUsage('openai', 1);
  await appendMetrics(scanId, { openaiCalls: 1 });

  const chosen = rankedCandidates.find((candidate) => candidate.productId === decision.chosenProductId) ?? rankedCandidates[0] ?? null;

  if (!decision.exactMatch || decision.confidence < AUTO_ACCEPT_CONFIDENCE || !chosen) {
    const resultId = await insertResultPayload(scanId, listing, null, decision, true);
    await insertReviewOptions(
      resultId,
      rankedCandidates.slice(0, 3).map((candidate, index) => reviewOptionPayload(candidate, index + 1, decision.confidence)),
    );
    await appendMetrics(scanId, { needsReview: 1 });
    await updateCandidate(candidateId, { stage: 'needs_review', ai_confidence: decision.confidence, ai_reasoning: decision.reasoning });
    await addScanEvent(scanId, 'warning', 'ai_verifying', 'Sent listing to Needs Review', `${listing.title}\n${decision.reasoning}`);
    return;
  }

  const estimatedProfit = (chosen.ungradedSell ?? 0) - listing.total;
  const estimatedMarginPct = chosen.ungradedSell ? (estimatedProfit / listing.total) * 100 : null;

  if (!passesThresholds(filters, estimatedProfit, estimatedMarginPct)) {
    const rejectionReason = filters.minProfit && estimatedProfit < filters.minProfit
      ? `Profit below threshold: ${estimatedProfit.toFixed(2)}`
      : `Margin below threshold: ${(estimatedMarginPct ?? 0).toFixed(2)}%`;
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: rejectionReason });
    return;
  }

  await insertResultPayload(scanId, listing, chosen, decision, false, estimatedProfit, estimatedMarginPct);
  await appendMetrics(scanId, { dealsFound: 1 });
  await updateCandidate(candidateId, { stage: 'accepted', ai_confidence: decision.confidence, ai_reasoning: decision.reasoning, scp_product_id: chosen.productId });
  await addScanEvent(scanId, 'info', 'publishing_results', 'Added deal result', `${listing.title}\nConfidence ${decision.confidence}`);
}

async function insertResultPayload(
  scanId: string,
  listing: EbayListing,
  candidate: ScpCandidate | null,
  decision: Awaited<ReturnType<typeof verifyCardMatchWithOpenAI>>,
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
  return !/#[a-z0-9]+/.test(lower) || lower.includes('prizm') || lower.includes('mosaic') || lower.includes('optic') || lower.includes('refractor');
}

function buildScpQuery(title: string, hints: string[]): string {
  const tokens = tokenizeLoose(`${title} ${hints.join(' ')}`)
    .filter((token) => token.length > 1)
    .slice(0, 16);
  return compactWhitespace(tokens.join(' '));
}

function rankScpCandidatesLocally(title: string, candidates: ScpCandidate[]): ScpCandidate[] {
  const lower = title.toLowerCase();
  return [...candidates].sort((a, b) => scoreCandidate(lower, b) - scoreCandidate(lower, a));
}

function scoreCandidate(title: string, candidate: ScpCandidate): number {
  const haystack = `${candidate.productName} ${candidate.consoleName ?? ''}`.toLowerCase();
  let score = 0;

  for (const token of tokenizeLoose(candidate.productName)) {
    if (token.length > 2 && title.includes(token)) score += 3;
    if (token.startsWith('#') && title.includes(token)) score += 12;
  }

  const numberMatch = candidate.productName.match(/#([a-z0-9-]+)/i);
  if (numberMatch && title.includes(`#${numberMatch[1].toLowerCase()}`)) score += 16;

  const bracketMatch = candidate.productName.match(/\[[^\]]+\]/g) ?? [];
  for (const variant of bracketMatch) {
    if (title.includes(variant.toLowerCase().replace(/[\[\]]/g, ''))) score += 10;
  }

  if (/\[rc\]|rookie/i.test(candidate.productName) && /rookie|\brc\b/i.test(title)) score += 4;
  if (/auto|autograph/i.test(candidate.productName) && /auto|autograph/i.test(title)) score += 6;
  if (/memorabilia|patch|relic/i.test(candidate.productName) && /memorabilia|patch|relic/i.test(title)) score += 6;
  if (candidate.ungradedSell !== null) score += 1;
  if (candidate.source === 'cache') score += 1;

  return score;
}

function mergeCandidates(...groups: ScpCandidate[][]): ScpCandidate[] {
  const byId = new Map<string, ScpCandidate>();
  for (const group of groups) {
    for (const candidate of group) {
      const existing = byId.get(candidate.productId);
      if (!existing) {
        byId.set(candidate.productId, candidate);
        continue;
      }
      byId.set(candidate.productId, {
        ...existing,
        ...candidate,
        productUrl: candidate.productUrl ?? existing.productUrl,
        consoleName: candidate.consoleName ?? existing.consoleName,
        ungradedSell: candidate.ungradedSell ?? existing.ungradedSell,
        grade9: candidate.grade9 ?? existing.grade9,
        psa10: candidate.psa10 ?? existing.psa10,
      });
    }
  }
  return [...byId.values()];
}

function passesThresholds(filters: SearchForm, estimatedProfit: number, estimatedMarginPct: number | null): boolean {
  if (filters.minProfit && estimatedProfit < filters.minProfit) return false;
  if (filters.minMarginPct && (estimatedMarginPct ?? 0) < filters.minMarginPct) return false;
  return true;
}
