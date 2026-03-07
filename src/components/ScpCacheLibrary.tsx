import type { ScpCacheEntry } from '@/types/app';

export function ScpCacheLibrary({ caches }: { caches: ScpCacheEntry[] }) {
  return (
    <div className="card card-pad stack">
      <div className="spread">
        <div>
          <div className="section-title">SCP Cache Library</div>
          <div className="muted small">Uploaded SportsCardsPro set files available for faster matching.</div>
        </div>
        <div className="badge">{caches.length} cached set{caches.length === 1 ? '' : 's'}</div>
      </div>
      {caches.length === 0 ? (
        <div className="muted small">No SCP set caches uploaded yet.</div>
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
                  <div>Updated {formatDate(cache.updatedAt)}</div>
                  {cache.downloadedAt ? <div>Downloaded {formatDate(cache.downloadedAt)}</div> : null}
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
