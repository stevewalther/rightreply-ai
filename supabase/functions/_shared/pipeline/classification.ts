/**
 * Pipeline Stage 3/4: Review Classification
 *
 * Takes a review that has passed injection detection (safe_for_downstream_generation = true),
 * sends it through the LLM gateway for content classification, and updates the review
 * with results.
 *
 * Spec alignment:
 *   - Section 6.3 Stages 3-4: Content safety + customer intent classification
 *   - Section 8.4: Canonical Review Classifier Output Contract
 *   - Section 8.4: safe_review_v1 definition — ALL conditions must be true
 *   - Section 8.6: REVIEW_CLASSIFICATION_AUTOPUBLISH_THRESHOLD (0.95)
 *
 * Events emitted:
 *   - review.classified (with classification results in payload)
 *   - review.policy_blocked (if block_reason_codes not empty)
 *   - escalation.triggered (if needs human review)
 */

import { getSupabaseClient } from "../supabase-client.ts";
import { emitEvent } from "../events/emit.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { invokeGateway } from "../gateway/gateway.ts";
import type { ReviewClassificationOutput } from "../gateway/types.ts";

// ---------------------------------------------------------------------------
// Config loader — reads autopublish threshold from system_config
// ---------------------------------------------------------------------------

async function loadAutopublishThreshold(): Promise<number> {
  const db = getSupabaseClient();

  const { data, error } = await db
    .from("system_config")
    .select("numeric_value")
    .eq("config_key", "REVIEW_CLASSIFICATION_AUTOPUBLISH_THRESHOLD")
    .eq("scope_type", "global")
    .maybeSingle();

  if (error || !data) {
    console.error("Failed to load autopublish threshold, using default 0.95:", error);
    return 0.95;
  }

  return data.numeric_value ?? 0.95;
}

// ---------------------------------------------------------------------------
// Review shape (fields needed for this stage)
// ---------------------------------------------------------------------------

interface ReviewForClassification {
  id: string;
  tenant_id: string;
  review_text: string | null;
  star_rating: number;
  reviewer_display_name: string | null;
  reviewer_is_anonymous: boolean;
  status: string;
  source_review_id: string;
  safe_for_downstream_generation: boolean | null;
  injection_status: string;
  created_from_event_id: string | null;
  last_event_id: string | null;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ClassificationStageResult {
  success: boolean;
  review_id: string;
  is_safe_review_v1_candidate: boolean;
  safe_review_confidence: number;
  customer_intent: string;
  autopublish_eligible: boolean;
  block_reason_codes: string[];
  llm_call_id: string | null;
  event_id: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// System prompt for review classification
// ---------------------------------------------------------------------------

const CLASSIFICATION_SYSTEM_PROMPT = `You are a review classification system for a Google review response service called RightReply.

Your job: Analyze the review and classify it across several dimensions. This classification determines whether the review is safe for automated response generation and publishing.

CLASSIFICATION DIMENSIONS:

1. **Safe Review v1 Candidate** — A review qualifies ONLY if ALL of the following are true:
   - 5 stars
   - Non-empty text
   - No question or request for reply
   - No complaint or mixed sentiment
   - No contact request
   - No legal/refund/billing/safety/discrimination signals
   - No wrong-business/spam/duplicate signals
   - Pure praise or positive feedback

2. **Customer Intent** — One of:
   - "praise" — Positive feedback, compliment, recommendation
   - "complaint" — Negative feedback, dissatisfaction
   - "mixed" — Contains both positive and negative elements
   - "question" — Asks a question or requests information
   - "contact_request" — Wants to be contacted directly
   - "no_text" — Star-only review with no text
   - "spam_wrong_business" — Appears to be spam or for the wrong business
   - "unknown" — Cannot determine intent

3. **Content Safety Flags** — Array of any that apply:
   - "refund_request" — Mentions refund, money back, billing dispute
   - "legal_threat" — Mentions lawyer, lawsuit, court, legal action
   - "medical_safety" — Mentions injury, infection, malpractice, safety incident
   - "discrimination" — Mentions discrimination, harassment, abuse
   - "profanity" — Contains profanity, slurs, sexual content
   - "competitor_comparison" — Makes specific competitor comparisons or allegations
   - "fake_review_allegation" — Alleges fake reviews or review manipulation

4. **Block Reason Codes** — Array of reasons this review should NOT be auto-published. Empty if no blocks.

OUTPUT FORMAT: Respond with exactly one JSON object (no other text):
{
  "is_safe_review_v1_candidate": boolean,
  "safe_review_confidence": number between 0.0 and 1.0,
  "question_detected": boolean,
  "complaint_detected": boolean,
  "contact_request_detected": boolean,
  "wrong_business_or_spam_detected": boolean,
  "block_reason_codes": string[],
  "customer_intent": string,
  "content_safety_flags": string[],
  "reasoning": "brief explanation of classification"
}

RULES:
- safe_review_confidence reflects how confident you are in the is_safe_review_v1_candidate classification
- A 5-star review with pure praise and no complications should have is_safe_review_v1_candidate = true and high confidence
- Any review with fewer than 5 stars is NOT a safe_review_v1_candidate
- Any review with a question, complaint, contact request, or safety flag is NOT a safe_review_v1_candidate
- Empty/blank review text is NOT a safe_review_v1_candidate (handled separately as star-only)
- Be precise. A 5-star review that says "Great but can you call me?" has contact_request_detected = true and is NOT safe
- When in doubt, err on the side of caution — mark as not safe rather than letting a problematic review through`;

// ---------------------------------------------------------------------------
// Main: run classification on a review
// ---------------------------------------------------------------------------

export async function runClassification(
  reviewId: string,
  correlationId?: string,
): Promise<ClassificationStageResult> {
  const db = getSupabaseClient();

  // ── 1. Load the review ──────────────────────────────────────────────

  const { data: review, error: loadError } = await db
    .from("reviews")
    .select(
      "id, tenant_id, review_text, star_rating, reviewer_display_name, reviewer_is_anonymous, status, source_review_id, safe_for_downstream_generation, injection_status, created_from_event_id, last_event_id",
    )
    .eq("id", reviewId)
    .single();

  if (loadError || !review) {
    return {
      success: false,
      review_id: reviewId,
      is_safe_review_v1_candidate: false,
      safe_review_confidence: 0,
      customer_intent: "unknown",
      autopublish_eligible: false,
      block_reason_codes: [],
      llm_call_id: null,
      event_id: null,
      error: `Review not found: ${loadError?.message ?? "no data"}`,
    };
  }

  const typedReview = review as ReviewForClassification;

  // ── 2. Guard: must have passed injection detection ──────────────────

  if (typedReview.safe_for_downstream_generation !== true) {
    return {
      success: false,
      review_id: reviewId,
      is_safe_review_v1_candidate: false,
      safe_review_confidence: 0,
      customer_intent: "unknown",
      autopublish_eligible: false,
      block_reason_codes: [],
      llm_call_id: null,
      event_id: null,
      error: `Review is not safe for downstream generation (injection_status: ${typedReview.injection_status}, safe_for_downstream: ${typedReview.safe_for_downstream_generation})`,
    };
  }

  // ── 3. Handle blank/star-only reviews ───────────────────────────────
  // No text = star-only. Not a safe_review_v1 candidate (Section 8.4
  // requires non-empty text). Classify without LLM call.

  if (!typedReview.review_text || typedReview.review_text.trim() === "") {
    const starOnlyResult: ReviewClassificationOutput = {
      is_safe_review_v1_candidate: false,
      safe_review_confidence: 1.0,
      question_detected: false,
      complaint_detected: false,
      contact_request_detected: false,
      wrong_business_or_spam_detected: false,
      block_reason_codes: ["no_text"],
      customer_intent: "no_text",
      content_safety_flags: [],
      reasoning: "Star-only review with no text — not eligible for safe_review_v1",
    };

    const eventResult = await emitClassificationEvent(
      typedReview,
      starOnlyResult,
      false,
      null,
      correlationId,
    );

    await updateReviewClassificationFields(typedReview.id, starOnlyResult, false, eventResult.event_id);

    return {
      success: true,
      review_id: reviewId,
      is_safe_review_v1_candidate: false,
      safe_review_confidence: 1.0,
      customer_intent: "no_text",
      autopublish_eligible: false,
      block_reason_codes: ["no_text"],
      llm_call_id: null,
      event_id: eventResult.event_id,
      error: null,
    };
  }

  // ── 4. Call the gateway for classification ──────────────────────────

  const requestId = crypto.randomUUID();
  const corrId = correlationId ?? crypto.randomUUID();

  const gatewayResponse = await invokeGateway({
    request_id: requestId,
    domain_key: "rightreply",
    tenant_id: typedReview.tenant_id,
    task_type: "review_classification",
    task_version: "1.0",
    route_mode: "primary",
    input_trust_level: "untrusted_external",
    system_instructions: CLASSIFICATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Classify this Google review:\n\nStar rating: ${typedReview.star_rating}/5\nReviewer: ${typedReview.reviewer_display_name ?? "anonymous"}\nReview text: "${typedReview.review_text}"`,
      },
    ],
    expected_output_mode: "json",
    temperature: 0.0,
    max_output_tokens: 1024,
    timeout_ms: 15000,
    requires_determinism: true,
    requires_high_precision: true,
    allow_tools: false,
    correlation_id: corrId,
    causation_event_id: typedReview.last_event_id,
    prompt_template_id: "review_classification_v1",
    prompt_template_version: "1.0",
    privacy_level: "customer_confidential",
  });

  // ── 5. Handle gateway failure ───────────────────────────────────────

  if (
    gatewayResponse.status !== "succeeded" ||
    !gatewayResponse.schema_valid ||
    !gatewayResponse.output_json
  ) {
    return {
      success: false,
      review_id: reviewId,
      is_safe_review_v1_candidate: false,
      safe_review_confidence: 0,
      customer_intent: "unknown",
      autopublish_eligible: false,
      block_reason_codes: [],
      llm_call_id: gatewayResponse.call_id,
      event_id: null,
      error: `Gateway call failed: ${gatewayResponse.parser_error ?? gatewayResponse.status}`,
    };
  }

  // ── 6. Interpret results and determine autopublish eligibility ──────

  const output = gatewayResponse.output_json as unknown as ReviewClassificationOutput;
  const autopublishThreshold = await loadAutopublishThreshold();

  // Autopublish eligible ONLY if safe candidate AND confidence meets threshold
  const autopublishEligible =
    output.is_safe_review_v1_candidate === true &&
    output.safe_review_confidence >= autopublishThreshold;

  // Determine new review status
  const needsHumanReview =
    output.block_reason_codes.length > 0 ||
    output.content_safety_flags.length > 0 ||
    output.complaint_detected ||
    output.contact_request_detected ||
    output.wrong_business_or_spam_detected;

  // Determine recommended risk tier
  let recommendedRiskTier: "autonomous" | "confirmation_required" | "forbidden";
  if (output.content_safety_flags.some((f) =>
    ["legal_threat", "medical_safety", "discrimination"].includes(f)
  )) {
    recommendedRiskTier = "forbidden";
  } else if (!output.is_safe_review_v1_candidate || needsHumanReview) {
    recommendedRiskTier = "confirmation_required";
  } else {
    recommendedRiskTier = "autonomous";
  }

  // ── 7. Emit events ─────────────────────────────────────────────────

  const eventResult = await emitClassificationEvent(
    typedReview,
    output,
    autopublishEligible,
    gatewayResponse.call_id,
    corrId,
  );

  // If there are block reasons, emit policy_blocked
  if (output.block_reason_codes.length > 0) {
    await emitEvent({
      event_type: EVENT_TYPES.REVIEW_POLICY_BLOCKED,
      tenant_id: typedReview.tenant_id,
      source_channel: "google_gbp",
      source_system: "rightreply_pipeline",
      actor_type: "system",
      actor_id: "review_classifier",
      generation_class: "derived_system",
      authority_rank: 80,
      is_authoritative: true,
      object_type: "review",
      object_id: typedReview.source_review_id,
      correlation_id: corrId,
      causation_event_id: eventResult.event_id ?? undefined,
      idempotency_key: `review.policy_blocked:classification:${typedReview.id}`,
      status: "succeeded",
      risk_flags: output.block_reason_codes,
      privacy_level: "customer_confidential",
      payload: {
        summary: `Review blocked by classification: ${output.block_reason_codes.join(", ")}`,
        facts: {
          block_reason_codes: output.block_reason_codes,
          content_safety_flags: output.content_safety_flags,
          customer_intent: output.customer_intent,
        },
        refs: {
          review_id: typedReview.id,
          llm_call_id: gatewayResponse.call_id,
        },
      },
    });
  }

  // If needs human review, emit escalation
  if (needsHumanReview) {
    await emitEvent({
      event_type: EVENT_TYPES.ESCALATION_TRIGGERED,
      tenant_id: typedReview.tenant_id,
      source_channel: "google_gbp",
      source_system: "rightreply_pipeline",
      actor_type: "system",
      actor_id: "review_classifier",
      generation_class: "derived_system",
      authority_rank: 80,
      is_authoritative: true,
      object_type: "review",
      object_id: typedReview.source_review_id,
      correlation_id: corrId,
      causation_event_id: eventResult.event_id ?? undefined,
      idempotency_key: `escalation.triggered:classification:${typedReview.id}`,
      status: "succeeded",
      risk_flags: output.block_reason_codes,
      privacy_level: "customer_confidential",
      payload: {
        summary: `Escalation: review requires human review (intent: ${output.customer_intent})`,
        facts: {
          customer_intent: output.customer_intent,
          content_safety_flags: output.content_safety_flags,
          block_reason_codes: output.block_reason_codes,
          reasoning: output.reasoning,
        },
        refs: {
          review_id: typedReview.id,
          llm_call_id: gatewayResponse.call_id,
        },
      },
    });
  }

  // ── 8. Update the review row ────────────────────────────────────────

  await updateReviewClassificationFields(
    typedReview.id,
    output,
    autopublishEligible,
    eventResult.event_id,
    gatewayResponse.call_id,
    recommendedRiskTier,
    needsHumanReview,
  );

  return {
    success: true,
    review_id: reviewId,
    is_safe_review_v1_candidate: output.is_safe_review_v1_candidate,
    safe_review_confidence: output.safe_review_confidence,
    customer_intent: output.customer_intent,
    autopublish_eligible: autopublishEligible,
    block_reason_codes: output.block_reason_codes,
    llm_call_id: gatewayResponse.call_id,
    event_id: eventResult.event_id,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function emitClassificationEvent(
  review: ReviewForClassification,
  output: ReviewClassificationOutput,
  autopublishEligible: boolean,
  llmCallId: string | null,
  correlationId?: string,
) {
  return await emitEvent({
    event_type: EVENT_TYPES.REVIEW_CLASSIFIED,
    tenant_id: review.tenant_id,
    source_channel: "google_gbp",
    source_system: "rightreply_pipeline",
    actor_type: "model",
    actor_id: "review_classifier",
    generation_class: "derived_system",
    authority_rank: 50,
    is_authoritative: false,
    object_type: "review",
    object_id: review.source_review_id,
    correlation_id: correlationId,
    causation_event_id: review.last_event_id ?? undefined,
    idempotency_key: `review.classified:content:${review.id}`,
    status: "succeeded",
    risk_flags: output.block_reason_codes,
    privacy_level: "customer_confidential",
    payload: {
      summary: `Review classified: intent=${output.customer_intent}, safe_v1=${output.is_safe_review_v1_candidate}, confidence=${output.safe_review_confidence}, autopublish=${autopublishEligible}`,
      facts: {
        is_safe_review_v1_candidate: output.is_safe_review_v1_candidate,
        safe_review_confidence: output.safe_review_confidence,
        question_detected: output.question_detected,
        complaint_detected: output.complaint_detected,
        contact_request_detected: output.contact_request_detected,
        wrong_business_or_spam_detected: output.wrong_business_or_spam_detected,
        customer_intent: output.customer_intent,
        content_safety_flags: output.content_safety_flags,
        block_reason_codes: output.block_reason_codes,
      },
      refs: {
        review_id: review.id,
        llm_call_id: llmCallId,
      },
      derived: {
        autopublish_eligible: autopublishEligible,
        reasoning: output.reasoning,
      },
    },
  });
}

async function updateReviewClassificationFields(
  reviewId: string,
  output: ReviewClassificationOutput,
  autopublishEligible: boolean,
  eventId: string | null,
  llmCallId?: string | null,
  recommendedRiskTier?: string,
  needsHumanReview?: boolean,
): Promise<void> {
  const db = getSupabaseClient();

  // Determine new status based on classification
  // Section 4 review state machine:
  //   received → eligible_for_generation (if safe_review_v1 = true)
  //   received → policy_blocked (if block reasons exist)
  //   received → needs_human_review (if escalation needed)
  let newStatus: string | undefined;
  if (output.block_reason_codes.length > 0) {
    newStatus = "policy_blocked";
  } else if (needsHumanReview) {
    newStatus = "needs_human_review";
  } else if (output.is_safe_review_v1_candidate) {
    newStatus = "eligible_for_generation";
  }

  const { error } = await db
    .from("reviews")
    .update({
      // Classification fields
      is_safe_review_v1_candidate: output.is_safe_review_v1_candidate,
      safe_review_confidence: output.safe_review_confidence,
      question_detected: output.question_detected,
      complaint_detected: output.complaint_detected,
      contact_request_detected: output.contact_request_detected,
      wrong_business_or_spam_detected: output.wrong_business_or_spam_detected,
      block_reason_codes: output.block_reason_codes,
      customer_intent: output.customer_intent,
      content_safety_flags: output.content_safety_flags,
      recommended_risk_tier: recommendedRiskTier ?? null,
      // Pipeline flags
      autopublish_eligible: autopublishEligible,
      needs_human_review: needsHumanReview ?? false,
      // Status transition
      ...(newStatus ? { status: newStatus } : {}),
      // Traceability
      classification_llm_call_id: llmCallId ?? null,
      last_event_id: eventId,
      last_processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", reviewId);

  if (error) {
    console.error("Failed to update review classification fields:", error.message);
  }
}
