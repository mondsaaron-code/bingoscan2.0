import { getRequiredEnv } from '@/lib/env';
import { compactWhitespace, tokenizeLoose } from '@/lib/utils';

export type XimilarCardHints = {
  titleHints: string[];
  detectedText: string[];
  confidence: number | null;
  callCount: number;
};

export async function identifyWithXimilar(imageUrls: string[]): Promise<XimilarCardHints | null> {
  const apiKey = process.env.XIMILAR_API_KEY;
  const urls = imageUrls.filter(Boolean).slice(0, 2);
  if (!apiKey || urls.length === 0) {
    return null;
  }

  const [sportBody, ocrBody] = await Promise.all([
    postToXimilar('/collectibles/v2/sport_id', { records: urls.map((url) => ({ _url: url })), magic_ai: true }),
    postToXimilar('/collectibles/v2/card_ocr_id', { records: urls.map((url) => ({ _url: url })) }),
  ]);

  const strings = new Set<string>();
  const confidences: number[] = [];
  collectStrings(sportBody, strings, confidences);
  collectStrings(ocrBody, strings, confidences);

  const detectedText = [...strings]
    .map((value) => compactWhitespace(value))
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 40);

  const titleHints = detectedText
    .flatMap((value) => tokenizeLoose(value))
    .filter((token) => token.length > 1)
    .filter((token, index, arr) => arr.indexOf(token) === index)
    .slice(0, 20);

  return {
    titleHints,
    detectedText,
    confidence: confidences.length > 0 ? Math.max(...confidences) : null,
    callCount: 2,
  };
}

async function postToXimilar(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.ximilar.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${getRequiredEnv('XIMILAR_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ximilar request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

function collectStrings(value: unknown, sink: Set<string>, confidences: number[]): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.length <= 120) {
      sink.add(trimmed);
    }
    return;
  }

  if (typeof value === 'number') {
    if (value >= 0 && value <= 1) confidences.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, sink, confidences);
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (key.toLowerCase().includes('confidence') && typeof nested === 'number') {
        confidences.push(nested);
      }
      collectStrings(nested, sink, confidences);
    }
  }
}
