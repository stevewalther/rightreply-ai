/**
 * Supabase client — single shared instance for all Edge Functions.
 *
 * Uses the service role key (server-side only, never exposed to browsers).
 * Credentials come from environment variables set in Supabase project settings
 * or from .env.local during local development with `supabase functions serve`.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

let _client: SupabaseClient | null = null;

/**
 * Returns a singleton Supabase client configured with the service role key.
 * Throws immediately if credentials are missing — fail fast, not silently.
 */
export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url) {
    throw new Error("SUPABASE_URL is not set. Check your environment variables.");
  }
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set. Check your environment variables.");
  }

  _client = createClient(url, key, {
    auth: {
      // Service role key bypasses RLS — we handle authorization in app logic.
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _client;
}
