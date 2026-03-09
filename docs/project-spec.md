# Bingo Scan 3.0 Project Spec and Living Handoff

## Purpose
Bingo Scan 3.0 exists to find purchase-ready sports card deals from eBay by matching listings against SportsCardsPro data, calculating likely profit, and keeping manual review as small as possible.

## Product goal
The product goal is not just to generate results. The goal is to surface cards you can confidently purchase to make money, while reducing the time spent correcting bad SCP matches.

## Current scan philosophy
1. Pull eBay listings based on the query form.
2. Apply deterministic filters first so obvious junk never reaches AI.
3. Load indexed SCP CSV candidates first when relevant.
4. Supplement with live SportsCardsPro API lookups when the cache is not enough.
5. Use OpenAI to verify the exact card match from a narrowed candidate set.
6. Send only the strongest uncertain items to Needs Review.
7. Track manual review decisions so the system improves over time.

## What is already working
- Vercel-safe browser-driven worker model.
- eBay Browse API search with guardrails and price filtering.
- Indexed SCP CSV uploads shown in the app.
- SCP cache-first matching with live SCP supplementation.
- OpenAI exact-match verification on narrowed SCP candidate sets.
- Needs Review workflow with three SCP options.
- Manual review outcomes retained for future ranking memory.
- Negative-profit correct matches can still be tracked and removed from Deals / Needs Review.

## Recent important fixes already in repo
- SCP tracker shows indexed files.
- Needs Review can mark a correct match as `not_profitable`.
- Purchase floor is enforced in app logic on the eBay total.
- Cache candidates are used before live SCP lookups, but live SCP still supplements for better quality.

## Current pain point
The current bottleneck is too much manual review time. The system is still finding too many listings that need human correction before they are actionable.

## Immediate next milestone
Reduce manual review time by at least 50 percent while preserving or improving profitable deal quality.

## Next-step architecture
### 1. Better card fingerprints
Every eBay listing and every SCP candidate should be normalized into a shared fingerprint:
- year
- player
- brand/set
- card number
- parallel/color
- serial-numbered status
- rookie flag
- autograph flag
- memorabilia/relic flag
- grading lane

### 2. Confidence tiers
Every evaluated listing should fall into one of three buckets:
- auto-accept deal
- needs review
- auto-dispose / not profitable / low confidence

### 3. Candidate retrieval before reasoning
The system should narrow down SCP candidates using cache/API retrieval and local similarity before calling OpenAI. OpenAI should reason over a small, high-quality candidate set instead of a noisy pool.

### 4. Learning loop
Manual review decisions should be treated as labeled data. Correct match selections, suppressions, bad-logic calls, and not-profitable calls should all feed future ranking and evaluation.

### 5. Eval harness
Before major AI changes, compare them against a held-out set of historical review decisions. The key metrics are:
- top-1 SCP match accuracy
- top-3 SCP match accuracy
- false positive rate
- review rate
- purchase-ready hit rate

## What future versions should protect
- Do not turn the app into a cache-only matcher.
- Do not let tracker or freshness code break the dashboard route.
- Do not add features that increase review burden without improving purchase-ready hits.
- Preserve the current single-user, Vercel-safe scan flow unless a deliberate architecture change is made.

## What future versions should work on next
1. Strengthen fingerprint extraction and matching confidence.
2. Reduce garbage that reaches Needs Review.
3. Build evaluation tooling from historical review outcomes.
4. Add better visibility into why a listing became Needs Review.
5. Only after that, expand scan intelligence and automation.
