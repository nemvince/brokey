/**
 * Output-token budgeting for the OpenCode free tier.
 *
 * Reasoning models emit chain-of-thought tokens that count against the same
 * output budget as the visible answer, so a client asking for a small
 * `max_tokens` gets an empty completion with `finish_reason: "length"` — a
 * silent failure. The accepted fix (goose#11142, the pi coding agent) is an
 * additive budget: `answer_tokens + thinking_budget`. The client's value is only
 * ever raised, never lowered.
 *
 * The numbers are copied from `azrinaldi/opencode-free-bridge` (`token-budget.js`)
 * and were measured against the live gateway: 512 output tokens truncates long
 * answers, 2048 + thinking headroom returns complete ones.
 */

export const MIN_ANSWER_TOKENS = 1024;
export const THINKING_BUDGET = 4096;
export const MAX_OUTPUT_TOKENS = 131_072;
/** Non-reasoning models still get a floor, so a tiny value cannot truncate mid-sentence. */
export const MIN_PLAIN_TOKENS = 512;

function parseRequestedTokens(requested: unknown): number {
  if (
    requested === undefined ||
    requested === null ||
    typeof requested === "boolean"
  )
    return MAX_OUTPUT_TOKENS;
  if (typeof requested === "string" && requested.trim() === "")
    return MAX_OUTPUT_TOKENS;
  const raw = Number(requested);
  if (!Number.isFinite(raw) || raw < 0) return MAX_OUTPUT_TOKENS;
  return Math.floor(raw);
}

export function effectiveMaxTokens(
  payload: Record<string, unknown>,
  facts: { reasoning: boolean; maxOutput: number | null },
  modelMaxOutput: number | null,
): number {
  const requested = parseRequestedTokens(
    payload.max_output_tokens ??
      payload.max_completion_tokens ??
      payload.max_tokens,
  );
  const effort = payload.reasoning_effort;
  const reasoning = facts.reasoning || (Boolean(effort) && effort !== "none");
  const effective = reasoning
    ? Math.max(requested, MIN_ANSWER_TOKENS) + THINKING_BUDGET
    : Math.max(requested, MIN_PLAIN_TOKENS);
  // Asking for more than a model can emit is rejected or silently truncated
  // upstream, so the cap follows the model rather than a global constant.
  const ceiling = Math.min(
    MAX_OUTPUT_TOKENS,
    facts.maxOutput ?? modelMaxOutput ?? MAX_OUTPUT_TOKENS,
  );
  return Math.min(effective, ceiling);
}
