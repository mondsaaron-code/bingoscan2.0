'use client';

import { formatDurationSeconds, toTitleLabel } from '@/lib/utils';

export function DiagnosticsPanel({
  diagnostics,
  summary,
}: {
  diagnostics: Array<{ id: string; level: 'info' | 'warning' | 'error'; stage: string; message: string; details: string | null; createdAt: string }>;
  summary: {
    topRejectionReasons: Array<{ reason: string; count: number }>;
    stageTimings: Array<{ stage: string; seconds: number; eventCount: number }>;
  };
}) {
  return (
    <details className="card card-pad" open>
      <summary className="section-title" style={{ cursor: 'pointer' }}>Scan Diagnostics</summary>
      <div className="stack" style={{ marginTop: 16 }}>
        <div className="grid grid-2">
          <div className="card" style={{ padding: 16 }}>
            <div className="small muted" style={{ marginBottom: 8 }}>Stage Timings</div>
            <div className="stack">
              {summary.stageTimings.length === 0 ? <div className="muted">No stage timing data yet.</div> : null}
              {summary.stageTimings.map((item) => (
                <div key={item.stage} className="spread">
                  <div>
                    <strong>{toTitleLabel(item.stage)}</strong>
                    <div className="small muted">{item.eventCount} event{item.eventCount === 1 ? '' : 's'}</div>
                  </div>
                  <div>{formatDurationSeconds(item.seconds)}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div className="small muted" style={{ marginBottom: 8 }}>Top Rejection Reasons</div>
            <div className="stack">
              {summary.topRejectionReasons.length === 0 ? <div className="muted">No rejection reasons yet.</div> : null}
              {summary.topRejectionReasons.map((item) => (
                <div key={item.reason} className="spread">
                  <div style={{ maxWidth: '80%' }}>{item.reason}</div>
                  <strong>{item.count}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>

        {diagnostics.length === 0 ? <div className="muted">No diagnostics yet.</div> : null}
        {diagnostics.map((item) => (
          <div key={item.id} className={item.level === 'error' ? 'notice error' : item.level === 'warning' ? 'notice' : 'notice success'}>
            <div className="spread">
              <strong>{toTitleLabel(item.stage)}</strong>
              <span className="small muted">{new Date(item.createdAt).toLocaleTimeString()}</span>
            </div>
            <div>{item.message}</div>
            {item.details ? <div className="code">{item.details}</div> : null}
          </div>
        ))}
      </div>
    </details>
  );
}
