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
Make sure the **Framework Preset** is **Next.js**.
Leave **Output Directory** blank.
Deploy.

## First login

Use the email/password you created in Supabase Auth.
