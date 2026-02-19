/**
 * Simple character-based token estimator.
 * Heuristic: 1 token ≈ 4 characters for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Check if content fits within a token budget.
 */
export function fitsInBudget(text: string, budget: number): boolean {
  return estimateTokens(text) <= budget;
}
