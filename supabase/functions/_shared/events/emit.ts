/**
 * Event ledger writer — the single path for writing to the immutable events table.
 *
 * Design rules (from build reference Section 5.1):
 *   1. Events are append-only. No update. No delete.
 *   2. Every event has an idempotency_key to prevent duplicates.
 *   3. Every event has a payload_hash_sha256 and event_hash_sha256.
 *   4. If the ledger write fails, downstream side effects must not proceed.
 */

import { getSupabaseClient } from "../supabase-client.ts";
import {
  type ActorType,
  type ArchiveTier,
  type EventPayload,
  type EventRecord,
  type EventType,
  type GenerationClass,
  type PrivacyLevel,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helper: deterministic SHA-256 hash (works in Deno / Edge Functions)
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Input shape for emitting an event
// ---------------------------------------------------------------------------

export interface EmitEventInput {
  event_type: EventType;
  event_version?: number;
  tenant_id?: string | null;
  occurred_at?: string; // ISO timestamp, defaults to now
  source_channel: string;
  source_system: string;
  source_message_id?: string | null;
  actor_type: ActorType;
  actor_id?: string | null;
  actor_display_name?: string | null;
  generation_class: GenerationClass;
  authority_rank: number;
  is_authoritative: boolean;
  object_type: string;
  object_id: string;
  subject_entity_id?: string | null;
  correlation_id?: string | null;
  causation_event_id?: string | null;
  idempotency_key: string; // Required — no silent duplicates
  status?: string | null;
  risk_flags?: string[];
  privacy_level: PrivacyLevel;
  payload: EventPayload;
  payload_schema_version?: number;
  raw_blob_ref?: string | null;
  raw_blob_hash_sha256?: string | null;
  archive_tier?: ArchiveTier;
  legal_hold?: boolean;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface EmitEventResult {
  success: boolean;
  event_id: string | null;
  error: string | null;
  /** True when the event already existed (idempotency key collision). */
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Core emit function
// ---------------------------------------------------------------------------

export async function emitEvent(input: EmitEventInput): Promise<EmitEventResult> {
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();

  // Canonical JSON for hashing — sort keys for determinism
  const canonicalPayload = JSON.stringify(input.payload, Object.keys(input.payload).sort());
  const payloadHash = await sha256(canonicalPayload);

  // Build the full record for event-level hash
  const hashSource = JSON.stringify({
    id: eventId,
    event_type: input.event_type,
    tenant_id: input.tenant_id ?? null,
    occurred_at: input.occurred_at ?? now,
    object_type: input.object_type,
    object_id: input.object_id,
    idempotency_key: input.idempotency_key,
    payload_hash: payloadHash,
  });
  const eventHash = await sha256(hashSource);

  const row: Omit<EventRecord, "ingestion_sequence"> = {
    id: eventId,
    event_type: input.event_type,
    event_version: input.event_version ?? 1,
    domain_key: "rightreply",
    tenant_id: input.tenant_id ?? null,
    occurred_at: input.occurred_at ?? now,
    recorded_at: now,
    source_channel: input.source_channel,
    source_system: input.source_system,
    source_message_id: input.source_message_id ?? null,
    actor_type: input.actor_type,
    actor_id: input.actor_id ?? null,
    actor_display_name: input.actor_display_name ?? null,
    generation_class: input.generation_class,
    authority_rank: input.authority_rank,
    is_authoritative: input.is_authoritative,
    object_type: input.object_type,
    object_id: input.object_id,
    subject_entity_id: input.subject_entity_id ?? null,
    correlation_id: input.correlation_id ?? null,
    causation_event_id: input.causation_event_id ?? null,
    idempotency_key: input.idempotency_key,
    status: input.status ?? "succeeded",
    risk_flags: input.risk_flags ?? [],
    privacy_level: input.privacy_level,
    payload: input.payload,
    payload_schema_version: input.payload_schema_version ?? 1,
    payload_hash_sha256: payloadHash,
    raw_blob_ref: input.raw_blob_ref ?? null,
    raw_blob_hash_sha256: input.raw_blob_hash_sha256 ?? null,
    event_hash_sha256: eventHash,
    archive_tier: input.archive_tier ?? "hot",
    archived_at: null,
    archive_pointer: null,
    legal_hold: input.legal_hold ?? false,
    notes: input.notes ?? null,
  };

  const db = getSupabaseClient();

  const { data, error } = await db.from("events").insert(row).select("id").single();

  // Handle idempotency key collision (unique constraint violation)
  if (error) {
    const isDuplicate =
      error.code === "23505" && error.message?.includes("idempotency_key");

    if (isDuplicate) {
      // Not an error — the event already exists. Return the existing one.
      const { data: existing } = await db
        .from("events")
        .select("id")
        .eq("idempotency_key", input.idempotency_key)
        .single();

      return {
        success: true,
        event_id: existing?.id ?? null,
        error: null,
        duplicate: true,
      };
    }

    return {
      success: false,
      event_id: null,
      error: `Ledger write failed: ${error.message}`,
      duplicate: false,
    };
  }

  return {
    success: true,
    event_id: data?.id ?? eventId,
    error: null,
    duplicate: false,
  };
}
