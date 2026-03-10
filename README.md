# Bingo Scan 3.0

Fresh Next.js + Supabase repo for scanning eBay sports card listings, matching them to SportsCardsPro, and surfacing underpriced deals.

## What is included

- Supabase email/password login
- Dark mode deal dashboard
- Search form now boots with a sniper preset for Football • 2024 • Panini Prizm • numbered • raw
- Buy It Now default, auction optional
- Raw / Graded / Any selector
- Browser-driven worker ticks for Vercel-safe scanning
- eBay 24-hour dedupe
- Needs Review queue with top 3 SCP options after sniper candidate pruning
- Bulk dispositions and diagnostics panel
- Daily usage counters for eBay, SCP, OpenAI, and Ximilar

## What is intentionally conservative in v1

- One global active scan at a time
- Big four sports only
- Rule-based filtering before AI
- OpenAI verifies narrowed SCP candidate sets using structured card fingerprints plus listing text/images
- Ximilar is a helper, not mandatory for every listing
- CSV caching abstraction is scaffolded, but direct premium SCP CSV automation still needs your live account flow validated

## Strategy and roadmap

The current repo direction is a **sniper scanner**, not a broad universal matcher. The near-term goal is fewer cards, higher precision, and far less manual review.


- `docs/project-spec.md` — living project handoff, product goals, current architecture, and next milestone
- `docs/ai-roadmap.md` — the AI improvement path future versions should follow

## Setup

1. Create a new Supabase project.
2. In Supabase SQL Editor, run `supabase/schema.sql`.
3. In Supabase Auth, create your admin user manually.
4. Add all env vars from `.env.example` to `.env.local` and Vercel.
5. Push this repo to GitHub.
6. Import the repo into Vercel.

## Local dev

```bash
npm install
npm run dev
```

## Important notes

### eBay

The repo uses the Browse API with OAuth client credentials. It assumes production credentials and the `EBAY_US` marketplace.

### SportsCardsPro

The live match flow uses `/api/products` and assumes your token is valid. The uploaded CSV sample showed the fields this project maps:

- `retail-loose-sell` -> SCP Ungraded Sell
- `graded-price` -> Grade 9
- `manual-only-price` -> PSA 10

### OpenAI cost

The database has a daily usage table ready. The current code increments call counts, but exact admin-cost sync is still a follow-up task.

### Security

This repo is single-user oriented. Server routes currently trust that only your authenticated app is calling them. For a harder lock later, add signed session verification on every route.

## Follow-up items after first deploy

- Wire exact OpenAI admin cost sync
- Add SCP CSV storage bucket fetch + refresh job once your live CSV download URL pattern is confirmed
- Add back-image support from eBay item detail / description parsing
- Add stronger manual override application during ranking
- Add archived results page
