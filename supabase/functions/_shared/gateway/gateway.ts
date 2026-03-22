/**
 * LLM Gateway — the single path for all LLM calls.
 *
 * Five jobs (Section 7.1):
 *   1. Standardizes request/response shape across providers
 *   2. Routes task types to approved models
 *   3. Logs every call to llm_calls for cost, audit, replay, and eval
 *   4. Enforces task-level policy before/after model calls
 *   5. Allows provider/model swaps without touching operator logic
 *
 * Hard rules (Section 7.10):
 *   - All provider credentials live below the gateway, never in business workers
 *   - Every call must record provider, alias, version, tokens, cost, latency
 *   - No raw provider response bypasses schema validation for structured tasks
 *   - Untrusted external text must be labeled as untrusted in request metadata
 *
 * Slice 1: Anthropic (Claude) only. Provider abstraction is ready for
 * additional providers later.
 */

import { getSupabaseClient } from "../supabase-client.ts";
import { resolveRoute } from "./route-resolver.ts";
import type {
  LLMCallStatus,
  LLMInvokeRequest,
  LLMInvokeResponse,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Anthropic SDK via esm.sh (Deno-compatible)
// ---------------------------------------------------------------------------

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";

let _anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Store it as a Supabase secret.",
    );
  }

  _anthropicClient = new Anthropic({ apiKey });
  return _anthropicClient;
}

// ---------------------------------------------------------------------------
// Cost estimation (rough per-model rates, updated as needed)
// ---------------------------------------------------------------------------

const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-haiku-4-5-20251001": { input: 0.001, output: 0.005 },
  // Add new models here as they're registered
};

function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const rates = COST_PER_1K_TOKENS[modelId];
  if (!rates) return null;
  return (promptTokens / 1000) * rates.input +
    (completionTokens / 1000) * rates.output;
}

// ---------------------------------------------------------------------------
// Gateway: invoke
// ---------------------------------------------------------------------------

export async function invokeGateway(
  request: LLMInvokeRequest,
): Promise<LLMInvokeResponse> {
  const startedAt = new Date();
  const callId = crypto.randomUUID();

  // ── 1. Resolve the route ──────────────────────────────────────────────

  const { route, error: routeError } = await resolveRoute(
    request.task_type,
    request.task_version,
    request.route_mode,
    request.model_alias,
  );

  if (routeError || !route) {
    // Log the failed call and return
    const failedResponse = buildFailedResponse(
      callId,
      request,
      "blocked",
      routeError ?? "Route resolution failed",
      startedAt,
    );
    await logCall(request, failedResponse);
    return failedResponse;
  }

  // ── 2. Call the provider ──────────────────────────────────────────────

  let providerResponse: Anthropic.Message;
  let status: LLMCallStatus = "succeeded";
  let outputText: string | null = null;
  let outputJson: Record<string, unknown> | null = null;
  let schemaValid = false;
  let parserError: string | null = null;
  let finishReason: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let cachedTokens: number | null = null;
  let providerRequestId: string | null = null;

  try {
    const anthropic = getAnthropicClient();

    // Build the messages array for Anthropic
    // System instructions go in the system parameter, not as a message
    const anthropicMessages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Combine system + developer instructions
    const systemParts: string[] = [];
    if (request.system_instructions) {
      systemParts.push(request.system_instructions);
    }
    if (request.developer_instructions) {
      systemParts.push(request.developer_instructions);
    }

    const apiRequest: Anthropic.MessageCreateParams = {
      model: route.provider_model_id,
      max_tokens: route.max_output_tokens,
      temperature: route.temperature,
      messages: anthropicMessages,
    };

    if (systemParts.length > 0) {
      apiRequest.system = systemParts.join("\n\n");
    }

    // Use AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      route.timeout_ms,
    );

    try {
      providerResponse = await anthropic.messages.create(apiRequest, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Extract response data
    finishReason = providerResponse.stop_reason ?? null;
    providerRequestId = providerResponse.id;
    promptTokens = providerResponse.usage?.input_tokens ?? null;
    completionTokens = providerResponse.usage?.output_tokens ?? null;

    // Check for cached tokens in the usage
    const usage = providerResponse.usage as Record<string, unknown>;
    cachedTokens = (usage?.cache_read_input_tokens as number) ?? null;

    // Extract text from content blocks
    const textBlocks = providerResponse.content.filter(
      (b) => b.type === "text",
    );
    outputText = textBlocks.map((b) => b.text).join("") || null;

    // ── 3. Parse structured output ────────────────────────────────────

    if (
      request.expected_output_mode === "json" ||
      request.expected_output_mode === "json_schema" ||
      request.expected_output_mode === "classification"
    ) {
      if (outputText) {
        try {
          // Try to extract JSON from the response
          // First try raw parse, then try extracting from markdown code blocks
          let jsonStr = outputText.trim();

          // Strip markdown code fences if present
          const jsonBlockMatch = jsonStr.match(
            /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/,
          );
          if (jsonBlockMatch) {
            jsonStr = jsonBlockMatch[1].trim();
          }

          outputJson = JSON.parse(jsonStr);
          schemaValid = true; // Basic parse succeeded

          // TODO: validate against output_schema if provided
        } catch (e) {
          parserError = `JSON parse failed: ${(e as Error).message}`;
          schemaValid = false;
        }
      } else {
        parserError = "No text output to parse";
        schemaValid = false;
      }
    } else {
      // Text mode — no schema validation needed
      schemaValid = true;
    }
  } catch (err) {
    const error = err as Error;

    if (error.name === "AbortError") {
      status = "timed_out";
      parserError = `Timed out after ${route.timeout_ms}ms`;
    } else {
      status = "failed";
      parserError = error.message;
    }
  }

  // ── 4. Build response ────────────────────────────────────────────────

  const completedAt = new Date();
  const latencyMs = completedAt.getTime() - startedAt.getTime();

  const response: LLMInvokeResponse = {
    call_id: callId,
    request_id: request.request_id,
    status,
    resolved_provider: route.provider_key,
    resolved_model_id: route.provider_model_id,
    resolved_model_alias: route.internal_model_alias,
    route_mode: route.route_mode,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    latency_ms: latencyMs,
    output_text: outputText,
    output_json: outputJson,
    finish_reason: finishReason,
    schema_valid: schemaValid,
    parser_error: parserError,
    usage_prompt_tokens: promptTokens,
    usage_completion_tokens: completionTokens,
    usage_cached_tokens: cachedTokens,
    estimated_cost_usd: (promptTokens && completionTokens)
      ? estimateCost(route.provider_model_id, promptTokens, completionTokens)
      : null,
    provider_request_id: providerRequestId,
    task_confidence: null, // Set by caller after interpreting output
    policy_flags: [],
    retry_count: 0,
    fallback_used: false,
    artifact_ref: null,
  };

  // ── 5. Log to llm_calls ──────────────────────────────────────────────

  await logCall(request, response);

  return response;
}

// ---------------------------------------------------------------------------
// Log call to llm_calls table (Section 7.4)
// ---------------------------------------------------------------------------

async function logCall(
  request: LLMInvokeRequest,
  response: LLMInvokeResponse,
): Promise<void> {
  const db = getSupabaseClient();

  // Build compact excerpts — don't store full prompts in the main table
  // (Section 7.4: full prompt/response stored externally for sampled/failed)
  const requestExcerpt: Record<string, unknown> = {
    task_type: request.task_type,
    task_version: request.task_version,
    input_trust_level: request.input_trust_level,
    expected_output_mode: request.expected_output_mode,
    message_count: request.messages.length,
  };

  const responseExcerpt: Record<string, unknown> = {
    status: response.status,
    finish_reason: response.finish_reason,
    schema_valid: response.schema_valid,
    output_preview: response.output_text?.substring(0, 200) ?? null,
  };

  const { error } = await db.from("llm_calls").insert({
    id: response.call_id,
    request_id: request.request_id,
    domain_key: request.domain_key,
    tenant_id: request.tenant_id,
    task_type: request.task_type,
    task_version: request.task_version,
    route_mode: response.route_mode,
    input_trust_level: request.input_trust_level,
    status: response.status,
    resolved_provider: response.resolved_provider,
    resolved_model_id: response.resolved_model_id,
    resolved_model_alias: response.resolved_model_alias,
    temperature: response.route_mode !== "blocked" ? undefined : null,
    max_output_tokens: request.max_output_tokens,
    timeout_ms: request.timeout_ms,
    started_at: response.started_at,
    completed_at: response.completed_at,
    latency_ms: response.latency_ms,
    output_text: response.output_text,
    output_json: response.output_json,
    finish_reason: response.finish_reason,
    schema_valid: response.schema_valid,
    parser_error: response.parser_error,
    usage_prompt_tokens: response.usage_prompt_tokens,
    usage_completion_tokens: response.usage_completion_tokens,
    usage_cached_tokens: response.usage_cached_tokens,
    estimated_cost_usd: response.estimated_cost_usd,
    provider_request_id: response.provider_request_id,
    task_confidence: response.task_confidence,
    policy_flags: response.policy_flags,
    retry_count: response.retry_count,
    fallback_used: response.fallback_used,
    correlation_id: request.correlation_id,
    causation_event_id: request.causation_event_id,
    prompt_template_id: request.prompt_template_id ?? null,
    prompt_template_version: request.prompt_template_version ?? null,
    request_payload_excerpt: requestExcerpt,
    response_payload_excerpt: responseExcerpt,
    artifact_ref: response.artifact_ref,
  });

  if (error) {
    // Log but don't fail the gateway call — the LLM result is still valid
    // Section 7.10 rule 3 says every call must be recorded, so this is
    // a degraded state but not a hard failure for the caller.
    console.error("Failed to log LLM call:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Helper: build a failed response without provider call
// ---------------------------------------------------------------------------

function buildFailedResponse(
  callId: string,
  request: LLMInvokeRequest,
  status: LLMCallStatus,
  error: string,
  startedAt: Date,
): LLMInvokeResponse {
  const now = new Date();
  return {
    call_id: callId,
    request_id: request.request_id,
    status,
    resolved_provider: "none",
    resolved_model_id: "none",
    resolved_model_alias: "none",
    route_mode: request.route_mode,
    started_at: startedAt.toISOString(),
    completed_at: now.toISOString(),
    latency_ms: now.getTime() - startedAt.getTime(),
    output_text: null,
    output_json: null,
    finish_reason: null,
    schema_valid: false,
    parser_error: error,
    usage_prompt_tokens: null,
    usage_completion_tokens: null,
    usage_cached_tokens: null,
    estimated_cost_usd: null,
    provider_request_id: null,
    task_confidence: null,
    policy_flags: [],
    retry_count: 0,
    fallback_used: false,
    artifact_ref: null,
  };
}
