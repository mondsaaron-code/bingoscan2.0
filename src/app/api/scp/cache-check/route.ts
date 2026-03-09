import { NextResponse } from 'next/server';
import { runScpCacheFreshnessCheck } from '@/lib/db';

export async function POST() {
  try {
    const summary = await runScpCacheFreshnessCheck('manual_check', { force: true });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to check SCP cache freshness' },
      { status: 500 },
    );
  }
}
