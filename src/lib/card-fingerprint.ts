import type { EbayListing, EbayListingDetails } from '@/lib/ebay';
import type { ScpCandidate } from '@/lib/scp';
import { compactWhitespace, tokenizeLoose } from '@/lib/utils';

export type CardFingerprint = {
  normalizedText: string;
  year: string | null;
  playerName: string | null;
  brand: string | null;
  setName: string | null;
  familyKey: string | null;
  cardNumber: string | null;
  parallel: string | null;
  serialNumbered: boolean | null;
  serialNumberText: string | null;
  serialNumberDenominator: string | null;
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
  'white shimmer',
  'orange pulsar',
  'red wave',
  'blue wave',
  'green wave',
  'red white blue',
  'red white & blue',
  'blue hyper',
  'green hyper',
  'hyper prizm',
  'orange mosaic',
  'green mosaic',
  'pink mosaic',
  'blue mosaic',
  'reactive blue mosaic',
  'reactive orange mosaic',
  'purple shock',
  'blue stars',
  'pink optic preview',
  'optic preview pink',
  'orange scope',
  'blue scope',
  'red scope',
  'silver prizm',
  'green prizm',
  'orange prizm',
  'blue prizm',
  'pink prizm',
  'red prizm',
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
  'sonar',
  'sonar refractor',
  'aqua sonar',
  'aqua sonar refractor',
  'disco',
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
  'prizm',
  'select',
  'optic',
  'mosaic',
];

const FAMILY_TERMS = [
  'panini prizm',
  'prizm',
  'panini select',
  'select',
  'panini optic',
  'optic',
  'panini mosaic',
  'mosaic',
  'topps chrome',
  'bowman chrome',
  'donruss optic',
  'donruss',
  'rookie ticket',
  'downtown',
  'kaboom',
  'color blast',
  'my house',
  'stained glass',
  'genesis',
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

export type FingerprintComparison = {
  score: number;
  positiveSignals: string[];
  negativeSignals: string[];
};

export function scoreFingerprintSimilarity(listingFingerprint: CardFingerprint, candidateFingerprint: CardFingerprint): number {
  return compareFingerprintMatch(listingFingerprint, candidateFingerprint).score;
}

export function listingContainsCandidatePlayer(listingText: string, candidateProductName: string): boolean {
  const candidateTokens = tokenizePersonName(extractLeadingPlayerName(candidateProductName));
  if (candidateTokens.length === 0) return true;
  const normalizedListing = compactWhitespace(listingText).toLowerCase();
  const matched = candidateTokens.filter((token) => listingContainsToken(normalizedListing, token)).length;
  if (candidateTokens.length >= 2) return matched >= candidateTokens.length;
  return matched >= 1;
}

export function normalizeFamilyKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = compactWhitespace(String(value)).toLowerCase();
  for (const family of [...FAMILY_TERMS].sort((a, b) => b.length - a.length)) {
    if (normalized.includes(family)) return family.replace(/^panini\s+/, '');
  }
  return null;
}

export function compareFingerprintMatch(listingFingerprint: CardFingerprint, candidateFingerprint: CardFingerprint): FingerprintComparison {
  let score = 0;
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];

  if (listingFingerprint.year && candidateFingerprint.year) {
    if (listingFingerprint.year === candidateFingerprint.year) {
      score += 14;
      positiveSignals.push(`Year ${listingFingerprint.year}`);
    } else {
      score -= 12;
      negativeSignals.push(`Year mismatch (${listingFingerprint.year} vs ${candidateFingerprint.year})`);
    }
  }
  if (listingFingerprint.familyKey && candidateFingerprint.familyKey) {
    if (listingFingerprint.familyKey === candidateFingerprint.familyKey) {
      score += 18;
      positiveSignals.push(`Set family ${candidateFingerprint.familyKey}`);
    } else {
      score -= 18;
      negativeSignals.push(`Set family mismatch (${listingFingerprint.familyKey} vs ${candidateFingerprint.familyKey})`);
    }
  }
  if (listingFingerprint.cardNumber && candidateFingerprint.cardNumber) {
    if (listingFingerprint.cardNumber === candidateFingerprint.cardNumber) {
      score += 18;
      positiveSignals.push(`Card #${listingFingerprint.cardNumber}`);
    } else {
      score -= 14;
      negativeSignals.push(`Card # mismatch (${listingFingerprint.cardNumber} vs ${candidateFingerprint.cardNumber})`);
    }
  }
  const candidatePlayerTokens = tokenizePersonName(candidateFingerprint.playerName);
  if (candidatePlayerTokens.length > 0) {
    const matchedPlayerTokens = candidatePlayerTokens.filter((token) => listingContainsToken(listingFingerprint.normalizedText, token)).length;
    if (matchedPlayerTokens === candidatePlayerTokens.length) {
      score += Math.min(12, 4 + (candidatePlayerTokens.length * 3));
      positiveSignals.push(`Player ${candidateFingerprint.playerName ?? candidatePlayerTokens.join(' ')}`);
    } else if (candidatePlayerTokens.length >= 2 && matchedPlayerTokens === 0) {
      score -= 18;
      negativeSignals.push(`Player mismatch (${candidateFingerprint.playerName ?? candidatePlayerTokens.join(' ')})`);
    } else if (candidatePlayerTokens.length >= 2 && matchedPlayerTokens < candidatePlayerTokens.length) {
      score -= 8;
      negativeSignals.push(`Player evidence was incomplete for ${candidateFingerprint.playerName ?? candidatePlayerTokens.join(' ')}`);
    }
  }
  if (listingFingerprint.parallel && candidateFingerprint.parallel) {
    if (listingFingerprint.parallel === candidateFingerprint.parallel) {
      score += 12;
      positiveSignals.push(`Parallel ${candidateFingerprint.parallel}`);
    } else {
      score -= 10;
      negativeSignals.push(`Parallel mismatch (${listingFingerprint.parallel} vs ${candidateFingerprint.parallel})`);
    }
  }
  if (listingFingerprint.serialNumbered !== null && candidateFingerprint.serialNumbered !== null) {
    if (listingFingerprint.serialNumbered === candidateFingerprint.serialNumbered) {
      score += 6;
      positiveSignals.push(listingFingerprint.serialNumbered ? 'Both serial-numbered' : 'Both unnumbered');
    } else {
      score -= 6;
      negativeSignals.push('Serial-numbering mismatch');
    }
  }
  if (listingFingerprint.serialNumberDenominator && candidateFingerprint.serialNumberDenominator) {
    if (listingFingerprint.serialNumberDenominator === candidateFingerprint.serialNumberDenominator) {
      score += 6;
      positiveSignals.push(`Print run /${listingFingerprint.serialNumberDenominator}`);
    } else {
      score -= 5;
      negativeSignals.push(`Print-run mismatch (/${listingFingerprint.serialNumberDenominator} vs /${candidateFingerprint.serialNumberDenominator})`);
    }
  }
  if (listingFingerprint.autograph !== null && candidateFingerprint.autograph !== null) {
    if (listingFingerprint.autograph === candidateFingerprint.autograph) {
      score += 5;
      if (listingFingerprint.autograph) positiveSignals.push('Autograph aligned');
    } else {
      score -= 5;
      negativeSignals.push('Autograph mismatch');
    }
  }
  if (listingFingerprint.memorabilia !== null && candidateFingerprint.memorabilia !== null) {
    if (listingFingerprint.memorabilia === candidateFingerprint.memorabilia) {
      score += 5;
      if (listingFingerprint.memorabilia) positiveSignals.push('Memorabilia aligned');
    } else {
      score -= 5;
      negativeSignals.push('Memorabilia mismatch');
    }
  }
  if (listingFingerprint.rookie !== null && candidateFingerprint.rookie !== null) {
    if (listingFingerprint.rookie === candidateFingerprint.rookie) {
      score += 4;
      if (listingFingerprint.rookie) positiveSignals.push('Rookie aligned');
    } else {
      score -= 4;
      negativeSignals.push('Rookie mismatch');
    }
  }
  if (listingFingerprint.brand && candidateFingerprint.brand) {
    if (listingFingerprint.brand === candidateFingerprint.brand) {
      score += 8;
      positiveSignals.push(`Brand ${candidateFingerprint.brand}`);
    } else if (!normalizeFamilyKey(listingFingerprint.brand) || !normalizeFamilyKey(candidateFingerprint.brand) || normalizeFamilyKey(listingFingerprint.brand) !== normalizeFamilyKey(candidateFingerprint.brand)) {
      score -= 6;
      negativeSignals.push(`Brand mismatch (${listingFingerprint.brand} vs ${candidateFingerprint.brand})`);
    }
  }
  if (listingFingerprint.raw === true && candidateFingerprint.graded === true) {
    score -= 6;
    negativeSignals.push('Grading mismatch (listing raw, SCP graded)');
  }
  if (listingFingerprint.graded === true && candidateFingerprint.raw === true) {
    score -= 6;
    negativeSignals.push('Grading mismatch (listing graded, SCP raw)');
  }

  const overlap = listingFingerprint.tokens.filter((token) => candidateFingerprint.tokens.includes(token));
  score += Math.min(10, overlap.length);
  if (overlap.length > 0) {
    positiveSignals.push(`${Math.min(10, overlap.length)} shared text token${overlap.length === 1 ? '' : 's'}`);
  }

  return {
    score,
    positiveSignals: positiveSignals.slice(0, 5),
    negativeSignals: negativeSignals.slice(0, 5),
  };
}

function buildFingerprintFromText(
  text: string,
  options: { aspectMap: FingerprintAspectMap; condition: string | null },
): CardFingerprint {
  const compactText = compactWhitespace(text);
  const normalizedText = compactText.toLowerCase();
  const tokens = tokenizeLoose(normalizedText).slice(0, 48);
  const year = extractYear(normalizedText);
  const aspectMap = options.aspectMap ?? {};

  const playerName = firstAspectValue(aspectMap, ['player athlete', 'athlete', 'player']) ?? extractLeadingPlayerName(compactText);
  const team = firstAspectValue(aspectMap, ['team', 'professional sports authen']) ?? null;
  const brand = normalizeBrandValue(extractBestTerm(normalizedText, BRAND_TERMS) ?? firstAspectValue(aspectMap, ['manufacturer', 'brand']));
  const setName = firstAspectValue(aspectMap, ['set', 'insert set']) ?? extractBestTerm(normalizedText, SET_HINTS);
  const familyKey = normalizeFamilyKey([brand, setName, normalizedText].filter(Boolean).join(' '));
  const cardNumber = normalizeCardNumber(firstAspectValue(aspectMap, ['card number'])) ?? extractCardNumber(normalizedText);
  const parallel = normalizeParallelValue(firstAspectValue(aspectMap, ['parallel variety', 'parallel']) ?? extractBestTerm(normalizedText, PARALLEL_TERMS));
  const serialNumberText = normalizeSerialNumberText(firstAspectValue(aspectMap, ['print run', 'serial number', 'serial numbered'])) ?? extractSerialNumberText(normalizedText);
  const serialNumberDenominator = extractSerialNumberDenominator(serialNumberText);
  const serialNumbered = serialNumberText ? true : inferBoolean(normalizedText, ['numbered', '/'], ['unnumbered']);
  const rookie = inferBoolean(normalizedText, ['rookie', 'rc'], ['non rookie']);
  const autograph = inferBoolean(normalizedText, ['auto', 'autograph'], ['non auto', 'no auto']);
  const memorabilia = inferBoolean(normalizedText, ['patch', 'relic', 'memorabilia', 'jersey'], ['non patch', 'no relic']);
  const graded = inferBoolean(`${normalizedText} ${options.condition ?? ''}`.toLowerCase(), ['psa', 'bgs', 'sgc', 'cgc', 'graded'], ['raw']);
  const raw = inferBoolean(`${normalizedText} ${options.condition ?? ''}`.toLowerCase(), ['raw', 'ungraded'], ['graded', 'psa', 'bgs', 'sgc', 'cgc']);

  const keyHints = [year, playerName, brand, setName, familyKey, cardNumber, parallel, serialNumberText]
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);

  return {
    normalizedText,
    year,
    playerName,
    brand,
    setName,
    familyKey,
    cardNumber,
    parallel,
    serialNumbered,
    serialNumberText,
    serialNumberDenominator,
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

function normalizeCardNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = compactWhitespace(value).match(/#?\s*([a-z0-9-]{1,14})/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function extractCardNumber(text: string): string | null {
  const hashMatch = text.match(/(?:^|\s)#\s*([a-z0-9-]{1,14})(?=\s|$)/i);
  if (hashMatch?.[1]) return hashMatch[1].toUpperCase();
  const numberMatch = text.match(/\b(?:card|no|number)\s*#?\s*([a-z0-9-]{1,14})\b/i);
  if (numberMatch?.[1]) return numberMatch[1].toUpperCase();
  const insertStyleMatch = text.match(/\b([a-z]{2,5}-[a-z0-9]{2,8})\b/i);
  return insertStyleMatch?.[1]?.toUpperCase() ?? null;
}

function normalizeSerialNumberText(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = compactWhitespace(value).match(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function extractSerialNumberText(text: string): string | null {
  const match = text.match(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function extractSerialNumberDenominator(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/\/(\d+)/);
  return match?.[1] ?? null;
}

function normalizeBrandValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = compactWhitespace(value).toLowerCase();
  if (normalized.includes('donruss optic') || normalized.includes('panini optic')) return 'optic';
  if (normalized.includes('panini donruss') || normalized === 'donruss') return 'donruss';
  if (normalized.includes('panini prizm') || normalized === 'prizm') return 'prizm';
  if (normalized.includes('panini mosaic') || normalized === 'mosaic') return 'mosaic';
  if (normalized.includes('panini select') || normalized === 'select') return 'select';
  if (normalized.includes('topps chrome')) return 'topps chrome';
  if (normalized.includes('bowman chrome')) return 'bowman chrome';
  return normalized;
}

function normalizeParallelValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = compactWhitespace(value)
    .toLowerCase()
    .replace(/prism/g, 'prizm')
    .replace(/\s+/g, ' ');

  const rules: Array<[RegExp, string]> = [
    [/\boptic preview pink(?: prizm)?\b/, 'pink optic preview'],
    [/\bpink optic preview(?: prizm)?\b/, 'pink optic preview'],
    [/\breactive blue mosaic(?: prizm)?\b/, 'reactive blue mosaic'],
    [/\breactive orange mosaic(?: prizm)?\b/, 'reactive orange mosaic'],
    [/\borange mosaic(?: prizm)?\b/, 'orange mosaic'],
    [/\bgreen mosaic(?: prizm)?\b/, 'green mosaic'],
    [/\bblue mosaic(?: prizm)?\b/, 'blue mosaic'],
    [/\bpink mosaic(?: prizm)?\b/, 'pink mosaic'],
    [/\bgreen hyper(?: prizm)?\b/, 'green hyper'],
    [/\bblue hyper(?: prizm)?\b/, 'blue hyper'],
    [/\bred white(?: &)? blue(?: prizm)?\b/, 'red white blue'],
    [/\bblue wave(?: prizm)?\b/, 'blue wave'],
    [/\bred wave(?: prizm)?\b/, 'red wave'],
    [/\bgreen wave(?: prizm)?\b/, 'green wave'],
    [/\bpurple shock(?: prizm)?\b/, 'purple shock'],
    [/\borange scope(?: prizm)?\b/, 'orange scope'],
    [/\bblue scope(?: prizm)?\b/, 'blue scope'],
    [/\bred scope(?: prizm)?\b/, 'red scope'],
    [/\bsilver(?: holo)?(?: prizm)?\b/, 'silver'],
    [/\borange(?: holo)?(?: prizm)?\b/, 'orange'],
    [/\bblue(?: holo)?(?: prizm)?\b/, 'blue'],
    [/\bred(?: holo)?(?: prizm)?\b/, 'red'],
    [/\bpink(?: holo)?(?: prizm)?\b/, 'pink'],
    [/\bpurple(?: holo)?(?: prizm)?\b/, 'purple'],
    [/\bgreen(?: holo)?(?: prizm)?\b/, 'green'],
    [/\bgold(?: holo)?(?: prizm)?\b/, 'gold'],
    [/\baqua sonar(?: refractor)?\b/, 'aqua sonar'],
    [/\bsonar refractor\b/, 'sonar'],
    [/\bsonar\b/, 'sonar'],
    [/\bdisco(?: prizm)?\b/, 'disco'],
    [/\bpulsar(?: prizm)?\b/, 'pulsar'],
    [/\bshock(?: prizm)?\b/, 'shock'],
    [/\bholo(?: prizm)?\b/, 'holo'],
  ];

  for (const [pattern, canonical] of rules) {
    if (pattern.test(normalized)) return canonical;
  }

  return normalized;
}

function extractLeadingPlayerName(text: string): string | null {
  const head = compactWhitespace(text.split(/[\[#(]/)[0] ?? '');
  if (!head) return null;
  const stripped = head
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/[|,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = tokenizePersonName(stripped);
  if (tokens.length === 0) return null;
  return tokens.slice(0, 3).map((token) => token.replace(/\b\w/g, (m) => m.toUpperCase())).join(' ');
}

function tokenizePersonName(value: string | null | undefined): string[] {
  if (!value) return [];
  return compactWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9'\-.]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[#.-]+|[#.-]+$/g, ''))
    .filter((token) => Boolean(token)
      && !/^(19\d{2}|20\d{2}|rc|card|cards|rookie|auto|autograph|patch|relic|prizm|optic|mosaic|select|phoenix|donruss|panini|topps|bowman|football|basketball|baseball|hockey|numbered|parallel|insert|the|and|of|jr|sr|ii|iii|iv|v)$/i.test(token)
      && /[a-z]/.test(token));
}

function listingContainsToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

function extractBestTerm(text: string, terms: string[]): string | null {
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
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
