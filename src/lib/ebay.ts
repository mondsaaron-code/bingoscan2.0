import { buildKeywordClauses, buildNegativeClauses } from '@/lib/filters';
import { getRequiredEnv } from '@/lib/env';
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

  const q = [...buildKeywordClauses(filters), ...buildNegativeClauses(filters).map((value) => `-${value}`)].join(' ');
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

  const listings = (body.itemSummaries ?? [])
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

  return filters.listingMode === 'auction' && filters.auctionHours
    ? listings.filter((listing) => isWithinAuctionWindow(listing.auctionEndsAt, filters.auctionHours ?? null))
    : listings;
}

function sportToCategoryId(sport: string): string {
  const normalized = sport.trim().toLowerCase();
  if (normalized === 'baseball') return '213';
  if (normalized === 'basketball') return '214';
  if (normalized === 'football') return '215';
  if (normalized === 'hockey') return '216';
  return '261328';
}

function buildEbayFilter(filters: SearchForm): string {
  const chunks: string[] = [];
  if (filters.maxPurchasePrice) {
    chunks.push(`price:[..${filters.maxPurchasePrice}]`);
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
