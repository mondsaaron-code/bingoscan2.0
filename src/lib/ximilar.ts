import { getRequiredEnv } from '@/lib/env';

export type XimilarCardHints = {
  titleHints: string[];
  detectedText: string[];
  confidence: number | null;
};

export async function identifyWithXimilar(imageUrls: string[]): Promise<XimilarCardHints | null> {
  const apiKey = process.env.XIMILAR_API_KEY;
  if (!apiKey || imageUrls.length === 0) {
    return null;
  }

  const response = await fetch('https://api.ximilar.com/collectibles/v2/read', {
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
    throw new Error(`Ximilar read failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const records = Array.isArray(body.records) ? body.records : [];
  const texts: string[] = [];
  for (const record of records) {
    if (record && typeof record === 'object') {
      const data = record as Record<string, unknown>;
      const ocr = Array.isArray(data.ocr_text) ? data.ocr_text : [];
      for (const token of ocr) {
        if (typeof token === 'string') texts.push(token);
      }
    }
  }

  return {
    titleHints: texts.slice(0, 10),
    detectedText: texts,
    confidence: null,
  };
}
