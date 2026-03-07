import OpenAI from 'openai';
import type { ResponseInputContent, ResponseInputItem } from 'openai/resources/responses/responses';
import type { ScpCandidate } from '@/lib/scp';
import type { EbayListing } from '@/lib/ebay';
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
  options?: { ximilarHints?: string[] | null },
): Promise<MatchDecision> {
  const inputPayload = {
    listing: {
      title: listing.title,
      url: listing.itemWebUrl,
      condition: listing.condition,
      imageUrl: listing.imageUrl,
      purchaseTotal: listing.total,
    },
    ximilarHints: options?.ximilarHints ?? [],
    candidates: candidates.map((candidate) => ({
      productId: candidate.productId,
      productName: candidate.productName,
      consoleName: candidate.consoleName,
      ungradedSell: candidate.ungradedSell,
      grade9: candidate.grade9,
      psa10: candidate.psa10,
    })),
  };

  const userContent: ResponseInputContent[] = [
    {
      type: 'input_text',
      text: JSON.stringify(inputPayload),
    },
  ];

  if (listing.imageUrl) {
    userContent.push({
      type: 'input_image',
      image_url: listing.imageUrl,
      detail: 'high',
    });
  }

  const inputItems: ResponseInputItem[] = [
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text:
            'You match sports card eBay listings to the exact SportsCardsPro card record. Be conservative. Only return exactMatch true when you are highly confident in exact set, player, parallel, insert, numbering, autograph or relic status, grading context, and card number. Use the image when available. Return JSON only.',
        },
      ],
    },
    {
      role: 'user',
      content: userContent,
    },
  ];

  const response = await getOpenAiClient().responses.create({
    model: 'gpt-5-mini',
    input: inputItems,
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

  return JSON.parse(response.output_text) as MatchDecision;
}
