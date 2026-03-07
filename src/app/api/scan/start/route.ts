import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createScan, getActiveScan } from '@/lib/db';

const schema = z.object({
  sport: z.string().min(1),
  startYear: z.number().nullable().optional(),
  endYear: z.number().nullable().optional(),
  brand: z.string().optional(),
  variant: z.string().optional(),
  insert: z.string().optional(),
  cardNumber: z.string().optional(),
  numberedOutOf: z.string().optional(),
  playerName: z.string().optional(),
  position: z.string().optional(),
  team: z.string().optional(),
  rookie: z.boolean().optional(),
  autographed: z.boolean().optional(),
  memorabilia: z.boolean().optional(),
  numberedCard: z.boolean().optional(),
  conditionMode: z.enum(['raw', 'graded', 'any']),
  listingMode: z.enum(['buy_now', 'auction']),
  auctionHours: z.number().nullable().optional(),
  maxPurchasePrice: z.number().nullable().optional(),
  minProfit: z.number().nullable().optional(),
  minMarginPct: z.number().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const existing = await getActiveScan();
    if (existing) {
      return NextResponse.json({ error: 'A scan is already active. Cancel it before starting another.' }, { status: 409 });
    }
    const parsed = schema.parse(await request.json());
    const scan = await createScan(parsed);
    return NextResponse.json(scan);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to start scan' }, { status: 500 });
  }
}
