import { NextResponse } from 'next/server';
import { getDashboardSnapshot } from '@/lib/db';

export async function GET() {
  try {
    const data = await getDashboardSnapshot();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Dashboard route failed' },
      { status: 500 },
    );
  }
}
