'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then((result) => {
      if (result.data.session) router.replace('/deals');
    });
  }, [router, supabase.auth]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    router.replace('/deals');
  }

  return (
    <div className="page-shell">
      <div className="container" style={{ maxWidth: 480 }}>
        <div className="card card-pad stack">
          <div>
            <h1 className="h1">Bingo Scan 3.0</h1>
            <div className="muted">Sign in to scan eBay listings against SportsCardsPro.</div>
          </div>
          <form className="stack" onSubmit={handleSubmit}>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </div>
            {error ? <div className="notice error">{error}</div> : null}
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign In'}</button>
          </form>
        </div>
      </div>
    </div>
  );
}
