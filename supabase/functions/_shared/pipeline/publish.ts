/**
 * Pipeline Stage 7: Publish Gate + Publish Execution
 *
 * Final deterministic check before any public side effect. No LLM call.
 * Every safe_review_v1 condition is re-verified in code. Kill switches
 * are enforced. Duplicate publish is prevented.
 *
 * Spec alignment:
 *   - Section 2: Slice 1B flow steps 11-15
 *   - Section 6.3 Stage 7: Publish gate (deterministic)
 *   - Section 8.4: safe_review_v1 canonical definition
 *   - Section 8.5: Minimum policy rules (rule 1-6)
 *   - Data model Section 8: automation_controls (kill switches)
 *   - Data model Section 9: system_config (thresholds)
 *
 * Events emitted:
 *   - response.publish_attempted (BEFORE the API call)
 *   - response.published (on success)
 *   - response.publish_failed (on failure)
 */

import { getSupabaseClient } from "../supabase-client.ts";
import { emitEvent } from "../events/emit.ts";
import { EVENT_TYPES } from "../events/types.ts";
import {
  publishReplyToGBP,
  type GBPPublishResult,
} from "./gbp-publisher.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewForPublish {
  id: string;
  tenant_id: string;
  review_text: string | null;
  star_rating: number;
  reviewer_display_name: string | null;
  status: string;
  source_review_id: string;
  injection_status: string;
  injection_confidence: number | null;
  safe_for_downstream_generation: boolean;
  is_safe_review_v1_candidate: boolean;
  safe_review_confidence: number;
  question_detected: boolean;
  complaint_detected: boolean;
  contact_request_detected: boolean;
  wrong_business_or_spam_detected: boolean;
  block_reason_codes: string[] | null;
  autopublish_eligible: boolean;
  current_response_id: string | null;
  oauth_connection_id: string | null;
  last_event_id: string | null;
}

interface ResponseForPublish {
  id: string;
  tenant_id: string;
  review_id: string;
  response_version: number;
  status: string;
  draft_text: string;
  generation_mode: string;
  publish_attempt_count: number;
  published_at: string | null;
  last_event_id: string | null;
}

interface GateCheckResult {
  passed: boolean;
  failures: string[];
}

export interface PublishStageResult {
  success: boolean;
  review_id: string;
  response_id: string | null;
  gate_passed: boolean;
  gate_failures: string[];
  publish_result: GBPPublishResult | null;
  receipt_id: string | null;
  attempted_event_id: string | null;
  outcome_event_id: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runPublish(
  reviewId: string,
  correlationId?: string,
): Promise<PublishStageResult> {
  const db = getSupabaseClient();
  const corrId = correlationId ?? crypto.randomUUID();

  const fail = (error: string, partial?: Partial<PublishStageResult>): PublishStageResult => ({
    success: false,
    review_id: reviewId,
    response_id: null,
    gate_passed: false,
    gate_failures: [],
    publish_result: null,
    receipt_id: null,
    attempted_event_id: null,
    outcome_event_id: null,
    error,
    ...partial,
  });

  // ── 1. Load the review ──────────────────────────────────────────────

  const { data: review, error: loadError } = await db
    .from("reviews")
    .select(
      `id, tenant_id, review_text, star_rating, reviewer_display_name,
       status, source_review_id, injection_status, injection_confidence,
       safe_for_downstream_generation, is_safe_review_v1_candidate,
       safe_review_confidence, question_detected, complaint_detected,
       contact_request_detected, wrong_business_or_spam_detected,
       block_reason_codes, autopublish_eligible, current_response_id,
       oauth_connection_id, last_event_id`,
    )
    .eq("id", reviewId)
    .single();

  if (loadError || !review) {
    return fail(`Review not found: ${loadError?.message ?? "no data"}`);
  }

  const r = review as ReviewForPublish;

  // ── 2. Load the current response ────────────────────────────────────

  if (!r.current_response_id) {
    return fail("No current response on this review");
  }

  const { data: response, error: respError } = await db
    .from("responses")
    .select(
      `id, tenant_id, review_id, response_version, status, draft_text,
       generation_mode, publish_attempt_count, published_at, last_event_id`,
    )
    .eq("id", r.current_response_id)
    .single();

  if (respError || !response) {
    return fail(`Response not found: ${respError?.message ?? "no data"}`);
  }

  const resp = response as ResponseForPublish;

  // ── 3. Run the deterministic publish gate ───────────────────────────

  const gateResult = await runPublishGate(r, resp);

  if (!gateResult.passed) {
    return fail(`Publish gate failed: ${gateResult.failures.join("; ")}`, {
      response_id: resp.id,
      gate_passed: false,
      gate_failures: gateResult.failures,
    });
  }

  // ── 4. Load OAuth connection for the API call ───────────────────────

  const { data: oauth, error: oauthError } = await db
    .from("oauth_connections")
    .select("id, external_account_id, external_location_id, access_token_ref, status")
    .eq("id", r.oauth_connection_id)
    .single();

  if (oauthError || !oauth) {
    return fail(`OAuth connection not found: ${oauthError?.message ?? "no data"}`, {
      response_id: resp.id,
      gate_passed: true,
      gate_failures: [],
    });
  }

  if (oauth.status !== "connected") {
    return fail(`OAuth connection not active (status: ${oauth.status})`, {
      response_id: resp.id,
      gate_passed: true,
      gate_failures: [],
    });
  }

  // ── 5. Write response.publish_attempted event BEFORE the API call ──

  const attemptedEvent = await emitEvent({
    event_type: EVENT_TYPES.RESPONSE_PUBLISH_ATTEMPTED,
    tenant_id: r.tenant_id,
    source_channel: "google_gbp",
    source_system: "rightreply_pipeline",
    actor_type: "system",
    actor_id: "publish_gate",
    generation_class: "system_generated",
    authority_rank: 80,
    is_authoritative: true,
    object_type: "response",
    object_id: resp.id,
    correlation_id: corrId,
    causation_event_id: resp.last_event_id ?? undefined,
    idempotency_key: `response.publish_attempted:${resp.id}:attempt${resp.publish_attempt_count + 1}`,
    status: "attempted",
    risk_flags: [],
    privacy_level: "customer_confidential",
    payload: {
      summary: `Publish attempt ${resp.publish_attempt_count + 1} for response v${resp.response_version}`,
      facts: {
        response_version: resp.response_version,
        attempt_number: resp.publish_attempt_count + 1,
        generation_mode: resp.generation_mode,
        gate_checks_passed: gateResult.failures.length === 0,
      },
      refs: {
        review_id: reviewId,
        response_id: resp.id,
        oauth_connection_id: oauth.id,
      },
    },
  });

  if (!attemptedEvent.success) {
    return fail(`Ledger write failed for publish_attempted: ${attemptedEvent.error}`, {
      response_id: resp.id,
      gate_passed: true,
      gate_failures: [],
    });
  }

  // ── 6. Update response to publish_attempted ─────────────────────────

  const now = new Date().toISOString();

  await db
    .from("responses")
    .update({
      status: "publish_attempted",
      publish_attempt_count: resp.publish_attempt_count + 1,
      last_publish_attempted_at: now,
      final_text: resp.draft_text,
      last_event_id: attemptedEvent.event_id,
      updated_at: now,
    })
    .eq("id", resp.id);

  // ── 7. Call the GBP publisher ───────────────────────────────────────

  const publishResult = await publishReplyToGBP({
    account_id: oauth.external_account_id,
    location_id: oauth.external_location_id,
    review_id: r.source_review_id,
    comment: resp.draft_text,
    access_token: oauth.access_token_ref,
  });

  // ── 8. Handle success or failure ────────────────────────────────────

  if (publishResult.success) {
    return await handlePublishSuccess(
      r, resp, publishResult, attemptedEvent.event_id!, corrId,
    );
  } else {
    return await handlePublishFailure(
      r, resp, publishResult, attemptedEvent.event_id!, corrId,
    );
  }
}

// ---------------------------------------------------------------------------
// Publish gate — all deterministic, no LLM
// ---------------------------------------------------------------------------

async function runPublishGate(
  review: ReviewForPublish,
  response: ResponseForPublish,
): Promise<GateCheckResult> {
  const failures: string[] = [];
  const db = getSupabaseClient();

  // ── safe_review_v1 checks (Section 8.4) ──

  if (review.star_rating !== 5) {
    failures.push(`star_rating is ${review.star_rating}, must be 5`);
  }

  if (!review.review_text || review.review_text.trim().length === 0) {
    failures.push("review_text is empty");
  }

  if (review.question_detected) {
    failures.push("question_detected = true");
  }

  if (review.complaint_detected) {
    failures.push("complaint_detected = true");
  }

  if (review.contact_request_detected) {
    failures.push("contact_request_detected = true");
  }

  if (review.wrong_business_or_spam_detected) {
    failures.push("wrong_business_or_spam_detected = true");
  }

  if (review.injection_status === "detected") {
    failures.push(`injection detected (status: ${review.injection_status})`);
  }

  if (!review.safe_for_downstream_generation) {
    failures.push("safe_for_downstream_generation = false");
  }

  if (!review.is_safe_review_v1_candidate) {
    failures.push("is_safe_review_v1_candidate = false");
  }

  if (!review.autopublish_eligible) {
    failures.push("autopublish_eligible = false");
  }

  if (review.block_reason_codes && review.block_reason_codes.length > 0) {
    failures.push(`block_reason_codes: [${review.block_reason_codes.join(", ")}]`);
  }

  // ── Confidence threshold check ──

  const { data: thresholdRow } = await db
    .from("system_config")
    .select("numeric_value")
    .eq("config_key", "REVIEW_CLASSIFICATION_AUTOPUBLISH_THRESHOLD")
    .eq("scope_type", "global")
    .maybeSingle();

  const threshold = thresholdRow?.numeric_value ?? 0.95;

  if ((review.safe_review_confidence ?? 0) < threshold) {
    failures.push(
      `safe_review_confidence ${review.safe_review_confidence} < threshold ${threshold}`,
    );
  }

  // ── Response state checks ──

  if (response.status !== "draft_generated" && response.status !== "approved") {
    failures.push(`response status is '${response.status}', must be 'draft_generated' or 'approved'`);
  }

  if (!response.draft_text || response.draft_text.trim().length === 0) {
    failures.push("response draft_text is empty");
  }

  // ── Kill switch enforcement (automation_controls) ──

  const { data: controls } = await db
    .from("automation_controls")
    .select("control_key, control_value, scope_type, scope_id")
    .or(
      `and(scope_type.eq.global,scope_id.is.null),` +
      `and(scope_type.eq.tenant,scope_id.eq.${review.tenant_id})`,
    );

  const controlMap = new Map<string, boolean>();
  if (controls) {
    for (const c of controls) {
      controlMap.set(c.control_key, c.control_value);
    }
  }

  // global_publish_enabled must be true
  if (controlMap.get("global_publish_enabled") === false) {
    failures.push("KILL SWITCH: global_publish_enabled = false");
  }

  // tenant_publish_enabled must be true
  if (controlMap.get("tenant_publish_enabled") === false) {
    failures.push("KILL SWITCH: tenant_publish_enabled = false");
  }

  // draft_only_mode must be false
  if (controlMap.get("draft_only_mode") === true) {
    failures.push("KILL SWITCH: draft_only_mode = true (Slice 1A mode still active)");
  }

  // incident_mode must be false
  if (controlMap.get("incident_mode") === true) {
    failures.push("KILL SWITCH: incident_mode = true (incident in progress)");
  }

  // ── Tenant active check ──

  const { data: tenant } = await db
    .from("tenants")
    .select("status, approved_brand_voice_profile_id, current_oauth_connection_id")
    .eq("id", review.tenant_id)
    .single();

  if (!tenant || tenant.status !== "active") {
    failures.push(`tenant status is '${tenant?.status ?? "not found"}', must be 'active'`);
  }

  if (!tenant?.approved_brand_voice_profile_id) {
    failures.push("no approved brand voice profile");
  }

  if (!tenant?.current_oauth_connection_id) {
    failures.push("no active OAuth connection");
  }

  // ── Duplicate publish prevention ──

  const { data: existingPublished } = await db
    .from("responses")
    .select("id, published_at")
    .eq("review_id", review.id)
    .eq("status", "published")
    .limit(1);

  if (existingPublished && existingPublished.length > 0) {
    failures.push(
      `DUPLICATE: response ${existingPublished[0].id} already published at ${existingPublished[0].published_at}`,
    );
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Success handler
// ---------------------------------------------------------------------------

async function handlePublishSuccess(
  review: ReviewForPublish,
  response: ResponseForPublish,
  publishResult: GBPPublishResult,
  attemptedEventId: string,
  correlationId: string,
): Promise<PublishStageResult> {
  const db = getSupabaseClient();
  const now = new Date().toISOString();

  // Write response.published event
  const publishedEvent = await emitEvent({
    event_type: EVENT_TYPES.RESPONSE_PUBLISHED,
    tenant_id: review.tenant_id,
    source_channel: "google_gbp",
    source_system: "rightreply_pipeline",
    actor_type: "system",
    actor_id: "gbp_publisher",
    generation_class: "system_generated",
    authority_rank: 90,
    is_authoritative: true,
    object_type: "response",
    object_id: response.id,
    correlation_id: correlationId,
    causation_event_id: attemptedEventId,
    idempotency_key: `response.published:${response.id}`,
    status: "succeeded",
    risk_flags: [],
    privacy_level: "customer_confidential",
    payload: {
      summary: `Response v${response.response_version} published to GBP${publishResult.is_mock ? " (MOCK)" : ""}`,
      facts: {
        response_version: response.response_version,
        http_status: publishResult.http_status,
        provider_response_id: publishResult.provider_response_id,
        is_mock: publishResult.is_mock,
      },
      refs: {
        review_id: review.id,
        response_id: response.id,
        source_review_id: review.source_review_id,
      },
      outcome: {
        published_at: now,
        reply_update_time: publishResult.reply?.updateTime,
      },
    },
  });

  if (!publishedEvent.success) {
    return {
      success: false,
      review_id: review.id,
      response_id: response.id,
      gate_passed: true,
      gate_failures: [],
      publish_result: publishResult,
      receipt_id: null,
      attempted_event_id: attemptedEventId,
      outcome_event_id: null,
      error: `Ledger write failed for published event: ${publishedEvent.error}`,
    };
  }

  // Store receipt in event_receipts
  const receiptPayload = {
    provider: "google_gbp",
    http_status: publishResult.http_status,
    provider_response_id: publishResult.provider_response_id,
    reply: publishResult.reply,
    is_mock: publishResult.is_mock,
    timestamp: now,
  };

  const receiptHash = await sha256(JSON.stringify(receiptPayload));

  const { data: receipt, error: receiptError } = await db
    .from("event_receipts")
    .insert({
      event_id: publishedEvent.event_id,
      receipt_type: "gbp_publish_reply",
      receipt_payload: receiptPayload,
      receipt_hash_sha256: receiptHash,
      recorded_at: now,
    })
    .select("id")
    .single();

  if (receiptError) {
    console.error("Receipt insert failed:", receiptError.message);
  }

  // Update response to published
  await db
    .from("responses")
    .update({
      status: "published",
      published_at: now,
      publish_provider_response_id: publishResult.provider_response_id,
      publish_receipt_id: receipt?.id ?? null,
      last_event_id: publishedEvent.event_id,
      updated_at: now,
    })
    .eq("id", response.id);

  // Update review status
  await db
    .from("reviews")
    .update({
      status: "published",
      last_event_id: publishedEvent.event_id,
      last_processed_at: now,
      updated_at: now,
    })
    .eq("id", review.id);

  return {
    success: true,
    review_id: review.id,
    response_id: response.id,
    gate_passed: true,
    gate_failures: [],
    publish_result: publishResult,
    receipt_id: receipt?.id ?? null,
    attempted_event_id: attemptedEventId,
    outcome_event_id: publishedEvent.event_id,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Failure handler
// ---------------------------------------------------------------------------

async function handlePublishFailure(
  review: ReviewForPublish,
  response: ResponseForPublish,
  publishResult: GBPPublishResult,
  attemptedEventId: string,
  correlationId: string,
): Promise<PublishStageResult> {
  const db = getSupabaseClient();
  const now = new Date().toISOString();

  // Write response.publish_failed event
  const failedEvent = await emitEvent({
    event_type: EVENT_TYPES.RESPONSE_PUBLISH_FAILED,
    tenant_id: review.tenant_id,
    source_channel: "google_gbp",
    source_system: "rightreply_pipeline",
    actor_type: "system",
    actor_id: "gbp_publisher",
    generation_class: "system_generated",
    authority_rank: 90,
    is_authoritative: true,
    object_type: "response",
    object_id: response.id,
    correlation_id: correlationId,
    causation_event_id: attemptedEventId,
    idempotency_key: `response.publish_failed:${response.id}:attempt${response.publish_attempt_count + 1}`,
    status: "failed",
    risk_flags: ["publish_failure"],
    privacy_level: "customer_confidential",
    payload: {
      summary: `Publish attempt ${response.publish_attempt_count + 1} failed: ${publishResult.error_code ?? "unknown"}`,
      facts: {
        response_version: response.response_version,
        http_status: publishResult.http_status,
        error_code: publishResult.error_code,
        error_message: publishResult.error_message,
        is_mock: publishResult.is_mock,
      },
      refs: {
        review_id: review.id,
        response_id: response.id,
        source_review_id: review.source_review_id,
      },
    },
  });

  // Update response to publish_failed
  await db
    .from("responses")
    .update({
      status: "publish_failed",
      publish_failure_code: publishResult.error_code,
      publish_failure_message: publishResult.error_message,
      last_event_id: failedEvent.event_id,
      updated_at: now,
    })
    .eq("id", response.id);

  return {
    success: false,
    review_id: review.id,
    response_id: response.id,
    gate_passed: true,
    gate_failures: [],
    publish_result: publishResult,
    receipt_id: null,
    attempted_event_id: attemptedEventId,
    outcome_event_id: failedEvent.event_id,
    error: `GBP publish failed: ${publishResult.error_code} — ${publishResult.error_message}`,
  };
}

// ---------------------------------------------------------------------------
// Helper: SHA-256 hash
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
