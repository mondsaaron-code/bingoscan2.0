alter table public.scan_results
  add column if not exists ai_chosen_product_id text,
  add column if not exists ai_top_three_product_ids jsonb not null default '[]'::jsonb,
  add column if not exists review_reason text;

alter table public.scan_review_options
  add column if not exists candidate_source text,
  add column if not exists match_score numeric(8,2),
  add column if not exists positive_signals jsonb not null default '[]'::jsonb,
  add column if not exists negative_signals jsonb not null default '[]'::jsonb,
  add column if not exists ai_preferred boolean not null default false;

create table if not exists public.review_resolution_events (
  id uuid primary key default gen_random_uuid(),
  scan_result_id uuid not null references public.scan_results(id) on delete cascade,
  scan_id uuid references public.scans(id) on delete set null,
  selected_option_id uuid references public.scan_review_options(id) on delete set null,
  selected_rank integer,
  ai_chosen_product_id text,
  ai_top_three_product_ids jsonb not null default '[]'::jsonb,
  selected_product_id text not null,
  selected_product_name text not null,
  review_reason text,
  selected_profitable boolean not null default false,
  selected_in_ai_top3 boolean not null default false,
  selected_is_ai_top1 boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists review_resolution_events_scan_idx
  on public.review_resolution_events(scan_id, created_at desc);

create index if not exists review_resolution_events_result_idx
  on public.review_resolution_events(scan_result_id, created_at desc);

alter table public.review_resolution_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'review_resolution_events'
      and policyname = 'authenticated full access review resolution events'
  ) then
    create policy "authenticated full access review resolution events"
      on public.review_resolution_events
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;
