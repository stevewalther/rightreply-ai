/**
 * GBP Publisher — Google Business Profile review reply publisher.
 *
 * MOCK IMPLEMENTATION for Slice 1B development. Returns a realistic
 * fake receipt simulating the GBP API response. When real GBP API
 * access is approved, replace ONLY the body of publishReplyToGBP()
 * with the real PUT call. The interface stays the same.
 *
 * Real endpoint (when ready):
 *   PUT https://mybusiness.googleapis.com/v4/{name}/reply
 *   Authorization: Bearer {access_token}
 *   Body: { "comment": "<response text>" }
 *
 * This file is the ONLY place that touches the GBP API. No other
 * file should import Google API clients or construct GBP URLs.
 */

// ---------------------------------------------------------------------------
// Publisher input / output contracts
// ---------------------------------------------------------------------------

export interface GBPPublishRequest {
  /** Google account ID (e.g. "accounts/123456") */
  account_id: string;
  /** Google location ID (e.g. "accounts/123456/locations/789012") */
  location_id: string;
  /** Google's review ID (source_review_id from reviews table) */
  review_id: string;
  /** The response text to publish */
  comment: string;
  /** OAuth access token for the GBP API */
  access_token: string;
}

export interface GBPPublishResult {
  success: boolean;
  /** GBP's reply object — includes comment and updateTime */
  reply: {
    comment: string;
    updateTime: string;
  } | null;
  /** HTTP status code from the API (or simulated) */
  http_status: number;
  /** Provider-assigned response ID (for publish_provider_response_id) */
  provider_response_id: string | null;
  /** Error details if failed */
  error_code: string | null;
  error_message: string | null;
  /** Whether this was a mock call */
  is_mock: boolean;
}

// ---------------------------------------------------------------------------
// Mock publisher — swap this function body for real API call
// ---------------------------------------------------------------------------

export async function publishReplyToGBP(
  request: GBPPublishRequest,
): Promise<GBPPublishResult> {
  // ┌──────────────────────────────────────────────────────────────┐
  // │  MOCK IMPLEMENTATION                                         │
  // │                                                              │
  // │  To swap in the real GBP API call, replace everything        │
  // │  below this comment with:                                    │
  // │                                                              │
  // │  const url = `https://mybusiness.googleapis.com/v4/           │
  // │    ${request.location_id}/reviews/${request.review_id}/reply`;│
  // │                                                              │
  // │  const res = await fetch(url, {                              │
  // │    method: "PUT",                                            │
  // │    headers: {                                                │
  // │      "Authorization": `Bearer ${request.access_token}`,      │
  // │      "Content-Type": "application/json",                     │
  // │    },                                                        │
  // │    body: JSON.stringify({ comment: request.comment }),        │
  // │  });                                                         │
  // │                                                              │
  // │  const body = await res.json();                              │
  // │  if (!res.ok) return { success: false, ... };                │
  // │  return { success: true, reply: body, ... };                 │
  // └──────────────────────────────────────────────────────────────┘

  console.log(
    `[MOCK GBP PUBLISHER] Simulating PUT to ` +
    `${request.location_id}/reviews/${request.review_id}/reply`,
  );
  console.log(`[MOCK GBP PUBLISHER] Comment: "${request.comment.substring(0, 80)}..."`);

  // Simulate a ~200ms network round-trip
  await new Promise((resolve) => setTimeout(resolve, 200));

  const now = new Date().toISOString();
  const mockProviderResponseId = `gbp_reply_${crypto.randomUUID().substring(0, 8)}`;

  return {
    success: true,
    reply: {
      comment: request.comment,
      updateTime: now,
    },
    http_status: 200,
    provider_response_id: mockProviderResponseId,
    error_code: null,
    error_message: null,
    is_mock: true,
  };
}
