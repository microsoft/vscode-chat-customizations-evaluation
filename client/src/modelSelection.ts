/**
 * Model selection logic extracted from extension.ts so it can be unit-tested
 * independently of the VS Code API.
 *
 * The only property accessed on a model is `family`, so we use a minimal
 * interface rather than importing from `vscode`.
 */

export interface ModelCandidate {
  readonly family: string;
  readonly name: string;
}

// Ordered list of preferred model families for automatic fallback selection (cheapest/most available first).
// Free tier: copilot-utility, gpt-5-mini, raptor-mini
// 0.33x tier: gpt-5.4-mini, claude-haiku, gemini-3-flash
// 1x tier (mid-cost fallbacks): gpt-5.2, gpt-5.2-codex, gpt-5.3-codex, gpt-5.4, claude-sonnet, gemini-2.5-pro, gemini-3.1-pro
export const PREFERRED_FALLBACK_FAMILIES: readonly string[] = [
  'copilot-utility',
  'gpt-5-mini',
  'raptor-mini',
  'gpt-5.4-mini',
  'claude-haiku',
  'gemini-3-flash',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'claude-sonnet',
  'gemini-2.5-pro',
  'gemini-3.1-pro',
];

// Model families that must never be selected automatically due to high cost.
// claude-opus: 15x, gemini-3.5-flash: 14x, gpt-5.5: 7.5x, gpt-4.5/o1/o3: legacy expensive models.
export const EXPENSIVE_MODEL_FAMILIES: readonly string[] = [
  'claude-opus',
  'gemini-3.5-flash',
  'gpt-5.5',
  'gpt-4.5',
  'o1',
  'o3',
];

/**
 * Returns true when `family` matches a known expensive entry exactly or by
 * versioned prefix (e.g. "claude-opus-4.7" is caught by "claude-opus").
 */
export function isExpensiveFamily(family: string): boolean {
  return EXPENSIVE_MODEL_FAMILIES.some(
    exp => family === exp || family.startsWith(exp + '-')
  );
}

/**
 * Picks the most preferred model from a list, respecting PREFERRED_FALLBACK_FAMILIES
 * order and never selecting a model whose family is in EXPENSIVE_MODEL_FAMILIES.
 *
 * @param models   Candidate models to choose from.
 * @param log      Optional logging callback (defaults to no-op).
 * @returns        The best available model, or undefined if none is acceptable.
 */
export function selectPreferredModel<T extends ModelCandidate>(
  models: T[],
  log: (message: string) => void = () => { /* no-op */ }
): T | undefined {
  if (models.length === 0) { return undefined; }

  // Walk the preference list in order — first match wins.
  for (const family of PREFERRED_FALLBACK_FAMILIES) {
    const match = models.find(m => m.family === family);
    if (match) { return match; }
  }

  // No preferred family present — filter out expensive models and take first.
  const affordable = models.filter(m => !isExpensiveFamily(m.family));
  if (affordable.length > 0) {
    log(`[LLM Proxy] Warning: no preferred model family found; using ${affordable[0].family} (filtered expensive models).`);
    return affordable[0];
  }

  // Every remaining model is expensive — refuse to select automatically.
  log('[LLM Proxy] Error: all available models are classified as expensive; refusing automatic selection. Please set chatCustomizationsEvaluations.model explicitly.');
  return undefined;
}
