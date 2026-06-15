import { describe, it, expect } from 'vitest';
import {
  buildCopySuggestionLabel,
  formatSuggestionComment,
  getDiagnosticSuggestion,
  truncateSuggestionForLabel,
  SUGGESTION_LABEL_MAX_LENGTH,
} from '../suggestionUtils';

describe('getDiagnosticSuggestion', () => {
  it('returns the trimmed suggestion when data is a non-empty string', () => {
    expect(getDiagnosticSuggestion({ message: 'Problem', data: '  Do X instead  ' })).toBe('Do X instead');
  });

  it('returns undefined when data is missing', () => {
    expect(getDiagnosticSuggestion({ message: 'Problem' })).toBeUndefined();
  });

  it('returns undefined when data is not a string', () => {
    expect(getDiagnosticSuggestion({ message: 'Problem', data: 42 })).toBeUndefined();
    expect(getDiagnosticSuggestion({ message: 'Problem', data: { x: 1 } })).toBeUndefined();
  });

  it('returns undefined when data is empty or whitespace only', () => {
    expect(getDiagnosticSuggestion({ message: 'Problem', data: '' })).toBeUndefined();
    expect(getDiagnosticSuggestion({ message: 'Problem', data: '   ' })).toBeUndefined();
  });

  it('returns undefined when the suggestion equals the message (redundant)', () => {
    expect(getDiagnosticSuggestion({ message: 'Same text', data: '  Same text ' })).toBeUndefined();
  });
});

describe('truncateSuggestionForLabel', () => {
  it('collapses whitespace and leaves short text unchanged', () => {
    expect(truncateSuggestionForLabel('Split   into\ntwo steps')).toBe('Split into two steps');
  });

  it('truncates long text with an ellipsis at the configured length', () => {
    const long = 'x'.repeat(SUGGESTION_LABEL_MAX_LENGTH + 20);
    const result = truncateSuggestionForLabel(long);
    expect(result.length).toBe(SUGGESTION_LABEL_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });

  it('respects a custom max length', () => {
    expect(truncateSuggestionForLabel('abcdefghij', 5)).toBe('abcd…');
  });

  it('keeps very small max lengths within the requested bound', () => {
    expect(truncateSuggestionForLabel('abcdefghij', 1)).toBe('…');
    expect(truncateSuggestionForLabel('abcdefghij', 0)).toBe('');
    expect(truncateSuggestionForLabel('abcdefghij', -1)).toBe('');
  });
});

describe('buildCopySuggestionLabel', () => {
  it('wraps a previewed suggestion in quotes with the default prefix', () => {
    expect(buildCopySuggestionLabel('Be concise')).toBe('Copy suggestion: "Be concise"');
  });

  it('honors a custom prefix', () => {
    expect(buildCopySuggestionLabel('Be concise', 'Apply')).toBe('Apply: "Be concise"');
  });

  it('escapes quotes in the suggestion preview', () => {
    expect(buildCopySuggestionLabel('Use "clear" phrasing')).toBe('Copy suggestion: "Use \\"clear\\" phrasing"');
  });
});

describe('formatSuggestionComment', () => {
  it('wraps the suggestion in an HTML comment on a single line', () => {
    expect(formatSuggestionComment('Rewrite this\nas one step')).toBe('<!-- suggestion: Rewrite this as one step -->');
  });

  it('neutralizes double dashes that would break the comment', () => {
    expect(formatSuggestionComment('use -- as a separator')).toBe('<!-- suggestion: use - as a separator -->');
  });

  it('strips trailing hyphens from the comment payload', () => {
    expect(formatSuggestionComment('finish with a divider ---')).toBe('<!-- suggestion: finish with a divider -->');
  });
});
