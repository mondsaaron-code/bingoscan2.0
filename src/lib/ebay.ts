import { buildEbayQueryTerms } from '@/lib/filters';
import { getRequiredEnv } from '@/lib/env';
import { compactWhitespace } from '@/lib/utils';
import type { SearchForm } from '@/types/app';

export type EbayListing = {
  itemId: string;
  title: string;
  itemWebUrl: string;
  imageUrl: string | null;
  price: number;
  shipping: number;
  total: number;
  auctionEndsAt: string | null;
  condition: string | null;
};

export type EbayListingDetails = {
  itemId: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  condition: string | null;
  aspectMap: Record<string, string[]>;
  sellerUsername: string | null;
  sellerFeedbackPercentage: number | null;
  sellerFeedbackScore: number | null;
  imageUrls: string[];
};

type EbayTokenResponse = {
  access_token: string;
  expires_in: number;
};

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

async function getEbayAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.accessToken;
  }

  const clientId = getRequiredEnv('EBAY_CLIENT_ID');
  const clientSecret = getRequiredEnv('EBAY_CLIENT_SECRET');
  const environment = process.env.EBAY_ENVIRONMENT === 'sandbox' ? 'api.sandbox.ebay.com' : 'api.ebay.com';

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`https://${environment}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay token request failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as EbayTokenResponse;
  tokenCache = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return body.access_token;
}

export async function searchEbayListings(filters: SearchForm, offset = 0, limit = 50): Promise<EbayListing[]> {
  const token = await getEbayAccessToken();
  const environment = process.env.EBAY_ENVIRONMENT === 'sandbox' ? 'api.sandbox.ebay.com' : 'api.ebay.com';

  const q = buildEbayQueryTerms(filters).join(' ');
  const params = new URLSearchParams({
    q,
    limit: String(limit),
    offset: String(offset),
    sort: filters.listingMode === 'auction' ? 'endingSoonest' : 'newlyListed',
    category_ids: sportToCategoryId(filters.sport),
    filter: buildEbayFilter(filters),
  });

  const response = await fetch(`https://${environment}/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay search failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as {
    itemSummaries?: Array<{
      itemId?: string;
      title?: string;
      itemWebUrl?: string;
      image?: { imageUrl?: string };
      price?: { value?: string };
      shippingOptions?: Array<{ shippingCost?: { value?: string } }>;
      buyingOptions?: string[];
      itemEndDate?: string;
      condition?: string;
    }>;
  };

  let listings = (body.itemSummaries ?? [])
    .filter((item) => item.itemId && item.title && item.itemWebUrl && item.price?.value)
    .map((item) => {
      const shipping = Number(item.shippingOptions?.[0]?.shippingCost?.value ?? '0');
      const price = Number(item.price?.value ?? '0');
      return {
        itemId: item.itemId!,
        title: item.title!,
        itemWebUrl: item.itemWebUrl!,
        imageUrl: item.image?.imageUrl ?? null,
        price,
        shipping,
        total: price + shipping,
        auctionEndsAt: item.buyingOptions?.includes('AUCTION') ? item.itemEndDate ?? null : null,
        condition: item.condition ?? null,
      } satisfies EbayListing;
    });

  if (filters.minPurchasePrice && filters.minPurchasePrice > 0) {
    listings = listings.filter((listing) => listing.total >= filters.minPurchasePrice!);
  }
  if (filters.maxPurchasePrice && filters.maxPurchasePrice > 0) {
    listings = listings.filter((listing) => listing.total <= filters.maxPurchasePrice!);
  }

  return filters.listingMode === 'auction' && filters.auctionHours
    ? listings.filter((listing) => isWithinAuctionWindow(listing.auctionEndsAt, filters.auctionHours ?? null))
    : listings;
}

export async function getEbayListingDetails(itemId: string): Promise<EbayListingDetails | null> {
  const token = await getEbayAccessToken();
  const environment = process.env.EBAY_ENVIRONMENT === 'sandbox' ? 'api.sandbox.ebay.com' : 'api.ebay.com';

  const response = await fetch(`https://${environment}/buy/browse/v1/item/${encodeURIComponent(itemId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay item lookup failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as {
    itemId?: string;
    title?: string;
    subtitle?: string;
    shortDescription?: string;
    description?: string;
    condition?: string;
    localizedAspects?: Array<{ name?: string; value?: string }>;
    seller?: {
      username?: string;
      feedbackPercentage?: string | number;
      feedbackScore?: number;
    };
    image?: { imageUrl?: string };
    additionalImages?: Array<{ imageUrl?: string }>;
  };

  if (!body.itemId || !body.title) return null;

  const imageUrls = uniqueStrings([
    body.image?.imageUrl ?? null,
    ...(body.additionalImages ?? []).map((image) => image.imageUrl ?? null),
  ]);

  return {
    itemId: body.itemId,
    title: body.title,
    subtitle: body.subtitle ? compactWhitespace(body.subtitle) : null,
    description: body.description ? compactWhitespace(body.description) : body.shortDescription ? compactWhitespace(body.shortDescription) : null,
    condition: body.condition ?? null,
    aspectMap: mapLocalizedAspects(body.localizedAspects ?? []),
    sellerUsername: body.seller?.username ?? null,
    sellerFeedbackPercentage: body.seller?.feedbackPercentage === undefined || body.seller?.feedbackPercentage === null
      ? null
      : Number(String(body.seller.feedbackPercentage).replace(/%/g, '')),
    sellerFeedbackScore: body.seller?.feedbackScore === undefined || body.seller?.feedbackScore === null ? null : Number(body.seller.feedbackScore),
    imageUrls,
  };
}

function mapLocalizedAspects(aspects: Array<{ name?: string; value?: string }>): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const aspect of aspects) {
    const name = normalizeAspectName(aspect.name ?? '');
    const value = compactWhitespace(aspect.value ?? '');
    if (!name || !value) continue;
    output[name] ||= [];
    if (!output[name].includes(value)) output[name].push(value);
  }
  return output;
}

function normalizeAspectName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value)).filter((value, index, arr) => arr.indexOf(value) === index);
}

function sportToCategoryId(_sport: string): string {
  return '261328';
}



function buildEbayFilter(filters: SearchForm): string {
  const chunks: string[] = [];
  const minPrice = filters.minPurchasePrice && filters.minPurchasePrice > 0 ? filters.minPurchasePrice : null;
  const maxPrice = filters.maxPurchasePrice && filters.maxPurchasePrice > 0 ? filters.maxPurchasePrice : null;
  if (minPrice !== null || maxPrice !== null) {
    chunks.push(`price:[${minPrice ?? '..'}..${maxPrice ?? '..'}]`);
  }
  if (filters.listingMode === 'auction') {
    chunks.push('buyingOptions:{AUCTION}');
  } else {
    chunks.push('buyingOptions:{FIXED_PRICE}');
  }
  return chunks.join(',');
}

function isWithinAuctionWindow(auctionEndsAt: string | null, hours: number | null): boolean {
  if (!auctionEndsAt || !hours) return true;
  const target = new Date(auctionEndsAt).getTime();
  if (!Number.isFinite(target)) return false;
  const diffMs = target - Date.now();
  return diffMs > 0 && diffMs <= hours * 60 * 60 * 1000;
}
