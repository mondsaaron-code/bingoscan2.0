import { getRequiredEnv } from '@/lib/env';
import { compactWhitespace, parseMoney, sleep, slugify, tokenizeLoose } from '@/lib/utils';

export type ScpCandidate = {
  productId: string;
  productName: string;
  consoleName: string | null;
  productUrl: string | null;
  ungradedSell: number | null;
  grade9: number | null;
  psa10: number | null;
  source?: 'api' | 'cache';
};

type ScpProductLookupResponse = {
  status?: string;
  products?: Array<Record<string, unknown>>;
  ['error-message']?: string;
};

type ScpSingleProductResponse = Record<string, unknown> & {
  status?: string;
  ['error-message']?: string;
};

const SCP_THROTTLE_MS = 1100;
let lastScpRequestAt = 0;
const productCache = new Map<string, ScpCandidate>();
const queryCache = new Map<string, ScpCandidate[]>();

export function scpSetCacheKey(consoleName: string): string {
  return `${slugify(consoleName)}.csv`;
}

function getScpBaseUrl(): string {
  return process.env.SPORTSCARDSPRO_API_BASE_URL ?? 'https://www.sportscardspro.com';
}

async function throttleScp(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, lastScpRequestAt + SCP_THROTTLE_MS - now);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastScpRequestAt = Date.now();
}

export async function searchSportsCardsProCandidates(query: string): Promise<ScpCandidate[]> {
  const trimmedQuery = compactWhitespace(query);
  if (!trimmedQuery) return [];

  const cached = queryCache.get(trimmedQuery.toLowerCase());
  if (cached) return cached;

  await throttleScp();
  const params = new URLSearchParams({
    t: getRequiredEnv('SPORTSCARDSPRO_API_TOKEN'),
    q: trimmedQuery,
  });

  const response = await fetch(`${getScpBaseUrl()}/api/products?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SportsCardsPro lookup failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as ScpProductLookupResponse;
  if (body.status === 'error') {
    throw new Error(`SportsCardsPro lookup error: ${body['error-message'] ?? 'Unknown lookup error'}`);
  }

  const mapped = (body.products ?? []).slice(0, 20).map((row) => mapScpRow(row, 'api'));
  queryCache.set(trimmedQuery.toLowerCase(), mapped);
  return mapped;
}

export async function searchSportsCardsProCandidatesMulti(queries: string[], perQueryLimit = 12): Promise<{ candidates: ScpCandidate[]; queryHits: Array<{ query: string; count: number }> }> {
  const cleanedQueries = [...new Set(queries.map((value) => compactWhitespace(value)).filter(Boolean))].slice(0, 4);
  const merged: ScpCandidate[] = [];
  const queryHits: Array<{ query: string; count: number }> = [];

  for (const query of cleanedQueries) {
    const rows = await searchSportsCardsProCandidates(query);
    queryHits.push({ query, count: rows.length });
    merged.push(...rows.slice(0, perQueryLimit));
  }

  return {
    candidates: dedupeCandidates(merged),
    queryHits,
  };
}

export async function getSportsCardsProProduct(productId: string): Promise<ScpCandidate | null> {
  if (!productId) return null;
  const cached = productCache.get(productId);
  if (cached) return cached;

  await throttleScp();
  const params = new URLSearchParams({
    t: getRequiredEnv('SPORTSCARDSPRO_API_TOKEN'),
    id: productId,
  });

  const response = await fetch(`${getScpBaseUrl()}/api/product?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SportsCardsPro product lookup failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as ScpSingleProductResponse;
  if (body.status === 'error') {
    return null;
  }

  const mapped = mapScpRow(body, 'api');
  productCache.set(productId, mapped);
  return mapped;
}

export async function hydrateSportsCardsProCandidates(productIds: string[]): Promise<ScpCandidate[]> {
  const seen = new Set<string>();
  const hydrated: ScpCandidate[] = [];
  for (const productId of productIds) {
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    const row = await getSportsCardsProProduct(productId);
    if (row) hydrated.push(row);
  }
  return hydrated;
}

export function searchScpCsvCandidates(csvText: string, query: string, limit = 12): ScpCandidate[] {
  const rows = parseScpCsv(csvText);
  const ranked = [...rows].sort((a, b) => scoreScpText(query, b) - scoreScpText(query, a));
  return ranked.slice(0, limit);
}

export function searchScpCsvCandidatesMulti(csvText: string, queries: string[], limit = 16): ScpCandidate[] {
  const cleanedQueries = [...new Set(queries.map((value) => compactWhitespace(value)).filter(Boolean))].slice(0, 5);
  if (cleanedQueries.length === 0) return [];

  const merged: ScpCandidate[] = [];
  for (const query of cleanedQueries) {
    merged.push(...searchScpCsvCandidates(csvText, query, Math.max(limit, 12)));
  }

  const deduped = dedupeCandidates(merged);
  return [...deduped].sort((a, b) => {
    const aScore = Math.max(...cleanedQueries.map((query) => scoreScpText(query, a)));
    const bScore = Math.max(...cleanedQueries.map((query) => scoreScpText(query, b)));
    return bScore - aScore;
  }).slice(0, limit);
}

export function parseScpCsv(csvText: string): ScpCandidate[] {
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines
    .slice(1)
    .map((line) => {
      const values = splitCsvLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
      return mapScpRow(row, 'cache');
    })
    .filter((row) => Boolean(row.productId));
}

function mapScpRow(row: Record<string, unknown>, source: 'api' | 'cache'): ScpCandidate {
  const productId = String(row.id ?? row['product-id'] ?? '');
  const productName = String(row['product-name'] ?? row.name ?? 'Unknown Product');
  const consoleName = row['console-name'] ? String(row['console-name']) : null;
  const productUrl = productId && consoleName ? `https://www.sportscardspro.com/game/${slugify(consoleName)}/${slugify(productName)}` : null;
  return {
    productId,
    productName,
    consoleName,
    productUrl,
    // SportsCardsPro's current item-page 'Ungraded' price maps to loose-price.
    // retail-loose-sell is a retailer asking-price recommendation and can be materially different.
    ungradedSell: penniesOrMoney(row['loose-price'] ?? row['retail-loose-sell']),
    grade9: penniesOrMoney(row['graded-price']),
    psa10: penniesOrMoney(row['manual-only-price']),
    source,
  };
}

function penniesOrMoney(input: unknown): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return input > 1000 ? Number((input / 100).toFixed(2)) : input;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed) && trimmed.length >= 3) {
      return Number((Number(trimmed) / 100).toFixed(2));
    }
    return parseMoney(trimmed);
  }
  return null;
}

function scoreScpText(query: string, candidate: ScpCandidate): number {
  const haystack = `${candidate.productName} ${candidate.consoleName ?? ''}`.toLowerCase();
  const queryTokens = tokenizeLoose(query);
  let score = 0;
  for (const token of queryTokens) {
    if (token.length <= 1) continue;
    if (haystack.includes(token)) score += token.startsWith('#') ? 16 : 4;
  }
  const titleNumber = query.match(/#([a-z0-9-]+)/i)?.[0]?.toLowerCase();
  if (titleNumber && haystack.includes(titleNumber)) score += 14;
  if (/\[[^\]]+\]/.test(candidate.productName)) score += 2;
  if (candidate.ungradedSell !== null) score += 1;
  return score;
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function dedupeCandidates(candidates: ScpCandidate[]): ScpCandidate[] {
  const byId = new Map<string, ScpCandidate>();
  for (const candidate of candidates) {
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
      source: candidate.source === 'api' || existing.source === 'api' ? 'api' : existing.source,
    });
  }
  return [...byId.values()];
}
