# Deploy Checklist

## Supabase

Run `supabase/schema.sql` for a fresh project.

If your project is already running from an older pass, also run these migrations in order:

- `supabase/migrations/20260308_pass13_seller_title_memory.sql`
- `supabase/migrations/20260309_pass25_review_cache_tracker.sql`

Create your login user in Supabase Auth.

## Vercel env vars

Required:

- NEXT_PUBLIC_APP_URL
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- OPENAI_API_KEY
- OPENAI_ADMIN_KEY
- EBAY_CLIENT_ID
- EBAY_CLIENT_SECRET
- EBAY_ENVIRONMENT=production
- SPORTSCARDSPRO_API_TOKEN
- SPORTSCARDSPRO_API_BASE_URL=https://www.sportscardspro.com
- XIMILAR_API_KEY

Optional guardrails:

- EBAY_DAILY_CALL_LIMIT=4500
- SCP_DAILY_CALL_LIMIT
- OPENAI_DAILY_CALL_LIMIT
- XIMILAR_DAILY_CALL_LIMIT

The worker will stop a scan with a specific warning if one of these configured daily budgets is reached.

## Environment notes

`NEXT_PUBLIC_` variables are embedded into the browser bundle at build time, so if you change:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_APP_URL`

redeploy after saving the new values in Vercel.

## GitHub

Push as a fresh repo.

## Vercel

Import repo.
Set env vars.
Leave **Output Directory** blank.
Deploy.

## First login

Use the email/password you created in Supabase Auth.

## Notes on SportsCardsPro CSVs

The app can automatically **check freshness** of uploaded SCP CSV files on login and when you press **Check Freshness** on the Deals page.

The app does **not** yet automatically download premium SCP CSV files from your account. Manual SCP download/upload is still required when a cache file is stale.

## SCP CSV uploads in the app

After deployment, you can upload a SportsCardsPro CSV directly from the Deals page. The app stores it in the `scp-csv-cache` bucket and indexes it in `scp_set_cache_index`, so later scans can merge cached set rows before calling OpenAI.

The Deals page now shows:

- the last two SCP CSV uploads from the past two weeks
- a freshness tracker with total files, updated-in-24h count, stale count, last update time, and recent refresh-check errors

## Manual review behavior

- Needs Review only shows the top 20 profitable review candidates.
- If you manually choose an SCP match that still is not profitable, the card is automatically marked `Not Profitable` instead of moving into the Deals table.
