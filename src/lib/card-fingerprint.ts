import type { EbayListing, EbayListingDetails } from '@/lib/ebay';
import type { ScpCandidate } from '@/lib/scp';
import { compactWhitespace, tokenizeLoose } from '@/lib/utils';

export type CardFingerprint = {
  normalizedText: string;
  year: string | null;
  playerName: string | null;
  brand: string | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  serialNumbered: boolean | null;
  serialNumberText: string | null;
  rookie: boolean | null;
  autograph: boolean | null;
  memorabilia: boolean | null;
  graded: boolean | null;
  raw: boolean | null;
  team: string | null;
  tokens: string[];
  keyHints: string[];
};

type FingerprintAspectMap = Record<string, string[]>;

const PARALLEL_TERMS = [
  'black finite',
  'gold vinyl',
  'gold shimmer',
  'blue shimmer',
  'red shimmer',
  'orange pulsar',
  'red wave',
  'blue wave',
  'hyper prizm',
  'silver prizm',
  'green prizm',
  'mojo prizm',
  'choice red',
  'choice blue',
  'white sparkle',
  'cracked ice',
  'scope',
  'mojo',
  'pulsar',
  'refractor',
  'xfractor',
  'atomic',
  'speckle',
  'pink',
  'purple',
  'orange',
  'red',
  'blue',
  'green',
  'gold',
  'silver',
  'bronze',
  'teal',
  'aqua',
  'sepia',
  'rainbow',
  'velocity',
  'ice',
  'wave',
  'galaxy',
  'checkerboard',
  'laser',
  'phoenix',
  'neon green',
  'holo',
];

const BRAND_TERMS = [
  'panini prizm',
  'panini select',
  'panini optic',
  'panini donruss',
  'panini mosaic',
  'topps chrome',
  'topps finest',
  'topps bowman chrome',
  'bowman chrome',
  'bowman best',
  'bowman sterling',
  'upper deck',
  'fleer ultra',
  'leaf metal',
  'donruss optic',
  'select',
  'prizm',
  'optic',
  'mosaic',
  'donruss',
  'bowman',
  'topps',
  'leaf',
  'upper deck',
];

const SET_HINTS = [
  'rookie ticket',
  'downtown',
  'kaboom',
  'color blast',
  'my house',
  'stained glass',
  'pandora',
  'bomb squad',
  'marvels',
  'seismic',
  'genesis',
  'dragon scale',
  'v color',
  'blue scope',
  'white sparkle',
  'checkerboard',
];

export function buildListingFingerprint(
  listing: Pick<EbayListing, 'title' | 'condition'>,
  options?: { details?: Pick<EbayListingDetails, 'subtitle' | 'description' | 'aspectMap'> | null; ximilarHints?: string[] | null },
): CardFingerprint {
  const mergedText = compactWhitespace([
    listing.title,
    options?.details?.subtitle ?? '',
    options?.details?.description ?? '',
    ...(options?.ximilarHints ?? []),
  ].filter(Boolean).join(' '));

  return buildFingerprintFromText(mergedText, {
    aspectMap: options?.details?.aspectMap ?? {},
    condition: listing.condition ?? null,
  });
}

export function buildScpCandidateFingerprint(candidate: Pick<ScpCandidate, 'productName' | 'consoleName'>): CardFingerprint {
  const mergedText = compactWhitespace([candidate.productName, candidate.consoleName ?? ''].filter(Boolean).join(' '));
  return buildFingerprintFromText(mergedText, { aspectMap: {}, condition: null });
}

export function scoreFingerprintSimilarity(listingFingerprint: CardFingerprint, candidateFingerprint: CardFingerprint): number {
  let score = 0;

  if (listingFingerprint.year && candidateFingerprint.year) {
    score += listingFingerprint.year === candidateFingerprint.year ? 14 : -12;
  }
  if (listingFingerprint.cardNumber && candidateFingerprint.cardNumber) {
    score += listingFingerprint.cardNumber === candidateFingerprint.cardNumber ? 18 : -14;
  }
  if (listingFingerprint.parallel && candidateFingerprint.parallel) {
    score += listingFingerprint.parallel === candidateFingerprint.parallel ? 12 : -10;
  }
  if (listingFingerprint.serialNumbered !== null && candidateFingerprint.serialNumbered !== null) {
    score += listingFingerprint.serialNumbered === candidateFingerprint.serialNumbered ? 6 : -6;
  }
  if (listingFingerprint.autograph !== null && candidateFingerprint.autograph !== null) {
    score += listingFingerprint.autograph === candidateFingerprint.autograph ? 5 : -5;
  }
  if (listingFingerprint.memorabilia !== null && candidateFingerprint.memorabilia !== null) {
    score += listingFingerprint.memorabilia === candidateFingerprint.memorabilia ? 5 : -5;
  }
  if (listingFingerprint.rookie !== null && candidateFingerprint.rookie !== null) {
    score += listingFingerprint.rookie === candidateFingerprint.rookie ? 4 : -4;
  }
  if (listingFingerprint.brand && candidateFingerprint.brand) {
    score += listingFingerprint.brand === candidateFingerprint.brand ? 8 : -6;
  }

  const overlap = listingFingerprint.tokens.filter((token) => candidateFingerprint.tokens.includes(token));
  score += Math.min(10, overlap.length);

  return score;
}

function buildFingerprintFromText(
  text: string,
  options: { aspectMap: FingerprintAspectMap; condition: string | null },
): CardFingerprint {
  const normalizedText = compactWhitespace(text).toLowerCase();
  const tokens = tokenizeLoose(normalizedText).slice(0, 48);
  const year = extractYear(normalizedText);
  const aspectMap = options.aspectMap ?? {};

  const playerName = firstAspectValue(aspectMap, ['player athlete', 'athlete', 'player']) ?? null;
  const team = firstAspectValue(aspectMap, ['team', 'professional sports authen']) ?? null;
  const brand = extractBestTerm(normalizedText, BRAND_TERMS) ?? firstAspectValue(aspectMap, ['manufacturer', 'brand']);
  const setName = firstAspectValue(aspectMap, ['set']) ?? extractBestTerm(normalizedText, SET_HINTS);
  const cardNumber = firstAspectValue(aspectMap, ['card number']) ?? extractCardNumber(normalizedText);
  const parallel = firstAspectValue(aspectMap, ['parallel variety', 'parallel']) ?? extractBestTerm(normalizedText, PARALLEL_TERMS);
  const serialNumberText = firstAspectValue(aspectMap, ['print run', 'serial number', 'serial numbered']) ?? extractSerialNumberText(normalizedText);
  const serialNumbered = serialNumberText ? true : inferBoolean(normalizedText, ['numbered', '/'], ['unnumbered']);
  const rookie = inferBoolean(normalizedText, ['rookie', 'rc'], ['non rookie']);
  const autograph = inferBoolean(normalizedText, ['auto', 'autograph'], ['non auto', 'no auto']);
  const memorabilia = inferBoolean(normalizedText, ['patch', 'relic', 'memorabilia', 'jersey'], ['non patch', 'no relic']);
  const graded = inferBoolean(`${normalizedText} ${options.condition ?? ''}`.toLowerCase(), ['psa', 'bgs', 'sgc', 'cgc', 'graded'], ['raw']);
  const raw = inferBoolean(`${normalizedText} ${options.condition ?? ''}`.toLowerCase(), ['raw', 'ungraded'], ['graded', 'psa', 'bgs', 'sgc', 'cgc']);

  const keyHints = [year, playerName, brand, setName, cardNumber, parallel, serialNumberText]
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);

  return {
    normalizedText,
    year,
    playerName,
    brand,
    setName,
    cardNumber,
    parallel,
    serialNumbered,
    serialNumberText,
    rookie,
    autograph,
    memorabilia,
    graded,
    raw,
    team,
    tokens,
    keyHints,
  };
}

function extractYear(text: string): string | null {
  const match = text.match(/\b(19\d{2}|20\d{2})\b/);
  return match?.[1] ?? null;
}

function extractCardNumber(text: string): string | null {
  const hashMatch = text.match(/(?:^|\s)#\s*([a-z0-9-]{1,10})(?=\s|$)/i);
  if (hashMatch?.[1]) return hashMatch[1].toUpperCase();
  const numberMatch = text.match(/\b(?:card|no|number)\s*#?\s*([a-z0-9-]{1,10})\b/i);
  return numberMatch?.[1]?.toUpperCase() ?? null;
}

function extractSerialNumberText(text: string): string | null {
  const match = text.match(/\b\d+\s*\/\s*\d+\b/);
  return match ? match[0].replace(/\s+/g, '') : null;
}

function extractBestTerm(text: string, terms: string[]): string | null {
  for (const term of terms.sort((a, b) => b.length - a.length)) {
    if (text.includes(term)) return term;
  }
  return null;
}

function inferBoolean(text: string, positiveTerms: string[], negativeTerms: string[]): boolean | null {
  if (negativeTerms.some((term) => text.includes(term))) return false;
  if (positiveTerms.some((term) => text.includes(term))) return true;
  return null;
}

function firstAspectValue(aspectMap: FingerprintAspectMap, keys: string[]): string | null {
  for (const key of keys) {
    const value = aspectMap[key]?.[0];
    if (value) return compactWhitespace(value);
  }
  return null;
}
