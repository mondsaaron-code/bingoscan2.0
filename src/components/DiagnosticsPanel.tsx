'use client';

export function DiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: Array<{ id: string; level: 'info' | 'warning' | 'error'; stage: string; message: string; details: string | null; createdAt: string }>;
}) {
  return (
    <details className="card card-pad" open>
      <summary className="section-title" style={{ cursor: 'pointer' }}>Scan Diagnostics</summary>
      <div className="stack" style={{ marginTop: 16 }}>
        {diagnostics.length === 0 ? <div className="muted">No diagnostics yet.</div> : null}
        {diagnostics.map((item) => (
          <div key={item.id} className={item.level === 'error' ? 'notice error' : item.level === 'warning' ? 'notice' : 'notice success'}>
            <div className="spread">
              <strong>{item.stage}</strong>
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
