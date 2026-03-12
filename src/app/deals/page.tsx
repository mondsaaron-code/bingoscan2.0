'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase';
import { SearchForm } from '@/components/SearchForm';
import { ResultsTable } from '@/components/ResultsTable';
import { DiagnosticsPanel } from '@/components/DiagnosticsPanel';
import { ScpCacheUploader } from '@/components/ScpCacheUploader';
import { ScpCacheLibrary } from '@/components/ScpCacheLibrary';
import { ScpCacheTracker } from '@/components/ScpCacheTracker';
import { NeedsReviewBoard } from '@/components/NeedsReviewBoard';
import type { DashboardSnapshot, Disposition, SearchForm as SearchFormType } from '@/types/app';
import { toCurrency, toTitleLabel } from '@/lib/utils';

const EMPTY_DASHBOARD: DashboardSnapshot = {
  activeScan: null,
  latestScan: null,
  visibleResults: [],
  needsReviewResults: [],
  reviewOptionsByResultId: {},
  diagnostics: [],
  diagnosticsSummary: {
    topRejectionReasons: [],
    stageTimings: [],
  },
  scpCaches: [],
  scpCacheTracker: {
    totalFiles: 0,
    recentUploads: 0,
    updatedRecently: 0,
    staleFiles: 0,
    errorCount: 0,
    lastUpdatedAt: null,
    lastCheckAt: null,
    lastCheckStatus: null,
    lastCheckMessage: null,
  },
  reviewLearning: {
    totalResolved: 0,
    top1Chosen: 0,
    top3Chosen: 0,
    top1RatePct: null,
    top3RatePct: null,
    profitableSelections: 0,
    notProfitableSelections: 0,
    recentReasons: [],
  },
  usage: {
    openAiCostTodayUsd: null,
    ebayCallsToday: 0,
    scpCallsToday: 0,
    openAiCallsToday: 0,
    ximilarCallsToday: 0,
    providerLimits: [],
  },
};

export default function DealsPage() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const [dashboard, setDashboard] = useState<DashboardSnapshot>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [checkingCaches, setCheckingCaches] = useState(false);
  const [hiddenResultIds, setHiddenResultIds] = useState<string[]>([]);
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
      const body = (await response.json()) as DashboardSnapshot['activeScan'] & { error?: string };
      if (!response.ok || !body?.id) throw new Error(body?.error ?? 'Unable to start scan');
      setDashboard((current) => ({
        ...current,
        activeScan: body,
        latestScan: body,
      }));
      setBanner('Scan started. Results will stream in below.');
      try {
        await fetch('/api/scan/worker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scanId: body.id }),
        });
      } catch {
        // The polling loop will retry on the next tick.
      }
      await loadDashboard();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Unable to start scan');
    } finally {
      setBusy(false);
    }
  }

  async function cancelScan() {
    if (!dashboard.activeScan) return;
    setBanner(null);
    try {
      const response = await fetch('/api/scan/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId: dashboard.activeScan.id }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to cancel scan');
      await loadDashboard();
      setBanner('Scan cancelled.');
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Unable to cancel scan');
    }
  }

  function hideResultIds(ids: string[]) {
    setHiddenResultIds((current) => [...new Set([...current, ...ids])]);
  }

  async function setDisposition(ids: string[], disposition: Disposition) {
    setBanner(null);
    try {
      const response = await fetch('/api/scan/disposition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, disposition }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to update disposition');
      hideResultIds(ids);
      void loadDashboard();
      setBanner(`Updated ${ids.length} listing${ids.length === 1 ? '' : 's'} to ${disposition.replace(/_/g, ' ')}.`);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Unable to update disposition');
    }
  }

  async function resolveReview(resultId: string, optionId: string) {
    setBanner(null);
    try {
      const response = await fetch('/api/scan/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resultId, optionId }),
      });
      const body = (await response.json()) as { error?: string; disposition?: Disposition | null; matchedProductName?: string | null; tracked?: boolean; selectedIsAiTop1?: boolean; selectedInAiTop3?: boolean; selectedRank?: number | null };
      if (!response.ok) throw new Error(body.error ?? 'Unable to resolve review');
      if (body.disposition) hideResultIds([resultId]);
      void loadDashboard();
      const suffix = body.disposition === 'not_profitable'
        ? ' It was tracked as not profitable and removed from Deals / Needs Review.'
        : body.tracked
          ? ' The manual match was saved for future learning.'
          : '';
      const rankNote = body.selectedIsAiTop1
        ? ' AI top-1 was correct.'
        : body.selectedInAiTop3
          ? ` AI had the correct card in its top ${body.selectedRank ?? 3}.`
          : ' AI missed the winning SCP option.';
      setBanner(`Review saved${body.matchedProductName ? ` for ${body.matchedProductName}` : ''}.${suffix}${rankNote}`);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Unable to resolve review');
    }
  }

  async function checkCaches() {
    setCheckingCaches(true);
    setBanner(null);
    try {
      const response = await fetch('/api/scp/cache-check', { method: 'POST' });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to check SCP cache freshness');
      await loadDashboard();
      setBanner('SCP cache freshness check complete.');
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Unable to check SCP cache freshness');
    } finally {
      setCheckingCaches(false);
    }
  }

  const visibleResults = dashboard.visibleResults.filter((row) => !hiddenResultIds.includes(row.id));
  const needsReviewResults = dashboard.needsReviewResults.filter((row) => !hiddenResultIds.includes(row.id));

  const scanContext = dashboard.activeScan ?? dashboard.latestScan;

  const kpis = useMemo(() => {
    return [
      { label: 'OpenAI Cost Today', value: toCurrency(dashboard.usage.openAiCostTodayUsd) },
      { label: 'eBay Calls Today', value: dashboard.usage.ebayCallsToday },
      { label: 'SCP Calls Today', value: dashboard.usage.scpCallsToday },
      { label: 'OpenAI Calls Today', value: dashboard.usage.openAiCallsToday },
      { label: 'Ximilar Calls Today', value: dashboard.usage.ximilarCallsToday },
      { label: 'Deals Shown', value: visibleResults.length },
      { label: 'Needs Review', value: needsReviewResults.length },
      { label: 'Candidates Evaluated', value: scanContext?.metrics.candidatesEvaluated ?? 0 },
    ];
  }, [dashboard, scanContext, visibleResults.length, needsReviewResults.length]);

  const progress = useMemo(() => {
    const currentResults = (scanContext?.metrics.dealsFound ?? 0) + (scanContext?.metrics.needsReview ?? 0);
    const targetResults = 10;
    const processedCandidates = (scanContext?.metrics.candidatesEvaluated ?? 0) + (scanContext?.metrics.candidatesFilteredOut ?? 0);
    return {
      currentResults,
      targetResults,
      processedCandidates,
      pct: Math.min(100, Math.round((currentResults / targetResults) * 100)),
    };
  }, [scanContext]);

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

        {dashboard.usage.providerLimits.length > 0 ? (
          <div className="card card-pad stack">
            <div className="spread">
              <div>
                <div className="section-title">API Guardrails</div>
                <div className="muted small">The worker will stop scans if a configured daily call budget is reached.</div>
              </div>
            </div>
            <div className="grid grid-4">
              {dashboard.usage.providerLimits.map((limit) => (
                <div key={limit.provider} className="kpi">
                  <div className="small muted">{toTitleLabel(limit.provider)} Budget</div>
                  <div className="kpi-value" style={{ fontSize: '1rem' }}>
                    {limit.limit === null ? `${limit.used} used` : `${limit.used} / ${limit.limit}`}
                  </div>
                  <div className="small" style={{ color: limit.isExceeded ? '#ff7b7b' : limit.isNearLimit ? '#ffd166' : '#9ca8bd' }}>
                    {limit.isExceeded ? 'Limit reached' : limit.isNearLimit ? 'Near limit' : limit.limit === null ? 'No cap set' : `${limit.remaining ?? 0} remaining`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {scanContext ? (
          <div className="card card-pad stack">
            <div className="spread">
              <div>
                <div className="section-title">Scan Progress</div>
                <div className="muted small">
                  {dashboard.activeScan ? 'Live scan in progress.' : 'Showing the latest completed scan.'}
                </div>
              </div>
              <div className="badge">{toTitleLabel(scanContext.status)}</div>
            </div>
            <div>
              <div className="spread small muted" style={{ marginBottom: 8 }}>
                <span>{progress.currentResults} / {progress.targetResults} results ready</span>
                <span>{progress.processedCandidates} candidates processed</span>
              </div>
              <div style={{ height: 10, background: '#182033', borderRadius: 9999, overflow: 'hidden' }}>
                <div style={{ width: `${progress.pct}%`, height: '100%', background: 'linear-gradient(90deg, #4f8cff, #29d391)' }} />
              </div>
            </div>
            <div className="grid grid-4">
              <div className="kpi">
                <div className="small muted">Filtered Out</div>
                <div className="kpi-value">{scanContext.metrics.candidatesFilteredOut}</div>
              </div>
              <div className="kpi">
                <div className="small muted">Warnings</div>
                <div className="kpi-value">{scanContext.warningCount}</div>
              </div>
              <div className="kpi">
                <div className="small muted">Errors</div>
                <div className="kpi-value">{scanContext.errorCount}</div>
              </div>
              <div className="kpi">
                <div className="small muted">Current Stage</div>
                <div className="kpi-value" style={{ fontSize: '1rem' }}>{scanContext.stageMessage ?? '—'}</div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="card card-pad stack">
          <div className="spread">
            <div>
              <div className="section-title">Review Learning</div>
              <div className="muted small">Tracks whether the correct SCP card was AI top-1 or at least inside the AI short list so future tuning is measurable.</div>
            </div>
            <div className="badge">{dashboard.reviewLearning.totalResolved} resolved</div>
          </div>
          <div className="grid grid-4">
            <div className="kpi">
              <div className="small muted">AI Top-1 Hit Rate</div>
              <div className="kpi-value">{dashboard.reviewLearning.top1RatePct === null ? '—' : `${dashboard.reviewLearning.top1RatePct}%`}</div>
            </div>
            <div className="kpi">
              <div className="small muted">AI Top-3 Hit Rate</div>
              <div className="kpi-value">{dashboard.reviewLearning.top3RatePct === null ? '—' : `${dashboard.reviewLearning.top3RatePct}%`}</div>
            </div>
            <div className="kpi">
              <div className="small muted">Profitable Picks</div>
              <div className="kpi-value">{dashboard.reviewLearning.profitableSelections}</div>
            </div>
            <div className="kpi">
              <div className="small muted">Not Profitable Picks</div>
              <div className="kpi-value">{dashboard.reviewLearning.notProfitableSelections}</div>
            </div>
          </div>
          {dashboard.reviewLearning.recentReasons.length > 0 ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="small muted">Most common review reasons</div>
              <div className="row-actions" style={{ flexWrap: 'wrap' }}>
                {dashboard.reviewLearning.recentReasons.map((reason) => (
                  <span key={reason.reason} className="badge">{reason.count}× {reason.reason}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <SearchForm onStart={startScan} isBusy={busy || Boolean(dashboard.activeScan)} />
        <div className="grid grid-2">
          <ScpCacheUploader onUploaded={loadDashboard} />
          <ScpCacheTracker tracker={dashboard.scpCacheTracker} onCheck={checkCaches} isChecking={checkingCaches} />
        </div>
        <ScpCacheLibrary caches={dashboard.scpCaches} />

        <ResultsTable title="Deals" rows={dashboard.visibleResults} reviewOptionsByResultId={dashboard.reviewOptionsByResultId} onDisposition={setDisposition} onResolveReview={resolveReview} />
        <NeedsReviewBoard
          rows={dashboard.needsReviewResults}
          reviewOptionsByResultId={dashboard.reviewOptionsByResultId}
          onDisposition={setDisposition}
          onResolveReview={resolveReview}
        />
        <DiagnosticsPanel diagnostics={dashboard.diagnostics} summary={dashboard.diagnosticsSummary} />
      </div>
    </div>
  );
}
