'use client';

import type { ScpCacheTracker as ScpCacheTrackerType } from '@/types/app';

type Props = {
  tracker: ScpCacheTrackerType;
  onCheck: () => Promise<void> | void;
  isChecking?: boolean;
};

export function ScpCacheTracker({ tracker, onCheck, isChecking = false }: Props) {
  return (
    <div className="card card-pad stack">
      <div className="spread">
        <div>
          <div className="section-title">SCP Cache Tracker</div>
          <div className="muted small">The app can automatically check freshness on login and when you press the button below. Manual SCP download/upload is still required to replace stale files.</div>
        </div>
        <button className="btn btn-ghost" type="button" onClick={() => void onCheck()} disabled={isChecking}>
          {isChecking ? 'Checking...' : 'Check Freshness'}
        </button>
      </div>

      <div className="grid grid-4">
        <div className="kpi">
          <div className="small muted">Total Files</div>
          <div className="kpi-value">{tracker.totalFiles}</div>
        </div>
        <div className="kpi">
          <div className="small muted">Updated &lt; 24h</div>
          <div className="kpi-value">{tracker.updatedRecently}</div>
        </div>
        <div className="kpi">
          <div className="small muted">Stale Files</div>
          <div className="kpi-value">{tracker.staleFiles}</div>
        </div>
        <div className="kpi">
          <div className="small muted">Errors (14d)</div>
          <div className="kpi-value">{tracker.errorCount}</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="card" style={{ padding: 12 }}>
          <div className="small muted">Last CSV updated</div>
          <div style={{ fontWeight: 600 }}>{formatDate(tracker.lastUpdatedAt)}</div>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div className="small muted">Last freshness check</div>
          <div style={{ fontWeight: 600 }}>{formatDate(tracker.lastCheckAt)}</div>
          {tracker.lastCheckStatus ? <div className="small muted">Status: {tracker.lastCheckStatus}</div> : null}
        </div>
      </div>

      {tracker.lastCheckMessage ? <div className="notice"><div className="small">{tracker.lastCheckMessage}</div></div> : null}
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
