# RIGHTREPLY CORE OPERATIONAL DATA MODEL
## Slice 1 — Postgres/Supabase Schema
### March 20, 2026

---

## Global Design Rules

These apply to all nine tables.

1. **Operational tables store current truth.** The immutable events ledger stores history and causation. These tables store the latest operational state.
2. **Events drive writes.** No silent state changes. Every meaningful insert/update should correspond to an event in the ledger.
3. **Do not store raw blobs here.** Raw webhook bodies, provider payloads, and long audit artifacts belong in the events ledger / artifact storage.
4. **Do not mix memory into operational state.** These are not memory tables. They hold live app state needed to run the operator.
5. **Use events for history, tables for current state.** Versioning/supersession is used where the current table itself must preserve lineage, such as brand_voice_profiles, policy_rules, and responses.

---

## 1) tenants

### Purpose

Current source of truth for each customer account's commercial and operational identity.

**Authoritative for:** Customer/account identity, plan code and service lifecycle status, primary contact fields, default timezone/locale, which brand voice profile is currently live, which OAuth connection is currently the active one.

**Not authoritative for:** Raw billing ledger, raw OAuth tokens, review history, response history, audit history, memory/preferences/patterns.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| tenant_key | text | yes | Stable internal key, human-friendly slug |
| legal_name | text | no | Legal business/entity name if different |
| display_name | text | yes | Customer-facing business name |
| business_category | tenant_business_category_enum | yes | Used for segmentation/templates |
| status | tenant_status_enum | yes | Current lifecycle state |
| plan_code | text | yes | Example: starter_79 |
| billing_provider_customer_id | text | no | Stripe or other provider customer ID |
| trial_starts_at | timestamptz | no | Null if no trial |
| trial_ends_at | timestamptz | no | Null if no trial |
| service_starts_at | timestamptz | no | First active service date |
| service_ends_at | timestamptz | no | Final service date if canceled |
| timezone | text | yes | IANA timezone |
| default_locale | text | yes | Example: en-US |
| primary_contact_name | text | no | Current main contact |
| primary_contact_email | citext | no | Prefer citext extension |
| primary_contact_phone | text | no | E.164 preferred |
| approved_brand_voice_profile_id | uuid | no | FK to brand_voice_profiles.id |
| current_oauth_connection_id | uuid | no | FK to oauth_connections.id |
| last_review_sync_at | timestamptz | no | Last successful sync |
| last_digest_sent_at | timestamptz | no | Later phase |
| paused_reason | text | no | Human-readable reason |
| notes | text | no | Internal ops notes only |
| created_from_event_id | uuid | no | Event that created row |
| last_event_id | uuid | no | Most recent event applied |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**tenant_business_category_enum:** dentist, roofing, restaurant, contractor, home_services, medical, legal, other

**tenant_status_enum:** onboarding, onboarding_blocked, trial_active, active, paused, cancel_scheduled, canceled, archived

### State Transitions

| From | To | Trigger |
|------|-----|---------|
| onboarding | trial_active | oauth.connected + minimum onboarding valid |
| onboarding | active | Immediate paid activation without trial |
| onboarding | onboarding_blocked | OAuth/connectivity/config validation failure |
| onboarding_blocked | onboarding | Human fixes blocking issue |
| onboarding_blocked | canceled | Customer abandons before launch |
| trial_active | active | Trial converts / first paid activation |
| trial_active | paused | Human/admin pause or operational block |
| trial_active | cancel_scheduled | Customer requests end-of-period cancellation |
| trial_active | canceled | Immediate cancel |
| active | paused | automation.paused or admin pause |
| active | cancel_scheduled | Customer requests cancellation |
| active | canceled | Immediate termination |
| paused | active | automation.resumed and blockers cleared |
| paused | cancel_scheduled | Customer requests cancellation while paused |
| paused | canceled | Immediate cancel |
| cancel_scheduled | active | Cancellation reversed |
| cancel_scheduled | canceled | End date reached or human executes cancel |
| canceled | archived | Retention/archive process |

Anything not listed is not allowed.

### Uniqueness Constraints
- unique (tenant_key)
- optional: unique (billing_provider_customer_id) where not null

### Key Indexes
- index on (status)
- index on (plan_code, status)
- index on (current_oauth_connection_id)
- index on (approved_brand_voice_profile_id)
- index on (updated_at desc)

### Events That Cause Writes
- tenant.created → insert
- oauth.connected → update status / current OAuth
- oauth.refresh_failed → maybe update status to onboarding_blocked or paused
- brand_voice.approved → set approved_brand_voice_profile_id
- automation.paused / automation.resumed → update status
- future billing events → update lifecycle state

---

## 2) oauth_connections

### Purpose

Current source of truth for tenant-to-provider authorization status.

**Authoritative for:** Whether Google Business Profile access is currently usable, current token state, scoped location/account binding, last refresh error state.

**Not authoritative for:** Long-term audit history of refresh attempts, raw OAuth callback payloads, tenant business identity.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| tenant_id | uuid | yes | FK to tenants.id |
| provider | oauth_provider_enum | yes | Slice 1 = GBP only |
| external_account_id | text | yes | Provider account subject/user identifier |
| external_location_id | text | yes | Google location ID for Slice 1 |
| status | oauth_connection_status_enum | yes | Current auth health |
| granted_scopes | text[] | yes | Granted scopes |
| access_token_ref | text | no | Vault/encrypted reference, not raw token |
| refresh_token_ref | text | no | Vault/encrypted reference, not raw token |
| token_expires_at | timestamptz | no | Null if provider does not expose |
| connected_at | timestamptz | no | When first connected |
| last_refreshed_at | timestamptz | no | Successful refresh |
| last_refresh_attempt_at | timestamptz | no | Attempted refresh |
| last_error_code | text | no | Provider/app error code |
| last_error_message | text | no | Short error detail |
| revoked_at | timestamptz | no | When provider revoked |
| disconnected_at | timestamptz | no | Human-initiated disconnect |
| metadata | jsonb | no | Provider-specific lightweight metadata |
| created_from_event_id | uuid | no | Event that created row |
| last_event_id | uuid | no | Most recent event applied |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**oauth_provider_enum:** google_business_profile

**oauth_connection_status_enum:** pending, connected, refresh_failed, token_expired, revoked, disconnected

### State Transitions

| From | To | Trigger |
|------|-----|---------|
| pending | connected | OAuth callback succeeds |
| pending | disconnected | Human aborts onboarding |
| connected | connected | Successful token refresh, same state |
| connected | refresh_failed | Refresh attempt fails |
| connected | token_expired | Token expires and refresh unavailable |
| connected | revoked | Provider revokes access |
| connected | disconnected | Human disconnect |
| refresh_failed | connected | Successful retry refresh |
| refresh_failed | token_expired | Refresh window lost / token expired |
| refresh_failed | revoked | Provider revokes |
| token_expired | connected | Reauth succeeds |
| token_expired | revoked | Provider revokes |
| token_expired | disconnected | Human disconnect |
| revoked | disconnected | Cleanup finalization |
| disconnected | pending | Human initiates reconnect |
| disconnected | connected | Reconnect completes directly |

Anything not listed is not allowed.

### Uniqueness Constraints
- unique (provider, external_location_id) for Slice 1
- unique (tenant_id, provider, external_location_id)

### Key Indexes
- index on (tenant_id, status)
- index on (status, token_expires_at)
- index on (external_location_id)

### Events That Cause Writes
- oauth.connected → insert or set connected
- oauth.refresh_failed → update state/error fields
- oauth.refresh_succeeded → update refresh timestamps/state
- oauth.revoked → set revoked
- oauth.disconnected → set disconnected

---

## 3) brand_voice_profiles

### Purpose

Versioned source of truth for tenant-specific response style rules.

**Authoritative for:** Live approved voice profile, draft profiles under review, voice/version lineage.

**Not authoritative for:** Individual response texts, one-off human edits to single responses, long-term memory/preferences.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| tenant_id | uuid | yes | FK |
| profile_version | integer | yes | Monotonic per tenant |
| status | brand_voice_profile_status_enum | yes | Current version state |
| label | text | yes | Human-readable name |
| source_type | brand_voice_profile_source_enum | yes | How it was produced |
| tone_summary | text | yes | Short natural-language summary |
| style_rules | jsonb | yes | Canonical structured rules |
| dos | jsonb | no | Array/list of do's |
| donts | jsonb | no | Array/list of don'ts |
| forbidden_phrases | text[] | no | Hard blocks |
| approved_example_responses | jsonb | no | Example responses |
| max_response_words | integer | yes | Hard cap |
| allow_exclamation_points | boolean | yes | Style rule |
| signoff_style | text | no | Usually null for GBP |
| prompt_snippet | text | no | Optional distilled insert for generation |
| supersedes_profile_id | uuid | no | Prior profile |
| approved_by_actor_id | text | no | Human approver |
| approved_at | timestamptz | no | Approval time |
| rejected_reason | text | no | If rejected |
| created_from_event_id | uuid | no | Event that created row |
| last_event_id | uuid | no | Most recent event |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**brand_voice_profile_status_enum:** draft, approved_live, approved_inactive, rejected, superseded, archived

**brand_voice_profile_source_enum:** onboarding_answers, model_draft, manual_admin_edit, customer_requested_change, imported_examples

### State Transitions

| From | To | Trigger |
|------|-----|---------|
| draft | approved_live | Human approves and activates |
| draft | rejected | Human rejects |
| approved_live | approved_inactive | Another version becomes live |
| approved_live | superseded | Explicit supersession |
| approved_inactive | approved_live | Human reactivates old version |
| approved_inactive | archived | Retention cleanup |
| rejected | archived | Retention cleanup |
| superseded | archived | Retention cleanup |

### Uniqueness Constraints
- unique (tenant_id, profile_version)
- partial unique: one approved_live profile per tenant

### Key Indexes
- index on (tenant_id, status)
- index on (tenant_id, profile_version desc)

### Events That Cause Writes
- brand_voice.draft_generated → insert draft
- brand_voice.approved → set approved/live and supersede previous
- settings.updated or explicit profile change events later → insert new version

---

## 4) reviews

### Purpose

Current operational record for each inbound Google review and its pipeline state.

**Authoritative for:** Current review processing status, latest injection/classification results, current autopublish eligibility, link to current response version.

**Not authoritative for:** Raw webhook payload, full event history, full response text history, long-term memory/patterns.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| tenant_id | uuid | yes | FK |
| oauth_connection_id | uuid | yes | FK |
| source_channel | review_source_channel_enum | yes | Slice 1 = GBP |
| source_review_id | text | yes | Provider review ID |
| source_location_id | text | yes | Google location ID |
| reviewer_display_name | text | no | Null if anonymous |
| reviewer_is_anonymous | boolean | yes | Default false |
| star_rating | smallint | yes | 1-5 check constraint |
| review_text | text | no | Null/blank supported for later cohorts |
| review_language | text | no | Example: en |
| source_review_published_at | timestamptz | yes | Provider timestamp |
| ingested_at | timestamptz | yes | App ingest time |
| status | review_status_enum | yes | Current end-to-end state |
| source_review_status | review_source_status_enum | yes | Usually active |
| current_response_id | uuid | no | FK to responses.id |
| duplicate_of_review_id | uuid | no | If duplicate blocked |
| processing_attempt_count | integer | yes | Default 0 |
| last_processed_at | timestamptz | no | Last pipeline touch |
| injection_status | review_injection_status_enum | yes | Detection result |
| injection_confidence | numeric(5,4) | no | 0-1 |
| injection_pattern_codes | text[] | no | Pattern codes |
| obfuscation_detected | boolean | yes | Default false |
| safe_for_downstream_generation | boolean | no | From injection stage |
| content_safety_flags | text[] | no | Refund/legal/etc. |
| customer_intent | review_customer_intent_enum | no | Praise/complaint/etc. |
| recommended_risk_tier | review_risk_tier_enum | no | Autonomous / confirmation / forbidden |
| is_safe_review_v1_candidate | boolean | no | Canonical contract output |
| safe_review_confidence | numeric(5,4) | no | Canonical contract output |
| question_detected | boolean | yes | Default false |
| complaint_detected | boolean | yes | Default false |
| contact_request_detected | boolean | yes | Default false |
| wrong_business_or_spam_detected | boolean | yes | Default false |
| block_reason_codes | text[] | no | Canonical contract output |
| needs_human_review | boolean | yes | Default false |
| autopublish_eligible | boolean | yes | Default false |
| injection_llm_call_id | uuid | no | FK-ish to llm_calls.id |
| classification_llm_call_id | uuid | no | FK-ish to llm_calls.id |
| created_from_event_id | uuid | no | Usually review.received |
| last_event_id | uuid | no | Most recent review-affecting event |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**review_source_channel_enum:** google_gbp

**review_source_status_enum:** active, removed_external

**review_status_enum:** received, duplicate_blocked, injection_blocked, policy_blocked, needs_human_review, eligible_for_generation, draft_ready, awaiting_human_approval, approved_for_publish, publish_in_progress, published, publish_failed, closed

**review_injection_status_enum:** not_run, clean, ambiguous, detected

**review_customer_intent_enum:** praise, complaint, mixed, question, contact_request, no_text, spam_wrong_business, unknown

**review_risk_tier_enum:** autonomous, confirmation_required, forbidden

### Review State Machine

```
received
├──(review.duplicate_detected)────────────────→ duplicate_blocked
├──(review.policy_blocked + injection)────────→ injection_blocked
├──(review.policy_blocked non-injection)──────→ policy_blocked
├──(escalation.triggered)─────────────────────→ needs_human_review
└──(review.classified + safe_review_v1 true)──→ eligible_for_generation

eligible_for_generation
└──(response.draft_generated)─────────────────→ draft_ready

draft_ready
├──(confirmation-required path)───────────────→ awaiting_human_approval
├──(response.publish_attempted autonomous)────→ publish_in_progress
└──(response.draft_generated replacement)─────→ draft_ready

awaiting_human_approval
├──(approval.recorded approved)───────────────→ approved_for_publish
├──(approval.recorded rejected)───────────────→ needs_human_review
└──(response.draft_generated replacement)─────→ draft_ready

approved_for_publish
└──(response.publish_attempted)───────────────→ publish_in_progress

publish_in_progress
├──(response.published)───────────────────────→ published
└──(response.publish_failed)──────────────────→ publish_failed

publish_failed
├──(response.publish_attempted retry)─────────→ publish_in_progress
├──(response.draft_generated replacement)─────→ draft_ready
└──(human.override_applied close)─────────────→ closed

duplicate_blocked / injection_blocked / policy_blocked / needs_human_review
└──(human.override_applied close)─────────────→ closed
```

If a transition is not shown above, it is not allowed.

### Uniqueness Constraints
- unique (tenant_id, source_channel, source_review_id)

### Key Indexes
- index on (tenant_id, status, source_review_published_at desc)
- index on (tenant_id, star_rating, source_review_published_at desc)
- index on (autopublish_eligible, status) partial for true values
- index on (needs_human_review) partial for true values
- gin index on block_reason_codes
- gin index on content_safety_flags
- index on (current_response_id)

### Events That Cause Writes
- review.received → insert
- review.duplicate_detected → mark duplicate
- review.classified → update all classifier fields
- review.policy_blocked → set blocked/injection state
- escalation.triggered → set needs_human_review
- response.draft_generated → set current_response_id, status
- approval.recorded → update approval-related review state
- response.publish_attempted / response.published / response.publish_failed → update publish state

---

## 5) responses

### Purpose

Versioned source of truth for response drafts and publication lifecycle.

**Authoritative for:** Response text versions, approval status of each response version, publish attempts/results, which response superseded which.

**Not authoritative for:** Review classification, review source text, publish receipt body itself, full audit/event history.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| tenant_id | uuid | yes | FK |
| review_id | uuid | yes | FK |
| response_version | integer | yes | Monotonic per review |
| status | response_status_enum | yes | Current lifecycle state |
| draft_text | text | yes | Generated or human-entered draft |
| final_text | text | no | Published/final approved text |
| generation_mode | response_generation_mode_enum | yes | How this version was produced |
| brand_voice_profile_id | uuid | no | FK to active profile used |
| generation_llm_call_id | uuid | no | llm_calls.id |
| generation_prompt_template_id | text | no | Template ref |
| generation_prompt_template_version | text | no | Version pin |
| generated_at | timestamptz | yes | Draft generation time |
| approval_required | boolean | yes | Whether this version needs human approval |
| approval_id | uuid | no | FK to approvals.id |
| approved_at | timestamptz | no | Approval timestamp |
| approved_by_actor_id | text | no | Human approver |
| rejected_at | timestamptz | no | Reject timestamp |
| rejected_by_actor_id | text | no | Human rejector |
| rejection_reason | text | no | Human reason |
| publish_attempt_count | integer | yes | Default 0 |
| last_publish_attempted_at | timestamptz | no | Last attempt |
| published_at | timestamptz | no | Success timestamp |
| publish_provider_response_id | text | no | Provider receipt identifier |
| publish_receipt_id | uuid | no | Link to event_receipts.id |
| publish_failure_code | text | no | Last failure code |
| publish_failure_message | text | no | Last failure detail |
| supersedes_response_id | uuid | no | Prior version |
| superseded_by_response_id | uuid | no | Later version |
| created_from_event_id | uuid | no | Usually response.draft_generated |
| last_event_id | uuid | no | Most recent lifecycle event |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**response_status_enum:** draft_generated, awaiting_human_approval, approved, rejected, publish_attempted, published, publish_failed, superseded, archived

**response_generation_mode_enum:** autonomous, human_approved, manual_import, retry_existing, replacement_draft

### Response State Machine

```
draft_generated
├──(approval required)────────────────────────→ awaiting_human_approval
├──(response.publish_attempted autonomous)────→ publish_attempted
├──(approval.recorded rejected without use)───→ rejected
└──(response.draft_generated newer version)───→ superseded

awaiting_human_approval
├──(approval.recorded approved)───────────────→ approved
├──(approval.recorded rejected)───────────────→ rejected
└──(response.draft_generated replacement)─────→ superseded

approved
└──(response.publish_attempted)───────────────→ publish_attempted

publish_attempted
├──(response.published)───────────────────────→ published
└──(response.publish_failed)──────────────────→ publish_failed

publish_failed
├──(response.publish_attempted retry)─────────→ publish_attempted
└──(response.draft_generated replacement)─────→ superseded

rejected
└──(response.draft_generated replacement)─────→ superseded

published
└──(response.superseded / later edit)─────────→ superseded
```

If a transition is not shown above, it is not allowed.

### Uniqueness Constraints
- unique (review_id, response_version)

### Key Indexes
- index on (review_id, response_version desc)
- index on (tenant_id, status)
- index on (approval_id)
- index on (published_at desc) partial where published
- index on (publish_attempt_count)

### Events That Cause Writes
- response.draft_generated → insert
- approval.recorded → update approval/rejection status
- response.publish_attempted → update attempt state
- response.published → update success fields
- response.publish_failed → update failure fields
- response.superseded / new later draft → supersession linkage

---

## 6) policy_rules

### Purpose

Executable operational policy catalog.

**Authoritative for:** Current live rules that govern operator behavior, draft/rejected/superseded rule versions, scope and severity of each rule.

**Not authoritative for:** One-off approval decisions, kill switch current state, numeric threshold tunables, memory rules from later memory system.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| rule_key | text | yes | Stable family key |
| version | integer | yes | Monotonic per key/scope |
| domain_key | text | yes | rightreply |
| scope_type | policy_scope_enum | yes | Global/tenant/workflow |
| scope_id | text | no | Tenant ID or workflow key |
| title | text | yes | Human-readable title |
| description | text | no | Human-readable explanation |
| risk_tier | policy_risk_tier_enum | yes | Autonomous / confirmation / forbidden |
| condition_text | text | yes | Human-readable condition |
| condition_json | jsonb | yes | Canonical structured condition |
| action_text | text | yes | Human-readable action |
| action_json | jsonb | yes | Canonical structured action |
| severity | policy_rule_severity_enum | yes | Operational severity |
| status | policy_rule_status_enum | yes | Draft/live/etc. |
| supersedes_rule_id | uuid | no | Prior version |
| superseded_by_rule_id | uuid | no | Later version |
| approved_by_actor_id | text | no | Human approver |
| approved_at | timestamptz | no | Approval time |
| effective_at | timestamptz | yes | When live version starts |
| effective_until | timestamptz | no | Optional sunset |
| created_by_actor_id | text | yes | Human creator |
| created_from_event_id | uuid | no | Event that created row |
| last_event_id | uuid | no | Most recent lifecycle event |
| notes | text | no | Internal notes |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**policy_scope_enum:** global, tenant, workflow

**policy_risk_tier_enum:** autonomous, confirmation_required, forbidden

**policy_rule_severity_enum:** normal, high, critical

**policy_rule_status_enum:** draft, live, superseded, retired, rejected

### State Transitions

| From | To | Trigger |
|------|-----|---------|
| draft | live | Human approval / activation |
| draft | rejected | Human rejection |
| live | superseded | Newer rule version activated |
| live | retired | Rule turned off without replacement |
| superseded | retired | Cleanup |
| rejected | retired | Cleanup |

### Uniqueness Constraints
- unique (rule_key, scope_type, scope_id, version)
- partial unique: one live rule per (rule_key, scope_type, scope_id)

### Key Indexes
- index on (status, scope_type)
- index on (rule_key, version desc)
- index on (scope_type, scope_id, status)

### Events That Cause Writes
- policy.updated → insert new draft or edit draft
- approval.recorded → activate/reject
- rule.activated / rule.deactivated → state changes

### Source-of-Truth Note

This table defines what the operator is allowed to do, not whether it is currently paused. Current switch state belongs in automation_controls. Current thresholds belong in system_config.

---

## 7) approvals

### Purpose

Operational record of human approval gates and outcomes.

**Authoritative for:** Pending human approvals, approval/rejection decision outcome, scope and payload under review.

**Not authoritative for:** Policy rule definitions, response text versioning, long-term audit history beyond current approval row plus events.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| tenant_id | uuid | no | Nullable for global approvals |
| scope_type | approval_scope_enum | yes | What is being approved |
| scope_id | text | yes | ID of record under approval |
| status | approval_status_enum | yes | Current approval state |
| requested_action | text | yes | Example: publish_response, activate_rule |
| requested_payload | jsonb | yes | Snapshot of what is being approved |
| reason | text | no | Why approval is needed |
| evidence_packet | jsonb | no | Compact packet for reviewer |
| requested_by_actor_type | approval_requestor_actor_enum | yes | Usually system |
| requested_by_actor_id | text | yes | System worker or human |
| requested_at | timestamptz | yes | Creation time |
| review_due_at | timestamptz | no | SLA deadline |
| decided_by_actor_type | approval_decider_actor_enum | no | Human actor type |
| decided_by_actor_id | text | no | Approver/rejector |
| decided_at | timestamptz | no | Decision time |
| decision_note | text | no | Approver note |
| expires_at | timestamptz | no | Optional timeout |
| created_from_event_id | uuid | no | Trigger event |
| last_event_id | uuid | no | Most recent approval event |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**approval_scope_enum:** review_response, policy_rule, brand_voice_profile, config_change, tenant_action, publish_override, model_route_change

**approval_status_enum:** pending, approved, rejected, canceled, expired

**approval_requestor_actor_enum:** system, human_admin, customer_admin

**approval_decider_actor_enum:** human_admin, customer_admin

### State Transitions

| From | To | Trigger |
|------|-----|---------|
| pending | approved | Human approves |
| pending | rejected | Human rejects |
| pending | canceled | Request withdrawn/replaced |
| pending | expired | Timeout reached |

### Uniqueness Constraints
- partial unique: one pending approval per (scope_type, scope_id, requested_action)

### Key Indexes
- index on (tenant_id, status)
- index on (scope_type, scope_id)
- index on (requested_at desc)

### Events That Cause Writes
- approval.recorded → insert or update to approved/rejected
- human.override_applied → may close related approval or create one

---

## 8) automation_controls

### Purpose

Current operational switch state for kill switches and explicit automation toggles.

**Authoritative for:** Global/tenant operational switches, whether certain automated paths are enabled right now.

**Not authoritative for:** Numeric thresholds, risk policy logic, memory or inferred behavior, audit history of changes beyond current value.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| scope_type | automation_control_scope_enum | yes | Global or tenant |
| scope_id | uuid | no | Null for global |
| control_key | automation_control_key_enum | yes | Which switch |
| control_value | boolean | yes | Current on/off state |
| reason | text | no | Why this value was set |
| set_by_actor_type | automation_control_actor_enum | yes | Human only |
| set_by_actor_id | text | yes | Who changed it |
| effective_at | timestamptz | yes | When current value took effect |
| expires_at | timestamptz | no | Optional temporary override |
| created_from_event_id | uuid | no | First event |
| last_event_id | uuid | no | Last change event |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**automation_control_scope_enum:** global, tenant

**automation_control_key_enum:** global_publish_enabled, tenant_publish_enabled, response_generation_enabled, draft_only_mode, incident_mode, gateway_healthy_required

**automation_control_actor_enum:** human_admin, customer_admin

### Scope Rules
- global_publish_enabled → global only
- response_generation_enabled → global only
- draft_only_mode → global only
- incident_mode → global only
- gateway_healthy_required → global only
- tenant_publish_enabled → tenant only

Enforce in application code or with check constraints/triggers.

### State Transitions

This table does not have a lifecycle enum. The valid transition is simply boolean flip: true → false, false → true. Triggered only by human/admin action. System may react to controls, but may not write them.

### Uniqueness Constraints
- unique (scope_type, scope_id, control_key)

### Key Indexes
- index on (scope_type, scope_id)
- index on (control_key, control_value)

### Events That Cause Writes
- settings.updated for generic control changes
- automation.paused / automation.resumed for publish/automation-related switches

### Source-of-Truth Note

This table answers: "Is this path currently allowed to run?" It does not answer: "What threshold should classify a review?" That belongs in system_config.

---

## 9) system_config

### Purpose

Current source of truth for thresholds, tunables, and runtime parameters.

**Authoritative for:** Injection thresholds, classification threshold, gateway minimum health threshold, receipt timeout, other numeric/text tunables.

**Not authoritative for:** Kill switches, approval decisions, policy definitions, secrets or provider credentials.

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | yes | PK |
| scope_type | system_config_scope_enum | yes | Slice 1 uses global only |
| scope_id | uuid | no | Null for global |
| config_key | system_config_key_enum | yes | Which tunable |
| value_type | system_config_value_type_enum | yes | Type discriminator |
| numeric_value | numeric(12,6) | no | For decimals |
| integer_value | integer | no | For integers |
| boolean_value | boolean | no | For booleans if needed |
| text_value | text | no | For text values |
| json_value | jsonb | no | For complex config |
| units | text | no | Example: seconds, hours |
| description | text | no | Human-readable meaning |
| set_by_actor_id | text | yes | Human admin |
| effective_at | timestamptz | yes | When current value takes effect |
| created_from_event_id | uuid | no | Event that created row |
| last_event_id | uuid | no | Last change event |
| created_at | timestamptz | yes | Default now() |
| updated_at | timestamptz | yes | Updated on write |

### Enums

**system_config_scope_enum:** global, tenant

**system_config_value_type_enum:** numeric, integer, boolean, text, json

**system_config_key_enum:** INJECTION_BLOCK_THRESHOLD, INJECTION_AMBIGUOUS_LOW, INJECTION_AMBIGUOUS_HIGH, REVIEW_CLASSIFICATION_AUTOPUBLISH_THRESHOLD, RESPONSE_GENERATION_SCHEMA_RETRY_LIMIT, GATEWAY_HEALTH_MIN_SCORE, OPERATOR_CONFIDENCE_DRAFT_ONLY_THRESHOLD, OPERATOR_CONFIDENCE_PAUSE_THRESHOLD, PUBLISH_RECEIPT_TIMEOUT_SECONDS, DUPLICATE_PUBLISH_LOOKBACK_HOURS

### Validation Rule

Exactly one of numeric_value, integer_value, boolean_value, text_value, json_value should be populated according to value_type.

### Uniqueness Constraints
- unique (scope_type, scope_id, config_key)

### Key Indexes
- index on (config_key)
- index on (scope_type, scope_id)

### Events That Cause Writes
- settings.updated

### Source-of-Truth Note

This table answers: "What numbers/parameters govern runtime behavior?" It does not answer: "Is the system currently paused?" That belongs in automation_controls.

---

## Cross-Table Relationship Summary

### Core Foreign-Key Relationships
- oauth_connections.tenant_id → tenants.id
- brand_voice_profiles.tenant_id → tenants.id
- reviews.tenant_id → tenants.id
- reviews.oauth_connection_id → oauth_connections.id
- responses.tenant_id → tenants.id
- responses.review_id → reviews.id
- responses.brand_voice_profile_id → brand_voice_profiles.id
- tenants.approved_brand_voice_profile_id → brand_voice_profiles.id
- tenants.current_oauth_connection_id → oauth_connections.id
- responses.approval_id → approvals.id

### Cross-Table Invariants
- A tenant may have many OAuth rows historically, but only one current active row should be referenced by tenants.current_oauth_connection_id.
- A tenant may have many brand voice profiles, but only one live profile should be referenced by tenants.approved_brand_voice_profile_id.
- A review may have many response versions, but reviews.current_response_id points to the currently operative response.
- automation_controls and system_config must never be merged.

---

## Final Implementation Notes

1. **Do not store raw OAuth tokens in Postgres.** Store only encrypted/vault references in oauth_connections.
2. **Do not store raw webhook payloads in reviews.** Put raw payloads in events/artifact storage. Keep normalized fields only.
3. **Do not put policy JSON into system_config.** Rules belong in policy_rules. Thresholds belong in system_config.
4. **Do not let responses become an audit log.** One row per response version. Event ledger carries the full timeline.
5. **Do not let tenants.status become a dumping ground.** Use paused_reason and events for explanation. Keep status enum tight.
6. **For Slice 1, keep scope simple.** Even though some tables support tenant scope, start with one pilot tenant, global config, global controls plus one tenant publish override.
