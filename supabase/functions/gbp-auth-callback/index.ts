/**
 * gbp-auth-callback — Handles Google OAuth callback after user consent.
 *
 * Receives authorization code from Google, exchanges for tokens,
 * fetches account/location info, stores in oauth_connections,
 * updates tenant record, and emits oauth.connected event.
 *
 * Query params (set by Google redirect):
 *   code — authorization code
 *   state — signed state token from gbp-auth-start
 *   error — present if user denied consent
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OAUTH_SUCCESS_REDIRECT — URL to redirect to after successful connection
 *   OAUTH_FAILURE_REDIRECT — URL to redirect to after failed connection
 *
 * Events emitted:
 *   oauth.connected — on successful token exchange and storage
 *   oauth.disconnected — if user denied consent (pending → disconnected)
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import {
  decode as base64urlDecode,
} from "https://deno.land/std@0.208.0/encoding/base64url.ts";
import { getSupabaseClient } from "../_shared/supabase-client.ts";
import { emitEvent } from "../_shared/events/emit.ts";
import { EVENT_TYPES } from "../_shared/events/types.ts";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GBP_ACCOUNTS_ENDPOINT =
  "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";

// ---------------------------------------------------------------------------
// State token verification
// ---------------------------------------------------------------------------

interface StatePayload {
  tenant_id: string;
  nonce: string;
  timestamp: number;
}

async function verifyStateToken(
  stateToken: string,
  secret: string,
): Promise<StatePayload | null> {
  try {
    const [payloadB64, sigB64] = stateToken.split(".");
    if (!payloadB64 || !sigB64) return null;

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Reconstruct payload
    const payloadBytes = base64urlDecode(payloadB64);
    const payloadStr = decoder.decode(payloadBytes);
    const payload: StatePayload = JSON.parse(payloadStr);

    // Verify HMAC signature
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = base64urlDecode(sigB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      encoder.encode(payloadStr),
    );

    if (!valid) {
      console.error("State token HMAC verification failed");
      return null;
    }

    // Check timestamp freshness — reject if older than 30 minutes
    const MAX_AGE_MS = 30 * 60 * 1000;
    if (Date.now() - payload.timestamp > MAX_AGE_MS) {
      console.error("State token expired");
      return null;
    }

    return payload;
  } catch (err) {
    console.error("State token parse error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const resp = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${errBody}`);
  }

  return await resp.json();
}

// ---------------------------------------------------------------------------
// GBP account + location discovery
// ---------------------------------------------------------------------------

interface GBPAccountInfo {
  accountId: string;
  accountName: string;
  locationId: string | null;
  locationName: string | null;
}

/**
 * Fetches the GBP account and first location for the authenticated user.
 * For Slice 1: we assume one account, one location per tenant.
 * Multi-location support is Phase 4+.
 */
async function discoverGBPAccount(
  accessToken: string,
): Promise<GBPAccountInfo> {
  // Step 1: Get accounts
  const accountsResp = await fetch(GBP_ACCOUNTS_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!accountsResp.ok) {
    const errBody = await accountsResp.text();
    throw new Error(
      `GBP accounts fetch failed (${accountsResp.status}): ${errBody}`,
    );
  }

  const accountsData = await accountsResp.json();
  const accounts = accountsData.accounts || [];

  if (accounts.length === 0) {
    throw new Error("No GBP accounts found for this Google account");
  }

  // Use first account (Slice 1 simplification)
  const account = accounts[0];
  const accountId = account.name; // Format: "accounts/{id}"

  // Step 2: Get locations for this account
  let locationId: string | null = null;
  let locationName: string | null = null;

  try {
    const locationsResp = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (locationsResp.ok) {
      const locationsData = await locationsResp.json();
      const locations = locationsData.locations || [];

      if (locations.length > 0) {
        // Use first location (Slice 1 simplification)
        locationId = locations[0].name; // Format: "locations/{id}"
        locationName =
          locations[0].title ||
          locations[0].storefrontAddress?.locality ||
          null;
      }
    } else {
      console.warn(
        "Could not fetch locations — may need separate API enablement",
      );
      // Non-fatal: we can still store the account connection
    }
  } catch (locErr) {
    console.warn("Location discovery error (non-fatal):", locErr);
  }

  return {
    accountId,
    accountName: account.accountName || account.name,
    locationId,
    locationName,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  const url = new URL(req.url);
  const db = getSupabaseClient();

  // --- Validate environment ---
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
  const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI") ?? "";
  const successRedirect =
    Deno.env.get("OAUTH_SUCCESS_REDIRECT") ??
    "https://rightreply.ai/connected";
  const failureRedirect =
    Deno.env.get("OAUTH_FAILURE_REDIRECT") ??
    "https://rightreply.ai/connection-failed";

  if (!clientId || !clientSecret || !redirectUri) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${failureRedirect}?error=config` },
    });
  }

  // --- Check for user-denied consent ---
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    console.warn("User denied OAuth consent:", oauthError);

    const stateParam = url.searchParams.get("state");
    if (stateParam) {
      const payload = await verifyStateToken(stateParam, clientSecret);
      if (payload) {
        // Find pending connection and mark disconnected
        const { data: conn } = await db
          .from("oauth_connections")
          .select("id")
          .eq("tenant_id", payload.tenant_id)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (conn) {
          await db
            .from("oauth_connections")
            .update({
              status: "disconnected",
              disconnected_at: new Date().toISOString(),
            })
            .eq("id", conn.id);

          await emitEvent({
            event_type: EVENT_TYPES.OAUTH_DISCONNECTED,
            tenant_id: payload.tenant_id,
            source_channel: "google_oauth",
            source_system: "gbp_auth_callback",
            actor_type: "external_service",
            actor_id: "google_oauth",
            generation_class: "external_observed",
            authority_rank: 90,
            is_authoritative: true,
            object_type: "oauth_connection",
            object_id: conn.id,
            idempotency_key: `oauth.disconnected:${conn.id}:denied`,
            privacy_level: "operator_secret",
            payload: {
              summary: "User denied OAuth consent",
              facts: {
                reason: "user_denied_consent",
                google_error: oauthError,
              },
              refs: {
                connection_id: conn.id,
                tenant_id: payload.tenant_id,
              },
            },
          });
        }
      }
    }

    return new Response(null, {
      status: 302,
      headers: { Location: `${failureRedirect}?error=denied` },
    });
  }

  // --- Validate state and code ---
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  if (!code || !stateParam) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${failureRedirect}?error=missing_params` },
    });
  }

  const statePayload = await verifyStateToken(stateParam, clientSecret);
  if (!statePayload) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${failureRedirect}?error=invalid_state` },
    });
  }

  const tenantId = statePayload.tenant_id;

  try {
    // --- Exchange code for tokens ---
    const tokens = await exchangeCodeForTokens(
      code,
      clientId,
      clientSecret,
      redirectUri,
    );

    if (!tokens.refresh_token) {
      console.warn(
        "No refresh_token returned — user may have previously authorized. Consider revoking and re-authorizing.",
      );
    }

    // --- Discover GBP account + location ---
    const gbpInfo = await discoverGBPAccount(tokens.access_token);

    // --- Find the pending connection row created by gbp-auth-start ---
    const { data: pendingConn, error: findError } = await db
      .from("oauth_connections")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (findError || !pendingConn) {
      console.error("No pending connection found for tenant:", tenantId);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${failureRedirect}?error=no_pending_connection`,
        },
      });
    }

    // --- Store tokens ---
    // TOKEN SECURITY NOTE:
    // For Slice 1 (single test tenant), tokens are stored directly.
    // Before ANY paying customer: migrate to Supabase Vault or external
    // secrets manager. The column names end in _ref to remind us these
    // should be vault references, not raw values.
    //
    // TODO: Replace with vault storage before customer onboarding
    const tokenExpiresAt = new Date(
      Date.now() + tokens.expires_in * 1000,
    ).toISOString();

    const { error: updateError } = await db
      .from("oauth_connections")
      .update({
        status: "connected",
        external_account_id: gbpInfo.accountId,
        external_location_id: gbpInfo.locationId || "unknown",
        granted_scopes: tokens.scope.split(" "),
        access_token_ref: tokens.access_token, // TODO: vault ref
        refresh_token_ref: tokens.refresh_token || null, // TODO: vault ref
        token_expires_at: tokenExpiresAt,
        connected_at: new Date().toISOString(),
        last_refreshed_at: new Date().toISOString(),
        metadata: {
          account_name: gbpInfo.accountName,
          location_name: gbpInfo.locationName,
          has_refresh_token: !!tokens.refresh_token,
        },
      })
      .eq("id", pendingConn.id);

    if (updateError) {
      throw new Error(`Failed to update connection: ${updateError.message}`);
    }

    // --- Update tenant record to point to this connection ---
    const { error: tenantUpdateError } = await db
      .from("tenants")
      .update({
        current_oauth_connection_id: pendingConn.id,
      })
      .eq("id", tenantId);

    if (tenantUpdateError) {
      console.error(
        "Failed to update tenant OAuth ref:",
        tenantUpdateError.message,
      );
      // Non-fatal — connection is stored, tenant ref just needs manual fix
    }

    // --- Emit oauth.connected event ---
    await emitEvent({
      event_type: EVENT_TYPES.OAUTH_CONNECTED,
      tenant_id: tenantId,
      source_channel: "google_oauth",
      source_system: "gbp_auth_callback",
      actor_type: "external_service",
      actor_id: "google_oauth",
      generation_class: "system_generated",
      authority_rank: 90,
      is_authoritative: true,
      object_type: "oauth_connection",
      object_id: pendingConn.id,
      idempotency_key: `oauth.connected:${pendingConn.id}`,
      privacy_level: "operator_secret",
      payload: {
        summary: `GBP OAuth connected for tenant ${tenantId}`,
        facts: {
          provider: "google_business_profile",
          external_account_id: gbpInfo.accountId,
          account_name: gbpInfo.accountName,
          external_location_id: gbpInfo.locationId,
          location_name: gbpInfo.locationName,
          scopes: tokens.scope.split(" "),
          has_refresh_token: !!tokens.refresh_token,
        },
        refs: {
          connection_id: pendingConn.id,
          tenant_id: tenantId,
        },
      },
    });

    console.log(
      `OAuth connected for tenant ${tenantId}, connection ${pendingConn.id}, account ${gbpInfo.accountId}`,
    );

    // --- Redirect to success ---
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${successRedirect}?tenant_id=${tenantId}&connection_id=${pendingConn.id}`,
      },
    });
  } catch (err) {
    console.error("OAuth callback error:", err);

    // Try to emit failure event if we have context
    try {
      const { data: pendingConn } = await db
        .from("oauth_connections")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (pendingConn) {
        await emitEvent({
          event_type: EVENT_TYPES.OAUTH_DISCONNECTED,
          tenant_id: tenantId,
          source_channel: "google_oauth",
          source_system: "gbp_auth_callback",
          actor_type: "system",
          actor_id: "gbp_auth_callback",
          generation_class: "system_generated",
          authority_rank: 80,
          is_authoritative: true,
          object_type: "oauth_connection",
          object_id: pendingConn.id,
          idempotency_key: `oauth.disconnected:${pendingConn.id}:error`,
          privacy_level: "operator_secret",
          payload: {
            summary: "OAuth callback failed during token exchange",
            facts: {
              reason: "callback_error",
              error_message: String(err).substring(0, 500),
            },
            refs: {
              connection_id: pendingConn.id,
              tenant_id: tenantId,
            },
          },
        });
      }
    } catch (_) {
      // Best effort — don't let event failure mask the real error
    }

    return new Response(null, {
      status: 302,
      headers: { Location: `${failureRedirect}?error=exchange_failed` },
    });
  }
});
