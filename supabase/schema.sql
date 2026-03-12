create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  filters jsonb not null,
  status text not null check (status in ('queued','fetching_ebay','filtering','matching_scp','ai_verifying','publishing_results','completed','cancelled','failed')),
  stage_message text,
  metrics jsonb not null default '{}'::jsonb,
  warning_count integer not null default 0,
  error_count integer not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.scan_stage_events (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  level text not null check (level in ('info','warning','error')),
  stage text not null,
  message text not null,
  details text,
  created_at timestamptz not null default now()
);

create table if not exists public.scan_candidates (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  ebay_item_id text not null,
  ebay_title text not null,
  ebay_url text not null,
  image_url text,
  purchase_price numeric(12,2) not null default 0,
  shipping_price numeric(12,2) not null default 0,
  total_purchase_price numeric(12,2) not null default 0,
  auction_ends_at timestamptz,
  stage text not null,
  rejection_reason text,
  ai_confidence numeric(5,2),
  ai_reasoning text,
  scp_product_id text,
  seller_username text,
  seller_feedback_percentage numeric(6,2),
  seller_feedback_score integer,
  listing_quality_score numeric(6,2),
  created_at timestamptz not null default now()
);

create table if not exists public.scan_results (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  ebay_item_id text not null,
  ebay_title text not null,
  ebay_url text not null,
  image_url text,
  purchase_price numeric(12,2) not null default 0,
  shipping_price numeric(12,2) not null default 0,
  total_purchase_price numeric(12,2) not null default 0,
  scp_product_id text,
  scp_product_name text,
  scp_link text,
  scp_ungraded_sell numeric(12,2),
  scp_grade_9 numeric(12,2),
  scp_psa_10 numeric(12,2),
  estimated_profit numeric(12,2),
  estimated_margin_pct numeric(8,2),
  ai_confidence numeric(5,2),
  ai_chosen_product_id text,
  ai_top_three_product_ids jsonb not null default '[]'::jsonb,
  needs_review boolean not null default false,
  auction_ends_at timestamptz,
  seller_username text,
  seller_feedback_percentage numeric(6,2),
  seller_feedback_score integer,
  listing_quality_score numeric(6,2),
  reasoning text,
  review_reason text,
  disposition text check (disposition in ('purchased','suppress_90_days','bad_logic','not_profitable','not_enough_profit','bad_scp_options','does_not_match_query','multi_card_or_set_builder','wrong_player_or_wrong_card','parallel_or_variant_unclear','price_changed','already_reviewed_duplicate','non_card_or_memorabilia')),
  created_at timestamptz not null default now()
);

create table if not exists public.scan_review_options (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null references public.scan_results(id) on delete cascade,
  rank integer not null,
  scp_product_id text not null,
  scp_product_name text not null,
  scp_link text,
  scp_ungraded_sell numeric(12,2),
  scp_grade_9 numeric(12,2),
  scp_psa_10 numeric(12,2),
  confidence numeric(5,2),
  candidate_source text,
  match_score numeric(8,2),
  positive_signals jsonb not null default '[]'::jsonb,
  negative_signals jsonb not null default '[]'::jsonb,
  ai_preferred boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.result_dispositions (
  id uuid primary key default gen_random_uuid(),
  scan_result_id uuid not null references public.scan_results(id) on delete cascade,
  disposition text not null check (disposition in ('purchased','suppress_90_days','bad_logic','not_profitable','not_enough_profit','bad_scp_options','does_not_match_query','multi_card_or_set_builder','wrong_player_or_wrong_card','parallel_or_variant_unclear','price_changed','already_reviewed_duplicate','non_card_or_memorabilia')),
  created_at timestamptz not null default now()
);

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

create table if not exists public.ebay_item_dedupe (
  ebay_item_id text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.manual_match_overrides (
  id uuid primary key default gen_random_uuid(),
  ebay_title_fingerprint text not null,
  scp_product_id text not null,
  scp_product_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.scp_set_cache_index (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  console_name text not null,
  source_console_url text,
  storage_path text,
  downloaded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists public.api_usage_daily (
  usage_date date primary key,
  ebay_calls integer not null default 0,
  scp_calls integer not null default 0,
  openai_calls integer not null default 0,
  ximilar_calls integer not null default 0,
  openai_cost_usd numeric(12,6) not null default 0
);

create table if not exists public.app_errors (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  message text not null,
  details text,
  created_at timestamptz not null default now()
);

create index if not exists scans_status_idx on public.scans(status, created_at desc);
create index if not exists scan_results_scan_idx on public.scan_results(scan_id, created_at desc);
create index if not exists scan_results_seller_idx on public.scan_results(seller_username, created_at desc);
create index if not exists scan_candidates_scan_idx on public.scan_candidates(scan_id, created_at desc);
create index if not exists stage_events_scan_idx on public.scan_stage_events(scan_id, created_at desc);
create index if not exists review_resolution_events_scan_idx on public.review_resolution_events(scan_id, created_at desc);
create index if not exists review_resolution_events_result_idx on public.review_resolution_events(scan_result_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.scans enable row level security;
alter table public.scan_stage_events enable row level security;
alter table public.scan_candidates enable row level security;
alter table public.scan_results enable row level security;
alter table public.scan_review_options enable row level security;
alter table public.result_dispositions enable row level security;
alter table public.review_resolution_events enable row level security;
alter table public.ebay_item_dedupe enable row level security;
alter table public.manual_match_overrides enable row level security;
alter table public.scp_set_cache_index enable row level security;
alter table public.scp_cache_refresh_runs enable row level security;
alter table public.api_usage_daily enable row level security;
alter table public.app_errors enable row level security;

create policy "single-user read write profiles" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "authenticated can read scans" on public.scans for select to authenticated using (true);
create policy "authenticated can insert scans" on public.scans for insert to authenticated with check (true);
create policy "authenticated can update scans" on public.scans for update to authenticated using (true);

create policy "authenticated full access stage events" on public.scan_stage_events for all to authenticated using (true) with check (true);
create policy "authenticated full access scan candidates" on public.scan_candidates for all to authenticated using (true) with check (true);
create policy "authenticated full access scan results" on public.scan_results for all to authenticated using (true) with check (true);
create policy "authenticated full access review options" on public.scan_review_options for all to authenticated using (true) with check (true);
create policy "authenticated full access result dispositions" on public.result_dispositions for all to authenticated using (true) with check (true);
create policy "authenticated full access review resolution events" on public.review_resolution_events for all to authenticated using (true) with check (true);
create policy "authenticated full access ebay_item_dedupe" on public.ebay_item_dedupe for all to authenticated using (true) with check (true);
create policy "authenticated full access manual_match_overrides" on public.manual_match_overrides for all to authenticated using (true) with check (true);
create policy "authenticated full access scp_set_cache_index" on public.scp_set_cache_index for all to authenticated using (true) with check (true);
create policy "authenticated full access scp_cache_refresh_runs" on public.scp_cache_refresh_runs for all to authenticated using (true) with check (true);
create policy "authenticated full access api_usage_daily" on public.api_usage_daily for all to authenticated using (true) with check (true);
create policy "authenticated full access app_errors" on public.app_errors for all to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
values ('scp-csv-cache', 'scp-csv-cache', false), ('scan-images', 'scan-images', false), ('debug-artifacts', 'debug-artifacts', false)
on conflict (id) do nothing;
