import { getEbayListingDetails, searchEbayListings, type EbayListing, type EbayListingDetails } from '@/lib/ebay';
import {
  addScanEvent,
  appendMetrics,
  findScpCacheMatches,
  getExceededUsageLimits,
  getRecentStageEvents,
  getManualMatchOverride,
  getRecentAuctionOutcomeMemory,
  getRecentBadLogicPatterns,
  getRecentCardNumberOutcomeMemory,
  getRecentFamilyOutcomeMemory,
  getRecentPlayerOutcomeMemory,
  getRecentPriceBandOutcomeMemory,
  getRecentReviewResolutionMemory,
  getRecentTitleOutcomeMemory,
  getScanById,
  getEbaySearchPageCount,
  getNeedsReviewQueueFloor,
  getScanResultMemory,
  getScpCacheCsvTextByStoragePath,
  getSellerOutcomeMemory,
  incrementUsage,
  insertCandidate,
  insertResult,
  insertReviewOptions,
  markScanStatus,
  updateCandidate,
  upsertDedupeItem,
} from '@/lib/db';
import { shouldRejectListingDetails, shouldRejectTitle } from '@/lib/filters';
import { buildListingFingerprint, buildScpCandidateFingerprint, compareFingerprintMatch } from '@/lib/card-fingerprint';
import { triageNeedsReviewWithOpenAI, verifyCardMatchWithOpenAI } from '@/lib/openai';
import {
  getSportsCardsProProduct,
  hydrateSportsCardsProCandidates,
  searchScpCsvCandidatesMulti,
  searchSportsCardsProCandidatesMulti,
  type ScpCandidate,
} from '@/lib/scp';
import { identifyWithXimilar } from '@/lib/ximilar';
import {
  buildAuctionOutcomeMemory,
  buildCardNumberOutcomeMemory,
  buildDealDiversityKeys,
  buildFamilyOutcomeMemory,
  buildPlayerOutcomeMemory,
  buildPriceBandOutcomeMemory,
  buildReviewResolutionMemory,
  buildTitleOutcomeMemory,
  classifyProviderFailure,
  compactWhitespace,
  formatProviderFailure,
  determineGradingLane,
  sleep,
  normalizeSellerUsername,
  normalizeTitleFingerprint,
  scoreListingAgainstAuctionMemory,
  scoreListingAgainstFamilyMemory,
  scoreListingAgainstPlayerMemory,
  scoreListingAgainstPriceBandMemory,
  scoreScpCandidateAgainstCardNumberMemory,
  scoreScpCandidateAgainstReviewMemory,
  scoreListingAgainstTitleMemory,
  scoreListingPriority,
  scoreSellerListingQuality,
  shouldRejectLowTrustListing,
  shouldSkipWeakTail,
  tokenSimilarity,
  tokenizeLoose,
} from '@/lib/utils';
import type { SearchForm, ScanSummary } from '@/types/app';

const TARGET_RESULTS = 10;
const FETCH_PAGE_SIZE = 40;
const MAX_CANDIDATES_PER_TICK = 3;
const MIN_CANDIDATES_PER_TICK = 1;
const AUTO_ACCEPT_CONFIDENCE = 90;
const BAD_LOGIC_CACHE_TTL_MS = 2 * 60 * 1000;
const TITLE_OUTCOME_CACHE_TTL_MS = 2 * 60 * 1000;
const SELLER_OUTCOME_CACHE_TTL_MS = 10 * 60 * 1000;
const FAMILY_OUTCOME_CACHE_TTL_MS = 2 * 60 * 1000;
const PLAYER_OUTCOME_CACHE_TTL_MS = 2 * 60 * 1000;
const REVIEW_RESOLUTION_CACHE_TTL_MS = 2 * 60 * 1000;
const AUCTION_OUTCOME_CACHE_TTL_MS = 2 * 60 * 1000;
const PRICE_BAND_OUTCOME_CACHE_TTL_MS = 2 * 60 * 1000;
const CARD_NUMBER_OUTCOME_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_EXACT_FAMILY_RESULTS = 1;
const MAX_CLUSTER_RESULTS = 2;
const LOW_YIELD_STOP_MIN_RESULTS = 6;
const LOW_YIELD_STREAK_TO_STOP = 3;

let badLogicCache: { loadedAt: number; rows: Array<{ ebayTitle: string; fingerprint: string; createdAt: string; reasoning: string | null }> } | null = null;
let titleOutcomeMemoryCache: { loadedAt: number; memory: ReturnType<typeof buildTitleOutcomeMemory> } | null = null;
let familyOutcomeMemoryCache: { loadedAt: number; memory: ReturnType<typeof buildFamilyOutcomeMemory> } | null = null;
let playerOutcomeMemoryCache: { loadedAt: number; memory: ReturnType<typeof buildPlayerOutcomeMemory> } | null = null;
let reviewResolutionMemoryCache: { loadedAt: number; memory: ReturnType<typeof buildReviewResolutionMemory> } | null = null;
let auctionOutcomeMemoryCache: { loadedAt: number; memory: ReturnType<typeof buildAuctionOutcomeMemory> } | null = null;
let priceBandOutcomeMemoryCache: { loadedAt: number; memory: ReturnType<typeof buildPriceBandOutcomeMemory> } | null = null;
let cardNumberOutcomeMemoryCache: { loadedAt: number; memory: ReturnType<typeof buildCardNumberOutcomeMemory> } | null = null;
const sellerOutcomeCache = new Map<string, { loadedAt: number; value: Awaited<ReturnType<typeof getSellerOutcomeMemory>> }>();

export async function runScanWorkerTick(scanId: string): Promise<ScanSummary> {
  const scan = await getScanById(scanId);
  if (!scan) {
    throw new Error(`Scan ${scanId} not found`);
  }

  if (scan.status === 'cancelled' || scan.status === 'completed' || scan.status === 'failed') {
    return scan;
  }

  const exceededLimits = await getExceededUsageLimits();
  if (exceededLimits.length > 0) {
    const message = exceededLimits
      .map((row) => `${row.provider.toUpperCase()} daily call limit reached (${row.used}/${row.limit})`)
      .join('; ');
    await markScanStatus(scanId, 'failed', message);
    await addScanEvent(scanId, 'warning', 'guardrails', message);
    return (await getScanById(scanId))!;
  }

  const currentResults = scan.metrics.dealsFound + scan.metrics.needsReview;
  if (currentResults >= TARGET_RESULTS) {
    await markScanStatus(scanId, 'completed', 'Reached target result count');
    await addScanEvent(scanId, 'info', 'publishing_results', 'Scan completed');
    return (await getScanById(scanId))!;
  }

  await markScanStatus(scanId, 'fetching_ebay', 'Fetching eBay listings');
  const searchPageCount = await getEbaySearchPageCount(scanId);
  const offset = searchPageCount * FETCH_PAGE_SIZE;
  const searchOutcome = await withProviderRetries('ebay', 'search', () => searchEbayListings(scan.filters, offset, FETCH_PAGE_SIZE), {
    scanId,
    stage: 'fetching_ebay',
    attempts: 2,
  });

  if (!searchOutcome.ok) {
    if (searchOutcome.failure.recoverable) {
      await markScanStatus(scanId, 'fetching_ebay', 'Temporary eBay search issue; retry on next worker tick');
      return (await getScanById(scanId))!;
    }
    await markScanStatus(scanId, 'failed', `eBay search failed: ${searchOutcome.failure.message}`);
    return (await getScanById(scanId))!;
  }

  const listings = searchOutcome.value;
  await incrementUsage('ebay', 1);
  await appendMetrics(scanId, { ebayCalls: 1, candidatesFetched: listings.length });
  await addScanEvent(scanId, 'info', 'fetching_ebay', `Fetched ${listings.length} eBay candidates`, `Offset ${offset} (page ${searchPageCount + 1})`);

  if (listings.length === 0) {
    await markScanStatus(scanId, 'completed', 'No more eBay listings returned');
    return (await getScanById(scanId))!;
  }

  const existingResultMemory = await getScanResultMemory(scanId);
  const titleOutcomeMemory = await getTitleOutcomeMemoryCached();
  const familyOutcomeMemory = await getFamilyOutcomeMemoryCached();
  const playerOutcomeMemory = await getPlayerOutcomeMemoryCached();
  const reviewResolutionMemory = await getReviewResolutionMemoryCached();
  const auctionOutcomeMemory = await getAuctionOutcomeMemoryCached();
  const priceBandOutcomeMemory = await getPriceBandOutcomeMemoryCached();
  const cardNumberOutcomeMemory = await getCardNumberOutcomeMemoryCached();
  const prioritizedListings = prioritizeListingsForScan(
    listings,
    scan.filters,
    existingResultMemory,
    titleOutcomeMemory,
    familyOutcomeMemory,
    playerOutcomeMemory,
    auctionOutcomeMemory,
    priceBandOutcomeMemory,
  );
  await addScanEvent(
    scanId,
    'info',
    'fetching_ebay',
    'Prioritized eBay listings for evaluation',
    prioritizedListings
      .slice(0, 5)
      .map((entry) => `${entry.score} · ${entry.listing.title}${entry.reasons.length ? ` [${entry.reasons.join(', ')}]` : ''}`)
      .join('\n'),
  );

  const tickResultsBefore = currentResults;
  const tickEvaluatedBefore = scan.metrics.candidatesEvaluated;
  let processed = 0;
  const tickBudget = getTickBudget(currentResults, scan.metrics.dealsFound);
  for (const { listing, score } of prioritizedListings) {
    if (processed >= tickBudget) break;

    const weakTailReason = shouldSkipWeakTail({
      currentResults,
      dealsFound: scan.metrics.dealsFound,
      listingPriorityScore: score,
    });
    if (weakTailReason) {
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'filtering', weakTailReason, `${listing.title}
Priority ${score}`);
      continue;
    }
    const dedupeAllowed = await upsertDedupeItem(listing.itemId);
    if (!dedupeAllowed) {
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'filtering', `Skipped duplicate eBay item ${listing.itemId}`);
      continue;
    }

    const rejectionReason = shouldRejectTitle(listing.title, scan.filters);
    const titleMemorySignal = scoreListingAgainstTitleMemory(listing.title, titleOutcomeMemory);
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

    if (titleMemorySignal.score <= -10) {
      const memoryReason = `Suppressed by title-pattern memory: ${titleMemorySignal.reason ?? 'historical low-quality pattern'}`;
      await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: memoryReason });
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'filtering', memoryReason, listing.title);
      processed += 1;
      continue;
    }

    try {
      await evaluateListing(scanId, candidateId, listing, scan.filters, titleOutcomeMemory, familyOutcomeMemory, playerOutcomeMemory, reviewResolutionMemory, auctionOutcomeMemory, priceBandOutcomeMemory, cardNumberOutcomeMemory);
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

  const refreshedScan = (await getScanById(scanId))!;
  const tickResultsAfter = refreshedScan.metrics.dealsFound + refreshedScan.metrics.needsReview;
  const tickEvaluatedAfter = refreshedScan.metrics.candidatesEvaluated;
  const resultsDelta = tickResultsAfter - tickResultsBefore;
  const evaluatedDelta = tickEvaluatedAfter - tickEvaluatedBefore;

  if (resultsDelta > 0) {
    await addScanEvent(scanId, 'info', 'worker_summary', 'Batch produced results', `+${resultsDelta} result(s) from ${evaluatedDelta} evaluated candidate(s)`);
  } else {
    await addScanEvent(scanId, 'info', 'worker_summary', 'No publishable results from batch', `Evaluated ${evaluatedDelta} candidate(s) from ${listings.length} fetched listing(s)`);
  }

  if (tickResultsAfter >= LOW_YIELD_STOP_MIN_RESULTS) {
    const recentEvents = await getRecentStageEvents(scanId, 10);
    if (shouldStopAfterLowYieldStreak(recentEvents)) {
      await markScanStatus(scanId, 'completed', 'Stopped after consecutive low-yield batches once enough results were already captured');
      await addScanEvent(scanId, 'info', 'worker_summary', 'Completed early after low-yield streak', `Current results: ${tickResultsAfter}`);
      return (await getScanById(scanId))!;
    }
  }

  return refreshedScan;
}

async function evaluateListing(
  scanId: string,
  candidateId: string,
  listing: EbayListing,
  filters: SearchForm,
  titleOutcomeMemory: ReturnType<typeof buildTitleOutcomeMemory>,
  familyOutcomeMemory: ReturnType<typeof buildFamilyOutcomeMemory>,
  playerOutcomeMemory: ReturnType<typeof buildPlayerOutcomeMemory>,
  reviewResolutionMemory: ReturnType<typeof buildReviewResolutionMemory>,
  auctionOutcomeMemory: ReturnType<typeof buildAuctionOutcomeMemory>,
  priceBandOutcomeMemory: ReturnType<typeof buildPriceBandOutcomeMemory>,
  cardNumberOutcomeMemory: ReturnType<typeof buildCardNumberOutcomeMemory>,
): Promise<void> {
  await markScanStatus(scanId, 'matching_scp', 'Inspecting listing and matching SportsCardsPro candidates');
  await updateCandidate(candidateId, { stage: 'matching_scp' });
  await appendMetrics(scanId, { candidatesEvaluated: 1 });

  const initialBadLogicMatch = await findBadLogicPatternMatch(listing.title);
  if (initialBadLogicMatch) {
    const rejectionReason = `Suppressed from prior Bad Logic pattern: ${initialBadLogicMatch.reason}`;
    await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: rejectionReason });
    await appendMetrics(scanId, { candidatesFilteredOut: 1 });
    await addScanEvent(scanId, 'info', 'filtering', rejectionReason, `${listing.title}\nMatched prior: ${initialBadLogicMatch.matchedTitle}`);
    return;
  }

  const details = await getEbayDetailsWithLogging(scanId, listing);
  const aspectCount = Object.values(details?.aspectMap ?? {}).reduce<number>((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0);
  const imageCount = [listing.imageUrl, ...(details?.imageUrls ?? [])].filter(Boolean).length;
  const listingQuality = scoreSellerListingQuality({
    sellerFeedbackPercentage: details?.sellerFeedbackPercentage ?? null,
    sellerFeedbackScore: details?.sellerFeedbackScore ?? null,
    imageCount,
    description: details?.description ?? null,
    aspectMap: details?.aspectMap ?? null,
    condition: details?.condition ?? listing.condition ?? null,
  });
  const sellerUsername = normalizeSellerUsername(details?.sellerUsername);
  const sellerOutcome = sellerUsername ? await getSellerOutcomeMemoryCached(sellerUsername) : null;
  const titleMemorySignal = scoreListingAgainstTitleMemory(`${listing.title} ${details?.subtitle ?? ''}`.trim(), titleOutcomeMemory);
  const familyMemorySignal = scoreListingAgainstFamilyMemory({ ebayTitle: `${listing.title} ${details?.subtitle ?? ''}`.trim() }, familyOutcomeMemory);
  const playerMemorySignal = scoreListingAgainstPlayerMemory({ ebayTitle: `${listing.title} ${details?.subtitle ?? ''}`.trim(), requestedPlayerName: filters.playerName ?? null }, playerOutcomeMemory);
  const auctionMemorySignal = scoreListingAgainstAuctionMemory({ ebayTitle: `${listing.title} ${details?.subtitle ?? ''}`.trim(), auctionEndsAt: listing.auctionEndsAt }, auctionOutcomeMemory);
  const priceBandMemorySignal = scoreListingAgainstPriceBandMemory({ ebayTitle: `${listing.title} ${details?.subtitle ?? ''}`.trim(), totalPurchasePrice: listing.total }, priceBandOutcomeMemory);
  const trustAdjustedScore = Math.max(
    0,
    Math.min(
      100,
      listingQuality.score
        + Math.max(-14, Math.min(8, sellerOutcome?.score ?? 0))
        + Math.max(-8, Math.min(6, titleMemorySignal.score))
        + Math.max(-8, Math.min(6, familyMemorySignal.score))
        + Math.max(-8, Math.min(6, playerMemorySignal.score))
        + Math.max(-6, Math.min(5, auctionMemorySignal.score))
        + Math.max(-6, Math.min(5, priceBandMemorySignal.score)),
    ),
  );

  await updateCandidate(candidateId, {
    seller_username: sellerUsername,
    seller_feedback_percentage: details?.sellerFeedbackPercentage ?? null,
    seller_feedback_score: details?.sellerFeedbackScore ?? null,
    listing_quality_score: trustAdjustedScore,
  });

  if (auctionMemorySignal.score <= -9 && priceBandMemorySignal.score <= -8 && trustAdjustedScore < 60) {
    const patternReason = `Suppressed by auction/price-band memory: ${auctionMemorySignal.reason ?? 'weak auction pattern'}${priceBandMemorySignal.reason ? ` + ${priceBandMemorySignal.reason}` : ''}`;
    await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: patternReason });
    await appendMetrics(scanId, { candidatesFilteredOut: 1 });
    await addScanEvent(scanId, 'info', 'filtering', patternReason, `${listing.title}
${auctionMemorySignal.band} • ${priceBandMemorySignal.band}`);
    return;
  }

  if (familyMemorySignal.score <= -12 && titleMemorySignal.score <= 0 && trustAdjustedScore < 58) {
    const familyReason = `Suppressed by set/parallel family memory: ${familyMemorySignal.reason ?? 'historically weak family'}`;
    await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: familyReason });
    await appendMetrics(scanId, { candidatesFilteredOut: 1 });
    await addScanEvent(scanId, 'info', 'filtering', familyReason, `${listing.title}\n${familyMemorySignal.exactFamily ?? familyMemorySignal.cluster ?? ''}`.trim());
    return;
  }

  if (sellerOutcome?.total && sellerOutcome.total >= 3 && sellerOutcome.purchased === 0 && (sellerOutcome.badLogic >= 2 || sellerOutcome.score <= -8)) {
    const sellerReason = `Suppressed by seller memory: ${sellerOutcome.label}`;
    await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: sellerReason });
    await appendMetrics(scanId, { candidatesFilteredOut: 1 });
    await addScanEvent(scanId, 'info', 'filtering', sellerReason, `${listing.title}
${sellerOutcome.detail}`);
    return;
  }

  const lowTrustReason = shouldRejectLowTrustListing({
    score: trustAdjustedScore,
    sellerFeedbackPercentage: details?.sellerFeedbackPercentage ?? null,
    sellerFeedbackScore: details?.sellerFeedbackScore ?? null,
    imageCount,
    aspectCount,
    description: details?.description ?? null,
    title: listing.title,
    subtitle: details?.subtitle ?? null,
    filters,
  });
  if (lowTrustReason) {
    await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: lowTrustReason });
    await appendMetrics(scanId, { candidatesFilteredOut: 1 });
    await addScanEvent(scanId, 'info', 'filtering', lowTrustReason, `${listing.title}
${listingQuality.summary}${sellerOutcome ? `
${sellerOutcome.label}: ${sellerOutcome.detail}` : ''}`);
    return;
  }

  if (details) {
    const detailRejection = shouldRejectListingDetails(details, filters);
    if (detailRejection) {
      await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: detailRejection });
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'filtering', detailRejection, listing.title);
      return;
    }

    const detailedBadLogicMatch = await findBadLogicPatternMatch(`${listing.title} ${details.subtitle ?? ''}`);
    if (detailedBadLogicMatch) {
      const rejectionReason = `Suppressed from prior Bad Logic pattern: ${detailedBadLogicMatch.reason}`;
      await updateCandidate(candidateId, { stage: 'filtered_out', rejection_reason: rejectionReason });
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'filtering', rejectionReason, `${listing.title}\nMatched prior: ${detailedBadLogicMatch.matchedTitle}`);
      return;
    }
  }

  await addScanEvent(scanId, 'info', 'matching_scp', 'Hydrated listing quality', `${listingQuality.summary}${sellerOutcome ? `\n${sellerOutcome.label}: ${sellerOutcome.detail}` : ''}${titleMemorySignal.reason ? `\nTitle memory: ${titleMemorySignal.reason}` : ''}${familyMemorySignal.reason ? `\nFamily memory: ${familyMemorySignal.reason}` : ''}${playerMemorySignal.reason ? `\nPlayer memory: ${playerMemorySignal.reason}` : ''}${auctionMemorySignal.reason ? `\nAuction memory: ${auctionMemorySignal.reason}` : ''}${priceBandMemorySignal.reason ? `\nPrice-band memory: ${priceBandMemorySignal.reason}` : ''}`);

  const override = await getManualMatchOverride(listing.title);
  if (override) {
    await addScanEvent(scanId, 'info', 'matching_scp', 'Applied saved manual override', `${listing.title} -> ${override.scpProductName}`);
  }

  const imageUrlsForAi = [listing.imageUrl, ...(details?.imageUrls ?? [])]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 2);

  const ximilarHints = shouldUseXimilar(listing, details)
    ? await identifyWithXimilar(imageUrlsForAi)
    : null;
  if (ximilarHints) {
    await incrementUsage('ximilar', ximilarHints.callCount);
    await appendMetrics(scanId, { ximilarCalls: ximilarHints.callCount });
  }

  const scpQueries = buildScpQueries(listing, details, filters, ximilarHints?.titleHints ?? []);
  let candidatePool: ScpCandidate[] = [];
  let hydratedBase: ScpCandidate[] = [];

  const cacheHints = buildScpCacheHints(listing, details, filters, candidatePool, hydratedBase, scpQueries, ximilarHints?.titleHints ?? []);
  const matchedCaches = await findScpCacheMatches(cacheHints, 4);
  if (cacheHints.length > 0) {
    await addScanEvent(scanId, 'info', 'matching_scp', 'Inferred SCP cache targets', cacheHints.slice(0, 8).join(' • '));
  }

  const loadedCacheNames: string[] = [];
  for (const cacheEntry of matchedCaches.slice(0, 3)) {
    if (!cacheEntry.storagePath) continue;
    const cachedCsv = await getScpCacheCsvTextByStoragePath(cacheEntry.storagePath);
    if (!cachedCsv) continue;
    const cacheQueries = buildScpCacheQueries(scpQueries, cacheEntry.consoleName, listing, details, filters);
    const cacheCandidates = searchScpCsvCandidatesMulti(cachedCsv, cacheQueries, 30);
    if (cacheCandidates.length > 0) {
      candidatePool = mergeCandidates(candidatePool, cacheCandidates);
      loadedCacheNames.push(`${cacheEntry.consoleName} (${cacheCandidates.length})`);
    }
  }
  if (loadedCacheNames.length > 0) {
    await addScanEvent(scanId, 'info', 'matching_scp', 'Loaded SCP set cache before live API lookup', loadedCacheNames.join(' • '));
  }

  const shouldUseLiveScpApi = true;
  if (shouldUseLiveScpApi) {
    const scpSearchOutcome = await withProviderRetries('scp', 'candidate search', () => searchSportsCardsProCandidatesMulti(scpQueries, 10), {
      scanId,
      stage: 'matching_scp',
      attempts: 2,
    });
    if (!scpSearchOutcome.ok) {
      if (candidatePool.length === 0) {
        const rejectionReason = `SCP lookup unavailable: ${scpSearchOutcome.failure.message}`;
        await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: rejectionReason });
        await addScanEvent(scanId, scpSearchOutcome.failure.recoverable ? 'warning' : 'error', 'matching_scp', rejectionReason, listing.title);
        return;
      }
      await addScanEvent(scanId, scpSearchOutcome.failure.recoverable ? 'warning' : 'error', 'matching_scp', 'Live SCP lookup unavailable; continuing with cached CSV candidates only', scpSearchOutcome.failure.message);
    } else {
      const { candidates: baseCandidates, queryHits } = scpSearchOutcome.value;
      if (queryHits.length > 0) {
        await incrementUsage('scp', queryHits.length);
        await appendMetrics(scanId, { scpCalls: queryHits.length });
        await addScanEvent(
          scanId,
          'info',
          'matching_scp',
          'Ran live SCP lookup queries after cache pass',
          queryHits.map((row) => `${row.query} (${row.count})`).join('\n'),
        );
      }

      candidatePool = mergeCandidates(candidatePool, baseCandidates);
      const hydrateIds = rankScpCandidatesLocally(listing, details, filters, candidatePool, reviewResolutionMemory, cardNumberOutcomeMemory)
        .slice(0, 8)
        .map((row) => row.candidate.productId);
      if (hydrateIds.length > 0) {
        const hydrateOutcome = await withProviderRetries(
          'scp',
          'candidate hydration',
          () => hydrateSportsCardsProCandidates(hydrateIds),
          {
            scanId,
            stage: 'matching_scp',
            attempts: 2,
          },
        );
        if (!hydrateOutcome.ok) {
          if (candidatePool.length === 0) {
            const rejectionReason = `SCP hydration unavailable: ${hydrateOutcome.failure.message}`;
            await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: rejectionReason });
            await addScanEvent(scanId, hydrateOutcome.failure.recoverable ? 'warning' : 'error', 'matching_scp', rejectionReason, listing.title);
            return;
          }
          await addScanEvent(scanId, hydrateOutcome.failure.recoverable ? 'warning' : 'error', 'matching_scp', 'Live SCP hydration unavailable; continuing with cached CSV candidates only', hydrateOutcome.failure.message);
        } else {
          hydratedBase = hydrateOutcome.value;
          if (hydratedBase.length > 0) {
            await incrementUsage('scp', hydratedBase.length);
            await appendMetrics(scanId, { scpCalls: hydratedBase.length });
            candidatePool = mergeCandidates(candidatePool, hydratedBase);
          }
        }
      }
    }
  } else {
    await addScanEvent(scanId, 'info', 'matching_scp', 'Skipped live SCP API lookup because cached CSV candidates were already available', `${candidatePool.length} cache candidate${candidatePool.length === 1 ? '' : 's'} retained`);
  }

  if (candidatePool.length === 0 && !override) {
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: 'No SportsCardsPro candidates found' });
    await addScanEvent(scanId, 'warning', 'matching_scp', 'No SCP candidates found', listing.title);
    return;
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
        const diversityDecision = await assessScanResultDiversity(scanId, listing, overrideCandidate);
        if (diversityDecision.rejectReason) {
          await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: diversityDecision.rejectReason });
          await appendMetrics(scanId, { candidatesFilteredOut: 1 });
          await addScanEvent(scanId, 'info', 'publishing_results', diversityDecision.rejectReason, diversityDecision.details ?? listing.title);
          return;
        }

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
          null,
          estimatedProfit,
          estimatedMarginPct,
          listingQuality,
          details,
          sellerOutcome,
          scoreListingAgainstFamilyMemory({ ebayTitle: listing.title, scpProductName: overrideCandidate.productName }, familyOutcomeMemory),
          playerMemorySignal,
          auctionMemorySignal,
          priceBandMemorySignal,
          scoreScpCandidateAgainstCardNumberMemory({ ebayTitle: `${listing.title} ${details?.subtitle ?? ''}`.trim(), scpProductName: overrideCandidate.productName, requestedCardNumber: filters.cardNumber ?? null }, cardNumberOutcomeMemory),
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
  const rankedCandidateRows = rankScpCandidatesLocally(listing, details, filters, candidatePool, reviewResolutionMemory, cardNumberOutcomeMemory);
  const memorySignals = rankedCandidateRows
    .filter((row) => row.reviewMemory.score >= 5 || row.reviewMemory.score <= -5 || row.cardNumberMemory.score >= 5 || row.cardNumberMemory.score <= -5)
    .slice(0, 4)
    .map((row) => `${row.candidate.productName} ${row.reviewMemory.score ? `review ${row.reviewMemory.score > 0 ? '+' : ''}${row.reviewMemory.score}` : ''}${row.cardNumberMemory.score ? `${row.reviewMemory.score ? ' • ' : ''}card# ${row.cardNumberMemory.score > 0 ? '+' : ''}${row.cardNumberMemory.score}` : ''}${row.reviewMemory.reason ? ` • ${row.reviewMemory.reason}` : ''}${row.cardNumberMemory.reason ? ` • ${row.cardNumberMemory.reason}` : ''}`);
  if (memorySignals.length > 0) {
    await addScanEvent(scanId, 'info', 'ai_verifying', 'Applied memory signals to SCP candidate ranking', memorySignals.join('\n'));
  }
  const rankedCandidates = rankedCandidateRows
    .filter((row, index) => !(row.reviewMemory.score <= -10 && row.cardNumberMemory.score <= -10 && index > 0))
    .slice(0, 8)
    .map((row) => row.candidate);
  const openAiOutcome = await withProviderRetries('openai', 'exact match verification', () => verifyCardMatchWithOpenAI(listing, rankedCandidates, {
    ximilarHints: ximilarHints?.titleHints ?? [],
    details,
  }), {
    scanId,
    stage: 'ai_verifying',
    attempts: 2,
  });

  let decision: Awaited<ReturnType<typeof verifyCardMatchWithOpenAI>>;
  if (!openAiOutcome.ok) {
    const placeholderCandidate = rankedCandidates[0] ?? null;
    if (!placeholderCandidate) {
      await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: `OpenAI verification unavailable: ${openAiOutcome.failure.message}` });
      await addScanEvent(scanId, openAiOutcome.failure.recoverable ? 'warning' : 'error', 'ai_verifying', 'OpenAI verification unavailable and no fallback candidate existed', listing.title);
      return;
    }

    const placeholderProfit = placeholderCandidate.ungradedSell !== null && placeholderCandidate.ungradedSell !== undefined
      ? placeholderCandidate.ungradedSell - listing.total
      : null;
    const placeholderMargin = placeholderCandidate.ungradedSell && placeholderProfit !== null ? (placeholderProfit / listing.total) * 100 : null;
    if (placeholderProfit !== null && !passesThresholds(filters, placeholderProfit, placeholderMargin)) {
      await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: `OpenAI verification unavailable and fallback candidate missed thresholds: ${openAiOutcome.failure.message}` });
      return;
    }

    decision = {
      exactMatch: false,
      confidence: 0,
      reasoning: `OpenAI verification unavailable; queued for manual review using the top ranked SCP options. ${openAiOutcome.failure.message}`,
      chosenProductId: placeholderCandidate.productId,
      topThreeProductIds: rankedCandidates.slice(0, 3).map((candidate) => candidate.productId),
      extractedAttributes: {},
    };
  } else {
    decision = openAiOutcome.value;
    await incrementUsage('openai', 1);
    await appendMetrics(scanId, { openaiCalls: 1 });
  }

  const chosen = rankedCandidates.find((candidate) => candidate.productId === decision.chosenProductId) ?? rankedCandidates[0] ?? null;
  const chosenCardNumberSignal = chosen
    ? scoreScpCandidateAgainstCardNumberMemory({ ebayTitle: `${listing.title} ${details?.subtitle ?? ''}`.trim(), scpProductName: chosen.productName, requestedCardNumber: filters.cardNumber ?? null }, cardNumberOutcomeMemory)
    : null;
  const cardNumberThresholdAdjustment = (chosenCardNumberSignal?.score ?? 0) <= -8 ? 4 : (chosenCardNumberSignal?.score ?? 0) >= 8 ? -2 : 0;
  const autoAcceptThreshold = Math.max(88, Math.min(96, AUTO_ACCEPT_CONFIDENCE + cardNumberThresholdAdjustment));

  if (!decision.exactMatch || decision.confidence < autoAcceptThreshold || !chosen) {
    const diversityDecision = await assessScanResultDiversity(scanId, listing, rankedCandidates[0] ?? null);
    if (diversityDecision.rejectReason) {
      await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: diversityDecision.rejectReason });
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'publishing_results', diversityDecision.rejectReason, diversityDecision.details ?? listing.title);
      return;
    }

    const candidateFinancials = rankedCandidates.map((candidate) => {
      const estimatedProfit = candidate.ungradedSell !== null && candidate.ungradedSell !== undefined
        ? candidate.ungradedSell - listing.total
        : null;
      const estimatedMarginPct = candidate.ungradedSell && estimatedProfit !== null
        ? (estimatedProfit / listing.total) * 100
        : null;
      return { candidate, estimatedProfit, estimatedMarginPct };
    });

    const profitableReviewCandidates = candidateFinancials
      .filter((row) => row.estimatedProfit !== null && row.estimatedProfit > 0 && passesThresholds(filters, row.estimatedProfit, row.estimatedMarginPct));

    if (profitableReviewCandidates.length === 0) {
      await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: 'No profitable SCP options survived review ranking.' });
      return;
    }

    const aiPreferredCandidates = decision.topThreeProductIds
      .map((productId) => candidateFinancials.find((row) => row.candidate.productId === productId))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    let bestReviewCandidate = aiPreferredCandidates.find((row) => row.estimatedProfit !== null && row.estimatedProfit > 0 && passesThresholds(filters, row.estimatedProfit, row.estimatedMarginPct))
      ?? profitableReviewCandidates
        .slice()
        .sort((a, b) => (b.estimatedProfit ?? Number.NEGATIVE_INFINITY) - (a.estimatedProfit ?? Number.NEGATIVE_INFINITY))[0];
    const queueFloor = await getNeedsReviewQueueFloor(scanId, 20);
    if (queueFloor.count >= 20 && queueFloor.floorProfit !== null && (bestReviewCandidate.estimatedProfit ?? Number.NEGATIVE_INFINITY) <= queueFloor.floorProfit) {
      await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: 'Needs Review queue already holds 20 stronger profitable candidates.' });
      return;
    }

    let reviewCandidates = [
      ...aiPreferredCandidates.map((row) => row.candidate),
      bestReviewCandidate.candidate,
      ...rankedCandidates,
    ].filter((candidate, index, arr) => arr.findIndex((row) => row.productId === candidate.productId) === index).slice(0, 3);

    const reviewCandidateMeta = reviewCandidates.map((candidate) => {
      const financial = candidateFinancials.find((row) => row.candidate.productId === candidate.productId);
      const rankedRow = rankedCandidateRows.find((row) => row.candidate.productId === candidate.productId);
      return {
        productId: candidate.productId,
        estimatedProfit: financial?.estimatedProfit ?? null,
        estimatedMarginPct: financial?.estimatedMarginPct ?? null,
        reviewMemoryScore: rankedRow?.reviewMemory.score ?? 0,
        cardNumberMemoryScore: rankedRow?.cardNumberMemory.score ?? 0,
        aiPreferred: decision.topThreeProductIds.includes(candidate.productId),
      };
    });

    const triageOutcome = await withProviderRetries('openai', 'needs review triage', () => triageNeedsReviewWithOpenAI(listing, reviewCandidates, {
      ximilarHints: ximilarHints?.titleHints ?? [],
      details,
      candidateMeta: reviewCandidateMeta,
    }), {
      scanId,
      stage: 'ai_verifying',
      attempts: 1,
    });

    if (triageOutcome.ok) {
      await incrementUsage('openai', 1);
      await appendMetrics(scanId, { openaiCalls: 1 });
      if (!triageOutcome.value.sendToReview) {
        const rejectReason = triageOutcome.value.rejectReason
          ?? 'OpenAI review triage rejected the listing because none of the SCP options looked credible enough to review.';
        await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: rejectReason });
        await appendMetrics(scanId, { candidatesFilteredOut: 1 });
        await addScanEvent(scanId, 'info', 'ai_verifying', 'Rejected listing before Needs Review', `${listing.title}
${rejectReason}
${triageOutcome.value.reasoning}`);
        return;
      }

      const triageTop = triageOutcome.value.topThreeProductIds
        .map((productId) => reviewCandidates.find((candidate) => candidate.productId === productId))
        .filter((candidate): candidate is ScpCandidate => Boolean(candidate));
      const triagePreferred = triageOutcome.value.preferredProductId
        ? reviewCandidates.find((candidate) => candidate.productId === triageOutcome.value.preferredProductId) ?? null
        : null;
      reviewCandidates = [
        ...(triagePreferred ? [triagePreferred] : []),
        ...triageTop,
        ...reviewCandidates,
      ].filter((candidate, index, arr) => arr.findIndex((row) => row.productId === candidate.productId) === index).slice(0, 3);

      if (triagePreferred) {
        const preferredFinancial = candidateFinancials.find((row) => row.candidate.productId === triagePreferred.productId);
        if (preferredFinancial && preferredFinancial.estimatedProfit !== null && preferredFinancial.estimatedProfit > 0 && passesThresholds(filters, preferredFinancial.estimatedProfit, preferredFinancial.estimatedMarginPct)) {
          bestReviewCandidate = preferredFinancial;
        }
      }
    }

    const reviewReasonBase = buildNeedsReviewReason({
      decision,
      autoAcceptThreshold,
      listing,
      details,
      chosen: bestReviewCandidate.candidate,
      rankedCandidates: reviewCandidates,
    });
    const reviewReason = triageOutcome.ok
      ? `${reviewReasonBase} • Final review triage: ${triageOutcome.value.reasoning}`
      : reviewReasonBase;

    const reviewShortlistIds = new Set<string>([
      ...decision.topThreeProductIds,
      ...(triageOutcome.ok ? triageOutcome.value.topThreeProductIds : []),
      ...(triageOutcome.ok && triageOutcome.value.preferredProductId ? [triageOutcome.value.preferredProductId] : []),
    ]);

    const resultId = await insertResultPayload(
      scanId,
      listing,
      bestReviewCandidate.candidate,
      decision,
      true,
      reviewReason,
      bestReviewCandidate.estimatedProfit,
      bestReviewCandidate.estimatedMarginPct,
      listingQuality,
      details,
      sellerOutcome,
      scoreListingAgainstFamilyMemory({ ebayTitle: listing.title, scpProductName: bestReviewCandidate.candidate.productName }, familyOutcomeMemory),
      playerMemorySignal,
      auctionMemorySignal,
      priceBandMemorySignal,
      scoreScpCandidateAgainstCardNumberMemory({ ebayTitle: `${listing.title} ${details?.subtitle ?? ''}`.trim(), scpProductName: bestReviewCandidate.candidate.productName, requestedCardNumber: filters.cardNumber ?? null }, cardNumberOutcomeMemory),
    );
    await insertReviewOptions(
      resultId,
      reviewCandidates.map((candidate, index) => reviewOptionPayload(listing, details, candidate, index + 1, triageOutcome.ok ? triageOutcome.value.confidence : decision.confidence, reviewShortlistIds.has(candidate.productId))),
    );
    await appendMetrics(scanId, { needsReview: 1 });
    await updateCandidate(candidateId, { stage: 'needs_review', ai_confidence: triageOutcome.ok ? triageOutcome.value.confidence : decision.confidence, ai_reasoning: triageOutcome.ok ? `${decision.reasoning} • ${triageOutcome.value.reasoning}` : decision.reasoning });
    await addScanEvent(scanId, 'warning', 'ai_verifying', 'Sent listing to Needs Review', `${listing.title}
${reviewReason}
${decision.reasoning}${triageOutcome.ok ? `
${triageOutcome.value.reasoning}` : ''}`);
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

  const diversityDecision = await assessScanResultDiversity(scanId, listing, chosen);
  if (diversityDecision.rejectReason) {
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: diversityDecision.rejectReason });
    await appendMetrics(scanId, { candidatesFilteredOut: 1 });
    await addScanEvent(scanId, 'info', 'publishing_results', diversityDecision.rejectReason, diversityDecision.details ?? listing.title);
    return;
  }

  await insertResultPayload(
    scanId,
    listing,
    chosen,
    decision,
    false,
    null,
    estimatedProfit,
    estimatedMarginPct,
    listingQuality,
    details,
    sellerOutcome,
    scoreListingAgainstFamilyMemory({ ebayTitle: listing.title, scpProductName: chosen.productName }, familyOutcomeMemory),
    playerMemorySignal,
    auctionMemorySignal,
    priceBandMemorySignal,
    chosenCardNumberSignal,
  );
  await appendMetrics(scanId, { dealsFound: 1 });
  await updateCandidate(candidateId, { stage: 'accepted', ai_confidence: decision.confidence, ai_reasoning: decision.reasoning, scp_product_id: chosen.productId });
  await addScanEvent(scanId, 'info', 'publishing_results', 'Added deal result', `${listing.title}\nConfidence ${decision.confidence}`);
}

async function getEbayDetailsWithLogging(scanId: string, listing: EbayListing): Promise<EbayListingDetails | null> {
  const outcome = await withProviderRetries('ebay', 'item detail hydration', () => getEbayListingDetails(listing.itemId), {
    scanId,
    stage: 'matching_scp',
    attempts: 2,
  });

  if (!outcome.ok) {
    await addScanEvent(scanId, outcome.failure.recoverable ? 'warning' : 'error', 'matching_scp', 'Failed to hydrate eBay item details', `${listing.title}\n${formatProviderFailure(outcome.failure)}`);
    return null;
  }

  await incrementUsage('ebay', 1);
  await appendMetrics(scanId, { ebayCalls: 1 });
  return outcome.value;
}

async function insertResultPayload(
  scanId: string,
  listing: EbayListing,
  candidate: ScpCandidate | null,
  decision: Awaited<ReturnType<typeof verifyCardMatchWithOpenAI>>,
  needsReview: boolean,
  reviewReason?: string | null,
  estimatedProfit?: number | null,
  estimatedMarginPct?: number | null,
  listingQuality?: { score: number; summary: string; signals: string[] } | null,
  details?: EbayListingDetails | null,
  sellerOutcome?: Awaited<ReturnType<typeof getSellerOutcomeMemory>> | null,
  familyMemorySignal?: { score: number; reason: string | null; exactFamily: string | null; cluster: string | null } | null,
  playerMemorySignal?: { score: number; reason: string | null; playerKey: string | null } | null,
  auctionMemorySignal?: { score: number; reason: string | null; band: string; familyKey: string | null } | null,
  priceBandMemorySignal?: { score: number; reason: string | null; band: string; familyKey: string | null } | null,
  cardNumberMemorySignal?: { score: number; reason: string | null; category: string; listingToken: string | null; productToken: string | null; requestedToken: string | null; familyKey: string | null } | null,
): Promise<string> {
  const gradingLane = determineGradingLane({
    totalPurchasePrice: listing.total,
    scpUngradedSell: candidate?.ungradedSell ?? null,
    scpGrade9: candidate?.grade9 ?? null,
    scpPsa10: candidate?.psa10 ?? null,
  });
  const sellerUsername = normalizeSellerUsername(details?.sellerUsername);
  const composedReasoning = [
    decision.reasoning,
    listingQuality?.summary,
    sellerUsername ? `Seller ${sellerUsername}` : null,
    sellerOutcome ? `Seller memory: ${sellerOutcome.label}${sellerOutcome.detail ? ` (${sellerOutcome.detail})` : ''}` : null,
    familyMemorySignal?.reason ? `Family memory: ${familyMemorySignal.reason}${familyMemorySignal.exactFamily ? ` (${familyMemorySignal.exactFamily})` : ''}` : null,
    playerMemorySignal?.reason ? `Player memory: ${playerMemorySignal.reason}${playerMemorySignal.playerKey ? ` (${playerMemorySignal.playerKey})` : ''}` : null,
    auctionMemorySignal?.reason ? `Auction memory: ${auctionMemorySignal.reason} (${auctionMemorySignal.band})` : null,
    priceBandMemorySignal?.reason ? `Price-band memory: ${priceBandMemorySignal.reason} (${priceBandMemorySignal.band})` : null,
    cardNumberMemorySignal?.reason ? `Card-number memory: ${cardNumberMemorySignal.reason} (${cardNumberMemorySignal.category}${cardNumberMemorySignal.productToken ? ` • ${cardNumberMemorySignal.productToken}` : ''})` : null,
    `Grade lane: ${gradingLane.label}${gradingLane.detail ? ` (${gradingLane.detail})` : ''}`,
  ]
    .filter(Boolean)
    .join(' • ');

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
    seller_username: sellerUsername,
    seller_feedback_percentage: details?.sellerFeedbackPercentage ?? null,
    seller_feedback_score: details?.sellerFeedbackScore ?? null,
    listing_quality_score: listingQuality?.score ?? null,
    scp_product_id: candidate?.productId ?? null,
    scp_product_name: candidate?.productName ?? null,
    scp_link: candidate?.productUrl ?? null,
    scp_ungraded_sell: candidate?.ungradedSell ?? null,
    scp_grade_9: candidate?.grade9 ?? null,
    scp_psa_10: candidate?.psa10 ?? null,
    estimated_profit: estimatedProfit ?? null,
    estimated_margin_pct: estimatedMarginPct ?? null,
    ai_confidence: decision.confidence,
    ai_chosen_product_id: decision.chosenProductId,
    ai_top_three_product_ids: decision.topThreeProductIds ?? [],
    needs_review: needsReview,
    reasoning: composedReasoning,
    review_reason: reviewReason ?? null,
  });
}

function buildNeedsReviewReason(args: {
  decision: Awaited<ReturnType<typeof verifyCardMatchWithOpenAI>>;
  autoAcceptThreshold: number;
  listing: EbayListing;
  details: EbayListingDetails | null;
  chosen: ScpCandidate | null;
  rankedCandidates: ScpCandidate[];
}): string {
  const reasons: string[] = [];
  if (!args.decision.exactMatch) reasons.push('AI did not confirm an exact SCP match');
  if (args.decision.confidence < args.autoAcceptThreshold) {
    reasons.push(`AI confidence ${Math.round(args.decision.confidence)}% stayed below the ${args.autoAcceptThreshold}% auto-accept line`);
  }
  if (args.chosen) {
    const listingFingerprint = buildListingFingerprint(args.listing, { details: args.details ?? null });
    const comparison = compareFingerprintMatch(listingFingerprint, buildScpCandidateFingerprint(args.chosen));
    if (comparison.negativeSignals.length > 0) {
      reasons.push(comparison.negativeSignals.slice(0, 2).join(' · '));
    } else if (comparison.positiveSignals.length > 0 && comparison.score < 24) {
      reasons.push('Fingerprint evidence was only moderate, so a human check is safer');
    }
  }
  if (args.rankedCandidates.length > 1) {
    reasons.push(`Multiple plausible SCP variants remained in the top ${Math.min(3, args.rankedCandidates.length)}`);
  }
  return reasons.slice(0, 3).join(' • ') || 'Manual review requested for the final SCP variant check.';
}

function reviewOptionPayload(
  listing: EbayListing,
  details: EbayListingDetails | null,
  candidate: ScpCandidate,
  rank: number,
  confidence: number | null,
  aiPreferred: boolean,
): Record<string, unknown> {
  const comparison = compareFingerprintMatch(
    buildListingFingerprint(listing, { details: details ?? null }),
    buildScpCandidateFingerprint(candidate),
  );
  return {
    rank,
    scp_product_id: candidate.productId,
    scp_product_name: candidate.productName,
    scp_link: candidate.productUrl,
    scp_ungraded_sell: candidate.ungradedSell,
    scp_grade_9: candidate.grade9,
    scp_psa_10: candidate.psa10,
    confidence,
    candidate_source: candidate.source ?? null,
    match_score: comparison.score,
    positive_signals: comparison.positiveSignals,
    negative_signals: comparison.negativeSignals,
    ai_preferred: aiPreferred,
  };
}

function shouldUseXimilar(listing: EbayListing, details: EbayListingDetails | null): boolean {
  const imageCount = [listing.imageUrl, ...(details?.imageUrls ?? [])].filter(Boolean).length;
  if (imageCount === 0) return false;
  const lower = `${listing.title} ${details?.subtitle ?? ''}`.toLowerCase();
  return !/#[a-z0-9]+/.test(lower) || lower.includes('prizm') || lower.includes('mosaic') || lower.includes('optic') || lower.includes('refractor');
}

function buildScpQueries(listing: EbayListing, details: EbayListingDetails | null, filters: SearchForm, hints: string[]): string[] {
  const year = extractPrimaryYear(`${listing.title} ${details?.subtitle ?? ''}`) ?? (filters.startYear ? String(filters.startYear) : null);
  const manufacturer = firstAspectValue(details, 'manufacturer') ?? filters.brand ?? null;
  const setName = firstAspectValue(details, 'set', 'insert set') ?? filters.insert ?? filters.variant ?? null;
  const parallel = firstAspectValue(details, 'parallel variety') ?? filters.variant ?? null;
  const cardNumber = filters.cardNumber ?? firstAspectValue(details, 'card number') ?? null;
  const player = filters.playerName ?? firstAspectValue(details, 'athlete', 'player/athlete') ?? null;
  const premiumFlags = [filters.rookie ? 'rookie' : '', filters.autographed ? 'autograph' : '', filters.memorabilia ? 'memorabilia' : ''].filter(Boolean).join(' ');
  const inferredConsoles = inferConsoleCandidatesFromListing(listing, details, filters);

  const queries = new Set<string>();
  for (const consoleName of inferredConsoles.slice(0, 4)) {
    queries.add(compactWhitespace([consoleName, player ?? '', cardNumber ? `#${cardNumber}` : '', premiumFlags].filter(Boolean).join(' ')));
  }
  queries.add(compactWhitespace([year ?? '', manufacturer ?? '', setName ?? '', player ?? '', cardNumber ? `#${cardNumber}` : '', parallel ?? '', premiumFlags].filter(Boolean).join(' ')));
  queries.add(compactWhitespace([year ?? '', manufacturer ?? '', player ?? '', cardNumber ? `#${cardNumber}` : '', filters.insert ?? '', parallel ?? ''].filter(Boolean).join(' ')));
  queries.add(compactWhitespace([listing.title, details?.subtitle ?? '', ...(details ? buildAspectHints(details.aspectMap) : []), hints.join(' ')].join(' ')));

  return [...queries]
    .map((value) => compactWhitespace(tokenizeLoose(value).filter((token) => token.length > 1).slice(0, 20).join(' ')))
    .filter(Boolean)
    .slice(0, 5);
}

function buildScpCacheQueries(baseQueries: string[], consoleName: string, listing: EbayListing, details: EbayListingDetails | null, filters: SearchForm): string[] {
  const year = extractPrimaryYear(`${listing.title} ${details?.subtitle ?? ''}`) ?? (filters.startYear ? String(filters.startYear) : null);
  const manufacturer = firstAspectValue(details, 'manufacturer') ?? filters.brand ?? null;
  const setName = firstAspectValue(details, 'set', 'insert set') ?? filters.insert ?? filters.variant ?? null;
  const cardNumber = filters.cardNumber ?? firstAspectValue(details, 'card number') ?? null;
  const player = filters.playerName ?? firstAspectValue(details, 'athlete', 'player/athlete') ?? null;
  const queries = new Set<string>(baseQueries);
  queries.add(consoleName);
  queries.add(compactWhitespace([consoleName, player ?? '', cardNumber ? `#${cardNumber}` : ''].filter(Boolean).join(' ')));
  queries.add(compactWhitespace([year ?? '', manufacturer ?? '', setName ?? '', player ?? '', cardNumber ? `#${cardNumber}` : ''].filter(Boolean).join(' ')));
  return [...queries].filter(Boolean).slice(0, 6);
}

function buildScpCacheHints(
  listing: EbayListing,
  details: EbayListingDetails | null,
  filters: SearchForm,
  candidatePool: ScpCandidate[],
  hydratedBase: ScpCandidate[],
  scpQueries: string[],
  ximilarHints: string[],
): string[] {
  const hints = new Set<string>();

  for (const inferred of inferConsoleCandidatesFromListing(listing, details, filters)) {
    hints.add(inferred);
  }

  const fromFilters = inferConsoleFromFilters(filters);
  if (fromFilters) hints.add(fromFilters);

  for (const query of scpQueries.slice(0, 4)) {
    hints.add(query);
  }

  for (const candidate of [...hydratedBase, ...candidatePool].slice(0, 10)) {
    if (candidate.consoleName) hints.add(candidate.consoleName);
  }

  const year = extractPrimaryYear(`${listing.title} ${details?.subtitle ?? ''}`);
  if (year && filters.brand) {
    hints.add(`${filters.sport} cards ${year} ${filters.brand}`);
  }
  if (year && filters.brand && filters.variant) {
    hints.add(`${filters.sport} cards ${year} ${filters.brand} ${filters.variant}`);
  }
  if (year && filters.brand && filters.insert) {
    hints.add(`${filters.sport} cards ${year} ${filters.brand} ${filters.insert}`);
  }

  for (const hint of ximilarHints.slice(0, 4)) {
    hints.add(hint);
  }

  hints.add(listing.title);
  if (details?.subtitle) hints.add(details.subtitle);

  return [...hints].map((value) => compactWhitespace(value)).filter(Boolean);
}

function inferConsoleFromFilters(filters: SearchForm): string | null {
  const year = filters.startYear && filters.endYear && filters.startYear === filters.endYear ? filters.startYear : filters.startYear ?? filters.endYear ?? null;
  const pieces = [filters.sport ? `${filters.sport} cards` : '', year ? String(year) : '', filters.brand ?? '', filters.variant ?? filters.insert ?? ''];
  const output = compactWhitespace(pieces.join(' '));
  return output || null;
}

function extractPrimaryYear(value: string): string | null {
  return value.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
}

function buildAspectHints(aspects: Record<string, string[]>): string[] {
  const keys = ['manufacturer', 'set', 'insert set', 'parallel variety', 'card number', 'athlete', 'team', 'features'];
  return keys.flatMap((key) => aspects[key] ?? []).slice(0, 10);
}

function rankScpCandidatesLocally(
  listing: EbayListing,
  details: EbayListingDetails | null,
  filters: SearchForm,
  candidates: ScpCandidate[],
  reviewResolutionMemory?: ReturnType<typeof buildReviewResolutionMemory>,
  cardNumberOutcomeMemory?: ReturnType<typeof buildCardNumberOutcomeMemory>,
): Array<{ candidate: ScpCandidate; score: number; reviewMemory: ReturnType<typeof scoreScpCandidateAgainstReviewMemory>; cardNumberMemory: ReturnType<typeof scoreScpCandidateAgainstCardNumberMemory> }> {
  const sourceTitle = `${listing.title} ${details?.subtitle ?? ''}`.trim();
  const fingerprint = normalizeTitleFingerprint(sourceTitle);
  return [...candidates]
    .map((candidate) => {
      const reviewMemory = scoreScpCandidateAgainstReviewMemory(
        { ebayTitle: sourceTitle, candidateProductId: candidate.productId, candidateProductName: candidate.productName },
        reviewResolutionMemory,
      );
      const cardNumberMemory = scoreScpCandidateAgainstCardNumberMemory({ ebayTitle: sourceTitle, scpProductName: candidate.productName, requestedCardNumber: filters.cardNumber ?? null }, cardNumberOutcomeMemory);
      return {
        candidate,
        score: scoreCandidate(fingerprint, listing, details, candidate, reviewMemory.score, cardNumberMemory.score),
        reviewMemory,
        cardNumberMemory,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function scoreCandidate(
  fingerprint: string,
  listing: EbayListing,
  details: EbayListingDetails | null,
  candidate: ScpCandidate,
  reviewMemoryScore = 0,
  cardNumberMemoryScore = 0,
): number {
  const haystack = `${candidate.productName} ${candidate.consoleName ?? ''}`.toLowerCase();
  let score = 0;

  for (const token of tokenizeLoose(fingerprint)) {
    if (token.length > 2 && haystack.includes(token)) score += token.startsWith('#') ? 12 : 3;
  }

  const numberMatch = candidate.productName.match(/#([a-z0-9-]+)/i);
  if (numberMatch && fingerprint.includes(`#${numberMatch[1].toLowerCase()}`)) score += 18;

  const bracketMatch = candidate.productName.match(/\[[^\]]+\]/g) ?? [];
  for (const variant of bracketMatch) {
    const normalizedVariant = variant.toLowerCase().replace(/[\[\]]/g, '');
    if (fingerprint.includes(normalizedVariant)) score += 10;
  }

  if (/\[rc\]|rookie/i.test(candidate.productName) && /rookie|\brc\b/i.test(fingerprint)) score += 4;
  if (/auto|autograph/i.test(candidate.productName) && /auto|autograph|signed/i.test(fingerprint)) score += 6;
  if (/memorabilia|patch|relic|jersey/i.test(candidate.productName) && /memorabilia|patch|relic|jersey/i.test(fingerprint)) score += 6;
  if (candidate.ungradedSell !== null) score += 1;
  if (candidate.source === 'cache') score += 2;

  const aspectSignals = details ? buildAspectHints(details.aspectMap).join(' ').toLowerCase() : '';
  if (aspectSignals) {
    for (const token of tokenizeLoose(aspectSignals)) {
      if (token.length > 2 && haystack.includes(token)) score += 2;
    }
  }

  if (listing.condition?.toLowerCase().includes('graded') && /psa|bgs|sgc|graded/i.test(candidate.productName)) score += 3;
  score += reviewMemoryScore;
  score += cardNumberMemoryScore;
  return score;
}

function inferConsoleCandidatesFromListing(listing: EbayListing, details: EbayListingDetails | null, filters?: SearchForm): string[] {
  const setValue = firstAspectValue(details, 'set', 'insert set') ?? filters?.insert ?? filters?.variant ?? null;
  const manufacturer = firstAspectValue(details, 'manufacturer') ?? filters?.brand ?? null;
  const parallel = firstAspectValue(details, 'parallel variety') ?? filters?.variant ?? null;
  const year = extractPrimaryYear(`${listing.title} ${details?.subtitle ?? ''}`) ?? (filters?.startYear ? String(filters.startYear) : null);
  const sportPrefix = filters?.sport ? `${filters.sport} cards` : listing.title.toLowerCase().includes('football') ? 'football cards' : '';
  const values = new Set<string>();

  if (manufacturer && setValue && year) {
    values.add(compactWhitespace(`${sportPrefix} ${year} ${manufacturer} ${setValue}`));
    values.add(compactWhitespace(`${year} ${manufacturer} ${setValue}`));
  }
  if (manufacturer && setValue && year && parallel && !setValue.toLowerCase().includes(parallel.toLowerCase())) {
    values.add(compactWhitespace(`${sportPrefix} ${year} ${manufacturer} ${setValue} ${parallel}`));
    values.add(compactWhitespace(`${year} ${manufacturer} ${setValue} ${parallel}`));
  }
  if (manufacturer && parallel && year) {
    values.add(compactWhitespace(`${sportPrefix} ${year} ${manufacturer} ${parallel}`));
  }
  if (manufacturer && setValue) {
    values.add(compactWhitespace(`${manufacturer} ${setValue}`));
  }
  return [...values].filter(Boolean);
}

function firstAspectValue(details: EbayListingDetails | null, ...keys: string[]): string | null {
  if (!details) return null;
  for (const key of keys) {
    const value = details.aspectMap[key]?.[0];
    if (value) return value;
  }
  return null;
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

function prioritizeListingsForScan(
  listings: EbayListing[],
  filters: SearchForm,
  existingRows: Array<{ ebayTitle: string; scpProductName: string | null; needsReview: boolean }>,
  titleOutcomeMemory: ReturnType<typeof buildTitleOutcomeMemory>,
  familyOutcomeMemory: ReturnType<typeof buildFamilyOutcomeMemory>,
  playerOutcomeMemory: ReturnType<typeof buildPlayerOutcomeMemory>,
  auctionOutcomeMemory: ReturnType<typeof buildAuctionOutcomeMemory>,
  priceBandOutcomeMemory: ReturnType<typeof buildPriceBandOutcomeMemory>,
): Array<{ listing: EbayListing; score: number; reasons: string[] }> {
  const existingFamilies = new Set<string>();
  const existingClusterCounts = new Map<string, number>();

  for (const row of existingRows) {
    const keys = buildDealDiversityKeys({ ebayTitle: row.ebayTitle, scpProductName: row.scpProductName });
    if (keys.exactFamily) existingFamilies.add(keys.exactFamily);
    if (keys.cluster) existingClusterCounts.set(keys.cluster, (existingClusterCounts.get(keys.cluster) ?? 0) + 1);
  }

  const pageFamilyCounts = new Map<string, number>();
  const pageClusterCounts = new Map<string, number>();
  for (const listing of listings) {
    const keys = buildDealDiversityKeys({ ebayTitle: listing.title });
    if (keys.exactFamily) pageFamilyCounts.set(keys.exactFamily, (pageFamilyCounts.get(keys.exactFamily) ?? 0) + 1);
    if (keys.cluster) pageClusterCounts.set(keys.cluster, (pageClusterCounts.get(keys.cluster) ?? 0) + 1);
  }

  return listings
    .map((listing) => {
      const keys = buildDealDiversityKeys({ ebayTitle: listing.title });
      const titleMemorySignal = scoreListingAgainstTitleMemory(listing.title, titleOutcomeMemory);
      const familyMemorySignal = scoreListingAgainstFamilyMemory({ ebayTitle: listing.title }, familyOutcomeMemory);
      const playerMemorySignal = scoreListingAgainstPlayerMemory({ ebayTitle: listing.title, requestedPlayerName: filters.playerName ?? null }, playerOutcomeMemory);
      const auctionMemorySignal = scoreListingAgainstAuctionMemory({ ebayTitle: listing.title, auctionEndsAt: listing.auctionEndsAt }, auctionOutcomeMemory);
      const priceBandMemorySignal = scoreListingAgainstPriceBandMemory({ ebayTitle: listing.title, totalPurchasePrice: listing.total }, priceBandOutcomeMemory);
      const baseScore = scoreListingPriority({
        title: listing.title,
        price: listing.price,
        shipping: listing.shipping,
        imageUrl: listing.imageUrl,
        auctionEndsAt: listing.auctionEndsAt,
        condition: listing.condition,
        filters,
      }) + titleMemorySignal.score + familyMemorySignal.score + playerMemorySignal.score + auctionMemorySignal.score + priceBandMemorySignal.score;

      let penalty = 0;
      const reasons: string[] = [];
      if (titleMemorySignal.reason && titleMemorySignal.score !== 0) reasons.push(titleMemorySignal.reason);
      if (familyMemorySignal.reason && familyMemorySignal.score !== 0) reasons.push(familyMemorySignal.reason);
      if (playerMemorySignal.reason && playerMemorySignal.score !== 0) reasons.push(playerMemorySignal.reason);
      if (auctionMemorySignal.reason && auctionMemorySignal.score !== 0) reasons.push(auctionMemorySignal.reason);
      if (priceBandMemorySignal.reason && priceBandMemorySignal.score !== 0) reasons.push(priceBandMemorySignal.reason);
      if (keys.exactFamily && existingFamilies.has(keys.exactFamily)) {
        penalty += 34;
        reasons.push('family already shown');
      }

      const clusterCount = keys.cluster ? (existingClusterCounts.get(keys.cluster) ?? 0) : 0;
      if (clusterCount > 0) {
        penalty += Math.min(20, clusterCount * 8);
        reasons.push(`cluster ${clusterCount}`);
      }

      const pageFamilyCount = keys.exactFamily ? (pageFamilyCounts.get(keys.exactFamily) ?? 0) : 0;
      if (pageFamilyCount > 1) {
        penalty += Math.min(14, (pageFamilyCount - 1) * 5);
        reasons.push(`page family x${pageFamilyCount}`);
      }

      const pageClusterCount = keys.cluster ? (pageClusterCounts.get(keys.cluster) ?? 0) : 0;
      if (pageClusterCount > 1) {
        penalty += Math.min(10, (pageClusterCount - 1) * 3);
      }

      return {
        listing,
        score: Math.max(0, baseScore - penalty),
        reasons,
      };
    })
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const leftTime = left.listing.auctionEndsAt ? new Date(left.listing.auctionEndsAt).getTime() : 0;
      const rightTime = right.listing.auctionEndsAt ? new Date(right.listing.auctionEndsAt).getTime() : 0;
      if (leftTime && rightTime && leftTime !== rightTime) return leftTime - rightTime;
      return left.listing.total - right.listing.total;
    });
}

async function assessScanResultDiversity(
  scanId: string,
  listing: EbayListing,
  candidate: ScpCandidate | null,
): Promise<{ rejectReason: string | null; details: string | null }> {
  const existingRows = await getScanResultMemory(scanId);
  if (existingRows.length === 0) {
    return { rejectReason: null, details: null };
  }

  const incomingKeys = buildDealDiversityKeys({ ebayTitle: listing.title, scpProductName: candidate?.productName ?? null });
  let exactFamilyCount = 0;
  let clusterCount = 0;
  let closestTitle: string | null = null;
  let bestSimilarity = 0;

  for (const row of existingRows) {
    const existingKeys = buildDealDiversityKeys({ ebayTitle: row.ebayTitle, scpProductName: row.scpProductName });
    if (existingKeys.exactFamily && existingKeys.exactFamily === incomingKeys.exactFamily) {
      exactFamilyCount += 1;
    }
    if (existingKeys.cluster && existingKeys.cluster === incomingKeys.cluster) {
      clusterCount += 1;
    }

    const similarity = Math.max(
      tokenSimilarity(incomingKeys.exactFamily, existingKeys.exactFamily),
      tokenSimilarity(listing.title, row.ebayTitle),
    );
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      closestTitle = row.ebayTitle;
    }
  }

  if (exactFamilyCount >= MAX_EXACT_FAMILY_RESULTS) {
    return {
      rejectReason: 'Skipped near-duplicate result family already captured this scan',
      details: closestTitle ? `${incomingKeys.exactFamily}
Closest existing: ${closestTitle}` : incomingKeys.exactFamily,
    };
  }

  if (clusterCount >= MAX_CLUSTER_RESULTS && bestSimilarity >= 0.48) {
    return {
      rejectReason: 'Skipped result to preserve scan diversity within the same player/set cluster',
      details: closestTitle ? `${incomingKeys.cluster}
Closest existing: ${closestTitle}` : incomingKeys.cluster,
    };
  }

  return { rejectReason: null, details: null };
}

function passesThresholds(filters: SearchForm, estimatedProfit: number, estimatedMarginPct: number | null): boolean {
  if (filters.minProfit && estimatedProfit < filters.minProfit) return false;
  if (filters.minMarginPct && (estimatedMarginPct ?? 0) < filters.minMarginPct) return false;
  return true;
}



type ProviderRetryOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ReturnType<typeof classifyProviderFailure> };

async function withProviderRetries<T>(
  provider: 'ebay' | 'scp' | 'openai' | 'ximilar',
  action: string,
  fn: () => Promise<T>,
  options: { scanId: string; stage: string; attempts?: number },
): Promise<ProviderRetryOutcome<T>> {
  const attempts = Math.max(1, options.attempts ?? 2);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      const failure = classifyProviderFailure(provider, error);
      const shouldRetry = failure.recoverable && attempt < attempts;
      const detail = `${action} attempt ${attempt}/${attempts}
${formatProviderFailure(failure)}`;
      await addScanEvent(options.scanId, shouldRetry ? 'warning' : failure.recoverable ? 'warning' : 'error', options.stage, `${provider.toUpperCase()} ${action} failed`, detail);
      if (!shouldRetry) {
        return { ok: false, failure };
      }
      await sleep(450 * attempt);
    }
  }

  return { ok: false, failure: classifyProviderFailure(provider, new Error(`${provider} ${action} failed`)) };
}

function shouldStopAfterLowYieldStreak(
  events: Array<{ stage: string; message: string }>,
): boolean {
  const summaries = events.filter((event) => event.stage === 'worker_summary').slice(0, LOW_YIELD_STREAK_TO_STOP);
  return summaries.length >= LOW_YIELD_STREAK_TO_STOP && summaries.every((event) => event.message === 'No publishable results from batch');
}


async function getTitleOutcomeMemoryCached(): Promise<ReturnType<typeof buildTitleOutcomeMemory>> {
  if (titleOutcomeMemoryCache && Date.now() - titleOutcomeMemoryCache.loadedAt < TITLE_OUTCOME_CACHE_TTL_MS) {
    return titleOutcomeMemoryCache.memory;
  }
  const rows = await getRecentTitleOutcomeMemory(400);
  const memory = buildTitleOutcomeMemory(rows);
  titleOutcomeMemoryCache = { loadedAt: Date.now(), memory };
  return memory;
}

async function getFamilyOutcomeMemoryCached(): Promise<ReturnType<typeof buildFamilyOutcomeMemory>> {
  if (familyOutcomeMemoryCache && Date.now() - familyOutcomeMemoryCache.loadedAt < FAMILY_OUTCOME_CACHE_TTL_MS) {
    return familyOutcomeMemoryCache.memory;
  }
  const rows = await getRecentFamilyOutcomeMemory(500);
  const memory = buildFamilyOutcomeMemory(rows);
  familyOutcomeMemoryCache = { loadedAt: Date.now(), memory };
  return memory;
}

async function getPlayerOutcomeMemoryCached(): Promise<ReturnType<typeof buildPlayerOutcomeMemory>> {
  if (playerOutcomeMemoryCache && Date.now() - playerOutcomeMemoryCache.loadedAt < PLAYER_OUTCOME_CACHE_TTL_MS) {
    return playerOutcomeMemoryCache.memory;
  }
  const rows = await getRecentPlayerOutcomeMemory(520);
  const memory = buildPlayerOutcomeMemory(rows);
  playerOutcomeMemoryCache = { loadedAt: Date.now(), memory };
  return memory;
}

async function getReviewResolutionMemoryCached(): Promise<ReturnType<typeof buildReviewResolutionMemory>> {
  if (reviewResolutionMemoryCache && Date.now() - reviewResolutionMemoryCache.loadedAt < REVIEW_RESOLUTION_CACHE_TTL_MS) {
    return reviewResolutionMemoryCache.memory;
  }
  const rows = await getRecentReviewResolutionMemory(140);
  const memory = buildReviewResolutionMemory(rows);
  reviewResolutionMemoryCache = { loadedAt: Date.now(), memory };
  return memory;
}

async function getAuctionOutcomeMemoryCached(): Promise<ReturnType<typeof buildAuctionOutcomeMemory>> {
  if (auctionOutcomeMemoryCache && Date.now() - auctionOutcomeMemoryCache.loadedAt < AUCTION_OUTCOME_CACHE_TTL_MS) {
    return auctionOutcomeMemoryCache.memory;
  }
  const rows = await getRecentAuctionOutcomeMemory(420);
  const memory = buildAuctionOutcomeMemory(rows);
  auctionOutcomeMemoryCache = { loadedAt: Date.now(), memory };
  return memory;
}

async function getPriceBandOutcomeMemoryCached(): Promise<ReturnType<typeof buildPriceBandOutcomeMemory>> {
  if (priceBandOutcomeMemoryCache && Date.now() - priceBandOutcomeMemoryCache.loadedAt < PRICE_BAND_OUTCOME_CACHE_TTL_MS) {
    return priceBandOutcomeMemoryCache.memory;
  }
  const rows = await getRecentPriceBandOutcomeMemory(520);
  const memory = buildPriceBandOutcomeMemory(rows);
  priceBandOutcomeMemoryCache = { loadedAt: Date.now(), memory };
  return memory;
}

async function getCardNumberOutcomeMemoryCached(): Promise<ReturnType<typeof buildCardNumberOutcomeMemory>> {
  if (cardNumberOutcomeMemoryCache && Date.now() - cardNumberOutcomeMemoryCache.loadedAt < CARD_NUMBER_OUTCOME_CACHE_TTL_MS) {
    return cardNumberOutcomeMemoryCache.memory;
  }
  const rows = await getRecentCardNumberOutcomeMemory(520);
  const memory = buildCardNumberOutcomeMemory(rows);
  cardNumberOutcomeMemoryCache = { loadedAt: Date.now(), memory };
  return memory;
}

async function getSellerOutcomeMemoryCached(sellerUsername: string): Promise<Awaited<ReturnType<typeof getSellerOutcomeMemory>>> {
  const normalized = normalizeSellerUsername(sellerUsername);
  if (!normalized) return null;
  const cached = sellerOutcomeCache.get(normalized);
  if (cached && Date.now() - cached.loadedAt < SELLER_OUTCOME_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await getSellerOutcomeMemory(normalized);
  sellerOutcomeCache.set(normalized, { loadedAt: Date.now(), value });
  return value;
}

async function getBadLogicPatternsCached(): Promise<Array<{ ebayTitle: string; fingerprint: string; createdAt: string; reasoning: string | null }>> {
  if (badLogicCache && Date.now() - badLogicCache.loadedAt < BAD_LOGIC_CACHE_TTL_MS) {
    return badLogicCache.rows;
  }
  const rows = await getRecentBadLogicPatterns(250);
  badLogicCache = { loadedAt: Date.now(), rows };
  return rows;
}

async function findBadLogicPatternMatch(sourceTitle: string): Promise<{ matchedTitle: string; reason: string; similarity: number } | null> {
  const fingerprint = normalizeTitleFingerprint(sourceTitle);
  if (!fingerprint) return null;

  const priorRows = await getBadLogicPatternsCached();
  const currentCardNumber = extractCardNumberToken(fingerprint);
  let best: { matchedTitle: string; reason: string; similarity: number } | null = null;

  for (const row of priorRows) {
    if (!row.fingerprint) continue;
    if (row.fingerprint === fingerprint) {
      return {
        matchedTitle: row.ebayTitle,
        reason: row.reasoning ?? 'same normalized title',
        similarity: 1,
      };
    }

    const similarity = tokenSimilarity(fingerprint, row.fingerprint);
    if (similarity < 0.82) continue;

    const rowCardNumber = extractCardNumberToken(row.fingerprint);
    if (currentCardNumber && rowCardNumber && currentCardNumber !== rowCardNumber) continue;

    if (!best || similarity > best.similarity) {
      best = {
        matchedTitle: row.ebayTitle,
        reason: row.reasoning ?? `very similar prior bad logic title (${Math.round(similarity * 100)}% token overlap)`,
        similarity,
      };
    }
  }

  return best;
}

function extractCardNumberToken(value: string): string | null {
  const hashMatch = value.match(/#([a-z0-9-]{1,8})/i)?.[1];
  if (hashMatch) return hashMatch.toLowerCase();

  for (const token of tokenizeLoose(value)) {
    const normalized = token.replace(/^#/, '');
    if (!normalized || normalized.length > 8) continue;
    if (/\d/.test(normalized)) return normalized.toLowerCase();
  }
  return null;
}


function getTickBudget(currentResults: number, dealsFound: number): number {
  if (currentResults >= 9 && dealsFound >= 6) return MIN_CANDIDATES_PER_TICK;
  if (currentResults >= 8 && dealsFound >= 5) return 2;
  return MAX_CANDIDATES_PER_TICK;
}
