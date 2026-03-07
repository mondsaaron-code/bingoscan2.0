import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runScanWorkerTick } from '@/lib/orchestrator';
import { addScanEvent, markScanStatus } from '@/lib/db';

const schema = z.object({ scanId: z.string().uuid() });

export async function POST(request: Request) {
  const cloned = request.clone();
  try {
    const { scanId } = schema.parse(await request.json());
    const scan = await runScanWorkerTick(scanId);
    return NextResponse.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Worker tick failed';
    try {
      const body = (await cloned.json().catch(() => null)) as { scanId?: string } | null;
      if (body?.scanId) {
        await markScanStatus(body.scanId, 'failed', message);
        await addScanEvent(body.scanId, 'error', 'worker', message);
      }
    } catch {
      // no-op
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
