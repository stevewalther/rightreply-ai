/**
 * Event type definitions for the immutable events ledger.
 *
 * Only the ~20 event types needed for Slice 1 are listed here.
 * Full taxonomy lives in the build reference (Section 5.2).
 * Add new types as slices expand — never remove or rename existing ones.
 */

// ---------------------------------------------------------------------------
// Event type enum — Slice 1 subset (Section 8.3)
// ---------------------------------------------------------------------------

export const EVENT_TYPES = {
  // Tenant / config
  TENANT_CREATED: "tenant.created",
  OAUTH_CONNECTED: "oauth.connected",
  OAUTH_REFRESH_FAILED: "oauth.refresh_failed",
  BRAND_VOICE_APPROVED: "brand_voice.approved",
  SETTINGS_UPDATED: "settings.updated",
  AUTOMATION_PAUSED: "automation.paused",
  AUTOMATION_RESUMED: "automation.resumed",

  // Review path
  REVIEW_RECEIVED: "review.received",
  REVIEW_DUPLICATE_DETECTED: "review.duplicate_detected",
  REVIEW_CLASSIFIED: "review.classified",
  REVIEW_POLICY_BLOCKED: "review.policy_blocked",
  ESCALATION_TRIGGERED: "escalation.triggered",
  RESPONSE_DRAFT_GENERATED: "response.draft_generated",
  RESPONSE_PUBLISH_ATTEMPTED: "response.publish_attempted",
  RESPONSE_PUBLISHED: "response.published",
  RESPONSE_PUBLISH_FAILED: "response.publish_failed",

  // Governance
  APPROVAL_RECORDED: "approval.recorded",
  HUMAN_OVERRIDE_APPLIED: "human.override_applied",

  // Eval / ops
  EVAL_RUN_COMPLETED: "eval.run_completed",
  EVAL_THRESHOLD_BREACHED: "eval.threshold_breached",
  MODEL_VERSION_CHANGED: "model.version_changed",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

// ---------------------------------------------------------------------------
// Enums matching the events table columns (from build reference Section 5.3)
// ---------------------------------------------------------------------------

export type ActorType =
  | "system"
  | "human_admin"
  | "customer_admin"
  | "end_customer"
  | "external_service"
  | "scheduler"
  | "model"
  | "unknown";

export type GenerationClass =
  | "external_observed"
  | "human_generated"
  | "system_generated"
  | "derived_system";

export type PrivacyLevel =
  | "public_business"
  | "internal_business"
  | "customer_confidential"
  | "billing_sensitive"
  | "operator_secret";

export type ArchiveTier = "hot" | "warm" | "cold";

// ---------------------------------------------------------------------------
// Payload envelope convention (Section 5.4)
// ---------------------------------------------------------------------------

export interface EventPayload {
  /** One-sentence human-readable summary of what happened */
  summary: string;
  /** Verifiable facts extracted from the source */
  facts: Record<string, unknown>;
  /** IDs / foreign keys / pointers to related objects */
  refs: Record<string, unknown>;
  /** Computed or derived fields (not raw source data) */
  derived?: Record<string, unknown>;
  /** Result / outcome of the action */
  outcome?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Full event record shape — matches the `events` table
// ---------------------------------------------------------------------------

export interface EventRecord {
  id: string;
  event_type: EventType;
  event_version: number;
  domain_key: string;
  tenant_id: string | null;
  occurred_at: string;
  recorded_at: string;
  source_channel: string;
  source_system: string;
  source_message_id: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  actor_display_name: string | null;
  generation_class: GenerationClass;
  authority_rank: number;
  is_authoritative: boolean;
  object_type: string;
  object_id: string;
  subject_entity_id: string | null;
  correlation_id: string | null;
  causation_event_id: string | null;
  idempotency_key: string | null;
  status: string | null;
  risk_flags: string[];
  privacy_level: PrivacyLevel;
  payload: EventPayload;
  payload_schema_version: number;
  payload_hash_sha256: string;
  raw_blob_ref: string | null;
  raw_blob_hash_sha256: string | null;
  event_hash_sha256: string;
  archive_tier: ArchiveTier;
  archived_at: string | null;
  archive_pointer: string | null;
  legal_hold: boolean;
  notes: string | null;
}
