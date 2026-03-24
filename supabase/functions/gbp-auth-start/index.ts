/**
 * gbp-auth-start — Initiates Google OAuth consent flow for GBP access.
 *
 * Called when a tenant needs to connect their Google Business Profile.
 * Generates CSRF state, builds the Google consent URL, and redirects.
 *
 * Usage:
 *   GET /functions/v1/gbp-auth-start?tenant_id=<uuid>
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID — OAuth client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET — used to sign the state token (HMAC)
 *   GOOGLE_REDIRECT_URI — must match exactly what's registered in GCP
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Events emitted: none (callback handles events)
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { encode as base64url } from "https://deno.land/std@0.208.0/encoding/base64url.ts";
import { getSupabaseClient } from "../_shared/supabase-client.ts";

// Google OAuth constants
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GBP_SCOPES = ["https://www.googleapis.com/auth/business.manage"];

// ---------------------------------------------------------------------------
// CSRF state token — HMAC-signed payload with tenant_id + nonce + timestamp
// ---------------------------------------------------------------------------

async function buildStateToken(
  tenantId: string,
  secret: string,
): Promise<string> {
  const nonce = crypto.randomUUID();
  const timestamp = Date.now();
  const payload = JSON.stringify({ tenant_id: tenantId, nonce, timestamp });

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  const payloadB64 = base64url(encoder.encode(payload));
  const sigB64 = base64url(new Uint8Array(signature));

  return `${payloadB64}.${sigB64}`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  try {
    // --- Validate environment ---
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI");

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("Missing required environment variables for OAuth flow");
      return new Response(
        JSON.stringify({ error: "OAuth not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Extract and validate tenant_id ---
    const url = new URL(req.url);
    const tenantId = url.searchParams.get("tenant_id");

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: "tenant_id query parameter is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // UUID format check
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId)) {
      return new Response(
        JSON.stringify({ error: "Invalid tenant_id format" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Verify tenant exists and is in a connectable state ---
    const db = getSupabaseClient();

    const { data: tenant, error: tenantError } = await db
      .from("tenants")
      .select("id, status, business_name")
      .eq("id", tenantId)
      .single();

    if (tenantError || !tenant) {
      console.error("Tenant lookup failed:", tenantError?.message);
      return new Response(
        JSON.stringify({ error: "Tenant not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const connectableStatuses = [
      "onboarding",
      "onboarding_blocked",
      "trial_active",
      "active",
      "paused",
    ];
    if (!connectableStatuses.includes(tenant.status)) {
      return new Response(
        JSON.stringify({
          error: "Tenant cannot connect in current state",
          status: tenant.status,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Create pending oauth_connections row ---
    // Establishes the record before redirect so the callback can match it
    const { data: pendingConnection, error: connError } = await db
      .from("oauth_connections")
      .insert({
        tenant_id: tenantId,
        provider: "google_business_profile",
        status: "pending",
        external_account_id: "pending", // Will be populated by callback
        external_location_id: "pending", // Will be populated by callback
        granted_scopes: GBP_SCOPES,
      })
      .select("id")
      .single();

    if (connError) {
      console.error(
        "Failed to create pending connection:",
        connError.message,
      );
      return new Response(
        JSON.stringify({ error: "Failed to initialize connection" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Build signed state token ---
    const state = await buildStateToken(tenantId, clientSecret);

    // --- Store state → connection mapping for callback lookup ---
    const { error: updateError } = await db
      .from("oauth_connections")
      .update({ metadata: { state_nonce: state.split(".")[0] } })
      .eq("id", pendingConnection.id);

    if (updateError) {
      console.error("Failed to store state mapping:", updateError.message);
      // Non-fatal — callback can still match by tenant_id + pending status
    }

    // --- Build Google consent URL ---
    const consentParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GBP_SCOPES.join(" "),
      access_type: "offline", // Gets us a refresh_token
      prompt: "consent", // Force consent to ensure refresh_token is returned
      state: state,
      include_granted_scopes: "true",
    });

    const consentUrl = `${GOOGLE_AUTH_ENDPOINT}?${consentParams.toString()}`;

    console.log(
      `OAuth initiated for tenant ${tenantId} (${tenant.business_name}), connection ${pendingConnection.id}`,
    );

    // --- Redirect to Google ---
    return new Response(null, {
      status: 302,
      headers: { Location: consentUrl },
    });
  } catch (err) {
    console.error("Unexpected error in gbp-auth-start:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
