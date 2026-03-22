-- ============================================================
-- RIGHTREPLY — SLICE 1 COMPLETE DATABASE SCHEMA
-- Generated: 2026-03-20
-- Spec sources:
--   rightreply-build-reference.md (v1, frozen)
--   rightreply-core-data-model.md (Slice 1)
-- ============================================================
-- 18 tables: 9 core domain, 2 events, 4 LLM gateway, 3 eval
-- ============================================================

BEGIN;

-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
-- 1. EXTENSIONS
-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

CREATE EXTENSION IF NOT EXISTS citext;

-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
-- 2. HELPER FUNCTIONS
-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
-- 3. ENUMS
-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

-- --- Tenants ---
CREATE TYPE tenant_business_category_enum AS ENUM (
  'dentist', 'roofing', 'restaurant', 'contractor',
  'home_services', 'medical', 'legal', 'other'
);

CREATE TYPE tenant_status_enum AS ENUM (
  'onboarding', 'onboarding_blocked', 'trial_active', 'active',
  'paused', 'cancel_scheduled', 'canceled', 'archived'
);

-- --- OAuth ---
CREATE TYPE oauth_provider_enum AS ENUM ('google_business_profile');

CREATE TYPE oauth_connection_status_enum AS ENUM (
  'pending', 'connected', 'refresh_failed',
  'token_expired', 'revoked', 'disconnected'
);

-- --- Brand Voice ---
CREATE TYPE brand_voice_profile_status_enum AS ENUM (
  'draft', 'approved_live', 'approved_inactive',
  'rejected', 'superseded', 'archived'
);

CREATE TYPE brand_voice_profile_source_enum AS ENUM (
  'onboarding_answers', 'model_draft', 'manual_admin_edit',
  'customer_requested_change', 'imported_examples'
);

-- --- Reviews ---
CREATE TYPE review_source_channel_enum AS ENUM ('google_gbp');

CREATE TYPE review_source_status_enum AS ENUM ('active', 'removed_external');

CREATE TYPE review_status_enum AS ENUM (
  'received', 'duplicate_blocked', 'injection_blocked', 'policy_blocked',
  'needs_human_review', 'eligible_for_generation', 'draft_ready',
  'awaiting_human_approval', 'approved_for_publish', 'publish_in_progress',
  'published', 'publish_failed', 'closed'
);

CREATE TYPE review_injection_status_enum AS ENUM (
  'not_run', 'clean', 'ambiguous', 'detected'
);

CREATE TYPE review_customer_intent_enum AS ENUM (
  'praise', 'complaint', 'mixed', 'question',
  'contact_request', 'no_text', 'spam_wrong_business', 'unknown'
);

CREATE TYPE review_risk_tier_enum AS ENUM (
  'autonomous', 'confirmation_required', 'forbidden'
);

-- --- Responses ---
CREATE TYPE response_status_enum AS ENUM (
  'draft_generated', 'awaiting_human_approval', 'approved', 'rejected',
  'publish_attempted', 'published', 'publish_failed',
  'superseded', 'archived'
);

CREATE TYPE response_generation_mode_enum AS ENUM (
  'autonomous', 'human_approved', 'manual_import',
  'retry_existing', 'replacement_draft'
);

-- --- Policy Rules ---
CREATE TYPE policy_scope_enum AS ENUM ('global', 'tenant', 'workflow');

CREATE TYPE policy_risk_tier_enum AS ENUM (
  'autonomous', 'confirmation_required', 'forbidden'
);

CREATE TYPE policy_rule_severity_enum AS ENUM ('normal', 'high', 'critical');

CREATE TYPE policy_rule_status_enum AS ENUM (
  'draft', 'live', 'superseded', 'retired', 'rejected'
);

-- --- Approvals ---
CREATE TYPE approval_scope_enum AS ENUM (
  'review_response', 'policy_rule', 'brand_voice_profile',
  'config_change', 'tenant_action', 'publish_override', 'model_route_change'
);

CREATE TYPE approval_status_enum AS ENUM (
  'pending', 'approved', 'rejected', 'canceled', 'expired'
);

CREATE TYPE approval_requestor_actor_enum AS ENUM (
  'system', 'human_admin', 'customer_admin'
);

CREATE TYPE approval_decider_actor_enum AS ENUM (
  'human_admin', 'customer_admin'
);

-- --- Automation Controls ---
CREATE TYPE automation_control_scope_enum AS ENUM ('global', 'tenant');

CREATE TYPE automation_control_key_enum AS ENUM (
  'global_publish_enabled', 'tenant_publish_enabled',
  'response_generation_enabled', 'draft_only_mode',
  'incident_mode', 'gateway_healthy_required'
);

CREATE TYPE automation_control_actor_enum AS ENUM (
  'human_admin', 'customer_admin'
);

-- --- System Config ---
CREATE TYPE system_config_scope_enum AS ENUM ('global', 'tenant');

CREATE TYPE system_config_value_type_enum AS ENUM (
  'numeric', 'integer', 'boolean', 'text', 'json'
);

CREATE TYPE system_config_key_enum AS ENUM (
  'INJECTION_BLOCK_THRESHOLD',
  'INJECTION_AMBIGUOUS_LOW',
  'INJECTION_AMBIGUOUS_HIGH',
  'REVIEW_CLASSIFICATION_AUTOPUBLISH_THRESHOLD',
  'RESPONSE_GENERATION_SCHEMA_RETRY_LIMIT',
  'GATEWAY_HEALTH_MIN_SCORE',
  'OPERATOR_CONFIDENCE_DRAFT_ONLY_THRESHOLD',
  'OPERATOR_CONFIDENCE_PAUSE_THRESHOLD',
  'PUBLISH_RECEIPT_TIMEOUT_SECONDS',
  'DUPLICATE_PUBLISH_LOOKBACK_HOURS'
);

-- --- Events ---
CREATE TYPE event_actor_type_enum AS ENUM (
  'system', 'human_admin', 'customer_admin', 'end_customer',
  'external_service', 'scheduler', 'model', 'unknown'
);

CREATE TYPE event_generation_class_enum AS ENUM (
  'external_observed', 'human_generated',
  'system_generated', 'derived_system'
);

CREATE TYPE privacy_level_enum AS ENUM (
  'public_business', 'internal_business', 'customer_confidential',
  'billing_sensitive', 'operator_secret'
);

CREATE TYPE archive_tier_enum AS ENUM ('hot', 'warm', 'cold');

-- --- LLM Gateway ---
CREATE TYPE llm_call_status_enum AS ENUM (
  'succeeded', 'failed', 'timed_out', 'blocked', 'fallback_succeeded'
);

CREATE TYPE route_mode_enum AS ENUM (
  'primary', 'shadow', 'canary', 'fallback', 'forced_model'
);

CREATE TYPE input_trust_level_enum AS ENUM (
  'trusted_system', 'trusted_human', 'untrusted_external', 'mixed'
);

CREATE TYPE output_mode_enum AS ENUM (
  'text', 'json', 'json_schema', 'classification'
);

CREATE TYPE model_status_enum AS ENUM (
  'draft', 'candidate', 'approved', 'canary',
  'shadow_only', 'retired', 'blocked'
);

CREATE TYPE llm_artifact_type_enum AS ENUM (
  'full_prompt', 'full_response', 'parsed_output',
  'provider_raw', 'comparison_bundle'
);

CREATE TYPE llm_artifact_retention_enum AS ENUM (
  'sampled_short', 'audit_long', 'incident_hold'
);

-- --- Eval ---
CREATE TYPE eval_run_status_enum AS ENUM (
  'running', 'passed', 'failed', 'error'
);

CREATE TYPE eval_severity_enum AS ENUM (
  'critical', 'high', 'moderate', 'low'
);


-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
-- 4. TABLES (dependency order)
-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

-- -----------------------------------------------------------
-- 4.1  tenants
-- FKs to brand_voice_profiles and oauth_connections deferred
-- -----------------------------------------------------------
CREATE TABLE tenants (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key                    text NOT NULL,
  legal_name                    text,
  display_name                  text NOT NULL,
  business_category             tenant_business_category_enum NOT NULL,
  status                        tenant_status_enum NOT NULL DEFAULT 'onboarding',
  plan_code                     text NOT NULL,
  billing_provider_customer_id  text,
  trial_starts_at               timestamptz,
  trial_ends_at                 timestamptz,
  service_starts_at             timestamptz,
  service_ends_at               timestamptz,
  timezone                      text NOT NULL DEFAULT 'UTC',
  default_locale                text NOT NULL DEFAULT 'en-US',
  primary_contact_name          text,
  primary_contact_email         citext,
  primary_contact_phone         text,
  approved_brand_voice_profile_id uuid,   -- FK deferred
  current_oauth_connection_id   uuid,     -- FK deferred
  last_review_sync_at           timestamptz,
  last_digest_sent_at           timestamptz,
  paused_reason                 text,
  notes                         text,
  created_from_event_id         uuid,
  last_event_id                 uuid,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_tenants_tenant_key UNIQUE (tenant_key)
);

CREATE UNIQUE INDEX uq_tenants_billing_provider
  ON tenants (billing_provider_customer_id)
  WHERE billing_provider_customer_id IS NOT NULL;

-- -----------------------------------------------------------
-- 4.2  oauth_connections
-- -----------------------------------------------------------
CREATE TABLE oauth_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  provider                oauth_provider_enum NOT NULL,
  external_account_id     text NOT NULL,
  external_location_id    text NOT NULL,
  status                  oauth_connection_status_enum NOT NULL DEFAULT 'pending',
  granted_scopes          text[] NOT NULL DEFAULT '{}',
  access_token_ref        text,
  refresh_token_ref       text,
  token_expires_at        timestamptz,
  connected_at            timestamptz,
  last_refreshed_at       timestamptz,
  last_refresh_attempt_at timestamptz,
  last_error_code         text,
  last_error_message      text,
  revoked_at              timestamptz,
  disconnected_at         timestamptz,
  metadata                jsonb,
  created_from_event_id   uuid,
  last_event_id           uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_oauth_provider_location
    UNIQUE (provider, external_location_id),
  CONSTRAINT uq_oauth_tenant_provider_location
    UNIQUE (tenant_id, provider, external_location_id)
);

-- -----------------------------------------------------------
-- 4.3  brand_voice_profiles
-- supersedes_profile_id self-ref FK deferred
-- -----------------------------------------------------------
CREATE TABLE brand_voice_profiles (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id),
  profile_version             integer NOT NULL,
  status                      brand_voice_profile_status_enum NOT NULL DEFAULT 'draft',
  label                       text NOT NULL,
  source_type                 brand_voice_profile_source_enum NOT NULL,
  tone_summary                text NOT NULL,
  style_rules                 jsonb NOT NULL,
  dos                         jsonb,
  donts                       jsonb,
  forbidden_phrases           text[],
  approved_example_responses  jsonb,
  max_response_words          integer NOT NULL,
  allow_exclamation_points    boolean NOT NULL DEFAULT true,
  signoff_style               text,
  prompt_snippet              text,
  supersedes_profile_id       uuid,     -- self-ref FK deferred
  approved_by_actor_id        text,
  approved_at                 timestamptz,
  rejected_reason             text,
  created_from_event_id       uuid,
  last_event_id               uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_bvp_tenant_version
    UNIQUE (tenant_id, profile_version)
);

-- One approved_live profile per tenant
CREATE UNIQUE INDEX uq_bvp_one_live_per_tenant
  ON brand_voice_profiles (tenant_id)
  WHERE status = 'approved_live';

-- -----------------------------------------------------------
-- 4.4  events (immutable ledger)
-- No FKs to operational tables — append-only, soft refs only
-- -----------------------------------------------------------
CREATE TABLE events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type              text NOT NULL,
  event_version           integer NOT NULL DEFAULT 1,
  domain_key              text NOT NULL DEFAULT 'rightreply',
  tenant_id               uuid,
  occurred_at             timestamptz NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  ingestion_sequence      bigserial NOT NULL,
  source_channel          text NOT NULL,
  source_system           text NOT NULL,
  source_message_id       text,
  actor_type              event_actor_type_enum NOT NULL,
  actor_id                text,
  actor_display_name      text,
  generation_class        event_generation_class_enum NOT NULL,
  authority_rank          smallint NOT NULL,
  is_authoritative        boolean NOT NULL DEFAULT false,
  object_type             text NOT NULL,
  object_id               text NOT NULL,
  subject_entity_id       text,
  correlation_id          uuid,
  causation_event_id      uuid,
  idempotency_key         text,
  status                  text,
  risk_flags              text[] NOT NULL DEFAULT '{}',
  privacy_level           privacy_level_enum NOT NULL DEFAULT 'internal_business',
  payload                 jsonb NOT NULL DEFAULT '{}',
  payload_schema_version  integer NOT NULL DEFAULT 1,
  payload_hash_sha256     text NOT NULL,
  raw_blob_ref            text,
  raw_blob_hash_sha256    text,
  event_hash_sha256       text NOT NULL,
  archive_tier            archive_tier_enum NOT NULL DEFAULT 'hot',
  archived_at             timestamptz,
  archive_pointer         text,
  legal_hold              boolean NOT NULL DEFAULT false,
  notes                   text
);

CREATE UNIQUE INDEX uq_events_idempotency_key
  ON events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- -----------------------------------------------------------
-- 4.5  event_receipts
-- -----------------------------------------------------------
CREATE TABLE event_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES events(id),
  receipt_type        text NOT NULL,
  receipt_payload     jsonb NOT NULL DEFAULT '{}',
  receipt_hash_sha256 text NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------
-- 4.6  model_registry
-- -----------------------------------------------------------
CREATE TABLE model_registry (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key          text NOT NULL,
  provider_model_id     text NOT NULL,
  internal_model_alias  text NOT NULL,
  task_families         text[] NOT NULL DEFAULT '{}',
  status                model_status_enum NOT NULL DEFAULT 'draft',
  supports_json_schema  boolean NOT NULL DEFAULT false,
  supports_tools        boolean NOT NULL DEFAULT false,
  max_context_tokens    integer,
  cost_profile          jsonb,
  latency_profile       jsonb,
  quality_profile       jsonb,
  approved_for_prod     boolean NOT NULL DEFAULT false,
  approved_at           timestamptz,
  retired_at            timestamptz,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_model_registry_alias UNIQUE (internal_model_alias)
);

-- -----------------------------------------------------------
-- 4.7  task_model_routes
-- -----------------------------------------------------------
CREATE TABLE task_model_routes (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key                    text NOT NULL DEFAULT 'rightreply',
  task_type                     text NOT NULL,
  task_version                  text NOT NULL,
  primary_model_alias           text NOT NULL,
  fallback_model_alias          text,
  shadow_model_alias            text,
  canary_model_alias            text,
  canary_percentage             numeric(5,2),
  routing_policy                jsonb,
  temperature_override          numeric(4,2),
  max_output_tokens_override    integer,
  timeout_ms_override           integer,
  confidence_threshold          numeric(5,4),
  requires_dual_run             boolean NOT NULL DEFAULT false,
  approval_required_for_change  boolean NOT NULL DEFAULT true,
  is_active                     boolean NOT NULL DEFAULT true,
  effective_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------
-- 4.8  llm_calls
-- -----------------------------------------------------------
CREATE TABLE llm_calls (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                  uuid NOT NULL,
  domain_key                  text NOT NULL DEFAULT 'rightreply',
  tenant_id                   uuid,
  task_type                   text NOT NULL,
  task_version                text NOT NULL,
  route_mode                  route_mode_enum NOT NULL DEFAULT 'primary',
  input_trust_level           input_trust_level_enum NOT NULL,
  status                      llm_call_status_enum NOT NULL,
  resolved_provider           text NOT NULL,
  resolved_model_id           text NOT NULL,
  resolved_model_alias        text NOT NULL,
  temperature                 numeric(4,2),
  max_output_tokens           integer,
  timeout_ms                  integer,
  started_at                  timestamptz NOT NULL,
  completed_at                timestamptz,
  latency_ms                  integer,
  output_text                 text,
  output_json                 jsonb,
  finish_reason               text,
  schema_valid                boolean NOT NULL DEFAULT false,
  parser_error                text,
  usage_prompt_tokens         integer,
  usage_completion_tokens     integer,
  usage_cached_tokens         integer,
  estimated_cost_usd          numeric(12,6),
  provider_request_id         text,
  task_confidence             numeric(5,4),
  policy_flags                text[] NOT NULL DEFAULT '{}',
  retry_count                 integer NOT NULL DEFAULT 0,
  fallback_used               boolean NOT NULL DEFAULT false,
  correlation_id              uuid,
  causation_event_id          uuid,
  prompt_template_id          text,
  prompt_template_version     text,
  request_payload_excerpt     jsonb,
  response_payload_excerpt    jsonb,
  artifact_ref                text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------
-- 4.9  llm_call_artifacts
-- -----------------------------------------------------------
CREATE TABLE llm_call_artifacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id             uuid NOT NULL REFERENCES llm_calls(id),
  artifact_type       llm_artifact_type_enum NOT NULL,
  storage_ref         text NOT NULL,
  content_hash_sha256 text NOT NULL,
  byte_size           integer,
  retention_class     llm_artifact_retention_enum NOT NULL DEFAULT 'sampled_short',
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------
-- 4.10 policy_rules
-- Self-ref FKs deferred
-- -----------------------------------------------------------
CREATE TABLE policy_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key                text NOT NULL,
  version                 integer NOT NULL,
  domain_key              text NOT NULL DEFAULT 'rightreply',
  scope_type              policy_scope_enum NOT NULL,
  scope_id                text,
  title                   text NOT NULL,
  description             text,
  risk_tier               policy_risk_tier_enum NOT NULL,
  condition_text          text NOT NULL,
  condition_json          jsonb NOT NULL,
  action_text             text NOT NULL,
  action_json             jsonb NOT NULL,
  severity                policy_rule_severity_enum NOT NULL DEFAULT 'normal',
  status                  policy_rule_status_enum NOT NULL DEFAULT 'draft',
  supersedes_rule_id      uuid,     -- self-ref FK deferred
  superseded_by_rule_id   uuid,     -- self-ref FK deferred
  approved_by_actor_id    text,
  approved_at             timestamptz,
  effective_at            timestamptz NOT NULL DEFAULT now(),
  effective_until          timestamptz,
  created_by_actor_id     text NOT NULL,
  created_from_event_id   uuid,
  last_event_id           uuid,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Unique version per (rule_key, scope_type, scope_id)
-- COALESCE handles NULL scope_id for global-scope rules
CREATE UNIQUE INDEX uq_policy_rule_version
  ON policy_rules (rule_key, scope_type, COALESCE(scope_id, '__global__'), version);

-- One live rule per (rule_key, scope_type, scope_id)
CREATE UNIQUE INDEX uq_policy_one_live_per_key_scope
  ON policy_rules (rule_key, scope_type, COALESCE(scope_id, '__global__'))
  WHERE status = 'live';

-- -----------------------------------------------------------
-- 4.11 approvals
-- -----------------------------------------------------------
CREATE TABLE approvals (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid REFERENCES tenants(id),
  scope_type                approval_scope_enum NOT NULL,
  scope_id                  text NOT NULL,
  status                    approval_status_enum NOT NULL DEFAULT 'pending',
  requested_action          text NOT NULL,
  requested_payload         jsonb NOT NULL,
  reason                    text,
  evidence_packet           jsonb,
  requested_by_actor_type   approval_requestor_actor_enum NOT NULL,
  requested_by_actor_id     text NOT NULL,
  requested_at              timestamptz NOT NULL DEFAULT now(),
  review_due_at             timestamptz,
  decided_by_actor_type     approval_decider_actor_enum,
  decided_by_actor_id       text,
  decided_at                timestamptz,
  decision_note             text,
  expires_at                timestamptz,
  created_from_event_id     uuid,
  last_event_id             uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- One pending approval per (scope_type, scope_id, requested_action)
CREATE UNIQUE INDEX uq_approvals_one_pending
  ON approvals (scope_type, scope_id, requested_action)
  WHERE status = 'pending';

-- -----------------------------------------------------------
-- 4.12 automation_controls
-- -----------------------------------------------------------
CREATE TABLE automation_controls (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type            automation_control_scope_enum NOT NULL,
  scope_id              uuid,
  control_key           automation_control_key_enum NOT NULL,
  control_value         boolean NOT NULL,
  reason                text,
  set_by_actor_type     automation_control_actor_enum NOT NULL,
  set_by_actor_id       text NOT NULL,
  effective_at          timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  created_from_event_id uuid,
  last_event_id         uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Global-only keys must have scope_type = global
  CONSTRAINT chk_global_keys_global_scope CHECK (
    control_key NOT IN ('global_publish_enabled', 'response_generation_enabled',
                        'draft_only_mode', 'incident_mode', 'gateway_healthy_required')
    OR scope_type = 'global'
  ),
  -- tenant_publish_enabled must have scope_type = tenant
  CONSTRAINT chk_tenant_key_tenant_scope CHECK (
    control_key != 'tenant_publish_enabled'
    OR scope_type = 'tenant'
  ),
  -- Global scope requires NULL scope_id
  CONSTRAINT chk_global_scope_null_id CHECK (
    scope_type != 'global' OR scope_id IS NULL
  ),
  -- Tenant scope requires non-NULL scope_id
  CONSTRAINT chk_tenant_scope_has_id CHECK (
    scope_type != 'tenant' OR scope_id IS NOT NULL
  )
);

-- COALESCE handles NULL scope_id for global-scope uniqueness
CREATE UNIQUE INDEX uq_automation_control
  ON automation_controls (
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    control_key
  );

-- -----------------------------------------------------------
-- 4.13 system_config
-- -----------------------------------------------------------
CREATE TABLE system_config (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type            system_config_scope_enum NOT NULL,
  scope_id              uuid,
  config_key            system_config_key_enum NOT NULL,
  value_type            system_config_value_type_enum NOT NULL,
  numeric_value         numeric(12,6),
  integer_value         integer,
  boolean_value         boolean,
  text_value            text,
  json_value            jsonb,
  units                 text,
  description           text,
  set_by_actor_id       text NOT NULL,
  effective_at          timestamptz NOT NULL DEFAULT now(),
  created_from_event_id uuid,
  last_event_id         uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Exactly one value column must be populated
  CONSTRAINT chk_single_value CHECK (
    (CASE WHEN numeric_value  IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN integer_value  IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN boolean_value  IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN text_value     IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN json_value     IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

-- COALESCE handles NULL scope_id for global-scope uniqueness
CREATE UNIQUE INDEX uq_system_config_key
  ON system_config (
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    config_key
  );

-- -----------------------------------------------------------
-- 4.14 reviews
-- FK to responses (current_response_id) deferred
-- FKs to llm_calls deferred
-- -----------------------------------------------------------
CREATE TABLE reviews (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL REFERENCES tenants(id),
  oauth_connection_id             uuid NOT NULL REFERENCES oauth_connections(id),
  source_channel                  review_source_channel_enum NOT NULL,
  source_review_id                text NOT NULL,
  source_location_id              text NOT NULL,
  reviewer_display_name           text,
  reviewer_is_anonymous           boolean NOT NULL DEFAULT false,
  star_rating                     smallint NOT NULL,
  review_text                     text,
  review_language                 text,
  source_review_published_at      timestamptz NOT NULL,
  ingested_at                     timestamptz NOT NULL DEFAULT now(),
  status                          review_status_enum NOT NULL DEFAULT 'received',
  source_review_status            review_source_status_enum NOT NULL DEFAULT 'active',
  current_response_id             uuid,     -- FK deferred
  duplicate_of_review_id          uuid REFERENCES reviews(id),
  processing_attempt_count        integer NOT NULL DEFAULT 0,
  last_processed_at               timestamptz,
  injection_status                review_injection_status_enum NOT NULL DEFAULT 'not_run',
  injection_confidence            numeric(5,4),
  injection_pattern_codes         text[],
  obfuscation_detected            boolean NOT NULL DEFAULT false,
  safe_for_downstream_generation  boolean,
  content_safety_flags            text[],
  customer_intent                 review_customer_intent_enum,
  recommended_risk_tier           review_risk_tier_enum,
  is_safe_review_v1_candidate     boolean,
  safe_review_confidence          numeric(5,4),
  question_detected               boolean NOT NULL DEFAULT false,
  complaint_detected              boolean NOT NULL DEFAULT false,
  contact_request_detected        boolean NOT NULL DEFAULT false,
  wrong_business_or_spam_detected boolean NOT NULL DEFAULT false,
  block_reason_codes              text[],
  needs_human_review              boolean NOT NULL DEFAULT false,
  autopublish_eligible            boolean NOT NULL DEFAULT false,
  injection_llm_call_id           uuid,     -- FK deferred
  classification_llm_call_id      uuid,     -- FK deferred
  created_from_event_id           uuid,
  last_event_id                   uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_star_rating CHECK (star_rating BETWEEN 1 AND 5),
  CONSTRAINT uq_review_source UNIQUE (tenant_id, source_channel, source_review_id)
);

-- -----------------------------------------------------------
-- 4.15 responses
-- Self-ref FKs deferred
-- -----------------------------------------------------------
CREATE TABLE responses (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                         uuid NOT NULL REFERENCES tenants(id),
  review_id                         uuid NOT NULL REFERENCES reviews(id),
  response_version                  integer NOT NULL,
  status                            response_status_enum NOT NULL DEFAULT 'draft_generated',
  draft_text                        text NOT NULL,
  final_text                        text,
  generation_mode                   response_generation_mode_enum NOT NULL,
  brand_voice_profile_id            uuid REFERENCES brand_voice_profiles(id),
  generation_llm_call_id            uuid REFERENCES llm_calls(id),
  generation_prompt_template_id     text,
  generation_prompt_template_version text,
  generated_at                      timestamptz NOT NULL DEFAULT now(),
  approval_required                 boolean NOT NULL DEFAULT false,
  approval_id                       uuid REFERENCES approvals(id),
  approved_at                       timestamptz,
  approved_by_actor_id              text,
  rejected_at                       timestamptz,
  rejected_by_actor_id              text,
  rejection_reason                  text,
  publish_attempt_count             integer NOT NULL DEFAULT 0,
  last_publish_attempted_at         timestamptz,
  published_at                      timestamptz,
  publish_provider_response_id      text,
  publish_receipt_id                uuid REFERENCES event_receipts(id),
  publish_failure_code              text,
  publish_failure_message           text,
  supersedes_response_id            uuid,     -- self-ref FK deferred
  superseded_by_response_id         uuid,     -- self-ref FK deferred
  created_from_event_id             uuid,
  last_event_id                     uuid,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_response_version UNIQUE (review_id, response_version)
);

-- -----------------------------------------------------------
-- 4.16 eval_cases
-- -----------------------------------------------------------
CREATE TABLE eval_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_name        text NOT NULL,
  case_type         text NOT NULL,
  input_event_ids   uuid[],
  input_payload     jsonb NOT NULL DEFAULT '{}',
  expected_outputs  jsonb NOT NULL DEFAULT '{}',
  labels            text[] NOT NULL DEFAULT '{}',
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------
-- 4.17 eval_runs
-- -----------------------------------------------------------
CREATE TABLE eval_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_name        text NOT NULL,
  run_type          text NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  model_version     text,
  policy_version    text,
  status            eval_run_status_enum NOT NULL DEFAULT 'running',
  summary_metrics   jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------
-- 4.18 eval_results
-- -----------------------------------------------------------
CREATE TABLE eval_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_run_id       uuid NOT NULL REFERENCES eval_runs(id),
  eval_case_id      uuid REFERENCES eval_cases(id),
  test_name         text NOT NULL,
  severity          eval_severity_enum NOT NULL DEFAULT 'moderate',
  pass              boolean NOT NULL,
  measured_value    jsonb,
  threshold_value   jsonb,
  failure_reason    text,
  related_event_ids uuid[],
  created_at        timestamptz NOT NULL DEFAULT now()
);


-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
-- 5. DEFERRED FOREIGN KEYS
-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

-- tenants → brand_voice_profiles
ALTER TABLE tenants
  ADD CONSTRAINT fk_tenants_brand_voice_profile
  FOREIGN KEY (approved_brand_voice_profile_id)
  REFERENCES brand_voice_profiles(id);

-- tenants → oauth_connections
ALTER TABLE tenants
  ADD CONSTRAINT fk_tenants_oauth_connection
  FOREIGN KEY (current_oauth_connection_id)
  REFERENCES oauth_connections(id);

-- reviews → responses (current draft/published response)
ALTER TABLE reviews
  ADD CONSTRAINT fk_reviews_current_response
  FOREIGN KEY (current_response_id)
  REFERENCES responses(id);

-- reviews → llm_calls (injection detection call)
ALTER TABLE reviews
  ADD CONSTRAINT fk_reviews_injection_llm_call
  FOREIGN KEY (injection_llm_call_id)
  REFERENCES llm_calls(id);

-- reviews → llm_calls (classification call)
ALTER TABLE reviews
  ADD CONSTRAINT fk_reviews_classification_llm_call
  FOREIGN KEY (classification_llm_call_id)
  REFERENCES llm_calls(id);

-- responses self-references
ALTER TABLE responses
  ADD CONSTRAINT fk_responses_supersedes
  FOREIGN KEY (supersedes_response_id)
  REFERENCES responses(id);

ALTER TABLE responses
  ADD CONSTRAINT fk_responses_superseded_by
  FOREIGN KEY (superseded_by_response_id)
  REFERENCES responses(id);

-- brand_voice_profiles self-reference
ALTER TABLE brand_voice_profiles
  ADD CONSTRAINT fk_bvp_supersedes
  FOREIGN KEY (supersedes_profile_id)
  REFERENCES brand_voice_profiles(id);

-- policy_rules self-references
ALTER TABLE policy_rules
  ADD CONSTRAINT fk_policy_supersedes
  FOREIGN KEY (supersedes_rule_id)
  REFERENCES policy_rules(id);

ALTER TABLE policy_rules
  ADD CONSTRAINT fk_policy_superseded_by
  FOREIGN KEY (superseded_by_rule_id)
  REFERENCES policy_rules(id);


-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
-- 6. INDEXES
-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

-- --- tenants ---
CREATE INDEX idx_tenants_status          ON tenants (status);
CREATE INDEX idx_tenants_plan_status     ON tenants (plan_code, status);
CREATE INDEX idx_tenants_oauth           ON tenants (current_oauth_connection_id);
CREATE INDEX idx_tenants_bvp             ON tenants (approved_brand_voice_profile_id);
CREATE INDEX idx_tenants_updated         ON tenants (updated_at DESC);

-- --- oauth_connections ---
CREATE INDEX idx_oauth_tenant_status     ON oauth_connections (tenant_id, status);
CREATE INDEX idx_oauth_status_expires    ON oauth_connections (status, token_expires_at);
CREATE INDEX idx_oauth_location          ON oauth_connections (external_location_id);

-- --- brand_voice_profiles ---
CREATE INDEX idx_bvp_tenant_status       ON brand_voice_profiles (tenant_id, status);
CREATE INDEX idx_bvp_tenant_version      ON brand_voice_profiles (tenant_id, profile_version DESC);

-- --- events ---
CREATE INDEX idx_events_tenant_type      ON events (tenant_id, event_type);
CREATE INDEX idx_events_type_occurred    ON events (event_type, occurred_at DESC);
CREATE INDEX idx_events_correlation      ON events (correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_events_causation        ON events (causation_event_id)
  WHERE causation_event_id IS NOT NULL;
CREATE INDEX idx_events_object           ON events (object_type, object_id);
CREATE INDEX idx_events_recorded         ON events (recorded_at DESC);
CREATE INDEX idx_events_archive          ON events (archive_tier, recorded_at);

-- --- event_receipts ---
CREATE INDEX idx_event_receipts_event    ON event_receipts (event_id);
CREATE INDEX idx_event_receipts_type     ON event_receipts (receipt_type);

-- --- reviews ---
CREATE INDEX idx_reviews_tenant_status_pub
  ON reviews (tenant_id, status, source_review_published_at DESC);
CREATE INDEX idx_reviews_tenant_rating_pub
  ON reviews (tenant_id, star_rating, source_review_published_at DESC);
CREATE INDEX idx_reviews_autopublish
  ON reviews (autopublish_eligible, status)
  WHERE autopublish_eligible = true;
CREATE INDEX idx_reviews_human_review
  ON reviews (needs_human_review)
  WHERE needs_human_review = true;
CREATE INDEX idx_reviews_block_reasons
  ON reviews USING gin (block_reason_codes)
  WHERE block_reason_codes IS NOT NULL;
CREATE INDEX idx_reviews_safety_flags
  ON reviews USING gin (content_safety_flags)
  WHERE content_safety_flags IS NOT NULL;
CREATE INDEX idx_reviews_current_response
  ON reviews (current_response_id);

-- --- responses ---
CREATE INDEX idx_responses_review_version
  ON responses (review_id, response_version DESC);
CREATE INDEX idx_responses_tenant_status
  ON responses (tenant_id, status);
CREATE INDEX idx_responses_approval
  ON responses (approval_id)
  WHERE approval_id IS NOT NULL;
CREATE INDEX idx_responses_published
  ON responses (published_at DESC)
  WHERE status = 'published';
CREATE INDEX idx_responses_publish_attempts
  ON responses (publish_attempt_count);

-- --- policy_rules ---
CREATE INDEX idx_policy_status_scope     ON policy_rules (status, scope_type);
CREATE INDEX idx_policy_key_version      ON policy_rules (rule_key, version DESC);
CREATE INDEX idx_policy_scope            ON policy_rules (scope_type, scope_id, status);

-- --- approvals ---
CREATE INDEX idx_approvals_tenant_status ON approvals (tenant_id, status);
CREATE INDEX idx_approvals_scope         ON approvals (scope_type, scope_id);
CREATE INDEX idx_approvals_requested     ON approvals (requested_at DESC);

-- --- automation_controls ---
CREATE INDEX idx_auto_controls_scope     ON automation_controls (scope_type, scope_id);
CREATE INDEX idx_auto_controls_key_value ON automation_controls (control_key, control_value);

-- --- system_config ---
CREATE INDEX idx_system_config_key       ON system_config (config_key);
CREATE INDEX idx_system_config_scope     ON system_config (scope_type, scope_id);

-- --- llm_calls ---
CREATE INDEX idx_llm_calls_tenant        ON llm_calls (tenant_id)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_llm_calls_task          ON llm_calls (task_type, created_at DESC);
CREATE INDEX idx_llm_calls_correlation   ON llm_calls (correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_llm_calls_status        ON llm_calls (status);
CREATE INDEX idx_llm_calls_request       ON llm_calls (request_id);

-- --- llm_call_artifacts ---
CREATE INDEX idx_llm_artifacts_call      ON llm_call_artifacts (call_id);

-- --- model_registry ---
CREATE INDEX idx_model_registry_status   ON model_registry (status);
CREATE INDEX idx_model_registry_provider ON model_registry (provider_key, status);

-- --- task_model_routes ---
CREATE INDEX idx_task_routes_active
  ON task_model_routes (task_type, is_active)
  WHERE is_active = true;

-- --- eval_cases ---
CREATE INDEX idx_eval_cases_suite        ON eval_cases (suite_name, is_active);

-- --- eval_runs ---
CREATE INDEX idx_eval_runs_suite         ON eval_runs (suite_name, started_at DESC);
CREATE INDEX idx_eval_runs_status        ON eval_runs (status);

-- --- eval_results ---
CREATE INDEX idx_eval_results_run        ON eval_results (eval_run_id);
CREATE INDEX idx_eval_results_case       ON eval_results (eval_case_id)
  WHERE eval_case_id IS NOT NULL;
CREATE INDEX idx_eval_results_failures   ON eval_results (eval_run_id, pass)
  WHERE pass = false;


-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
-- 7. UPDATED_AT TRIGGERS
-- Applied only to mutable operational tables.
-- Immutable tables (events, event_receipts, llm_calls,
-- llm_call_artifacts, eval_results) have no update trigger.
-- ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_oauth_updated_at
  BEFORE UPDATE ON oauth_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_bvp_updated_at
  BEFORE UPDATE ON brand_voice_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_reviews_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_responses_updated_at
  BEFORE UPDATE ON responses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_policy_rules_updated_at
  BEFORE UPDATE ON policy_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_approvals_updated_at
  BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_auto_controls_updated_at
  BEFORE UPDATE ON automation_controls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_system_config_updated_at
  BEFORE UPDATE ON system_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_model_registry_updated_at
  BEFORE UPDATE ON model_registry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_task_routes_updated_at
  BEFORE UPDATE ON task_model_routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_eval_cases_updated_at
  BEFORE UPDATE ON eval_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


COMMIT;
