'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';

type Props = {
  onUploaded?: () => Promise<void> | void;
};

export function ScpCacheUploader({ onUploaded }: Props) {
  const [consoleName, setConsoleName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!consoleName.trim() || !file) {
      setStatus('Add a console name and choose a CSV file first.');
      return;
    }

    setBusy(true);
    setStatus(null);
    try {
      const formData = new FormData();
      formData.append('consoleName', consoleName.trim());
      if (sourceUrl.trim()) formData.append('sourceConsoleUrl', sourceUrl.trim());
      formData.append('file', file);

      const response = await fetch('/api/scp/cache-upload', {
        method: 'POST',
        body: formData,
      });
      const body = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to upload CSV cache');
      setStatus(body.message ?? 'CSV cache uploaded.');
      setConsoleName('');
      setSourceUrl('');
      setFile(null);
      setInputKey((value) => value + 1);
      await onUploaded?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to upload CSV cache');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card card-pad stack" onSubmit={handleSubmit}>
      <div className="spread">
        <div>
          <h2 className="section-title">Upload SCP CSV</h2>
          <div className="muted small">Upload a SportsCardsPro CSV for a specific set so scans can use cached pricing and candidate rows.</div>
        </div>
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Uploading...' : 'Upload CSV'}</button>
      </div>

      <div className="grid grid-3">
        <div>
          <label className="label">Console Name</label>
          <input className="input" value={consoleName} onChange={(event) => setConsoleName(event.target.value)} placeholder="Football Cards 2024 Panini Mosaic" />
        </div>
        <div>
          <label className="label">Source Console URL</label>
          <input className="input" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://www.sportscardspro.com/console/..." />
        </div>
        <div>
          <label className="label">CSV File</label>
          <input
            key={inputKey}
            className="input"
            type="file"
            accept=".csv,text/csv"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>
      </div>

      {status ? <div className="notice">{status}</div> : null}
    </form>
  );
}
