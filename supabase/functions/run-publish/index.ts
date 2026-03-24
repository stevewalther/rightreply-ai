/**
 * run-publish — Test endpoint to trigger the publish gate + publish execution.
 *
 * NOT a production endpoint. Used during Slice 1B development to manually
 * trigger the publish pipeline stage on a review that has a draft response.
 *
 * Usage:
 *   POST /functions/v1/run-publish
 *   Body: { "review_id": "<uuid>" }
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { runPublish } from "../_shared/pipeline/publish.ts";

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

  console.log(`Running publish on review: ${body.review_id}`);

  const result = await runPublish(body.review_id);

  return new Response(JSON.stringify(result, null, 2), {
    status: result.success ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
});
