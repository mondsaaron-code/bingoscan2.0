import OpenAI from 'openai';
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

export async function verifyCardMatchWithOpenAI(listing: EbayListing, candidates: ScpCandidate[]): Promise<MatchDecision> {
  const input = {
    listing: {
      title: listing.title,
      url: listing.itemWebUrl,
      condition: listing.condition,
      imageUrl: listing.imageUrl,
    },
    candidates: candidates.map((candidate) => ({
      productId: candidate.productId,
      productName: candidate.productName,
      ungradedSell: candidate.ungradedSell,
      grade9: candidate.grade9,
      psa10: candidate.psa10,
    })),
  };

  const response = await getOpenAiClient().responses.create({
    model: 'gpt-5-mini',
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text:
              'You match sports card ebay listings to the exact SportsCardsPro card record. Be conservative. Only return exactMatch true when you are highly confident in exact set, player, parallel, insert, numbering, autograph/relic status, and card number. Return JSON only.',
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify(input) }],
      },
    ],
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

  const text = response.output_text;
  return JSON.parse(text) as MatchDecision;
}
