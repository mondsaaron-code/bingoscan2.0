import { getRequiredEnv } from '@/lib/env';

export type XimilarCardHints = {
  titleHints: string[];
  detectedText: string[];
  confidence: number | null;
};

const IDENTIFY_ENDPOINT = 'https://api.ximilar.com/collectibles/v2/sport_id';
const OCR_ENDPOINT = 'https://api.ximilar.com/collectibles/v2/card_ocr_id';

export async function identifyWithXimilar(imageUrls: string[]): Promise<XimilarCardHints | null> {
  if (!process.env.XIMILAR_API_KEY || imageUrls.length === 0) {
    return null;
  }

  const [identifyResult, ocrResult] = await Promise.allSettled([
    callXimilar(IDENTIFY_ENDPOINT, imageUrls),
    callXimilar(OCR_ENDPOINT, imageUrls),
  ]);

  const hintBucket = new Set<string>();
  const textBucket = new Set<string>();
  const confidences: number[] = [];

  for (const result of [identifyResult, ocrResult]) {
    if (result.status !== 'fulfilled') continue;
    collectStrings(result.value, hintBucket, textBucket, confidences);
  }

  if (hintBucket.size === 0 && textBucket.size === 0) {
    return null;
  }

  return {
    titleHints: [...hintBucket].slice(0, 12),
    detectedText: [...textBucket].slice(0, 40),
    confidence: confidences.length > 0 ? Math.max(...confidences) : null,
  };
}

async function callXimilar(endpoint: string, imageUrls: string[]): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Token ${getRequiredEnv('XIMILAR_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      records: imageUrls.map((url) => ({ _url: url })),
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ximilar request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

function collectStrings(
  value: unknown,
  hintBucket: Set<string>,
  textBucket: Set<string>,
  confidences: number[],
  path: string[] = [],
): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'number') {
    if (path[path.length - 1] === 'prob' || path[path.length - 1] === 'confidence') {
      confidences.push(value);
    }
    return;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || /^https?:\/\//i.test(trimmed)) return;
    if (trimmed.length > 80) return;
    if (/[a-z0-9]/i.test(trimmed)) {
      textBucket.add(trimmed);
      if (shouldUseAsHint(path[path.length - 1] ?? '')) {
        hintBucket.add(trimmed);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, hintBucket, textBucket, confidences, path);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(child, hintBucket, textBucket, confidences, [...path, key]);
    }
  }
}

function shouldUseAsHint(key: string): boolean {
  return [
    'name',
    'title',
    'player',
    'athlete',
    'year',
    'set',
    'series',
    'subset',
    'parallel',
    'variant',
    'brand',
    'card_number',
    'number',
    'ocr_text',
    'text',
  ].includes(key);
}
