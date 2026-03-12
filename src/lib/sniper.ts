import type { EbayListing, EbayListingDetails } from '@/lib/ebay';
import type { ScpCandidate } from '@/lib/scp';
import type { SearchForm } from '@/types/app';
import {
  buildListingFingerprint,
  buildScpCandidateFingerprint,
  compareFingerprintMatch,
  listingContainsCandidatePlayer,
  normalizeFamilyKey,
  type CardFingerprint,
} from '@/lib/card-fingerprint';
import { compactWhitespace } from '@/lib/utils';

export type SniperProfile = {
  active: boolean;
  familyKey: string | null;
  requiredYear: string | null;
  label: string;
  requireRaw: boolean;
  requireNumbered: boolean;
  requireCardNumber: boolean;
};

export function getSniperDefaultFilters(): SearchForm {
  return {
    sport: 'Football',
    startYear: 2024,
    endYear: 2024,
    brand: 'Panini',
    variant: 'Prizm',
    numberedCard: true,
    conditionMode: 'raw',
    listingMode: 'buy_now',
    rookie: false,
    autographed: false,
    memorabilia: false,
    auctionHours: null,
    minPurchasePrice: null,
    maxPurchasePrice: null,
    minProfit: null,
    minMarginPct: null,
  };
}

export function getSniperProfile(filters: SearchForm): SniperProfile {
  const singleYear = filters.startYear && filters.endYear && filters.startYear === filters.endYear
    ? String(filters.startYear)
    : filters.startYear && !filters.endYear
      ? String(filters.startYear)
      : null;
  const familyKey = normalizeFamilyKey([filters.brand ?? '', filters.variant ?? '', filters.insert ?? ''].filter(Boolean).join(' '));
  const active = Boolean(filters.sport && singleYear && familyKey && filters.numberedCard && filters.conditionMode === 'raw');
  return {
    active,
    familyKey,
    requiredYear: singleYear,
    label: active ? compactWhitespace([filters.sport, singleYear ?? '', familyKey ?? '', 'numbered raw sniper'].join(' ')) : 'Broad scan',
    requireRaw: active,
    requireNumbered: active && Boolean(filters.numberedCard),
    requireCardNumber: active,
  };
}

export function validateListingForSniperLane(listing: EbayListing, details: EbayListingDetails | null, filters: SearchForm): {
  rejectReason: string | null;
  fingerprint: CardFingerprint;
  notes: string[];
} {
  const profile = getSniperProfile(filters);
  const fingerprint = buildListingFingerprint(listing, { details });
  if (!profile.active) return { rejectReason: null, fingerprint, notes: [] };

  const notes: string[] = [];
  if (profile.requiredYear && fingerprint.year !== profile.requiredYear) {
    return { rejectReason: `Sniper lane skipped listing because the year was not clearly ${profile.requiredYear}.`, fingerprint, notes };
  }
  if (profile.familyKey && fingerprint.familyKey !== profile.familyKey) {
    return { rejectReason: `Sniper lane skipped listing because it did not clearly look like ${profile.familyKey}.`, fingerprint, notes };
  }
  if (profile.requireNumbered && fingerprint.serialNumbered !== true) {
    return { rejectReason: 'Sniper lane skipped listing because the title/details did not clearly show a numbered card.', fingerprint, notes };
  }
  if (profile.requireRaw && fingerprint.graded === true) {
    return { rejectReason: 'Sniper lane skipped listing because the listing appears graded instead of raw.', fingerprint, notes };
  }
  if (profile.requireCardNumber && !fingerprint.cardNumber) {
    return { rejectReason: 'Sniper lane skipped listing because no clear card number was found in the eBay listing.', fingerprint, notes };
  }

  notes.push(`Listing fingerprint: ${fingerprint.familyKey ?? 'unknown family'} • #${fingerprint.cardNumber ?? '?'}${fingerprint.parallel ? ` • ${fingerprint.parallel}` : ''}`);
  return { rejectReason: null, fingerprint, notes };
}

export function filterCandidatesForSniperLane(args: {
  listing: EbayListing;
  details: EbayListingDetails | null;
  filters: SearchForm;
  candidates: ScpCandidate[];
  listingFingerprint?: CardFingerprint | null;
}): { candidates: ScpCandidate[]; dropped: number; reasons: string[] } {
  const profile = getSniperProfile(args.filters);
  if (!profile.active) return { candidates: args.candidates, dropped: 0, reasons: [] };

  const listingFingerprint = args.listingFingerprint ?? buildListingFingerprint(args.listing, { details: args.details });
  const kept: Array<{ candidate: ScpCandidate; score: number }> = [];
  const reasons = new Set<string>();

  for (const candidate of args.candidates) {
    const candidateFingerprint = buildScpCandidateFingerprint(candidate);
    const comparison = compareFingerprintMatch(listingFingerprint, candidateFingerprint);
    const hardReasons: string[] = [];

    if (profile.requiredYear && candidateFingerprint.year && candidateFingerprint.year !== profile.requiredYear) hardReasons.push('year mismatch');
    if (profile.familyKey && candidateFingerprint.familyKey && candidateFingerprint.familyKey !== profile.familyKey) hardReasons.push('set-family mismatch');
    if (listingFingerprint.cardNumber && candidateFingerprint.cardNumber && candidateFingerprint.cardNumber !== listingFingerprint.cardNumber) hardReasons.push('card-number mismatch');
    if (!listingContainsCandidatePlayer(args.listing.title, candidate.productName)) hardReasons.push('player mismatch');
    if (listingFingerprint.parallel && candidateFingerprint.parallel && listingFingerprint.parallel !== candidateFingerprint.parallel) hardReasons.push('parallel mismatch');
    if (profile.requireNumbered && candidateFingerprint.serialNumbered === false) hardReasons.push('unnumbered SCP candidate');
    if (listingFingerprint.cardNumber && !candidateFingerprint.cardNumber && comparison.score < 30) hardReasons.push('missing card number on weak candidate');
    if (comparison.score < 16 && comparison.positiveSignals.length < 3) hardReasons.push('low fingerprint score');

    if (hardReasons.length > 0) {
      reasons.add(hardReasons[0]);
      continue;
    }

    kept.push({
      candidate,
      score: comparison.score + (candidateFingerprint.cardNumber === listingFingerprint.cardNumber ? 12 : 0) + (candidateFingerprint.familyKey === listingFingerprint.familyKey ? 8 : 0),
    });
  }

  const filtered = kept.sort((a, b) => b.score - a.score).map((entry) => entry.candidate);
  return { candidates: filtered, dropped: Math.max(0, args.candidates.length - filtered.length), reasons: [...reasons].slice(0, 4) };
}

export function candidateClearsSniperDealGate(args: {
  listingFingerprint: CardFingerprint;
  candidate: ScpCandidate;
  filters: SearchForm;
}): { ok: boolean; reason: string | null; score: number; positiveSignals: string[]; negativeSignals: string[] } {
  const profile = getSniperProfile(args.filters);
  const candidateFingerprint = buildScpCandidateFingerprint(args.candidate);
  const comparison = compareFingerprintMatch(args.listingFingerprint, candidateFingerprint);
  if (!profile.active) {
    return { ok: true, reason: null, score: comparison.score, positiveSignals: comparison.positiveSignals, negativeSignals: comparison.negativeSignals };
  }

  if (profile.familyKey && candidateFingerprint.familyKey !== profile.familyKey) {
    return { ok: false, reason: 'Displayed SCP match failed the sniper set-family gate.', score: comparison.score, positiveSignals: comparison.positiveSignals, negativeSignals: comparison.negativeSignals };
  }
  if (profile.requiredYear && candidateFingerprint.year && candidateFingerprint.year !== profile.requiredYear) {
    return { ok: false, reason: 'Displayed SCP match failed the sniper year gate.', score: comparison.score, positiveSignals: comparison.positiveSignals, negativeSignals: comparison.negativeSignals };
  }
  if (profile.requireCardNumber && (!args.listingFingerprint.cardNumber || candidateFingerprint.cardNumber !== args.listingFingerprint.cardNumber)) {
    return { ok: false, reason: 'Displayed SCP match failed the sniper card-number gate.', score: comparison.score, positiveSignals: comparison.positiveSignals, negativeSignals: comparison.negativeSignals };
  }
  if (args.listingFingerprint.parallel && candidateFingerprint.parallel && args.listingFingerprint.parallel !== candidateFingerprint.parallel) {
    return { ok: false, reason: 'Displayed SCP match failed the sniper parallel gate.', score: comparison.score, positiveSignals: comparison.positiveSignals, negativeSignals: comparison.negativeSignals };
  }
  if (!listingContainsCandidatePlayer(args.listingFingerprint.normalizedText, args.candidate.productName)) {
    return { ok: false, reason: 'Displayed SCP match failed the sniper player-name gate.', score: comparison.score, positiveSignals: comparison.positiveSignals, negativeSignals: comparison.negativeSignals };
  }
  if (comparison.score < 34 || comparison.positiveSignals.length < 3) {
    return { ok: false, reason: 'Displayed SCP match failed the sniper confidence gate.', score: comparison.score, positiveSignals: comparison.positiveSignals, negativeSignals: comparison.negativeSignals };
  }

  return { ok: true, reason: null, score: comparison.score, positiveSignals: comparison.positiveSignals, negativeSignals: comparison.negativeSignals };
}

export function candidateIsPlausibleSniperReview(args: {
  listingFingerprint: CardFingerprint;
  candidate: ScpCandidate;
  filters: SearchForm;
}): boolean {
  const profile = getSniperProfile(args.filters);
  if (!profile.active) return true;
  const candidateFingerprint = buildScpCandidateFingerprint(args.candidate);
  const comparison = compareFingerprintMatch(args.listingFingerprint, candidateFingerprint);
  if (profile.familyKey && candidateFingerprint.familyKey && candidateFingerprint.familyKey !== profile.familyKey) return false;
  if (profile.requiredYear && candidateFingerprint.year && candidateFingerprint.year !== profile.requiredYear) return false;
  if (args.listingFingerprint.cardNumber && candidateFingerprint.cardNumber && args.listingFingerprint.cardNumber !== candidateFingerprint.cardNumber) return false;
  if (args.listingFingerprint.parallel && candidateFingerprint.parallel && args.listingFingerprint.parallel !== candidateFingerprint.parallel) return false;
  if (!listingContainsCandidatePlayer(args.listingFingerprint.normalizedText, args.candidate.productName)) return false;
  return comparison.score >= 24 || comparison.positiveSignals.length >= 3;
}
