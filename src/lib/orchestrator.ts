import { getEbayListingDetails, searchEbayListings, type EbayListing, type EbayListingDetails } from '@/lib/ebay';
import {
  addScanEvent,
  appendMetrics,
  findScpCacheMatches,
  getExceededUsageLimits,
  getManualMatchOverride,
  getRecentBadLogicPatterns,
  getScanById,
  getScanResultMemory,
  getScpCacheCsvTextByStoragePath,
  incrementUsage,
  insertCandidate,
  insertResult,
  insertReviewOptions,
  markScanStatus,
  updateCandidate,
  upsertDedupeItem,
} from '@/lib/db';
import { shouldRejectListingDetails, shouldRejectTitle } from '@/lib/filters';
import { verifyCardMatchWithOpenAI } from '@/lib/openai';
import {
  getSportsCardsProProduct,
  hydrateSportsCardsProCandidates,
  searchScpCsvCandidates,
  searchSportsCardsProCandidates,
  type ScpCandidate,
} from '@/lib/scp';
import { identifyWithXimilar } from '@/lib/ximilar';
import {
  buildDealDiversityKeys,
  compactWhitespace,
  determineGradingLane,
  normalizeTitleFingerprint,
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
const MAX_EXACT_FAMILY_RESULTS = 1;
const MAX_CLUSTER_RESULTS = 2;

let badLogicCache: { loadedAt: number; rows: Array<{ ebayTitle: string; fingerprint: string; createdAt: string; reasoning: string | null }> } | null = null;

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
  const offset = scan.metrics.candidatesFetched;
  const listings = await searchEbayListings(scan.filters, offset, FETCH_PAGE_SIZE);
  await incrementUsage('ebay', 1);
  await appendMetrics(scanId, { ebayCalls: 1, candidatesFetched: listings.length });
  await addScanEvent(scanId, 'info', 'fetching_ebay', `Fetched ${listings.length} eBay candidates`, `Offset ${offset}`);

  if (listings.length === 0) {
    await markScanStatus(scanId, 'completed', 'No more eBay listings returned');
    return (await getScanById(scanId))!;
  }

  const existingResultMemory = await getScanResultMemory(scanId);
  const prioritizedListings = prioritizeListingsForScan(listings, scan.filters, existingResultMemory);
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
  const aspectCount = Object.values(details?.aspectMap ?? {}).reduce((sum, values) => sum + values.length, 0);
  const imageCount = [listing.imageUrl, ...(details?.imageUrls ?? [])].filter(Boolean).length;
  const listingQuality = scoreSellerListingQuality({
    sellerFeedbackPercentage: details?.sellerFeedbackPercentage ?? null,
    sellerFeedbackScore: details?.sellerFeedbackScore ?? null,
    imageCount,
    description: details?.description ?? null,
    aspectMap: details?.aspectMap ?? null,
    condition: details?.condition ?? listing.condition ?? null,
  });
  const lowTrustReason = shouldRejectLowTrustListing({
    score: listingQuality.score,
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
${listingQuality.summary}`);
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

  await addScanEvent(scanId, 'info', 'matching_scp', 'Hydrated listing quality', listingQuality.summary);

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

  const scpQuery = buildScpQuery(listing, details, ximilarHints?.titleHints ?? []);
  const baseCandidates = await searchSportsCardsProCandidates(scpQuery);
  await incrementUsage('scp', 1);
  await appendMetrics(scanId, { scpCalls: 1 });

  let candidatePool = [...baseCandidates];
  const hydratedBase = await hydrateSportsCardsProCandidates(rankScpCandidatesLocally(listing, details, baseCandidates).slice(0, 5).map((row) => row.productId));
  if (hydratedBase.length > 0) {
    await incrementUsage('scp', hydratedBase.length);
    await appendMetrics(scanId, { scpCalls: hydratedBase.length });
    candidatePool = mergeCandidates(candidatePool, hydratedBase);
  }

  const cacheHints = buildScpCacheHints(listing, details, filters, candidatePool, hydratedBase, ximilarHints?.titleHints ?? []);
  const matchedCaches = await findScpCacheMatches(cacheHints, 3);
  const loadedCacheNames: string[] = [];
  for (const cacheEntry of matchedCaches.slice(0, 2)) {
    if (!cacheEntry.storagePath) continue;
    const cachedCsv = await getScpCacheCsvTextByStoragePath(cacheEntry.storagePath);
    if (!cachedCsv) continue;
    const cacheCandidates = searchScpCsvCandidates(cachedCsv, scpQuery, 16);
    if (cacheCandidates.length > 0) {
      candidatePool = mergeCandidates(candidatePool, cacheCandidates);
      loadedCacheNames.push(cacheEntry.consoleName);
    }
  }
  if (loadedCacheNames.length > 0) {
    await addScanEvent(scanId, 'info', 'matching_scp', 'Loaded SCP set cache', loadedCacheNames.join(' • '));
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
          estimatedProfit,
          estimatedMarginPct,
          listingQuality,
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
  const rankedCandidates = rankScpCandidatesLocally(listing, details, candidatePool).slice(0, 5);
  const decision = await verifyCardMatchWithOpenAI(listing, rankedCandidates, {
    ximilarHints: ximilarHints?.titleHints ?? [],
    details,
  });
  await incrementUsage('openai', 1);
  await appendMetrics(scanId, { openaiCalls: 1 });

  const chosen = rankedCandidates.find((candidate) => candidate.productId === decision.chosenProductId) ?? rankedCandidates[0] ?? null;

  if (!decision.exactMatch || decision.confidence < AUTO_ACCEPT_CONFIDENCE || !chosen) {
    const diversityDecision = await assessScanResultDiversity(scanId, listing, rankedCandidates[0] ?? null);
    if (diversityDecision.rejectReason) {
      await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: diversityDecision.rejectReason });
      await appendMetrics(scanId, { candidatesFilteredOut: 1 });
      await addScanEvent(scanId, 'info', 'publishing_results', diversityDecision.rejectReason, diversityDecision.details ?? listing.title);
      return;
    }

    const placeholderCandidate = rankedCandidates[0] ?? null;
    const placeholderProfit = placeholderCandidate?.ungradedSell !== null && placeholderCandidate?.ungradedSell !== undefined
      ? placeholderCandidate.ungradedSell - listing.total
      : null;
    const placeholderMargin = placeholderCandidate?.ungradedSell && placeholderProfit !== null ? (placeholderProfit / listing.total) * 100 : null;
    const resultId = await insertResultPayload(scanId, listing, placeholderCandidate, decision, true, placeholderProfit, placeholderMargin, listingQuality);
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

  const diversityDecision = await assessScanResultDiversity(scanId, listing, chosen);
  if (diversityDecision.rejectReason) {
    await updateCandidate(candidateId, { stage: 'rejected', rejection_reason: diversityDecision.rejectReason });
    await appendMetrics(scanId, { candidatesFilteredOut: 1 });
    await addScanEvent(scanId, 'info', 'publishing_results', diversityDecision.rejectReason, diversityDecision.details ?? listing.title);
    return;
  }

  await insertResultPayload(scanId, listing, chosen, decision, false, estimatedProfit, estimatedMarginPct, listingQuality);
  await appendMetrics(scanId, { dealsFound: 1 });
  await updateCandidate(candidateId, { stage: 'accepted', ai_confidence: decision.confidence, ai_reasoning: decision.reasoning, scp_product_id: chosen.productId });
  await addScanEvent(scanId, 'info', 'publishing_results', 'Added deal result', `${listing.title}\nConfidence ${decision.confidence}`);
}

async function getEbayDetailsWithLogging(scanId: string, listing: EbayListing): Promise<EbayListingDetails | null> {
  try {
    const details = await getEbayListingDetails(listing.itemId);
    await incrementUsage('ebay', 1);
    await appendMetrics(scanId, { ebayCalls: 1 });
    return details;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load eBay item details';
    await addScanEvent(scanId, 'warning', 'matching_scp', 'Failed to hydrate eBay item details', `${listing.title}\n${message}`);
    return null;
  }
}

async function insertResultPayload(
  scanId: string,
  listing: EbayListing,
  candidate: ScpCandidate | null,
  decision: Awaited<ReturnType<typeof verifyCardMatchWithOpenAI>>,
  needsReview: boolean,
  estimatedProfit?: number | null,
  estimatedMarginPct?: number | null,
  listingQuality?: { score: number; summary: string; signals: string[] } | null,
): Promise<string> {
  const gradingLane = determineGradingLane({
    totalPurchasePrice: listing.total,
    scpUngradedSell: candidate?.ungradedSell ?? null,
    scpGrade9: candidate?.grade9 ?? null,
    scpPsa10: candidate?.psa10 ?? null,
  });
  const composedReasoning = [decision.reasoning, listingQuality?.summary, `Grade lane: ${gradingLane.label}${gradingLane.detail ? ` (${gradingLane.detail})` : ''}`]
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
    reasoning: composedReasoning,
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

function shouldUseXimilar(listing: EbayListing, details: EbayListingDetails | null): boolean {
  const imageCount = [listing.imageUrl, ...(details?.imageUrls ?? [])].filter(Boolean).length;
  if (imageCount === 0) return false;
  const lower = `${listing.title} ${details?.subtitle ?? ''}`.toLowerCase();
  return !/#[a-z0-9]+/.test(lower) || lower.includes('prizm') || lower.includes('mosaic') || lower.includes('optic') || lower.includes('refractor');
}

function buildScpQuery(listing: EbayListing, details: EbayListingDetails | null, hints: string[]): string {
  const pieces = [
    listing.title,
    details?.subtitle ?? '',
    ...(details ? buildAspectHints(details.aspectMap) : []),
    hints.join(' '),
  ];
  const tokens = tokenizeLoose(pieces.join(' '))
    .filter((token) => token.length > 1)
    .slice(0, 20);
  return compactWhitespace(tokens.join(' '));
}


function buildScpCacheHints(
  listing: EbayListing,
  details: EbayListingDetails | null,
  filters: SearchForm,
  candidatePool: ScpCandidate[],
  hydratedBase: ScpCandidate[],
  ximilarHints: string[],
): string[] {
  const hints = new Set<string>();
  const inferredConsole = inferConsoleFromListing(listing, details, filters);
  if (inferredConsole) hints.add(inferredConsole);

  const fromFilters = inferConsoleFromFilters(filters);
  if (fromFilters) hints.add(fromFilters);

  for (const candidate of [...hydratedBase, ...candidatePool].slice(0, 8)) {
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

function rankScpCandidatesLocally(listing: EbayListing, details: EbayListingDetails | null, candidates: ScpCandidate[]): ScpCandidate[] {
  const fingerprint = normalizeTitleFingerprint(`${listing.title} ${details?.subtitle ?? ''}`);
  return [...candidates].sort((a, b) => scoreCandidate(fingerprint, listing, details, b) - scoreCandidate(fingerprint, listing, details, a));
}

function scoreCandidate(fingerprint: string, listing: EbayListing, details: EbayListingDetails | null, candidate: ScpCandidate): number {
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
  return score;
}

function inferConsoleFromListing(listing: EbayListing, details: EbayListingDetails | null, filters?: SearchForm): string | null {
  const setValue = details?.aspectMap.set?.[0] ?? details?.aspectMap['insert set']?.[0] ?? filters?.variant ?? filters?.insert ?? null;
  const manufacturer = details?.aspectMap.manufacturer?.[0] ?? filters?.brand ?? null;
  const year = extractPrimaryYear(`${listing.title} ${details?.subtitle ?? ''}`) ?? (filters?.startYear ? String(filters.startYear) : null);
  const sportPrefix = filters?.sport ? `${filters.sport} cards` : listing.title.toLowerCase().includes('football') ? 'football cards' : '';
  if (!manufacturer || !setValue || !year) return null;
  return `${sportPrefix} ${year} ${manufacturer} ${setValue}`.replace(/\s+/g, ' ').trim();
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
      const baseScore = scoreListingPriority({
        title: listing.title,
        price: listing.price,
        shipping: listing.shipping,
        imageUrl: listing.imageUrl,
        auctionEndsAt: listing.auctionEndsAt,
        condition: listing.condition,
        filters,
      });

      let penalty = 0;
      const reasons: string[] = [];
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
