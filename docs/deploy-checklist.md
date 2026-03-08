# Deploy Checklist

## Supabase

Run `supabase/schema.sql`.

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

This pass also includes a browser-safe Supabase client env fix, so the login page now reads `NEXT_PUBLIC_*` variables through direct static references.

## GitHub

Push as a fresh repo.

## Vercel

Import repo.
Set env vars.
Leave **Output Directory** blank.
Deploy.

## First login

Use the email/password you created in Supabase Auth.

## Notes on SportsCardsPro set cache

The app supports reading set CSV files from the Supabase Storage bucket `scp-csv-cache` when a matching set file exists. The expected storage path is:

- `sets/<slugified-console-name>.csv`

Examples:

- `sets/football-cards-2025-panini-donruss.csv`
- `sets/basketball-cards-2024-panini-prizm.csv`

When cached files exist, the scan engine now does more than exact slug matching:

- exact console-name lookup
- fuzzy cache matching based on listing title, filter inputs, hydrated SCP candidates, and Ximilar hints
- loading up to two strong cache matches into the SCP candidate pool before OpenAI verification

That means uploaded set files should be used more often automatically, even when the eBay listing wording is messy.

## SCP CSV uploads in the app

After deployment, you can upload a SportsCardsPro CSV directly from the Deals page. The app stores it in the `scp-csv-cache` bucket and indexes it in `scp_set_cache_index`, so later scans can merge cached set rows before calling OpenAI.

The Deals page now also shows a simple SCP Cache Library panel so you can confirm which cached set files are currently indexed.

## Manual review memory

Manual review picks save a reusable override automatically, so when you correct a match once, future near-identical titles can auto-apply that product without sending the row back to review.


## Pass 13 SQL
Run the migration before deploying this pass:

- `supabase/migrations/20260308_pass13_seller_title_memory.sql`
