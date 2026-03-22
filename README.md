# RightReply

Automated Google review response service for local businesses. Monitors Google Business Profiles, generates brand-voice-matched responses, and publishes them automatically.

## Current Phase

**Slice 1A** — Draft/shadow only. End-to-end pipeline from webhook ingestion through classification, policy gating, and draft generation. No public side effects.

## Architecture

- **Runtime:** Deno (Supabase Edge Functions)
- **Database:** Supabase Postgres
- **LLM:** Routed through internal gateway (no direct provider calls from business logic)
- **Events:** Immutable append-only ledger with causation chains

## Project Structure

```
supabase/
  migrations/           SQL DDL files applied in order
  functions/
    review-webhook/     Slice 1A entry point — receives Google webhook
    _shared/            Shared code (not deployed as standalone functions)
      gateway/          LLM gateway interface and routing
      pipeline/         Review processing stages (ingest, injection, classify, policy-gate, generate)
      events/           Events ledger writer
      validation/       Zod schemas for payload validation
      types/            TypeScript type definitions
    _tests/             Test files
```

## Pipeline Stages (Slice 1A)

1. **Ingest** — Validate webhook signature, resolve tenant, write `review.received` event
2. **Injection detection** — Prompt injection / adversarial instruction scan via gateway
3. **Classification** — Content safety, customer intent, safe_review_v1 eligibility
4. **Policy gate** — Apply policy rules, determine autopublish eligibility
5. **Generation** — Draft response via gateway (eligible reviews only)
6. **Publish gate** — Final deterministic check (Slice 1B, not yet active)

## Setup

1. Install Supabase CLI: `brew install supabase/tap/supabase`
2. Copy `.env.local.example` to `.env.local` and fill in credentials
3. Link project: `supabase link --project-ref <your-project-ref>`
4. Apply migrations: `supabase db push`
5. Run functions locally: `supabase functions serve`

## Key Specs

- `rightreply-build-reference.md` — Full system specification (frozen v1)
- `rightreply-core-data-model.md` — Operational table schemas for Slice 1
