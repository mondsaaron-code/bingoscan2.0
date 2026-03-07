# Deploy Checklist

## Supabase

Run `supabase/schema.sql`.

Create your login user in Supabase Auth.

## Vercel env vars

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

The app now supports reading set CSV files from the Supabase Storage bucket `scp-csv-cache` when a matching set file already exists. The expected storage path is:

- `sets/<slugified-console-name>.csv`

Examples:

- `sets/football-cards-2025-panini-donruss.csv`
- `sets/basketball-cards-2024-panini-prizm.csv`

When a cached file exists, the scan engine will merge those rows into the normal SCP API candidate pool before OpenAI verification.

Manual review picks now save a reusable override automatically, so when you correct a match once, future near-identical titles can auto-apply that product without sending the row back to review.
