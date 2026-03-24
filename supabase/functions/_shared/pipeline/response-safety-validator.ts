/**
 * Response Safety Validator
 *
 * Post-generation regex-based safety check. Scans generated response text
 * for prohibited patterns: financial commitments, action claims, scheduling
 * promises, guarantees, and redo-of-work offers.
 *
 * Design principle: false positives are acceptable — a held response costs
 * nothing, a bad published response costs everything.
 *
 * Spec alignment:
 *   - Section 6.3 Stage 7: Deterministic publish gate
 *   - Section 8.1: No public side effects in Slice 1A/1B without passing all checks
 */

// ---------------------------------------------------------------------------
// Pattern groups — each has a category label for violation reporting
// ---------------------------------------------------------------------------

interface PatternGroup {
  category: string;
  patterns: RegExp[];
}

const SAFETY_PATTERN_GROUPS: PatternGroup[] = [
  // ── Financial commitments ───────────────────────────────────────────
  {
    category: "financial_commitment",
    patterns: [
      /\b(free|complimentary|on us|on the house|no charge|at no cost)\b/i,
      /\b(discount|% off|\$ off|off your next|coupon|promo)\b/i,
      /\b(refund|credit|reimburse|money back|make it right financially)\b/i,
      /\b(comp|upgrade|bonus|gift card|token of)\b/i,
    ],
  },

  // ── Claims of action already taken ──────────────────────────────────
  {
    category: "action_claim",
    patterns: [
      /\b(I've|we've|I have|we have) (looked into|investigated|addressed|spoken with|talked to|discussed with)\b/i,
      /\b(I've|we've) (made changes|updated|revised|taken steps|corrected)\b/i,
      /\b(this has been|this was) (addressed|resolved|corrected|fixed|handled)\b/i,
    ],
  },

  // ── Scheduling and follow-up promises ───────────────────────────────
  {
    category: "scheduling_promise",
    patterns: [
      /\b(I'll|we'll|I will|we will) (call|contact|reach out|follow up|get back to|email|send)\b/i,
      /\b(expect a|you'll hear from|by (Monday|Tuesday|Wednesday|Thursday|Friday|tomorrow|end of))\b/i,
    ],
  },

  // ── Guarantees and absolute promises ────────────────────────────────
  {
    category: "guarantee",
    patterns: [
      /\b(I guarantee|we guarantee|I promise|we promise|I ensure|we ensure)\b/i,
      /\b(this won't happen again|never happen again|make sure this)\b/i,
      /\b(we'll make it right|make this right|set this right)\b/i,
    ],
  },

  // ── Redo-of-work offers ─────────────────────────────────────────────
  {
    category: "redo_work",
    patterns: [
      /\b(come back|send someone|redo|redo the|fix it|repair it|come out and)\b/i,
      /\b(at no (additional )?cost|free of charge|no extra)\b/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SafetyValidationResult {
  passed: boolean;
  violations: string[];
}

/**
 * Validates a generated response against prohibited phrase patterns.
 *
 * Returns { passed: true, violations: [] } if no patterns match.
 * Returns { passed: false, violations: [...] } with category and matched
 * text for every pattern hit.
 */
export function validateResponseSafety(
  responseText: string,
): SafetyValidationResult {
  const violations: string[] = [];

  for (const group of SAFETY_PATTERN_GROUPS) {
    for (const pattern of group.patterns) {
      const match = responseText.match(pattern);
      if (match) {
        violations.push(
          `${group.category}: matched "${match[0]}"`,
        );
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
