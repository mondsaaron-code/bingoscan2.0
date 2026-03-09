alter table if exists public.scan_results
  drop constraint if exists scan_results_disposition_check;

alter table if exists public.scan_results
  add constraint scan_results_disposition_check
  check (disposition in ('purchased','suppress_90_days','bad_logic','not_profitable'));

alter table if exists public.result_dispositions
  drop constraint if exists result_dispositions_disposition_check;

alter table if exists public.result_dispositions
  add constraint result_dispositions_disposition_check
  check (disposition in ('purchased','suppress_90_days','bad_logic','not_profitable'));

create table if not exists public.scp_cache_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('login_auto','manual_check','upload')),
  status text not null check (status in ('ok','warning','error')),
  total_files integer not null default 0,
  recent_uploads integer not null default 0,
  updated_recently integer not null default 0,
  stale_files integer not null default 0,
  error_count integer not null default 0,
  last_updated_at timestamptz,
  message text,
  created_at timestamptz not null default now()
);

alter table public.scp_cache_refresh_runs enable row level security;

drop policy if exists "authenticated full access scp_cache_refresh_runs" on public.scp_cache_refresh_runs;

create policy "authenticated full access scp_cache_refresh_runs"
  on public.scp_cache_refresh_runs
  for all
  to authenticated
  using (true)
  with check (true);
