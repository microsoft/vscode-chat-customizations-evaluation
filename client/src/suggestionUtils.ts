/**
 * Pure helpers for working with diagnostic suggestions.
 *
 * Deliberately free of any `vscode` import so the logic can be unit-tested
 * without the editor runtime. The extension layer adapts `vscode.Diagnostic`
 * onto the minimal {@link SuggestionDiagnostic} shape used here.
 */

/** Minimal shape needed to extract a suggestion from a diagnostic. */
export interface SuggestionDiagnostic {
    message: string;
    /** Server attaches the suggestion string here (LSP Diagnostic.data). */
    data?: unknown;
}

/** Max characters of suggestion text shown inline in a quick-fix label. */
export const SUGGESTION_LABEL_MAX_LENGTH = 60;

/**
 * Return a usable suggestion string for a diagnostic, or undefined.
 *
 * A suggestion is usable only when it is a non-empty string that differs from
 * the diagnostic's own message (otherwise the action would be redundant).
 */
export function getDiagnosticSuggestion(diagnostic: SuggestionDiagnostic): string | undefined {
    if (typeof diagnostic.data !== 'string') {
        return undefined;
    }
    const suggestion = diagnostic.data.trim();
    const normalizedSuggestion = suggestion.replace(/\s+/g, ' ');
    const normalizedMessage = diagnostic.message.trim().replace(/\s+/g, ' ');
    if (!suggestion || normalizedSuggestion === normalizedMessage) {
        return undefined;
    }
    return suggestion;
}

/**
 * Collapse whitespace and truncate a suggestion for display in a single-line
 * label, appending an ellipsis when truncated.
 */
export function truncateSuggestionForLabel(suggestion: string, maxLength = SUGGESTION_LABEL_MAX_LENGTH): string {
    const normalized = suggestion.replace(/\s+/g, ' ').trim();
    if (maxLength <= 0) {
        return '';
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    if (maxLength === 1) {
        return '…';
    }
    return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Build the inline quick-fix label that previews the suggestion text, e.g.
 * `Copy suggestion: "Split into two steps…"`.
 */
export function buildCopySuggestionLabel(suggestion: string, prefix = 'Copy suggestion'): string {
    const preview = truncateSuggestionForLabel(suggestion).replace(/"/g, '\\"');
    return `${prefix}: "${preview}"`;
}

/**
 * Format a suggestion as an HTML comment for insertion above the flagged line.
 * Multi-line suggestions are collapsed to a single line so the comment stays
 * compact and never accidentally closes early.
 */
export function formatSuggestionComment(suggestion: string): string {
    const oneLine = suggestion.replace(/\s+/g, ' ').trim().replace(/--+/g, '-').replace(/-+$/g, '').trimEnd();
    return `<!-- suggestion: ${oneLine} -->`;
}
