/**
 * Pipeline Stage 6: Response Draft Generation
 *
 * Takes a review that has passed classification (autopublish_eligible = true),
 * loads the tenant's approved brand voice profile, sends both through the
 * LLM gateway to generate a draft response, inserts a row into responses,
 * and updates the review with the current_response_id.
 *
 * Spec alignment:
 *   - Section 2: Slice 1A flow steps 8-10
 *   - Section 6.3 Stage 6: Draft generation (eligible reviews only)
 *   - Data model Section 5: responses table schema
 *   - Section 7.10 rule 7: Untrusted text labeled as untrusted
 *   - Section 8.1: Slice 1A = draft/shadow only, nothing publishes
 *
 * Events emitted:
 *   - response.draft_generated
 */

import { getSupabaseClient } from "../supabase-client.ts";
import { emitEvent } from "../events/emit.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { invokeGateway } from "../gateway/gateway.ts";

// ---------------------------------------------------------------------------
// Review shape (fields needed for this stage)
// ---------------------------------------------------------------------------

interface ReviewForGeneration {
  id: string;
  tenant_id: string;
  review_text: string | null;
  star_rating: number;
  reviewer_display_name: string | null;
  reviewer_is_anonymous: boolean;
  status: string;
  source_review_id: string;
  autopublish_eligible: boolean;
  current_response_id: string | null;
  last_event_id: string | null;
}

// ---------------------------------------------------------------------------
// Brand voice profile shape
// ---------------------------------------------------------------------------

interface BrandVoiceProfile {
  id: string;
  tone_summary: string;
  prompt_snippet: string | null;
  max_response_words: number;
  allow_exclamation_points: boolean;
  dos: unknown[] | null;
  donts: unknown[] | null;
  forbidden_phrases: string[] | null;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface GenerationStageResult {
  success: boolean;
  review_id: string;
  response_id: string | null;
  response_version: number;
  draft_text: string | null;
  llm_call_id: string | null;
  event_id: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Main: run generation on a review
// ---------------------------------------------------------------------------

export async function runGeneration(
  reviewId: string,
  correlationId?: string,
): Promise<GenerationStageResult> {
  const db = getSupabaseClient();

  // ── 1. Load the review ──────────────────────────────────────────────

  const { data: review, error: loadError } = await db
    .from("reviews")
    .select(
      "id, tenant_id, review_text, star_rating, reviewer_display_name, reviewer_is_anonymous, status, source_review_id, autopublish_eligible, current_response_id, last_event_id",
    )
    .eq("id", reviewId)
    .single();

  if (loadError || !review) {
    return {
      success: false,
      review_id: reviewId,
      response_id: null,
      response_version: 0,
      draft_text: null,
      llm_call_id: null,
      event_id: null,
      error: `Review not found: ${loadError?.message ?? "no data"}`,
    };
  }

  const typedReview = review as ReviewForGeneration;

  // ── 2. Guard: must be autopublish eligible ──────────────────────────

  if (typedReview.autopublish_eligible !== true) {
    return {
      success: false,
      review_id: reviewId,
      response_id: null,
      response_version: 0,
      draft_text: null,
      llm_call_id: null,
      event_id: null,
      error: `Review is not autopublish eligible (autopublish_eligible: ${typedReview.autopublish_eligible}, status: ${typedReview.status})`,
    };
  }

  // ── 3. Load tenant's approved brand voice profile ───────────────────

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("approved_brand_voice_profile_id")
    .eq("id", typedReview.tenant_id)
    .single();

  if (tenantError || !tenant || !tenant.approved_brand_voice_profile_id) {
    return {
      success: false,
      review_id: reviewId,
      response_id: null,
      response_version: 0,
      draft_text: null,
      llm_call_id: null,
      event_id: null,
      error: `No approved brand voice profile for tenant ${typedReview.tenant_id}`,
    };
  }

  const { data: brandVoice, error: bvError } = await db
    .from("brand_voice_profiles")
    .select(
      "id, tone_summary, prompt_snippet, max_response_words, allow_exclamation_points, dos, donts, forbidden_phrases",
    )
    .eq("id", tenant.approved_brand_voice_profile_id)
    .single();

  if (bvError || !brandVoice) {
    return {
      success: false,
      review_id: reviewId,
      response_id: null,
      response_version: 0,
      draft_text: null,
      llm_call_id: null,
      event_id: null,
      error: `Brand voice profile not found: ${bvError?.message ?? "no data"}`,
    };
  }

  const typedBV = brandVoice as BrandVoiceProfile;

  // ── 4. Determine response_version ───────────────────────────────────

  const { count } = await db
    .from("responses")
    .select("id", { count: "exact", head: true })
    .eq("review_id", reviewId);

  const responseVersion = (count ?? 0) + 1;

  // ── 5. Build the generation prompt ──────────────────────────────────

  const systemPrompt = buildSystemPrompt(typedBV);
  const userMessage = buildUserMessage(typedReview);

  // ── 6. Call the gateway ─────────────────────────────────────────────

  const requestId = crypto.randomUUID();
  const corrId = correlationId ?? crypto.randomUUID();

  const gatewayResponse = await invokeGateway({
    request_id: requestId,
    domain_key: "rightreply",
    tenant_id: typedReview.tenant_id,
    task_type: "response_generation",
    task_version: "1.0",
    route_mode: "primary",
    input_trust_level: "mixed", // System prompt is trusted, review text is not
    system_instructions: systemPrompt,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
    expected_output_mode: "text", // Generation returns plain text, not JSON
    temperature: 0.7,
    max_output_tokens: 512,
    timeout_ms: 30000,
    requires_determinism: false,
    requires_high_precision: false,
    allow_tools: false,
    correlation_id: corrId,
    causation_event_id: typedReview.last_event_id,
    prompt_template_id: "response_generation_v1",
    prompt_template_version: "1.0",
    privacy_level: "customer_confidential",
  });

  // ── 7. Handle gateway failure ───────────────────────────────────────

  if (gatewayResponse.status !== "succeeded" || !gatewayResponse.output_text) {
    return {
      success: false,
      review_id: reviewId,
      response_id: null,
      response_version: responseVersion,
      draft_text: null,
      llm_call_id: gatewayResponse.call_id,
      event_id: null,
      error: `Gateway call failed: ${gatewayResponse.parser_error ?? gatewayResponse.status}`,
    };
  }

  const draftText = gatewayResponse.output_text.trim();

  // ── 8. Write response.draft_generated event ─────────────────────────

  const responseId = crypto.randomUUID();
  const now = new Date().toISOString();

  const eventResult = await emitEvent({
    event_type: EVENT_TYPES.RESPONSE_DRAFT_GENERATED,
    tenant_id: typedReview.tenant_id,
    source_channel: "google_gbp",
    source_system: "rightreply_pipeline",
    actor_type: "model",
    actor_id: "response_generator",
    generation_class: "system_generated",
    authority_rank: 50,
    is_authoritative: false,
    object_type: "response",
    object_id: responseId,
    correlation_id: corrId,
    causation_event_id: typedReview.last_event_id ?? undefined,
    idempotency_key: `response.draft_generated:${reviewId}:v${responseVersion}`,
    status: "succeeded",
    risk_flags: [],
    privacy_level: "customer_confidential",
    payload: {
      summary: `Draft response generated for ${typedReview.star_rating}-star review from ${typedReview.reviewer_display_name ?? "anonymous"}`,
      facts: {
        response_version: responseVersion,
        generation_mode: "autonomous",
        word_count: draftText.split(/\s+/).length,
        brand_voice_profile_id: typedBV.id,
      },
      refs: {
        review_id: reviewId,
        response_id: responseId,
        llm_call_id: gatewayResponse.call_id,
        brand_voice_profile_id: typedBV.id,
      },
      derived: {
        draft_preview: draftText.substring(0, 200),
      },
    },
  });

  if (!eventResult.success) {
    // Section 5.7: If ledger write fails, no downstream side effects
    return {
      success: false,
      review_id: reviewId,
      response_id: null,
      response_version: responseVersion,
      draft_text: draftText,
      llm_call_id: gatewayResponse.call_id,
      event_id: null,
      error: `Ledger write failed: ${eventResult.error}`,
    };
  }

  // ── 9. Insert into responses table ──────────────────────────────────

  // Slice 1A: draft_only_mode is on, so approval_required = true
  // (nothing publishes autonomously yet)
  const { error: insertError } = await db.from("responses").insert({
    id: responseId,
    tenant_id: typedReview.tenant_id,
    review_id: reviewId,
    response_version: responseVersion,
    status: "draft_generated",
    draft_text: draftText,
    final_text: null,
    generation_mode: "autonomous",
    brand_voice_profile_id: typedBV.id,
    generation_llm_call_id: gatewayResponse.call_id,
    generation_prompt_template_id: "response_generation_v1",
    generation_prompt_template_version: "1.0",
    generated_at: now,
    approval_required: true, // Slice 1A = draft only
    approval_id: null,
    approved_at: null,
    approved_by_actor_id: null,
    rejected_at: null,
    rejected_by_actor_id: null,
    rejection_reason: null,
    publish_attempt_count: 0,
    last_publish_attempted_at: null,
    published_at: null,
    publish_provider_response_id: null,
    publish_receipt_id: null,
    publish_failure_code: null,
    publish_failure_message: null,
    supersedes_response_id: typedReview.current_response_id,
    superseded_by_response_id: null,
    created_from_event_id: eventResult.event_id,
    last_event_id: eventResult.event_id,
    created_at: now,
    updated_at: now,
  });

  if (insertError) {
    console.error("Response insert failed:", insertError);
    return {
      success: false,
      review_id: reviewId,
      response_id: null,
      response_version: responseVersion,
      draft_text: draftText,
      llm_call_id: gatewayResponse.call_id,
      event_id: eventResult.event_id,
      error: `Response insert failed: ${insertError.message}`,
    };
  }

  // ── 10. Update reviews table ────────────────────────────────────────

  const { error: updateError } = await db
    .from("reviews")
    .update({
      current_response_id: responseId,
      status: "draft_ready",
      last_event_id: eventResult.event_id,
      last_processed_at: now,
      updated_at: now,
    })
    .eq("id", reviewId);

  if (updateError) {
    console.error("Review update failed:", updateError.message);
  }

  // If there was a previous response, mark it superseded
  if (typedReview.current_response_id) {
    await db
      .from("responses")
      .update({
        status: "superseded",
        superseded_by_response_id: responseId,
        updated_at: now,
      })
      .eq("id", typedReview.current_response_id);
  }

  return {
    success: true,
    review_id: reviewId,
    response_id: responseId,
    response_version: responseVersion,
    draft_text: draftText,
    llm_call_id: gatewayResponse.call_id,
    event_id: eventResult.event_id,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPrompt(bv: BrandVoiceProfile): string {
  const parts: string[] = [];

  // Use the prompt_snippet if available (distilled voice instruction)
  if (bv.prompt_snippet) {
    parts.push(bv.prompt_snippet);
  } else {
    parts.push(
      `You are writing a response to a Google review on behalf of a business.`,
    );
    parts.push(`Tone: ${bv.tone_summary}`);
  }

  parts.push(`\nHard constraints:`);
  parts.push(`- Maximum ${bv.max_response_words} words`);
  parts.push(`- 2-3 sentences only`);

  if (!bv.allow_exclamation_points) {
    parts.push(`- Do not use exclamation points`);
  }

  if (bv.dos && Array.isArray(bv.dos) && bv.dos.length > 0) {
    parts.push(`\nDO:`);
    for (const item of bv.dos) {
      parts.push(`- ${item}`);
    }
  }

  if (bv.donts && Array.isArray(bv.donts) && bv.donts.length > 0) {
    parts.push(`\nDO NOT:`);
    for (const item of bv.donts) {
      parts.push(`- ${item}`);
    }
  }

  if (bv.forbidden_phrases && bv.forbidden_phrases.length > 0) {
    parts.push(
      `\nFORBIDDEN PHRASES (never use these words): ${bv.forbidden_phrases.join(", ")}`,
    );
  }

  parts.push(`\nCRITICAL RULES:`);
  parts.push(`- Do NOT make promises, offers, discounts, or guarantees`);
  parts.push(`- Do NOT invent facts not present in the review`);
  parts.push(`- Do NOT reference specific pricing or promotions`);
  parts.push(`- Do NOT discuss other patients, customers, or cases`);
  parts.push(`- Respond ONLY with the response text — no preamble, no quotes, no explanation`);

  return parts.join("\n");
}

function buildUserMessage(review: ReviewForGeneration): string {
  const reviewerName = review.reviewer_is_anonymous
    ? null
    : review.reviewer_display_name;

  return [
    `Write a response to this Google review:`,
    ``,
    `Star rating: ${review.star_rating}/5`,
    `Reviewer: ${reviewerName ?? "Anonymous"}`,
    `Review text: "${review.review_text}"`,
    ``,
    `${reviewerName ? `Thank ${reviewerName} by name.` : "Do not address the reviewer by name since they are anonymous."} Reference something specific they mentioned. Keep it warm and professional.`,
  ].join("\n");
}
