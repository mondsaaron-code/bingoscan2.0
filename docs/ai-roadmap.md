# AI Roadmap

## Goal
Use more AI in a way that increases purchase-ready hits and decreases manual correction work.

## Safe sequence
### Phase 1: Structured extraction
- Build normalized fingerprints for eBay listings and SCP candidates.
- Feed those fingerprints into the OpenAI exact-match step.
- Keep deterministic guardrails before AI.

### Phase 2: Better review precision
- Capture why a card reached Needs Review.
- Capture extracted attributes from the OpenAI verifier.
- Track top-1 vs top-3 correctness over time.

### Phase 3: Learning and evals
- Build an offline evaluation set from historical review actions.
- Score every prompt/model/ranking change before rollout.

### Phase 4: Escalation strategy
- Cheap filtering first.
- Text-based AI second.
- Vision escalation only when confidence is still mixed.

## Current implementation progress
- Added a shared fingerprint helper in `src/lib/card-fingerprint.ts`.
- OpenAI exact-match verification now receives listing and SCP candidate fingerprints.
- Candidate payloads now include a fingerprint similarity signal before model judgment.
- Needs Review rows now store a structured review reason so you can see why the model stopped short of auto-accept.
- Review options now carry positive and negative fingerprint signals for faster human selection.
- Review resolutions now log top-1/top-3 hit data so future tuning can be measured instead of guessed.
- A smart auto-accept override now promotes some high-signal fingerprint matches into Deals.
- A second-pass smart publish lane now promotes profitable AI-shortlisted matches into Deals even when the exact-match verdict is still conservative.
- A weak-review rejection pass now blocks obvious SCP lookalikes from reaching Needs Review.

## Near-term target
The next code changes should reduce the number of bad cards that reach Needs Review without suppressing real deals.
