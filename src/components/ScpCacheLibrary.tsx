import type { ScpCacheEntry } from '@/types/app';

export function ScpCacheLibrary({ caches }: { caches: ScpCacheEntry[] }) {
  return (
    <div className="card card-pad stack">
      <div className="spread">
        <div>
          <div className="section-title">Indexed SCP CSV Files</div>
          <div className="muted small">Showing the latest indexed SCP CSV files tracked by the app.</div>
        </div>
        <div className="badge">{caches.length} shown</div>
      </div>
      {caches.length === 0 ? (
        <div className="muted small">No indexed SCP CSV files were found.</div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {caches.map((cache) => (
            <div key={cache.id} className="card" style={{ padding: 12 }}>
              <div className="spread" style={{ gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{cache.consoleName}</div>
                  <div className="muted small">{cache.cacheKey}</div>
                </div>
                <div className="small muted" style={{ textAlign: 'right' }}>
                  <div>Uploaded {formatDate(cache.createdAt ?? cache.updatedAt)}</div>
                  <div>Updated {formatDate(cache.updatedAt)}</div>
                </div>
              </div>
              {cache.sourceConsoleUrl ? (
                <div className="small" style={{ marginTop: 8 }}>
                  <a href={cache.sourceConsoleUrl} target="_blank" rel="noreferrer">Open source console page</a>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
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
