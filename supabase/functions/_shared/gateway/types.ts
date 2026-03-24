/**
 * LLM Gateway type definitions.
 *
 * Maps directly to the gateway contracts in Build Reference Section 7.2-7.3
 * and the llm_calls / model_registry / task_model_routes tables.
 *
 * Hard rule (Section 7.1): No business logic may call a provider SDK directly.
 * All calls go through the gateway.
 */

// ---------------------------------------------------------------------------
// Enums — match DB enums and build reference Section 7.2
// ---------------------------------------------------------------------------

/** Slice 1 task types only. Others are reserved (Section 7.2, 8.7). */
export type TaskType =
  | "prompt_injection_detection"
  | "review_classification"
  | "response_generation";

export type RouteMode =
  | "primary"
  | "shadow"
  | "canary"
  | "fallback"
  | "forced_model";

export type InputTrustLevel =
  | "trusted_system"
  | "trusted_human"
  | "untrusted_external"
  | "mixed";

export type ExpectedOutputMode =
  | "text"
  | "json"
  | "json_schema"
  | "classification";

export type LLMCallStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "blocked"
  | "fallback_succeeded";

export type PrivacyLevel =
  | "public_business"
  | "internal_business"
  | "customer_confidential"
  | "billing_sensitive"
  | "operator_secret";

// ---------------------------------------------------------------------------
// Gateway Request Contract — Section 7.2 (LLMInvokeRequest)
// ---------------------------------------------------------------------------

export interface LLMInvokeRequest {
  /** Caller-supplied or gateway-generated unique request ID */
  request_id: string;
  domain_key: string;
  tenant_id: string | null;
  task_type: TaskType;
  task_version: string;
  route_mode: RouteMode;
  /** Optional model alias override */
  model_alias?: string | null;
  /** Optional provider hint */
  provider_hint?: string | null;
  input_trust_level: InputTrustLevel;
  /** System instructions — usually from template store */
  system_instructions: string | null;
  /** Developer instructions — internal task logic */
  developer_instructions?: string | null;
  /** Canonical message array for the LLM */
  messages: LLMMessage[];
  /** Structured task-specific facts */
  input_payload?: Record<string, unknown> | null;
  expected_output_mode: ExpectedOutputMode;
  /** JSON schema for structured output validation */
  output_schema?: Record<string, unknown> | null;
  temperature: number;
  max_output_tokens: number;
  timeout_ms: number;
  requires_determinism: boolean;
  requires_high_precision: boolean;
  allow_tools: boolean;
  tool_spec?: Record<string, unknown> | null;
  correlation_id: string | null;
  causation_event_id: string | null;
  prompt_template_id?: string | null;
  prompt_template_version?: string | null;
  privacy_level: PrivacyLevel;
  sampling_key?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Standard message shape for LLM conversations */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Gateway Response Contract — Section 7.3 (LLMInvokeResponse)
// ---------------------------------------------------------------------------

export interface LLMInvokeResponse {
  /** Unique call record ID (logged to llm_calls) */
  call_id: string;
  /** Echo of request_id */
  request_id: string;
  status: LLMCallStatus;
  resolved_provider: string;
  resolved_model_id: string;
  resolved_model_alias: string;
  route_mode: RouteMode;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  /** Raw text output from the model */
  output_text: string | null;
  /** Parsed structured JSON output */
  output_json: Record<string, unknown> | null;
  finish_reason: string | null;
  /** Whether output_json passes schema validation */
  schema_valid: boolean;
  parser_error: string | null;
  usage_prompt_tokens: number | null;
  usage_completion_tokens: number | null;
  usage_cached_tokens: number | null;
  estimated_cost_usd: number | null;
  provider_request_id: string | null;
  /** Advisory confidence — not operational truth */
  task_confidence: number | null;
  policy_flags: string[];
  retry_count: number;
  fallback_used: boolean;
  artifact_ref: string | null;
}

// ---------------------------------------------------------------------------
// Route resolution result (internal to gateway)
// ---------------------------------------------------------------------------

export interface ResolvedRoute {
  provider_key: string;
  provider_model_id: string;
  internal_model_alias: string;
  temperature: number;
  max_output_tokens: number;
  timeout_ms: number;
  route_mode: RouteMode;
}

// ---------------------------------------------------------------------------
// Injection detection output contract — Section 6.3 Stage 2
// ---------------------------------------------------------------------------

export interface InjectionDetectionOutput {
  injection_detected: boolean;
  injection_confidence: number;
  injection_pattern_codes: string[];
  obfuscation_detected: boolean;
  recommended_risk_tier: "autonomous" | "confirmation_required" | "forbidden";
  safe_for_downstream_generation: boolean;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Review classification output contract — Section 8.4
// ---------------------------------------------------------------------------

export interface ReviewClassificationOutput {
  is_safe_review_v1_candidate: boolean;
  safe_review_confidence: number;
  question_detected: boolean;
  complaint_detected: boolean;
  contact_request_detected: boolean;
  wrong_business_or_spam_detected: boolean;
  block_reason_codes: string[];
  customer_intent: string;
  content_safety_flags: string[];
  reasoning: string;
}
