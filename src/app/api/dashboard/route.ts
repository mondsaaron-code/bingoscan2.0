import { NextResponse } from 'next/server';
import { getDashboardSnapshot } from '@/lib/db';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : 'Dashboard route failed';
  } catch {
    return 'Dashboard route failed';
  }
}

export async function GET() {
  try {
    const data = await getDashboardSnapshot();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
