/**
 * Zod schemas for validating inbound webhook payloads.
 *
 * This uses a mock Google Business Profile webhook format.
 * When we integrate with the real GBP Notifications API, we'll update
 * this schema to match their actual payload shape — the rest of the
 * pipeline won't change because we normalize into our internal format here.
 *
 * Spec alignment:
 *   - reviews.star_rating: smallint 1-5 (data model Section 4)
 *   - reviews.source_review_id: text (provider review ID)
 *   - reviews.source_location_id: text (Google location ID)
 *   - reviews.reviewer_display_name: nullable
 *   - reviews.review_text: nullable (blank/star-only supported for later cohorts)
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// ---------------------------------------------------------------------------
// Inbound GBP webhook payload schema (mock format)
// ---------------------------------------------------------------------------

export const GbpReviewWebhookSchema = z.object({
  /** Unique review ID assigned by Google */
  reviewId: z.string().min(1, "reviewId is required"),

  /** Google location ID (accounts/{id}/locations/{id} format) */
  locationId: z.string().min(1, "locationId is required"),

  /** Reviewer's display name — null/missing if anonymous */
  reviewerName: z.string().nullable().optional(),

  /** Star rating 1-5 */
  starRating: z.number().int().min(1).max(5),

  /** Review body text — null/empty for star-only reviews */
  reviewText: z.string().nullable().optional(),

  /** Language code (e.g. "en") */
  language: z.string().nullable().optional(),

  /** When the review was published on Google (ISO 8601) */
  publishedAt: z.string().datetime({ message: "publishedAt must be ISO 8601" }),

  /** Google's webhook message ID — used for deduplication */
  messageId: z.string().nullable().optional(),
});

export type GbpReviewWebhookPayload = z.infer<typeof GbpReviewWebhookSchema>;

// ---------------------------------------------------------------------------
// Normalized internal review shape (what the pipeline works with)
// ---------------------------------------------------------------------------

export interface NormalizedReview {
  source_review_id: string;
  source_location_id: string;
  reviewer_display_name: string | null;
  reviewer_is_anonymous: boolean;
  star_rating: number;
  review_text: string | null;
  review_language: string | null;
  source_review_published_at: string;
  source_message_id: string | null;
}

/**
 * Transforms a validated GBP webhook payload into our normalized internal shape.
 * This is the only place provider-specific field names are translated.
 */
export function normalizeGbpReview(raw: GbpReviewWebhookPayload): NormalizedReview {
  return {
    source_review_id: raw.reviewId,
    source_location_id: raw.locationId,
    reviewer_display_name: raw.reviewerName ?? null,
    reviewer_is_anonymous: !raw.reviewerName,
    star_rating: raw.starRating,
    review_text: raw.reviewText ?? null,
    review_language: raw.language ?? null,
    source_review_published_at: raw.publishedAt,
    source_message_id: raw.messageId ?? null,
  };
}


/*
 * ============================================================================
 * TEST PAYLOAD — use this to test the review-webhook function manually.
 *
 * curl -X POST http://localhost:54321/functions/v1/review-webhook \
 *   -H "Content-Type: application/json" \
 *   -H "Authorization: Bearer YOUR_ANON_KEY" \
 *   -d '{
 *     "reviewId": "goog_review_abc123",
 *     "locationId": "accounts/123456/locations/789012",
 *     "reviewerName": "Jane Smith",
 *     "starRating": 5,
 *     "reviewText": "Absolutely fantastic experience! Dr. Chen was thorough and the staff was incredibly friendly. Highly recommend.",
 *     "language": "en",
 *     "publishedAt": "2026-03-21T14:30:00Z",
 *     "messageId": "gbp_msg_xyz789"
 *   }'
 *
 * Expected result: 200 OK with event_id and review_id in the response body.
 *
 * To test duplicate rejection, send the exact same payload again.
 * The second call should return 200 with duplicate: true.
 *
 * To test validation failure, omit starRating or set it to 6.
 * ============================================================================
 */
