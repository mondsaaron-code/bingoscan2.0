alter table if exists public.scan_results
  drop constraint if exists scan_results_disposition_check;

alter table if exists public.scan_results
  add constraint scan_results_disposition_check
  check (disposition in ('purchased','suppress_90_days','bad_logic','not_profitable','not_enough_profit','bad_scp_options','does_not_match_query','multi_card_or_set_builder','wrong_player_or_wrong_card','parallel_or_variant_unclear','price_changed','already_reviewed_duplicate','non_card_or_memorabilia'));

alter table if exists public.result_dispositions
  drop constraint if exists result_dispositions_disposition_check;

alter table if exists public.result_dispositions
  add constraint result_dispositions_disposition_check
  check (disposition in ('purchased','suppress_90_days','bad_logic','not_profitable','not_enough_profit','bad_scp_options','does_not_match_query','multi_card_or_set_builder','wrong_player_or_wrong_card','parallel_or_variant_unclear','price_changed','already_reviewed_duplicate','non_card_or_memorabilia'));
