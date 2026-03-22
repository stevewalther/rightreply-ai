-- ============================================================
-- SEED: Pilot tenant for Slice 1A testing
-- Run after 001_initial_schema.sql
--
-- Creates:
--   1. One tenant (Oak Street Dental) in trial_active state
--   2. One OAuth connection (connected, Google Business Profile)
--   3. One approved brand voice profile
--   4. Updates tenant FKs to point to the brand voice + OAuth
--   5. Automation controls: draft_only_mode = true (Slice 1A)
--   6. Starting system_config threshold values (Section 8.6)
--
-- Fixed UUIDs for easy reference:
--   Tenant:     550e8400-e29b-41d4-a716-446655440001
--   OAuth:      550e8400-e29b-41d4-a716-446655440002
--   Brand Voice:550e8400-e29b-41d4-a716-446655440003
-- ============================================================

BEGIN;

-- ── 1. Tenant ──────────────────────────────────────────────────

INSERT INTO tenants (
  id, tenant_key, legal_name, display_name,
  business_category, status, plan_code,
  billing_provider_customer_id,
  trial_starts_at, trial_ends_at,
  service_starts_at,
  timezone, default_locale,
  primary_contact_name, primary_contact_email, primary_contact_phone,
  notes
) VALUES (
  '550e8400-e29b-41d4-a716-446655440001',
  'oak-street-dental',
  'Oak Street Dental LLC',
  'Oak Street Dental',
  'dentist',
  'trial_active',
  'starter_79',
  'cus_test_oak_001',
  now(),
  now() + interval '30 days',
  now(),
  'America/Chicago',
  'en-US',
  'Dr. Sarah Chen',
  'sarah@oakstreetdental.example',
  '+15551234567',
  'Pilot tenant for Slice 1A testing'
);

-- ── 2. OAuth Connection ────────────────────────────────────────

INSERT INTO oauth_connections (
  id, tenant_id, provider,
  external_account_id, external_location_id,
  status, granted_scopes,
  access_token_ref, refresh_token_ref,
  token_expires_at, connected_at, last_refreshed_at
) VALUES (
  '550e8400-e29b-41d4-a716-446655440002',
  '550e8400-e29b-41d4-a716-446655440001',
  'google_business_profile',
  'google_account_12345',
  'accounts/123456/locations/789012',
  'connected',
  ARRAY['https://www.googleapis.com/auth/business.manage'],
  'encrypted:access:placeholder_not_a_real_token',
  'encrypted:refresh:placeholder_not_a_real_token',
  now() + interval '1 hour',
  now(),
  now()
);

-- ── 3. Brand Voice Profile (approved_live) ─────────────────────

INSERT INTO brand_voice_profiles (
  id, tenant_id, profile_version,
  status, label, source_type,
  tone_summary,
  style_rules,
  dos,
  donts,
  forbidden_phrases,
  max_response_words,
  allow_exclamation_points,
  prompt_snippet,
  approved_by_actor_id,
  approved_at
) VALUES (
  '550e8400-e29b-41d4-a716-446655440003',
  '550e8400-e29b-41d4-a716-446655440001',
  1,
  'approved_live',
  'Oak Street Dental - Warm Professional v1',
  'manual_admin_edit',
  'Warm, professional, and appreciative. First-name friendly but never casual. Emphasize patient care and team pride.',
  '{
    "formality": "professional_warm",
    "person": "first_person_plural",
    "sentence_style": "short_to_medium",
    "emoji_policy": "never",
    "exclamation_policy": "sparingly"
  }'::jsonb,
  '["Thank the reviewer by name when available", "Mention the specific service or experience they praised", "Invite them back warmly", "Keep responses under 80 words"]'::jsonb,
  '["Never mention competitors", "Never offer discounts or promotions", "Never reference specific pricing", "Never discuss other patients or cases", "Never make medical claims or guarantees"]'::jsonb,
  ARRAY['guaranteed', 'promise', 'cheapest', 'best price', 'discount', 'free consultation'],
  80,
  true,
  'You are responding to a Google review on behalf of Oak Street Dental. Use a warm, professional tone. Thank the reviewer by name. Keep responses under 80 words. Never make medical claims or guarantees.',
  'steve_admin',
  now()
);

-- ── 4. Update tenant FKs ───────────────────────────────────────

UPDATE tenants
SET approved_brand_voice_profile_id = '550e8400-e29b-41d4-a716-446655440003',
    current_oauth_connection_id     = '550e8400-e29b-41d4-a716-446655440002'
WHERE id = '550e8400-e29b-41d4-a716-446655440001';

-- ── 5. Automation controls (Slice 1A = draft only) ─────────────

INSERT INTO automation_controls (
  scope_type, scope_id, control_key, control_value,
  reason, set_by_actor_type, set_by_actor_id, effective_at
) VALUES
  ('global', NULL, 'global_publish_enabled', true,
   'Default: publishing infrastructure enabled', 'human_admin', 'steve_admin', now()),
  ('global', NULL, 'response_generation_enabled', true,
   'Default: LLM generation enabled', 'human_admin', 'steve_admin', now()),
  ('global', NULL, 'draft_only_mode', true,
   'Slice 1A: all output is draft/shadow only', 'human_admin', 'steve_admin', now()),
  ('global', NULL, 'incident_mode', false,
   'Default: no active incident', 'human_admin', 'steve_admin', now()),
  ('global', NULL, 'gateway_healthy_required', true,
   'Default: gateway must be healthy for public paths', 'human_admin', 'steve_admin', now()),
  ('tenant', '550e8400-e29b-41d4-a716-446655440001', 'tenant_publish_enabled', true,
   'Pilot tenant: publishing allowed (gated by draft_only_mode)', 'human_admin', 'steve_admin', now());

-- ── 6. System config thresholds (Section 8.6 starting values) ──

INSERT INTO system_config (
  scope_type, scope_id, config_key, value_type,
  numeric_value, integer_value, units, description,
  set_by_actor_id, effective_at
) VALUES
  ('global', NULL, 'INJECTION_BLOCK_THRESHOLD', 'numeric',
   0.70, NULL, NULL, 'Above this confidence = injection detected, auto-publish blocked',
   'steve_admin', now()),
  ('global', NULL, 'INJECTION_AMBIGUOUS_LOW', 'numeric',
   0.35, NULL, NULL, 'Below 0.35 = likely clean',
   'steve_admin', now()),
  ('global', NULL, 'INJECTION_AMBIGUOUS_HIGH', 'numeric',
   0.70, NULL, NULL, 'Above 0.70 = blocked',
   'steve_admin', now()),
  ('global', NULL, 'REVIEW_CLASSIFICATION_AUTOPUBLISH_THRESHOLD', 'numeric',
   0.95, NULL, NULL, 'Classifier must be >= 0.95 confident for safe_review_v1',
   'steve_admin', now()),
  ('global', NULL, 'RESPONSE_GENERATION_SCHEMA_RETRY_LIMIT', 'integer',
   NULL, 2, NULL, 'Max retries on schema parse failure',
   'steve_admin', now()),
  ('global', NULL, 'GATEWAY_HEALTH_MIN_SCORE', 'numeric',
   0.95, NULL, NULL, 'Below this, public generation/publish paths pause',
   'steve_admin', now()),
  ('global', NULL, 'OPERATOR_CONFIDENCE_DRAFT_ONLY_THRESHOLD', 'integer',
   NULL, 85, NULL, 'Below 85, all public posting becomes draft-only',
   'steve_admin', now()),
  ('global', NULL, 'OPERATOR_CONFIDENCE_PAUSE_THRESHOLD', 'integer',
   NULL, 75, NULL, 'Below 75, public posting paused entirely',
   'steve_admin', now()),
  ('global', NULL, 'PUBLISH_RECEIPT_TIMEOUT_SECONDS', 'integer',
   NULL, 300, 'seconds', 'If no receipt within 5 min, mark uncertain',
   'steve_admin', now()),
  ('global', NULL, 'DUPLICATE_PUBLISH_LOOKBACK_HOURS', 'integer',
   NULL, 24, 'hours', 'Check for existing response within this window',
   'steve_admin', now());

COMMIT;
