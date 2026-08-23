import type { EscalationReason } from "../../src/shared/contracts.js";

export interface PolicyDecision {
  escalationReasons: EscalationReason[];
  unsupported: boolean;
  matched: string[];
}

const patterns: Array<{ reason: EscalationReason; expression: RegExp; label: string }> = [
  {
    reason: "payment_dispute",
    expression: /\b(dispute|charged?\b|chargeback|duplicate charge|refund|payment|credit card|billing)\b/i,
    label: "payment or charge dispute",
  },
  {
    reason: "cancellation_penalty",
    expression: /\b(cancel(?:led|lation)?|cancellation|penalt(?:y|ies)|cancellation fee)\b/i,
    label: "cancellation or penalty",
  },
  {
    reason: "urgent_disruption",
    expression:
      /\b(stranded|tonight|right now|same[- ]day|hotel (?:is )?closed|closure|nowhere to stay|emergency|urgent disruption)\b/i,
    label: "urgent travel disruption",
  },
];

const unsupportedPatterns = [
  /ignore (?:all |your )?(?:previous )?instructions/i,
  /system prompt/i,
  /tell me a joke/i,
  /write (?:me )?(?:code|a poem|an essay)/i,
  /what(?:'s| is) the weather/i,
  /book (?:a )?flight/i,
];

export function evaluatePolicy(text: string): PolicyDecision {
  const escalationReasons: EscalationReason[] = [];
  const matched: string[] = [];

  for (const pattern of patterns) {
    if (pattern.expression.test(text)) {
      escalationReasons.push(pattern.reason);
      matched.push(pattern.label);
    }
  }

  return {
    escalationReasons: [...new Set(escalationReasons)],
    unsupported: unsupportedPatterns.some((pattern) => pattern.test(text)),
    matched,
  };
}
