/**
 * Route resolver — determines which model handles a given task type.
 *
 * Looks up the task_model_routes table to find the active route for a
 * task_type + task_version pair, then resolves the model details from
 * model_registry.
 *
 * Spec alignment:
 *   - Section 7.6: task_model_routes schema
 *   - Section 7.5: model_registry schema
 *   - Section 7.7: task-to-model routing strategy
 *   - Section 7.8 rule 1: Caller specifies task_type, gateway chooses model
 *   - Section 7.8 rule 2: Business logic does not know provider model IDs
 */

import { getSupabaseClient } from "../supabase-client.ts";
import type { ResolvedRoute, RouteMode, TaskType } from "./types.ts";

// ---------------------------------------------------------------------------
// Types for DB rows
// ---------------------------------------------------------------------------

interface TaskModelRouteRow {
  primary_model_alias: string;
  fallback_model_alias: string | null;
  temperature_override: number | null;
  max_output_tokens_override: number | null;
  timeout_ms_override: number | null;
}

interface ModelRegistryRow {
  provider_key: string;
  provider_model_id: string;
  internal_model_alias: string;
  status: string;
  approved_for_prod: boolean;
}

// ---------------------------------------------------------------------------
// Defaults per task type (Section 7.7 strategy)
// ---------------------------------------------------------------------------

const TASK_DEFAULTS: Record<TaskType, {
  temperature: number;
  max_output_tokens: number;
  timeout_ms: number;
}> = {
  prompt_injection_detection: {
    temperature: 0.0,       // Determinism — favor recall
    max_output_tokens: 1024,
    timeout_ms: 15000,
  },
  review_classification: {
    temperature: 0.0,       // Structured accuracy
    max_output_tokens: 1024,
    timeout_ms: 15000,
  },
  response_generation: {
    temperature: 0.7,       // Quality and variety
    max_output_tokens: 512,
    timeout_ms: 30000,
  },
};

// ---------------------------------------------------------------------------
// Resolve route
// ---------------------------------------------------------------------------

export interface RouteResolutionResult {
  route: ResolvedRoute | null;
  error: string | null;
}

/**
 * Resolves the model route for a task.
 *
 * 1. Looks up active route in task_model_routes for (task_type, task_version)
 * 2. Resolves the model alias to full model details from model_registry
 * 3. Applies temperature/token/timeout overrides from the route
 *
 * If model_alias is provided (forced_model), skips route lookup.
 */
export async function resolveRoute(
  taskType: TaskType,
  taskVersion: string,
  routeMode: RouteMode = "primary",
  modelAlias?: string | null,
): Promise<RouteResolutionResult> {
  const db = getSupabaseClient();

  let targetAlias: string;
  let tempOverride: number | null = null;
  let tokensOverride: number | null = null;
  let timeoutOverride: number | null = null;

  if (modelAlias && routeMode === "forced_model") {
    // Caller forcing a specific model — skip route table
    targetAlias = modelAlias;
  } else {
    // Look up the active route for this task_type + task_version
    const { data: route, error: routeError } = await db
      .from("task_model_routes")
      .select(
        "primary_model_alias, fallback_model_alias, temperature_override, max_output_tokens_override, timeout_ms_override",
      )
      .eq("task_type", taskType)
      .eq("task_version", taskVersion)
      .eq("is_active", true)
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (routeError) {
      return {
        route: null,
        error: `Route lookup failed: ${routeError.message}`,
      };
    }

    if (!route) {
      return {
        route: null,
        error: `No active route for task_type=${taskType} task_version=${taskVersion}`,
      };
    }

    const typedRoute = route as TaskModelRouteRow;

    // For primary mode use primary alias; for fallback mode use fallback
    if (routeMode === "fallback" && typedRoute.fallback_model_alias) {
      targetAlias = typedRoute.fallback_model_alias;
    } else {
      targetAlias = typedRoute.primary_model_alias;
    }

    tempOverride = typedRoute.temperature_override;
    tokensOverride = typedRoute.max_output_tokens_override;
    timeoutOverride = typedRoute.timeout_ms_override;
  }

  // Resolve the model alias to full registry details
  const { data: model, error: modelError } = await db
    .from("model_registry")
    .select(
      "provider_key, provider_model_id, internal_model_alias, status, approved_for_prod",
    )
    .eq("internal_model_alias", targetAlias)
    .maybeSingle();

  if (modelError) {
    return {
      route: null,
      error: `Model registry lookup failed: ${modelError.message}`,
    };
  }

  if (!model) {
    return {
      route: null,
      error: `Model alias '${targetAlias}' not found in model_registry`,
    };
  }

  const typedModel = model as ModelRegistryRow;

  // Verify model is approved for production
  if (!typedModel.approved_for_prod) {
    return {
      route: null,
      error: `Model '${targetAlias}' is not approved for production (status: ${typedModel.status})`,
    };
  }

  const defaults = TASK_DEFAULTS[taskType];

  return {
    route: {
      provider_key: typedModel.provider_key,
      provider_model_id: typedModel.provider_model_id,
      internal_model_alias: typedModel.internal_model_alias,
      temperature: tempOverride ?? defaults.temperature,
      max_output_tokens: tokensOverride ?? defaults.max_output_tokens,
      timeout_ms: timeoutOverride ?? defaults.timeout_ms,
      route_mode: routeMode,
    },
    error: null,
  };
}
