import { parseMoney, slugify } from '@/lib/utils';
import { getRequiredEnv } from '@/lib/env';

export type ScpCandidate = {
  productId: string;
  productName: string;
  consoleName: string | null;
  productUrl: string | null;
  ungradedSell: number | null;
  grade9: number | null;
  psa10: number | null;
};

export function scpSetCacheKey(consoleName: string): string {
  return `${slugify(consoleName)}.csv`;
}

export async function searchSportsCardsProCandidates(query: string): Promise<ScpCandidate[]> {
  const baseUrl = process.env.SPORTSCARDSPRO_API_BASE_URL ?? 'https://www.sportscardspro.com';
  const token = getRequiredEnv('SPORTSCARDSPRO_API_TOKEN');
  const params = new URLSearchParams({ query, type: 'price-guide' });

  const response = await fetch(`${baseUrl}/api/products?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SportsCardsPro lookup failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as Array<Record<string, unknown>>;
  return body.slice(0, 20).map((row) => mapScpRow(row));
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

function mapScpRow(row: Record<string, unknown>): ScpCandidate {
  const productId = String(row.id ?? row['product-id'] ?? '');
  const productName = String(row['product-name'] ?? row.name ?? 'Unknown Product');
  const consoleName = row['console-name'] ? String(row['console-name']) : null;
  const productUrl = productId ? `https://www.sportscardspro.com/game/${slugify(consoleName ?? 'cards')}/${productId}` : null;
  return {
    productId,
    productName,
    consoleName,
    productUrl,
    ungradedSell: parseMoney(row['retail-loose-sell'] as string | number | undefined),
    grade9: parseMoney(row['graded-price'] as string | number | undefined),
    psa10: parseMoney(row['manual-only-price'] as string | number | undefined),
  };
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
