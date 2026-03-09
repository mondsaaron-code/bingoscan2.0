import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveReview } from '@/lib/db';

const schema = z.object({ resultId: z.string().uuid(), optionId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const { resultId, optionId } = schema.parse(await request.json());
    const resolution = await resolveReview(resultId, optionId);
    return NextResponse.json({ ok: true, ...resolution });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to resolve review' }, { status: 500 });
  }
}
