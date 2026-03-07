import OpenAI from 'openai';
import type { ScpCandidate } from '@/lib/scp';
import type { EbayListing } from '@/lib/ebay';
import type { XimilarCardHints } from '@/lib/ximilar';
import { getRequiredEnv } from '@/lib/env';

function getOpenAiClient() {
  return new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY') });
}

export type MatchDecision = {
  exactMatch: boolean;
  confidence: number;
  reasoning: string;
  chosenProductId: string | null;
  topThreeProductIds: string[];
  extractedAttributes: Record<string, string>;
};

export async function verifyCardMatchWithOpenAI(
  listing: EbayListing,
  candidates: ScpCandidate[],
  ximilarHints?: XimilarCardHints | null,
): Promise<MatchDecision> {
  const input = {
    listing: {
      title: listing.title,
      url: listing.itemWebUrl,
      condition: listing.condition,
      purchasePrice: listing.price,
      shippingPrice: listing.shipping,
      totalPurchasePrice: listing.total,
    },
    ximilarHints: ximilarHints
      ? {
          titleHints: ximilarHints.titleHints,
          detectedText: ximilarHints.detectedText.slice(0, 20),
          confidence: ximilarHints.confidence,
        }
      : null,
    candidates: candidates.map((candidate) => ({
      productId: candidate.productId,
      productName: candidate.productName,
      consoleName: candidate.consoleName,
      ungradedSell: candidate.ungradedSell,
      grade9: candidate.grade9,
      psa10: candidate.psa10,
    })),
  };

  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: JSON.stringify(input),
    },
  ];

  if (listing.imageUrl) {
    userContent.push({
      type: 'input_image',
      image_url: listing.imageUrl,
      detail: 'high',
    });
  }

  const response = await getOpenAiClient().responses.create({
    model: 'gpt-5-mini',
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text:
              'You match sports card eBay listings to the exact SportsCardsPro card record. Be conservative. Only return exactMatch=true when you are highly confident in the exact set, player, parallel, insert, numbering, autograph or relic status, and card number. Use the image if provided. If uncertain, choose exactMatch=false, provide the top three candidate product IDs, and explain the ambiguity. Return JSON only.',
          },
        ],
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    max_output_tokens: 500,
    text: {
      format: {
        type: 'json_schema',
        name: 'match_decision',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            exactMatch: { type: 'boolean' },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
            chosenProductId: { type: ['string', 'null'] },
            topThreeProductIds: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 3,
            },
            extractedAttributes: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['exactMatch', 'confidence', 'reasoning', 'chosenProductId', 'topThreeProductIds', 'extractedAttributes'],
        },
      },
    },
  });

  const text = response.output_text?.trim();
  if (!text) {
    throw new Error('OpenAI returned an empty match response');
  }

  return JSON.parse(text) as MatchDecision;
}
