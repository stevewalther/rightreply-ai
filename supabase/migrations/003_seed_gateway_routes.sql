-- ============================================================
-- SEED: Model registry + task routes for Slice 1A gateway
-- Run after 002_seed_pilot_tenant.sql
--
-- Registers Claude models and creates active routes for
-- the three Slice 1 task types.
-- ============================================================

BEGIN;

-- ── 1. Model Registry ──────────────────────────────────────────

-- Claude Haiku 4.5 — fast classifier for injection detection
INSERT INTO model_registry (
  provider_key, provider_model_id, internal_model_alias,
  task_families, status,
  supports_json_schema, supports_tools,
  max_context_tokens,
  cost_profile,
  approved_for_prod, approved_at,
  notes
) VALUES (
  'anthropic',
  'claude-haiku-4-5-20251001',
  'haiku-45',
  ARRAY['prompt_injection_detection', 'review_classification'],
  'approved',
  true, true,
  200000,
  '{"input_per_1k": 0.001, "output_per_1k": 0.005}'::jsonb,
  true, now(),
  'Fast classifier. Primary for injection detection and classification.'
);

-- Claude Sonnet 4 — stronger model for generation
INSERT INTO model_registry (
  provider_key, provider_model_id, internal_model_alias,
  task_families, status,
  supports_json_schema, supports_tools,
  max_context_tokens,
  cost_profile,
  approved_for_prod, approved_at,
  notes
) VALUES (
  'anthropic',
  'claude-sonnet-4-20250514',
  'sonnet-4',
  ARRAY['response_generation', 'review_classification'],
  'approved',
  true, true,
  200000,
  '{"input_per_1k": 0.003, "output_per_1k": 0.015}'::jsonb,
  true, now(),
  'Primary for response generation. Quality and safety focus.'
);

-- ── 2. Task Model Routes ───────────────────────────────────────

-- Injection detection: Haiku primary (cheap, fast, deterministic)
INSERT INTO task_model_routes (
  task_type, task_version,
  primary_model_alias, fallback_model_alias,
  temperature_override, max_output_tokens_override, timeout_ms_override,
  confidence_threshold,
  is_active, effective_at
) VALUES (
  'prompt_injection_detection', '1.0',
  'haiku-45', 'sonnet-4',
  0.0, 1024, 15000,
  0.70,
  true, now()
);

-- Review classification: Haiku primary (structured accuracy)
INSERT INTO task_model_routes (
  task_type, task_version,
  primary_model_alias, fallback_model_alias,
  temperature_override, max_output_tokens_override, timeout_ms_override,
  confidence_threshold,
  is_active, effective_at
) VALUES (
  'review_classification', '1.0',
  'haiku-45', 'sonnet-4',
  0.0, 1024, 15000,
  0.95,
  true, now()
);

-- Response generation: Sonnet primary (quality and safety)
INSERT INTO task_model_routes (
  task_type, task_version,
  primary_model_alias, fallback_model_alias,
  temperature_override, max_output_tokens_override, timeout_ms_override,
  confidence_threshold,
  is_active, effective_at
) VALUES (
  'response_generation', '1.0',
  'sonnet-4', 'haiku-45',
  0.7, 512, 30000,
  0.95,
  true, now()
);

COMMIT;
