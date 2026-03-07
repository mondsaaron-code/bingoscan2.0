import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addScanEvent, markScanStatus } from '@/lib/db';

const schema = z.object({ scanId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const { scanId } = schema.parse(await request.json());
    await markScanStatus(scanId, 'cancelled', 'Scan cancelled by user');
    await addScanEvent(scanId, 'warning', 'cancelled', 'Scan cancelled by user');
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to cancel scan' }, { status: 500 });
  }
}
