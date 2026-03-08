import type { EbayListingDetails } from '@/lib/ebay';
import type { CardConditionMode, SearchForm } from '@/types/app';

const BLOCK_WORDS = [
  'lot',
  'lots',
  'break',
  'case break',
  'box',
  'blaster',
  'hanger',
  'fat pack',
  'pack',
  'repack',
  'team set',
  'mystery',
  'custom',
  'reprint',
  'digital',
  'pokemon',
  'comic',
  'sticker',
  'magazine',
  'wax',
  'bundle',
  'mixed lot',
  'investment lot',
];

const GRADED_WORDS = ['psa', 'bgs', 'sgc', 'cgc', 'beckett', 'gem mint', 'slab', 'graded'];
const MULTI_CARD_PATTERNS = [/\blot\b/i, /\bpair\b/i, /\bset of\b/i, /\bteam set\b/i, /\bbundle\b/i, /\b2 card\b/i, /\b3 card\b/i, /\b4 card\b/i, /\bx2\b/i];

type AspectRule = {
  filterValue: string | undefined;
  keys: string[];
  label: string;
  exact?: boolean;
};

export function shouldRejectTitle(title: string, filters: SearchForm): string | null {
  return rejectFromText(title, filters);
}

export function shouldRejectListingDetails(details: EbayListingDetails, filters: SearchForm): string | null {
  const titleReason = rejectFromText(`${details.title} ${details.subtitle ?? ''} ${details.description ?? ''}`.trim(), filters);
  if (titleReason) return titleReason;

  const aspectReason = rejectFromAspects(details.aspectMap, filters);
  if (aspectReason) return aspectReason;

  const detailConditionReason = rejectFromCondition(details.condition, filters.conditionMode);
  if (detailConditionReason) return detailConditionReason;

  return null;
}

function rejectFromText(text: string, filters: SearchForm): string | null {
  const lower = text.toLowerCase();

  for (const word of BLOCK_WORDS) {
    if (lower.includes(word)) {
      return `Blocked phrase: ${word}`;
    }
  }

  if (!filters.memorabilia && /\bjersey\b|\bshirt\b/i.test(text)) {
    return 'Blocked phrase: jersey or shirt';
  }

  if (filters.sport.trim().toLowerCase() === 'football' && /\bsoccer\b|\bfutbol\b|\buefa\b|\bfifa\b|\bpremier league\b/i.test(text)) {
    return 'Blocked soccer-style football listing';
  }

  for (const pattern of MULTI_CARD_PATTERNS) {
    if (pattern.test(text)) {
      return 'Rejected multi-card or lot listing';
    }
  }

  if (/(\b1\/1\b|one of one)/i.test(text)) {
    return 'Rejected 1/1 listing';
  }

  const serialMatch = text.match(/\/(\d{1,4})\b/);
  if (serialMatch) {
    const serial = Number(serialMatch[1]);
    if (serial > 0 && serial <= 10) {
      return 'Rejected serial /10 or below';
    }
  }

  if (filters.memorabilia && /(lot|patch lot|relic lot)/i.test(text)) {
    return 'Memorabilia lot rejected';
  }

  const isGraded = GRADED_WORDS.some((word) => lower.includes(word));
  const detailConditionReason = rejectFromCondition(isGraded ? 'graded' : 'raw', filters.conditionMode);
  if (detailConditionReason) return detailConditionReason;

  return null;
}

function rejectFromCondition(condition: string | null | undefined, conditionMode: CardConditionMode): string | null {
  if (!condition) return null;
  const normalized = condition.toLowerCase();
  const isGraded = GRADED_WORDS.some((word) => normalized.includes(word));

  if (conditionMode === 'raw' && isGraded) {
    return 'Rejected graded listing while search is raw';
  }

  if (conditionMode === 'graded' && !isGraded) {
    return 'Rejected raw listing while search is graded';
  }

  return null;
}

function rejectFromAspects(aspectMap: Record<string, string[]>, filters: SearchForm): string | null {
  const matcher: AspectRule[] = [
    { filterValue: filters.playerName, keys: ['athlete', 'player athlete', 'player', 'character'], label: 'player' },
    { filterValue: filters.team, keys: ['team', 'professional sports psl team', 'league', 'nfl team'], label: 'team' },
    { filterValue: filters.brand, keys: ['manufacturer', 'brand'], label: 'brand' },
    { filterValue: filters.cardNumber, keys: ['card number'], label: 'card number', exact: true },
    { filterValue: filters.insert, keys: ['insert set', 'insert', 'set'], label: 'insert' },
    { filterValue: filters.variant, keys: ['parallel variety', 'parallel', 'variety insert', 'series'], label: 'variant' },
    { filterValue: filters.position, keys: ['position'], label: 'position' },
  ];

  for (const rule of matcher) {
    const filterValue = normalizeFilterValue(rule.filterValue ?? null);
    if (!filterValue) continue;
    const aspectValues = rule.keys.flatMap((key) => aspectMap[key] ?? []);
    if (aspectValues.length === 0) continue;
    const matched = aspectValues.some((value) => {
      const normalized = normalizeFilterValue(value);
      if (!normalized) return false;
      return rule.exact ? normalized === filterValue || normalized.endsWith(` ${filterValue}`) : normalized.includes(filterValue) || filterValue.includes(normalized);
    });
    if (!matched) {
      return `eBay specifics conflict with requested ${rule.label}`;
    }
  }

  const gradedAspect = [...(aspectMap.graded ?? []), ...(aspectMap['professional grader'] ?? []), ...(aspectMap.grade ?? [])].join(' ');
  const conditionReason = rejectFromCondition(gradedAspect, filters.conditionMode);
  if (conditionReason) return conditionReason;

  if (filters.rookie) {
    const rookieValues = [...(aspectMap.features ?? []), ...(aspectMap['card attributes'] ?? [])].join(' ').toLowerCase();
    if (rookieValues && !/rookie|rc/.test(rookieValues)) {
      return 'eBay specifics conflict with requested rookie card';
    }
  }

  if (filters.autographed) {
    const autoValues = [...(aspectMap.autographed ?? []), ...(aspectMap.features ?? [])].join(' ').toLowerCase();
    if (autoValues && !/yes|auto|autograph|signed/.test(autoValues)) {
      return 'eBay specifics conflict with requested autograph';
    }
  }

  if (filters.memorabilia) {
    const memoValues = [...(aspectMap.features ?? []), ...(aspectMap['card attributes'] ?? [])].join(' ').toLowerCase();
    if (memoValues && !/memorabilia|patch|relic|jersey/.test(memoValues)) {
      return 'eBay specifics conflict with requested memorabilia';
    }
  }

  return null;
}

function normalizeFilterValue(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildSportClause(filters: SearchForm): string | null {
  const normalized = filters.sport.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'football') return 'football';
  if (normalized === 'basketball') return 'basketball';
  if (normalized === 'baseball') return 'baseball';
  if (normalized === 'hockey') return 'hockey';
  return normalized;
}

export function buildKeywordClauses(filters: SearchForm): string[] {
  const clauses = [buildSportClause(filters) ?? filters.sport];
  if (filters.startYear && filters.endYear && filters.startYear === filters.endYear) {
    clauses.push(String(filters.startYear));
  } else {
    if (filters.startYear) clauses.push(String(filters.startYear));
    if (filters.endYear && filters.endYear !== filters.startYear) clauses.push(String(filters.endYear));
  }
  if (filters.brand) clauses.push(filters.brand);
  if (filters.variant) clauses.push(filters.variant);
  if (filters.insert) clauses.push(filters.insert);
  if (filters.cardNumber) clauses.push(filters.cardNumber);
  if (filters.playerName) clauses.push(filters.playerName);
  if (filters.position) clauses.push(filters.position);
  if (filters.team) clauses.push(filters.team);
  if (filters.numberedOutOf) clauses.push(`/${filters.numberedOutOf}`);
  if (filters.rookie) clauses.push('rookie');
  if (filters.autographed) clauses.push('autograph');
  if (filters.memorabilia) clauses.push('patch');
  return clauses.filter(Boolean);
}

export function buildEbayQueryTerms(filters: SearchForm): string[] {
  const terms: string[] = [];
  const sport = filters.sport.trim().toLowerCase();
  if (sport) terms.push(sport);
  if (filters.startYear && filters.endYear && filters.startYear === filters.endYear) terms.push(String(filters.startYear));
  else {
    if (filters.startYear) terms.push(String(filters.startYear));
    if (filters.endYear && filters.endYear !== filters.startYear) terms.push(String(filters.endYear));
  }
  if (filters.brand) terms.push(filters.brand);
  if (filters.variant) terms.push(filters.variant);
  if (filters.insert) terms.push(filters.insert);
  if (filters.cardNumber) terms.push(filters.cardNumber);
  if (filters.playerName) terms.push(filters.playerName);
  if (filters.team) terms.push(filters.team);
  if (filters.rookie) terms.push('rookie');
  if (filters.autographed) terms.push('autograph');
  if (filters.memorabilia) terms.push('patch');
  return terms.filter(Boolean).map((value) => compactWhitespace(value)).filter(Boolean);
}

export function buildNegativeClauses(filters: SearchForm): string[] {
  const negatives = [
    'lot',
    'lots',
    'box',
    'pack',
    'break',
    'reprint',
    'custom',
    'digital',
    '1/1',
    'team set',
    'bundle',
    'complete set',
    'starter set',
  ];

  const sport = filters.sport.trim().toLowerCase();
  if (sport === 'football') {
    negatives.push('soccer', 'futbol', 'uefa', 'fifa', 'premier league', 'women', 'womens', 'european');
  }

  if (!filters.memorabilia) {
    negatives.push('jersey', 'shirt');
  }

  if (filters.conditionMode === 'raw') {
    negatives.push('PSA', 'BGS', 'SGC', 'CGC', 'graded', 'slab');
  }

  return negatives;
}
