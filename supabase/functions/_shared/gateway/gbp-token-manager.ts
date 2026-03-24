/**
 * gbp-token-manager.ts — Shared module for GBP OAuth token management
 *
 * Used by any Edge Function that needs a valid GBP access token:
 *   - gbp-publisher.ts (publish responses)
 *   - review-sync (future: poll for new reviews)
 *   - gbp-post-publisher (future: weekly GBP posts)
 *
 * Responsibilities:
 *   - Check token freshness
 *   - Refresh expired tokens using refresh_token
 *   - Update oauth_connections with new tokens
 *   - Emit oauth.refresh_succeeded / oauth.refresh_failed events
 *   - Return a usable access token or a clear error
 *
 * Does NOT:
 *   - Handle initial OAuth consent (that's gbp-auth-start/callback)
 *   - Make business logic decisions about what to do on failure
 *   - Retry indefinitely (caller decides retry policy)
 */

import { getSupabaseClient } from "../supabase-client.ts";
import { emitEvent } from "../events/emit.ts";
import { EVENT_TYPES } from "../events/types.ts";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Refresh proactively when token expires within this window
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenResult {
  success: true;
  accessToken: string;
  connectionId: string;
  externalAccountId: string;
  externalLocationId: string;
}

export interface TokenError {
  success: false;
  error: string;
  errorCode:
    | "no_connection"
    | "no_refresh_token"
    | "refresh_failed"
    | "connection_unhealthy"
    | "db_error";
  connectionId?: string;
}

export type GetTokenResult = TokenResult | TokenError;

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  // Note: Google does NOT return a new refresh_token on refresh
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<RefreshResponse> {
  const resp = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${errBody}`);
  }

  return await resp.json();
}

// ---------------------------------------------------------------------------
// Main export: getValidToken
// ---------------------------------------------------------------------------

/**
 * Get a valid GBP access token for a tenant.
 *
 * Logic:
 * 1. Look up current_oauth_connection_id from tenants table
 * 2. Check connection status (must be 'connected' or 'refresh_failed')
 * 3. If token is still fresh, return it
 * 4. If token is expired/expiring, attempt refresh
 * 5. On refresh success: update tokens, emit event, return new token
 * 6. On refresh failure: update status, emit event, return error
 */
export async function getValidToken(tenantId: string): Promise<GetTokenResult> {
  const db = getSupabaseClient();

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return {
      success: false,
      error: "OAuth credentials not configured",
      errorCode: "db_error",
    };
  }

  // --- Look up tenant's current OAuth connection ---
  const { data: tenant, error: tenantErr } = await db
    .from("tenants")
    .select("current_oauth_connection_id")
    .eq("id", tenantId)
    .single();

  if (tenantErr || !tenant?.current_oauth_connection_id) {
    return {
      success: false,
      error: "No OAuth connection found for tenant",
      errorCode: "no_connection",
    };
  }

  const connectionId = tenant.current_oauth_connection_id;

  // --- Fetch the connection record ---
  const { data: conn, error: connErr } = await db
    .from("oauth_connections")
    .select("*")
    .eq("id", connectionId)
    .single();

  if (connErr || !conn) {
    return {
      success: false,
      error: "OAuth connection record not found",
      errorCode: "no_connection",
      connectionId,
    };
  }

  // --- Check connection health ---
  const healthyStatuses = ["connected", "refresh_failed"]; // refresh_failed = try one more time
  if (!healthyStatuses.includes(conn.status)) {
    return {
      success: false,
      error: `Connection is in ${conn.status} state — requires reauthorization`,
      errorCode: "connection_unhealthy",
      connectionId,
    };
  }

  // --- Check if token is still fresh ---
  const now = Date.now();
  const expiresAt = conn.token_expires_at
    ? new Date(conn.token_expires_at).getTime()
    : 0;
  const isFresh = expiresAt > now + REFRESH_BUFFER_MS;

  if (isFresh && conn.access_token_ref) {
    // Token is still good — return it
    // TODO: When using vault, this would be a vault.decrypt() call
    return {
      success: true,
      accessToken: conn.access_token_ref,
      connectionId,
      externalAccountId: conn.external_account_id,
      externalLocationId: conn.external_location_id,
    };
  }

  // --- Token expired or expiring — attempt refresh ---
  if (!conn.refresh_token_ref) {
    // Update status to token_expired since we can't refresh
    await db
      .from("oauth_connections")
      .update({
        status: "token_expired",
        last_error_code: "no_refresh_token",
        last_error_message:
          "No refresh token available — user must reauthorize",
      })
      .eq("id", connectionId);

    await emitEvent({
      event_type: EVENT_TYPES.OAUTH_REFRESH_FAILED,
      tenant_id: tenantId,
      source_channel: "system_action",
      source_system: "gbp_token_manager",
      actor_type: "system",
      actor_id: "gbp_token_manager",
      generation_class: "system_generated",
      authority_rank: 80,
      is_authoritative: true,
      object_type: "oauth_connection",
      object_id: connectionId,
      idempotency_key: `oauth.refresh_failed:${connectionId}:no_refresh:${now}`,
      privacy_level: "operator_secret",
      payload: {
        summary: "Token refresh failed — no refresh token available",
        facts: { reason: "no_refresh_token" },
        refs: { connection_id: connectionId, tenant_id: tenantId },
      },
    });

    return {
      success: false,
      error: "No refresh token — tenant must reauthorize",
      errorCode: "no_refresh_token",
      connectionId,
    };
  }

  // --- Attempt the refresh ---
  try {
    // Record the attempt
    await db
      .from("oauth_connections")
      .update({ last_refresh_attempt_at: new Date().toISOString() })
      .eq("id", connectionId);

    // TODO: When using vault, decrypt refresh_token_ref first
    const refreshResult = await refreshAccessToken(
      conn.refresh_token_ref,
      clientId,
      clientSecret,
    );

    const newExpiresAt = new Date(
      now + refreshResult.expires_in * 1000,
    ).toISOString();

    // Update connection with new access token
    // TODO: When using vault, encrypt before storing
    const { error: updateErr } = await db
      .from("oauth_connections")
      .update({
        access_token_ref: refreshResult.access_token,
        token_expires_at: newExpiresAt,
        status: "connected",
        last_refreshed_at: new Date().toISOString(),
        last_error_code: null,
        last_error_message: null,
      })
      .eq("id", connectionId);

    if (updateErr) {
      console.error("Failed to store refreshed token:", updateErr.message);
      // We have the token in memory — return it but log the storage failure
    }

    await emitEvent({
      event_type: EVENT_TYPES.OAUTH_REFRESH_SUCCEEDED,
      tenant_id: tenantId,
      source_channel: "system_action",
      source_system: "gbp_token_manager",
      actor_type: "system",
      actor_id: "gbp_token_manager",
      generation_class: "system_generated",
      authority_rank: 80,
      is_authoritative: true,
      object_type: "oauth_connection",
      object_id: connectionId,
      idempotency_key: `oauth.refresh_succeeded:${connectionId}:${now}`,
      privacy_level: "operator_secret",
      payload: {
        summary: `Token refreshed for tenant ${tenantId}`,
        facts: { expires_in: refreshResult.expires_in },
        refs: { connection_id: connectionId, tenant_id: tenantId },
      },
    });

    console.log(
      `Token refreshed for tenant ${tenantId}, connection ${connectionId}`,
    );

    return {
      success: true,
      accessToken: refreshResult.access_token,
      connectionId,
      externalAccountId: conn.external_account_id,
      externalLocationId: conn.external_location_id,
    };
  } catch (err) {
    console.error(`Token refresh failed for tenant ${tenantId}:`, err);

    // Determine if this is a permanent failure (revoked) or transient
    const errStr = String(err);
    const isRevoked =
      errStr.includes("invalid_grant") ||
      errStr.includes("Token has been revoked");

    const newStatus = isRevoked ? "revoked" : "refresh_failed";
    const eventType = isRevoked
      ? EVENT_TYPES.OAUTH_REVOKED
      : EVENT_TYPES.OAUTH_REFRESH_FAILED;

    await db
      .from("oauth_connections")
      .update({
        status: newStatus,
        last_error_code: isRevoked ? "token_revoked" : "refresh_failed",
        last_error_message: errStr.substring(0, 500),
        ...(isRevoked
          ? { revoked_at: new Date().toISOString() }
          : {}),
      })
      .eq("id", connectionId);

    await emitEvent({
      event_type: eventType,
      tenant_id: tenantId,
      source_channel: "system_action",
      source_system: "gbp_token_manager",
      actor_type: "system",
      actor_id: "gbp_token_manager",
      generation_class: "system_generated",
      authority_rank: 80,
      is_authoritative: true,
      object_type: "oauth_connection",
      object_id: connectionId,
      idempotency_key: `${eventType}:${connectionId}:${now}`,
      privacy_level: "operator_secret",
      payload: {
        summary: isRevoked
          ? "Google access revoked — tenant must reauthorize"
          : `Token refresh failed: ${errStr.substring(0, 200)}`,
        facts: {
          error: errStr.substring(0, 500),
          is_revoked: isRevoked,
        },
        refs: { connection_id: connectionId, tenant_id: tenantId },
      },
    });

    return {
      success: false,
      error: isRevoked
        ? "Google access has been revoked — tenant must reauthorize"
        : `Token refresh failed: ${errStr.substring(0, 200)}`,
      errorCode: isRevoked ? "connection_unhealthy" : "refresh_failed",
      connectionId,
    };
  }
}
