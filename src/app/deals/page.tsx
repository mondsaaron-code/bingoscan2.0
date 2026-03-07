'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase';
import { SearchForm } from '@/components/SearchForm';
import { ResultsTable } from '@/components/ResultsTable';
import { DiagnosticsPanel } from '@/components/DiagnosticsPanel';
import { ScpCacheUploader } from '@/components/ScpCacheUploader';
import type { DashboardSnapshot, Disposition, SearchForm as SearchFormType } from '@/types/app';
import { toCurrency } from '@/lib/utils';

const EMPTY_DASHBOARD: DashboardSnapshot = {
  activeScan: null,
  latestScan: null,
  visibleResults: [],
  needsReviewResults: [],
  reviewOptionsByResultId: {},
  diagnostics: [],
  usage: {
    openAiCostTodayUsd: null,
    ebayCallsToday: 0,
    scpCallsToday: 0,
    openAiCallsToday: 0,
    ximilarCallsToday: 0,
  },
};

export default function DealsPage() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const [dashboard, setDashboard] = useState<DashboardSnapshot>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const intervalRef = useRef<number | null>(null);

  const loadDashboard = useCallback(async () => {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    const body = (await response.json()) as DashboardSnapshot & { error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Dashboard load failed');
    setDashboard(body);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.replace('/login');
        return;
      }
      loadDashboard().finally(() => setLoading(false));
    });
  }, [loadDashboard, router, supabase.auth]);

  useEffect(() => {
    if (!dashboard.activeScan) {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }
    if (!intervalRef.current) {
      intervalRef.current = window.setInterval(async () => {
        try {
          await fetch('/api/scan/worker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scanId: dashboard.activeScan?.id }),
          });
          await loadDashboard();
        } catch (error) {
          console.error(error);
        }
      }, 2500);
    }
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [dashboard.activeScan, loadDashboard]);

  async function startScan(filters: SearchFormType) {
    setBusy(true);
    setBanner(null);
    try {
      const response = await fetch('/api/scan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to start scan');
      setBanner('Scan started. Results will stream in below.');
      await loadDashboard();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Unable to start scan');
    } finally {
      setBusy(false);
    }
  }

  async function cancelScan() {
    if (!dashboard.activeScan) return;
    await fetch('/api/scan/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: dashboard.activeScan.id }),
    });
    await loadDashboard();
  }

  async function setDisposition(ids: string[], disposition: Disposition) {
    await fetch('/api/scan/disposition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, disposition }),
    });
    await loadDashboard();
  }

  async function resolveReview(resultId: string, optionId: string) {
    await fetch('/api/scan/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultId, optionId }),
    });
    await loadDashboard();
  }

  const scanContext = dashboard.activeScan ?? dashboard.latestScan;

  const kpis = useMemo(() => {
    return [
      { label: 'OpenAI Cost Today', value: toCurrency(dashboard.usage.openAiCostTodayUsd) },
      { label: 'eBay Calls Today', value: dashboard.usage.ebayCallsToday },
      { label: 'SCP Calls Today', value: dashboard.usage.scpCallsToday },
      { label: 'OpenAI Calls Today', value: dashboard.usage.openAiCallsToday },
      { label: 'Ximilar Calls Today', value: dashboard.usage.ximilarCallsToday },
      { label: 'Deals Found', value: scanContext?.metrics.dealsFound ?? 0 },
      { label: 'Needs Review', value: scanContext?.metrics.needsReview ?? 0 },
      { label: 'Candidates Evaluated', value: scanContext?.metrics.candidatesEvaluated ?? 0 },
    ];
  }, [dashboard, scanContext]);

  if (loading) {
    return (
      <div className="page-shell">
        <div className="container">
          <div className="muted">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="container stack">
        <div className="header">
          <div>
            <h1 className="h1">Bingo Scan 3.0</h1>
            <div className="muted">eBay deal finder for sports cards against SportsCardsPro</div>
          </div>
          <div className="row-actions">
            {dashboard.activeScan ? (
              <div className="badge">{dashboard.activeScan.status} · {dashboard.activeScan.stageMessage ?? 'Running'}</div>
            ) : scanContext ? (
              <div className="badge">Last scan: {scanContext.status}</div>
            ) : (
              <div className="badge">Idle</div>
            )}
            {dashboard.activeScan ? <button className="btn btn-danger" onClick={cancelScan}>Cancel Scan</button> : null}
          </div>
        </div>

        {banner ? <div className="notice">{banner}</div> : null}

        <div className="grid grid-4">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="kpi">
              <div className="small muted">{kpi.label}</div>
              <div className="kpi-value">{kpi.value}</div>
            </div>
          ))}
        </div>

        <SearchForm onStart={startScan} isBusy={busy || Boolean(dashboard.activeScan)} />
        <ScpCacheUploader />

        <ResultsTable title="Deals" rows={dashboard.visibleResults} onDisposition={setDisposition} />
        <ResultsTable
          title="Needs Review"
          rows={dashboard.needsReviewResults}
          reviewOptionsByResultId={dashboard.reviewOptionsByResultId}
          onDisposition={setDisposition}
          onResolveReview={resolveReview}
        />
        <DiagnosticsPanel diagnostics={dashboard.diagnostics} />
      </div>
    </div>
  );
}
