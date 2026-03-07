import { getRequiredEnv } from '@/lib/env';
import { parseMoney, sleep, slugify } from '@/lib/utils';

export type ScpCandidate = {
  productId: string;
  productName: string;
  consoleName: string | null;
  productUrl: string | null;
  ungradedSell: number | null;
  grade9: number | null;
  psa10: number | null;
};

export type ScpHydrationResult = {
  candidates: ScpCandidate[];
  apiCalls: number;
};

const SCP_MIN_INTERVAL_MS = 1100;
let lastScpRequestAt = 0;

export function scpSetCacheKey(consoleName: string): string {
  return `${slugify(consoleName)}.csv`;
}

export async function searchSportsCardsProCandidates(query: string): Promise<ScpCandidate[]> {
  const body = await fetchScpJson('/api/products', { q: query });
  const rows = Array.isArray(body.products) ? body.products : Array.isArray(body) ? body : [];
  return rows.slice(0, 20).map((row) => mapScpRow(asRecord(row)));
}

export async function getSportsCardsProProductById(productId: string): Promise<ScpCandidate | null> {
  if (!productId) return null;
  const body = await fetchScpJson('/api/product', { id: productId });
  if (!body || typeof body !== 'object') return null;
  return mapScpRow(asRecord(body));
}

export async function hydrateSportsCardsProCandidates(candidates: ScpCandidate[], maxCount = 5): Promise<ScpHydrationResult> {
  if (candidates.length === 0) {
    return { candidates: [], apiCalls: 0 };
  }

  const detailById = new Map<string, ScpCandidate>();
  let apiCalls = 0;

  for (const candidate of candidates.slice(0, maxCount)) {
    const detailed = await getSportsCardsProProductById(candidate.productId);
    apiCalls += 1;
    if (detailed) {
      detailById.set(candidate.productId, detailed);
    }
  }

  return {
    apiCalls,
    candidates: candidates.map((candidate) => detailById.get(candidate.productId) ?? candidate),
  };
}

export function parseScpCsv(csvText: string): ScpCandidate[] {
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    return mapScpRow(row);
  });
}

async function waitForScpSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, SCP_MIN_INTERVAL_MS - (now - lastScpRequestAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastScpRequestAt = Date.now();
}

async function fetchScpJson(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const baseUrl = process.env.SPORTSCARDSPRO_API_BASE_URL ?? 'https://www.sportscardspro.com';
  const token = getRequiredEnv('SPORTSCARDSPRO_API_TOKEN');
  await waitForScpSlot();

  const url = new URL(path, baseUrl);
  url.searchParams.set('t', token);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SportsCardsPro request failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  if (String(body.status ?? 'success').toLowerCase() === 'error') {
    throw new Error(`SportsCardsPro error: ${String(body.message ?? body.error ?? 'Unknown API error')}`);
  }
  return body;
}

function mapScpRow(row: Record<string, unknown>): ScpCandidate {
  const productId = String(row.id ?? row['product-id'] ?? '');
  const productName = String(row['product-name'] ?? row.name ?? 'Unknown Product');
  const consoleName = row['console-name'] ? String(row['console-name']) : null;
  const productUrl = buildScpProductUrl(consoleName, productName);
  return {
    productId,
    productName,
    consoleName,
    productUrl,
    ungradedSell: parseScpPrice(row['retail-loose-sell']),
    grade9: parseScpPrice(row['graded-price']),
    psa10: parseScpPrice(row['manual-only-price']),
  };
}

function buildScpProductUrl(consoleName: string | null, productName: string | null): string | null {
  if (!consoleName || !productName) return null;
  return `https://www.sportscardspro.com/game/${slugify(consoleName)}/${slugify(productName.replace(/#/g, ' '))}`;
}

function parseScpPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value / 100 : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('$') || trimmed.includes('.') || trimmed.includes(',')) {
    return parseMoney(trimmed);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed) / 100;
  }
  return parseMoney(trimmed);
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
