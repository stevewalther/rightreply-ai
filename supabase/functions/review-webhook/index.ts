/**
 * review-webhook — Slice 1A entry point.
 *
 * Receives a Google Business Profile review webhook, validates it,
 * resolves the tenant, writes a review.received event to the immutable
 * ledger, and inserts a row into the reviews table.
 *
 * This is draft/shadow only — nothing publishes. The review starts at
 * status "received" and waits for downstream pipeline stages (injection
 * detection, classification, policy gate, generation).
 *
 * Spec alignment:
 *   - Build reference Section 8.1: Slice 1A flow steps 1-4
 *   - Data model Section 4: reviews table schema
 *   - Build reference Section 5.1: events are append-only, idempotency keys
 *   - Build reference Section 5.7: if ledger write fails, no downstream
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase-client.ts";
import { emitEvent } from "../_shared/events/emit.ts";
import { EVENT_TYPES } from "../_shared/events/types.ts";
import {
  GbpReviewWebhookSchema,
  normalizeGbpReview,
} from "../_shared/validation/schemas.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Tenant resolution
//
// Looks up the tenant by matching the Google location ID to an active
// OAuth connection. Returns the tenant row and oauth_connection row.
//
// Spec: only tenants with status in (trial_active, active) and OAuth
// status = connected are eligible to receive reviews.
// ---------------------------------------------------------------------------

interface TenantResolution {
  tenant_id: string;
  tenant_status: string;
  oauth_connection_id: string;
}

async function resolveTenant(
  locationId: string,
): Promise<{ data: TenantResolution | null; error: string | null }> {
  const db = getSupabaseClient();

  // Find the OAuth connection for this Google location
  const { data: oauth, error: oauthError } = await db
    .from("oauth_connections")
    .select("id, tenant_id, status")
    .eq("provider", "google_business_profile")
    .eq("external_location_id", locationId)
    .eq("status", "connected")
    .maybeSingle();

  if (oauthError) {
    return { data: null, error: `OAuth lookup failed: ${oauthError.message}` };
  }
  if (!oauth) {
    return { data: null, error: `No active OAuth connection for location: ${locationId}` };
  }

  // Verify the tenant is in an eligible state
  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("id, status")
    .eq("id", oauth.tenant_id)
    .in("status", ["trial_active", "active"])
    .maybeSingle();

  if (tenantError) {
    return { data: null, error: `Tenant lookup failed: ${tenantError.message}` };
  }
  if (!tenant) {
    return {
      data: null,
      error: `Tenant ${oauth.tenant_id} is not in an eligible state for review ingestion`,
    };
  }

  return {
    data: {
      tenant_id: tenant.id,
      tenant_status: tenant.status,
      oauth_connection_id: oauth.id,
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Duplicate check
//
// Spec: unique constraint on (tenant_id, source_channel, source_review_id)
// We check explicitly so we can return a clear idempotent response rather
// than relying on a DB constraint error.
// ---------------------------------------------------------------------------

async function checkDuplicate(
  tenantId: string,
  sourceReviewId: string,
): Promise<{ isDuplicate: boolean; existingReviewId: string | null }> {
  const db = getSupabaseClient();

  const { data } = await db
    .from("reviews")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("source_channel", "google_gbp")
    .eq("source_review_id", sourceReviewId)
    .maybeSingle();

  return {
    isDuplicate: !!data,
    existingReviewId: data?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req: Request): Promise<Response> => {
  // Only accept POST
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  // ── Step 1: Parse and validate the webhook payload ──────────────────

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const parseResult = GbpReviewWebhookSchema.safeParse(rawBody);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    return errorResponse(`Validation failed: ${issues.join("; ")}`, 400);
  }

  const normalized = normalizeGbpReview(parseResult.data);

  // ── Step 2: Resolve tenant from Google location ID ──────────────────

  const { data: tenant, error: tenantError } = await resolveTenant(
    normalized.source_location_id,
  );

  if (tenantError || !tenant) {
    // Log but don't expose internal details
    console.error("Tenant resolution failed:", tenantError);
    return errorResponse("Unable to resolve tenant for this location", 422);
  }

  // ── Step 3: Duplicate check ─────────────────────────────────────────

  const { isDuplicate, existingReviewId } = await checkDuplicate(
    tenant.tenant_id,
    normalized.source_review_id,
  );

  if (isDuplicate) {
    return jsonResponse({
      status: "duplicate",
      message: "Review already ingested",
      review_id: existingReviewId,
      duplicate: true,
    });
  }

  // ── Step 4: Write review.received event to ledger ───────────────────
  //
  // Spec (Section 5.7 rule 3): If ledger write fails, no downstream.
  // The idempotency key is tenant_id + source_review_id — if the same
  // review arrives twice, the event is deduplicated.

  const correlationId = crypto.randomUUID();
  const idempotencyKey = `review.received:${tenant.tenant_id}:${normalized.source_review_id}`;

  const eventResult = await emitEvent({
    event_type: EVENT_TYPES.REVIEW_RECEIVED,
    tenant_id: tenant.tenant_id,
    occurred_at: normalized.source_review_published_at,
    source_channel: "google_gbp",
    source_system: "google_business_profile",
    source_message_id: normalized.source_message_id,
    actor_type: "end_customer",
    actor_id: null,
    actor_display_name: normalized.reviewer_display_name,
    generation_class: "external_observed",
    authority_rank: 90, // System-of-record (Google is the source)
    is_authoritative: true,
    object_type: "review",
    object_id: normalized.source_review_id,
    subject_entity_id: null,
    correlation_id: correlationId,
    causation_event_id: null, // First event in chain
    idempotency_key: idempotencyKey,
    status: "succeeded",
    risk_flags: [],
    privacy_level: "customer_confidential",
    payload: {
      summary: `Review received: ${normalized.star_rating} stars from ${normalized.reviewer_display_name ?? "anonymous"} for location ${normalized.source_location_id}`,
      facts: {
        star_rating: normalized.star_rating,
        review_text: normalized.review_text,
        review_language: normalized.review_language,
        reviewer_display_name: normalized.reviewer_display_name,
        reviewer_is_anonymous: normalized.reviewer_is_anonymous,
        source_review_published_at: normalized.source_review_published_at,
      },
      refs: {
        source_review_id: normalized.source_review_id,
        source_location_id: normalized.source_location_id,
        tenant_id: tenant.tenant_id,
        oauth_connection_id: tenant.oauth_connection_id,
      },
    },
    raw_blob_ref: null,  // TODO: store raw webhook body in artifact storage
    raw_blob_hash_sha256: null,
  });

  if (!eventResult.success) {
    console.error("Ledger write failed:", eventResult.error);
    return errorResponse("Internal error: unable to record event", 500);
  }

  // If the event was a duplicate (idempotency key), the review may
  // already exist — check again before inserting.
  if (eventResult.duplicate) {
    const recheck = await checkDuplicate(
      tenant.tenant_id,
      normalized.source_review_id,
    );
    if (recheck.isDuplicate) {
      return jsonResponse({
        status: "duplicate",
        message: "Review already ingested (event deduplicated)",
        review_id: recheck.existingReviewId,
        event_id: eventResult.event_id,
        duplicate: true,
      });
    }
  }

  // ── Step 5: Insert into reviews table ───────────────────────────────
  //
  // Spec: status starts at "received", all classifier fields at defaults.
  // Raw webhook body is NOT stored here (data model rule 3).

  const reviewId = crypto.randomUUID();
  const now = new Date().toISOString();

  const db = getSupabaseClient();

  const { error: insertError } = await db.from("reviews").insert({
    id: reviewId,
    tenant_id: tenant.tenant_id,
    oauth_connection_id: tenant.oauth_connection_id,
    source_channel: "google_gbp",
    source_review_id: normalized.source_review_id,
    source_location_id: normalized.source_location_id,
    reviewer_display_name: normalized.reviewer_display_name,
    reviewer_is_anonymous: normalized.reviewer_is_anonymous,
    star_rating: normalized.star_rating,
    review_text: normalized.review_text,
    review_language: normalized.review_language,
    source_review_published_at: normalized.source_review_published_at,
    ingested_at: now,
    status: "received",
    source_review_status: "active",
    current_response_id: null,
    duplicate_of_review_id: null,
    processing_attempt_count: 0,
    last_processed_at: null,
    // Injection fields — not yet run
    injection_status: "not_run",
    injection_confidence: null,
    injection_pattern_codes: null,
    obfuscation_detected: false,
    safe_for_downstream_generation: null,
    // Classification fields — not yet run
    content_safety_flags: null,
    customer_intent: null,
    recommended_risk_tier: null,
    is_safe_review_v1_candidate: null,
    safe_review_confidence: null,
    question_detected: false,
    complaint_detected: false,
    contact_request_detected: false,
    wrong_business_or_spam_detected: false,
    block_reason_codes: null,
    // Pipeline flags — not yet determined
    needs_human_review: false,
    autopublish_eligible: false,
    // Traceability
    injection_llm_call_id: null,
    classification_llm_call_id: null,
    created_from_event_id: eventResult.event_id,
    last_event_id: eventResult.event_id,
    created_at: now,
    updated_at: now,
  });

  if (insertError) {
    // If it's a unique constraint violation, treat as duplicate
    if (insertError.code === "23505") {
      return jsonResponse({
        status: "duplicate",
        message: "Review already exists (race condition resolved)",
        duplicate: true,
      });
    }

    console.error("Review insert failed:", insertError);
    return errorResponse("Internal error: unable to save review", 500);
  }

  // ── Step 6: Success response ────────────────────────────────────────

  return jsonResponse({
    status: "received",
    message: "Review ingested successfully",
    review_id: reviewId,
    event_id: eventResult.event_id,
    correlation_id: correlationId,
    tenant_id: tenant.tenant_id,
    duplicate: false,
  });
});
