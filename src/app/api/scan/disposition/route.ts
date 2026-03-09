import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setDisposition } from '@/lib/db';

const schema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  disposition: z.enum(['purchased', 'suppress_90_days', 'bad_logic', 'not_profitable']),
});

export async function POST(request: Request) {
  try {
    const { ids, disposition } = schema.parse(await request.json());
    await setDisposition(ids, disposition);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to set disposition' }, { status: 500 });
  }
}
