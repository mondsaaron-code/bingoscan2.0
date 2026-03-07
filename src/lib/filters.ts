import type { CardConditionMode, SearchForm } from '@/types/app';

const BLOCK_WORDS = [
  'lot',
  'lots',
  'break',
  'case break',
  'box',
  'blaster',
  'mega box',
  'hanger',
  'fat pack',
  'pack',
  'repack',
  'team set',
  'complete set',
  'bundle',
  'mystery',
  'custom',
  'reprint',
  'digital',
  'pokemon',
  'comic',
  'sticker',
  'magazine',
  'wax',
  'choose your card',
  'pick your card',
];

const GRADED_WORDS = ['psa', 'bgs', 'sgc', 'cgc', 'beckett', 'gem mint', 'slab', 'hga', 'csg'];
const MULTI_CARD_WORDS = ['lot of', 'pair', 'x2', 'x3', 'two card', 'three card', 'multi card'];

export function shouldRejectTitle(title: string, filters: SearchForm): string | null {
  const lower = title.toLowerCase();

  for (const word of BLOCK_WORDS) {
    if (lower.includes(word)) {
      return `Blocked phrase: ${word}`;
    }
  }

  for (const word of MULTI_CARD_WORDS) {
    if (lower.includes(word)) {
      return `Rejected multi-card listing: ${word}`;
    }
  }

  if (/(1\/1|one of one)/i.test(title)) {
    return 'Rejected 1/1 listing';
  }

  const serialMatch = title.match(/\/(\d{1,4})/);
  if (serialMatch) {
    const serial = Number(serialMatch[1]);
    if (serial > 0 && serial <= 10) {
      return 'Rejected serial /10 or below';
    }
  }

  if (filters.memorabilia && /(lot|patch lot|relic lot)/i.test(title)) {
    return 'Memorabilia lot rejected';
  }

  const isGraded = GRADED_WORDS.some((word) => lower.includes(word));
  const conditionMode: CardConditionMode = filters.conditionMode;

  if (conditionMode === 'raw' && isGraded) {
    return 'Rejected graded listing while search is raw';
  }

  if (conditionMode === 'graded' && !isGraded) {
    return 'Rejected raw listing while search is graded';
  }

  return null;
}

export function buildKeywordClauses(filters: SearchForm): string[] {
  const clauses = [filters.sport];
  if (filters.startYear && filters.endYear && filters.startYear === filters.endYear) {
    clauses.push(String(filters.startYear));
  } else {
    if (filters.startYear) clauses.push(String(filters.startYear));
    if (filters.endYear && filters.endYear !== filters.startYear) clauses.push(String(filters.endYear));
  }
  if (filters.brand) clauses.push(filters.brand);
  if (filters.variant) clauses.push(filters.variant);
  if (filters.insert) clauses.push(filters.insert);
  if (filters.cardNumber) clauses.push(`#${filters.cardNumber}`);
  if (filters.playerName) clauses.push(filters.playerName);
  if (filters.position) clauses.push(filters.position);
  if (filters.team) clauses.push(filters.team);
  if (filters.numberedOutOf) clauses.push(`/${filters.numberedOutOf}`);
  if (filters.rookie) clauses.push('rookie');
  if (filters.autographed) clauses.push('auto');
  if (filters.memorabilia) clauses.push('memorabilia');
  if (filters.numberedCard) clauses.push('numbered');
  if (filters.conditionMode === 'graded') clauses.push('graded');
  return clauses.filter(Boolean);
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
    'comic',
    'pokemon',
    'magazine',
    'pick your card',
    'choose your card',
  ];

  if (filters.conditionMode === 'raw') {
    negatives.push('PSA', 'BGS', 'SGC', 'CGC', 'CSG', 'HGA', 'graded', 'slab');
  }

  return negatives;
}
