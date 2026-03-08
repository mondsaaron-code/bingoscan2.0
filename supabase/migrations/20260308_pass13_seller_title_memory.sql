alter table public.scan_candidates
  add column if not exists seller_username text,
  add column if not exists seller_feedback_percentage numeric(6,2),
  add column if not exists seller_feedback_score integer,
  add column if not exists listing_quality_score numeric(6,2);

alter table public.scan_results
  add column if not exists seller_username text,
  add column if not exists seller_feedback_percentage numeric(6,2),
  add column if not exists seller_feedback_score integer,
  add column if not exists listing_quality_score numeric(6,2);

create index if not exists scan_results_seller_idx on public.scan_results(seller_username, created_at desc);
