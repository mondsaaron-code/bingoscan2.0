import { getRequiredEnv } from '@/lib/env';

type CostCache = {
  key: string;
  expiresAt: number;
  value: number | null;
};

let todayCostCache: CostCache | null = null;

export async function getOpenAiTodayCostUsd(): Promise<number | null> {
  const adminKey = process.env.OPENAI_ADMIN_KEY;
  if (!adminKey) return null;

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  if (todayCostCache && todayCostCache.key === todayKey && todayCostCache.expiresAt > Date.now()) {
    return todayCostCache.value;
  }

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startTime = Math.floor(start.getTime() / 1000);
  const endTime = Math.floor(now.getTime() / 1000);

  const response = await fetch(`https://api.openai.com/v1/organization/costs?start_time=${startTime}&end_time=${endTime}`, {
    headers: {
      Authorization: `Bearer ${getRequiredEnv('OPENAI_ADMIN_KEY')}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    todayCostCache = {
      key: todayKey,
      expiresAt: Date.now() + 60_000,
      value: null,
    };
    return null;
  }

  const body = (await response.json()) as {
    data?: Array<{ results?: Array<{ amount?: { value?: number } }> }>;
  };

  let total = 0;
  for (const bucket of body.data ?? []) {
    for (const result of bucket.results ?? []) {
      total += result.amount?.value ?? 0;
    }
  }

  todayCostCache = {
    key: todayKey,
    expiresAt: Date.now() + 5 * 60_000,
    value: total,
  };

  return total;
}
