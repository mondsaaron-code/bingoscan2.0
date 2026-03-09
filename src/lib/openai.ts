import OpenAI from 'openai';
import type { ResponseInputContent, ResponseInputItem } from 'openai/resources/responses/responses';
import type { ScpCandidate } from '@/lib/scp';
import type { EbayListing, EbayListingDetails } from '@/lib/ebay';
import { buildListingFingerprint, buildScpCandidateFingerprint, scoreFingerprintSimilarity } from '@/lib/card-fingerprint';
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
  extractedAttributes: Record<string, string | null>;
};

export type NeedsReviewTriageDecision = {
  sendToReview: boolean;
  confidence: number;
  reasoning: string;
  rejectReason: string | null;
  preferredProductId: string | null;
  topThreeProductIds: string[];
};

export async function verifyCardMatchWithOpenAI(
  listing: EbayListing,
  candidates: ScpCandidate[],
  options?: { ximilarHints?: string[] | null; details?: EbayListingDetails | null },
): Promise<MatchDecision> {
  const listingFingerprint = buildListingFingerprint(listing, {
    details: options?.details ?? null,
    ximilarHints: options?.ximilarHints ?? null,
  });

  const rankedCandidates = candidates
    .map((candidate, index) => {
      const fingerprint = buildScpCandidateFingerprint(candidate);
      return {
        candidate,
        fingerprint,
        fingerprintScore: scoreFingerprintSimilarity(listingFingerprint, fingerprint),
        index,
      };
    })
    .sort((a, b) => b.fingerprintScore - a.fingerprintScore || a.index - b.index);

  const inputPayload = {
    listing: {
      title: listing.title,
      url: listing.itemWebUrl,
      condition: listing.condition,
      imageUrl: listing.imageUrl,
      purchaseTotal: listing.total,
      subtitle: options?.details?.subtitle ?? null,
      description: options?.details?.description ?? null,
      aspects: options?.details?.aspectMap ?? {},
      seller: options?.details
        ? {
            username: options.details.sellerUsername,
            feedbackPercentage: options.details.sellerFeedbackPercentage,
            feedbackScore: options.details.sellerFeedbackScore,
          }
        : null,
      fingerprint: listingFingerprint,
    },
    ximilarHints: options?.ximilarHints ?? [],
    candidates: rankedCandidates.map(({ candidate, fingerprint, fingerprintScore }) => ({
      productId: candidate.productId,
      productName: candidate.productName,
      consoleName: candidate.consoleName,
      ungradedSell: candidate.ungradedSell,
      grade9: candidate.grade9,
      psa10: candidate.psa10,
      source: candidate.source ?? null,
      fingerprintScore,
      fingerprint,
    })),
  };

  const userContent: ResponseInputContent[] = [
    {
      type: 'input_text',
      text: JSON.stringify(inputPayload),
    },
  ];

  const imageUrls = [listing.imageUrl, ...(options?.details?.imageUrls ?? [])]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 2);

  for (const imageUrl of imageUrls) {
    userContent.push({
      type: 'input_image',
      image_url: imageUrl,
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
            'You match sports card eBay listings to the exact SportsCardsPro card record. Be conservative. Only return exactMatch true when you are highly confident in exact set, player, parallel, insert, numbering, autograph or relic status, grading context, and card number. Use the image, seller listing details, subtitle, description, item specifics, and the provided structured fingerprints. Treat mismatches on year, card number, parallel/color, serial-numbered status, autograph/relic flags, and grading lane as strong negatives. Prefer the candidate whose fingerprint best aligns with the eBay listing when the image and text agree. Return JSON only.',
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
              additionalProperties: false,
              properties: {
                year: { type: ['string', 'null'] },
                playerName: { type: ['string', 'null'] },
                brand: { type: ['string', 'null'] },
                setName: { type: ['string', 'null'] },
                cardNumber: { type: ['string', 'null'] },
                parallel: { type: ['string', 'null'] },
                serialNumberText: { type: ['string', 'null'] },
                rookie: { type: ['string', 'null'] },
                autograph: { type: ['string', 'null'] },
                memorabilia: { type: ['string', 'null'] },
                gradeContext: { type: ['string', 'null'] },
              },
              required: ['year', 'playerName', 'brand', 'setName', 'cardNumber', 'parallel', 'serialNumberText', 'rookie', 'autograph', 'memorabilia', 'gradeContext'],
            },
          },
          required: ['exactMatch', 'confidence', 'reasoning', 'chosenProductId', 'topThreeProductIds', 'extractedAttributes'],
        },
      },
    },
  });

  const parsed = JSON.parse(response.output_text) as Omit<MatchDecision, 'extractedAttributes'> & { extractedAttributes?: Record<string, string | null> };

  return {
    exactMatch: parsed.exactMatch,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    chosenProductId: parsed.chosenProductId,
    topThreeProductIds: parsed.topThreeProductIds ?? [],
    extractedAttributes: parsed.extractedAttributes ?? {},
  };
}


export async function triageNeedsReviewWithOpenAI(
  listing: EbayListing,
  candidates: ScpCandidate[],
  options?: {
    ximilarHints?: string[] | null;
    details?: EbayListingDetails | null;
    candidateMeta?: Array<{
      productId: string;
      estimatedProfit: number | null;
      estimatedMarginPct: number | null;
      reviewMemoryScore?: number | null;
      cardNumberMemoryScore?: number | null;
      aiPreferred?: boolean;
    }>;
  },
): Promise<NeedsReviewTriageDecision> {
  const listingFingerprint = buildListingFingerprint(listing, {
    details: options?.details ?? null,
    ximilarHints: options?.ximilarHints ?? null,
  });

  const metaByProductId = new Map(
    (options?.candidateMeta ?? []).map((row) => [row.productId, row]),
  );

  const rankedCandidates = candidates
    .map((candidate, index) => {
      const fingerprint = buildScpCandidateFingerprint(candidate);
      const fingerprintScore = scoreFingerprintSimilarity(listingFingerprint, fingerprint);
      const meta = metaByProductId.get(candidate.productId);
      return {
        candidate,
        fingerprint,
        fingerprintScore,
        index,
        estimatedProfit: meta?.estimatedProfit ?? null,
        estimatedMarginPct: meta?.estimatedMarginPct ?? null,
        reviewMemoryScore: meta?.reviewMemoryScore ?? null,
        cardNumberMemoryScore: meta?.cardNumberMemoryScore ?? null,
        aiPreferred: Boolean(meta?.aiPreferred),
      };
    })
    .sort((a, b) => b.fingerprintScore - a.fingerprintScore || a.index - b.index);

  const inputPayload = {
    listing: {
      title: listing.title,
      url: listing.itemWebUrl,
      condition: listing.condition,
      imageUrl: listing.imageUrl,
      price: listing.price,
      shipping: listing.shipping,
      purchaseTotal: listing.total,
      subtitle: options?.details?.subtitle ?? null,
      description: options?.details?.description ?? null,
      aspects: options?.details?.aspectMap ?? {},
      fingerprint: listingFingerprint,
    },
    ximilarHints: options?.ximilarHints ?? [],
    candidates: rankedCandidates.map((row) => ({
      productId: row.candidate.productId,
      productName: row.candidate.productName,
      consoleName: row.candidate.consoleName,
      ungradedSell: row.candidate.ungradedSell,
      grade9: row.candidate.grade9,
      psa10: row.candidate.psa10,
      source: row.candidate.source ?? null,
      fingerprintScore: row.fingerprintScore,
      estimatedProfit: row.estimatedProfit,
      estimatedMarginPct: row.estimatedMarginPct,
      reviewMemoryScore: row.reviewMemoryScore,
      cardNumberMemoryScore: row.cardNumberMemoryScore,
      aiPreferred: row.aiPreferred,
      fingerprint: row.fingerprint,
    })),
  };

  const userContent: ResponseInputContent[] = [
    {
      type: 'input_text',
      text: JSON.stringify(inputPayload),
    },
  ];

  const imageUrls = [listing.imageUrl, ...(options?.details?.imageUrls ?? [])]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 2);

  for (const imageUrl of imageUrls) {
    userContent.push({
      type: 'input_image',
      image_url: imageUrl,
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
              'You are the final triage layer for sports-card deals. Decide whether this eBay listing is worth sending to human Needs Review. Only sendToReview=true when at least one candidate looks like a credible same-card SCP match that a human could reasonably confirm. Use the image, listing details, shipping-inclusive purchase total, structured fingerprints, review-memory scores, and candidate profits. If all candidates look like weak mismatches, return sendToReview=false and explain why. Favor exact card identity over optimistic profits. Return JSON only.',
          },
        ],
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'needs_review_triage',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sendToReview: { type: 'boolean' },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
            rejectReason: { type: ['string', 'null'] },
            preferredProductId: { type: ['string', 'null'] },
            topThreeProductIds: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 3,
            },
          },
          required: ['sendToReview', 'confidence', 'reasoning', 'rejectReason', 'preferredProductId', 'topThreeProductIds'],
        },
      },
    },
  });

  const parsed = JSON.parse(response.output_text) as NeedsReviewTriageDecision;
  return {
    sendToReview: parsed.sendToReview,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    rejectReason: parsed.rejectReason ?? null,
    preferredProductId: parsed.preferredProductId ?? null,
    topThreeProductIds: parsed.topThreeProductIds ?? [],
  };
}
