/**
 * run-classification — Test endpoint to trigger review classification.
 *
 * NOT a production endpoint. Used during Slice 1A development to manually
 * trigger the classification pipeline stage on a review that has already
 * passed injection detection (safe_for_downstream_generation = true).
 *
 * Usage:
 *   POST /functions/v1/run-classification
 *   Body: { "review_id": "<uuid>" }
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { runClassification } from "../_shared/pipeline/classification.ts";

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { review_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.review_id) {
    return new Response(
      JSON.stringify({ error: "review_id is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  console.log(`Running classification on review: ${body.review_id}`);

  const result = await runClassification(body.review_id);

  return new Response(JSON.stringify(result, null, 2), {
    status: result.success ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
});
